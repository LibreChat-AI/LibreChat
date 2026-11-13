import { useCallback, useMemo } from 'react';
import {
  isAssistantsEndpoint,
  isAgentsEndpoint,
  isConfiguredSender,
} from 'librechat-data-provider';
import type { Agent, Assistant, TConversation, SearchResultData } from 'librechat-data-provider';
import type { TMessageProps } from '../../react/messages/types';
import type { MessageCopy } from '../../react/messages/host';
import type { TAskFunction } from '../../core';
import { useMessagesHost } from '../../react/messages/host';
import { useChatContext } from '../../react/chat/context';
import { throttle } from '../../react/messages/throttle';
import { useMessagePartsHost } from '../../react/host';

export type MessageHelpers = {
  ask: TAskFunction;
  edit: boolean;
  agent: Agent | undefined;
  index: number;
  isLast: boolean;
  assistant: Assistant | undefined;
  getCanCopy: () => boolean;
  enterEdit: (cancel?: boolean) => void;
  conversation: TConversation | null;
  /** Whether the header's label is a configured sender, so it can withhold the model
   *  it stands in for. */
  hasConfiguredSender: boolean;
  isSubmitting: boolean;
  /** Takes no arguments so it can be handed to `onWheel` and `onTouchMove`. */
  handleScroll: () => void;
  handleContinue: ReturnType<typeof useChatContext>['handleContinue'];
  latestMessageId: string | undefined;
  copyToClipboard: MessageCopy['copyToClipboard'];
  regenerateMessage: () => void;
};

export default function useMessageHelpers(
  props: TMessageProps,
  searchResults?: { [key: string]: SearchResultData },
): MessageHelpers {
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
  } = useChatContext();
  const messagesHost = useMessagesHost();
  const partsHost = useMessagePartsHost();

  const getAddedConvo = messagesHost.useGetAddedConvo();

  const { children, messageId = null, isCreatedByUser } = message ?? {};
  const edit = messageId === currentEditId;
  const isLast = children?.length === 0 || children?.length === undefined;

  const enterEdit = useCallback(
    (cancel?: boolean) => setCurrentEditId && setCurrentEditId(cancel === true ? -1 : messageId),
    [messageId, setCurrentEditId],
  );

  const handleScroll = useCallback(() => {
    throttle(() => {
      if (isSubmitting) {
        setAbortScroll(true);
      } else {
        setAbortScroll(false);
      }
    }, 500)();
  }, [isSubmitting, setAbortScroll]);

  const assistantLookup = messagesHost.useAssistant(conversation?.endpoint, message?.model);
  const assistant = useMemo(
    () => (isAssistantsEndpoint(conversation?.endpoint) ? assistantLookup : undefined),
    [conversation?.endpoint, assistantLookup],
  );

  const agentLookup = partsHost.useAgent(message?.model ?? '');
  const agent = useMemo(
    () => (isAgentsEndpoint(conversation?.endpoint) ? agentLookup : undefined),
    [conversation?.endpoint, agentLookup],
  );

  const regenerateMessage = (): void => {
    if ((isSubmitting && isCreatedByUser === true) || !message) {
      return;
    }

    regenerate(message, { addedConvo: getAddedConvo() });
  };

  const { copyToClipboard, canCopy } = messagesHost.useMessageCopy({ message, searchResults });

  const getCanCopy = useCallback(() => canCopy, [canCopy]);

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
