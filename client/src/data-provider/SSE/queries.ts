import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { apiBaseUrl, QueryKeys, request, dataService } from 'librechat-data-provider';
import type { Agents, TConversation, TPendingSteer } from 'librechat-data-provider';
import { isNotFoundError, updateConvoInAllQueries, setDocumentTitle } from '~/utils';
import { generationProtocolHeaders, withGenerationProtocolQuery } from './protocol';
import { useGetStartupConfig } from '../Endpoints';

export interface StreamStatusResponse {
  /** Exact protocol selected by the job. Missing/1 is always legacy. */
  generationProtocolVersion?: number;
  active: boolean;
  /** Client-local cache marker used to force useResumeOnLoad to replace a
   * stale generation attachment with the newer epoch occupying this stream. */
  generationHandoff?: boolean;
  streamId?: string;
  status?: 'running' | 'complete' | 'error' | 'aborted' | 'requires_action';
  aggregatedContent?: Array<{ type: string; text?: string }>;
  createdAt?: number;
  /** Generation age computed on the server's clock, so a reattaching client
   *  can rebuild a clock-local elapsed baseline free of cross-machine skew. */
  elapsedMs?: number;
  resumeState?: Agents.ResumeState;
  /** Live pending approval when `status === 'requires_action'`; mirrors
   *  `resumeState.pendingAction`, surfaced top-level for the resume-on-load path. */
  pendingAction?: Agents.PendingAction;
  /** Acknowledged steers a terminal drain parked because no subscriber was
   *  live for the final/abort event. Reads are replayable until an exact
   *  recovery turn persists or the user discards the item. */
  unrecoveredSteers?: TPendingSteer[];
}

export const streamStatusQueryKey = (conversationId: string) => ['streamStatus', conversationId];

export const fetchStreamStatus = async (conversationId: string): Promise<StreamStatusResponse> => {
  return request.get<StreamStatusResponse>(
    withGenerationProtocolQuery(`${apiBaseUrl()}/api/agents/chat/status/${conversationId}`),
    { headers: generationProtocolHeaders() },
  );
};

