import { useRef, useMemo, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { useQueries, replaceEqualDeep } from '@tanstack/react-query';
import { QueryKeys, dataService, EModelEndpoint } from 'librechat-data-provider';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { TModelsConfig } from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from './queries';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { mapEndpoints } from '~/utils/endpoints';
import { retryTransientQuery } from '../retry';
import store from '~/store';

const emptyModels: TModelsConfig = {};

export type ModelCatalogConfig = {
  enabled?: boolean;
  refetchOnMount?: boolean | 'always';
};

export type ModelCatalogOptions = {
  /** A panel can bypass idle warmup without starting unrelated endpoint requests. */
  eager?: boolean;
  endpoints?: string[];
};

/** Independent endpoint observers share the selected-target query's scoped cache entries. */
export function useModelCatalog(config?: ModelCatalogConfig, options?: ModelCatalogOptions) {
  const ready = useCatalogReady('models');
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();
  const endpoints = useMemo(() => {
    if (!endpointsConfig || !startupConfig) {
      return [];
    }
    const visible = options?.endpoints ?? startupConfig.modelSpecs?.addedEndpoints;
    let included: Set<string> | undefined;
    if (options?.endpoints !== undefined || visible?.length) included = new Set(visible ?? []);
    return mapEndpoints(endpointsConfig).filter(
      (endpoint) => endpoint !== EModelEndpoint.agents && (!included || included.has(endpoint)),
    );
  }, [endpointsConfig, startupConfig, options?.endpoints]);
  const queries = useQueries<UseQueryOptions<TModelsConfig>[]>({
    queries: endpoints.map((endpoint) => ({
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: retryTransientQuery,
      ...config,
      queryKey: [QueryKeys.models, endpoint],
      queryFn: () => dataService.getModels(endpoint),
      enabled: queriesEnabled && (config?.enabled ?? true) && (ready || options?.eager === true),
      initialData: undefined,
      placeholderData: undefined,
      select: undefined,
    })),
  });

  const previous = useRef<TModelsConfig>(emptyModels);
  const data = useMemo(() => {
    const next: TModelsConfig = {};
    for (let i = 0; i < endpoints.length; i++) {
      const result = queries[i].data;
      if (result != null) next[endpoints[i]] = result[endpoints[i]] ?? [];
    }
    previous.current = replaceEqualDeep(previous.current, next);
    return previous.current;
  }, [endpoints, queries]);
  const endpointQueries = useMemo(
    () =>
      Object.fromEntries(endpoints.map((endpoint, index) => [endpoint, queries[index]])) as Record<
        string,
        UseQueryResult<TModelsConfig>
      >,
    [endpoints, queries],
  );
  const count = Object.keys(data).length;
  const refetch = useCallback(
    () => Promise.all(queries.map((query) => query.refetch())),
    [queries],
  );

  return {
    data,
    endpointQueries,
    isLoading: count === 0 && queries.some((query) => query.isLoading),
    isFetching: queries.some((query) => query.isFetching),
    isError: queries.some((query) => query.isError),
    error: queries.find((query) => query.isError)?.error ?? null,
    isSuccess: queries.length > 0 && queries.every((query) => query.isSuccess),
    isFetched: queries.length > 0 && queries.every((query) => query.isFetched),
    isFetchedAfterMount: queries.length > 0 && queries.every((query) => query.isFetchedAfterMount),
    refetch,
  };
}
