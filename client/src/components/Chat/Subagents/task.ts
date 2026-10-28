import { useCallback, useMemo } from 'react';
import type { ActiveSubagentPanel } from './state';
import { useParentSubagents } from './ParentSubagentsProvider';
import { durableSubagentSelection } from './eventSelection';
import { useShareContext } from '~/Providers/ShareContext';
import { useOpenSubagentPanel } from './surface';
import { useMessageContext } from '~/Providers';

/** One durable child task, as a wake-up or a background-task check names it. */
export interface DurableSubagentTask {
  threadId?: string;
  taskId: string;
  subagentType?: string;
  settled: boolean;
}

/**
 * Opens the unified activity panel on one durable child task. Share pages have
 * no authenticated thread panel, so they get no selection; a selection there
 * would be written and silently ignored.
 */
export function useSubagentTaskPanel(
  task: DurableSubagentTask | null,
  conversationId?: string | null,
): { selection: ActiveSubagentPanel | null; open: (() => void) | null } {
  const { isSharedConvo } = useShareContext();
  const { messageId } = useMessageContext();
  const { byThreadId } = useParentSubagents();
  const openPanel = useOpenSubagentPanel();
  const threadId = task?.threadId;
  const child = threadId == null ? undefined : byThreadId.get(threadId);
  const selection = useMemo<ActiveSubagentPanel | null>(() => {
    if (
      task == null ||
      threadId == null ||
      isSharedConvo === true ||
      conversationId == null ||
      conversationId === ''
    ) {
      return null;
    }
    if (child != null) {
      return durableSubagentSelection(conversationId, child, task.taskId);
    }
    /** The bounded discovery index can omit older children; the task already
     *  carries the exact durable identities, so link to the authorized thread
     *  query directly instead of requiring index membership. */
    return {
      host: 'conversation',
      parentConversationId: conversationId,
      parentMessageId: messageId,
      toolCallId: `wakeup:${threadId}`,
      partIndex: 0,
      subagentType: task.subagentType ?? '',
      initialProgress: task.settled ? 1 : 0,
      isSubmitting: false,
      durable: { threadId, taskId: task.taskId },
    };
  }, [child, conversationId, isSharedConvo, messageId, task, threadId]);
  const open = useCallback(() => {
    if (selection != null) {
      openPanel?.(selection);
    }
  }, [openPanel, selection]);
  return { selection, open: selection == null || openPanel == null ? null : open };
}
