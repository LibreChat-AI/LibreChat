import { useRef, useEffect, useCallback, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useForm } from 'react-hook-form';
import { Alert, Button, TextareaAutosize } from '@librechat/client';
import { useUpdateMessageMutation } from 'librechat-data-provider/react-query';
import type { TEditProps } from '~/common';
import { useMessagesOperations, useMessagesConversation } from '~/Providers';
import { findRerunParent } from './rerunParent';
import { useGetAddedConvo } from '~/hooks/Chat';
import { useLocalize } from '~/hooks';
import Container from './Container';
import { cn } from '~/utils';
import store from '~/store';

const EditMessage = ({
  text,
  message,
  isSubmitting,
  ask,
  enterEdit,
  siblingIdx,
  setSiblingIdx,
}: TEditProps) => {
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const [saveError, setSaveError] = useState(false);
  /** Editable copy of the message's attachments: the rerun submission replays
   *  these instead of the original list, so a bad or incompatible file can be
   *  removed instead of locking the message out of being resubmitted. */
  const [editedFiles, setEditedFiles] = useState(message.files ?? []);
  const { conversation } = useMessagesConversation();
  const { getMessages, setMessages } = useMessagesOperations();

  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const { conversationId, parentMessageId, messageId } = message;
  /** Only a user turn's draft becomes the submission; an assistant turn's is discarded
   *  by the rerun (see `resubmitMessage`), so it must not be labelled as an update. */
  const isUserTurn = message.isCreatedByUser === true;
  /** A rerun replays the parent as the turn's user message, so a model turn with no
   *  user turn behind it — chained onto another model turn, or left at the root by an
   *  import — has none. The action is withheld rather than offered and silently
   *  refused, the footer says why, and Save still applies. */
  const canRerun = isUserTurn || findRerunParent(getMessages(), parentMessageId) != null;
  const updateMessageMutation = useUpdateMessageMutation(conversationId ?? '');
  const localize = useLocalize();

  const chatDirection = useRecoilValue(store.chatDirection).toLowerCase();
  const isRTL = chatDirection === 'rtl';

  const getAddedConvo = useGetAddedConvo();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { isDirty, isValid },
  } = useForm({
    mode: 'onChange',
    defaultValues: {
      text: text ?? '',
    },
  });

  useEffect(() => {
    const textArea = textAreaRef.current;
    if (textArea) {
      const length = textArea.value.length;
      textArea.focus();
      textArea.setSelectionRange(length, length);
    }
  }, []);

  /** `ask` refuses to send while another response is streaming and reports it by
   *  returning false. Closing the editor regardless would throw the draft away for
   *  a rerun that never started, so a refused send leaves the editor as it was. */
  const resubmitMessage = (data: { text: string }) => {
    const submitted = ask(
      {
        text: data.text,
        parentMessageId,
        conversationId,
      },
      {
        overrideFiles: editedFiles,
        /** Pills on the edited user message stay visible after save-and-submit;
         *  carry the picks forward so the new turn primes the same skills
         *  instead of running unprimed. */
        overrideManualSkills: message.manualSkills,
        /** Carry the edited user message's quoted excerpts forward so the new
         *  turn sends the same referenced context the pills still show. */
        overrideQuotes: message.quotes,
        addedConvo: getAddedConvo() || undefined,
      },
    );

    if (submitted === false) {
      return;
    }

    setSiblingIdx((siblingIdx ?? 0) - 1);
    enterEdit(true);
  };

  /** No draft reaches the submission: `editedContent` is index-addressed over a content
   *  array and this editor only opens on messages that have none, so a text edit has
   *  nothing to target. Rerunning an answer is therefore a plain regeneration, the same
   *  one the hover action sends, which is why the draft neither gates this nor is
   *  offered as an update. Deliberately NOT routed through `handleSubmit`: the field is
   *  required so Save cannot blank a response, and a response that is already empty (a
   *  cancellation before the first token) is exactly what needs rerunning. */
  const rerunResponse = () => {
    /** The same resolution the withheld button is gated on, so a rendered Rerun and
     *  the submission it runs cannot disagree about the turn being replayed. */
    const parentMessage = findRerunParent(getMessages(), parentMessageId);
    if (!parentMessage) {
      return;
    }
    const submitted = ask(
      { ...parentMessage },
      {
        isRegenerate: true,
        /** Name the response being regenerated. Without it the submission resolves the
         *  NEWEST answer for this turn, so rerunning an older sibling prunes the wrong
         *  subtree from the optimistic thread. */
        targetResponseMessageId: messageId,
        /** Replaying the parent user turn: keep its manual skills and quoted excerpts so
         *  the regenerated response is primed and given the same context as the first. */
        overrideManualSkills: parentMessage.manualSkills,
        overrideQuotes: parentMessage.quotes,
        addedConvo: getAddedConvo() || undefined,
      },
    );

    if (submitted === false) {
      return;
    }

    /** The new answer is a sibling of this one, not of the user turn `siblingIdx` walks,
     *  so the index stays put and the thread follows the appended child. */
    enterEdit(true);
  };

  const updateMessage = async (data: { text: string }) => {
    setSaveError(false);
    try {
      await updateMessageMutation.mutateAsync({
        conversationId: conversationId ?? '',
        model: conversation?.model ?? 'gpt-3.5-turbo',
        text: data.text,
        messageId,
      });

      /** Read the thread after the request, not before it. An earlier turn stays
       *  editable while the newest answer streams, so a snapshot taken before the
       *  round trip is already behind by the time it would be written back, and
       *  writing it wholesale would drop every delta that landed in between. */
      const messages = getMessages();
      if (!messages) {
        enterEdit(true);
        return;
      }

      const isInMessages = messages.some(
        (currentMessage) => currentMessage.messageId === messageId,
      );
      if (!isInMessages) {
        message.text = data.text;
      } else {
        setMessages(
          messages.map((msg) =>
            msg.messageId === messageId
              ? {
                  ...msg,
                  text: data.text,
                }
              : msg,
          ),
        );
      }

      enterEdit(true);
    } catch {
      setSaveError(true);
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitButtonRef.current?.click();
      }
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveButtonRef.current?.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        enterEdit(true);
      }
    },
    [enterEdit],
  );

  const { ref, ...registerProps } = register('text', {
    /** Retained attachments make an otherwise empty edit submittable, matching
     *  the composer; `ask` replays them through `overrideFiles`. */
    required: (editedFiles?.length ?? 0) === 0,
    onChange: (e) => {
      setValue('text', e.target.value, { shouldDirty: true, shouldValidate: true });
    },
  });

  /** The footer carries one status line, so it reports the most actionable state:
   *  an unsaved draft first, because Cancel discards it, then why the footer offers
   *  no rerun — the question a Save-only editor otherwise leaves unanswered. */
  const getStatusMessage = () => {
    if (isDirty) {
      return localize(
        isUserTurn || !canRerun ? 'com_ui_unsaved_changes' : 'com_ui_rerun_discards_changes',
      );
    }
    if (!canRerun) {
      return localize('com_ui_rerun_needs_user_turn');
    }
    return '';
  };

  return (
    <Container message={message}>
      <section
        aria-label={localize('com_ui_edit_message')}
        className="mt-2 flex w-full flex-col gap-2"
      >
        {saveError && <Alert variant="error">{localize('com_ui_save_message_error')}</Alert>}
        {editedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="message-editor-files">
            {editedFiles.map((file, idx) => (
              <span
                key={`${file.file_id ?? file.filename}-${idx}`}
                className="flex items-center gap-1.5 rounded-lg border border-border-medium bg-surface-tertiary-alt px-2 py-1 text-xs text-text-primary"
              >
                <span
                  className="max-w-48 truncate"
                  title={file.filename ?? file.file_id ?? undefined}
                >
                  {file.filename ?? file.file_id ?? file.type ?? 'file'}
                </span>
                <button
                  type="button"
                  aria-label={localize('com_ui_delete')}
                  disabled={isSubmitting || updateMessageMutation.isLoading}
                  className="shrink-0 rounded-full text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                  onClick={() =>
                    setEditedFiles((files) => files.filter((_, current) => current !== idx))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <TextareaAutosize
          {...registerProps}
          ref={(e) => {
            ref(e);
            textAreaRef.current = e;
          }}
          onKeyDown={handleKeyDown}
          data-testid="message-text-editor"
          className={cn(
            'message-editor-text max-h-[65vh] min-h-24 w-full resize-y whitespace-pre-wrap',
            'break-words rounded-lg border border-border-medium bg-surface-tertiary-alt',
            'px-3 py-2 text-text-primary',
            'focus-visible:outline-none',
            isRTL ? 'text-right' : 'text-left',
            'disabled:opacity-50 md:max-h-[75vh]',
          )}
          aria-label={localize('com_ui_message_input')}
          aria-keyshortcuts={
            canRerun
              ? 'Control+Enter Meta+Enter Control+S Meta+S Escape'
              : 'Control+S Meta+S Escape'
          }
          disabled={isSubmitting || updateMessageMutation.isLoading}
          dir={isRTL ? 'rtl' : 'ltr'}
        />
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
            <Button
              size="sm"
              variant="outline"
              onClick={() => enterEdit(true)}
              disabled={updateMessageMutation.isLoading}
            >
              {localize('com_ui_cancel')}
            </Button>
            <Button
              ref={saveButtonRef}
              size="sm"
              variant="outline"
              disabled={isSubmitting || updateMessageMutation.isLoading || !isDirty || !isValid}
              onClick={handleSubmit(updateMessage)}
            >
              {updateMessageMutation.isLoading
                ? localize('com_ui_saving')
                : localize('com_ui_save')}
            </Button>
            {/* A rerun with no edits is a first-class action, not a mistake: a cancelled
                or failed response, or a backend restarted on different parameters, has
                to be reissued byte-for-byte. Validity gates only an edited USER draft,
                which is the one that becomes the submission: a pristine draft is the
                persisted message, already submittable by construction, `isValid` is
                false for a tick after mount while the form's first validation pass
                settles, and an answer's draft is never sent at all. */}
            {canRerun && (
              <Button
                ref={submitButtonRef}
                size="sm"
                variant="submit"
                disabled={
                  isSubmitting ||
                  updateMessageMutation.isLoading ||
                  (isUserTurn && isDirty && !isValid)
                }
                onClick={isUserTurn ? handleSubmit(resubmitMessage) : rerunResponse}
              >
                {isDirty && isUserTurn ? localize('com_ui_update_rerun') : localize('com_ui_rerun')}
              </Button>
            )}
          </div>
        </footer>
      </section>
    </Container>
  );
};

export default EditMessage;
