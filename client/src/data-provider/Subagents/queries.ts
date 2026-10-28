import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  ParentSubagentIndex,
  SubagentControlReceipt,
  SubagentControlRequest,
  SubagentControlResponse,
  SubagentThreadView,
} from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';

const responseStatus = (error: unknown): number | undefined => {
  if (error == null || typeof error !== 'object') return undefined;
  const candidate = error as { status?: number; response?: { status?: number } };
  return candidate.response?.status ?? candidate.status;
};

export const ACTIVE_THREAD_REFRESH_MS = 2_000;
const IDLE_PARENT_REFRESH_MS = 10_000;
const QUIET_PARENT_REFRESH_MS = 60_000;
const CHILD_READY_POLL_WINDOW_MS = 60_000;

/** Streamed child lifecycle events wake local discovery; the capped fallback finds
 * children published elsewhere when this tab has no active parent stream. */
export const parentSubagentsRefetchInterval = (
  index: ParentSubagentIndex | undefined,
  isSubmitting = false,
  error?: unknown,
  dataUpdateCount = 0,
  readinessDeadline = 0,
): number | false => {
  if (responseStatus(error) === 404) {
    return isSubmitting && Date.now() < readinessDeadline ? IDLE_PARENT_REFRESH_MS : false;
  }
  if (index?.children.some((child) => child.status === 'running') === true) {
    return ACTIVE_THREAD_REFRESH_MS;
  }
  if (isSubmitting || index?.children.some((child) => child.status === 'dispatched')) {
    return IDLE_PARENT_REFRESH_MS;
  }
  if (index == null && error == null) {
    return IDLE_PARENT_REFRESH_MS;
  }
  // Recheck the first empty result soon: publication may still be committing.
  return dataUpdateCount <= 1 && error == null ? IDLE_PARENT_REFRESH_MS : QUIET_PARENT_REFRESH_MS;
};

export const useParentSubagentsQuery = (
  parentConversationId: string,
  config?: UseQueryOptions<ParentSubagentIndex>,
  isSubmitting = false,
) => {
  const readinessKey = `${parentConversationId}\u0000${isSubmitting}`;
  const readiness = useMemo(
    () => ({ key: readinessKey, deadline: Date.now() + CHILD_READY_POLL_WINDOW_MS }),
    [readinessKey],
  );
  return useQuery<ParentSubagentIndex>(
    [QueryKeys.parentSubagents, parentConversationId],
    () => dataService.getParentSubagents(parentConversationId),
    {
      enabled:
        parentConversationId !== '' &&
        parentConversationId !== Constants.NEW_CONVO &&
        parentConversationId !== Constants.PENDING_CONVO,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => responseStatus(error) !== 404 && failureCount < 3,
      refetchInterval: (index, query) =>
        parentSubagentsRefetchInterval(
          index,
          isSubmitting,
          query.state.error,
          query.state.dataUpdateCount,
          readiness.deadline,
        ),
      refetchIntervalInBackground: false,
      ...config,
    },
  );
};

const isTerminal = (status: SubagentThreadView['status']): boolean =>
  status === 'completed' ||
  status === 'failed' ||
  status === 'interrupted' ||
  status === 'cancelled';

export const subagentThreadHasTaskEvidence = (
  view: SubagentThreadView | undefined,
  taskId: string,
): boolean =>
  view?.turns?.some((turn) => turn.taskId === taskId) === true ||
  view?.messages.some(
    (message) =>
      message.messageId === `${taskId}:user` || message.messageId === `${taskId}:assistant`,
  ) === true;

export const subagentThreadRefetchInterval = (
  view: SubagentThreadView | undefined,
  readinessDeadline: number,
  now = Date.now(),
  expectedTaskId?: string,
): number | false => {
  if (expectedTaskId != null && !subagentThreadHasTaskEvidence(view, expectedTaskId)) {
    return now < readinessDeadline ? ACTIVE_THREAD_REFRESH_MS : false;
  }
  // During a rolling deploy, an older replica can return a thread-wide status
  // without the task-scoped activity projection. The exact assistant row is
  // nevertheless authoritative evidence that this selected invocation ended.
  if (
    expectedTaskId != null &&
    view?.activity == null &&
    view?.messages.some((message) => message.messageId === `${expectedTaskId}:assistant`)
  ) {
    return false;
  }
  if (view == null || view.status === 'dispatched') {
    return now < readinessDeadline ? ACTIVE_THREAD_REFRESH_MS : false;
  }
  return isTerminal(view.status) ? false : ACTIVE_THREAD_REFRESH_MS;
};

