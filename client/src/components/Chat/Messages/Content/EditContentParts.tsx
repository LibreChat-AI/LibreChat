import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Alert, Button, TextareaAutosize } from '@librechat/client';
import { useUpdateMessageContentMutation } from 'librechat-data-provider/react-query';
import {
  ContentTypes,
  findMessageById,
  stripReasoningLabelMetadata,
} from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useMessagesConversation, useMessagesOperations } from '~/Providers';
import { getPartText, isEditablePart, withPartText } from './editableParts';
import { findRerunParent } from './rerunParent';
import { useGetAddedConvo } from '~/hooks/Chat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type EditableType = ContentTypes.TEXT | ContentTypes.THINK;

type EditablePart = {
  index: number;
  localIndex: number;
  type: EditableType;
  original: string;
};

type EditContentPartsProps = {
  content: Array<TMessageContentParts | undefined>;
  contentIndexOffset?: number;
  messageId: string;
  isSubmitting: boolean;
  enterEdit: (cancel?: boolean) => void | null | undefined;
  siblingIdx: number | null;
  setSiblingIdx: (value: number) => void;
  renderReadOnlyPart: (part: TMessageContentParts, index: number, isLastPart: boolean) => ReactNode;
};

export default function EditContentParts({
  content,
  contentIndexOffset = 0,
  messageId,
  isSubmitting,
  enterEdit,
  siblingIdx,
  setSiblingIdx,
  renderReadOnlyPart,
}: EditContentPartsProps) {
  const localize = useLocalize();
  const isRTL = useRecoilValue(store.chatDirection).toLowerCase() === 'rtl';
  const { conversation } = useMessagesConversation();
  const { ask, getMessages, setMessages } = useMessagesOperations();
  const getAddedConvo = useGetAddedConvo();
  const firstEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const updateMessageContentMutation = useUpdateMessageContentMutation(
    conversation?.conversationId ?? '',
  );

  const editableParts = useMemo<EditablePart[]>(() => {
    const result: EditablePart[] = [];
    content.forEach((part, localIndex) => {
      if (!part || !isEditablePart(part)) {
        return;
      }
      const original = getPartText(part);
      if (original == null) {
        return;
      }
      result.push({
        index: localIndex + contentIndexOffset,
        localIndex,
        type: part.type as EditableType,
        original,
      });
    });
    return result;
  }, [content, contentIndexOffset]);

  const [drafts, setDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(editableParts.map((part) => [part.index, part.original])),
  );

  const editableByLocalIndex = useMemo(
    () => new Map(editableParts.map((part) => [part.localIndex, part])),
    [editableParts],
  );
  const changedParts = useMemo(
    () => editableParts.filter((part) => drafts[part.index] !== part.original),
    [drafts, editableParts],
  );
  /** Emptying a part would persist a blank one, and nothing in the editor offers a
   *  way back: there is no delete-part affordance, so the only reading of a cleared
   *  box is an accident. The sibling `EditMessage` refuses the same edit through its
   *  form's `required` rule, so both editors hold the same line. */
  const hasBlankEdit = useMemo(
    () => changedParts.some((part) => (drafts[part.index] ?? '').trim() === ''),
    [changedParts, drafts],
  );
  const editedMessage = findMessageById(getMessages(), messageId);
  const isBusy = isSubmitting || isSaving;
  /** A rerun replays the parent as the turn's user message, so a model turn with no
   *  user turn behind it — chained onto another model turn, or left at the root by an
   *  import — has none. The action is withheld rather than offered and silently
   *  refused, the footer says why, and Save still applies. */
  const canRerun =
    editedMessage?.isCreatedByUser === true ||
    findRerunParent(getMessages(), editedMessage?.parentMessageId) != null;
  /** Only meaningful while a rerun is on offer: it explains why this one is held
   *  back until the edits are saved. A save-only editor reports unsaved changes
   *  instead of an unavailable action's precondition. */
  const rerunRequiresSave =
    canRerun && editedMessage?.isCreatedByUser !== true && changedParts.length > 1;

  useEffect(() => {
    const editor = firstEditorRef.current;
    if (!editor) {
      return;
    }
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, []);

  const applySavedParts = useCallback(
    (savedParts: EditablePart[]) => {
      const messages = getMessages();
      if (!messages || savedParts.length === 0) {
        return;
      }
      const changedByLocalIndex = new Map(
        savedParts.map((part) => [part.localIndex, { type: part.type, text: drafts[part.index] }]),
      );
      setMessages(
        messages.map((currentMessage) => {
          if (currentMessage.messageId !== messageId || !Array.isArray(currentMessage.content)) {
            return currentMessage;
          }
          return {
            ...currentMessage,
            content: currentMessage.content.map((part, localIndex) => {
              const change = changedByLocalIndex.get(localIndex);
              if (!part || !change || part.type !== change.type) {
                return part;
              }
              const editedPart = {
                ...part,
                [change.type]: withPartText(part, change.text),
              } as TMessageContentParts;
              return change.type === ContentTypes.THINK
                ? stripReasoningLabelMetadata(editedPart)
                : editedPart;
            }),
          };
        }),
      );
    },
    [drafts, getMessages, messageId, setMessages],
  );

  const saveChanges = useCallback(async () => {
    if (changedParts.length === 0 || hasBlankEdit || isBusy) {
      return;
    }
    setIsSaving(true);
    setSaveError(false);
    /** The endpoint takes one part per call and nothing rolls a write back, so a
     *  refused part leaves the earlier ones on the server. Recording what actually
     *  landed lets the failure reconcile the transcript with the server instead of
     *  claiming nothing was saved, and leaves only the refused parts still edited. */
    const savedParts: EditablePart[] = [];
    try {
      /** Each endpoint call replaces the full content array. Keep writes ordered so a
       *  later edit reads the content produced by the previous one instead of racing it. */
      for (const part of changedParts) {
        await updateMessageContentMutation.mutateAsync({
          index: part.index,
          conversationId: conversation?.conversationId ?? '',
          text: drafts[part.index],
          messageId,
        });
        savedParts.push(part);
      }
    } catch {
      setSaveError(true);
    } finally {
      applySavedParts(savedParts);
      setIsSaving(false);
    }

    if (savedParts.length === changedParts.length) {
      enterEdit(true);
    }
  }, [
    applySavedParts,
    changedParts,
    conversation?.conversationId,
    drafts,
    enterEdit,
    hasBlankEdit,
    isBusy,
    messageId,
    updateMessageContentMutation,
  ]);

  /** A rerun with no edits is a first-class action, not a mistake: a cancelled or
   *  failed response, or a backend restarted on different parameters, has to be
   *  reissued byte-for-byte. Gating the button on a change only taught people to
   *  type a space and delete it again. */
  const updateAndRerun = useCallback(() => {
    if (!editedMessage || rerunRequiresSave || hasBlankEdit || isBusy) {
      return;
    }
    const firstChange = changedParts[0];
    const messages = getMessages();

    /** `ask` refuses to send while another response is streaming and reports it by
     *  returning false. Closing the editor regardless would throw the drafts away for
     *  a rerun that never started, so a refused send leaves the editor as it was. */
    let refused = false;
    /** An unedited assistant turn regenerates in place, landing as a sibling of this
     *  response rather than of the user turn this editor's sibling index walks. */
    let regenerated = false;

    if (editedMessage.isCreatedByUser === true) {
      const userText = editableParts
        .filter((part) => part.type === ContentTypes.TEXT)
        .map((part) => drafts[part.index])
        .join('\n');
      /** Retained attachments make an otherwise textless request submittable, matching
       *  the composer and the sibling `EditMessage` form's `required` rule. A turn with
       *  neither text nor files has nothing to send, edited or not. */
      if (userText.trim() === '' && (editedMessage.files?.length ?? 0) === 0) {
        return;
      }
      refused =
        ask(
          {
            text: userText,
            parentMessageId: editedMessage.parentMessageId,
            conversationId: editedMessage.conversationId,
          },
          {
            overrideFiles: editedMessage.files,
            overrideManualSkills: editedMessage.manualSkills,
            overrideQuotes: editedMessage.quotes,
            overrideReasoning: editedMessage.reasoningOverride ?? null,
            addedConvo: getAddedConvo() || undefined,
          },
        ) === false;
    } else {
      /** The same resolution the withheld button is gated on, so a rendered Rerun and
       *  the submission it runs cannot disagree about the turn being replayed. */
      const parentMessage = findRerunParent(messages, editedMessage.parentMessageId);
      if (!parentMessage) {
        return;
      }
      if (!firstChange) {
        /** No edit means no retained prefix to continue from, so rerunning the response
         *  regenerates it: the same submission the hover action sends. Replaying the
         *  unchanged part as `editedContent` instead would keep this answer and append
         *  a second one to it. */
        regenerated = true;
        refused =
          ask(
            { ...parentMessage },
            {
              isRegenerate: true,
              targetResponseMessageId: messageId,
              overrideManualSkills: parentMessage.manualSkills,
              overrideQuotes: parentMessage.quotes,
              overrideReasoning: parentMessage.reasoningOverride ?? null,
              addedConvo: getAddedConvo() || undefined,
            },
          ) === false;
      } else {
        const editedContent =
          firstChange.type === ContentTypes.THINK
            ? {
                index: firstChange.index,
                type: ContentTypes.THINK as const,
                [ContentTypes.THINK]: drafts[firstChange.index],
              }
            : {
                index: firstChange.index,
                type: ContentTypes.TEXT as const,
                [ContentTypes.TEXT]: drafts[firstChange.index],
              };
        refused =
          ask(
            { ...parentMessage },
            {
              editedContent,
              editedMessageId: messageId,
              isRegenerate: true,
              isEdited: true,
              overrideManualSkills: parentMessage.manualSkills,
              overrideQuotes: parentMessage.quotes,
              overrideReasoning: parentMessage.reasoningOverride ?? null,
              addedConvo: getAddedConvo() || undefined,
            },
          ) === false;
      }
    }

    if (refused) {
      return;
    }

    if (!regenerated) {
      setSiblingIdx((siblingIdx ?? 0) - 1);
    }
    enterEdit(true);
  }, [
    ask,
    changedParts,
    drafts,
    editedMessage,
    editableParts,
    enterEdit,
    getAddedConvo,
    getMessages,
    hasBlankEdit,
    isBusy,
    messageId,
    rerunRequiresSave,
    setSiblingIdx,
    siblingIdx,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        enterEdit(true);
        return;
      }
      if (canRerun && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        updateAndRerun();
        return;
      }
      if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveChanges();
      }
    },
    [canRerun, enterEdit, saveChanges, updateAndRerun],
  );

  /** Every state shares the footer's one status slot so none can add a row and
   *  shift the message below it, which orders them by how actionable they are:
   *  a blocked or pending save first, then why the footer offers no rerun — the
   *  question a Save-only editor otherwise leaves unanswered. */
  const getStatusMessage = () => {
    if (hasBlankEdit) {
      return localize('com_ui_message_part_empty');
    }
    if (rerunRequiresSave) {
      return localize('com_ui_save_before_rerun');
    }
    if (changedParts.length > 0) {
      return localize('com_ui_unsaved_changes');
    }
    if (!canRerun) {
      return localize('com_ui_rerun_needs_user_turn');
    }
    return '';
  };

  return (
    <section
      aria-label={localize('com_ui_edit_message')}
      className="flex w-full min-w-0 flex-col gap-2"
    >
      {saveError && <Alert variant="error">{localize('com_ui_save_message_error')}</Alert>}

      <div className="flex min-w-0 flex-col gap-3">
        {content.map((part, localIndex) => {
          if (!part) {
            return null;
          }
          const editablePart = editableByLocalIndex.get(localIndex);
          const absoluteIndex = localIndex + contentIndexOffset;
          if (!editablePart) {
            return (
              <div key={`read-only-${messageId}-${absoluteIndex}`} className="min-w-0">
                {renderReadOnlyPart(part, absoluteIndex, localIndex === content.length - 1)}
              </div>
            );
          }
          const label =
            editablePart.type === ContentTypes.THINK
              ? localize('com_ui_thoughts')
              : localize('com_ui_response');
          return (
            <label
              key={`editor-${messageId}-${absoluteIndex}`}
              dir={isRTL ? 'rtl' : 'ltr'}
              className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-text-secondary"
            >
              {label}
              <TextareaAutosize
                focusOutline="hidden"
                ref={editablePart === editableParts[0] ? firstEditorRef : undefined}
                value={drafts[absoluteIndex]}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [absoluteIndex]: event.target.value,
                  }))
                }
                onKeyDown={handleKeyDown}
                aria-label={`${localize('com_ui_editable_message')}: ${label}`}
                aria-keyshortcuts={
                  canRerun
                    ? 'Control+Enter Meta+Enter Control+S Meta+S Escape'
                    : 'Control+S Meta+S Escape'
                }
                disabled={isBusy}
                minRows={3}
                dir={isRTL ? 'rtl' : 'ltr'}
                className={cn(
                  'message-editor-text max-h-[65vh] min-h-24 w-full resize-y rounded-lg',
                  'border border-border-medium bg-surface-tertiary-alt px-3 py-2',
                  'font-normal text-text-primary',
                  isRTL ? 'text-right' : 'text-left',
                  'disabled:opacity-50 md:max-h-[75vh]',
                )}
              />
            </label>
          );
        })}
      </div>

      {/* The actions wrap rather than hold one unbreakable row: on a 320px assistant
          turn the identity column and page padding leave less width than the three
          English labels need, and a translated label needs more still. */}
      <footer className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="line-clamp-2 min-w-0 flex-1 text-xs text-text-secondary"
          aria-live="polite"
        >
          {getStatusMessage()}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => enterEdit(true)} disabled={isSaving}>
            {localize('com_ui_cancel')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveChanges()}
            disabled={changedParts.length === 0 || hasBlankEdit || isBusy}
          >
            {isSaving ? localize('com_ui_saving') : localize('com_ui_save')}
          </Button>
          {canRerun && (
            <Button
              size="sm"
              variant="submit"
              onClick={updateAndRerun}
              disabled={rerunRequiresSave || hasBlankEdit || isBusy}
            >
              {changedParts.length > 0 ? localize('com_ui_update_rerun') : localize('com_ui_rerun')}
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
