import { useState, useCallback, useRef } from 'react';
import { v4 } from 'uuid';
import { useToastContext } from '@librechat/client';
import {
  dataService,
  EToolResources,
  FileSources,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import {
  addPastedTextDraftFile,
  collectForeignAttachmentClaims,
  failedFileIdsFrom,
  forceResize,
  isFilesDraftOwnedByThisTab,
  isPasteSubmitted,
  getComposerDraftId,
  getFilesDraftCached,
  markPastedTextFile,
  nextPastedTextFilename,
  removePendingTextAttachmentDraft,
  removeTabAttachmentPresence,
  retainFileDeletion,
} from '~/utils';
import { useDeleteFilesMutation, useGetFiles } from '~/data-provider';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { useChatContext, useChatFormContext } from '~/Providers';
import useFileUploadRouter from './useFileUploadRouter';
import { getNewConversationDraftToken } from '~/utils';
import { useAuthContext } from '~/hooks/AuthContext';
import useFileDeletion from './useFileDeletion';
import { useLocalize } from '~/hooks';

/** The attachment being edited, with its text already resolved so the dialog stays controlled. */
export type PastedTextEdit = {
  file: ExtendedFile;
  text: string;
  /** The composer the dialog was opened in; an edit must never apply to a different one. */
  conversationId: string | null;
  /** Distinguishes two successive unsaved chats, which share the `new` conversation id. */
  draftToken: symbol;
};

/**
 * Backs the paste editor: resolves an attached `pasted-text.txt` back to the text it holds, and
 * applies an edit either as a replacement attachment or by returning the text to the composer.
 */
export default function usePastedTextEdit({
  index = 0,
  files,
  setFiles,
  textAreaRef,
}: {
  index?: number;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { user } = useAuthContext();
  const { conversation, isSubmitting } = useChatContext();
  const methods = useChatFormContext();
  const routeFiles = useFileUploadRouter();
  const { data: fileList } = useGetFiles<TFile[]>();
  const { saveDrafts } = useChatSettings();
  const [editing, setEditing] = useState<PastedTextEdit | null>(null);
  /** Failed edits that could not reopen their dialog because another chip was open. Their
   * corrections have no other owner, so they wait for the dialog to free up. */
  const [failedEdits, setFailedEdits] = useState<PastedTextEdit[]>([]);
  /** Source attachments with a replacement upload or inline move in flight; a second action
   * against the same original would double-replace or double-insert it. */
  const [pendingActionIds, setPendingActionIds] = useState<Set<string>>(new Set());

  const { mutateAsync } = useDeleteFilesMutation();
  const { deleteFile } = useFileDeletion({ mutateAsync });

  const conversationId = conversation?.conversationId ?? null;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  /** Async resolves must re-check the composer against its current state, not the render the
   * callback was captured on. */
  const filesRef = useRef(files);
  filesRef.current = files;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** Sequence of editor-open requests, so a slow resolve cannot overwrite a later click. */
  const openRequestRef = useRef(0);
  /** Synchronous lock for in-flight edit/move actions. React state lags a render behind, so two
   * clicks in the same turn would both observe an empty set and double-insert the paste. */
  const pendingActionIdsRef = useRef<Set<string>>(new Set());

  /** The dialog belongs to the composer it was opened in. Switching conversation or starting a
   * new chat retires it: saving from the new composer would detach that conversation's file and
   * upload the replacement into it. Reset on the render that observes the change. */
  if (
    editing != null &&
    (editing.conversationId !== conversationId ||
      editing.draftToken !== getNewConversationDraftToken(index))
  ) {
    setEditing(null);
  }
  if (editing == null && failedEdits.length > 0) {
    setEditing(failedEdits[0]);
    setFailedEdits((queue) => queue.slice(1));
  }

  /** The in-memory blob is the only current copy right after an edit; the file record is the
   * only copy left once the composer was rebuilt from a draft. */
  const resolveText = useCallback(
    async (file: ExtendedFile): Promise<string | null> => {
      if (file.file != null) {
        try {
          return await file.file.text();
        } catch {
          // Fall through to the stored copy rather than failing the open.
        }
      }
      const stored = fileList?.find((entry) => entry.file_id === file.file_id)?.text;
      if (stored != null && stored !== '') {
        return stored;
      }
      /** Assistants and agent uploads are persisted without a `text` field, so a paste restored
       * from a draft has no copy in memory or on its record; the stored bytes are the only
       * remaining source. */
      if (user?.id != null && (file.type ?? '').startsWith('text/')) {
        try {
          const response = await dataService.getFileDownload(user.id, file.file_id);
          const downloaded = await response.data.text();
          if (downloaded !== '') {
            return downloaded;
          }
        } catch {
          // Unreadable bytes leave the affordance to report the text as missing.
        }
      }
      return null;
    },
    [fileList, user?.id],
  );

  /** Whether a file is still one of this composer's unsent chips. The map is not always keyed by
   * the file's own id: a restored entry keeps its temporary upload id as the key while the value
   * carries the server-assigned one, so every identity is matched against keys and values. */
  const isAttachedToComposer = useCallback((file: ExtendedFile): boolean => {
    const identities = new Set([file.file_id]);
    if (file.temp_file_id != null && file.temp_file_id !== '') {
      identities.add(file.temp_file_id);
    }
    for (const [key, entry] of filesRef.current) {
      if (identities.has(key)) {
        return true;
      }
      if (
        (entry.file_id != null && identities.has(entry.file_id)) ||
        (entry.temp_file_id != null && identities.has(entry.temp_file_id))
      ) {
        return true;
      }
    }
    return false;
  }, []);

  const isOpenStale = useCallback(
    (
      request: number,
      conversationIdAtOpen: string | null,
      draftTokenAtOpen: symbol,
      file: ExtendedFile,
    ) =>
      openRequestRef.current !== request ||
      conversationIdRef.current !== conversationIdAtOpen ||
      getNewConversationDraftToken(index) !== draftTokenAtOpen ||
      !isAttachedToComposer(file),
    [index, isAttachedToComposer],
  );

  const openEditor = useCallback(
    async (file: ExtendedFile) => {
      /** A replacement for this chip is already in flight; acting on it again would
       * double-replace the same original. */
      if (pendingActionIdsRef.current.has(file.file_id)) {
        return;
      }
      const conversationIdAtOpen = conversationIdRef.current;
      const draftTokenAtOpen = getNewConversationDraftToken(index);
      /** Restored chips resolve asynchronously; a later click on another chip must not be
       * overwritten by an earlier, slower resolution. */
      const request = ++openRequestRef.current;
      const text = await resolveText(file);
      /** Stale checks first: a failed resolve for an earlier click must not toast after a
       * later chip opened, or after the original was sent / the conversation was left. */
      if (isOpenStale(request, conversationIdAtOpen, draftTokenAtOpen, file)) {
        return;
      }
      if (text == null) {
        showToast({ message: localize('com_ui_pasted_text_unavailable'), status: 'error' });
        return;
      }
      setEditing({
        file,
        text,
        conversationId: conversationIdAtOpen,
        draftToken: draftTokenAtOpen,
      });
    },
    [resolveText, showToast, localize, index, isOpenStale],
  );

  const closeEditor = useCallback(() => setEditing(null), []);

  /** Removes the chip locally and schedules the upload's deletion. A paste restored from a
   * draft carries `attached: true`, which makes `deleteFile` keep the server record because a
   * restored file is normally shared. Foreign claims are checked before either path can schedule
   * deletion, because another tab or composer pane may still reference the upload. Both draft keys
   * are read, since a response finishing mid-edit migrates the record between them. */
  const detach = useCallback(
    (file: ExtendedFile) => {
      const restored = file.attached === true;
      const attachmentIds = [file.file_id, file.temp_file_id].filter(
        (id): id is string => id != null && id !== '',
      );
      const draftIds = [
        getComposerDraftId(index, conversationIdRef.current, isSubmitting),
        getComposerDraftId(index, conversationIdRef.current, !isSubmitting),
      ];
      const claimedElsewhere = collectForeignAttachmentClaims(draftIds, index);
      if (attachmentIds.some((id) => claimedElsewhere.has(id))) {
        removeTabAttachmentPresence(attachmentIds, index);
        setFiles((currentFiles) => {
          const updatedFiles = new Map(currentFiles);
          attachmentIds.forEach((id) => updatedFiles.delete(id));
          return updatedFiles;
        });
        return;
      }

      deleteFile({ file, setFiles });
      if (!restored || file.progress < 1) {
        return;
      }
      /** A submitted paste is still referenced by the message that consumed it. Stop and error
       * paths intentionally leave its draft provenance behind, so detaching a restored chip must
       * not mistake that stale claim for ownership and delete the server record. */
      if (attachmentIds.some((id) => isPasteSubmitted(id))) {
        return;
      }
      const draftOwned = [isSubmitting, !isSubmitting].some((submitting) => {
        const draft = getFilesDraftCached(
          getComposerDraftId(index, conversationIdRef.current, submitting),
        );
        if (!isFilesDraftOwnedByThisTab(draft)) {
          return false;
        }
        const claimed = draft.pastedTextIds ?? [];
        return attachmentIds.some((id) => claimed.includes(id));
      });
      if (draftOwned) {
        const deletion = {
          file_id: file.file_id,
          embedded: file.embedded ?? false,
          filepath: file.filepath ?? '',
          source: file.source ?? FileSources.local,
        };
        /** The chip is already gone, so a failed request cannot be rebuilt from the composer;
         * the payload is retained for the discard path's next retry. A resolved request is not
         * proof of deletion either: the route reports a failed storage delete as a 200 carrying
         * the id in `failedFileIds`, and the draft provenance this deletion was derived from is
         * pruned right after, so retention is the last reference to the orphaned upload. */
        mutateAsync({ files: [deletion] })
          .then((result) => {
            if (failedFileIdsFrom(result).includes(deletion.file_id)) {
              retainFileDeletion(deletion);
            }
          })
          .catch(() => {
            retainFileDeletion(deletion);
          });
      }
    },
    [deleteFile, setFiles, mutateAsync, index, isSubmitting],
  );

  /** The composer an edit belongs to: same conversation, same unsaved-chat identity. */
  const isOriginatingComposer = useCallback(
    (editConversationId: string | null, editDraftToken: symbol) =>
      conversationIdRef.current === editConversationId &&
      getNewConversationDraftToken(index) === editDraftToken,
    [index],
  );

  const saveEdit = useCallback(
    async (text: string) => {
      if (editing == null) {
        return;
      }
      const { file, conversationId: editConversationId, draftToken: editDraftToken } = editing;
      /** Refuse a save from a composer the paste did not come from: the detach and the
       * replacement upload would otherwise land in whatever the user switched to. */
      if (!isOriginatingComposer(editConversationId, editDraftToken)) {
        setEditing(null);
        return;
      }
      /** Uploads are deduped on name + size + type, and an edit that preserves length would
       * otherwise collide with the attachment it replaces. A free name cannot. */
      const attachedFilenames = new Set(
        Array.from(files.values()).map(
          (attached) => attached.file?.name ?? attached.filename ?? '',
        ),
      );
      const replacement = new File([text], nextPastedTextFilename(attachedFilenames), {
        type: 'text/plain',
      });
      /** A paste restored from a draft has no `tool_resource`: the server record does not keep
       * one. `embedded` does survive, and it is only ever set for a file that was vectorized,
       * so it is what tells a file-search paste apart from a plain one, and `metadata.codeEnvRef`
       * does the same for one staged into the code sandbox. Falling straight through to `context`
       * would upload the correction where the original was not and then detach the original,
       * quietly dropping the edited paste out of file search or out of the sandbox. */
      const restoredToolResource = ((): EToolResources | undefined => {
        if (file.metadata?.codeEnvRef != null || file.metadata?.codeEnvRefs != null) {
          return EToolResources.execute_code;
        }
        return file.embedded === true ? EToolResources.file_search : undefined;
      })();
      const toolResource =
        (file.tool_resource as EToolResources | undefined) ??
        restoredToolResource ??
        (isAssistantsEndpoint(conversation?.endpoint) ? undefined : EToolResources.context);

      setEditing(null);
      /** The original stays until the replacement is stored, but it stops accepting actions:
       * a second edit or a Move back against the same original would double-replace it. */
      const sourceId = file.file_id;
      pendingActionIdsRef.current.add(sourceId);
      setPendingActionIds(new Set(pendingActionIdsRef.current));
      const settleAction = () => {
        pendingActionIdsRef.current.delete(sourceId);
        setPendingActionIds(new Set(pendingActionIdsRef.current));
      };
      /** The original stays until the replacement is stored. `routeFiles` resolving only means
       * the upload was accepted into the queue, and detaching first would leave neither copy
       * behind when the upload is rejected or fails. */
      const uploadId = v4();
      /** The replacement is itself a generated paste: without recording its provenance the
       * fresh chip immediately loses the Edit and Move back affordances it exists for. */
      markPastedTextFile(uploadId);
      const replacementDraftId = getComposerDraftId(index, conversationIdRef.current, isSubmitting);
      /** Same rule as the original paste: a record another open tab owns is not ours to write to.
       * `setFilesDraft` keeps that tab's stamp, so recording the replacement there would hand it
       * a chip this composer is still holding, which it could then delete through New Chat. */
      if (saveDrafts && isFilesDraftOwnedByThisTab(getFilesDraftCached(replacementDraftId))) {
        addPastedTextDraftFile({
          id: replacementDraftId,
          fileId: uploadId,
        });
      }
      /** The corrections stay recoverable: a rejected or failed upload reopens the editor with
       * what the user typed, because the original attachment alone no longer holds it. When
       * another chip's dialog is open, the failed edit queues for the freed dialog instead of
       * being dropped: the failed upload's callback was its only remaining owner. */
      const restoreEdits = () => {
        if (!isOriginatingComposer(editConversationId, editDraftToken)) {
          return;
        }
        const revived = {
          file,
          text,
          conversationId: editConversationId,
          draftToken: editDraftToken,
        };
        if (editingRef.current == null) {
          setEditing(revived);
        } else {
          setFailedEdits((queue) => [...queue, revived]);
        }
      };
      const accepted = await routeFiles([replacement], toolResource, {
        fileId: uploadId,
        replacesFileId: sourceId,
        shouldCommit: () =>
          isOriginatingComposer(editConversationId, editDraftToken) && isAttachedToComposer(file),
        onSuccess: () => {
          settleAction();
          /** `shouldCommit` only gates the queue, not the request: the composer can change
           * while the upload itself is in flight, and so can the map, when the message this
           * file belongs to was sent in the meantime. Either way the original is no longer
           * this composer's unsent chip to remove. */
          if (
            isOriginatingComposer(editConversationId, editDraftToken) &&
            isAttachedToComposer(file)
          ) {
            detach(file);
          }
        },
        onError: () => {
          settleAction();
          restoreEdits();
        },
        onAbort: () => {
          settleAction();
          restoreEdits();
        },
      });
      if (!accepted) {
        settleAction();
        /** The queue rejected the replacement before it could create a file, so remove the
         * provenance record that was reserved before routing. Recheck ownership because another
         * tab may have claimed the draft while the upload was in flight. */
        if (saveDrafts && isFilesDraftOwnedByThisTab(getFilesDraftCached(replacementDraftId))) {
          removePendingTextAttachmentDraft({
            id: replacementDraftId,
            fileId: uploadId,
            removeFile: true,
          });
        }
        /** A send or navigation already took the original; reopening the editor or toasting a
         * save error would put a replacement into the emptied composer. */
        if (
          isOriginatingComposer(editConversationId, editDraftToken) &&
          isAttachedToComposer(file)
        ) {
          restoreEdits();
          showToast({ message: localize('com_ui_pasted_text_save_error'), status: 'error' });
        }
      }
    },
    [
      editing,
      files,
      conversation?.endpoint,
      isOriginatingComposer,
      isAttachedToComposer,
      detach,
      routeFiles,
      showToast,
      localize,
      index,
      saveDrafts,
      isSubmitting,
    ],
  );

  /**
   * Drops the attachment and appends its text to the composer. The caret the paste came from is
   * long gone by now, so this lands at the end rather than guessing at an offset.
   *
   * The write goes through the form rather than `insertTextAtCursor`: that helper needs the
   * textarea focused for `execCommand`, and the chip that was clicked is being unmounted as this
   * runs, so the insert silently did nothing. The manual `input` event stands in for the one
   * `execCommand` would have fired, which is what tells autosave to write the draft.
   */
  const moveInline = useCallback(
    async (file: ExtendedFile) => {
      /** Same lock as an edit: a replacement already in flight must not race a move, and a
       * second action must not race this move's own resolve. The ref is claimed before any
       * await so two clicks in the same turn cannot both proceed. */
      if (pendingActionIdsRef.current.has(file.file_id)) {
        return;
      }
      pendingActionIdsRef.current.add(file.file_id);
      setPendingActionIds(new Set(pendingActionIdsRef.current));
      try {
        const conversationIdAtClick = conversationIdRef.current;
        const draftTokenAtClick = getNewConversationDraftToken(index);
        const text = await resolveText(file);
        const moveStale =
          conversationIdRef.current !== conversationIdAtClick ||
          getNewConversationDraftToken(index) !== draftTokenAtClick ||
          !isAttachedToComposer(file);
        if (moveStale) {
          return;
        }
        if (text == null) {
          showToast({ message: localize('com_ui_pasted_text_unavailable'), status: 'error' });
          return;
        }

        setEditing((current) => (current?.file.file_id === file.file_id ? null : current));
        detach(file);

        const textArea = textAreaRef.current;
        const current = textArea?.value ?? methods.getValues('text') ?? '';
        const next = current.length > 0 ? `${current}\n${text}` : text;
        methods.setValue('text', next, { shouldDirty: true, shouldValidate: true });

        if (textArea == null) {
          return;
        }
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
        forceResize(textArea);
        textArea.focus();
        textArea.setSelectionRange(next.length, next.length);
      } finally {
        pendingActionIdsRef.current.delete(file.file_id);
        setPendingActionIds(new Set(pendingActionIdsRef.current));
      }
    },
    [resolveText, showToast, localize, detach, textAreaRef, methods, index, isAttachedToComposer],
  );

  /** Whether a replacement upload or inline move is in flight for a source attachment; the
   * chip's actions hide while it is, so the same original cannot be acted on twice. */
  const isActionPending = useCallback(
    (fileId: string) => pendingActionIds.has(fileId),
    [pendingActionIds],
  );

  return { editing, openEditor, closeEditor, saveEdit, moveInline, isActionPending };
}
