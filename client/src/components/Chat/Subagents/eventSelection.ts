import type { ParentSubagentSummary } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from './state';

export const eventTaskProgressKey = (threadId: string, taskId: string) =>
  `event-task:${threadId}:${taskId}`;

export const eventSubagentSelection = (
  parentConversationId: string,
  child: ParentSubagentSummary,
  siblingParentMessageIds?: string[],
  requestedTaskId?: string,
): ActiveSubagentPanel | null => {
  const taskId = requestedTaskId ?? child.latestTaskId;
  if (child.origin !== 'event' || child.actorId == null || taskId == null) return null;
  /** Any explicitly requested task stays pinned — even today's latest task can
   *  be displaced by a newer delivery while the panel is open. */
  const pinnedTask = requestedTaskId != null;
  return {
    host: 'conversation',
    parentConversationId,
    parentMessageId: child.parentMessageId,
    toolCallId: `event-thread:${child.threadId}`,
    partIndex: 0,
    subagentType: child.subagentType,
    initialProgress: child.status === 'completed' ? 1 : 0,
    isSubmitting: child.status === 'running',
    durable: { threadId: child.threadId, taskId },
    event: {
      actorId: child.actorId,
      progressKey: eventTaskProgressKey(child.threadId, taskId),
      ...(siblingParentMessageIds == null ? {} : { siblingParentMessageIds }),
      ...(pinnedTask ? { pinnedTask: true } : {}),
    },
  };
};

/** Panel selection for one durable task of an indexed child thread, regardless
 * of how the child was dispatched. Event actors reuse their event selection so
 * the panel keeps its actor picker and task timeline. */
export const durableSubagentSelection = (
  parentConversationId: string,
  child: ParentSubagentSummary,
  taskId: string,
): ActiveSubagentPanel | null => {
  if (child.origin === 'event') {
    return eventSubagentSelection(parentConversationId, child, undefined, taskId);
  }
  const taskStatus = child.tasks.find((task) => task.taskId === taskId)?.status ?? child.status;
  return {
    host: 'conversation',
    parentConversationId,
    parentMessageId: child.parentMessageId,
    toolCallId: child.parentToolCallId ?? `subagent-thread:${child.threadId}`,
    partIndex: 0,
    subagentType: child.subagentType,
    initialProgress: taskStatus === 'running' ? 0 : 1,
    isSubmitting: taskStatus === 'running',
    durable: { threadId: child.threadId, taskId },
  };
};
