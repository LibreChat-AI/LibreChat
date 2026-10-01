import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryClient, QueryObserverResult } from '@tanstack/react-query';
import type { TImportJob } from 'librechat-data-provider';

const POLL_MS = 2000;
/** Transient failures are retried this many times before the panel gives up
 * and shows the "job lost" screen. */
const TRANSIENT_RETRIES = 3;

/** The subset of React Query's `Query` that the interval callback reads. */
type ImportJobQueryState = { state: { status: string; error?: unknown } };
type ImportJobMountQuery = { state: { data?: TImportJob } };

const TERMINAL_PHASES = new Set<TImportJob['phase']>([
  'awaiting_confirmation',
  'completed',
  'failed',
  'cancelled',
]);

/** Phases whose job may have written conversations to the database. `failed`
 * is included deliberately: a run that throws after a batch flush leaves every
 * conversation up to that flush permanently saved, so the sidebar has to be
 * refreshed even though the import as a whole did not succeed. */
const WROTE_CONVERSATIONS = new Set<TImportJob['phase']>(['completed', 'failed', 'cancelled']);

/** An import can carry already-archived and pinned chats, so every list that
 * may hold one is refreshed, not only the default chats list. */
export const invalidateImportedConversations = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries([QueryKeys.allConversations]);
  queryClient.invalidateQueries([QueryKeys.archivedConversations]);
  queryClient.invalidateQueries([QueryKeys.pinnedConversations]);
};

/** A job the server will never return again, as opposed to a request that
 * failed on the way there. Only the former is worth giving up on. */
export const isJobGone = (error: unknown): boolean =>
  (error as { response?: { status?: number } })?.response?.status === 404;

/**
 * Determines the polling cadence for an import job.
 *
 * Polls every `POLL_MS` while the job is queued or actively importing
 * conversations/assets, and while no data has arrived yet. Stops on every
 * terminal phase, including `awaiting_confirmation`: the job is idle there,
 * waiting on the user to confirm before it starts, so continuing to poll
 * would burn requests for nothing.
 *
 * A 404 also stops it: a job lost to TTL expiry, cache eviction, or a server
 * restart on the default in-memory backend will never reappear. Any other
 * failure keeps polling: a dropped connection or a single 5xx says nothing
 * about the import, which is still running server-side, and abandoning the
 * poll there strands the panel on a job it would have seen finish.
 */
export const importJobRefetchInterval = (
  data: TImportJob | undefined,
  query?: ImportJobQueryState,
): number | false => {
  if (query?.state.status === 'error' && isJobGone(query.state.error)) {
    return false;
  }
  if (!data) {
    return POLL_MS;
  }
  return TERMINAL_PHASES.has(data.phase) ? false : POLL_MS;
};

export const importJobRefetchOnMount = (query: ImportJobMountQuery): boolean =>
  query.state.data?.phase === 'awaiting_confirmation';

/**
 * Fetches a single import job and, the moment a fetch reveals the job has
 * stopped running, invalidates the conversation list so the sidebar reflects
 * what the background job wrote to the database, succeeded or not, since a
 * run that stops partway leaves everything it already flushed behind.
 *
 * This lives in the fetcher itself rather than in `useQuery`'s `onSuccess`
 * config on purpose: `onSuccess` is a per-observer callback tied to React
 * Query's cache-update lifecycle (deprecated in v5 for exactly this reason),
 * so it can re-run on every component that observes the query, not once per
 * real network response. Placing the invalidation here ties it to the one
 * concrete event that matters, an actual server response confirming
 * completion, and keeps `useImportJobQuery` itself free of side effects: it
 * only wires up the cache key and the polling cadence.
 */
export const fetchImportJob = async (
  jobId: string,
  queryClient: QueryClient,
): Promise<TImportJob> => {
  const data = await dataService.getImportJob(jobId);
  if (WROTE_CONVERSATIONS.has(data.phase)) {
    invalidateImportedConversations(queryClient);
  }
  return data;
};

export const useImportJobQuery = (
  jobId: string | null,
): QueryObserverResult<TImportJob, unknown> => {
  const queryClient = useQueryClient();

  return useQuery<TImportJob, unknown, TImportJob>(
    [QueryKeys.importJob, jobId],
    () => fetchImportJob(jobId ?? '', queryClient),
    {
      enabled: jobId != null,
      /** A 404 is the job's final answer and is surfaced immediately as the
       * "job lost" screen; everything else gets a few attempts before the
       * panel concludes anything, so one dropped request mid-import does not
       * replace a running job with an error state. */
      retry: (failureCount: number, error: unknown) =>
        !isJobGone(error) && failureCount < TRANSIENT_RETRIES,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      /** A confirmation can be accepted or cancelled by another mounted
       * observer. Refresh that idle phase when the panel remounts, while
       * retaining settled results without repeating completion side effects. */
      refetchOnMount: importJobRefetchOnMount,
      refetchInterval: importJobRefetchInterval,
    },
  );
};