export function useStreamStatus(conversationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: streamStatusQueryKey(conversationId || ''),
    queryFn: () => fetchStreamStatus(conversationId!),
    enabled: !!conversationId && enabled,
    staleTime: 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export const genTitleQueryKey = (conversationId: string) => ['genTitle', conversationId] as const;

/** Response type for active jobs query */
export interface ActiveJobsResponse {
  activeJobIds: string[];
}

/** Module-level queue for title generation (survives re-renders).
 * Stores conversationIds that need title generation once their job completes */
const titleQueue = new Set<string>();
const processedTitles = new Set<string>();

/** Conversations whose eager (immediate-mode) title fetch 404'd while the stream
 * was still active. They wait for stream completion before fetching again instead
 * of busy-looping — covers a per-endpoint `final` override under a global
 * `immediate` default. */
const deferredTitles = new Set<string>();

/** Listeners to notify when queue changes (for non-resumable streams like assistants) */
const queueListeners = new Set<() => void>();

/** Queue a conversation for title generation (call when starting new conversation) */
export function queueTitleGeneration(conversationId: string) {
  if (!processedTitles.has(conversationId)) {
    titleQueue.add(conversationId);
    queueListeners.forEach((listener) => listener());
  }
}

export function markTitleGenerationProcessed(conversationId: string) {
  processedTitles.add(conversationId);
  titleQueue.delete(conversationId);
  deferredTitles.delete(conversationId);
  queueListeners.forEach((listener) => listener());
}

/**
 * Hook to process the title generation queue.
 *
 * Timing is driven by the server's effective default (`titleGenerationTiming`):
 * - `immediate` (default): fetch the title in parallel with the active stream so
 *   it appears while the response is still streaming.
 * - `final` (legacy): fetch only after the stream completes.
 *
 * The title query retries on 404 (server still generating) so a transient
 * not-ready response is never treated as final (#13318).
 * Place this high in the component tree (e.g., Nav.tsx).
 */
export function useTitleGeneration(enabled = true) {
  const queryClient = useQueryClient();
  const { data: startupConfig } = useGetStartupConfig();
  /** Defaults to immediate until startup config loads. */
  const timing = startupConfig?.titleGenerationTiming ?? 'immediate';

  const [queueVersion, setQueueVersion] = useState(0);
  const [readyToFetch, setReadyToFetch] = useState<string[]>([]);

  const { data: activeJobsData } = useActiveJobs(enabled);
  const activeJobIds = useMemo(
    () => activeJobsData?.activeJobIds ?? [],
    [activeJobsData?.activeJobIds],
  );

  useEffect(() => {
    const listener = () => setQueueVersion((v) => v + 1);
    queueListeners.add(listener);
    return () => {
      queueListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const activeSet = new Set(activeJobIds);
    const eligible: string[] = [];

    for (const conversationId of titleQueue) {
      if (processedTitles.has(conversationId)) {
        continue;
      }
      const eager = timing === 'immediate' && !deferredTitles.has(conversationId);
      if (eager || !activeSet.has(conversationId)) {
        eligible.push(conversationId);
      }
    }

    if (eligible.length > 0) {
      setReadyToFetch((prev) => [...new Set([...prev, ...eligible])]);
    }
  }, [activeJobIds, queueVersion, timing]);

  useEffect(() => {
    setReadyToFetch((prev) => {
      const next = prev.filter((id) => !processedTitles.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [queueVersion]);

  // Fetch titles for ready conversations.
  const titleQueries = useQueries({
    queries: readyToFetch.map((conversationId) => ({
      queryKey: genTitleQueryKey(conversationId),
      queryFn: () => dataService.genTitle({ conversationId }),
      // Gate on `enabled` so no /gen_title request fires while unauthenticated
      // (e.g. after logout) even if the module-level queue still holds IDs.
      enabled,
      staleTime: Infinity,
      /** Retry only on 404 (title still generating server-side) so a transient
       * not-ready response is never treated as final. All other errors are
       * terminal. Bounded retry adapted from PR #13329. */
      retry: (failureCount: number, error: unknown) => isNotFoundError(error) && failureCount < 3,
      retryDelay: () => 5_000,
    })),
  });

  useEffect(() => {
    const activeSet = new Set(activeJobIds);
    titleQueries.forEach((titleQuery, index) => {
      const conversationId = readyToFetch[index];
      if (!conversationId || processedTitles.has(conversationId)) {
        return;
      }

      if (titleQuery.isSuccess && titleQuery.data) {
        const { title } = titleQuery.data;
        queryClient.setQueryData(
          [QueryKeys.conversation, conversationId],
          (convo: TConversation | undefined) => (convo ? { ...convo, title } : convo),
        );
        updateConvoInAllQueries(queryClient, conversationId, (c) => ({ ...c, title }));
        // Only update document title if this conversation is currently active
        if (window.location.pathname.includes(conversationId)) {
          setDocumentTitle(title);
        }
        markTitleGenerationProcessed(conversationId);
        setReadyToFetch((prev) => prev.filter((id) => id !== conversationId));
      } else if (titleQuery.isError) {
        // Retries are exhausted here (the query only retries on 404). A title may
        // still be generated *after* the stream completes (final mode generates
        // only once the response ends), so don't treat the first 404 as final —
        // guarantee one fresh, full-budget fetch cycle that runs post-completion.
        if (activeSet.has(conversationId)) {
          // Failed while still streaming: drop and clear so the completion
          // transition re-promotes a fresh fetch (instead of busy-looping).
          deferredTitles.add(conversationId);
          queryClient.removeQueries(genTitleQueryKey(conversationId));
          setReadyToFetch((prev) => prev.filter((id) => id !== conversationId));
        } else if (!deferredTitles.has(conversationId)) {
          // First failure at/after completion without a prior deferral: grant one
          // fresh cycle. Polling has stopped (no re-promotion), so reset the query
          // in place — `resetQueries` refetches active observers with a fresh retry
          // budget, unlike `removeQueries`, which leaves the observer in error state.
          deferredTitles.add(conversationId);
          queryClient.resetQueries(genTitleQueryKey(conversationId));
        } else {
          // The post-completion fetch also failed — the title is genuinely absent.
          markTitleGenerationProcessed(conversationId);
          setReadyToFetch((prev) => prev.filter((id) => id !== conversationId));
        }
      }
    });
  }, [titleQueries, readyToFetch, queryClient, activeJobIds]);
}

/**
 * React Query hook for active job IDs.
 * - Polls while jobs are active
 * - Shows generation indicators in conversation list
 */
export const ACTIVE_JOBS_POLL_MS = 5_000;
/**
 * How long to keep asking after the last job this client knew about ended.
 *
 * Fallback only, for a successor nothing local predicts — a background-tool
 * continuation, say. A queued turn is known in advance and reports itself
 * through `expectsSuccessor`, which needs no window at all.
 *
 * A successor the server admits for itself starts as part of terminalizing the
 * run before it. But finishing a run also empties this list, partly because
 * the client removes its own job optimistically the moment `FINAL` lands.
 * Stopping the poll on an empty list therefore goes quiet at exactly the
 * moment a successor appears, and with the tab already focused there is no
 * focus refetch to recover: the pane waits for a reload.
 */
export const ACTIVE_JOBS_SUCCESSOR_GRACE_MS = 30_000;

/** Module-scoped rather than per-observer: this is one shared query, and a
 *  component mounting mid-handover should inherit the grace, not restart it. */
let lastListedActiveJobsAt = 0;

/** @internal Test seam — the grace window is wall-clock state. */
export function resetActiveJobsGrace(): void {
  lastListedActiveJobsAt = 0;
}

/**
 * A generation was just observed live by some other means — a pane attached to
 * the run a queued turn produced — without the list ever reporting it, because
 * the run started and finished between two polls. The list's own notion of
 * "recently active" is therefore stale, and an unpredicted successor after
 * that run (a background-tool continuation) would find no poll left to notice
 * it. Restart the handover window from this observation instead.
 */
export function extendActiveJobsGrace(): void {
  lastListedActiveJobsAt = Date.now();
}

export function getActiveJobsRefetchInterval(
  data?: ActiveJobsResponse,
  expectsSuccessor = false,
): number | false {
  if ((data?.activeJobIds?.length ?? 0) > 0) {
    lastListedActiveJobsAt = Date.now();
    return ACTIVE_JOBS_POLL_MS;
  }
  /** A caller that knows the backend owes it a run says so outright, and keeps
   *  listening for as long as that stays true — no guess at how long admission
   *  takes. The window below is only for successors nothing local predicts. */
  if (expectsSuccessor) {
    return ACTIVE_JOBS_POLL_MS;
  }
  return Date.now() - lastListedActiveJobsAt < ACTIVE_JOBS_SUCCESSOR_GRACE_MS
    ? ACTIVE_JOBS_POLL_MS
    : false;
}

/**
 * @param expectsSuccessor Set by a caller holding positive evidence that the
 * backend owes this client a run it will start itself — a queued turn admitted
 * server-side, say. Observers each keep their own interval, so declaring it
 * affects only the caller that knows.
 */
export function useActiveJobs(enabled = true, expectsSuccessor = false) {
  return useQuery({
    queryKey: [QueryKeys.activeJobs],
    queryFn: () => dataService.getActiveJobs(),
    enabled,
    staleTime: 5_000,
    refetchOnMount: true,
    /** Unconditional: the interval is off while nothing is listed, so a run
     *  another client started during the last `staleTime` window would be
     *  invisible until some unrelated refetch, and returning to the tab is
     *  exactly when a pane needs to know whether its history has moved. */
    refetchOnWindowFocus: 'always',
    refetchInterval: (data?: ActiveJobsResponse) =>
      getActiveJobsRefetchInterval(data, expectsSuccessor),
    retry: false,
  });
}
