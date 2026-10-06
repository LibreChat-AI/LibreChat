import { useRecoilValue } from 'recoil';
import { useQuery } from '@tanstack/react-query';
import { Time, QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import { normalizeStartupConfigModelSpecs } from '~/utils';
import store from '~/store';

export const useGetEndpointsQuery = <TData = t.TEndpointsConfig>(
  config?: UseQueryOptions<t.TEndpointsConfig, unknown, TData>,
): QueryObserverResult<TData> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TEndpointsConfig, unknown, TData>(
    [QueryKeys.endpoints],
    () => dataService.getAIEndpoints(),
    {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled,
    },
  );
};

export const useTokenConfigQuery = (
  config?: UseQueryOptions<t.TTokenConfigMap>,
): QueryObserverResult<t.TTokenConfigMap> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TTokenConfigMap>([QueryKeys.tokenConfig], () => dataService.getTokenConfig(), {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    /** Refetch on mount only when stale — with `staleTime: Infinity` that's
     *  exclusively after a user-key change invalidates `tokenConfig`, so a
     *  settings change made while the gauge is unmounted is picked up on
     *  return instead of serving the prior key's resolved config */
    refetchOnMount: true,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

/**
 * Per-model reasoning efforts of one OpenRouter endpoint. The server caches the catalog for
 * an hour and the data changes rarely, so one fetch serves the session. Scoped to the endpoint,
 * so another endpoint's outage cannot hide this one's data. Pass `enabled: false` unless the
 * endpoint is an OpenRouter one, so other users never pay for the request.
 */
export const useReasoningCapabilitiesQuery = (
  endpoint: string,
  config?: UseQueryOptions<t.TReasoningCapabilityMap>,
): QueryObserverResult<t.TReasoningCapabilityMap> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TReasoningCapabilityMap>(
    [QueryKeys.reasoningCapabilities, endpoint],
    () => dataService.getReasoningCapabilities(endpoint),
    {
      staleTime: Time.ONE_HOUR,
      /** Loaded data lives for an hour, so focus and reconnect do not refetch it. A failed
       *  request is different: the editors fall back to the generic list while the server may
       *  have recovered and start refusing it, so only an errored query retries on those events. */
      refetchOnWindowFocus: (query) => query.state.status === 'error',
      refetchOnReconnect: (query) => query.state.status === 'error',
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled,
    },
  );
};

/**
 * Auth-aware query key so unauthenticated (login page) and authenticated
 * (chat page) configs are cached independently, preventing stale
 * unauthenticated config from persisting after login.
 */
export const startupConfigKey = (isAuthenticated: boolean, context?: t.StartupConfigContext) =>
  [QueryKeys.startupConfig, isAuthenticated, context ?? 'default'] as const;

export const sharedStartupConfigKey = (shareId?: string) =>
  [QueryKeys.sharedStartupConfig, shareId ?? ''] as const;

export const useGetStartupConfig = (
  config?: UseQueryOptions<t.TStartupConfig>,
  options?: { context?: t.StartupConfigContext },
): QueryObserverResult<t.TStartupConfig> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  const user = useRecoilValue<t.TUser | undefined>(store.user);
  return useQuery<t.TStartupConfig>(
    startupConfigKey(!!user, options?.context),
    /**
     * Normalized at the query boundary — once per fetch, cached — so every
     * consumer of `modelSpecs.list` reads complete specs without per-site guards.
     */
    () =>
      dataService
        .getStartupConfig({ context: options?.context })
        .then(normalizeStartupConfigModelSpecs),
    {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled,
    },
  );
};

export const useGetSharedStartupConfig = (
  shareId?: string,
  config?: UseQueryOptions<t.TSharedLinkStartupConfig>,
): QueryObserverResult<t.TSharedLinkStartupConfig> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TSharedLinkStartupConfig>(
    sharedStartupConfigKey(shareId),
    () => dataService.getSharedStartupConfig(shareId ?? ''),
    {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled:
        (config?.enabled ?? true) === true &&
        queriesEnabled &&
        typeof shareId === 'string' &&
        shareId.length > 0,
    },
  );
};
