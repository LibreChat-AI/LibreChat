import { useCallback, useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { FileSources, TFile } from 'librechat-data-provider';
import type { MouseEvent } from 'react';
import type { ExtendedFile } from '~/common';
import type { FilesDraft } from '~/utils';
import {
  beginRetainedDeletionPass,
  clearAllDrafts,
  clearFilesDraft,
  clearMessagesCache,
  clearRetainedFileDeletion,
  failedFileIdsFrom,
  getFilesDraft,
  getNewConversationDraftId,
  collectDraftedAttachmentIds,
  collectForeignAttachmentClaims,
  collectLiveAttachmentIds,
  endRetainedDeletionPass,
  getPendingDraftId,
  isFilesDraftOwnedByThisTab,
  isPastedTextFileMarked,
  isPasteSubmitted,
  loadPendingDiscardIds,
  removeTabAttachmentPresence,
  scheduleRetainedFileDeletionRetry,
  storePendingDiscardIds,
  subscribePendingDiscardIds,
  subscribeRetainedFileDeletions,
  takeRetainedFileDeletions,
} from '~/utils';
import { useGetFiles, useDeleteFilesMutation } from '~/data-provider';
import useNewConvo from '~/hooks/useNewConvo';
import store from '~/store';

export type UseNewChatParams = {
  index?: number;
  /**
   * Runs once the conversation has been reset. The sidebar uses it to switch
   * back to the conversations panel; callers outside `ActivePanelProvider`
   * (the chat header, keyboard shortcuts) omit it.
   */
  onNewChat?: () => void;
};

export type UseNewChatResult = {
  startNewChat: () => void;
  /** For an `<a href="/c/new">` trigger, so modified clicks still open a tab. */
  handleNewChatClick: (event: MouseEvent<HTMLElement>) => void;
  newConversation: ReturnType<typeof useNewConvo>['newConversation'];
};

type DeletableRecord = {
  file_id: string;
  embedded: boolean;
  filepath: string;
  source: FileSources;
};

const toDeletableRecord = (record: TFile): DeletableRecord | null => {
  if (record.filepath == null || record.filepath === '' || !record.source) {
    return null;
  }
  return {
    file_id: record.file_id,
    embedded: record.embedded ?? false,
    filepath: record.filepath,
    source: record.source,
  };
};

/** The live chip's own evidence of what it is, used when no draft record exists to read. */
const toDeletableComposerFile = (file: ExtendedFile): DeletableRecord | null => {
  if (file.filepath == null || file.filepath === '' || file.source == null) {
    return null;
  }
  return {
    file_id: file.file_id,
    embedded: file.embedded ?? false,
    filepath: file.filepath,
    source: file.source,
  };
};

/** Every id the composer currently owns: map keys plus their resolved file ids. Pastes stay
 * owned even when restoration stamped them `attached`, because the draft says they are ours. */
const collectOwnedIds = (files: Map<string, ExtendedFile>, pasteIds: Set<string>): Set<string> => {
  const ownedIds = new Set<string>();
  files.forEach((file, key) => {
    if (file.attached === true && !pasteIds.has(key) && !pasteIds.has(file.file_id)) {
      return;
    }
    ownedIds.add(key);
    if (file.file_id != null) {
      ownedIds.add(file.file_id);
    }
  });
  return ownedIds;
};

/** The draft and the composer map carry a request's own uuid, while the files cache keys the
 * record by the server-assigned file id and remembers the request id as `temp_file_id`, so a
 * discard is matched through either identity. */
const findFilesRecord = (fileList: TFile[] | undefined, fileId: string): TFile | undefined =>
  fileList?.find((entry) => entry.file_id === fileId || entry.temp_file_id === fileId);

/**
 * Single source of truth for starting a new conversation: drops the cached
 * messages for the outgoing conversation, invalidates the messages query, then
 * resets the conversation atom.
 */
export default function useNewChat({
  index = 0,
  onNewChat,
}: UseNewChatParams = {}): UseNewChatResult {
  const queryClient = useQueryClient();
  const { newConversation } = useNewConvo(index);
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const files = useRecoilValue(store.filesByIndex(index));
  const saveDrafts = useRecoilValue(store.saveDrafts);
  const { data: fileList } = useGetFiles<TFile[]>();
  const { mutateAsync } = useDeleteFilesMutation();
  /** The cleanup pass runs on a timer nobody asked for, so it reports nothing: a storage failure
   * that keeps failing would otherwise toast on every retry, and success would arrive minutes
   * after the action that caused it. */
  const { mutateAsync: mutateAsyncSilently } = useDeleteFilesMutation({ silent: true });
  /** Draft uploads whose records were not resolvable when the draft was discarded: the files
   * cache was still loading, or the upload was still in flight and completed only after. */
  const [pendingDiscardIds, setPendingDiscardIdsState] = useState<string[]>(() =>
    loadPendingDiscardIds(index),
  );
  const [retainedGeneration, setRetainedGeneration] = useState(0);

  const setPendingDiscardIds = useCallback(
    (updater: string[] | ((current: string[]) => string[])) => {
      setPendingDiscardIdsState((current) => {
        const next = typeof updater === 'function' ? updater(current) : updater;
        /** The header, sidebar, mobile bar and shortcut hooks each mount this hook against one
         * shared session store, so writing this instance's snapshot back would drop ids another
         * instance recorded and never saw. Only the ids this instance actually knows about are
         * resolved; anything else in the store is another instance's and is carried through. */
        const known = new Set(current);
        const merged = Array.from(
          new Set([...next, ...loadPendingDiscardIds(index).filter((id) => !known.has(id))]),
        );
        storePendingDiscardIds(index, merged);
        return merged;
      });
    },
    [index],
  );

  useEffect(() => subscribeRetainedFileDeletions(() => setRetainedGeneration((n) => n + 1)), []);

  /** Another instance may have deferred work and then unmounted, so the store is re-read on every
   * write rather than only at mount. Only a real change is applied, or the write this instance
   * just made would set state straight back and loop. */
  useEffect(
    () =>
      subscribePendingDiscardIds(() =>
        setPendingDiscardIdsState((current) => {
          const stored = loadPendingDiscardIds(index);
          const changed =
            stored.length !== current.length || stored.some((id, at) => id !== current[at]);
          return changed ? stored : current;
        }),
      ),
    [index],
  );

  useEffect(() => {
    const retained = takeRetainedFileDeletions();
    if ((pendingDiscardIds.length === 0 && retained.length === 0) || fileList == null) {
      return;
    }
    /** Another mounted instance is already running this pass. Ask for a later one rather than
     * dropping the work: whatever it does not resolve has to be revisited by someone. */
    if (!beginRetainedDeletionPass()) {
      scheduleRetainedFileDeletionRetry();
      return;
    }
    let cancelled = false;
    const attempt = async () => {
      removeTabAttachmentPresence(
        [...pendingDiscardIds, ...retained.map((record) => record.file_id)],
        index,
      );
      /** An id that came back, as a live chip or inside any draft, is no longer the discarded
       * draft's to delete. Every persisted draft is consulted, not just this pane's keys: after
       * a reload the `files` map is empty until the autosave restore renders, and a second tab
       * can have reattached the file to a conversation this pane has never opened. Drafts live in
       * `localStorage`, so that tab's record is readable from here. */
      const reattached = collectDraftedAttachmentIds();
      /** Drafts are only written when draft saving is on, so live tabs also publish what their
       * composers are holding: without that, a file reattached in another tab with the setting
       * off would be invisible here and deleted underneath it. */
      for (const liveId of collectLiveAttachmentIds()) {
        reattached.add(liveId);
      }
      files.forEach((file, key) => {
        reattached.add(key);
        if (file.file_id != null) {
          reattached.add(file.file_id);
        }
        /** A discard can be pending under the upload's temporary id, and `findFilesRecord`
         * resolves that alias to the same record: without matching it here, reattaching the
         * surviving file would not protect it from its own pending deletion. */
        if (file.temp_file_id != null && file.temp_file_id !== '') {
          reattached.add(file.temp_file_id);
        }
      });
      /** A file a message already consumed is off-limits whatever the draft and presence records
       * say. Those are per-tab and time-bounded; the submitted ledger is durable and shared, so it
       * is the one that can still speak for a send that happened in a tab which has since been
       * suspended, or longer ago than presence remembers.
       *
       * The record is resolved before judging, because the two sides can know the file by
       * different names: a discard is often keyed by the temporary upload id while the pane that
       * sent it marked only the server id. */
      const consumedBySubmission = (fileId: string): boolean => {
        const record = findFilesRecord(fileList, fileId);
        return [fileId, record?.file_id, record?.temp_file_id].some((id) => isPasteSubmitted(id));
      };
      const deletable: DeletableRecord[] = [];
      const stillPending: string[] = [];
      for (const fileId of pendingDiscardIds) {
        if (reattached.has(fileId) || consumedBySubmission(fileId)) {
          continue;
        }
        const record = findFilesRecord(fileList, fileId);
        if (record == null) {
          stillPending.push(fileId);
          continue;
        }
        const deletableRecord = toDeletableRecord(record);
        if (deletableRecord != null) {
          deletable.push(deletableRecord);
        }
      }
      /** Deletions other flows retained after a failed request ride along: their payloads
       * cannot be rebuilt, so they retry here until one succeeds. A file the composer has
       * since reattached, or that a message has since consumed, is no longer ours to retry. */
      const retainedToRetry = retained.filter(
        (record) => !reattached.has(record.file_id) && !consumedBySubmission(record.file_id),
      );
      for (const record of retained) {
        if (reattached.has(record.file_id) || consumedBySubmission(record.file_id)) {
          clearRetainedFileDeletion(record.file_id);
        }
      }
      const batch = [...deletable, ...retainedToRetry];
      if (batch.length > 0) {
        try {
          const result = await mutateAsyncSilently({ files: batch });
          const failed = new Set(failedFileIdsFrom(result));
          for (const record of retainedToRetry) {
            if (!failed.has(record.file_id)) {
              clearRetainedFileDeletion(record.file_id);
            }
          }
          for (const record of deletable) {
            if (failed.has(record.file_id)) {
              stillPending.push(record.file_id);
            }
          }
          /** A reported failure leaves both stores exactly as they were, so this effect has no
           * dependency left to move it: the next attempt has to be asked for, same as a rejection. */
          if (failed.size > 0) {
            scheduleRetainedFileDeletionRetry();
          }
        } catch {
          /** The draft is already gone, so these ids are the only record of what to clean:
           * keep them for the next files-cache update rather than orphaning the uploads. Nothing
           * here moves an effect dependency, so the next attempt has to be asked for. */
          scheduleRetainedFileDeletionRetry();
          return;
        }
      }
      if (!cancelled && stillPending.length !== pendingDiscardIds.length) {
        setPendingDiscardIds(stillPending);
      }
    };
    void attempt().finally(endRetainedDeletionPass);
    return () => {
      cancelled = true;
    };
  }, [
    pendingDiscardIds,
    conversationId,
    fileList,
    files,
    index,
    mutateAsyncSilently,
    retainedGeneration,
    setPendingDiscardIds,
  ]);

  const startNewChat = useCallback(() => {
    clearMessagesCache(queryClient, conversationId);
    queryClient.invalidateQueries([QueryKeys.messages]);
    /** The unsaved-chat draft key outlives the reset and `useAutoSave` restores from it on the way
     * in, so an unsent paste came back on every later new chat. Its attachments are dropped here to
     * make an explicit new chat a clean slate; its text is deliberately kept, because the restore
     * is also what puts a draft back when the user simply leaves the unsaved chat and returns, and
     * clearing it made that the one composer that forgot what had been typed in it. Nothing else is
     * gained by clearing it: unlike an attachment there is no upload behind it to leave dangling.
     * Per-conversation drafts are untouched either way.
     *
     * With draft saving on, `newConversation` deliberately leaves the draft's files alive
     * because a draft normally keeps them restorable; discarding the draft removes the only
     * reference to them, so the uploads are deleted here rather than orphaned. Two limits keep
     * that deletion safe: the unsaved-chat key is shared by every tab's default composer, so a
     * record stamped with another tab's id is left alone, and only ids the composer still owns
     * are deleted, because the draft also records library attaches whose files other messages
     * share. Ids the composer no longer shows cannot be told apart from those, so they are left
     * to retention cleanup; ids still uploading are kept until their records arrive. */
    const draftId = getNewConversationDraftId(index);
    const pendingId = getPendingDraftId(index);
    const idleDraft = getFilesDraft(draftId);
    const pendingDraft = getFilesDraft(pendingId);
    const collectDiscardWork = (
      draft: FilesDraft,
    ): { deletable: DeletableRecord[]; deferred: string[] } => {
      if (!isFilesDraftOwnedByThisTab(draft)) {
        return { deletable: [], deferred: [] };
      }
      const pasteIds = new Set(draft.pastedTextIds ?? []);
      const ownedIds = collectOwnedIds(files, pasteIds);
      /** A draft's own paste provenance is ownership in itself: after a reload the composer
       * map may not be rebuilt yet when New Chat is clicked, and the chips those ids are
       * waiting to become would otherwise be skipped rather than discarded with the draft.
       *
       * Not for one a message already took, though. Submitting empties the file map but leaves
       * the draft's provenance behind, and the run ending is no evidence either way: Stop and
       * error paths clear the flag without clearing the draft. Only the submission itself knows,
       * so ids it consumed are excluded by name rather than by whether a run is in flight. */
      for (const pasteId of pasteIds) {
        if (!isPasteSubmitted(pasteId)) {
          ownedIds.add(pasteId);
        }
      }
      const draftFileIds = new Set([...draft.fileIds, ...Object.keys(draft.pendingPastes)]);
      const deletable: DeletableRecord[] = [];
      const deferred: string[] = [];
      for (const fileId of draftFileIds) {
        if (!ownedIds.has(fileId)) {
          continue;
        }
        const record = findFilesRecord(fileList, fileId);
        const deletableRecord = record != null ? toDeletableRecord(record) : null;
        if (deletableRecord != null) {
          deletable.push(deletableRecord);
        } else if (record == null) {
          deferred.push(fileId);
        }
      }
      return { deletable, deferred };
    };
    if (saveDrafts) {
      const idleWork = collectDiscardWork(idleDraft);
      const pendingWork = collectDiscardWork(pendingDraft);
      const seen = new Set<string>();
      const deletable: DeletableRecord[] = [];
      for (const record of [...idleWork.deletable, ...pendingWork.deletable]) {
        if (seen.has(record.file_id)) {
          continue;
        }
        seen.add(record.file_id);
        deletable.push(record);
      }
      /** Persisting a draft can fail outright (private mode, quota) while the upload and its
       * chip still succeed, leaving nothing in the draft to discard from. A generated paste the
       * composer is still showing is its own evidence, so it is collected directly. One that came
       * back `attached` is skipped for the usual reason: the registry also remembers pastes that
       * were already sent and re-attached, and those belong to the message that sent them. */
      files.forEach((file, key) => {
        /** The registry is marked with the client upload id, while a completed entry carries the
         * server one and keeps the original as `temp_file_id`, so the marker is matched through
         * every identity or the finished paste reads as somebody else's file. */
        const isMarkedPaste = [key, file.file_id, file.temp_file_id].some((id) =>
          isPastedTextFileMarked(id),
        );
        if (
          file.attached === true ||
          file.progress < 1 ||
          !isMarkedPaste ||
          seen.has(file.file_id)
        ) {
          return;
        }
        const record = toDeletableComposerFile(file);
        if (record != null) {
          seen.add(record.file_id);
          deletable.push(record);
        }
      });
      const deferred = [...idleWork.deferred, ...pendingWork.deferred];
      /** The retry effect consults every other tab before it deletes; this direct path has to do
       * the same or it races past that guard entirely. A second tab can have reattached one of
       * these pastes and even sent it, in which case its draft or its published presence is the
       * only thing standing between the upload and this request. Its own keys and its own presence
       * are excluded, because those hold exactly what this discard is throwing away. */
      const claimedElsewhere = collectForeignAttachmentClaims([draftId, pendingId], index);
      const discardable = deletable.filter((record) => !claimedElsewhere.has(record.file_id));
      if (discardable.length > 0) {
        mutateAsync({ files: discardable })
          .then((result) => {
            const failedIds = failedFileIdsFrom(result);
            if (failedIds.length > 0) {
              setPendingDiscardIds((current) => Array.from(new Set([...current, ...failedIds])));
            }
          })
          .catch(() => {
            /** A failed deletion is retried on the next files-cache update, exactly like a
             * deferred one, instead of orphaning the uploads. */
            const failedIds = discardable.map((record) => record.file_id);
            setPendingDiscardIds((current) => Array.from(new Set([...current, ...failedIds])));
          });
      }
      /** Merged, not replaced: a second reset while an earlier upload is still in flight
       * must not forget that earlier id, or its eventual record is orphaned. */
      setPendingDiscardIds((current) => Array.from(new Set([...current, ...deferred])));
    }
    /** An upload still in flight has no filepath or source yet, so no discard path can build a
     * payload for it and the reset drops the chip regardless. Its id is deferred so the record is
     * deleted once it finally arrives. With draft saving on the draft supplies these ids; with it
     * off nothing else remembers them at all. */
    const inFlightPasteIds: string[] = [];
    files.forEach((file, key) => {
      const isMarkedPaste = [key, file.file_id, file.temp_file_id].some((id) =>
        isPastedTextFileMarked(id),
      );
      if (file.attached !== true && file.progress < 1 && isMarkedPaste) {
        inFlightPasteIds.push(file.file_id);
      }
    });
    if (inFlightPasteIds.length > 0) {
      setPendingDiscardIds((current) => Array.from(new Set([...current, ...inFlightPasteIds])));
    }
    /** A running response parks this pane's composer under the pending key; the clean slate
     * discards that too, or the queued text and attachments come back with the next run.
     * A record another tab still owns is left in place: clearing it would drop that tab's
     * unsent text and attachment recovery if it reloads before the next autosave. */
    if (isFilesDraftOwnedByThisTab(pendingDraft)) {
      clearAllDrafts(pendingId);
    }
    /** Attachments only: the uploads behind them have just been deleted, so restoring the chips
     * would reference files that are gone, while the typed message is what the user expects to
     * find again on the way back into the unsaved chat. */
    if (isFilesDraftOwnedByThisTab(idleDraft)) {
      clearFilesDraft(draftId);
    }
    const discardedFileIds = Array.from(
      new Set([
        ...inFlightPasteIds,
        ...Array.from(files.keys()),
        ...Array.from(files.values()).flatMap(
          (f) => [f.file_id, f.temp_file_id].filter(Boolean) as string[],
        ),
      ]),
    );
    removeTabAttachmentPresence(discardedFileIds, index);
    newConversation();
    onNewChat?.();
  }, [
    queryClient,
    conversationId,
    newConversation,
    onNewChat,
    index,
    saveDrafts,
    fileList,
    mutateAsync,
    files,
    setPendingDiscardIds,
  ]);

  const handleNewChatClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      startNewChat();
    },
    [startNewChat],
  );

  return { startNewChat, handleNewChatClick, newConversation };
}
