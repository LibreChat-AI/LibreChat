import { useCallback, useMemo } from 'react';
import { dataService } from 'librechat-data-provider';
import { useFollowChat } from '@librechat/chat/react';
import { createGenerationTransport } from '@librechat/chat';
import type { FollowedChat, SideChatHost, FollowChatOptions } from '@librechat/chat/react';
import type { TConversation } from 'librechat-data-provider';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useChatTransport } from './ChatTransportContext';
import { useChatSettings } from './ChatSettingsContext';
import { fetchStreamStatus } from '~/data-provider';

/**
 * A conversation of the reader's own as a chat they drive: its messages through the ordinary
 * route, and its generations started, streamed and stopped over the transport main chat uses.
 */
function useChat(
  { conversationId, endpoint }: Pick<TConversation, 'conversationId' | 'endpoint'>,
  options?: Pick<FollowChatOptions, 'onWithdrawn'>,
): FollowedChat {
  const id = conversationId ?? '';
  const { token } = useChatSettings().auth;
  const transport = useChatTransport();
  const generation = useMemo(
    () =>
      createGenerationTransport({
        wire: () => transport.stream({ token }),
        getStatus: fetchStreamStatus,
        start: (request, options) => transport.start(request, options),
        abort: ({ chatId, streamId, generationCreatedAt }) =>
          transport.abort({ conversationId: chatId, streamId, generationCreatedAt }),
      }),
    [transport, token],
  );
  const loadMessages = useCallback(() => dataService.getMessagesByConvoId(id), [id]);
  return useFollowChat({
    id,
    transport: generation,
    loadMessages,
    endpoint,
    enabled: id !== '',
    onWithdrawn: options?.onWithdrawn,
  });
}

function useOpenConversation(): (conversation: TConversation) => void {
  const { navigateToConvo } = useNavigateToConvo();
  return useCallback((conversation) => navigateToConvo(conversation), [navigateToConvo]);
}

/** What a side chat reads from the app. */
export const appSideChatHost: SideChatHost = {
  useChat,
  useOpenConversation,
  useSheetLayout: () => useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH),
  useClearsFooter: useConfiguredFooter,
};
