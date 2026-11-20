import { foldHolds } from '@librechat/chat/components';
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

const FOLD = '[data-fold-root]';
const FOLD_TOGGLE = '[data-fold-toggle]';
/** Deeper than the thread nests a call: a phase, a group, and room to spare. */
const MAX_FOLDS = 6;

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Opens the closed folds around a call, outermost first. A closed fold has not drawn its rows,
 * so the call is not in the document until every fold around it is open; each is opened through
 * its own header, as a reader would, and its rows are given a frame to arrive before the next
 * is looked for. Folds that are already open are left as they are.
 */
async function openFoldsAround(message: HTMLElement, toolCallId: string): Promise<void> {
  for (let depth = 0; depth < MAX_FOLDS; depth += 1) {
    const toggle = Array.from(message.querySelectorAll<HTMLElement>(FOLD))
      .filter((root) => foldHolds(root, toolCallId))
      .map((root) => root.querySelector<HTMLElement>(FOLD_TOGGLE))
      .find((button) => button?.getAttribute('aria-expanded') === 'false');
    if (toggle == null) {
      return;
    }
    toggle.click();
    await frame();
    await frame();
    if (toggle.isConnected && toggle.getAttribute('aria-expanded') === 'false') {
      return;
    }
  }
}

/**
 * Takes the reader to a tool row's call and opens it: the folds around it, then the call's own
 * details. Answers at once whether there is anywhere to go, which is whether the call's message
 * is among those loaded; the opening follows over the next few frames. `onLeave` runs before
 * anything moves, for a surface that has to step aside first.
 */
export function visitTaskTarget(row: TaskRow, onLeave?: () => void): boolean {
  const reached = findTaskTarget(row);
  if (reached == null) {
    return false;
  }
  onLeave?.();
  const message = row.messageId == null ? null : document.getElementById(row.messageId);
  void (async () => {
    if (message != null && row.toolCallId != null) {
      await openFoldsAround(message, row.toolCallId);
    }
    const target = findTaskTarget(row) ?? reached;
    const details = target.matches('[data-task-tool-call]')
      ? target.querySelector<HTMLElement>('button[aria-expanded="false"]')
      : null;
    details?.click();
    focusTaskTarget(target);
    if (details != null) {
      await frame();
    }
    scrollToTaskTarget(target);
  })();
  return true;
}
