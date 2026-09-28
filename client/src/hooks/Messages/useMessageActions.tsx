import { useCallback, useMemo, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useUpdateFeedbackMutation } from 'librechat-data-provider/react-query';
import {
  TFeedback,
  getTagByKey,
  isAgentsEndpoint,
  SearchResultData,
  isConfiguredSender,
  toMinimalFeedback,
  isAssistantsEndpoint,
  TUpdateFeedbackRequest,
} from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common/types';
import type { TMessageProps } from '~/common';
import { useCopyMessageToClipboard, hasCopyableText } from './useCopyToClipboard';
import { useAssistantsMapContext, useAgentsMapContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';
import { useGetAddedConvo } from '~/hooks/Chat';
import { useLocalize } from '~/hooks';
import store from '~/store';

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

export default function useMessageActions(props: TMessageActions) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const UsernameDisplay = useRecoilValue<boolean>(store.UsernameDisplay);
  const { message, currentEditId, setCurrentEditId, searchResults, chatContext } = props;

  const {
    ask,
    index,
    regenerate,
    conversation,
    latestMessageId,
    latestMessageDepth,
    handleContinue,
    feedbackEnabled,
    // NOTE: isSubmitting is intentionally NOT destructured here.
    // chatContext.isSubmitting is a getter backed by a ref — destructuring
    // would capture a one-time snapshot. Always access via chatContext.isSubmitting.
  } = chatContext;

  const getAddedConvo = useGetAddedConvo();

  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();

  const { text, content, messageId = null, isCreatedByUser } = message ?? {};
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

  const assistant = useMemo(() => {
    if (!isAssistantsEndpoint(conversation?.endpoint)) {
      return undefined;
    }

    const endpointKey = conversation?.endpoint ?? '';
    const modelKey = message?.model ?? '';

    return assistantMap?.[endpointKey] ? assistantMap[endpointKey][modelKey] : undefined;
  }, [conversation?.endpoint, message?.model, assistantMap]);

  const agent = useMemo(() => {
    if (!isAgentsEndpoint(conversation?.endpoint)) {
      return undefined;
    }

    if (!agentsMap) {
      return undefined;
    }

    const modelKey = message?.model ?? '';
    if (modelKey) {
      return agentsMap[modelKey];
    }

    const agentId = conversation?.agent_id ?? '';
    if (agentId) {
      return agentsMap[agentId];
    }
  }, [agentsMap, conversation?.agent_id, conversation?.endpoint, message?.model]);

  /**
   * chatContext.isSubmitting is a getter backed by the wrapper's ref,
   * so it always returns the current value at call-time — even for
   * non-latest messages that don't re-render during streaming.
   */
  const regenerateMessage = useCallback(() => {
    if ((chatContext.isSubmitting && isCreatedByUser === true) || !message) {
      return;
    }

    regenerate(message, { addedConvo: getAddedConvo() });
  }, [chatContext, isCreatedByUser, message, regenerate, getAddedConvo]);

  const copyToClipboard = useCopyMessageToClipboard({
    text,
    content,
    searchResults,
    isCreatedByUser,
    error: message?.error,
  });

  const getCanCopy = useCallback(
    () => hasCopyableText({ text, content, searchResults }),
    [text, content, searchResults],
  );

  const messageLabel = useMemo(() => {
    if (message?.isCreatedByUser === true) {
      return UsernameDisplay ? (user?.name ?? '') || user?.username : localize('com_user_message');
    } else if (agent) {
      return agent.name ?? 'Assistant';
    } else if (assistant) {
      return assistant.name ?? 'Assistant';
    } else {
      return message?.sender;
    }
  }, [message, agent, assistant, UsernameDisplay, user, localize]);

  const feedbackMutation = useUpdateFeedbackMutation(
    conversation?.conversationId || '',
    message?.messageId || '',
  );

  const handleFeedback = useCallback(
    ({ feedback: newFeedback }: { feedback: TFeedback | undefined }) => {
      const payload: TUpdateFeedbackRequest = {
        feedback: newFeedback ? toMinimalFeedback(newFeedback) : undefined,
      };

      feedbackMutation.mutate(payload, {
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
    [feedbackMutation],
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
    /** Whether `messageLabel` is a configured sender, so the header can withhold the
     *  model it stands in for. */
    hasConfiguredSender: isConfiguredSender({
      sender: message?.sender,
      endpoint: message?.endpoint ?? conversation?.endpoint,
      endpointType: conversation?.endpointType,
      model: message?.model ?? conversation?.model,
      isCreatedByUser: message?.isCreatedByUser,
    }),
    /** Withholding the handler removes the controls: `HoverButtons` renders feedback
     *  only when it has somewhere to send it. */
    handleFeedback: feedbackEnabled ? handleFeedback : undefined,
    handleContinue,
    copyToClipboard,
    latestMessageId,
    regenerateMessage,
    latestMessageDepth,
  };
}
