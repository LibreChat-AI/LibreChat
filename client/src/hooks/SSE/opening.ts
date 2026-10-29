import { useCallback } from 'react';
import { buildCreatedInitialResponse } from '@librechat/chat';
import { QueryKeys, Constants, tConvoUpdateSchema } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  TStartupConfig,
  EventSubmission,
  ChatCreatedFrame,
} from 'librechat-data-provider';
import type { EventHandlerContext } from './handlers';
import {
  scrollToEnd,
  adoptComposerConversation,
  hasRealTitle,
  withoutListFlags,
  setDocumentTitle,
  upsertConvoInAllQueries,
  updateConvoInAllQueries,
} from '~/utils';
import { transferFileSearchPreference, withFileSearchPreference } from '~/hooks/Files/search';
import { startupConfigKey, markTitleGenerationProcessed } from '~/data-provider';
import { MESSAGE_UPDATE_INTERVAL } from '~/common';
import { getConvoTitle } from './turns';
export type TSyncData = {
  sync: boolean;
  thread_id: string;
  messages?: TMessage[];
  requestMessage: TMessage;
  responseMessage: TMessage;
  conversationId: string;
};

export type TTitleEvent = {
  event: 'title';
  data?: {
    conversationId?: string;
    title?: string;
  };
};

/** Apply the resolved request choice only after acknowledgement. A saved decision may have
 *  moved since this event was emitted, so replay must never replace it. */
export function acknowledgedCodeEnvironment(
  current: TConversation | null,
  submission: EventSubmission,
): Pick<TConversation, 'codeEnvironmentMode' | 'codeWorkspaces'> {
  const { codeEnvironmentMode, codeWorkspaces } = submission;
  if (codeEnvironmentMode == null && !codeWorkspaces?.length) return {};
  const saved =
    current?.conversationId != null &&
    current.conversationId !== Constants.NEW_CONVO &&
    current.conversationId !== Constants.PENDING_CONVO;
  if (saved && (current.codeEnvironmentMode != null || current.codeWorkspaces?.length)) return {};
  return {
    codeEnvironmentMode,
    codeWorkspaces: codeEnvironmentMode === 'without_attached' ? undefined : codeWorkspaces,
  };
}

