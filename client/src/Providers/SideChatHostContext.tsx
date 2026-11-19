import { useCallback, useMemo } from 'react';
import { useStore } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { createGenerationTransport } from '@librechat/chat';
import {
  dataService,
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import {
  filesFamily,
  useFollowChat,
  SIDE_CHAT_PANE,
  useUsageHandler,
  toResumableUsage,
} from '@librechat/chat/react';
import type { Agent, TMessage, TConversation, ChatFinalFrame } from 'librechat-data-provider';
import type { FollowedChat, SideChatHost, FollowChatOptions } from '@librechat/chat/react';
import { isTemporaryConversation, proveFetchedReplyByIdentity } from '~/utils';
import { stagedForHandoff, handedComposerFilesFamily } from '~/store/handoff';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import useAttachmentHandler from '~/hooks/SSE/useAttachmentHandler';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import { createConversationCache } from '~/hooks/SSE/services';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import SideChatSurface from '~/components/Chat/Side/Surface';
import { retryTransientQuery } from '~/data-provider/retry';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useChatTransport } from './ChatTransportContext';
import { useChatSettings } from './ChatSettingsContext';
import { useLiveAnnouncer } from './AnnouncerContext';
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
  /**
   * The conversation's token usage, kept by main chat's own writers: the context reading the
   * server sends as a reply starts, the output arriving meanwhile, and the totals at its end.
   * It is what the composer's gauge reads, by conversation.
   */
  const usageHandlers = useUsageHandler();
  const usage = useMemo(() => toResumableUsage(usageHandlers), [usageHandlers]);
  /**
   * What lets a reply read here be acknowledged, as main chat's is: the reply a turn just ended
   * on is stamped on the conversation wherever it is listed, paired with the list that holds
   * it; and the history just read stands as proof of the reply the conversation already names.
   */
  const onSettled = useCallback(
    (final?: ChatFinalFrame) => {
      if (final == null) {
        /** No reply is on its way in what was just read, so no estimate of one is kept. */
        usageHandlers.resetLive({ conversation: { conversationId: id } });
        const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, id]);
        if (messages != null) {
          proveFetchedReplyByIdentity(queryClient, id, messages);
        }
        return;
      }
      const settled = final.conversation as Partial<TConversation> | undefined;
      if (settled?.lastResponseAt == null || isTemporaryConversation(settled)) {
        return;
      }
      createConversationCache(queryClient).commitReply(id, {
        lastResponseAt: settled.lastResponseAt,
        lastResponseMessageId: settled.lastResponseMessageId,
        updatedAt: settled.updatedAt,
      });
    },
    [queryClient, id, usageHandlers],
  );
  /** A turn here is said to a screen reader as main chat's is: started, still going, done. */
  const { announcePolite: announce } = useLiveAnnouncer();
  const beside = useMemo(
    () => ({ onAttachment, onSettled, announce, usage }),
    [onAttachment, onSettled, announce, usage],
  );
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

/**
 * Opens the side conversation as the page's main chat. What its composer has staged and
 * finished uploading goes with it: taken from the side pane before the navigation clears every
 * pane's files, and left for main chat's composer to pick up once it holds the conversation.
 */
function useOpenConversation(): (conversation: TConversation) => void {
  const { navigateToConvo } = useNavigateToConvo();
  const store = useStore();
  return useCallback(
    (conversation) => {
      const staged = stagedForHandoff(store.get(filesFamily(SIDE_CHAT_PANE)));
      const { conversationId } = conversation;
      if (staged.size > 0 && conversationId != null && conversationId !== '') {
        store.set(handedComposerFilesFamily(conversationId), staged);
      }
      navigateToConvo(conversation);
    },
    [navigateToConvo, store],
  );
}

/** What a side chat reads from the app. */
export const appSideChatHost: SideChatHost = {
  useChat,
  useOpenConversation,
  useSheetLayout: () => useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH),
  useClearsFooter: useConfiguredFooter,
  Surface: SideChatSurface,
};
