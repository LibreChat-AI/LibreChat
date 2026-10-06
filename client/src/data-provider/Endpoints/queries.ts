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

/** Floor for the revalidation timer, so an entry that is about to expire cannot cause a request storm. */
const MIN_REVALIDATE_MS = 1000;

/** The server's catalog entry is gone, or the request failed, so the data must be read again. */
const reasoningCapabilitiesExpired = (query: {
  state: { status: string; data?: unknown; dataUpdatedAt: number };
}): 'always' | false => {
  const data = query.state.data as t.TReasoningCapabilitiesResponse | undefined;
  if (query.state.status === 'error') {
    return 'always';
  }
  return data != null && Date.now() - query.state.dataUpdatedAt >= data.expiresInMs
    ? 'always'
    : false;
};

/**
 * Per-model reasoning efforts of one OpenRouter endpoint. Scoped to the endpoint, so another
 * endpoint's outage cannot hide this one's data. Pass `enabled: false` unless the endpoint is an
 * OpenRouter one, so other users never pay for the request.
 *
 * The response says how long the server keeps the catalog it came from, and the client reads it
 * again when that time passes, on a timer while the page is open and on focus or reconnect
 * otherwise, so it never offers a list the server has already replaced. A failed request retries
 * every 30 seconds without waiting for an event, because the editors offer nothing while it fails.
 */
export const useReasoningCapabilitiesQuery = (
  endpoint: string,
  config?: UseQueryOptions<t.TReasoningCapabilitiesResponse>,
): QueryObserverResult<t.TReasoningCapabilitiesResponse> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TReasoningCapabilitiesResponse>(
    [QueryKeys.reasoningCapabilities, endpoint],
    () => dataService.getReasoningCapabilities(endpoint),
    {
      staleTime: Infinity,
      refetchOnWindowFocus: reasoningCapabilitiesExpired,
      refetchOnReconnect: reasoningCapabilitiesExpired,
      refetchOnMount: reasoningCapabilitiesExpired,
      refetchInterval: (data, query) => {
        if (query.state.status === 'error') {
          return Time.THIRTY_SECONDS;
        }
        return data == null ? false : Math.max(data.expiresInMs, MIN_REVALIDATE_MS);
      },
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
