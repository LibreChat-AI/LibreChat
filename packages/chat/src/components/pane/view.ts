import { Constants } from 'librechat-data-provider';

/** What a chat pane's message column shows. */
export type ChatPaneColumn = 'loading' | 'landing' | 'messages';

/** How a chat pane is laid out and what its column shows. */
export type ChatPaneView = {
  /** The welcome-screen layout: a new conversation with nothing in it. It holds while the
   *  session loads, so the composer, starters and footer stay put under the spinner. */
  isLanding: boolean;
  column: ChatPaneColumn;
};

/**
 * Picks the pane's layout and column: the welcome screen for a new conversation with nothing in
 * it, a spinner while a conversation loads or the route moves to one that has no messages yet,
 * and the message list otherwise.
 */
export function getChatPaneView({
  conversationId,
  hasMessages,
  isLoading,
}: {
  conversationId?: string | null;
  hasMessages: boolean;
  isLoading: boolean;
}): ChatPaneView {
  const isNew = !conversationId || conversationId === Constants.NEW_CONVO;
  const isLanding = !hasMessages && isNew;
  if (isLoading && conversationId !== Constants.NEW_CONVO) {
    return { isLanding, column: 'loading' };
  }
  if (isLanding) {
    return { isLanding, column: 'landing' };
  }
  if (isLoading || (!hasMessages && conversationId != null)) {
    return { isLanding, column: 'loading' };
  }
  return { isLanding, column: 'messages' };
}
