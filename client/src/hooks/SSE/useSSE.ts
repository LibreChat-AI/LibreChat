import { useEffect, useState } from 'react';
import { v4 } from 'uuid';
import { useStore } from 'jotai';
import { useSetRecoilState } from 'recoil';
import { StepEvents, createPayload, removeNullishValues } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TPayload,
  ChatEvent,
  TAttachment,
  TSubmission,
  ChatErrorData,
  ChatFinalFrame,
  EventSubmission,
} from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData, TFinalResData } from '~/common';
import { clearComposerDrafts, applyPendingAction, findPendingActionMessageIndex } from '~/utils';
import { startedAsNewConversation, buildCreatedInitialResponse } from './useEventHandlers';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import useUsageHandler from './useUsageHandler';
import store from '~/store';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

type EventHandlers = ReturnType<typeof useEventHandlers>;
type TSyncData = Parameters<EventHandlers['syncHandler']>[0];
/** The handlers predate the wire types and accept a narrower payload; these
 * frames reached them unchanged before the transport existed. */
type TStepEvent = Parameters<EventHandlers['stepHandler']>[0];

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const jotaiStore = useStore();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const transport = useChatTransport();
  const [completed, setCompleted] = useState(new Set());
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));

  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } =
    chatHelpers;

  const {
    clearStepMaps,
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    messageHandler,
    contentHandler,
    createdHandler,
    titleHandler,
    attachmentHandler,
    abortConversation,
    cancelPendingDeltaFlush,
    flushPendingDeltas,
  } = useEventHandlers({
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    runIndex,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const {
    bindResponse,
    contextHandler,
    usageHandler,
    tapStream,
    tapContent,
    finalizeUsage,
    resetLive,
    attributePending,
  } = useUsageHandler();

  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      return;
    }

    let currentSubmission = submission as EventSubmission;
    /** Provider identity updates cross one boundary. Message rendering, usage,
     * content, and terminal handlers all consume the same resolved response. */
    const adoptResponse = (userMessage: Partial<TMessage>, responseMessage: Partial<TMessage>) => {
      currentSubmission = {
        ...currentSubmission,
        userMessage: {
          ...currentSubmission.userMessage,
          ...userMessage,
          overrideParentMessageId: currentSubmission.userMessage.overrideParentMessageId,
        },
        initialResponse: { ...currentSubmission.initialResponse, ...responseMessage },
      };
      bindResponse(currentSubmission);
    };

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    payload = removeNullishValues(payload) as TPayload;

    clearStepMaps();
    bindResponse(currentSubmission);

    const handleFinal = (data: ChatFinalFrame) => {
      /** A queued delta flush reading the older streaming copy must never
       * land on top of the server-final write. */
      cancelPendingDeltaFlush();
      clearComposerDrafts(runIndex, submission.conversation?.conversationId, {
        includeNewChatDraft: startedAsNewConversation(submission),
      });
      try {
        finalHandler(data as TFinalResData, currentSubmission);
        finalizeUsage(data, currentSubmission);
      } catch (error) {
        console.error('Error in finalHandler:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
      console.log('final', data);
    };

    const handlePendingAction = (pendingAction: Agents.PendingAction) => {
      /** The pause card must attach to the same message state the stream
       * produced, so apply any queued delta before reading the cache. */
      flushPendingDeltas();
      const pendingConversationId =
        pendingAction.conversationId ?? submission.conversation?.conversationId;
      if (pendingConversationId) {
        jotaiStore.set(pendingApprovalActionFamily(pendingConversationId), pendingAction);
      }
      const messages = getMessages() ?? [];
      const index = findPendingActionMessageIndex(messages, pendingAction);
      if (index >= 0) {
        const updated = applyPendingAction(messages[index], pendingAction);
        if (updated !== messages[index]) {
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
        }
      }
    };

    const handleAbort = async () => {
      /** FLUSH (not cancel): the abort below synthesizes the partial response
       * from the cache, so the last queued tokens must land first. */
      flushPendingDeltas();
      const streamKey = (submission as TSubmission | null)?.['initialResponse']?.messageId;
      if (completed.has(streamKey)) {
        setIsSubmitting(false);
        setCompleted((prev) => {
          prev.delete(streamKey);
          return new Set(prev);
        });
        return;
      }

      setCompleted((prev) => new Set(prev.add(streamKey)));
      const latestMessages = getMessages();
      const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
      /** Attribute usage billed before the stop to the partial response (the
       *  branch tail), then reset pending, so it neither drops nor leaks into
       *  the next response. Falls back to a plain reset when no response exists. */
      const tail = latestMessages?.[latestMessages.length - 1];
      const partialResponseId =
        tail != null && tail.isCreatedByUser === false ? tail.messageId : null;
      attributePending(partialResponseId, currentSubmission);
      try {
        await abortConversation(
          conversationId ??
            currentSubmission.userMessage.conversationId ??
            submission.conversation?.conversationId ??
            '',
          currentSubmission,
          latestMessages,
        );
      } catch (error) {
        console.error('Error during abort:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }
    };

    const handleError = (data: ChatErrorData | null | undefined) => {
      console.log('error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
      resetLive(currentSubmission);
      if (data === undefined) {
        setIsSubmitting(false);
      }

      /** FLUSH (not cancel): the error card is built from the cache tail, so
       * the last queued tokens must land before it is synthesized. */
      flushPendingDeltas();
      errorHandler({
        data: data as TResData | undefined,
        submission: currentSubmission,
      });
    };

    const onEvent = (event: ChatEvent) => {
      switch (event.type) {
        case 'open':
          setAbortScroll(false);
          console.log('connection is opened');
          return;
        case 'final':
          handleFinal(event.data);
          return;
        case 'created': {
          const runId = v4();
          setActiveRunId(runId);
          const userMessage = { ...currentSubmission.userMessage, ...event.data.message };
          adoptResponse(
            userMessage,
            buildCreatedInitialResponse({
              ...currentSubmission,
              userMessage,
            }),
          );
          createdHandler(event.data, currentSubmission);
          return;
        }
        case 'title':
          titleHandler(event.data);
          return;
        case 'attachment':
          attachmentHandler({ data: event.data as TAttachment, submission: currentSubmission });
          return;
        case 'context_usage':
          contextHandler(event.data, currentSubmission);
          return;
        case 'token_usage':
          usageHandler(event.data, currentSubmission);
          return;
        case 'pending_action':
          handlePendingAction(event.data);
          return;
        case 'step':
          if (
            event.data.event === StepEvents.ON_MESSAGE_DELTA ||
            event.data.event === StepEvents.ON_REASONING_DELTA
          ) {
            tapStream(event.data.data, currentSubmission);
          }
          stepHandler(event.data as TStepEvent, currentSubmission);
          return;
        case 'sync': {
          const runId = v4();
          setActiveRunId(runId);
          /* synchronize messages to Assistants API as well as with real DB ID's */
          adoptResponse(event.data.requestMessage ?? {}, event.data.responseMessage ?? {});
          syncHandler(event.data as TSyncData, currentSubmission);
          return;
        }
        case 'content': {
          const text = 'text' in event.data ? event.data.text : undefined;
          tapContent(text, currentSubmission);
          contentHandler({ data: event.data, submission: currentSubmission });
          return;
        }
        case 'text': {
          const { data } = event;
          const text = data.text ?? data.response;

          adoptResponse({}, { parentMessageId: data.parentMessageId, messageId: data.messageId });

          /** Legacy non-agent streams (handleText) send cumulative text here,
           *  not via the content path; feed it to the live estimate too */
          tapContent(text, currentSubmission);
          messageHandler(text, currentSubmission);
          return;
        }
        case 'error':
          handleError(event.data);
          return;
        case 'abort':
          void handleAbort();
          return;
        default:
          /** Steering and label events belong to agent runs, which stream
           * through `useResumableSSE`; this path never receives them. */
          return;
      }
    };

    const controller = new AbortController();
    setIsSubmitting(true);
    transport
      .stream({ token })
      .send({ server: payloadData.server, payload }, { signal: controller.signal, onEvent });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}
