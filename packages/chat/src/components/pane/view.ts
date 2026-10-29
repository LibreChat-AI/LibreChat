import { Constants } from 'librechat-data-provider';

/** What a chat pane's message column shows. */
export type ChatPaneView = 'loading' | 'landing' | 'messages';

/**
 * Picks the pane's column: the welcome screen for a new conversation with nothing in it, a
 * spinner while a conversation loads or the route moves to one that has no messages yet, and
 * the message list otherwise.
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
    return 'loading';
  }
  if (isLanding) {
    return 'landing';
  }
  if (isLoading || (!hasMessages && conversationId != null)) {
    return 'loading';
  }
  return 'messages';
}
