import { useCallback, useMemo, useState } from 'react';
import { useLocalize } from '@librechat/client';
import {
  getTagByKey,
  isAgentsEndpoint,
  isConfiguredSender,
  toMinimalFeedback,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type {
  Agent,
  TFeedback,
  Assistant,
  TConversation,
  SearchResultData,
  TUpdateFeedbackRequest,
} from 'librechat-data-provider';
import type { TMessageChatContext, TMessageProps } from '../../react/messages/types';
import type { MessageCopy } from '../../react/messages/host';
import type { TAskFunction } from '../../core';
import { useMessagesHost } from '../../react/messages/host';
import { useMessagePartsHost } from '../../react/host';

export type TMessageActions = Pick<
  TMessageProps,
  'message' | 'currentEditId' | 'setCurrentEditId'
> & {
  searchResults?: { [key: string]: SearchResultData };
  /**
   * Stable context object passed from wrapper components to avoid subscribing
   * to ChatContext inside memo'd components (which would bypass React.memo).
   * The `isSubmitting` property uses a getter backed by a ref, so it always
   * returns the current value at call-time without triggering re-renders.
   */
  chatContext: TMessageChatContext;
};

export type MessageActions = {
  ask: TAskFunction;
  edit: boolean;
  index: number;
  agent: Agent | undefined;
  feedback: TFeedback | undefined;
  getCanCopy: () => boolean;
  assistant: Assistant | undefined;
  enterEdit: (cancel?: boolean) => void;
  conversation: TConversation | null;
  messageLabel: string | undefined;
  /** Whether `messageLabel` is a configured sender, so the header can withhold the
   *  model it stands in for. */
  hasConfiguredSender: boolean;
  /** Withholding the handler removes the controls: `HoverButtons` renders feedback
   *  only when it has somewhere to send it. */
  handleFeedback: ((input: { feedback: TFeedback | undefined }) => void) | undefined;
  handleContinue: TMessageChatContext['handleContinue'];
  copyToClipboard: MessageCopy['copyToClipboard'];
  regenerateMessage: () => void;
};

export default function useMessageActions(props: TMessageActions): MessageActions {
  const localize = useLocalize();
  const messagesHost = useMessagesHost();
  const partsHost = useMessagePartsHost();
  const user = partsHost.useUser();
  const { usernameDisplay } = partsHost.useUserTextPreferences();
  const { message, currentEditId, setCurrentEditId, searchResults, chatContext } = props;

  const {
    ask,
    index,
    regenerate,
    conversation,
    handleContinue,
    feedbackEnabled,
    // NOTE: isSubmitting, latestMessageId and latestMessageDepth are intentionally
    // NOT destructured here. They are getters backed by a ref, destructuring
    // would capture a one-time snapshot. Rows render them from their own props.
  } = chatContext;

  const getAddedConvo = messagesHost.useGetAddedConvo();

  const { messageId = null, isCreatedByUser } = message ?? {};
  const edit = useMemo(() => messageId === currentEditId, [messageId, currentEditId]);

  const [feedback, setFeedback] = useState<TFeedback | undefined>(() => {
    if (message?.feedback) {
      const tag = getTagByKey(message.feedback?.tag?.key);
      return {
        rating: message.feedback.rating,
        tag,
        text: message.feedback.text,
      };
    }
    return undefined;
  });

  const enterEdit = useCallback(
    (cancel?: boolean) => setCurrentEditId && setCurrentEditId(cancel === true ? -1 : messageId),
    [messageId, setCurrentEditId],
  );

  const assistantLookup = messagesHost.useAssistant(conversation?.endpoint, message?.model);
  const assistant = isAssistantsEndpoint(conversation?.endpoint) ? assistantLookup : undefined;

  const agentLookup = partsHost.useAgent(message?.model || conversation?.agent_id || '');
  const agent = isAgentsEndpoint(conversation?.endpoint) ? agentLookup : undefined;

  /**
   * chatContext.isSubmitting is a getter backed by the wrapper's ref,
   * so it always returns the current value at call-time, even for
   * non-latest messages that don't re-render during streaming.
   */
  const regenerateMessage = useCallback(() => {
    if ((chatContext.isSubmitting && isCreatedByUser === true) || !message) {
      return;
    }

    regenerate(message, { addedConvo: getAddedConvo() });
  }, [chatContext, isCreatedByUser, message, regenerate, getAddedConvo]);

  const { copyToClipboard, canCopy } = messagesHost.useMessageCopy({ message, searchResults });

  const getCanCopy = useCallback(() => canCopy, [canCopy]);

  const messageLabel = useMemo(() => {
    if (message?.isCreatedByUser === true) {
      return usernameDisplay ? (user?.name ?? '') || user?.username : localize('com_user_message');
    } else if (agent) {
      return agent.name ?? 'Assistant';
    } else if (assistant) {
      return assistant.name ?? 'Assistant';
    } else {
      return message?.sender;
    }
  }, [message, agent, assistant, usernameDisplay, user, localize]);

  const writeFeedback = messagesHost.useMessageFeedback(
    conversation?.conversationId || '',
    message?.messageId || '',
  );

  const handleFeedback = useCallback(
    ({ feedback: newFeedback }: { feedback: TFeedback | undefined }) => {
      const payload: TUpdateFeedbackRequest = {
        feedback: newFeedback ? toMinimalFeedback(newFeedback) : undefined,
      };

      writeFeedback(payload, {
        onSuccess: (data) => {
          if (!data.feedback) {
            setFeedback(undefined);
          } else {
            const tag = getTagByKey(data.feedback?.tag ?? undefined);
            setFeedback({
              rating: data.feedback.rating,
              tag,
              text: data.feedback.text,
            });
          }
        },
        onError: (error) => {
          console.error('Failed to update feedback:', error);
        },
      });
    },
    [writeFeedback],
  );

  return {
    ask,
    edit,
    index,
    agent,
    feedback,
    getCanCopy,
    assistant,
    enterEdit,
    conversation,
    messageLabel,
    hasConfiguredSender: isConfiguredSender({
      sender: message?.sender,
      endpoint: message?.endpoint ?? conversation?.endpoint,
      endpointType: conversation?.endpointType,
      model: message?.model ?? conversation?.model,
      isCreatedByUser: message?.isCreatedByUser,
    }),
    handleFeedback: feedbackEnabled ? handleFeedback : undefined,
    handleContinue,
    copyToClipboard,
    regenerateMessage,
  };
}
