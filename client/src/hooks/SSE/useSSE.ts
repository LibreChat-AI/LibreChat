import { useEffect, useState } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useStore } from 'jotai';
import { useSetRecoilState } from 'recoil';
import {
  request,
  UsageEvents,
  StepEvents,
  createPayload,
  ApprovalEvents,
  removeNullishValues,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TPayload,
  TSubmission,
  EventSubmission,
} from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData } from '~/common';
import { clearComposerDrafts, applyPendingAction, findPendingActionMessageIndex } from '~/utils';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { startedAsNewConversation } from './useEventHandlers';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import useUsageHandler from './useUsageHandler';
import store from '~/store';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const jotaiStore = useStore();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
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

    let { userMessage } = submission;

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    payload = removeNullishValues(payload) as TPayload;

    let textIndex = null;
    clearStepMaps();

    const sse = new SSE(payloadData.server, {
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });

    sse.addEventListener('attachment', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        attachmentHandler({ data, submission: submission as EventSubmission });
      } catch (error) {
        console.error(error);
      }
    });

    sse.addEventListener('message', (e: MessageEvent) => {
      const data = JSON.parse(e.data);

      if (data.final != null) {
        /** A queued delta flush reading the older streaming copy must never
         * land on top of the server-final write. */
        cancelPendingDeltaFlush();
        clearComposerDrafts(runIndex, submission.conversation?.conversationId, {
          includeNewChatDraft: startedAsNewConversation(submission),
        });
        try {
          finalHandler(data, submission as EventSubmission);
          finalizeUsage(data, { ...submission, userMessage });
        } catch (error) {
          console.error('Error in finalHandler:', error);
          setIsSubmitting(false);
          setShowStopButton(false);
        }
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
        console.log('final', data);
        return;
      } else if (data.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage.overrideParentMessageId,
        };

        createdHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.event === 'title') {
        titleHandler(data);
      } else if (data.event === UsageEvents.ON_CONTEXT_USAGE) {
        contextHandler(data.data, { ...submission, userMessage });
      } else if (data.event === UsageEvents.ON_TOKEN_USAGE) {
        usageHandler(data.data, { ...submission, userMessage });
      } else if (data.event === ApprovalEvents.ON_PENDING_ACTION) {
        /** The pause card must attach to the same message state the stream
         * produced — apply any queued delta before reading the cache. */
        flushPendingDeltas();
        const pendingAction = data.data as Agents.PendingAction;
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
      } else if (data.event != null) {
        if (
          data.event === StepEvents.ON_MESSAGE_DELTA ||
          data.event === StepEvents.ON_REASONING_DELTA
        ) {
          tapStream(data.data, { ...submission, userMessage });
        }
        stepHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.sync != null) {
        const runId = v4();
        setActiveRunId(runId);
        /* synchronize messages to Assistants API as well as with real DB ID's */
        syncHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.type != null) {
        const { text, index } = data;
        if (text != null && index !== textIndex) {
          textIndex = index;
        }

        tapContent(text, { ...submission, userMessage });
        contentHandler({ data, submission: submission as EventSubmission });
      } else {
        const text = data.text ?? data.response;

        const initialResponse = {
          ...(submission.initialResponse as TMessage),
          parentMessageId: data.parentMessageId,
          messageId: data.messageId,
        };

        if (data.message != null) {
          /** Legacy non-agent streams (handleText) send cumulative text here,
           *  not via the content path — feed it to the live estimate too */
          tapContent(text, { ...submission, userMessage });
          messageHandler(text, { ...submission, userMessage, initialResponse });
        }
      }
    });

    sse.addEventListener('open', () => {
      setAbortScroll(false);
      console.log('connection is opened');
    });

    sse.addEventListener('cancel', async () => {
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
       *  branch tail), then reset pending — so it neither drops nor leaks into
       *  the next response. Falls back to a plain reset when no response exists. */
      const tail = latestMessages?.[latestMessages.length - 1];
      const partialResponseId =
        tail != null && tail.isCreatedByUser === false ? tail.messageId : null;
      attributePending(partialResponseId, { ...submission, userMessage });
      try {
        await abortConversation(
          conversationId ??
            userMessage.conversationId ??
            submission.conversation?.conversationId ??
            '',
          submission as EventSubmission,
          latestMessages,
        );
      } catch (error) {
        console.error('Error during abort:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        /* token expired, refresh and retry */
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) {
            throw new Error('Token refresh failed.');
          }
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };

          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          /* token refresh failed, continue handling the original 401 */
          console.log(error);
        }
      }

      console.log('error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
      resetLive({ ...submission, userMessage });

      let data: TResData | undefined = undefined;
      try {
        data = JSON.parse(e.data) as TResData;
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }

      /** FLUSH (not cancel): the error card is built from the cache tail, so
       * the last queued tokens must land before it is synthesized. */
      flushPendingDeltas();
      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
    });

    setIsSubmitting(true);
    sse.stream();

    return () => {
      const isCancelled = sse.readyState <= 1;
      sse.close();
      if (isCancelled) {
        const e = new Event('cancel');
        /* @ts-ignore */
        sse.dispatchEvent(e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}
