import { useCallback } from 'react';
import { v4 } from 'uuid';
import { mergeErrorMessages, keepLocalCodeApprovalMode } from '@librechat/chat';
import { QueryKeys, Constants, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation, EventSubmission } from 'librechat-data-provider';
import type { TResData, TFinalResData } from '~/common';
import type { EventHandlerContext } from './handlers';
import {
  logger,
  applyServerReplyStamp,
  markLocallyCommittedReply,
  removeConvoFromAllQueries,
} from '~/utils';
import { createErrorMessage, resolveErrorTurn, resolveSettledErrorReadState } from './turns';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';

/** Writes a failed or stopped turn: the error card, a cancelled run, and an abort that settles from what streamed. */
export default function useAbortHandlers(
  ctx: EventHandlerContext,
  finalHandler: (data: TFinalResData, submission: EventSubmission) => void,
) {
  const { token } = useChatSettings().auth;
  const transport = useChatTransport();
  const {
    setCompleted,
    setMessages,
    paramId,
    setIsSubmitting,
    setShowStopButton,
    setSubmissionStart,
    getMessages,
    queryClient,
    recoverConversation,
    reconcileFailedCodeDecision,
    setConversation,
    isAddedRequest,
  } = ctx;

  const cancelHandler = useCallback(
    (data: TResData, submission: EventSubmission) => {
      const { requestMessage, responseMessage, conversation } = data;
      const { messages, isRegenerate = false } = submission;
      const convoUpdate =
        (conversation as TConversation | null) ?? (submission.conversation as TConversation);

      // update the messages
      if (isRegenerate) {
        const messagesUpdate = (
          [...messages, responseMessage] as Array<TMessage | undefined>
        ).filter((msg) => msg);
        setMessages(messagesUpdate as TMessage[]);
      } else {
        const messagesUpdate = (
          [...messages, requestMessage, responseMessage] as Array<TMessage | undefined>
        ).filter((msg) => msg);
        setMessages(messagesUpdate as TMessage[]);
      }

      const isNewConvo = conversation.conversationId !== submission.conversation.conversationId;
      if (isNewConvo) {
        removeConvoFromAllQueries(queryClient, submission.conversation.conversationId as string);
      }

      if (setConversation && !isAddedRequest) {
        setConversation((prevState) =>
          keepLocalCodeApprovalMode(
            { ...prevState, ...convoUpdate },
            prevState,
            convoUpdate.conversationId,
          ),
        );
      }

      setIsSubmitting(false);
    },
    [setMessages, setConversation, isAddedRequest, queryClient, setIsSubmitting],
  );

  const errorHandler = useCallback(
    ({ data, submission }: { data?: TResData; submission: EventSubmission }) => {
      setCompleted((prev) => new Set(prev.add(submission.initialResponse.messageId)));
      setSubmissionStart(null);

      const { conversationId, errorResponse, recover } = resolveErrorTurn({
        data,
        submission,
        getMessages,
        isNewConversationRoute: paramId === Constants.NEW_CONVO,
      });
      const finalMessages = mergeErrorMessages({ ...submission, errorMessage: errorResponse });
      setMessages(finalMessages);
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, conversationId], finalMessages);
      const settled = resolveSettledErrorReadState({ data, submission, conversationId });
      if (settled) {
        markLocallyCommittedReply(queryClient, conversationId, settled.lastResponseAt);
        applyServerReplyStamp(queryClient, conversationId, settled);
      }
      if (recover) {
        recoverConversation(conversationId, submission);
      }
      reconcileFailedCodeDecision(submission, conversationId);
      setIsSubmitting(false);
    },
    [
      setCompleted,
      setMessages,
      paramId,
      setIsSubmitting,
      setSubmissionStart,
      getMessages,
      queryClient,
      recoverConversation,
      reconcileFailedCodeDecision,
    ],
  );

  const abortConversation = useCallback(
    async (conversationId = '', submission: EventSubmission, messages?: TMessage[]) => {
      const runAbortKey = `${conversationId}:${messages?.[messages.length - 1]?.messageId ?? ''}`;
      const { endpoint: _endpoint, endpointType } =
        (submission.conversation as TConversation | null) ?? {};
      const endpoint = endpointType ?? _endpoint;
      if (
        !isAssistantsEndpoint(endpoint) &&
        messages?.[messages.length - 1] != null &&
        messages[messages.length - 2] != null
      ) {
        let requestMessage = messages[messages.length - 2];
        const _responseMessage = messages[messages.length - 1];
        if (requestMessage.messageId !== _responseMessage.parentMessageId) {
          // the request message is the parent of response, which we search for backwards
          for (let i = messages.length - 3; i >= 0; i--) {
            if (messages[i].messageId === _responseMessage.parentMessageId) {
              requestMessage = messages[i];
              break;
            }
          }
        }
        /** Sanitize content array to remove undefined parts from interrupted streaming */
        const responseMessage = {
          ..._responseMessage,
          content: _responseMessage.content?.filter((part) => part != null),
        };
        try {
          finalHandler(
            {
              conversation: {
                conversationId,
              },
              requestMessage,
              responseMessage,
            },
            submission,
          );
        } catch (error) {
          console.error('Error in finalHandler during abort:', error);
          setShowStopButton(false);
          setIsSubmitting(false);
          setSubmissionStart(null);
        }
        return;
      } else if (!isAssistantsEndpoint(endpoint)) {
        const convoId = conversationId || `_${v4()}`;
        logger.log('conversation', 'Aborted conversation with minimal messages, ID: ' + convoId);
        recoverConversation(convoId, submission);
        setIsSubmitting(false);
        return;
      }

      try {
        const response = await transport.abortRun(
          { endpoint: endpoint ?? '', abortKey: runAbortKey },
          { token },
        );

        // Check if the response is JSON
        const contentType = response.headers.get('content-type');
        if (contentType != null && contentType.includes('application/json')) {
          const data = await response.json();
          if (response.status === 404) {
            setIsSubmitting(false);
            return;
          }
          if (data.final === true) {
            finalHandler(data, submission);
          } else {
            cancelHandler(data, submission);
          }
        } else if (response.status === 204 || response.status === 200) {
          setIsSubmitting(false);
        } else {
          throw new Error(
            'Unexpected response from server; Status: ' +
              response.status +
              ' ' +
              response.statusText,
          );
        }
      } catch (error) {
        const errorResponse = createErrorMessage({
          getMessages,
          submission,
          error,
        });
        /** A compaction has no user row: its `userMessage` slot names the leaf
         *  the turn hangs off, which `messages` already holds. Writing it here
         *  would duplicate that id as an empty, self-parented user message,
         *  a phantom root the thread then folds into. */
        setMessages(
          submission.compact === true
            ? [...submission.messages, errorResponse]
            : [...submission.messages, submission.userMessage, errorResponse],
        );
        recoverConversation(conversationId || errorResponse.conversationId || v4(), submission);
        setIsSubmitting(false);
      }
    },
    [
      token,
      transport,
      getMessages,
      setMessages,
      finalHandler,
      cancelHandler,
      setIsSubmitting,
      setShowStopButton,
      setSubmissionStart,
      recoverConversation,
    ],
  );

  return { cancelHandler, errorHandler, abortConversation };
}
