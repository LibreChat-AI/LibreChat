import { useEffect, useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, dataService } from 'librechat-data-provider';
import type { Agent, TEndpointsConfig, TModelSpec } from 'librechat-data-provider';
import type { Favorite } from '~/store/favorites';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useAssistantsMapContext, useAgentsMapContext } from '~/Providers';
import { useFavorites, useGetConversation, useNewConvo } from '~/hooks';
import useSelectMention from '~/hooks/Input/useSelectMention';

/** A 404/403 from getAgentById means the agent is gone or inaccessible; other errors are transient. */
export const isMissingAgentError = (error: unknown): boolean => {
  if (error && typeof error === 'object' && 'response' in error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    return status === 404 || status === 403;
  }
  return false;
};

export type FavoriteSelectKwargs = {
  model?: string;
  agent_id?: string;
  assistant_id?: string;
  spec?: string | null;
};
export type SelectEndpointHandler = (
  endpoint?: EModelEndpoint | string | null,
  kwargs?: FavoriteSelectKwargs,
) => void;
export type SelectSpecHandler = (spec: TModelSpec) => void;

export type FavoritesData = {
  favorites: Favorite[];
  isLoading: boolean;
  /** Whether the atom has absorbed the settled favorites query value. */
  isLoaded: boolean;
  dataUpdatedAt: number;
  isAgentsLoading: boolean;
  agentsMap: Record<string, Agent>;
  specsMap: Record<string, TModelSpec>;
  endpointsConfig: TEndpointsConfig;
  reorderFavorites: (favorites: Favorite[], persist: boolean) => void;
  onSelectEndpoint: SelectEndpointHandler | undefined;
  onSelectSpec: SelectSpecHandler | undefined;
};

/**
 * Data layer for the sidebar's favorite models/agents/specs: resolution of
 * favorites into renderable items, agent fetching past the global map, and
 * cleanup of favorites whose agent or spec no longer exists. Rendering and
 * ordering live with the caller (the Pinned section interleaves these rows
 * with pinned conversations).
 */
export default function useFavoritesData(): FavoritesData {
  const getConversation = useGetConversation(0);
  const { favorites, reorderFavorites, isLoading, isLoaded, dataUpdatedAt } = useFavorites();

  const { newConversation } = useNewConvo();
  const assistantsMap = useAssistantsMapContext();
  const agentsMapContext = useAgentsMapContext();
  const { data: endpointsConfig = {} as TEndpointsConfig, isLoading: isEndpointsLoading } =
    useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();

  const modelSpecs = useMemo(
    () => startupConfig?.modelSpecs?.list ?? [],
    [startupConfig?.modelSpecs?.list],
  );

  const specsMap = useMemo(() => {
    const map: Record<string, TModelSpec> = {};
    for (const spec of modelSpecs) {
      map[spec.name] = spec;
    }
    return map;
  }, [modelSpecs]);

  const { onSelectEndpoint, onSelectSpec } = useSelectMention({
    modelSpecs,
    assistantsMap,
    endpointsConfig,
    getConversation,
    newConversation,
    returnHandlers: true,
  });

  const safeFavorites = useMemo(() => (Array.isArray(favorites) ? favorites : []), [favorites]);

  const allAgentIds = useMemo(
    () => safeFavorites.map((f) => f.agentId).filter(Boolean) as string[],
    [safeFavorites],
  );

  const agentsEndpointEnabled = !!endpointsConfig?.[EModelEndpoint.agents];

  const agentIdsToFetch = useMemo(() => {
    if (!agentsEndpointEnabled) {
      return [];
    }
    if (agentsMapContext === undefined) {
      return allAgentIds;
    }
    return allAgentIds.filter((id) => !agentsMapContext[id]);
  }, [allAgentIds, agentsMapContext, agentsEndpointEnabled]);

  const agentQueries = useQueries({
    queries: agentIdsToFetch.map((agentId) => ({
      queryKey: [QueryKeys.agent, agentId],
      queryFn: (): Promise<Agent> => dataService.getAgentById({ agent_id: agentId }),
      staleTime: 1000 * 60 * 5,
      retry: (failureCount: number, error: unknown) =>
        !isMissingAgentError(error) && failureCount < 3,
    })),
  });

  const staleAgentIdsKey = useMemo(() => {
    // Only persist cleanup once the global map has loaded. A revoked AGENTS.USE role
    // makes every getAgentById return a global 403, which must not delete favorites.
    if (agentsMapContext === undefined) {
      return '';
    }
    const ids: string[] = [];
    for (let i = 0; i < agentIdsToFetch.length; i++) {
      const query = agentQueries[i];
      if (query.isError && isMissingAgentError(query.error)) {
        ids.push(agentIdsToFetch[i]);
      }
    }
    return ids.sort().join(',');
  }, [agentIdsToFetch, agentQueries, agentsMapContext]);

  const cleanupAttemptedRef = useRef('');

  useEffect(() => {
    if (!staleAgentIdsKey || cleanupAttemptedRef.current === staleAgentIdsKey) {
      return;
    }
    const staleSet = new Set(staleAgentIdsKey.split(','));
    const cleaned = safeFavorites.filter((f) => !f.agentId || !staleSet.has(f.agentId));
    if (cleaned.length < safeFavorites.length) {
      cleanupAttemptedRef.current = staleAgentIdsKey;
      reorderFavorites(cleaned, true);
    }
  }, [staleAgentIdsKey, safeFavorites, reorderFavorites]);

  const staleSpecNamesKey = useMemo(() => {
    if (startupConfig === undefined) {
      return '';
    }
    return safeFavorites
      .filter((f) => f.spec && !specsMap[f.spec])
      .map((f) => f.spec as string)
      .sort()
      .join(',');
  }, [safeFavorites, specsMap, startupConfig]);

  const specCleanupAttemptedRef = useRef('');

  useEffect(() => {
    if (!staleSpecNamesKey || specCleanupAttemptedRef.current === staleSpecNamesKey) {
      return;
    }
    const staleSet = new Set(staleSpecNamesKey.split(','));
    const cleaned = safeFavorites.filter((f) => !f.spec || !staleSet.has(f.spec));
    if (cleaned.length < safeFavorites.length) {
      specCleanupAttemptedRef.current = staleSpecNamesKey;
      reorderFavorites(cleaned, true);
    }
  }, [staleSpecNamesKey, safeFavorites, reorderFavorites]);

  const combinedAgentsMap = useMemo(() => {
    const combined: Record<string, Agent> = {};
    if (agentsMapContext) {
      for (const [key, value] of Object.entries(agentsMapContext)) {
        if (value) {
          combined[key] = value;
        }
      }
    }
    agentQueries.forEach((query) => {
      if (query.data) {
        combined[query.data.id] = query.data;
      }
    });
    return combined;
  }, [agentsMapContext, agentQueries]);

  const isAgentsLoading =
    allAgentIds.length > 0 &&
    (isEndpointsLoading ||
      agentQueries.some(
        (q) =>
          q.isLoading ||
          (agentsMapContext === undefined && q.isError && !isMissingAgentError(q.error)),
      ));

  return {
    favorites: safeFavorites,
    isLoading,
    isLoaded,
    dataUpdatedAt,
    isAgentsLoading,
    agentsMap: combinedAgentsMap,
    specsMap,
    endpointsConfig,
    reorderFavorites,
    onSelectEndpoint,
    onSelectSpec,
  };
}
