import { dataService, QueryKeys } from 'librechat-data-provider';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectAvailableFilesParams,
  ProjectAvailableFilesResponse,
  ProjectListParams,
  ProjectListResponse,
  TChatProject,
  TChatProjectFile,
} from 'librechat-data-provider';
import type {
  InfiniteData,
  UseInfiniteQueryOptions,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';

export const useProjectsInfiniteQuery = (
  params: ProjectListParams = {},
  config?: UseInfiniteQueryOptions<ProjectListResponse, unknown>,
) => {
  const { sortBy, sortDirection, search, limit } = params;

  return useInfiniteQuery<ProjectListResponse>({
    queryKey: [QueryKeys.projects, { sortBy, sortDirection, search, limit }],
    queryFn: ({ pageParam }) =>
      dataService.listProjects({
        sortBy,
        sortDirection,
        search,
        limit,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000,
    cacheTime: 30 * 60 * 1000,
    ...config,
  });
};

export const useProjectQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProject>,
): QueryObserverResult<TChatProject, unknown> => {
  return useQuery<TChatProject>(
    [QueryKeys.project, projectId],
    () => dataService.getProjectById(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};
/**
 * A project's name for a row that only carries its id. The sidebar already holds the
 * recent projects, so a name found there costs no request; only a project past that
 * list is fetched, once per id. A record written by id (a rename) still wins.
 */
export const useProjectName = (projectId?: string | null): string | undefined => {
  const queryClient = useQueryClient();
  let listedName: string | undefined;
  if (projectId) {
    for (const [, data] of queryClient.getQueriesData<InfiniteData<ProjectListResponse>>([
      QueryKeys.projects,
    ])) {
      for (const page of data?.pages ?? []) {
        listedName = page?.projects?.find((project) => project._id === projectId)?.name;
        if (listedName != null) {
          break;
        }
      }
      if (listedName != null) {
        break;
      }
    }
  }
  const { data: project } = useProjectQuery(projectId, { enabled: listedName == null });
  return project?.name ?? listedName;
};
export const useProjectFilesQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProjectFile[]>,
): QueryObserverResult<TChatProjectFile[], unknown> => {
  return useQuery<TChatProjectFile[]>(
    [QueryKeys.projectFiles, projectId],
    () => dataService.getProjectFiles(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      ...config,
    },
  );
};
export const useProjectAvailableFilesInfiniteQuery = (
  projectId?: string | null,
  params: ProjectAvailableFilesParams = {},
  config?: UseInfiniteQueryOptions<ProjectAvailableFilesResponse, unknown>,
) => {
  const queryParams = { limit: params.limit, search: params.search };

  return useInfiniteQuery<ProjectAvailableFilesResponse>({
    queryKey: [QueryKeys.projectAvailableFiles, projectId, queryParams],
    queryFn: ({ pageParam }) =>
      dataService.getAvailableProjectFiles(projectId ?? '', {
        ...queryParams,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    enabled: Boolean(projectId),
    refetchOnWindowFocus: false,
    ...config,
  });
};
