import { createContext, useContext } from 'react';
import { atom, createStore } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService, hasToolCallPreview } from 'librechat-data-provider';
import type { SubagentTaskContentSnapshot, ToolCallPartResponse } from 'librechat-data-provider';
import type { QueryClient, UseQueryOptions } from '@tanstack/react-query';
import type { ToolContentQuery } from '~/components/Chat/Messages/Content/disclosure';
import type { RecoveredContent } from '~/components/Chat/Subagents/recovery';
import { recoverTaskContent, recoveredToolPart } from '~/components/Chat/Subagents/recovery';
import { isLiveSubagentStatus } from '~/components/Chat/Subagents/status';
import { ACTIVE_THREAD_REFRESH_MS } from './queries';

export type TaskContentScope = {
  parentConversationId: string;
  threadId: string;
  taskId: string;
};

export const TaskContentScopeContext = createContext<TaskContentScope | null>(null);
export const subagentTaskContentKey = (scope: TaskContentScope) =>
  [
    QueryKeys.subagentTaskContent,
    scope.parentConversationId,
    scope.threadId,
    scope.taskId,
  ] as const;

const streams = new WeakMap<object, ReturnType<typeof createRecoveryState>>();
const createRecoveryState = () => ({
  store: createStore(),
  stream: atom<RecoveredContent | null>(null),
  partReaders: 0,
});

function recoveryState(queryClient: QueryClient, scope: TaskContentScope) {
  const query = queryClient.getQueryCache().build(queryClient, {
    queryKey: subagentTaskContentKey(scope),
  });
  let state = streams.get(query);
  if (state == null) {
    state = createRecoveryState();
    streams.set(query, state);
  }
  return state;
}

async function loadTaskContent(
  queryClient: QueryClient,
  scope: TaskContentScope,
  signal?: AbortSignal,
  fresh = false,
): Promise<SubagentTaskContentSnapshot> {
  const { store, stream } = recoveryState(queryClient, scope);
  const before = fresh ? null : store.get(stream);
  const load = async (afterSequence?: number, cursor?: string) => {
    const response = await dataService.getSubagentTaskContent(
      scope.parentConversationId,
      scope.threadId,
      scope.taskId,
      afterSequence,
      cursor,
    );
    if (
      response.taskId !== scope.taskId ||
      response.threadId !== scope.threadId ||
      response.parentConversationId !== scope.parentConversationId
    ) {
      throw new Error('subagent_content_identity_mismatch');
    }
    return response;
  };
  let next: RecoveredContent;
  try {
    next = await recoverTaskContent(before, load, signal);
  } catch (error) {
    const code = responseCode(error);
    if (code !== 'SUBAGENT_CONTENT_AHEAD' && code !== 'SUBAGENT_CONTENT_GAP') throw error;
    next = await recoverTaskContent(null, load, signal);
  }
  if (signal?.aborted) throw new Error('subagent_content_cancelled');
  const current = store.get(stream);
  if (
    current != null &&
    (current.snapshot.throughSequence > next.snapshot.throughSequence ||
      current.snapshot.revision > next.snapshot.revision)
  )
    return current.snapshot;
  store.set(stream, next);
  return next.snapshot;
}

async function loadFullTaskContent(
  queryClient: QueryClient,
  scope: TaskContentScope,
  signal?: AbortSignal,
): Promise<SubagentTaskContentSnapshot> {
  if (signal?.aborted) throw new Error('subagent_content_cancelled');
  const state = recoveryState(queryClient, scope);
  const queryKey = subagentTaskContentKey(scope);
  const query = queryClient.getQueryCache().find(queryKey, { exact: true });
  state.partReaders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.partReaders--;
    if (signal?.aborted && state.partReaders === 0 && query?.getObserversCount() === 0) {
      void query.cancel({ revert: true });
    }
  };
  signal?.addEventListener('abort', release, { once: true });
  try {
    return await queryClient.fetchQuery<SubagentTaskContentSnapshot>({
      queryKey,
      queryFn: ({ signal: taskSignal }) => loadTaskContent(queryClient, scope, taskSignal, true),
      staleTime: 0,
    });
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
}