export const isSubagentReadinessPending = (
  error: unknown,
  readinessDeadline: number,
  now = Date.now(),
): boolean => responseStatus(error) === 404 && now < readinessDeadline;

export type SubagentThreadQueryResult = QueryObserverResult<SubagentThreadView> & {
  isReadinessPending: boolean;
};

export const useSubagentThreadQuery = (
  parentConversationId: string,
  threadId: string,
  taskId: string,
  config?: UseQueryOptions<SubagentThreadView>,
): SubagentThreadQueryResult => {
  const readinessKey = `${parentConversationId}\u0000${threadId}\u0000${taskId}`;
  const readiness = useMemo(
    () => ({ key: readinessKey, deadline: Date.now() + CHILD_READY_POLL_WINDOW_MS }),
    [readinessKey],
  );
  const query = useQuery<SubagentThreadView>(
    [QueryKeys.subagentThread, parentConversationId, threadId, taskId],
    () => dataService.getSubagentThread(parentConversationId, threadId, taskId),
    {
      enabled: parentConversationId !== '' && threadId !== '',
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (view) =>
        subagentThreadRefetchInterval(view, readiness.deadline, Date.now(), taskId),
      ...config,
    },
  );

  return {
    ...query,
    isReadinessPending: isSubagentReadinessPending(query.error, readiness.deadline),
  };
};

export type SubagentControlVariables = {
  parentConversationId: string;
  threadId: string;
  command: SubagentControlRequest;
  /** Client-only timestamp retained across retries; never sent to the API. */
  submittedAt: string;
};

type SubagentControlMutationOptions = {
  onSuccess?: (data: SubagentControlResponse, variables: SubagentControlVariables) => void;
  onError?: (error: Error, variables: SubagentControlVariables) => void;
};

const isTerminalControlReceipt = (receipt: SubagentControlReceipt): boolean =>
  receipt.status === 'applied' || receipt.status === 'rejected' || receipt.status === 'failed';

/** Reconciles a mutation response without allowing an older accepted projection
 * to replace a terminal receipt delivered by the concurrent activity refresh. */
export const reconcileSubagentControlReceipts = (
  receipts: SubagentControlReceipt[],
  incoming: SubagentControlReceipt,
): SubagentControlReceipt[] => {
  const index = receipts.findIndex((candidate) => candidate.invocationId === incoming.invocationId);
  if (index === -1) return [...receipts, incoming];
  const current = receipts[index];
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (
    (isTerminalControlReceipt(current) && !isTerminalControlReceipt(incoming)) ||
    (Number.isFinite(currentUpdatedAt) &&
      Number.isFinite(incomingUpdatedAt) &&
      currentUpdatedAt > incomingUpdatedAt)
  ) {
    return receipts;
  }
  return receipts.map((candidate, candidateIndex) =>
    candidateIndex === index ? incoming : candidate,
  );
};

export const useSubagentControlMutation = (options: SubagentControlMutationOptions = {}) => {
  const queryClient = useQueryClient();
  return useMutation<SubagentControlResponse, Error, SubagentControlVariables>(
    ({ parentConversationId, threadId, command }) =>
      dataService.controlSubagentTask(parentConversationId, threadId, command),
    {
      mutationKey: [MutationKeys.subagentControl],
      onSuccess: ({ receipt }, { parentConversationId, threadId, command, submittedAt }) => {
        const key = [QueryKeys.subagentThread, parentConversationId, threadId, command.taskId];
        queryClient.setQueryData<SubagentThreadView | undefined>(key, (current) => {
          if (current == null) return current;
          return {
            ...current,
            controlReceipts: reconcileSubagentControlReceipts(
              current.controlReceipts ?? [],
              receipt,
            ),
          };
        });
        void queryClient.invalidateQueries(key);
        options.onSuccess?.({ receipt }, { parentConversationId, threadId, command, submittedAt });
      },
      onError: (error, variables) => options.onError?.(error, variables),
    },
  );
};
