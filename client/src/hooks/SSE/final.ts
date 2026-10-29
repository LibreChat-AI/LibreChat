import { useCallback } from 'react';
import { QueryKeys, Constants, isAssistantsEndpoint } from 'librechat-data-provider';
import {
  keepLocalCodeApprovalMode,
  mergeRegenerateFinalMessages,
  isInitialNewConversationSubmission,
  getExistingConversationAbortMessages,
} from '@librechat/chat';
import type {
  TMessage,
  TConversation,
  TStartupConfig,
  EventSubmission,
} from 'librechat-data-provider';
import type { EventHandlerContext } from './handlers';
import type { TFinalResData } from '~/common';
import {
  setDraft,
  getConversationDraftId,
  hasRealTitle,
  requestChatFocus,
  getAllContentText,
  updateConvoInAllQueries,
  applyServerReplyStamp,
  markLocallyCommittedReply,
  removeConvoFromAllQueries,
  preserveStreamedContentIdentity,
} from '~/utils';
import { startupConfigKey, queueTitleGeneration } from '~/data-provider';
import { withFileSearchPreference } from '~/hooks/Files/search';
import { getConvoTitle } from './turns';

/** Settles a finished turn: the final messages, the conversation it belongs to, and an early abort that restores the draft. */
export default function useFinalHandler(ctx: EventHandlerContext) {
  const {
    navigate,
    getMessages,
    setMessages,
    queryClient,
    setCompleted,
    runIndex,
    isAddedRequest,
    announcePolite,
    setConversation,
    setIsSubmitting,
    setShowStopButton,
    location,
    applyAgentTemplate,
    attachmentHandler,
    setSubmissionStart,
    restorePendingContext,
    reconcileFailedCodeDecision,
    preserveSubagentAtomsForNewConvoIdRef,
  } = ctx;

  const finalHandler = useCallback(
    (data: TFinalResData, submission: EventSubmission) => {
      const { requestMessage, responseMessage, conversation, runMessages } = data;
      const {
        messages,
        conversation: submissionConvo,
        isRegenerate = false,
        isTemporary: _isTemporary = false,
      } = submission;
      const serverConversation = conversation as TConversation;
      setSubmissionStart(null);

      try {
        // Handle early abort - aborted before any response message was saved.
        if ((data as Record<string, unknown>).earlyAbort) {
          console.log('[finalHandler] Early abort detected - no response message saved');
          setShowStopButton(false);
          setIsSubmitting(false);

          const currentConvoId = submissionConvo.conversationId;
          const isInitialNewConvo = isInitialNewConversationSubmission(submission);
          const isExistingConvo =
            currentConvoId && currentConvoId !== Constants.NEW_CONVO && !isInitialNewConvo;
          if (isExistingConvo) {
            reconcileFailedCodeDecision(submission, currentConvoId);
            const abortMessages = getExistingConversationAbortMessages({
              messages,
              isRegenerate,
              currentMessages: getMessages(),
              regenerateMessages: submission.regenerateMessages,
            });
            setMessages(abortMessages);
            queryClient.setQueryData<TMessage[]>(
              [QueryKeys.messages, currentConvoId],
              abortMessages,
            );
            setDraft({ id: currentConvoId, value: requestMessage?.text });
            restorePendingContext(
              currentConvoId,
              requestMessage?.quotes,
              requestMessage?.reasoningOverride,
            );
            return;
          }

          if (currentConvoId && currentConvoId !== Constants.NEW_CONVO) {
            removeConvoFromAllQueries(queryClient, currentConvoId);
            queryClient.removeQueries({ queryKey: [QueryKeys.conversation, currentConvoId] });
            queryClient.removeQueries({ queryKey: [QueryKeys.messages, currentConvoId] });
          }
          setMessages([]);
          queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
          setDraft({
            id: getConversationDraftId(runIndex, Constants.NEW_CONVO),
            value: requestMessage?.text,
          });
          restorePendingContext(
            String(Constants.NEW_CONVO),
            requestMessage?.quotes,
            requestMessage?.reasoningOverride,
          );
          if (location.pathname !== `/c/${Constants.NEW_CONVO}`) {
            navigate(`/c/${Constants.NEW_CONVO}`, { replace: true });
          }
          return;
        }

        if (responseMessage?.attachments && responseMessage.attachments.length > 0) {
          // Process each attachment through the attachmentHandler
          responseMessage.attachments.forEach((attachment) => {
            const attachmentData = {
              ...attachment,
              messageId: responseMessage.messageId,
            };

            attachmentHandler({
              data: attachmentData,
              submission: submission as EventSubmission,
            });
          });
        }

        setCompleted((prev) => new Set(prev.add(submission.initialResponse.messageId)));

        const currentMessages = getMessages();
        /* Early return if messages are empty; i.e., the user navigated away */
        if (!currentMessages || currentMessages.length === 0) {
          return;
        }

        /* a11y announcements */
        announcePolite({ message: 'end', isStatus: true });
        announcePolite({ message: getAllContentText(responseMessage) });

        const isNewConvo = conversation.conversationId !== submissionConvo.conversationId;

        // Skip temporary conversations; the server never generates titles for them.
        if (isNewConvo && conversation.conversationId && !_isTemporary) {
          queueTitleGeneration(conversation.conversationId);
        }

        const setFinalMessages = (id: string | null, _messages: TMessage[]) => {
          setMessages(_messages);
          queryClient.setQueryData<TMessage[]>([QueryKeys.messages, id], _messages);
        };

        const hasNoResponse =
          responseMessage?.content?.[0]?.['text']?.value ===
            submission.initialResponse?.content?.[0]?.['text']?.value ||
          !!responseMessage?.content?.[0]?.['tool_call']?.auth;

        /** Handle edge case where stream is cancelled before any response, which creates a blank page */
        if (!conversation.conversationId && hasNoResponse) {
          const currentConvoId =
            (submissionConvo.conversationId ?? conversation.conversationId) || Constants.NEW_CONVO;
          if (isNewConvo && submissionConvo.conversationId) {
            removeConvoFromAllQueries(queryClient, submissionConvo.conversationId);
          }

          const isNewChat =
            location.pathname === `/c/${Constants.NEW_CONVO}` &&
            currentConvoId === Constants.NEW_CONVO;

          setFinalMessages(currentConvoId, isNewChat ? [] : [...messages]);
          setDraft({
            id: getConversationDraftId(runIndex, currentConvoId),
            value: requestMessage?.text,
          });
          restorePendingContext(
            currentConvoId,
            requestMessage?.quotes,
            requestMessage?.reasoningOverride,
          );
          if (isNewChat) {
            requestChatFocus();
            navigate(`/c/${Constants.NEW_CONVO}`, { replace: true });
          }
          return;
        }

        /* Update messages; if assistants endpoint, client doesn't receive responseMessage */
        let finalMessages: TMessage[] = [];
        if (runMessages) {
          finalMessages = [...runMessages];
        } else if (isRegenerate && responseMessage) {
          finalMessages = mergeRegenerateFinalMessages({
            messages: submission.regenerateMessages ?? currentMessages ?? messages,
            responseMessage,
            initialResponseId: submission.initialResponse.messageId,
          });
        } else if (requestMessage != null && responseMessage != null) {
          finalMessages = [...messages, requestMessage, responseMessage];
        }

        /* Preserve files and streamed content identity from current messages:
         * files fill in when the server response lacks them, and the persisted
         * (compacted) content is stamped with the indexes it streamed at so
         * index-keyed renders don't remount the settled message. */
        if (finalMessages.length > 0) {
          const currentMsgMap = new Map(currentMessages.map((m) => [m.messageId, m]));
          for (let i = 0; i < finalMessages.length; i++) {
            const msg = finalMessages[i];
            const currentMsg = currentMsgMap.get(msg.messageId);
            if (!currentMsg) {
              continue;
            }
            const preservedFiles =
              msg.files == null && currentMsg.files?.length ? currentMsg.files : undefined;
            const content = preserveStreamedContentIdentity(currentMsg.content, msg.content);
            if (preservedFiles == null && content === msg.content) {
              continue;
            }
            finalMessages[i] = {
              ...msg,
              ...(preservedFiles != null ? { files: preservedFiles } : {}),
              ...(content !== msg.content ? { content } : {}),
            };
          }
        }

        if (finalMessages.length > 0) {
          setFinalMessages(conversation.conversationId, finalMessages);
        } else if (
          isAssistantsEndpoint(submissionConvo.endpoint) &&
          (!submissionConvo.conversationId ||
            submissionConvo.conversationId === Constants.NEW_CONVO)
        ) {
          queryClient.setQueryData<TMessage[]>(
            [QueryKeys.messages, conversation.conversationId],
            [...currentMessages],
          );
        }

        if (isNewConvo && submissionConvo.conversationId) {
          removeConvoFromAllQueries(queryClient, submissionConvo.conversationId);
        }

        /** Stream snapshots cannot overwrite a rename or generated title already in the cache. */
        if (setConversation && isAddedRequest !== true) {
          /* Pair the durable server stamp with the exact final messages cache object before
           * point/list cache events can ask useConversationSeen to acknowledge it. */
          const serverLastResponseAt = serverConversation.lastResponseAt;
          if (conversation.conversationId && !_isTemporary && serverLastResponseAt) {
            markLocallyCommittedReply(
              queryClient,
              conversation.conversationId,
              serverLastResponseAt,
            );
            applyServerReplyStamp(queryClient, conversation.conversationId, {
              lastResponseAt: serverLastResponseAt,
              lastResponseMessageId: serverConversation.lastResponseMessageId,
              updatedAt: serverConversation.updatedAt,
            });
          }
          setConversation((prevState) => {
            const update = keepLocalCodeApprovalMode(
              { ...prevState, ...(conversation as TConversation) },
              prevState,
              conversation.conversationId,
            );
            if (prevState?.model != null && prevState.model !== submissionConvo.model) {
              update.model = prevState.model;
            }
            const titleState = getConvoTitle({
              queryClient,
              conversationId: conversation.conversationId,
              titleSetByUser: conversation.titleSetByUser,
              titleRevision: conversation.titleRevision,
              authoritative: true,
              currentTitle:
                !conversation.titleSetByUser &&
                !hasRealTitle(conversation.title) &&
                prevState?.conversationId === conversation.conversationId &&
                hasRealTitle(prevState.title)
                  ? prevState.title
                  : conversation.title,
            });
            Object.assign(update, titleState);
            if (conversation.conversationId) {
              updateConvoInAllQueries(queryClient, conversation.conversationId, (convo) => ({
                ...convo,
                ...titleState,
              }));
              queryClient.setQueryData<TConversation>(
                [QueryKeys.conversation, conversation.conversationId],
                (cachedConvo) => {
                  const merged = keepLocalCodeApprovalMode(
                    { ...cachedConvo, ...serverConversation } as TConversation,
                    prevState?.conversationId === conversation.conversationId
                      ? prevState
                      : cachedConvo,
                    conversation.conversationId,
                  );
                  Object.assign(merged, titleState);
                  return merged;
                },
              );
            }
            return update;
          });

          if (conversation.conversationId && submission.ephemeralAgent) {
            applyAgentTemplate({
              targetId: conversation.conversationId,
              sourceId: submissionConvo.conversationId,
              ephemeralAgent: withFileSearchPreference(
                conversation.conversationId,
                submission.ephemeralAgent,
              ),
              specName: submission.conversation?.spec,
              startupConfig: queryClient.getQueryData<TStartupConfig>(startupConfigKey(true)),
            });
          }

          if (conversation.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, conversation.chatProjectId]);
          }

          if (location.pathname === `/c/${Constants.NEW_CONVO}`) {
            preserveSubagentAtomsForNewConvoIdRef.current = conversation.conversationId;
            navigate(`/c/${conversation.conversationId}`, { replace: true });
          }
        }
      } finally {
        setShowStopButton(false);
        setIsSubmitting(false);
      }
    },
    [
      navigate,
      getMessages,
      setMessages,
      queryClient,
      setCompleted,
      runIndex,
      isAddedRequest,
      announcePolite,
      setConversation,
      setIsSubmitting,
      setShowStopButton,
      location.pathname,
      applyAgentTemplate,
      attachmentHandler,
      setSubmissionStart,
      restorePendingContext,
      reconcileFailedCodeDecision,
      preserveSubagentAtomsForNewConvoIdRef,
    ],
  );

  return finalHandler;
}
