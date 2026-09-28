import { useEffect, useRef, useCallback } from 'react';
import { v4 } from 'uuid';
import debounce from 'lodash/debounce';
import { useToastContext } from '@librechat/client';
import { useRecoilValue, useRecoilState } from 'recoil';
import { Constants, EToolResources, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TEndpointOption } from 'librechat-data-provider';
import type { KeyboardEvent } from 'react';
import type { UploadLifecycleCallbacks } from '~/hooks/Files/useFileHandling';
import {
  forceResize,
  insertTextAtCursor,
  resolvePastedTextFile,
  getNewConversationDraftToken,
  getComposerDraftId,
  setPendingTextAttachmentDraft,
  removePendingTextAttachmentDraft,
  resolvePendingPasteInsertStart,
  addPastedTextDraftFile,
  isFilesDraftOwnedByThisTab,
  getFilesDraft,
  setDraft,
  markPastedTextFile,
  getEntityName,
  getEntity,
  checkIfScrollable,
} from '~/utils';
import { useAssistantsMapContext } from '~/Providers/AssistantsMapContext';
import { useLatestMessageMeta } from '~/hooks/Messages/useLatestMessage';
import { useChatFormContext, useUploadModalContext } from '~/Providers';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import useFileUploadRouter from '~/hooks/Files/useFileUploadRouter';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import useGetSender from '~/hooks/Conversations/useGetSender';
import useUploadOptions from '~/hooks/Files/useUploadOptions';
import { useInteractionHealthCheck } from '~/data-provider';
import { resolveComposerKeyDown } from '~/utils/shortcuts';
import { useChatContext } from '~/Providers/ChatContext';
import { globalAudioId } from '~/common';
import { useLocalize } from '~/hooks';
import store from '~/store';

type KeyEvent = KeyboardEvent<HTMLTextAreaElement>;

