import { useCallback } from 'react';
import { QueryKeys, Constants, tConvoUpdateSchema } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  EventSubmission,
  ChatCreatedFrame,
} from 'librechat-data-provider';
import type { EventHandlerContext } from './context';
import { hasRealTitle, MESSAGE_UPDATE_INTERVAL, buildCreatedInitialResponse } from '../../../core';
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
export type TurnHandlers = {
  messageHandler: (data: string | undefined, submission: EventSubmission) => void;
  syncHandler: (data: TSyncData, submission: EventSubmission) => void;
  createdHandler: (data: ChatCreatedFrame, submission: EventSubmission) => void;
  titleHandler: (event: TTitleEvent) => void;
};

export default function useTurnHandlers(ctx: EventHandlerContext): TurnHandlers {
  const {
    queryClient,
    setMessages,
    setIsSubmitting,
    setShowStopButton,
    setConversation,
    isAddedRequest,
    runIndex,
    lastAnnouncementTimeRef,
    services,
  } = ctx;
  const { conversations, drafts, focus, navigation, templates, titles } = services;
  const { announce: announcePolite } = focus;

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
      drafts.adopt(submission.conversation, conversationId, runIndex);
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
          const titleState = conversations.getTitle({
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
          const sidebarUpdate = conversations.listEntry(update);
          if (requestMessage.parentMessageId === Constants.NO_PARENT) {
            conversations.upsert(sidebarUpdate);
          } else {
            conversations.update(update.conversationId!, () => sidebarUpdate, true);
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
      conversations,
      drafts,
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
        focus.showRegenerated(initialResponse.parentMessageId);
      } else {
        setMessages([...messages, userMessage, initialResponse]);
      }

      const { conversationId, parentMessageId } = userMessage;
      if (conversationId) {
        drafts.adopt(submission.conversation, conversationId, runIndex, {
          carryPreferences: true,
        });
      }
      lastAnnouncementTimeRef.current = Date.now();
      announcePolite({
        message: 'start',
        isStatus: true,
      });

      let update = {} as TConversation;
      if (setConversation && !isAddedRequest) {
        setConversation((prevState) => {
          const titleState = conversations.getTitle({
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
          const sidebarUpdate = conversations.listEntry(update);
          if (parentMessageId === Constants.NO_PARENT) {
            conversations.upsert(sidebarUpdate);
          } else {
            conversations.update(update.conversationId!, () => sidebarUpdate, true);
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
        templates.apply({
          targetId: conversationId,
          sourceId: submission.conversation?.conversationId,
          ephemeralAgent: submission.ephemeralAgent,
          specName: submission.conversation?.spec,
        });
      }

      focus.scrollToEnd();
    },
    [
      setMessages,
      queryClient,
      isAddedRequest,
      announcePolite,
      setConversation,
      lastAnnouncementTimeRef,
      runIndex,
      conversations,
      drafts,
      focus,
      templates,
    ],
  );

  const titleHandler = useCallback(
    (event: TTitleEvent) => {
      const { conversationId, title: generatedTitle } = event.data ?? {};
      if (!conversationId || !hasRealTitle(generatedTitle)) {
        return;
      }
      const titleState = conversations.getTitle({
        conversationId,
        currentTitle: generatedTitle,
      });
      const title = titleState.title ?? generatedTitle;

      queryClient.setQueryData<TConversation>([QueryKeys.conversation, conversationId], (convo) =>
        convo ? { ...convo, ...titleState, title } : convo,
      );
      conversations.update(conversationId, (convo) => ({
        ...convo,
        ...titleState,
        title,
      }));
      titles.markProcessed(conversationId);

      if (navigation.pathname.includes(conversationId)) {
        titles.setDocumentTitle(title);
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
    [queryClient, navigation.pathname, setConversation, isAddedRequest, conversations, titles],
  );

  return { messageHandler, syncHandler, createdHandler, titleHandler };
}
