/** Resolves the chat pane an element belongs to: its own `[data-chat-pane]`
 *  ancestor, or the pane named by a `[data-chat-pane-portal]` ancestor for
 *  surfaces rendered outside the pane's subtree (palettes, popovers, header). */
export function getChatPane(element: Element | null): HTMLElement | null {
  const directPane = element?.closest<HTMLElement>('[data-chat-pane]');
  if (directPane != null) {
    return directPane;
  }
  const paneIndex =
    element?.closest<HTMLElement>('[data-chat-pane-portal]')?.dataset.chatPanePortal;
  if (paneIndex != null && /^\d+$/.test(paneIndex)) {
    return document.querySelector<HTMLElement>(`[data-chat-pane="${paneIndex}"]`);
  }
  return null;
}

/** The pane holding keyboard focus, or `null` when focus sits outside every pane. */
export function getFocusedChatPane(): HTMLElement | null {
  return getChatPane(document.activeElement);
}

/** Whether a pane-scoped keyboard action should act for this pane: the pane
 *  holding focus, or the first pane when focus sits outside every pane. */
export function isFocusedChatPane(index: number): boolean {
  const focused = getFocusedChatPane()?.dataset.chatPane;
  return focused == null ? index === 0 : focused === String(index);
}