export default function useTextarea({
  textAreaRef,
  submitButtonRef,
  setIsScrollable,
  disabled = false,
  placeholder,
  allowSubmitWhileGenerating = false,
  onDuringRunModifier,
  answerModeActive = false,
}: {
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  submitButtonRef: React.RefObject<HTMLButtonElement>;
  setIsScrollable: React.Dispatch<React.SetStateAction<boolean>>;
  disabled?: boolean;
  placeholder?: string;
  /** Lets Enter submit during a run (during-run steering/queuing routes it). */
  allowSubmitWhileGenerating?: boolean;
  /** During-run modifier chords: ⌘/Ctrl+Enter = the non-default action,
   *  ⌥/Alt+Enter = interrupt & send. Enter itself submits the default. */
  onDuringRunModifier?: (kind: 'other' | 'interrupt' | 'preempt') => void;
  /** Keeps pasted text inline while the composer is answering a paused question. */
  answerModeActive?: boolean;
}) {
  const localize = useLocalize();
  const getSender = useGetSender();
  const { setValue } = useChatFormContext();
  const isComposing = useRef(false);
  const agentsMap = useAgentsMapContext();
  const { showToast } = useToastContext();
  const {
    getOptions: getUploadOptions,
    uploadsDisabled,
    isConfigPending: isUploadConfigPending,
    isConfigResolved: isUploadConfigResolved,
    isUnifiedMode,
  } = useUploadOptions();
  const routeFiles = useFileUploadRouter();
  const { openModal } = useUploadModalContext();
  const assistantMap = useAssistantsMapContext();
  const checkHealth = useInteractionHealthCheck();
  const enterToSend = useRecoilValue(store.enterToSend);
  const saveDrafts = useRecoilValue(store.saveDrafts);
  const pasteLongTextAsFile = useRecoilValue(store.pasteLongTextAsFile);
  const { shortcutsEnabled, submitOverride, yieldedChords } = useComposerBindings();

  const { index, conversation, isSubmitting, files, setFilesLoading } = useChatContext();
  const conversationIdRef = useRef(conversation?.conversationId);
  conversationIdRef.current = conversation?.conversationId;
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;
  const answerModeActiveRef = useRef(answerModeActive);
  answerModeActiveRef.current = answerModeActive;
  /** Names handed to pastes that are still waiting on the shared upload queue, so a second
   * paste is numbered against them instead of colliding once the queue drains. */
  const reservedPasteFilenames = useRef<Set<string>>(new Set());
  const latestMessage = useLatestMessageMeta(index);
  const [activePrompt, setActivePrompt] = useRecoilState(store.activePromptByIndex(index));
  const [pendingComposerText, setPendingComposerText] = useRecoilState(
    store.pendingComposerTextByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  const { endpoint = '' } = conversation || {};
  const { entity, isAgent, isAssistant } = getEntity({
    endpoint,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });
  const entityName = entity?.name ?? '';

  const isNotAppendable =
    latestMessage?.error === true && latestMessage.isCreatedByUser === true && !isAssistant;
  // && (conversationId?.length ?? 0) > 6; // also ensures that we don't show the wrong placeholder

  const insertComposerText = useCallback(
    (text: string) => {
      const textarea = textAreaRef.current;
      if (!textarea) {
        return false;
      }

      const { value, selectionStart, selectionEnd } = textarea;
      const nextCursor = selectionStart + text.length;
      setValue('text', `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`, {
        shouldDirty: true,
        shouldValidate: true,
      });
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      forceResize(textarea);
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
      return true;
    },
    [setValue, textAreaRef],
  );

  useEffect(() => {
    const prompt = activePrompt ?? '';
    if (!prompt || !insertComposerText(prompt)) {
      return;
    }

    setActivePrompt(undefined);
  }, [activePrompt, insertComposerText, setActivePrompt]);

  /** Text a surface the user was leaving handed to THIS conversation (see
   *  `pendingComposerTextByConvoId`). It is drained once, on the first render
   *  where that conversation's composer exists, which is what lets it survive a
   *  navigation that resolves its record before moving the route. */
  useEffect(() => {
    const text = pendingComposerText ?? '';
    if (text === '' || !insertComposerText(text)) {
      return;
    }

    setPendingComposerText(undefined);
  }, [insertComposerText, pendingComposerText, setPendingComposerText]);

  useEffect(() => {
    const currentValue = textAreaRef.current?.value ?? '';
    if (currentValue) {
      return;
    }

    const getPlaceholderText = () => {
      if (disabled) {
        return localize('com_endpoint_config_placeholder');
      }
      const currentEndpoint = conversation?.endpoint ?? '';
      const currentAgentId = conversation?.agent_id ?? '';
      const currentAssistantId = conversation?.assistant_id ?? '';
      if (isAgent && (!currentAgentId || !agentsMap?.[currentAgentId])) {
        return localize('com_endpoint_agent_placeholder');
      } else if (
        isAssistant &&
        (!currentAssistantId || !assistantMap?.[currentEndpoint]?.[currentAssistantId])
      ) {
        return localize('com_endpoint_assistant_placeholder');
      }

      if (isNotAppendable) {
        return localize('com_endpoint_message_not_appendable');
      }

      if (placeholder) {
        return placeholder;
      }

      const sender =
        isAssistant || isAgent
          ? getEntityName({ name: entityName, isAgent, localize })
          : getSender(conversation as TEndpointOption);

      return `${localize('com_endpoint_message_new', {
        0: sender ? sender : localize('com_endpoint_ai'),
      })}`;
    };

    const placeholderText = getPlaceholderText();

    if (textAreaRef.current?.getAttribute('placeholder') === placeholderText) {
      return;
    }

    const setPlaceholder = () => {
      const placeholderText = getPlaceholderText();

      if (textAreaRef.current?.getAttribute('placeholder') !== placeholderText) {
        textAreaRef.current?.setAttribute('placeholder', placeholderText);
        forceResize(textAreaRef.current);
      }
    };

    const debouncedSetPlaceholder = debounce(setPlaceholder, 80);
    debouncedSetPlaceholder();

    return () => debouncedSetPlaceholder.cancel();
  }, [
    isAgent,
    localize,
    disabled,
    getSender,
    agentsMap,
    entityName,
    textAreaRef,
    isAssistant,
    assistantMap,
    conversation,
    latestMessage,
    isNotAppendable,
    placeholder,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyEvent) => {
      if (textAreaRef.current && checkIfScrollable(textAreaRef.current)) {
        const scrollable = checkIfScrollable(textAreaRef.current);
        scrollable && setIsScrollable(scrollable);
      }
      if (e.key === 'Enter' && isSubmitting && !allowSubmitWhileGenerating) {
        return;
      }

      checkHealth();

      // NOTE: isComposing and e.key behave differently in Safari compared to other browsers, forcing us to use e.keyCode instead
      const isComposingInput = isComposing.current || e.key === 'Process' || e.keyCode === 229;

      const action = resolveComposerKeyDown(e.nativeEvent, {
        isComposing: isComposingInput,
        isSubmitting,
        allowSubmitWhileGenerating,
        hasDuringRunModifier: onDuringRunModifier != null,
        shortcutsEnabled,
        enterToSend,
        submitOverride,
        yieldedChords,
      });

      if (action === 'none') {
        return;
      }
      e.preventDefault();
      if (action === 'interrupt' || action === 'preempt' || action === 'other') {
        onDuringRunModifier?.(action);
        return;
      }
      if (action === 'newline' && textAreaRef.current) {
        insertTextAtCursor(textAreaRef.current, '\n');
        forceResize(textAreaRef.current);
        return;
      }
      if (action !== 'submit') {
        return;
      }
      const globalAudio = document.getElementById(globalAudioId) as HTMLAudioElement | undefined;
      if (globalAudio) {
        console.log('Unmuting global audio');
        globalAudio.muted = false;
      }
      submitButtonRef.current?.click();
    },
    [
      isSubmitting,
      allowSubmitWhileGenerating,
      onDuringRunModifier,
      shortcutsEnabled,
      yieldedChords,
      checkHealth,
      enterToSend,
      submitOverride,
      setIsScrollable,
      textAreaRef,
      submitButtonRef,
    ],
  );

  const handleCompositionStart = () => {
    isComposing.current = true;
  };

  const handleCompositionEnd = () => {
    isComposing.current = false;
  };

  /**
   * Sends clipboard-derived files to their upload destination, prompting when several are
   * viable. `preferred` skips that prompt when the caller already knows the intent.
   */
  const routeClipboardFiles = useCallback(
    async (
      clipboardFiles: File[],
      preferred?: EToolResources,
      uploadLifecycle?: UploadLifecycleCallbacks,
    ): Promise<boolean> => {
      setFilesLoading(true);

      const upload = async (destination?: EToolResources): Promise<boolean> => {
        /** Held until the upload is accepted so a rejected file (a duplicate, an oversized one)
         * reports only its own error instead of pairing it with a success message. */
        const accepted = await routeFiles(clipboardFiles, destination, uploadLifecycle);
        if (accepted && destination === EToolResources.context) {
          showToast({ message: localize('com_ui_file_attached_as_text'), status: 'info' });
        }
        return accepted;
      };

      try {
        /** Assistants use their own upload path; bypass option resolution like drag-and-drop does */
        if (isAssistantsEndpoint(conversation?.endpoint)) {
          return await upload();
        }

        /* Unified mode decides the destination from the file itself, matching the drop
         * handler. A caller that already knows where the file belongs, as the long-text
         * paste does, still passes that through. */
        if (isUnifiedMode && preferred == null) {
          return await upload();
        }

        /* Before the config lands neither answer is safe, so the paste says so rather than
         * falling through to the chooser a unified deployment no longer shows. */
        if (preferred == null && !isUploadConfigResolved) {
          showToast({ message: localize('com_ui_attach_error_pending'), status: 'warning' });
          setFilesLoading(false);
          return false;
        }

        /** Resolving options reads the file config, so until that lands the list is empty for
         * reasons that have nothing to do with this file. A caller that already knows where the
         * file belongs hands it to the upload instead, which waits for the same config and
         * validates against it, rather than rejecting or re-routing on a stale answer here. */
        if (preferred != null && isUploadConfigPending) {
          return await upload(preferred);
        }

        const options = getUploadOptions(clipboardFiles);
        if (options.length === 0) {
          showToast({ message: localize('com_error_files_unsupported'), status: 'error' });
          setFilesLoading(false);
          return false;
        }

        const usePreferred = preferred != null && options.includes(preferred);
        if (!usePreferred && options.length > 1) {
          setFilesLoading(false);
          openModal(clipboardFiles);
          return false;
        }

        return await upload(usePreferred ? preferred : options[0]);
      } catch (error) {
        console.error('clipboard file routing error', error);
        setFilesLoading(false);
        return false;
      }
    },
    [
      localize,
      showToast,
      openModal,
      routeFiles,
      conversation,
      setFilesLoading,
      getUploadOptions,
      isUploadConfigPending,
      isUploadConfigResolved,
      isUnifiedMode,
    ],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const textArea = textAreaRef.current;
      if (!textArea) {
        return;
      }

      const clipboardData = e.clipboardData as DataTransfer | undefined;
      if (!clipboardData) {
        return;
      }

      if (clipboardData.files.length > 0) {
        const timestampedFiles: File[] = [];
        for (const file of clipboardData.files) {
          const newFile = new File([file], `clipboard_${+new Date()}_${file.name}`, {
            type: file.type,
          });
          timestampedFiles.push(newFile);
        }

        if (uploadsDisabled) {
          showToast({ message: localize('com_ui_attach_error_disabled'), status: 'error' });
          return;
        }

        void routeClipboardFiles(timestampedFiles);
        return;
      }

      if (answerModeActive) {
        return;
      }

      const attachedFilenames = new Set(reservedPasteFilenames.current);
      for (const attached of files.values()) {
        attachedFilenames.add(attached.file?.name ?? attached.filename ?? '');
      }

      const pastedText = clipboardData.getData('text/plain');
      const attachment = resolvePastedTextFile(pastedText, {
        enabled: pasteLongTextAsFile,
        uploadsDisabled,
        isAssistants: isAssistantsEndpoint(conversation?.endpoint),
        attachedFilenames,
        configPending: isUploadConfigPending,
        getOptions: getUploadOptions,
      });
      if (!attachment) {
        return;
      }

      e.preventDefault();
      const pastedFilename = attachment.file.name;
      reservedPasteFilenames.current.add(pastedFilename);
      const conversationId = conversation?.conversationId;
      const draftId = getComposerDraftId(index, conversationId, isSubmitting);
      const draftToken = getNewConversationDraftToken(index);
      const selectionStart = textArea.selectionStart;
      const selectionEnd = textArea.selectionEnd;
      const replacedText =
        selectionStart === selectionEnd ? '' : textArea.value.slice(selectionStart, selectionEnd);
      if (selectionStart !== selectionEnd) {
        textArea.setRangeText('', selectionStart, selectionEnd, 'end');
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
        forceResize(textArea);
      }
      const composerValue = textArea.value;
      const pendingFileId = v4();
      markPastedTextFile(pendingFileId);
      /** Another open tab can hold this shared key against files it still has attached, and
       * `setFilesDraft` keeps that owner rather than rejecting the write: recording this paste
       * there would hand it to a composer that never made it, which could then restore the
       * upload and delete it through New Chat while this tab still shows the chip. */
      if (saveDrafts && isFilesDraftOwnedByThisTab(getFilesDraft(draftId))) {
        addPastedTextDraftFile({ id: draftId, fileId: pendingFileId });
        try {
          setDraft({ id: draftId, value: composerValue });
          setPendingTextAttachmentDraft({
            id: draftId,
            fileId: pendingFileId,
            text: pastedText,
            selectionStart,
            selectionEnd,
            replacedText,
            replacedApplied: true,
            anchorBefore: composerValue.slice(0, selectionStart),
            anchorAfter: composerValue.slice(selectionStart),
          });
        } catch {
          // Persistence must not prevent the generated attachment from uploading.
        }
      }
      const restorePaste = (target: HTMLTextAreaElement, insertStart: number) => {
        target.setSelectionRange(insertStart, insertStart);
        insertTextAtCursor(target, pastedText);
        forceResize(target);
      };
      /** The composer that owns this paste: same conversation, same unsaved-chat identity. */
      const isOriginatingComposer = (): boolean =>
        conversationIdRef.current === conversationId &&
        getNewConversationDraftToken(index) === draftToken;
      /** Whether a durable copy of this paste exists. When one does, a composer the user has
       * since typed into is deliberately left alone: the record recovers at an anchored offset on
       * the next restore, and inserting here as well would fight that. */
      const hasPersistedPasteRecovery = (fileId: string): boolean => {
        if (!saveDrafts) {
          return false;
        }
        const { pendingPastes } = getFilesDraft(draftId);
        return pendingPastes[fileId] != null || pendingPastes[pendingFileId] != null;
      };
      const restorePasteAfterUploadFailure = (fileId: string): boolean => {
        const currentTextArea = textAreaRef.current;
        if (!currentTextArea || answerModeActiveRef.current || !isOriginatingComposer()) {
          return false;
        }
        const composerUnchanged = currentTextArea.value === composerValue;
        if (!composerUnchanged && hasPersistedPasteRecovery(fileId)) {
          return false;
        }
        /** Nothing durable to fall back on: the shared draft key belongs to another tab, or drafts
         * are off, so this callback holds the only copy of the paste left. Dropping it because the
         * composer moved on would lose it outright, so it goes back in at the offset its anchors
         * resolve to, which is where a restore from a record would have put it. */
        restorePaste(
          currentTextArea,
          composerUnchanged
            ? selectionStart
            : resolvePendingPasteInsertStart(currentTextArea.value, {
                text: pastedText,
                selectionStart,
                selectionEnd,
                replacedText,
                replacedApplied: true,
                anchorBefore: composerValue.slice(0, selectionStart),
                anchorAfter: composerValue.slice(selectionStart),
              }),
        );
        if (saveDrafts) {
          setDraft({
            id: getComposerDraftId(index, conversationIdRef.current, isSubmittingRef.current),
            value: currentTextArea.value,
          });
        }
        return true;
      };
      const clearPendingPasteDraft = (fileId: string, removeFile = false) => {
        if (!saveDrafts) {
          return;
        }
        removePendingTextAttachmentDraft({ id: draftId, fileId, removeFile });
        const currentDraftId = getComposerDraftId(
          index,
          conversationIdRef.current,
          isSubmittingRef.current,
        );
        if (currentDraftId !== draftId) {
          removePendingTextAttachmentDraft({ id: currentDraftId, fileId, removeFile });
        }
      };
      const uploadLifecycle: UploadLifecycleCallbacks = {
        fileId: pendingFileId,
        shouldCommit: isOriginatingComposer,
        onStart: (fileId) => {
          markPastedTextFile(fileId);
          if (
            !saveDrafts ||
            fileId === pendingFileId ||
            !isFilesDraftOwnedByThisTab(getFilesDraft(draftId))
          ) {
            return;
          }
          try {
            addPastedTextDraftFile({ id: draftId, fileId });
            removePendingTextAttachmentDraft({
              id: draftId,
              fileId: pendingFileId,
              removeFile: true,
            });
            setPendingTextAttachmentDraft({
              id: draftId,
              fileId,
              text: pastedText,
              selectionStart,
              selectionEnd,
              replacedText,
              replacedApplied: true,
              anchorBefore: composerValue.slice(0, selectionStart),
              anchorAfter: composerValue.slice(selectionStart),
            });
          } catch {
            // Keep the upload going if durable recovery cannot be written.
          }
        },
        onSuccess: (fileId) => {
          clearPendingPasteDraft(fileId);
        },
        onError: (fileId) => {
          const restored = restorePasteAfterUploadFailure(fileId);
          if (restored || getNewConversationDraftToken(index) !== draftToken) {
            clearPendingPasteDraft(fileId, true);
          }
        },
        onAbort: (fileId) => {
          clearPendingPasteDraft(fileId, true);
        },
      };
      void routeClipboardFiles([attachment.file], attachment.toolResource, uploadLifecycle).then(
        (accepted) => {
          /** The name is either attached now or was never taken, so stop reserving it. */
          reservedPasteFilenames.current.delete(pastedFilename);
          if (!accepted) {
            const restored = restorePasteAfterUploadFailure(pendingFileId);
            if (restored || getNewConversationDraftToken(index) !== draftToken) {
              clearPendingPasteDraft(pendingFileId, true);
            }
          }
        },
      );
    },
    [
      files,
      localize,
      showToast,
      conversation,
      index,
      textAreaRef,
      uploadsDisabled,
      getUploadOptions,
      pasteLongTextAsFile,
      routeClipboardFiles,
      isUploadConfigPending,
      answerModeActive,
      isSubmitting,
      saveDrafts,
    ],
  );

  return {
    textAreaRef,
    handlePaste,
    handleKeyDown,
    isNotAppendable,
    handleCompositionEnd,
    handleCompositionStart,
  };
}
