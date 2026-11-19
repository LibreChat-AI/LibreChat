import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
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
  useOwedSuccessor,
} from '@librechat/chat/react';
import type {
  FollowedChat,
  SideChatHost,
  FollowedRunEnd,
  SideChatOptions,
  FollowedGeneration,
} from '@librechat/chat/react';
import type { Agent, TMessage, TConversation, ChatFinalFrame } from 'librechat-data-provider';
import { isTemporaryConversation, proveFetchedReplyByIdentity } from '~/utils';
import { stagedForHandoff, handedComposerFilesFamily } from '~/store/handoff';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import useAttachmentHandler from '~/hooks/SSE/useAttachmentHandler';
import { addActiveJob, removeActiveJob } from '~/hooks/SSE/cache';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import { createConversationCache } from '~/hooks/SSE/services';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import SideChatSurface from '~/components/Chat/Side/Surface';
import { retryTransientQuery } from '~/data-provider/retry';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useChatTransport } from './ChatTransportContext';
import { useChatSettings } from './ChatSettingsContext';
import { useLiveAnnouncer } from './AnnouncerContext';
import useResumableSteers from '~/hooks/SSE/steers';
import { fetchStreamStatus } from '~/data-provider';
import useSteerState from '~/hooks/SSE/steer';

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
  options?: SideChatOptions,
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
  /**
   * The reader's steers, kept by main chat's own steer state: a steer the run takes resolves
   * its chip, the ones still waiting are seeded from what the server holds, and one the run
   * never took becomes a queued message when it ends.
   */
  const steers = useResumableSteers(useSteerState());
  const beside = useMemo(
    () => ({ onAttachment, onSettled, announce, usage, steers }),
    [onAttachment, onSettled, announce, usage, steers],
  );
  /**
   * The generation followed, kept where the app keeps main chat's: listed as running from the
   * moment its stream names it, so the list does not announce it as one nobody is following,
   * and taken off the list the moment it ends.
   */
  const [attached, setAttached] = useState<number | null>(null);
  const { onGeneration: tellGeneration, onRunEnd: tellRunEnd } = options ?? {};
  const onGeneration = useCallback(
    (named: FollowedGeneration | null) => {
      setAttached(named?.createdAt ?? null);
      if (named != null) {
        addActiveJob(queryClient, id);
      }
      tellGeneration?.(named);
    },
    [id, queryClient, tellGeneration],
  );
  const onRunEnd = useCallback(
    (end: FollowedRunEnd) => {
      removeActiveJob(queryClient, id);
      tellRunEnd?.(end);
    },
    [id, queryClient, tellRunEnd],
  );
  const followed = useFollowChat({
    id,
    transport: generation,
    loadMessages,
    endpoint,
    enabled: id !== '',
    beside,
    /** The reader drives this conversation: a run it loses is settled as main chat settles its own. */
    settlesLost: true,
    onWithdrawn: options?.onWithdrawn,
    onGeneration,
    onRunEnd,
    onStopped: options?.onStopped,
    onDetached: options?.onDetached,
    onIdle: options?.onIdle,
  });
  useAnnouncedRun(id, attached, followed);
  return followed;
}

/**
 * A run the server starts under the conversation without this chat asking for it is followed
 * like one it did ask for: the turn the server takes from the reader's queue when a reply ends,
 * or a run begun from another tab. Main chat learns of both the same way, from the receipts of
 * the queued turns and the list of running generations, and so does this.
 *
 * Looking costs a status read, and a read of the stored rows when nothing is found. So it looks
 * when a look can change what is shown: each time the list is fetched while it names the
 * conversation, and when the receipts change (a turn was taken, or dropped) while one is owed.
 * A turn that waits long before the server takes it is not looked for on every poll.
 */
function useAnnouncedRun(id: string, attached: number | null, followed: FollowedChat): void {
  const { attach } = followed;
  const busy =
    followed.isLoading ||
    followed.isFollowing ||
    followed.status === 'submitted' ||
    followed.status === 'streaming';
  const { successorOwed, hasActiveJobForThisConvo, activeJobsUpdatedAt, receiptSignature } =
    useOwedSuccessor({
      conversationId: id === '' ? undefined : id,
      resumableEnabled: id !== '',
      attachedGenerationCreatedAt: attached,
      hasLiveSubmissionForThisConvo: busy,
    });
  const announced = hasActiveJobForThisConvo || successorOwed;
  /** What was last acted on while a run stays announced: the receipts, and the list's fetch. */
  const seen = useRef<{ receipts: string | null; listed: number | null }>({
    receipts: null,
    listed: null,
  });
  useEffect(() => {
    /** Nothing is decided while a run is in hand: a look ends by leaving this state. */
    if (busy) {
      return;
    }
    if (!announced) {
      seen.current = { receipts: null, listed: null };
      return;
    }
    const moved = seen.current.receipts !== receiptSignature;
    const relisted = hasActiveJobForThisConvo && seen.current.listed !== activeJobsUpdatedAt;
    seen.current = {
      receipts: receiptSignature,
      listed: hasActiveJobForThisConvo ? activeJobsUpdatedAt : seen.current.listed,
    };
    if (moved || relisted) {
      attach();
    }
  }, [announced, busy, hasActiveJobForThisConvo, activeJobsUpdatedAt, receiptSignature, attach]);
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
