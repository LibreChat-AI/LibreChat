import type { TaskRow } from './rows';

/**
 * The rendered call a tool row points at, when the loaded messages hold it and it can be
 * reached. Legacy call ids are only usable when they identify one rendered call.
 */
export function findTaskTarget(row: TaskRow): HTMLElement | null {
  if (row.messageId == null) return null;
  const message = document.getElementById(row.messageId);
  if (message == null) return null;
  const destinations = Array.from(
    message.querySelectorAll<HTMLElement>('[data-task-tool-call]'),
  ).filter(
    (element) =>
      element.dataset.taskToolCall === row.toolCallId &&
      (row.stepId == null || element.dataset.taskStep === row.stepId),
  );
  const targets = Array.from(
    message.querySelectorAll<HTMLElement>(
      '[data-tool-call-id], [data-subagent-tool-call], [data-subagent-thread]',
    ),
  ).filter(
    (element) =>
      (row.threadId != null && element.dataset.subagentThread === row.threadId) ||
      (row.toolCallId != null &&
        (element.dataset.toolCallId === row.toolCallId ||
          element.dataset.subagentToolCall === row.toolCallId)),
  );
  const threads =
    row.threadId == null
      ? []
      : targets.filter((element) => element.dataset.subagentThread === row.threadId);
  let target = message;
  if (threads.length === 1) target = threads[0];
  else if (destinations.length === 1) target = destinations[0];
  else if (destinations.length === 0 && targets.length === 1) target = targets[0];
  return target.closest('[inert], [hidden], [aria-hidden="true"]') == null ? target : null;
}

/** Moves focus to the call; an element that takes none by itself is focusable until it loses it. */
export function focusTaskTarget(target: HTMLElement): void {
  if (!target.hasAttribute('tabindex') && !target.matches('button')) {
    target.tabIndex = -1;
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
  }
  target.focus({ preventScroll: true });
}

export function scrollToTaskTarget(target: HTMLElement): void {
  target.scrollIntoView?.({
    block: 'center',
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
  });
}
