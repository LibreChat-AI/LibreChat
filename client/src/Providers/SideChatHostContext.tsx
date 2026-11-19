import { useCallback, useMemo } from 'react';
import { useFollowChat } from '@librechat/chat/react';
import { useQueryClient } from '@tanstack/react-query';
import { createGenerationTransport } from '@librechat/chat';
import {
  dataService,
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import type { FollowedChat, SideChatHost, FollowChatOptions } from '@librechat/chat/react';
import type { Agent, TConversation } from 'librechat-data-provider';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import useAttachmentHandler from '~/hooks/SSE/useAttachmentHandler';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import { retryTransientQuery } from '~/data-provider/retry';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useChatTransport } from './ChatTransportContext';
import { useChatSettings } from './ChatSettingsContext';
import { fetchStreamStatus } from '~/data-provider';

/**
 * A conversation of the reader's own as a chat they drive: its messages through the ordinary
 * route, and its generations started, streamed and stopped over the transport main chat uses.
 */
function useChat(
  {
    conversationId,
    endpoint,
    agent_id,
  }: Pick<TConversation, 'conversationId' | 'endpoint' | 'agent_id'>,
  options?: Pick<FollowChatOptions, 'onWithdrawn'>,
): FollowedChat {
  const id = conversationId ?? '';
  const { token } = useChatSettings().auth;
  const queryClient = useQueryClient();
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
  const loadMessages = useCallback(async () => {
    const key = [QueryKeys.agent, agent_id];
    const cached = queryClient.getQueryState<Agent>(key);
    const needsTarget =
      isAgentsEndpoint(endpoint) &&
      agent_id != null &&
      !isEphemeralAgentId(agent_id) &&
      !(cached?.status === 'success' && cached.data?.id === agent_id);
    /** Warm the same authoritative query the submission guard reads, alongside history. */
    const target = needsTarget
      ? queryClient.fetchQuery({
          queryKey: key,
          queryFn: () => dataService.getAgentById({ agent_id }),
          retry: retryTransientQuery,
        })
      : Promise.resolve();
    const [messages] = await Promise.all([
      dataService.getMessagesByConvoId(id),
      /** A denied target must not hide readable history; the send guard retains the draft. */
      target.catch(() => undefined),
    ]);
    return messages;
  }, [agent_id, endpoint, id, queryClient]);
  /**
   * What a tool hands back while it runs (search sources, a generated file) arrives beside the
   * message it belongs to. It goes where main chat's goes: onto the rows that show it, and into
   * the app's file, memory and preview caches.
   */
  const onAttachment = useAttachmentHandler(queryClient);
  const beside = useMemo(() => ({ onAttachment }), [onAttachment]);
  return useFollowChat({
    id,
    transport: generation,
    loadMessages,
    endpoint,
    enabled: id !== '',
    beside,
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