/** The handlers that open a turn and keep its conversation current: legacy text, sync, created and title events. */
export default function useTurnHandlers(ctx: EventHandlerContext) {
  const {
    queryClient,
    setMessages,
    setIsSubmitting,
    setShowStopButton,
    setConversation,
    isAddedRequest,
    runIndex,
    announcePolite,
    lastAnnouncementTimeRef,
    applyAgentTemplate,
    focusRegeneratedResponse,
    location,
  } = ctx;

  const messageHandler = useCallback(
    (data: string | undefined, submission: EventSubmission) => {
      const { messages, userMessage, initialResponse, isRegenerate = false } = submission;
      const text = data ?? '';
      setIsSubmitting(true);

      const currentTime = Date.now();
      if (currentTime - lastAnnouncementTimeRef.current > MESSAGE_UPDATE_INTERVAL) {
        announcePolite({ message: 'composing', isStatus: true });
        lastAnnouncementTimeRef.current = currentTime;
      }

      if (isRegenerate) {
        setMessages([
          ...messages,
          {
            ...initialResponse,
            text,
          },
        ]);
      } else {
        setMessages([
          ...messages,
          userMessage,
          {
            ...initialResponse,
            text,
          },
        ]);
      }
    },
    [setMessages, announcePolite, setIsSubmitting, lastAnnouncementTimeRef],
  );

  const syncHandler = useCallback(
    (data: TSyncData, submission: EventSubmission) => {
      const { conversationId, thread_id, responseMessage, requestMessage } = data;
      const { initialResponse, messages: _messages, userMessage, isTemporary = false } = submission;
      adoptComposerConversation(submission.conversation, conversationId, runIndex);
      /** Swap the optimistic user row for the server-stamped one IN PLACE.
       *  Filtering it out and re-appending at the tail would order any of its
       *  already-present children (abandoned responses from preempted
       *  attempts) before their parent, and the message tree hoists such rows
       *  into phantom root branches, a folded thread. */
      const userIndex = _messages.findIndex((msg) => msg.messageId === userMessage.messageId);
      const messages =
        userIndex >= 0
          ? _messages.map((msg, i) => (i === userIndex ? requestMessage : msg))
          : [..._messages, requestMessage];

      const nextResponseMessage = {
        ...initialResponse,
        ...responseMessage,
      };

      setMessages([...messages, nextResponseMessage]);

      announcePolite({
        message: 'start',
        isStatus: true,
      });

      let update = {} as TConversation;
      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          const titleState = getConvoTitle({
            queryClient,
            conversationId,
            currentTitle: prevState?.title,
            titleSetByUser: prevState?.titleSetByUser,
            titleRevision: prevState?.titleRevision,
          });
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            thread_id,
            ...titleState,
            messages: [requestMessage.messageId, responseMessage.messageId],
          }) as TConversation;
          return update;
        });

        if (!isTemporary) {
          const sidebarUpdate = withoutListFlags(update);
          if (requestMessage.parentMessageId === Constants.NO_PARENT) {
            upsertConvoInAllQueries(queryClient, sidebarUpdate);
          } else {
            updateConvoInAllQueries(queryClient, update.conversationId!, () => sidebarUpdate, true);
          }
          if (update.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, update.chatProjectId]);
          }
        }
      } else if (setConversation) {
        setConversation((prevState) => {
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            thread_id,
            messages: [requestMessage.messageId, responseMessage.messageId],
          }) as TConversation;
          return update;
        });
      }

      setShowStopButton(true);
    },
    [
      queryClient,
      setMessages,
      isAddedRequest,
      announcePolite,
      setConversation,
      setShowStopButton,
      runIndex,
    ],
  );

  const createdHandler = useCallback(
    (data: ChatCreatedFrame, submission: EventSubmission) => {
      const { messages, userMessage, isRegenerate = false, isTemporary = false } = submission;
      /**
       * The spread carries `manualSkills` through from
       * `submission.initialResponse`: `useChatFunctions` seeds the field
       * there at construction so the assistant placeholder already has it
       * by the time this handler fires. Subsequent `useStepHandler`
       * spreads and `updateContent` spreads preserve it, and
       * `finalHandler`'s server-backed `responseMessage` replacement
       * drops it, which is the right behavior: by finalize the real
       * `skill` tool_call is in `content` and takes over rendering.
       */
      const initialResponse = buildCreatedInitialResponse({
        initialResponse: submission.initialResponse,
        userMessage,
        isRegenerate,
      });
      if (isRegenerate) {
        setMessages([...messages, initialResponse]);
        focusRegeneratedResponse(initialResponse.parentMessageId);
      } else {
        setMessages([...messages, userMessage, initialResponse]);
      }

      const { conversationId, parentMessageId } = userMessage;
      if (conversationId) {
        adoptComposerConversation(
          submission.conversation,
          conversationId,
          runIndex,
          transferFileSearchPreference,
        );
      }
      lastAnnouncementTimeRef.current = Date.now();
      announcePolite({
        message: 'start',
        isStatus: true,
      });

      let update = {} as TConversation;
      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          const titleState = getConvoTitle({
            queryClient,
            conversationId,
            currentTitle: prevState?.title,
            titleSetByUser: prevState?.titleSetByUser,
            titleRevision: prevState?.titleRevision,
          });
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
            ...titleState,
          }) as TConversation;
          return update;
        });

        if (!isTemporary) {
          const sidebarUpdate = withoutListFlags(update);
          if (parentMessageId === Constants.NO_PARENT) {
            upsertConvoInAllQueries(queryClient, sidebarUpdate);
          } else {
            updateConvoInAllQueries(queryClient, update.conversationId!, () => sidebarUpdate, true);
          }
          if (update.chatProjectId) {
            queryClient.invalidateQueries([QueryKeys.projects]);
            queryClient.invalidateQueries([QueryKeys.project, update.chatProjectId]);
          }
        }
      } else if (setConversation) {
        setConversation((prevState) => {
          update = tConvoUpdateSchema.parse({
            ...prevState,
            ...acknowledgedCodeEnvironment(prevState, submission),
            conversationId,
          }) as TConversation;
          return update;
        });
      }

      if (conversationId) {
        applyAgentTemplate({
          targetId: conversationId,
          sourceId: submission.conversation?.conversationId,
          ephemeralAgent: withFileSearchPreference(conversationId, submission.ephemeralAgent),
          specName: submission.conversation?.spec,
          startupConfig: queryClient.getQueryData<TStartupConfig>(startupConfigKey(true)),
        });
      }

      scrollToEnd();
    },
    [
      setMessages,
      queryClient,
      isAddedRequest,
      announcePolite,
      setConversation,
      applyAgentTemplate,
      focusRegeneratedResponse,
      lastAnnouncementTimeRef,
      runIndex,
    ],
  );

  const titleHandler = useCallback(
    (event: TTitleEvent) => {
      const { conversationId, title: generatedTitle } = event.data ?? {};
      if (!conversationId || !hasRealTitle(generatedTitle)) {
        return;
      }
      const titleState = getConvoTitle({
        queryClient,
        conversationId,
        currentTitle: generatedTitle,
      });
      const title = titleState.title ?? generatedTitle;

      queryClient.setQueryData<TConversation>([QueryKeys.conversation, conversationId], (convo) =>
        convo ? { ...convo, ...titleState, title } : convo,
      );
      updateConvoInAllQueries(queryClient, conversationId, (convo) => ({
        ...convo,
        ...titleState,
        title,
      }));
      markTitleGenerationProcessed(conversationId);

      if (location.pathname.includes(conversationId)) {
        setDocumentTitle(title);
      }

      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          if (!prevState) {
            return prevState;
          }
          if (prevState.conversationId && prevState.conversationId !== conversationId) {
            return prevState;
          }
          return {
            ...prevState,
            conversationId,
            ...titleState,
            title,
          };
        });
      }
    },
    [queryClient, location.pathname, setConversation, isAddedRequest],
  );

  return { messageHandler, syncHandler, createdHandler, titleHandler };
}
