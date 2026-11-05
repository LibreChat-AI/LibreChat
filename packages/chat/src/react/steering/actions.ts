import { useCallback, useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import type { DuringRunAction } from '../../core';
import type { ComposerTake } from './composer';
import type { QueueEnqueue } from './enqueue';
import type { SubmitSteer } from './submit';

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
  const { takeComposerFiles, takeComposerContext, takeComposerQuotes } = composer;
  /** Composer-originated steer: consumes the composer's attachments and quote
   *  chips so they ride the steer as one unit (the server re-fetches + encodes
   *  files and merges quotes at the injection boundary). Both are taken only
   *  after the guards pass: with `canSteer` true, `submitSteer` cannot
   *  refuse, so the drained context can never be stranded. */
  const steerFromComposer = useCallback(
    (text: string, preempt = false): boolean => {
      const trimmed = text.trim();
      if (composerDisabledRef.current || trimmed.length === 0 || filesLoading || !canSteer) {
        return false;
      }
      /** A live steer cannot change the provider request already in flight.
       * Preserve a staged reasoning choice as a full queued turn. */
      if (pendingReasoningOverride != null) {
        enqueue(trimmed, {
          files: takeComposerFiles(),
          ...takeComposerContext(),
        });
        takeComposerDraft();
        return true;
      }
      const consumed = submitSteer(trimmed, takeComposerFiles(), takeComposerQuotes(), {
        preempt,
      });
      if (consumed) {
        takeComposerDraft();
      }
      return consumed;
    },
    [
      composerDisabledRef,
      filesLoading,
      canSteer,
      pendingReasoningOverride,
      enqueue,
      takeComposerFiles,
      takeComposerContext,
      takeComposerQuotes,
      takeComposerDraft,
      submitSteer,
    ],
  );

  /** Composer-originated queue: carries the composer's attachments, quote
   *  chips, and manual skill picks as one unit. */
  const queueFromComposer = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (composerDisabledRef.current || trimmed.length === 0 || filesLoading) {
        return false;
      }
      enqueue(trimmed, {
        files: takeComposerFiles(),
        ...takeComposerContext(),
      });
      takeComposerDraft();
      return true;
    },
    [
      composerDisabledRef,
      filesLoading,
      enqueue,
      takeComposerFiles,
      takeComposerContext,
      takeComposerDraft,
    ],
  );

  /** Abort the current run and auto-send this text once the abort settles. */
  const interruptAndSend = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (
        composerDisabledRef.current ||
        trimmed.length === 0 ||
        filesLoading ||
        !canControlGeneration
      ) {
        return false;
      }
      enqueue(trimmed, {
        front: true,
        files: takeComposerFiles(),
        ...takeComposerContext(),
      });
      takeComposerDraft();
      armDrainAfterAbort();
      stopGenerating();
      return true;
    },
    [
      composerDisabledRef,
      filesLoading,
      canControlGeneration,
      enqueue,
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
      const trimmed = text.trim();
      if (
        composerDisabledRef.current ||
        trimmed.length === 0 ||
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
      const consumed = submitSteer(trimmed, takeComposerFiles(), takeComposerQuotes(), {
        preempt: true,
      });
      if (consumed) {
        takeComposerDraft();
      }
      return consumed;
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
