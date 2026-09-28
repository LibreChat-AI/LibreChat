import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import debounce from 'lodash/debounce';
import { Constants } from 'librechat-data-provider';
import { SetterOrUpdater, useRecoilValue } from 'recoil';
import type { TFile } from 'librechat-data-provider';
import type { PendingTextAttachmentDraft } from '~/utils';
import type { ExtendedFile } from '~/common';
import {
  applyPendingPastesToDraft,
  clearDraft,
  clearAllDrafts,
  getDraft,
  getFilesDraft,
  getNewConversationDraftId,
  getPendingDraftId,
  isAskAnswerDraftId,
  isFilesDraftOwnedByThisTab,
  isNewConversationDraftId,
  mayWriteComposerText,
  migrateFilesDraft,
  migrateTextDraft,
  publishTabAttachmentIds,
  setDraft,
  setFilesDraft,
} from '~/utils';
import { isPastedTextFileMarked, markPastedTextFile } from '~/utils/files';
import { hasInFlightUpload } from '~/hooks/Files/useFileHandling';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import store from '~/store';

export const useAutoSave = ({
  index = 0,
  isSubmitting,
  conversationId: _conversationId,
  draftId,
  textAreaRef,
  setFiles,
  files,
}: {
  index?: number;
  isSubmitting?: boolean;
  conversationId?: string | null;
  /** Explicit draft-key override: wins over the conversation id AND the
   *  PENDING_CONVO redirect. Set while an `ask_user_question` pause turns the
   *  composer into the answer box: the answer phase drafts under its own key,
   *  and the key change itself drives the save/restore swap below, so the
   *  conversation draft is stashed on entry and restored when the question
   *  resolves. */
  draftId?: string | null;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
  files: Map<string, ExtendedFile>;
  setFiles: SetterOrUpdater<Map<string, ExtendedFile>>;
}) => {
  // setting for auto-save
  const { setValue } = useChatFormContext();
  const saveDrafts = useRecoilValue<boolean>(store.saveDrafts);
  const pendingDraftId = getPendingDraftId(index);
  const conversationDraftId =
    _conversationId === Constants.NEW_CONVO ? getNewConversationDraftId(index) : _conversationId;
  const conversationId = draftId ?? (isSubmitting ? pendingDraftId : conversationDraftId);

  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const fileIds = useMemo(() => Array.from(files.keys()), [files]);
  const { data: fileList } = useGetFiles<TFile[]>();
  const filesRef = useRef(files);
  filesRef.current = files;

  /** Publishes what this composer holds so cleanup running in another tab can see it. Not gated
   * on `saveDrafts`: with draft saving off nothing is persisted at all, which is exactly when a
   * reattached file would otherwise look like nobody's and be deleted by a retry elsewhere. */
  useEffect(() => {
    /** Every identity, not just the map key: a restored upload is keyed by its temporary id while
     * the value carries the server one, and a retained deletion in another tab names whichever of
     * those it recorded. Publishing one alias would leave the chip unprotected under the other. */
    const identities = new Set<string>();
    files.forEach((file, key) => {
      identities.add(key);
      if (file.file_id != null && file.file_id !== '') {
        identities.add(file.file_id);
      }
      if (file.temp_file_id != null && file.temp_file_id !== '') {
        identities.add(file.temp_file_id);
      }
    });
    publishTabAttachmentIds(index, Array.from(identities));
  }, [index, files]);

  const restoreFiles = useCallback(
    (id: string): PendingTextAttachmentDraft[] => {
      const filesDraft = getFilesDraft(id);

      /** Restoring adds what the draft holds; it never clears. The conversation
       * swap below owns that, and does it explicitly before calling here — while
       * the file-cache path runs on every `QueryKeys.files` write (an upload
       * landing, an SSE attachment during a run), where an empty draft means the
       * write has not caught up yet, not that the user has no attachments. */
      if (
        !isFilesDraftOwnedByThisTab(filesDraft) ||
        filesDraft.fileIds.length === 0 ||
        fileList == null
      ) {
        return [];
      }

      const activeFileIds = new Set(filesRef.current.keys());
      const fileIdsToKeep: string[] = [];
      const pendingPastes = { ...filesDraft.pendingPastes };
      const pastedTextIds = [...(filesDraft.pastedTextIds ?? [])];
      const pastesToRecover: PendingTextAttachmentDraft[] = [];

      // Retrieve files stored in localStorage from files in fileList and set them to `setFiles`
      // If a file is found with `temp_file_id`, use `temp_file_id` as a key in `setFiles`
      filesDraft.fileIds.forEach((fileId) => {
        const fileData = fileList?.find((f) => f.file_id === fileId);
        const tempFileData = fileList?.find((f) => f.temp_file_id === fileId);
        const { fileToRecover, fileIdToRecover } = fileData
          ? { fileToRecover: fileData, fileIdToRecover: fileId }
          : {
              fileToRecover: tempFileData,
              fileIdToRecover: (tempFileData?.temp_file_id ?? '') || fileId,
            };

        if (fileToRecover) {
          fileIdsToKeep.push(fileId);
          if (pendingPastes[fileId] != null && !pastedTextIds.includes(fileId)) {
            /** Consuming the paste record here, so its id moves to the persistent provenance
             * list: the text is no longer kept, but the chip must stay recognizable as a paste. */
            pastedTextIds.push(fileId);
          }
          if (pastedTextIds.includes(fileId)) {
            markPastedTextFile(fileToRecover.file_id);
          }
          delete pendingPastes[fileId];
          setFiles((currentFiles) => {
            const updatedFiles = new Map(currentFiles);
            /** The same entry may still be live in the composer — this path also
             * runs when the upload that created it writes the file cache. Layer
             * the persisted record over it instead of replacing it: the local
             * `File`, the blob preview the chip renders from, and the tool
             * resource the upload was staged under exist nowhere on the server
             * record, and `attached` decides whether removing the chip also
             * deletes the file, which a composer-owned upload still needs. */
            const live = updatedFiles.get(fileIdToRecover);
            updatedFiles.set(fileIdToRecover, {
              ...live,
              ...fileToRecover,
              preview: live?.preview ?? fileToRecover.preview,
              progress: 1,
              attached: live ? (live.attached ?? false) : true,
              size: fileToRecover.bytes,
            });
            return updatedFiles;
          });
          return;
        }

        const pendingPaste = pendingPastes[fileId];
        if (pendingPaste && !activeFileIds.has(fileId) && !hasInFlightUpload(fileId)) {
          pastesToRecover.push(pendingPaste);
          delete pendingPastes[fileId];
          return;
        }

        fileIdsToKeep.push(fileId);
      });

      const keptIdentities = new Set([...fileIdsToKeep, ...Object.keys(pendingPastes)]);
      setFilesDraft(id, {
        fileIds: fileIdsToKeep,
        pastedTextIds: pastedTextIds.filter((pastedId) => keptIdentities.has(pastedId)),
        pendingPastes,
      });
      return pastesToRecover;
    },
    [fileList, setFiles],
  );

  const restoreText = useCallback(
    (id: string, pendingPastes: PendingTextAttachmentDraft[] = []) => {
      const draftText = applyPendingPastesToDraft(getDraft(id) ?? '', pendingPastes);

      if (pendingPastes.length > 0) {
        setDraft({ id, value: draftText });
      }
      setValue('text', draftText);
    },
    [setValue],
  );

  const saveText = useCallback(
    (id: string) => {
      if (!textAreaRef?.current) {
        return;
      }
      // Save the draft of the current conversation before switching
      if (textAreaRef.current.value === '') {
        clearDraft(id);
      } else {
        setDraft({ id, value: textAreaRef.current.value });
      }
    },
    [textAreaRef],
  );
  /** The key this composer reads and writes right now. It is the conversation, except while the
   * switch effect has parked storage on the pending key because the destination is not writable.
   * `currentConversationId` alone will not do: it lags `conversationId` by a render on every
   * transition, so keying off it restored the previous conversation's draft into the composer,
   * which after a send put the just-sent attachment straight back as a chip. */
  const activeStorageId =
    currentConversationId === pendingDraftId ? pendingDraftId : conversationId;
  /** Only autosave knows whether a foreign tab kept this composer on the
   * pending key. Submission consumes that actual key under its ownership guard. */
  const consumeDraft = useCallback(() => {
    if (activeStorageId) {
      clearAllDrafts(activeStorageId);
    }
  }, [activeStorageId]);
  useEffect(() => {
    // This useEffect is responsible for setting up and cleaning up the auto-save functionality
    // for the text area input. It saves the text to localStorage with a debounce to prevent
    // excessive writes.
    const draftStorageId = activeStorageId;
    if (!saveDrafts || draftStorageId == null || draftStorageId === '') {
      return;
    }

    /** Saves the composer's value AT FLUSH TIME rather than the value captured
     * when the event fired. A during-run steer/queue consumes the text and
     * clears the composer programmatically, so a write still in flight would
     * otherwise land after the submit and restore the just-sent text. */
    const saveLatest = () =>
      setDraft({ id: draftStorageId, value: textAreaRef?.current?.value ?? '' });

    /** Use shorter debounce for saving text (25ms) to capture rapid typing */
    const handleInputFast = debounce(saveLatest, 25);

    /** Use longer debounce for clearing empty values (850ms) to prevent accidental clearing */
    const handleInputSlow = debounce(saveLatest, 850);

    const eventListener = (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      const value = target.value;

      /** Cancel any pending operations to avoid conflicts */
      handleInputFast.cancel();
      handleInputSlow.cancel();

      /** If empty, use long delay to prevent accidental clearing
       * Otherwise use short delay to capture rapid typing */
      if (value === '') {
        handleInputSlow();
      } else {
        handleInputFast();
      }
    };

    const textArea = textAreaRef?.current;
    if (textArea) {
      textArea.addEventListener('input', eventListener);
    }

    return () => {
      if (textArea) {
        textArea.removeEventListener('input', eventListener);
      }
      /** Land the write instead of dropping it. This runs whenever the draft key changes and when
       * the composer goes away, and a keystroke inside the debounce window has nothing else to
       * persist it: cancelling here is what tore the end off a message being typed as a run
       * finished, since the key moves from PENDING to the conversation at that moment and the
       * record left behind was one flush old. Flushing is safe for the case the cancel was
       * protecting — `saveLatest` reads the composer at flush time, so a steer that consumed the
       * text and emptied the composer flushes the emptiness, not the message it just sent. */
      handleInputFast.flush();
      handleInputSlow.flush();
    };
  }, [activeStorageId, saveDrafts, textAreaRef]);

  const prevConversationIdRef = useRef<string | null>(null);
  const pendingDestinationRef = useRef<string | null>(null);

  useEffect(() => {
    // This useEffect is responsible for saving the current conversation's draft and
    // restoring the new conversation's draft when switching between conversations.
    // It handles both text and file drafts, ensuring that the user's input is preserved
    // across different conversations.

    if (!saveDrafts || conversationId == null || conversationId === '') {
      return;
    }
    if (conversationId === currentConversationId) {
      return;
    }

    // clear attachment files when switching conversation
    setFiles(new Map());

    /** The key the attachments live under once the pending draft has been moved. A move that
     * storage refuses leaves them behind, and recovery has to read them where they still are. */
    let filesDraftId = conversationId;
    let textDraftId = conversationId;
    let nextConversationId = conversationId;

    try {
      // Check for transition from PENDING_CONVO to a valid conversationId.
      // An ask-answer key is excluded: it is a temporary overlay, not the
      // pending draft's destination. Migrating would delete the very draft
      // the answer-phase swap-back is supposed to restore.
      /** A reload reports no previous key, so the pending draft has to be able to speak for
       * itself: this is only the awaited transition when this tab actually owns a pending record
       * that still holds something. Treating any first mount as the transition put an ordinary
       * conversation on the pending key, which then restored a just-sent attachment back into the
       * composer. */
      const pendingDraftRecord = getFilesDraft(pendingDraftId);
      const pendingDraftHasContent =
        isFilesDraftOwnedByThisTab(pendingDraftRecord) &&
        (pendingDraftRecord.fileIds.length > 0 ||
          Object.keys(pendingDraftRecord.pendingPastes).length > 0 ||
          (getDraft(pendingDraftId) ?? '') !== '');
      const pendingDestination = pendingDestinationRef.current;
      const pendingStorageActive =
        (prevConversationIdRef.current === pendingDraftId ||
          currentConversationId === pendingDraftId ||
          (currentConversationId == null && pendingDraftHasContent) ||
          pendingDestination === conversationId) &&
        (pendingDestination == null || pendingDestination === conversationId);
      if (
        pendingStorageActive &&
        conversationId !== pendingDraftId &&
        !isAskAnswerDraftId(conversationId) &&
        !isNewConversationDraftId(conversationId) &&
        conversationId.length > 3
      ) {
        /** Two tabs running at once share the default pending key, so the record here may be
         * another tab's: migrating first and checking ownership afterwards moved that tab's text
         * and attachments under this conversation and left it nothing to carry over when its own
         * run finished. This composer's text moves to the conversation only when that key is
         * writable; otherwise the pending key remains the active storage location. */
        /** The destination has to be writable too: another tab viewing this same conversation can
         * own its draft with attachments still on screen, and migrating over it would delete that
         * record and restamp the owner. */
        const pendingOwned = isFilesDraftOwnedByThisTab(getFilesDraft(pendingDraftId));
        const destinationOwned = isFilesDraftOwnedByThisTab(getFilesDraft(conversationId));
        const destinationWritable = destinationOwned && mayWriteComposerText(conversationId);
        if (pendingOwned && !destinationWritable) {
          /** Ours to move but nowhere to move it to. Keep both the draft and the active storage key
           * on the pending id until the destination can be written without clobbering its owner. */
          pendingDestinationRef.current = conversationId;
          filesDraftId = pendingDraftId;
          textDraftId = pendingDraftId;
          nextConversationId = pendingDraftId;
        } else if (pendingOwned) {
          pendingDestinationRef.current = null;
          /** Move the pending text draft to the new conversationId, then let the composer correct
           * it. Both describe the same composer and the record is a debounced copy of it, so when
           * they disagree the record is simply older, and restoring it would roll the user's last
           * keystrokes back mid-sentence. An empty composer defers to the record instead: a steer
           * consumes the text and clears the composer programmatically, and run end must not undo that. */
          migrateTextDraft(pendingDraftId, conversationId);
          const liveText = textAreaRef?.current?.value ?? '';
          if (liveText !== '' && getDraft(conversationId) !== liveText) {
            setDraft({ id: conversationId, value: liveText });
          }
          filesDraftId = migrateFilesDraft(pendingDraftId, conversationId);
        } else {
          if (textAreaRef?.current?.value) {
            setDraft({ id: conversationId, value: textAreaRef.current.value });
          }
          /** Nothing is taken from the record, but this tab's own queued attachments still have
           * to survive the switch. The map is cleared at the top of this effect, so persist them
           * under the destination when it is writable and restore the live map otherwise. */
          const liveFileIds = Array.from(filesRef.current.keys());
          if (liveFileIds.length > 0 && destinationOwned) {
            /** Provenance travels with them, or the restored chips stop being recognised as
             * pastes and lose both editing and New Chat cleanup. It is rebuilt from the session
             * registry rather than the foreign record, which is not ours to read. The unsent
             * paste text cannot come along: this tab was refused the pending key all run, so it
             * was never written anywhere to carry. */
            setFilesDraft(conversationId, {
              fileIds: liveFileIds,
              pendingPastes: {},
              pastedTextIds: liveFileIds.filter((fileId) => isPastedTextFileMarked(fileId)),
            });
          } else if (liveFileIds.length > 0) {
            /** Neither shared key is writable by this tab. The live map is the only copy of these
             * queued attachments, so restore it after the unconditional switch clear rather than
             * dropping it. */
            setFiles(filesRef.current);
          }
        }
      } else if (currentConversationId != null && currentConversationId) {
        saveText(currentConversationId);
      }

      if (isFilesDraftOwnedByThisTab(getFilesDraft(filesDraftId))) {
        const pendingPastes = restoreFiles(filesDraftId);
        restoreText(textDraftId, pendingPastes);
      }
    } catch (e) {
      console.error(e);
    }

    prevConversationIdRef.current = nextConversationId;
    setCurrentConversationId(nextConversationId);
  }, [
    currentConversationId,
    conversationId,
    pendingDraftId,
    restoreFiles,
    textAreaRef,
    restoreText,
    saveDrafts,
    saveText,
    setFiles,
  ]);

  useEffect(() => {
    const draftStorageId = activeStorageId;
    if (!saveDrafts || draftStorageId == null || draftStorageId === '' || fileList == null) {
      return;
    }

    const pendingPastes = restoreFiles(draftStorageId);
    if (pendingPastes.length > 0) {
      restoreText(draftStorageId, pendingPastes);
    }
  }, [activeStorageId, fileList, restoreFiles, restoreText, saveDrafts]);

  useEffect(() => {
    // This useEffect is responsible for saving or removing the current conversation's file drafts
    // in localStorage whenever the file attachments change.
    // It ensures that the file drafts are kept up-to-date and can be restored
    // when the conversation is revisited.
    const draftStorageId = currentConversationId ?? conversationId;

    if (!saveDrafts || draftStorageId == null || draftStorageId === '') {
      return;
    }

    const existingDraft = getFilesDraft(draftStorageId);
    if (!isFilesDraftOwnedByThisTab(existingDraft)) {
      return;
    }
    const pendingFileIds = Object.keys(existingDraft.pendingPastes);
    const draftFileIds = [
      ...fileIds,
      ...pendingFileIds.filter((fileId) => !fileIds.includes(fileId)),
    ];
    const liveIds = new Set(draftFileIds);
    files.forEach((file, key) => {
      liveIds.add(key);
      if (file.file_id != null) {
        liveIds.add(file.file_id);
      }
      if (file.temp_file_id != null && file.temp_file_id !== '') {
        liveIds.add(file.temp_file_id);
      }
    });
    /** Provenance is rebuilt, not just filtered. A paste queued during a run has its pending
     * draft taken by `takeComposerDraft`, so choosing Edit message later restores the upload into
     * an otherwise empty composer with nothing recording that it was ever a generated paste.
     * Filtering alone left it unmarked, and an unmarked restored chip is treated as a shared
     * attachment: removing it would not delete it and New Chat would skip it, so the unsent upload
     * was orphaned. The session registry still knows, so it is asked. */
    const pastedTextIds = (existingDraft.pastedTextIds ?? []).filter((id) => liveIds.has(id));
    const claimed = new Set(pastedTextIds);
    for (const id of liveIds) {
      if (!claimed.has(id) && isPastedTextFileMarked(id)) {
        pastedTextIds.push(id);
        claimed.add(id);
      }
    }
    setFilesDraft(draftStorageId, {
      fileIds: draftFileIds,
      pastedTextIds,
      pendingPastes: existingDraft.pendingPastes,
    });
  }, [conversationId, saveDrafts, currentConversationId, fileIds, files]);

  return consumeDraft;
};
