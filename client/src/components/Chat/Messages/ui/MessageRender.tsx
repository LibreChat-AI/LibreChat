import React, { useCallback, useMemo, memo } from 'react';
import { useRecoilValue } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps, TMessageIcon, TMessageChatContext } from '~/common';
import {
  areMessageFieldsEqual,
  cn,
  getHeaderPrefixForScreenReader,
  getMessageAriaLabel,
} from '~/utils';
import { revealOnRowHoverClasses, messageFooterClasses } from '~/components/Chat/Messages/styles';
import { parseWakeupText } from '~/components/Chat/Messages/Content/Parts/wakeup';
import Elapsed, { shouldShowElapsed } from '~/components/Chat/Messages/Elapsed';
import { getHeaderHoverLabel } from '~/components/Chat/Messages/ui/HeaderLabel';
import MessageContent from '~/components/Chat/Messages/Content/MessageContent';
import { useLocalize, useMessageActions, useContentMetadata } from '~/hooks';
import SiblingSwitch from '~/components/Chat/Messages/SiblingSwitch';
import HoverButtons from '~/components/Chat/Messages/HoverButtons';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import Wakeup from '~/components/Chat/Messages/Content/Wakeup';
import SubRow from '~/components/Chat/Messages/SubRow';
import { MessageContext } from '~/Providers';
import store from '~/store';

type MessageRenderProps = {
  message?: TMessage;
  /**
   * Effective isSubmitting: false for non-latest messages, real value for latest.
   * Computed by the wrapper (Message.tsx) so this memo'd component only re-renders
   * when the value actually matters.
   */
  isSubmitting?: boolean;
  /** Stable context object from wrapper — avoids ChatContext subscription inside memo */
  chatContext: TMessageChatContext;
} & Pick<
  TMessageProps,
  'currentEditId' | 'setCurrentEditId' | 'siblingIdx' | 'setSiblingIdx' | 'siblingCount'
>;

/**
 * Custom comparator for React.memo: compares `message` by key fields instead of reference
 * because `buildTree` creates new message objects on every streaming update for ALL messages,
 * even when only the latest message's text changed.
 */
function areMessageRenderPropsEqual(prev: MessageRenderProps, next: MessageRenderProps): boolean {
  if (prev.isSubmitting !== next.isSubmitting) {
    return false;
  }
  if (prev.chatContext !== next.chatContext) {
    return false;
  }
  if (prev.siblingIdx !== next.siblingIdx) {
    return false;
  }
  if (prev.siblingCount !== next.siblingCount) {
    return false;
  }
  if (prev.currentEditId !== next.currentEditId) {
    return false;
  }
  if (prev.setSiblingIdx !== next.setSiblingIdx) {
    return false;
  }
  if (prev.setCurrentEditId !== next.setCurrentEditId) {
    return false;
  }

  return areMessageFieldsEqual(prev.message, next.message);
}

