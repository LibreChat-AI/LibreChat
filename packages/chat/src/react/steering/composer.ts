import { useCallback, useMemo } from 'react';
import { useStore } from 'jotai';
import {
  DEFAULT_STEER_MAX_LENGTH,
  MAX_AGENT_QUEUED_TURN_TEXT_LENGTH,
} from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ComposerFile, ComposerFileSetter } from './types';
import type { QueuedMessageContext } from '../../core';
import {
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../composer';
import { markComposerFilesTaken, partitionComposerFiles } from '../../core';
import { useSteerHost } from '../steer/host';

export interface ComposerTake {
  takeComposerFiles: (
    text: string,
    submit: (text: string, files: TMessage['files']) => boolean,
  ) => boolean;
  takeComposerContext: () => QueuedMessageContext;
  takeComposerQuotes: () => QueuedMessageContext;
  restoreComposerQuotes: (context: QueuedMessageContext) => void;
}

/** Drains what the composer has staged so it travels with one during-run
 *  submission instead of the next one. */
export default function useComposerTake<File extends ComposerFile>({
  conversationId,
  reasoningStateKey,
  files,
  setFiles,
  discardFiles,
}: {
  conversationId: string;
  reasoningStateKey: string;
  files?: Map<string, File>;
  setFiles?: ComposerFileSetter<File>;
  discardFiles?: (fileIds: string[]) => void;
}): ComposerTake {
  const reasoningStore = useStore();
  const host = useSteerHost();
  const clearFilesToDelete = host.useClearFilesToDelete();
  const localize = host.useLocalize();
  const notify = host.useNotify();

  /** Prepares refs and inline text without side effects; consumes only after
   * the submission accepts them. Removal by identity preserves newer uploads. */
  const takeComposerFiles = useCallback(
    (text: string, submit: (text: string, files: TMessage['files']) => boolean): boolean => {
      if (files == null || files.size === 0 || setFiles == null) {
        return text.length > 0 && submit(text, undefined);
      }
      const prepared = partitionComposerFiles(text, files);
      if (prepared.hasIncompleteFiles || prepared.text.length === 0) {
        return false;
      }
      if (
        prepared.canceledUploadIds.length > 0 &&
        prepared.text.length > Math.min(DEFAULT_STEER_MAX_LENGTH, MAX_AGENT_QUEUED_TURN_TEXT_LENGTH)
      ) {
        notify({ message: localize('com_ui_pasted_text_wait_upload'), status: 'warning' });
        return false;
      }
      if (!submit(prepared.text, prepared.files)) {
        return false;
      }
      const submittedIds = prepared.submittedFileIds.filter((id): id is string => id != null);
      const takenIds = [
        ...submittedIds,
        ...prepared.canceledUploadIds,
        ...prepared.replacedFileIds,
      ];
      markComposerFilesTaken(takenIds);
      if (prepared.canceledUploadIds.length > 0) {
        host.cancelUploads?.(prepared.canceledUploadIds);
      }
      if (prepared.replacedFileIds.length > 0) {
        discardFiles?.(prepared.replacedFileIds);
      }
      setFiles((previous) => {
        const remaining = new Map(previous);
        for (const id of takenIds) {
          remaining.delete(id);
        }
        return remaining;
      });
      clearFilesToDelete();
      return true;
    },
    [files, setFiles, discardFiles, clearFilesToDelete, host, localize, notify],
  );

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

  const restoreComposerQuotes = useCallback(
    (context: QueuedMessageContext) => {
      if (!context.quotes?.length) return;
      const atom = pendingQuotesByConvoId(conversationId);
      reasoningStore.set(atom, [...context.quotes, ...reasoningStore.get(atom)]);
    },
    [conversationId, reasoningStore],
  );

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
    () => ({ takeComposerFiles, takeComposerContext, takeComposerQuotes, restoreComposerQuotes }),
    [takeComposerFiles, takeComposerContext, takeComposerQuotes, restoreComposerQuotes],
  );
}
