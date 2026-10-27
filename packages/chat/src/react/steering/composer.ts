import { useCallback, useMemo } from 'react';
import { useStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { ComposerFile, ComposerFileSetter } from './types';
import type { QueuedMessageContext } from '../../core';
import {
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../composer';
import { markComposerFilesTaken } from '../../core';
import { useSteerHost } from '../steer/host';

export interface ComposerTake {
  takeComposerFiles: () => TMessage['files'];
  takeComposerContext: () => QueuedMessageContext;
  takeComposerQuotes: () => QueuedMessageContext;
}

/** Drains what the composer has staged so it travels with one during-run
 *  submission instead of the next one. */
export default function useComposerTake<File extends ComposerFile>({
  conversationId,
  reasoningStateKey,
  files,
  setFiles,
}: {
  conversationId: string;
  reasoningStateKey: string;
  files?: Map<string, File>;
  setFiles?: ComposerFileSetter<File>;
}): ComposerTake {
  const reasoningStore = useStore();
  const clearFilesToDelete = useSteerHost().useClearFilesToDelete();

  /** Consumes completed composer attachments into message file refs (clearing
   *  the composer) so they pair with THIS queued message instead of gluing
   *  onto whatever `ask` vacuums up next.
   *
   *  Cleared by id through a FUNCTIONAL update, never by assigning an empty
   *  map: uploads dispatch their own functional updates, so a flat overwrite
   *  drops an attachment the user started after this read, and the upload's
   *  next callback puts it back on top of the emptied map. Removing exactly
   *  the ids taken leaves any newer upload alone, and marking them consumed
   *  stops a late callback for one of THESE files resurrecting it. */
  const takeComposerFiles = useCallback((): TMessage['files'] => {
    if (files == null || files.size === 0 || setFiles == null) {
      return undefined;
    }
    const staged = Array.from(files.values());
    // Completed uploads keep their temporary map key after receiving a server id.
    const takenIds = Array.from(files.entries()).flatMap(([key, file]) => [
      key,
      file.file_id,
      ...(file.temp_file_id ? [file.temp_file_id] : []),
    ]);
    const taken = staged.map((file) => ({
      file_id: file.file_id,
      filepath: file.filepath,
      type: file.type ?? '',
      height: file.height,
      width: file.width,
      // Retained beyond the submission shape so "Edit message" can restore
      // the attachment into the composer with its real name and size.
      filename: file.filename,
      bytes: file.size,
      llmDeliveryPath: file.llmDeliveryPath,
    }));
    markComposerFilesTaken(takenIds);
    setFiles((previous) => {
      const remaining = new Map(previous);
      for (const id of takenIds) {
        remaining.delete(id);
      }
      return remaining;
    });
    clearFilesToDelete();
    return taken;
  }, [files, setFiles, clearFilesToDelete]);

  /** Consumes staged quote chips + manual skill picks (mirroring `ask()`'s
   *  fresh-submit drain of the same atoms) so they pair with THIS queued
   *  message instead of gluing onto whatever the user sends next. */
  const takeComposerContext = useCallback((): QueuedMessageContext => {
    const quotes = reasoningStore.get(pendingQuotesByConvoId(conversationId));
    const manualSkills = reasoningStore.get(pendingManualSkillsByConvoId(conversationId));
    const reasoningOverride = reasoningStore.get(pendingReasoningOverrideFamily(reasoningStateKey));
    if (quotes.length > 0) {
      reasoningStore.set(pendingQuotesByConvoId(conversationId), []);
    }
    if (manualSkills.length > 0) {
      reasoningStore.set(pendingManualSkillsByConvoId(conversationId), []);
    }
    if (reasoningOverride != null) {
      reasoningStore.set(pendingReasoningOverrideFamily(reasoningStateKey), undefined);
    }
    return {
      ...(quotes.length > 0 && { quotes }),
      ...(manualSkills.length > 0 && { manualSkills }),
      ...(reasoningOverride != null && { reasoningOverride }),
    };
  }, [conversationId, reasoningStateKey, reasoningStore]);

  /** Quotes-only drain for composer-origin steers: the excerpts ride the steer
   *  POST into the live run, while manual skill picks stay staged: a skill
   *  pick configures a NEW turn's agent run and cannot apply to a mid-run
   *  injection, so it keeps waiting for the next full submission. */
  const takeComposerQuotes = useCallback((): QueuedMessageContext => {
    const quotes = reasoningStore.get(pendingQuotesByConvoId(conversationId));
    if (quotes.length === 0) {
      return {};
    }
    reasoningStore.set(pendingQuotesByConvoId(conversationId), []);
    return { quotes };
  }, [conversationId, reasoningStore]);

  return useMemo(
    () => ({ takeComposerFiles, takeComposerContext, takeComposerQuotes }),
    [takeComposerFiles, takeComposerContext, takeComposerQuotes],
  );
}
