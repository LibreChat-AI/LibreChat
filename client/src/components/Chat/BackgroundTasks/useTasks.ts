import { useCallback, useEffect, useMemo, useState } from 'react';
import { v4 } from 'uuid';
import { useQuery, useQueries } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { TMessage, ParentSubagentSummary } from 'librechat-data-provider';
import type { TaskRow, ToolCallArgs } from './rows';
import {
  countActive,
  buildTaskRows,
  subagentTaskKey,
  findToolCallArgs,
  countFailedDelivery,
  countAwaitingDelivery,
} from './rows';
import {
  useBackgroundTasksQuery,
  useSubagentControlMutation,
  useCancelBackgroundTasksMutation,
} from '~/data-provider';
import { useParentSubagents } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import parseJsonField from '~/components/Chat/Messages/Content/Parts/parseJsonField';
import { getToolCallIntent } from '~/components/Chat/Messages/Content/Parts/intent';

const noThreads: ReadonlyMap<string, ParentSubagentSummary> = new Map();
const noRefresh = async () => undefined;

export type BackgroundTasksView = {
  rows: TaskRow[];
  activeCount: number;
  /** Finished results that will still arrive as a new agent turn. */
  awaitingCount: number;
  /** Failed automatic deliveries still recoverable through an agent poll. */
  failedCount: number;
  /** A store outage or bounded list may hide remote results. */
  incomplete: boolean;
  /** Whether the deployment lets users stop ordinary background tools. */
  toolsCancellable: boolean;
  isStopping: boolean;
  stopFailed: boolean;
  loadFailed: boolean;
  retry: () => Promise<void>;
  canStop: (row: TaskRow) => boolean;
  stop: (row: TaskRow) => Promise<void>;
  stopAll: () => Promise<void>;
};

const describeToolCall = (args: ToolCallArgs): Pick<TaskRow, 'title' | 'detail'> => {
  if (args == null) return {};
  const title = getToolCallIntent(args);
  const detail = parseJsonField(args, 'command') || parseJsonField(args, 'code');
  return {
    ...(title == null ? {} : { title }),
    ...(detail === '' ? {} : { detail }),
  };
};

/**
 * Joins ordinary background tools (process registry) with detached subagents
 * (durable index) for one conversation, and stops one or every running task.
 */
