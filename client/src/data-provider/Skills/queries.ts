import { QueryKeys, dataService } from 'librechat-data-provider';
import { useQuery, useMutation, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TSkill,
  TSkillListRequest,
  TSkillListResponse,
  TSkillStatesResponse,
  TListSkillFilesResponse,
  TSkillFileContentResponse,
} from 'librechat-data-provider';
import type {
  QueryObserverResult,
  UseQueryOptions,
  UseInfiniteQueryOptions,
} from '@tanstack/react-query';

/**
 * Paginated skill list (single page) — use this for small lists or when you want to
 * control pagination manually.
 */
export const useListSkillsQuery = (
  params?: TSkillListRequest,
  config?: UseQueryOptions<TSkillListResponse>,
): QueryObserverResult<TSkillListResponse> => {
  return useQuery<TSkillListResponse>(
    [
      QueryKeys.skills,
      params?.category ?? '',
      params?.search ?? '',
      params?.limit ?? 20,
      params?.cursor ?? '',
    ],
    () => dataService.listSkills(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

/**
 * Cursor-paginated infinite query for skills. Use this for the main skills listing UI.
 */
export const useSkillsInfiniteQuery = (
  params?: Omit<TSkillListRequest, 'cursor'>,
  config?: UseInfiniteQueryOptions<TSkillListResponse, unknown>,
) => {
  return useInfiniteQuery<TSkillListResponse, unknown>(
    [
      QueryKeys.skills,
      'infinite',
      params?.category ?? '',
      params?.search ?? '',
      params?.limit ?? 20,
    ],
    ({ pageParam }) => {
      const request: TSkillListRequest = {
        category: params?.category,
        search: params?.search,
        limit: params?.limit,
      };
      if (typeof pageParam === 'string' && pageParam.length > 0) {
        request.cursor = pageParam;
      }
      return dataService.listSkills(request);
    },
    {
      getNextPageParam: (lastPage) =>
        lastPage.has_more && lastPage.after ? lastPage.after : undefined,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

/**
 * Fetch a single skill by id (includes full body + frontmatter).
 */
export const useGetSkillQuery = (
  id: string | null | undefined,
  config?: UseQueryOptions<TSkill>,
): QueryObserverResult<TSkill> => {
  const enabled = !!id;
  return useQuery<TSkill>([QueryKeys.skill, id], () => dataService.getSkill(id as string), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    ...config,
    enabled: enabled && (config?.enabled ?? true),
  });
};

/**
 * Alias kept for the original UI PR's call surface — components that still
 * import `useGetSkillByIdQuery` (e.g. `SkillsView`, `SkillForm`) resolve to
 * the same hook as `useGetSkillQuery`.
 */
export const useGetSkillByIdQuery = useGetSkillQuery;

/**
 * List file metadata for a single skill. In phase 1 this returns an empty array for
 * skills that have only an inline `SKILL.md`; multi-file skills arrive in phase 2.
 */
export const useListSkillFilesQuery = (
  skillId: string | null | undefined,
  config?: UseQueryOptions<TListSkillFilesResponse>,
): QueryObserverResult<TListSkillFilesResponse> => {
  const enabled = !!skillId;
  return useQuery<TListSkillFilesResponse>(
    [QueryKeys.skillFiles, skillId],
    () => dataService.listSkillFiles(skillId as string),
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

/**
 * Fetch a single skill file's content. Returns cached text from the DB when
 * available; otherwise the backend reads from storage, caches, and returns it.
 * Confirmed content stays fresh until invalidated; unavailable results refetch on revisit.
 */
export const useGetSkillFileContentQuery = (
  skillId: string | null | undefined,
  relativePath: string | null | undefined,
  config?: UseQueryOptions<TSkillFileContentResponse | null>,
): QueryObserverResult<TSkillFileContentResponse | null> => {
  const enabled = !!skillId && !!relativePath;
  return useQuery<TSkillFileContentResponse | null>(
    [QueryKeys.skillFileContent, skillId, relativePath],
    async () => {
      try {
        return await dataService.getSkillFileContent(skillId as string, relativePath as string);
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        // A terminal response replaces cached bytes, including on background reads.
        // Throw transient failures so React Query retains the last confirmed content.
        if (status === 404 || status === 410 || status === 403) {
          return null;
        }
        throw error;
      }
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: (query) => (query.state.data === null ? 'always' : false),
      retry: false,
      staleTime: Infinity,
      ...config,
      enabled: enabled && (config?.enabled ?? true),
    },
  );
};

/** Per-user skill active/inactive overrides. */
export const useGetSkillStatesQuery = (
  config?: Omit<UseQueryOptions<TSkillStatesResponse, Error>, 'queryKey' | 'queryFn'>,
) => {
  return useQuery<TSkillStatesResponse, Error>(
    [QueryKeys.skillStates],
    () => dataService.getSkillStates(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

export const useUpdateSkillStatesMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    (skillStates: TSkillStatesResponse) => dataService.updateSkillStates(skillStates),
    {
      onMutate: async (next) => {
        await queryClient.cancelQueries([QueryKeys.skillStates]);
        const previous = queryClient.getQueryData<TSkillStatesResponse>([QueryKeys.skillStates]);
        queryClient.setQueryData([QueryKeys.skillStates], next);
        return { previous };
      },
      onError: (_err, _next, context) => {
        if (context?.previous !== undefined) {
          queryClient.setQueryData([QueryKeys.skillStates], context.previous);
        }
      },
    },
  );
};
