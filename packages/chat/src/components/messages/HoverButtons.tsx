import React, { useState, useMemo, useCallback, useContext, memo } from 'react';
import { Copy, Check } from 'lucide';
import { getSpeechText, findMessageById, isUserInitiatedCompaction } from 'librechat-data-provider';
import {
  Button,
  EditIcon,
  MorphIcon,
  useLocalize,
  ContinueIcon,
  TooltipAnchor,
  RegenerateIcon,
} from '@librechat/client';
import type { TConversation, TMessage, TFeedback } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode } from 'react';
import { MessageAudioSlot, useMessagesHost } from '../../react/messages/host';
import useGenerationsByLatest from '../../react/messages/generations';
import { hasEditablePart } from '../../core/parts/editableParts';
import { ChatContext } from '../../react/chat/context';
import Feedback from './Feedback';
import Fork from './Fork';

type THoverButtons = {
  isEditing: boolean;
  enterEdit: (cancel?: boolean) => void;
  copyToClipboard: (setIsCopied: React.Dispatch<React.SetStateAction<boolean>>) => void;
  getCanCopy: () => boolean;
  conversation: TConversation | null;
  message: TMessage;
  regenerate: () => void;
  handleContinue: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** The tail as of the row's last render, which the row re-renders on whenever
   *  this message enters or leaves it; compared against, never sent anywhere. */
  latestMessageId?: string;
  /** The tail at call time, for actions that send it (forking at a split target). */
  getLatestMessageId?: () => string | undefined;
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
  /** Fades the button in with its row; the latest message's toolbar stays visible. */
  reveal?: boolean;
  dataTestId?: string;
  disabled?: boolean;
  /** Kept in the row but out of sight and out of reach: no ink, no focus, no click. Where the
   *  toolbar is centered the control also gives up its box, so the rest stay centered. */
  concealed?: boolean;
};

/**
 * Invisible rather than removed where the toolbar starts at the row's edge, so concealing the
 * trailing control moves nothing: a run starting or ending conceals one on every row of the
 * thread at once. Below `lg` the toolbar is centered and an invisible box would pull the others
 * off center, so there it leaves the flow.
 *
 * Visibility does the whole job: a hidden control takes no focus, no pointer and no place in
 * the accessibility tree. It is deliberately NOT also `disabled`. The stylesheet holds
 * `:has(:disabled)` rules and a message row is a `:has()` anchor, so a `disabled` flip inside a
 * row re-styles that row's entire subtree; flipped on every row at once that is the whole
 * transcript, 90 ms of it in a 250-message thread against 9 ms for the class alone. Mounting and
 * unmounting the button invalidates the same way.
 *
 * `data-concealed` is for the app's narrow-screen stylesheet, which forces every toolbar button
 * visible from outside any cascade layer and would otherwise outrank both utilities.
 */
const CONCEALED = 'max-lg:hidden lg:invisible';

const HoverButton = memo(
  ({
    id,
    onClick,
    title,
    icon,
    isActive = false,
    isLast = false,
    reveal = !isLast,
    dataTestId,
    disabled = false,
    concealed = false,
  }: HoverButtonProps) => {
    return (
      <TooltipAnchor
        description={title}
        render={
          <Button
            variant={reveal ? 'message-hover-reveal' : 'message-hover'}
            id={id}
            data-testid={dataTestId}
            data-hover-active={isActive || undefined}
            aria-label={title}
            aria-hidden={concealed || undefined}
            data-concealed={concealed || undefined}
            onClick={concealed ? undefined : onClick}
            disabled={disabled}
            className={concealed ? CONCEALED : undefined}
          >
            {icon}
          </Button>
        }
      />
    );
  },
);

HoverButton.displayName = 'HoverButton';

type ToolbarIcons = Record<'copy' | 'copied' | 'edit' | 'regenerate' | 'continue', ReactNode>;

let toolbarIcons: ToolbarIcons | undefined;

/**
 * The toolbar's glyphs, one element each for every row. A send and its completion re-render the
 * toolbar of every row in the thread, and an element built in that render is a new `icon` prop:
 * `HoverButton`'s memo then fails for each button of each row, and the tooltip and button under
 * it render again for nothing. Built on first use, since this module must not read
 * `@librechat/client` while it loads.
 */
function getToolbarIcons(): ToolbarIcons {
  toolbarIcons ??= {
    copy: <MorphIcon icon={Copy} size="1.1875rem" />,
    copied: <MorphIcon icon={Check} size="1.1875rem" />,
    edit: <EditIcon size="19" />,
    regenerate: <RegenerateIcon size="19" />,
    continue: <ContinueIcon className="size-4.75" />,
  };
  return toolbarIcons;
}