export default function useBackgroundTasks({
  conversationId,
  isSubmitting,
  now,
}: {
  conversationId: string;
  isSubmitting: boolean;
  now: number;
}): BackgroundTasksView {
  const parent = useParentSubagents();
  // The URL can advance before the host conversation context during navigation.
  const matchesConversation = parent.conversationId === conversationId;
  const byThreadId = matchesConversation ? parent.byThreadId : noThreads;
  const refresh = matchesConversation ? parent.refresh : noRefresh;
  const subagentsError = matchesConversation && parent.isError;
  const discoveryEnabled = matchesConversation && parent.discoveryEnabled;
  const { data, isError, refetch } = useBackgroundTasksQuery(
    conversationId,
    { enabled: discoveryEnabled },
    isSubmitting,
  );
  const { mutateAsync: cancelTools } = useCancelBackgroundTasksMutation();
  const { mutateAsync: controlSubagent } = useSubagentControlMutation();
  const [stoppingThreads, setStoppingThreads] = useState<ReadonlySet<string>>(() => new Set());
  const [isStopping, setIsStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [pendingControls, setPendingControls] = useState<
    Array<{
      threadId: string;
      taskId: string;
      invocationId: string;
    }>
  >([]);
  const controls = useQueries({
    queries: pendingControls.map((control) => ({
      queryKey: [QueryKeys.subagentThread, conversationId, control.threadId, control.taskId],
      queryFn: () =>
        dataService.getSubagentThread(conversationId, control.threadId, control.taskId),
      retry: false,
      refetchInterval: 2_000,
      select: (view: Awaited<ReturnType<typeof dataService.getSubagentThread>>) =>
        view.controlReceipts?.find((receipt) => receipt.invocationId === control.invocationId)
          ?.status,
    })),
  });
  // Receipt acceptance is not completion: a queued control can fail after POST returns.
  const controlStates = controls.map((result) => result.data).join(',');
  useEffect(() => {
    const statuses = controlStates.split(',');
    const finished = pendingControls.filter((control, index) => {
      const child = byThreadId.get(control.threadId);
      return (
        statuses[index] === 'failed' ||
        statuses[index] === 'rejected' ||
        statuses[index] === 'applied' ||
        child?.latestTaskId !== control.taskId ||
        (child.status !== 'running' && child.status !== 'dispatched')
      );
    });
    if (finished.length === 0) return;
    const failed = pendingControls.filter((_, index) =>
      ['failed', 'rejected'].includes(statuses[index]),
    );
    if (failed.length > 0) {
      setStopFailed(true);
      setStoppingThreads((current) => {
        const next = new Set(current);
        for (const control of failed)
          next.delete(subagentTaskKey(control.threadId, control.taskId));
        return next;
      });
    }
    setPendingControls((current) => current.filter((control) => !finished.includes(control)));
  }, [controlStates, pendingControls, byThreadId]);

  useEffect(() => {
    setStoppingThreads((current) => {
      const active = new Set(
        [...byThreadId.values()]
          .filter((child) => child.status === 'running' || child.status === 'dispatched')
          .map((child) => subagentTaskKey(child.threadId, child.latestTaskId)),
      );
      const settled = [...current].filter((key) => !active.has(key));
      if (settled.length === 0) return current;
      const remaining = new Set(current);
      for (const threadId of settled) remaining.delete(threadId);
      return remaining;
    });
  }, [byThreadId]);

  /** Observe existing message data without fetching. Structural sharing of the
   * selected record ignores unrelated streaming text but includes late restoration. */
  const selectArgs = useCallback(
    (messages: TMessage[]) => Object.fromEntries(findToolCallArgs(messages, data?.tasks ?? [])),
    [data?.tasks],
  );
  const { data: selectedArgs } = useQuery<TMessage[], unknown, Record<string, ToolCallArgs>>({
    queryKey: [QueryKeys.messages, conversationId],
    enabled: false,
    select: selectArgs,
  });
  const args = useMemo(() => new Map(Object.entries(selectedArgs ?? {})), [selectedArgs]);
  const retry = useCallback(async () => {
    await Promise.allSettled([
      refetch(),
      refresh(),
      ...controls.map((control) => control.refetch()),
    ]);
  }, [refetch, refresh, controls]);

  const rows = useMemo(
    () =>
      buildTaskRows({
        tools: data?.tasks ?? [],
        subagents: [...byThreadId.values()],
        stoppingThreads,
        now,
        args,
        describe: describeToolCall,
      }),
    [data?.tasks, byThreadId, stoppingThreads, now, args],
  );

  const toolsCancellable = data?.cancellable === true;
  const canStop = useCallback(
    (row: TaskRow) =>
      row.status === 'running' &&
      (row.subagent != null || (row.kind === 'tool' && toolsCancellable)),
    [toolsCancellable],
  );

  const stopRows = useCallback(
    async (targets: TaskRow[]) => {
      const toolIds = targets.flatMap((row) =>
        row.kind === 'tool' && row.taskId ? [row.taskId] : [],
      );
      const subagents = targets.flatMap((row) => (row.subagent == null ? [] : [row.subagent]));
      if (toolIds.length === 0 && subagents.length === 0) return;
      setIsStopping(true);
      setStopFailed(false);
      setStoppingThreads(
        (current) =>
          new Set([
            ...current,
            ...subagents.map((target) => subagentTaskKey(target.threadId, target.taskId)),
          ]),
      );
      const submittedAt = new Date().toISOString();
      const [toolFailed, subagentResults] = await Promise.all([
        toolIds.length > 0
          ? cancelTools({ conversationId, body: { taskIds: toolIds } })
              .then(({ results }) =>
                results.some(
                  (result) =>
                    !['requested', 'already_requested', 'settled'].includes(result.status),
                ),
              )
              .catch(() => true)
          : Promise.resolve(false),
        Promise.allSettled(
          subagents.map(async ({ threadId, taskId }) => {
            const invocationId = v4();
            const result = await controlSubagent({
              parentConversationId: conversationId,
              threadId,
              command: { taskId, invocationId, action: 'cancel' },
              submittedAt,
            });
            if (result.receipt.status === 'accepted') {
              setPendingControls((current) => [...current, { threadId, taskId, invocationId }]);
            }
            return result;
          }),
        ),
      ]);
      const failedThreads = subagents.flatMap(({ threadId, taskId }, index) => {
        const result = subagentResults[index];
        return result.status === 'rejected' ||
          (result.value.receipt.status !== 'accepted' && result.value.receipt.status !== 'applied')
          ? [subagentTaskKey(threadId, taskId)]
          : [];
      });
      if (failedThreads.length > 0) {
        setStoppingThreads((current) => {
          const remaining = new Set(current);
          for (const threadId of failedThreads) remaining.delete(threadId);
          return remaining;
        });
      }
      let failed = toolFailed || failedThreads.length > 0;
      if (subagents.length > 0) {
        try {
          await refresh();
        } catch {
          failed = true;
        }
      }
      if (failed) setStopFailed(true);
      setIsStopping(false);
    },
    [conversationId, cancelTools, controlSubagent, refresh],
  );

  const stop = useCallback(
    (row: TaskRow) => stopRows(canStop(row) ? [row] : []),
    [stopRows, canStop],
  );
  const stopAll = useCallback(() => stopRows(rows.filter(canStop)), [stopRows, rows, canStop]);

  return {
    rows,
    activeCount: countActive(rows),
    awaitingCount: countAwaitingDelivery(rows),
    failedCount: countFailedDelivery(rows),
    incomplete: data?.complete === false,
    toolsCancellable,
    isStopping,
    stopFailed,
    loadFailed: isError || subagentsError || controls.some((control) => control.isError),
    retry,
    canStop,
    stop,
    stopAll,
  };
}
