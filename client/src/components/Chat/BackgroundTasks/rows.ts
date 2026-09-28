import { ContentTypes } from 'librechat-data-provider';
import type {
  TMessage,
  BackgroundTaskSummary,
  BackgroundTaskDelivery,
  ParentSubagentSummary,
  SubagentThreadStatus,
} from 'librechat-data-provider';

export type TaskRowStatus = 'running' | 'stopping' | 'completed' | 'error' | 'cancelled';

/** A finished result the agent has not received yet, or never will. */
export type TaskRowDelivery = Extract<BackgroundTaskDelivery, 'pending' | 'failed'>;

export type TaskRow = {
  id: string;
  kind: 'tool' | 'subagent';
  /** Tool id for tool rows, thread title for subagent rows. */
  name: string;
  /** The call's model-authored intent, when its tool call is in the loaded messages. */
  title?: string;
  /** The command or code the call ran, for the expanded card. */
  detail?: string;
  /** Tool cancel target. */
  taskId?: string;
  status: TaskRowStatus;
  startedAt?: number;
  settledAt?: number;
  delivery?: TaskRowDelivery;
  /** Subagent cancel target; present only while the child can still be stopped. */
  subagent?: { threadId: string; taskId: string };
};

/** Matches the server registry's settled-task retention, so both kinds age out together. */
export const RECENT_SUBAGENT_WINDOW_MS = 60 * 60 * 1000;

const time = (value?: string): number | undefined => {
  if (value == null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const subagentStatus = (status: SubagentThreadStatus): TaskRowStatus => {
  if (status === 'running' || status === 'dispatched') return 'running';
  if (status === 'failed' || status === 'interrupted') return 'error';
  return status;
};

export type ToolCallArgs = string | Record<string, unknown> | undefined;

/** Legacy identities are usable only when they resolve unambiguously. */
const toolCallKey = (messageId: string | undefined, toolCallId: string, stepId?: string): string =>
  `${messageId ?? ''}\u0000${toolCallId}${stepId == null ? '' : `\u0000${stepId}`}`;

export const subagentTaskKey = (threadId: string, taskId?: string): string =>
  `${threadId}\u0000${taskId ?? ''}`;

export function findToolCallArgs(
  messages: readonly TMessage[] | undefined,
  tasks: readonly Pick<BackgroundTaskSummary, 'messageId' | 'toolCallId' | 'stepId'>[],
): Map<string, ToolCallArgs> {
  const found = new Map<string, ToolCallArgs>();
  if (messages == null || tasks.length === 0) return found;
  const wanted = new Set(
    tasks.map((task) => toolCallKey(task.messageId, task.toolCallId, task.stepId)),
  );
  const ambiguous = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    for (const part of message.content ?? []) {
      if (part?.type !== ContentTypes.TOOL_CALL) continue;
      const call = part[ContentTypes.TOOL_CALL] as
        | { id?: string; stepId?: string; args?: ToolCallArgs }
        | undefined;
      if (call?.id == null) continue;
      const keys = new Set([
        toolCallKey(message.messageId, call.id, call.stepId),
        toolCallKey(message.messageId, call.id),
        toolCallKey(undefined, call.id, call.stepId),
        toolCallKey(undefined, call.id),
      ]);
      for (const key of keys) {
        if (!wanted.has(key)) continue;
        if (found.has(key)) ambiguous.add(key);
        found.set(key, call.args);
      }
    }
  }
  for (const key of ambiguous) found.delete(key);
  return found;
}

export type ToolCallDescriber = (args: ToolCallArgs) => Pick<TaskRow, 'title' | 'detail'>;

const undelivered = (task: BackgroundTaskSummary): TaskRowDelivery | undefined =>
  task.status !== 'running' && (task.delivery === 'pending' || task.delivery === 'failed')
    ? task.delivery
    : undefined;

const toolRow = (
  task: BackgroundTaskSummary,
  described: Pick<TaskRow, 'title' | 'detail'>,
): TaskRow => {
  const delivery = undelivered(task);
  return {
    id: `tool:${task.taskId}`,
    kind: 'tool',
    name: task.toolName,
    taskId: task.taskId,
    ...described,
    status: task.status === 'running' && task.cancellationRequested ? 'stopping' : task.status,
    startedAt: time(task.startedAt),
    settledAt: time(task.settledAt),
    ...(delivery == null ? {} : { delivery }),
  };
};

const subagentRow = (child: ParentSubagentSummary, stopping: ReadonlySet<string>): TaskRow => {
  const status = subagentStatus(child.status);
  const running = status === 'running';
  const taskId = child.latestTaskId;
  return {
    id: `subagent:${subagentTaskKey(child.threadId, taskId)}`,
    kind: 'subagent',
    name: child.title,
    status: running && stopping.has(subagentTaskKey(child.threadId, taskId)) ? 'stopping' : status,
    startedAt: time(child.tasks.find((task) => task.taskId === taskId)?.createdAt),
    settledAt: running ? undefined : time(child.updatedAt),
    ...(running && taskId != null ? { subagent: { threadId: child.threadId, taskId } } : {}),
  };
};

const isActive = (row: TaskRow) => row.status === 'running' || row.status === 'stopping';

/** A finished result still on its way to the agent keeps the task relevant. */
const isAwaitingDelivery = (row: TaskRow) => row.delivery === 'pending';
const isFailedDelivery = (row: TaskRow) => row.delivery === 'failed';

const rank = (row: TaskRow): number => {
  if (isActive(row)) return 3;
  if (isAwaitingDelivery(row)) return 2;
  return isFailedDelivery(row) ? 1 : 0;
};

/**
 * One list across both background kinds: active rows first, then the most
 * recently started. Settled subagents older than the registry's retention are
 * dropped so a long conversation does not list its whole history. Apply the
 * same bound to cached tools after their terminal response stops polling.
 */
export function buildTaskRows({
  tools,
  subagents,
  stoppingThreads,
  now,
  describe,
  args,
}: {
  describe: ToolCallDescriber;
  args: ReadonlyMap<string, ToolCallArgs>;
  tools: readonly BackgroundTaskSummary[];
  subagents: readonly ParentSubagentSummary[];
  stoppingThreads: ReadonlySet<string>;
  now: number;
}): TaskRow[] {
  const rows = tools.map((task) =>
    toolRow(task, describe(args.get(toolCallKey(task.messageId, task.toolCallId, task.stepId)))),
  );
  for (const child of subagents) {
    const row = subagentRow(child, stoppingThreads);
    rows.push(row);
  }
  return rows
    .filter(
      (row) =>
        isActive(row) ||
        isAwaitingDelivery(row) ||
        isFailedDelivery(row) ||
        row.settledAt == null ||
        now - row.settledAt <= RECENT_SUBAGENT_WINDOW_MS,
    )
    .sort((left, right) => {
      const ranked = rank(right) - rank(left);
      return ranked !== 0 ? ranked : (right.startedAt ?? 0) - (left.startedAt ?? 0);
    });
}

export const countActive = (rows: readonly TaskRow[]) => rows.filter(isActive).length;

export const countAwaitingDelivery = (rows: readonly TaskRow[]) =>
  rows.filter(isAwaitingDelivery).length;

export const countFailedDelivery = (rows: readonly TaskRow[]) =>
  rows.filter(isFailedDelivery).length;
