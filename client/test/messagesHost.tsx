import React from 'react';
import { MessagesHostProvider } from '@librechat/chat/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessagesHost } from '@librechat/chat/react';

/** A messages host for specs whose subject is not the rows: inert scrolling, no forking,
 *  copying or read-aloud, and rows that render nothing. */
export const testMessagesHost: MessagesHost = {
  useHour12: () => undefined,
  renderFiles: () => null,
  useForkPreferences: () => ({
    option: '',
    setOption: () => undefined,
    splitAtTarget: false,
    setSplitAtTarget: () => undefined,
    rememberOption: false,
    setRememberOption: () => undefined,
  }),
  useForkConversation: () => null,
  useMessageCopy: () => ({ copyToClipboard: () => undefined, canCopy: false }),
  useGetMessages: () => () => undefined,
  useHasPendingTurn: () => false,
  renderMessageAudio: () => null,
  useScreenshotTarget: () => undefined,
  useAutoScroll: () => false,
  useConversationMessages: () => undefined,
  useAssistant: () => undefined,
  useGetAddedConvo: () => () => null,
  useStreamedAttachments: () => undefined,
  useMessageFeedback: () => () => undefined,
  useSeenSource: () => ({
    readReply: () => undefined,
    hasReplyProof: () => false,
    markSeen: () => undefined,
    consumeFocusSuppression: () => false,
  }),
  renderMessageIcon: () => null,
  useMaximizeChatSpace: () => false,
  useHideSelectedAuthor: () => false,
  useAgentsMap: () => undefined,
  renderMessageBody: () => null,
  renderWakeup: () => null,
  renderPrivateText: () => null,
  renderActivity: () => null,
  useFileMap: () => undefined,
};

const queryClient = new QueryClient();

/** Mounts `testMessagesHost` for specs that render a chat pane's message list, with the query
 *  client its seen reporting reads. */
export function MessagesHostTestProvider({ children }: { children?: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MessagesHostProvider host={testMessagesHost}>{children}</MessagesHostProvider>
    </QueryClientProvider>
  );
}
