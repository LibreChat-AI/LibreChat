import { useCallback, useMemo } from 'react';
import { v4 } from 'uuid';
import { safelyTrack } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import type { DuringRunAction } from '../../core';
import type { ComposerTake } from './composer';
import type { QueueEnqueue } from './enqueue';
import type { SubmitSteer } from './submit';
import { useSteerHost } from '../steer/host';

export interface DuringRunActions {
  steerFromComposer: (text: string, preempt?: boolean) => boolean;
  queueFromComposer: (text: string) => boolean;
  interruptAndSend: (text: string) => boolean;
  interruptSteer: (text: string) => boolean;
  submitDuringRun: (text: string) => boolean;
}

/** What the composer's own controls do during a run: steer, queue, interrupt
 *  and send, or interrupt the step and steer, each taking the composer's staged
 *  attachments, quotes and picks with the words. */
export default function useDuringRunActions({
  conversationId,
  composerDisabledRef,
  filesLoading,
  canSteer,
  canControlGeneration,
  hasRealConvoId,
  duringRunActive,
  pausedOnApproval,
  effectiveAction,
  pendingReasoningOverride,
  enqueue,
  composer,
  takeComposerDraft,
  submitSteer,
  armDrainAfterAbort,
  stopGenerating,
}: {
  conversationId: string | null | undefined;
  composerDisabledRef: MutableRefObject<boolean>;
  filesLoading: boolean;
  canSteer: boolean;
  canControlGeneration: boolean;
  hasRealConvoId: boolean;
  duringRunActive: boolean;
  pausedOnApproval: boolean;
  effectiveAction: DuringRunAction;
  pendingReasoningOverride: TMessage['reasoningOverride'];
  enqueue: QueueEnqueue['enqueue'];
  composer: ComposerTake;
  takeComposerDraft: () => void;
  submitSteer: SubmitSteer;
  armDrainAfterAbort: () => void;
  stopGenerating: () => void;
}): DuringRunActions {
  const host = useSteerHost();
  const trackProduct = host.useProductTracking?.();
  const enqueueExplicit = useCallback<QueueEnqueue['enqueue']>(
    (text, options) => {
      const clientRequestId = v4();
      safelyTrack(trackProduct, {
        name: 'librechat.chat.message.submitted',
        feature: 'chat',
        kind: 'send',
        submissionId: clientRequestId,
        conversationId: conversationId ?? undefined,
      });
      enqueue(text, { ...options, clientRequestId });
    },
    [conversationId, enqueue, trackProduct],
  );
  const { takeComposerFiles, takeComposerContext, takeComposerQuotes, restoreComposerQuotes } =
    composer;
  /** Composer-originated steer: consumes the composer's attachments and quote
   *  chips so they ride the steer as one unit (the server re-fetches + encodes
   *  files and merges quotes at the injection boundary). Both are taken only
   *  after the submission accepts the prepared text and refs. */
  const steerFromComposer = useCallback(
    (text: string, preempt = false): boolean => {
      if (composerDisabledRef.current || filesLoading || !canSteer) {
        return false;
      }
      return takeComposerFiles(text.trim(), (mergedText, files) => {
        /** A live steer cannot change the provider request already in flight.
         * Preserve a staged reasoning choice as a full queued turn. */
        if (pendingReasoningOverride != null) {
          enqueueExplicit(mergedText, { files, ...takeComposerContext() });
          takeComposerDraft();
          return true;
        }
        const quotes = takeComposerQuotes();
        const consumed = submitSteer(mergedText, files, quotes, { preempt });
        if (consumed) takeComposerDraft();
        else restoreComposerQuotes(quotes);
        return consumed;
      });
    },
    [
      composerDisabledRef,
      filesLoading,
      canSteer,
      pendingReasoningOverride,
      enqueueExplicit,
      takeComposerFiles,
      takeComposerContext,
      takeComposerQuotes,
      restoreComposerQuotes,
      takeComposerDraft,
      submitSteer,
    ],
  );

  /** Composer-originated queue: carries the composer's attachments, quote
   *  chips, and manual skill picks as one unit. */
  const queueFromComposer = useCallback(
    (text: string): boolean => {
      if (composerDisabledRef.current || filesLoading) {
        return false;
      }
      return takeComposerFiles(text.trim(), (mergedText, files) => {
        enqueueExplicit(mergedText, { files, ...takeComposerContext() });
        takeComposerDraft();
        return true;
      });
    },
    [
      composerDisabledRef,
      filesLoading,
      enqueueExplicit,
      takeComposerFiles,
      takeComposerContext,
      takeComposerDraft,
    ],
  );

  /** Abort the current run and auto-send this text once the abort settles. */
  const interruptAndSend = useCallback(
    (text: string): boolean => {
      if (composerDisabledRef.current || filesLoading || !canControlGeneration) {
        return false;
      }
      return takeComposerFiles(text.trim(), (mergedText, files) => {
        enqueueExplicit(mergedText, { front: true, files, ...takeComposerContext() });
        takeComposerDraft();
        armDrainAfterAbort();
        stopGenerating();
        return true;
      });
    },
    [
      composerDisabledRef,
      filesLoading,
      canControlGeneration,
      enqueueExplicit,
      takeComposerFiles,
      takeComposerContext,
      takeComposerDraft,
      armDrainAfterAbort,
      stopGenerating,
    ],
  );

  /** Preempt the active step and continue the same response with the message. */
  const interruptSteer = useCallback(
    (text: string): boolean => {
      if (
        composerDisabledRef.current ||
        filesLoading ||
        pausedOnApproval ||
        !canControlGeneration ||
        !hasRealConvoId
      ) {
        return false;
      }
      /* A staged reasoning choice belongs to a new generation, which a steer
         into the live one cannot carry. Falling back to interruptAndSend here
         would discard the partial answer this action promises to keep, so
         decline exactly as the disabled menu row does, on the first turn too,
         and leave the words in the composer, where Enter queues them as a
         turn of their own. */
      if (pendingReasoningOverride != null) {
        return false;
      }
      return takeComposerFiles(text.trim(), (mergedText, files) => {
        const quotes = takeComposerQuotes();
        const consumed = submitSteer(mergedText, files, quotes, { preempt: true });
        if (consumed) takeComposerDraft();
        else restoreComposerQuotes(quotes);
        return consumed;
      });
    },
    [
      composerDisabledRef,
      filesLoading,
      pausedOnApproval,
      canControlGeneration,
      hasRealConvoId,
      pendingReasoningOverride,
      takeComposerFiles,
      takeComposerQuotes,
      restoreComposerQuotes,
      takeComposerDraft,
      submitSteer,
    ],
  );

  /** Routes a during-run submit to the effective action. Returns true when consumed. */
  const submitDuringRun = useCallback(
    (text: string): boolean => {
      if (composerDisabledRef.current || !duringRunActive) {
        return false;
      }
      if (effectiveAction === 'interrupt') {
        return interruptSteer(text);
      }
      if (effectiveAction === 'steer') {
        return steerFromComposer(text);
      }
      return queueFromComposer(text);
    },
    [
      composerDisabledRef,
      duringRunActive,
      effectiveAction,
      interruptSteer,
      steerFromComposer,
      queueFromComposer,
    ],
  );

  return useMemo(
    () => ({
      steerFromComposer,
      queueFromComposer,
      interruptAndSend,
      interruptSteer,
      submitDuringRun,
    }),
    [steerFromComposer, queueFromComposer, interruptAndSend, interruptSteer, submitDuringRun],
  );
}
