import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type {
  TNmbMe,
  TNmbReviewsResponse,
  TNmbOriginal,
  TNmbSubmission,
  TNmbBlocklistEntry,
  TNmbReviewStatus,
} from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';

/** Whether the gateway is on, and whether the current user may review. Cheap; shared by nav, chat and the Reviews screen. */
export const useNmbMeQuery = (config?: UseQueryOptions<TNmbMe>): QueryObserverResult<TNmbMe> =>
  useQuery<TNmbMe>([QueryKeys.nmbMe], () => dataService.getNmbMe(), {
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    ...config,
  });

export const useNmbReviewsQuery = (
  status: TNmbReviewStatus,
  config?: UseQueryOptions<TNmbReviewsResponse>,
): QueryObserverResult<TNmbReviewsResponse> =>
  useQuery<TNmbReviewsResponse>(
    [QueryKeys.nmbReviews, status],
    () => dataService.getNmbReviews(status),
    { refetchOnWindowFocus: true, refetchInterval: 30_000, ...config },
  );

/**
 * The original content is fetched only when a reviewer opens an item and is not kept: no cache
 * time and no refetching, so it leaves memory when the item is closed.
 */
export const useNmbOriginalQuery = (
  id: string | undefined,
  config?: UseQueryOptions<TNmbOriginal>,
): QueryObserverResult<TNmbOriginal> =>
  useQuery<TNmbOriginal>(
    [QueryKeys.nmbOriginal, id],
    () => dataService.getNmbReviewOriginal(id as string),
    {
      enabled: id != null,
      cacheTime: 0,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      ...config,
    },
  );

export const useNmbBlocklistQuery = (
  config?: UseQueryOptions<{ entries: TNmbBlocklistEntry[] }>,
): QueryObserverResult<{ entries: TNmbBlocklistEntry[] }> =>
  useQuery<{ entries: TNmbBlocklistEntry[] }>(
    [QueryKeys.nmbBlocklist],
    () => dataService.getNmbBlocklist(),
    {
      refetchOnWindowFocus: false,
      cacheTime: 0,
      ...config,
    },
  );

/** The end user's own held submission; polled while it is pending. */
export const useNmbSubmissionQuery = (
  id: string | undefined,
  config?: UseQueryOptions<TNmbSubmission>,
): QueryObserverResult<TNmbSubmission> =>
  useQuery<TNmbSubmission>(
    [QueryKeys.nmbSubmission, id],
    () => dataService.getNmbSubmission(id as string),
    {
      enabled: id != null,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (data) => (data?.status === 'pending' || data == null ? 5000 : false),
      ...config,
    },
  );
