import React, { useState, useMemo, useCallback, memo } from 'react';
import { Copy, Check } from 'lucide';
import { useAtomValue } from 'jotai';
import { useRecoilState } from 'recoil';
import { findMessageById, isUserInitiatedCompaction } from 'librechat-data-provider';
import {
  Button,
  EditIcon,
  MorphIcon,
  ContinueIcon,
  TooltipAnchor,
  RegenerateIcon,
} from '@librechat/client';
import type { TConversation, TMessage, TFeedback } from 'librechat-data-provider';
import { useGenerationsByLatest, useLocalize } from '~/hooks';
import { useOptionalMessagesOperations } from '~/Providers';
import { hasEditablePart } from './Content/editableParts';
import { revealedQueuedTurnFamily } from '~/store/steer';
import { Fork } from '~/components/Conversations';
import { hoverButtonClasses } from './styles';
import MessageAudio from './MessageAudio';
import Feedback from './Feedback';
import { cn } from '~/utils';
import store from '~/store';

type THoverButtons = {
  isEditing: boolean;
  enterEdit: (cancel?: boolean) => void;
  copyToClipboard: (setIsCopied: React.Dispatch<React.SetStateAction<boolean>>) => void;
  getCanCopy: () => boolean;
  conversation: TConversation | null;
  isSubmitting: boolean;
  message: TMessage;
  regenerate: () => void;
  handleContinue: (e: React.MouseEvent<HTMLButtonElement>) => void;
  latestMessageId?: string;
  isLast: boolean;
  index: number;
  handleFeedback?: ({ feedback }: { feedback: TFeedback | undefined }) => void;
};

type HoverButtonProps = {
  id?: string;
  onClick: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  icon: React.ReactNode;
  isActive?: boolean;
  isLast?: boolean;
  className?: string;
  buttonStyle?: string;
  dataTestId?: string;
  disabled?: boolean;
};

const extractMessageContent = (message: TMessage): string => {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (part == null) {
          return '';
        }
        if (typeof part === 'string') {
          return part;
        }
        if ('text' in part) {
          return part.text || '';
        }
        if ('think' in part) {
          const think = part.think;
          if (typeof think === 'string') {
            return think;
          }
          return think && 'text' in think ? think.text || '' : '';
        }
        return '';
      })
      .join('');
  }

  return message.text || '';
};

const HoverButton = memo(
  ({
    id,
    onClick,
    title,
    icon,
    isActive = false,
    isLast = false,
    className = '',
    dataTestId,
    disabled = false,
  }: HoverButtonProps) => {
    const buttonStyle = hoverButtonClasses({ isActive, isLast, className });

    return (
      <TooltipAnchor
        description={title}
        render={
          <Button
            variant="ghost"
            size="icon"
            id={id}
            data-testid={dataTestId}
            aria-label={title}
            className={buttonStyle}
            onClick={onClick}
            disabled={disabled}
          >
            {icon}
          </Button>
        }
      />
    );
  },
);

HoverButton.displayName = 'HoverButton';