const MessageRender = memo(function MessageRender({
  message: msg,
  siblingIdx,
  siblingCount,
  setSiblingIdx,
  currentEditId,
  setCurrentEditId,
  isSubmitting = false,
  chatContext,
}: MessageRenderProps) {
  const localize = useLocalize();
  const {
    ask,
    edit,
    index,
    agent,
    assistant,
    enterEdit,
    conversation,
    messageLabel,
    handleFeedback,
    handleContinue,
    latestMessageId,
    copyToClipboard,
    getCanCopy,
    regenerateMessage,
    latestMessageDepth,
    hasConfiguredSender,
  } = useMessageActions({
    message: msg,
    currentEditId,
    setCurrentEditId,
    chatContext,
  });
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);

  const handleRegenerateMessage = useCallback(() => regenerateMessage(), [regenerateMessage]);
  const hasNoChildren = !(msg?.children?.length ?? 0);
  const isLast = useMemo(
    () => hasNoChildren && (msg?.depth === latestMessageDepth || msg?.depth === -1),
    [hasNoChildren, msg?.depth, latestMessageDepth],
  );
  const isLatestMessage = msg?.messageId === latestMessageId;

  const iconData: TMessageIcon = useMemo(
    () => ({
      endpoint: msg?.endpoint ?? conversation?.endpoint,
      model: msg?.model ?? conversation?.model,
      iconURL: msg?.iconURL,
      modelLabel: messageLabel,
      isCreatedByUser: msg?.isCreatedByUser,
    }),
    [
      messageLabel,
      conversation?.endpoint,
      conversation?.model,
      msg?.model,
      msg?.iconURL,
      msg?.endpoint,
      msg?.isCreatedByUser,
    ],
  );

  const { hasParallelContent } = useContentMetadata(msg);
  const wakeupDisplay = useMemo(
    () => (msg?.isCreatedByUser === true ? parseWakeupText(msg.text) : null),
    [msg?.isCreatedByUser, msg?.text],
  );
  const messageId = msg?.messageId ?? '';
  const messageContextValue = useMemo(
    () => ({
      messageId,
      isLatestMessage,
      isExpanded: false as const,
      isSubmitting,
      conversationId: conversation?.conversationId,
    }),
    [messageId, conversation?.conversationId, isSubmitting, isLatestMessage],
  );

  if (!msg) {
    return null;
  }

  return (
    <MessageRow
      id={msg.messageId}
      icon={<MessageIcon iconData={iconData} assistant={assistant} agent={agent} />}
      label={messageLabel ?? ''}
      hoverLabel={getHeaderHoverLabel(
        hasConfiguredSender,
        agent?.model,
        assistant?.model,
        msg.model,
        conversation?.model,
      )}
      timestamp={msg.createdAt ?? msg.clientTimestamp}
      ariaLabel={getMessageAriaLabel(msg, localize)}
      headerPrefix={getHeaderPrefixForScreenReader(msg, localize)}
      isCreatedByUser={msg.isCreatedByUser === true}
      hasParallelContent={hasParallelContent}
      fullWidth={maximizeChatSpace}
      isEditing={edit}
      systemLabel={wakeupDisplay != null && !edit ? localize('com_ui_system_event') : undefined}
      footer={
        <SubRow classes={cn(messageFooterClasses, msg.isCreatedByUser && 'justify-end')}>
          {/* The reading holds the column start: it takes over the slot the streaming
              dot vacates, so the retry navigation beside it — whose width the footer
              reserves whether or not hover has revealed it — must never push the
              timer inboard of that column. */}
          {shouldShowElapsed({
            isSubmitting,
            isLatestMessage,
            isCreatedByUser: msg.isCreatedByUser,
            siblingIdx,
            siblingCount,
          }) && <Elapsed index={index} />}
          {/* A user turn is right-aligned, so its retry navigation belongs at the
              outer edge under the bubble rather than inboard of the actions.

              While the answer is generating every other action is withheld, which
              would otherwise leave this counter sitting alone under a half-written
              response. It reveals on hover there, like the actions it sits with. */}
          <SiblingSwitch
            siblingIdx={siblingIdx}
            siblingCount={siblingCount}
            setSiblingIdx={setSiblingIdx}
            className={cn(
              msg.isCreatedByUser === true && 'order-last',
              isSubmitting && isLatestMessage && revealOnRowHoverClasses,
            )}
          />
          <HoverButtons
            index={index}
            isEditing={edit}
            message={msg}
            enterEdit={enterEdit}
            isSubmitting={chatContext.isSubmitting}
            conversation={conversation ?? null}
            regenerate={handleRegenerateMessage}
            copyToClipboard={copyToClipboard}
            getCanCopy={getCanCopy}
            handleContinue={handleContinue}
            latestMessageId={latestMessageId}
            handleFeedback={handleFeedback}
            isLast={isLast}
          />
        </SubRow>
      }
    >
      <MessageContext.Provider value={messageContextValue}>
        {wakeupDisplay != null && !edit ? (
          <Wakeup display={wakeupDisplay} conversationId={conversation?.conversationId} />
        ) : (
          <MessageContent
            ask={ask}
            edit={edit}
            isLast={isLast}
            text={msg.text || ''}
            message={msg}
            enterEdit={enterEdit}
            error={!!(msg.error ?? false)}
            isSubmitting={isSubmitting}
            unfinished={msg.unfinished ?? false}
            isCreatedByUser={msg.isCreatedByUser ?? true}
            siblingIdx={siblingIdx ?? 0}
            setSiblingIdx={setSiblingIdx ?? (() => ({}))}
          />
        )}
      </MessageContext.Provider>
    </MessageRow>
  );
}, areMessageRenderPropsEqual);
MessageRender.displayName = 'MessageRender';

export default MessageRender;
