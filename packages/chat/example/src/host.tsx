import { useMessageContext } from '@librechat/chat/react';
import type { MessagePartsHost } from '@librechat/chat/react';

const noop = (): void => {};

/**
 * Everything the package's parts ask of the app, answered with defaults. A real app backs these
 * with its own settings, user and markdown renderer; the example draws markdown as plain text.
 */
export const host: MessagePartsHost = {
  useMessage: () => {
    const { messageId, isSubmitting, isLatestMessage, conversationId, partIndex } =
      useMessageContext();
    return { messageId, isSubmitting, isLatestMessage, conversationId, partIndex };
  },
  renderMarkdown: ({ content }) => <p>{content}</p>,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => false,
  useChatDirection: () => 'auto',
  useUserTextPreferences: () => ({
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
    usernameDisplay: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => noop,
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, noop],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, noop],
};