type ContentError = { response?: { status?: number; data?: { code?: string } } };
const responseStatus = (error: unknown): number | undefined =>
  (error as ContentError | null)?.response?.status;
const responseCode = (error: unknown): string | undefined =>
  (error as ContentError | null)?.response?.data?.code;
export const isLegacyContentUnavailable = (error: unknown): boolean =>
  responseStatus(error) === 404 ||
  (responseStatus(error) === 409 && responseCode(error) === 'SUBAGENT_CONTENT_UNAVAILABLE');

export function subagentContentRefetchInterval(
  snapshot: SubagentTaskContentSnapshot | undefined,
  error?: unknown,
): number | false {
  if (isLegacyContentUnavailable(error)) return false;
  if (snapshot == null || isLiveSubagentStatus(snapshot.status)) return ACTIVE_THREAD_REFRESH_MS;
  const remaining = (snapshot.retryUntil ?? 0) - Date.now();
  if (snapshot.recovery !== 'partial' || !Number.isFinite(remaining) || remaining <= 0)
    return false;
  return Math.min(ACTIVE_THREAD_REFRESH_MS, remaining);
}

export function useSubagentTaskContentQuery(
  scope: TaskContentScope,
  options: UseQueryOptions<SubagentTaskContentSnapshot> = {},
) {
  const queryClient = useQueryClient();
  const query = useQuery<SubagentTaskContentSnapshot>(
    subagentTaskContentKey(scope),
    ({ signal }) => loadTaskContent(queryClient, scope, signal),
    {
      enabled: scope.parentConversationId !== '' && scope.threadId !== '' && scope.taskId !== '',
      retry: (attempt, error) => !isLegacyContentUnavailable(error) && attempt < 2,
      refetchOnWindowFocus: true,
      refetchInterval: (snapshot, query) =>
        subagentContentRefetchInterval(snapshot, query.state.error),
      ...options,
    },
  );
  return { ...query, isUnavailable: isLegacyContentUnavailable(query.error) };
}

/** Uses the parent-authorized task endpoint, never the child's private message route. */
export const useSubagentToolContentQuery: ToolContentQuery = (params, options, revision = '') => {
  const scope = useContext(TaskContentScopeContext);
  const queryClient = useQueryClient();
  return useQuery<ToolCallPartResponse>(
    [
      ...subagentTaskContentKey(scope ?? { parentConversationId: '', threadId: '', taskId: '' }),
      'part',
      params.conversationId,
      params.messageId,
      params.toolCallId,
      params.stepId,
      params.agentId,
      params.partIndex,
      revision,
    ],
    async ({ signal }) => {
      if (scope == null) throw new Error('subagent_content_scope_required');
      const cached = queryClient.getQueryData<SubagentTaskContentSnapshot>(
        subagentTaskContentKey(scope),
      );
      let part = cached == null ? null : recoveredToolPart(cached, params);
      if (cached != null && cached.messageId !== params.messageId) {
        throw new Error('subagent_content_identity_mismatch');
      }
      if (part == null || hasToolCallPreview(part.tool_call)) {
        const full = await loadFullTaskContent(queryClient, scope, signal);
        if (signal?.aborted) throw new Error('subagent_content_cancelled');
        if (full.messageId !== params.messageId)
          throw new Error('subagent_content_identity_mismatch');
        part = recoveredToolPart(full, params);
      }
      if (part == null || hasToolCallPreview(part.tool_call))
        throw new Error('subagent_content_part_unavailable');
      return { conversationId: params.conversationId, messageId: params.messageId, ...part };
    },
    {
      staleTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
      ...options,
      enabled: scope != null && options?.enabled !== false,
    },
  );
};
