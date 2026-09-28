import { useCallback, useMemo } from 'react';
import throttle from 'lodash/throttle';
import {
  isAssistantsEndpoint,
  isAgentsEndpoint,
  isConfiguredSender,
} from 'librechat-data-provider';
import type { SearchResultData } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import { useMessagesViewContext, useAssistantsMapContext, useAgentsMapContext } from '~/Providers';
import { useCopyMessageToClipboard, hasCopyableText } from './useCopyToClipboard';
import { useGetAddedConvo } from '~/hooks/Chat';
import { logger } from '~/utils';

export default function useMessageHelpers(
  props: TMessageProps,
  searchResults?: { [key: string]: SearchResultData },
) {
  const { message, currentEditId, setCurrentEditId } = props;

  const {
    ask,
    index,
    regenerate,
    isSubmitting,
    conversation,
    setAbortScroll,
    handleContinue,
    latestMessageId,
  } = useMessagesViewContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();

  const getAddedConvo = useGetAddedConvo();

  const { text, content, children, messageId = null, isCreatedByUser } = message ?? {};
  const edit = messageId === currentEditId;
  const isLast = children?.length === 0 || children?.length === undefined;

  const enterEdit = useCallback(
    (cancel?: boolean) => setCurrentEditId && setCurrentEditId(cancel === true ? -1 : messageId),
    [messageId, setCurrentEditId],
  );

  const handleScroll = useCallback(
    (event: unknown) => {
      throttle(() => {
        logger.log(
          'message_scrolling',
          `useMessageHelpers: setting abort scroll to ${isSubmitting}, handleScroll event`,
          event,
        );
        if (isSubmitting) {
          setAbortScroll(true);
        } else {
          setAbortScroll(false);
        }
      }, 500)();
    },
    [isSubmitting, setAbortScroll],
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

    const modelKey = message?.model ?? '';

    return agentsMap ? agentsMap[modelKey] : undefined;
  }, [agentsMap, conversation?.endpoint, message?.model]);

  const regenerateMessage = () => {
    if ((isSubmitting && isCreatedByUser === true) || !message) {
      return;
    }

    regenerate(message, { addedConvo: getAddedConvo() });
  };

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

  return {
    ask,
    edit,
    agent,
    index,
    isLast,
    assistant,
    getCanCopy,
    enterEdit,
    conversation,
    /** Whether the header's label is a configured sender, so it can withhold the model
     *  it stands in for. */
    hasConfiguredSender: isConfiguredSender({
      sender: message?.sender,
      endpoint: message?.endpoint ?? conversation?.endpoint,
      endpointType: conversation?.endpointType,
      model: message?.model ?? conversation?.model,
      isCreatedByUser: message?.isCreatedByUser,
    }),
    isSubmitting,
    handleScroll,
    handleContinue,
    latestMessageId,
    copyToClipboard,
    regenerateMessage,
  };
}
