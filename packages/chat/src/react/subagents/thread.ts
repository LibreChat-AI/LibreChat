import type { SubagentThreadView } from 'librechat-data-provider';

/** How often a live child thread is re-read while the reader watches it. */
export const ACTIVE_THREAD_REFRESH_MS = 2_000;

/** Whether a thread view already holds the given task's turn or messages. */
export const subagentThreadHasTaskEvidence = (
  view: SubagentThreadView | undefined,
  taskId: string,
): boolean =>
  view?.turns?.some((turn) => turn.taskId === taskId) === true ||
  view?.messages.some(
    (message) =>
      message.messageId === `${taskId}:user` || message.messageId === `${taskId}:assistant`,
  ) === true;