const HoverButtons = ({
  index,
  isEditing,
  enterEdit,
  copyToClipboard,
  getCanCopy,
  conversation,
  message,
  regenerate,
  handleContinue,
  latestMessageId,
  getLatestMessageId,
  isLast,
  handleFeedback,
}: THoverButtons): ReactNode => {
  const localize = useLocalize();
  /** Read from the pane's chat contract here rather than passed down: a send toggles the
   *  rerun controls on every row, and only this toolbar has to re-render for it. */
  const isSubmitting = useContext(ChatContext)?.isSubmitting === true;
  const [isCopied, setIsCopied] = useState(false);
  const { useGetMessages, useHasPendingTurn } = useMessagesHost();
  const getMessages = useGetMessages();
  const hasPendingTurn = useHasPendingTurn(conversation?.conversationId ?? '');

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
   *  in hand a parent that does not resolve is absent (an imported reply the
   *  lineage left at the root) and there is no turn to replay, which `regenerate`
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
    isSubmitting: isSubmitting || hasPendingTurn,
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
    regenerateOffered,
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

  /** Stable for the same reason the icons are: a handler made in render is a new `onClick`. */
  const onEdit = useCallback(() => {
    if (isEditing) {
      return enterEdit(true);
    }
    enterEdit();
  }, [isEditing, enterEdit]);
  const handleCopy = useCallback(() => copyToClipboard(setIsCopied), [copyToClipboard]);
  const onContinue = useCallback(
    (e?: React.MouseEvent<HTMLButtonElement>) => e && handleContinue(e),
    [handleContinue],
  );

  if (!conversation) {
    return null;
  }

  const { isCreatedByUser, error } = message;
  const isSubagentThreadReadOnly = conversation.subagentThread != null;
  const icons = getToolbarIcons();
  const speechText = getSpeechText(message);

  return (
    <div className="group visible flex justify-center gap-0.5 self-end focus-within:outline-hidden lg:justify-start">
      {/* Text to Speech */}
      {!error && !isActiveStreamingMessage && speechText.length > 0 && (
        <MessageAudioSlot
          index={index}
          isLast={isLast}
          messageId={message.messageId}
          content={speechText}
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
          icon={isCopied ? icons.copied : icons.copy}
          isLast={isLast}
          disabled={!canCopy}
          reveal={!isLast || (isSubmitting && isCreatedByUser)}
          dataTestId={!isCreatedByUser ? 'copy-response-button' : undefined}
        />
      )}

      {/* Edit Button */}
      {!isSubagentThreadReadOnly && isEditableEndpoint && !hideEditButton && (
        <HoverButton
          id={`edit-${message.messageId}`}
          onClick={onEdit}
          title={localize('com_ui_edit')}
          icon={icons.edit}
          isActive={isEditing}
          isLast={isLast}
        />
      )}

      {/* Fork Button: withheld on a failed turn, whose copy would carry the provider's error as an
          ordinary answer. The error card's "Branch without files" copies up to the turn before. */}
      {!error && !isActiveStreamingMessage && (
        <Fork
          messageId={message.messageId}
          conversationId={conversation.conversationId}
          forkingSupported={forkingSupported}
          getLatestMessageId={getLatestMessageId ?? (() => latestMessageId)}
          isLast={isLast}
        />
      )}

      {/* Feedback Buttons */}
      {!error && !isActiveStreamingMessage && !isCreatedByUser && handleFeedback != null && (
        <Feedback handleFeedback={handleFeedback} feedback={message.feedback} isLast={isLast} />
      )}

      {/* Regenerate Button: mounted for as long as the row has a rerun to offer, and concealed
          while a run is in flight. Every row loses and regains its rerun together when a run
          starts and ends; unmounting and remounting a button on each of them is a layout of the
          whole thread at exactly the two moments the reader is waiting on. The reply being
          written is the one row that offers nothing at all, so it mounts none. */}
      {!isSubagentThreadReadOnly && regenerateOffered && !isActiveStreamingMessage && (
        <HoverButton
          onClick={regenerate}
          title={localize('com_ui_regenerate')}
          icon={icons.regenerate}
          isLast={isLast}
          concealed={!regenerateEnabled}
          dataTestId={isLast ? 'regenerate-generation-button' : undefined}
        />
      )}

      {/* Continue Button */}
      {!isSubagentThreadReadOnly && continueSupported && (
        <HoverButton
          onClick={onContinue}
          title={localize('com_ui_continue')}
          icon={icons.continue}
          isLast={isLast}
          dataTestId={isLast ? 'continue-generation-button' : undefined}
        />
      )}
    </div>
  );
};

const MemoHoverButtons: NamedExoticComponent<THoverButtons> = memo(HoverButtons);

export default MemoHoverButtons;
