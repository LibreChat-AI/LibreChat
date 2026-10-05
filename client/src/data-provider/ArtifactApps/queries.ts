import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { QueryKeys, dataService, DEFAULT_ARTIFACT_APPS_CONFIG } from 'librechat-data-provider';
import type {
  TArtifactAppList,
  TArtifactAppWithVersion,
  TArtifactVersion,
  TArtifactVersionList,
  ArtifactAppListScope,
} from 'librechat-data-provider';
import type {
  QueryObserverResult,
  UseQueryOptions,
  UseInfiniteQueryOptions,
} from '@tanstack/react-query';
import { useGetStartupConfig } from '../Endpoints';

export const useListArtifactAppsQuery = (
  scope: ArtifactAppListScope = 'personal',
  search = '',
  config?: UseInfiniteQueryOptions<TArtifactAppList, Error>,
) => {
  const { data: startupConfig } = useGetStartupConfig();
  const pageSize =
    startupConfig?.artifactApps?.catalogPageSize ?? DEFAULT_ARTIFACT_APPS_CONFIG.catalogPageSize;
  return useInfiniteQuery<TArtifactAppList, Error>(
    [QueryKeys.artifactApps, scope, pageSize, search],
    ({ pageParam }) =>
      dataService.listArtifactApps({
        scope,
        limit: pageSize,
        cursor: typeof pageParam === 'string' ? pageParam : undefined,
        search: search || undefined,
      }),
    {
      getNextPageParam: (lastPage) =>
        lastPage.has_more && lastPage.after ? lastPage.after : undefined,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: 'always',
      ...config,
    },
  );
};

export const useGetArtifactAppBySourceQuery = (
  conversationId: string | null | undefined,
  sourceKey: string | null | undefined,
  config?: UseQueryOptions<TArtifactAppWithVersion>,
): QueryObserverResult<TArtifactAppWithVersion> => {
  const enabled = !!conversationId && !!sourceKey;
  return useQuery<TArtifactAppWithVersion>(
    [QueryKeys.artifactApp, 'source', conversationId, sourceKey],
    () => dataService.getArtifactAppBySource(conversationId as string, sourceKey as string),
    {
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: 'always',
      retry: false,
      ...config,
      enabled: enabled && (config?.enabled ?? true),
    },
  );
};

export const useGetArtifactAppQuery = (
  artifactAppId: string | null | undefined,
  config?: UseQueryOptions<TArtifactAppWithVersion>,
): QueryObserverResult<TArtifactAppWithVersion> => {
  const enabled = !!artifactAppId;
  return useQuery<TArtifactAppWithVersion>(
    [QueryKeys.artifactApp, artifactAppId],
    () => dataService.getArtifactApp(artifactAppId as string),
    {
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: 'always',
      retry: false,
      ...config,
      enabled: enabled && (config?.enabled ?? true),
    },
  );
};

export const useListArtifactAppVersionsQuery = (
  artifactAppId: string | null | undefined,
  config?: UseInfiniteQueryOptions<TArtifactVersionList, Error>,
) => {
  const enabled = !!artifactAppId;
  const { data: startupConfig } = useGetStartupConfig();
  const pageSize =
    startupConfig?.artifactApps?.versionPageSize ?? DEFAULT_ARTIFACT_APPS_CONFIG.versionPageSize;
  return useInfiniteQuery<TArtifactVersionList, Error>(
    [QueryKeys.artifactAppVersions, artifactAppId, pageSize],
    ({ pageParam }) =>
      dataService.listArtifactAppVersions(artifactAppId as string, {
        limit: pageSize,
        cursor: typeof pageParam === 'string' ? pageParam : undefined,
      }),
    {
      getNextPageParam: (lastPage) =>
        lastPage.has_more && lastPage.after ? lastPage.after : undefined,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: 'always',
      ...config,
      enabled: enabled && (config?.enabled ?? true),
    },
  );
};

export const useGetArtifactAppVersionQuery = (
  artifactAppId: string | null | undefined,
  versionId: string | null | undefined,
  config?: UseQueryOptions<TArtifactVersion>,
): QueryObserverResult<TArtifactVersion> => {
  const enabled = !!artifactAppId && !!versionId;
  return useQuery<TArtifactVersion>(
    [QueryKeys.artifactAppVersions, artifactAppId, versionId],
    () => dataService.getArtifactAppVersion(artifactAppId as string, versionId as string),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: enabled && (config?.enabled ?? true),
    },
  );
};