const HoverButtons = ({
  index,
  isEditing,
  enterEdit,
  copyToClipboard,
  getCanCopy,
  conversation,
  isSubmitting,
  message,
  regenerate,
  handleContinue,
  latestMessageId,
  isLast,
  handleFeedback,
}: THoverButtons) => {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const [TextToSpeech] = useRecoilState<boolean>(store.textToSpeech);
  const { getMessages } = useOptionalMessagesOperations();
  const pendingReveal = useAtomValue(revealedQueuedTurnFamily(conversation?.conversationId ?? ''));

  const endpoint = useMemo(() => {
    if (!conversation) {
      return '';
    }
    return conversation.endpointType ?? conversation.endpoint;
  }, [conversation]);

  /** Which turn a rerun would replay, resolved for a model turn only. The lookup
   *  goes through the messages array's memoized id index, so a conversation is
   *  indexed once for all its rows rather than scanned once per row, and the memo
   *  is keyed on the parent id: `getMessages` is a cache read, not a subscription,
   *  and a parent's authorship never changes. Outside the messages view (a search
   *  row) the thread is unavailable and the answer stays unknown; with the thread
   *  in hand a parent that does not resolve is absent — an imported reply the
   *  lineage left at the root — and there is no turn to replay, which `regenerate`
   *  can only log about once the button is pressed. */
  const parentIsUserMessage = useMemo(() => {
    if (message.isCreatedByUser === true) {
      return undefined;
    }
    const messages = getMessages();
    if (messages == null) {
      return undefined;
    }
    return findMessageById(messages, message.parentMessageId)?.isCreatedByUser === true;
  }, [getMessages, message.isCreatedByUser, message.parentMessageId]);

  /** Resolved only if the row has nothing to replay, because the artifact check
   *  inside parses markdown. */
  const getHasEditablePart = useCallback(() => hasEditablePart(message), [message]);

  /** A pending queued follow-up is a generation about to start: no rerun or
   *  continuation may race it, exactly as while a run is submitting. */
  const generationCapabilities = useGenerationsByLatest({
    isEditing,
    isSubmitting: isSubmitting || pendingReveal != null,
    error: message.error,
    endpoint: endpoint ?? '',
    messageId: message.messageId,
    searchResult: message.searchResult,
    finish_reason: message.finish_reason,
    isCreatedByUser: message.isCreatedByUser,
    getHasEditablePart,
    parentIsUserMessage,
    isUserInitiatedCompaction: isUserInitiatedCompaction(message),
    latestMessageId: latestMessageId,
  });

  const {
    hideEditButton,
    regenerateEnabled,
    continueSupported,
    forkingSupported,
    isActiveStreamingMessage,
    isEditableEndpoint,
  } = generationCapabilities;

  const canCopy = useMemo(
    () => !isActiveStreamingMessage && getCanCopy(),
    [isActiveStreamingMessage, getCanCopy],
  );

  if (!conversation) {
    return null;
  }

  const { isCreatedByUser, error } = message;
  const isSubagentThreadReadOnly = conversation.subagentThread != null;

  const onEdit = () => {
    if (isEditing) {
      return enterEdit(true);
    }
    enterEdit();
  };

  const handleCopy = () => copyToClipboard(setIsCopied);

  return (
    <div className="group visible flex justify-center gap-0.5 self-end focus-within:outline-none lg:justify-start">
      {/* Text to Speech */}
      {TextToSpeech && !error && !isActiveStreamingMessage && (
        <MessageAudio
          index={index}
          isLast={isLast}
          messageId={message.messageId}
          content={extractMessageContent(message)}
          renderButton={(props) => (
            <HoverButton
              onClick={props.onClick}
              title={props.title}
              icon={props.icon}
              isActive={props.isActive}
              isLast={isLast}
              dataTestId={isLast && !isCreatedByUser ? 'read-aloud-button' : undefined}
            />
          )}
        />
      )}

      {/* Copy Button */}
      {!isActiveStreamingMessage && (
        <HoverButton
          onClick={handleCopy}
          title={
            isCopied ? localize('com_ui_copied_to_clipboard') : localize('com_ui_copy_to_clipboard')
          }
          icon={<MorphIcon icon={isCopied ? Check : Copy} size={19} />}
          isLast={isLast}
          disabled={!canCopy}
          className={cn(
            'ml-0 flex items-center gap-1.5 text-xs',
            isSubmitting && isCreatedByUser
              ? 'group-hover:opacity-100 [@media(hover:hover)]:opacity-0'
              : '',
          )}
          dataTestId={!isCreatedByUser ? 'copy-response-button' : undefined}
        />
      )}

      {/* Edit Button */}
      {!isSubagentThreadReadOnly && isEditableEndpoint && !hideEditButton && (
        <HoverButton
          id={`edit-${message.messageId}`}
          onClick={onEdit}
          title={localize('com_ui_edit')}
          icon={<EditIcon size="19" />}
          isActive={isEditing}
          isLast={isLast}
          className={isCreatedByUser ? '' : 'active'}
        />
      )}

      {/* Fork Button */}
      {!error && !isActiveStreamingMessage && (
        <Fork
          messageId={message.messageId}
          conversationId={conversation.conversationId}
          forkingSupported={forkingSupported}
          latestMessageId={latestMessageId}
          isLast={isLast}
        />
      )}

      {/* Feedback Buttons */}
      {!error && !isActiveStreamingMessage && !isCreatedByUser && handleFeedback != null && (
        <Feedback handleFeedback={handleFeedback} feedback={message.feedback} isLast={isLast} />
      )}

      {/* Regenerate Button */}
      {!isSubagentThreadReadOnly && regenerateEnabled && (
        <HoverButton
          onClick={regenerate}
          title={localize('com_ui_regenerate')}
          icon={<RegenerateIcon size="19" />}
          isLast={isLast}
          dataTestId={isLast ? 'regenerate-generation-button' : undefined}
          className="active"
        />
      )}

      {/* Continue Button */}
      {!isSubagentThreadReadOnly && continueSupported && (
        <HoverButton
          onClick={(e) => e && handleContinue(e)}
          title={localize('com_ui_continue')}
          icon={<ContinueIcon className="w-19 h-19 -rotate-180" />}
          isLast={isLast}
          dataTestId={isLast ? 'continue-generation-button' : undefined}
          className="active"
        />
      )}
    </div>
  );
};

export default memo(HoverButtons);
