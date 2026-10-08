/** Rows in the sidebar's Pinned section. A favorite row is focusable itself
 *  (`role="button"`), while a chat row is a plain container whose link carries
 *  the focus, so both shapes have to be handled. */
const PINNED_ROW_SELECTOR = '[data-testid="convo-item"],[data-testid="favorite-item"]';

/** Where focus goes when a removed row has no neighbour left. In sidebar order:
 *  the expanded panel's own control, the mobile drawer's, then the chat
 *  header's. */
const NEW_CHAT_CONTROLS = [
  '[data-testid="new-chat-button"]',
  '[data-testid="nav-new-chat-fab"]',
  '[data-testid="header-new-chat-button"]',
];

const findNewChatControl = (): HTMLElement | null => {
  for (const selector of NEW_CHAT_CONTROLS) {
    const control = document.querySelector<HTMLElement>(selector);
    if (control) {
      return control;
    }
  }
  return null;
};

const focusableWithin = (row: HTMLElement): HTMLElement | null => {
  if (row.matches('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')) {
    return row;
  }
  return row.querySelector<HTMLElement>('a[href],button:not([disabled])');
};

/**
 * The element that should take focus when `row` is removed: the row below, else
 * the one above, else the New Chat button. Resolve this *before* starting the
 * removal: once the row unmounts there is no longer a position to search from.
 */
export const resolveRowBeside = (row: HTMLElement | null): HTMLElement | null => {
  /* Scoped to the Pinned section by its own marker, not by role: the whole
   * conversations pane is a labelled region too, and the project lists inside
   * it render this same row. Unpinning a chat there only clears its pinned
   * flag, so that row stays put and its focus must stay with it. */
  const scope = row?.closest('[data-pinned-section]');
  if (row && scope) {
    const rows = Array.from(scope.querySelectorAll<HTMLElement>(PINNED_ROW_SELECTOR));
    const current = rows.indexOf(row);
    const neighbour = rows[current + 1] ?? rows[current - 1];
    const target = neighbour ? focusableWithin(neighbour) : null;
    if (target) {
      return target;
    }
  }

  if (!scope) {
    return null;
  }
  return findNewChatControl();
};

/**
 * The row's own focusable element, for when the row itself survives but the
 * control that had focus does not: unpinning from a project list only clears
 * the flag, and the pin badge that was focused disappears with it.
 */
export const focusableInRow = (row: HTMLElement | null): HTMLElement | null =>
  row ? focusableWithin(row) : null;

/** Resolves and focuses in one step, for removals that happen synchronously. */
export const focusRowBeside = (row: HTMLElement | null): boolean => {
  const target = resolveRowBeside(row);
  target?.focus();
  return target != null && document.activeElement === target;
};

/**
 * Focuses the first surviving row in `scope`, falling back to the New Chat
 * button. For removals that report back only once the row is already gone, so
 * there is no longer a position to search around.
 */
export const focusFirstRow = (scope: HTMLElement | null): boolean => {
  const row = scope?.querySelector<HTMLElement>(PINNED_ROW_SELECTOR) ?? null;
  const target = (row && focusableWithin(row)) ?? findNewChatControl();
  target?.focus();
  return target != null && document.activeElement === target;
};
