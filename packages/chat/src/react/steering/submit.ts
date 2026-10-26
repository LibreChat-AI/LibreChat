import { useCallback, useRef } from 'react';
import { v4 } from 'uuid';
import type { TMessage } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import type {
  SteerAttempt,
  PendingSteer,
  SubmitSteerOptions,
  QueuedMessageOrigin,
  QueuedMessageContext,
  GenerationProtocolVersion,
} from '../../core';
import type { QueueEnqueue } from './enqueue';
import type { SteerChips } from './chips';
import type { QueueRows } from './rows';
import {
  steerAttemptChip,
  routeSteerFailure,
  carriedSteerContext,
  createSteerDispatch,
  supportsGenerationProtocolV2,
} from '../../core';
import { useSteerRehome } from './useSteerCancel';
import useSteerConvert from './useSteerConvert';
import { useSteerHost } from '../steer/host';

export type SubmitSteer = (
  text: string,
  steerFiles?: TMessage['files'],
  context?: QueuedMessageContext,
  opts?: SubmitSteerOptions,
) => boolean;

/** The steer POST and everything its response can mean for the words it carried. */
export default function useSubmitSteer({
  conversationId,
  hasRealConvoId,
  activeGenerationCreatedAt,
  activeGenerationProtocolVersion,
  visibleConversationRef,
  isSubmittingRef,
  sendNow,
  chips,
  rows,
  enqueue,
}: {
  conversationId: string;
  hasRealConvoId: boolean;
  activeGenerationCreatedAt: number | null;
  activeGenerationProtocolVersion: GenerationProtocolVersion;
  visibleConversationRef: MutableRefObject<string>;
  isSubmittingRef: MutableRefObject<boolean>;
  sendNow: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => false | void;
  chips: SteerChips;
  rows: Pick<QueueRows, 'restoreQueued' | 'rewakeDrain' | 'registerQueuedOrigin'>;
  enqueue: QueueEnqueue['enqueue'];
}): SubmitSteer {
  const host = useSteerHost();
  const localize = host.useLocalize();
  const notify = host.useNotify();
  const convertSteersToQueued = useSteerConvert();
  /* The single boundary a steer's words return through, wherever the cancel
     that reclaimed them was decided. */
  const rehomeSteer = useSteerRehome(conversationId);
  /** `mutate` is a stable callback; the mutation result objects are fresh
   * every render and would defeat the memoized return value of the caller. */
  const steerMessage = host.useSteerMessage();
  const cancelSteer = host.useCancelSteer();
  const dispatchRef = useRef(createSteerDispatch());
  const {
    upsertSteerChip,
    replaceSteerChip,
    acknowledgeSteer,
    settleReceiptReplay,
    reclaimRejectedChipQuotes,
    isSteerAcceptedOrSettled,
    hasPendingSteerCancel,
    clearPendingSteerCancel,
  } = chips;
  const { restoreQueued, rewakeDrain, registerQueuedOrigin } = rows;

  /** Restore a server-owned steer as the same queued follow-up and wake a
   * drain whose one-shot completion signal may already have been consumed
   * while the recovery request was in flight. Shared by reclaim and durable
   * receipt replay so neither round-trip can strand accepted words. */
  const queueRecoveredSteer = useCallback(
    (steer: PendingSteer) => {
      convertSteersToQueued(
        conversationId,
        [
          {
            steerId: steer.steerId,
            ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
            text: steer.text,
            createdAt: steer.createdAt,
            ...(steer.files && steer.files.length > 0 && { files: steer.files }),
            ...carriedSteerContext(steer),
            ...(steer.queuedOrigin && { queuedOrigin: steer.queuedOrigin }),
          },
        ],
        {
          /** A durable receipt belongs to the generation that produced it. The
           * visible conversation may already advertise a replacement/legacy
           * generation by the time this late ACK lands, but that must not strip
           * the receipt-bound recovery identity from the queued item. */
          generationProtocolVersion: steer.generationProtocolVersion,
        },
      );
      rewakeDrain(conversationId);
    },
    [conversationId, convertSteersToQueued, rewakeDrain],
  );

  /** POSTs a steer (text + files + quotes; the server merges the quotes into
   *  the model-bound turn at the injection boundary). `context` doubles as the
   *  RESTORE payload: every degradation path threads it back into the
   *  requeue/send fallback so the item's quotes and manual skills survive.
   *  Skill picks never ride the POST; they configure a NEW turn's run, so a
   *  queued-origin steer only carries them for restoration. */
  return useCallback(
    (
      text: string,
      steerFiles?: TMessage['files'],
      context?: QueuedMessageContext,
      opts?: SubmitSteerOptions,
    ): boolean => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || !hasRealConvoId) {
        return false;
      }
      const preempt = opts?.preempt === true;
      const targetGenerationCreatedAt =
        opts?.generationCreatedAt ?? activeGenerationCreatedAt ?? undefined;
      if (targetGenerationCreatedAt == null) {
        return false;
      }
      const files = steerFiles && steerFiles.length > 0 ? steerFiles : undefined;
      const localId = opts?.clientSteerId ?? `local-${v4()}`;
      /** The true submission time, carried through the ACK and failure chips so
       *  a later conversion sorts this steer by when it was SENT, not when its
       *  202 landed; otherwise a draft queued during the round-trip would drain
       *  ahead of a steer submitted before it. */
      const createdAt = opts?.createdAt ?? Date.now();
      /** Rides every chip state so a terminal conversion (late ACK, run-end
       *  leftover report) can restore the queued item's full context. */
      const attempt: SteerAttempt = {
        localId,
        text: trimmed,
        createdAt,
        files,
        generationCreatedAt: targetGenerationCreatedAt,
        generationProtocolVersion:
          opts?.generationProtocolVersion ?? activeGenerationProtocolVersion,
        queuedOrigin: opts?.queuedOrigin,
        carried: carriedSteerContext(context),
      };
      const { carried, generationProtocolVersion } = attempt;
      /** If the steer loses its race with run finalization, its normal-send
       * fallback must still be tied to the generation it targeted. Otherwise
       * a newer run started by another tab can be replaced by this stale
       * fallback. Every fallback also carries a queue origin: an existing row
       * keeps its exact logical slot, while a composer-origin steer gets a
       * stable synthetic row so a predecessor 409 cannot discard its text or
       * files when the newer run wins. */
      const fallbackOrigin: QueuedMessageOrigin = opts?.queuedOrigin ?? {
        item: {
          id: localId,
          text: trimmed,
          createdAt,
          expectedPredecessorCreatedAt: targetGenerationCreatedAt,
          ...(files && { files }),
          ...carried,
          ...(context?.clientRequestId && {
            clientRequestId: context.clientRequestId,
          }),
          ...(context?.recoverySteerId && {
            recoverySteerId: context.recoverySteerId,
          }),
        },
        beforeIds: [],
        afterIds: [],
      };
      const fallbackContext: QueuedMessageContext = {
        ...context,
        expectedPredecessorCreatedAt: targetGenerationCreatedAt,
        queuedMessageOrigin: fallbackOrigin,
      };
      /** A queued-origin attempt must be reversible as the same queue item,
       *  not merely reproducible from its text. This preserves its identity,
       *  timestamp, priority, future fields, and original array position. */
      const restoreRejectedSteer = () => {
        if (opts?.queuedOrigin != null) {
          restoreQueued(opts.queuedOrigin);
        } else {
          enqueue(trimmed, { id: localId, createdAt, files, ...context });
        }
        rewakeDrain(conversationId);
      };
      /** The words go out as a new turn when the visible pane is free, and back
       *  into the queue when it is not or the send is refused. */
      const sendOrRestore = () => {
        if (sendNow(trimmed, files ?? [], fallbackContext) === false) {
          restoreRejectedSteer();
        }
      };
      if (opts?.queuedOrigin != null) {
        registerQueuedOrigin(opts.queuedOrigin);
      }
      upsertSteerChip(
        conversationId,
        steerAttemptChip(attempt, {
          steerId: localId,
          status: 'sending',
          ...(preempt && { preempt: true }),
        }),
      );
      dispatchRef.current(conversationId, (settleDispatch) => {
        steerMessage(
          {
            conversationId,
            clientSteerId: localId,
            text: trimmed,
            ...(files && { files }),
            ...(carried.quotes && { quotes: carried.quotes }),
            ...(preempt && { preempt }),
            generationCreatedAt: targetGenerationCreatedAt,
          },
          {
            onSuccess: (response) => {
              try {
                /** The server's own record of this steer, as every later state names it. */
                const accepted = (extra?: Partial<PendingSteer>) =>
                  steerAttemptChip(attempt, {
                    steerId: response.steerId,
                    clientSteerId: localId,
                    status: 'pending',
                    ...extra,
                  });
                const acceptResponse = () => {
                  /** A 202 without the echo means a pre-quotes replica queued
                   *  the words without their excerpts. The quotes are NOT
                   *  re-staged here: the steer has not injected yet, so they
                   *  stay carried on the pending chip: a quote-less applied
                   *  event re-stages them at the actual loss, and a terminal
                   *  leftover conversion carries them onto the recovered row
                   *  instead (its normal send delivers quotes on any server).
                   *  Only a settled replay (an already-injected steer with no
                   *  future event to re-home the chip) reclaims immediately. */
                  const quotesRejected = carried.quotes != null && response.quotesAccepted !== true;
                  const canUseV2Receipt =
                    generationProtocolVersion === 2 && supportsGenerationProtocolV2(response);
                  if (canUseV2Receipt && response.settled === true) {
                    if (response.leftover === true) {
                      queueRecoveredSteer(accepted());
                    } else {
                      if (quotesRejected) {
                        reclaimRejectedChipQuotes(conversationId, [localId, response.steerId]);
                      }
                      settleReceiptReplay(conversationId, localId, response.steerId);
                    }
                    return;
                  }
                  /** Unsupported runs retain the words as Steer, but never silently
                   * claim to have requested tool cancellation. */
                  if (
                    preempt &&
                    response.preempt !== true &&
                    visibleConversationRef.current === conversationId
                  ) {
                    notify({
                      message: localize('com_ui_steer_preempt_unsupported'),
                      status: 'warning',
                    });
                  }
                  const acknowledged = accepted({
                    ...(response.preempt === true && { preempt: true }),
                    ...(response.preemptRevision != null && {
                      preemptRevision: response.preemptRevision,
                    }),
                  });
                  if (acknowledgeSteer(conversationId, localId, acknowledged)) {
                    /** Terminal conversion re-homes the words as a queued
                     *  follow-up that sends via `ask`; the carried quotes ride
                     *  it there, so nothing is re-staged. */
                    queueRecoveredSteer(acknowledged);
                  }
                };
                if (hasPendingSteerCancel(conversationId, localId)) {
                  void cancelSteer({
                    conversationId,
                    steerId: response.steerId,
                    clientSteerId: localId,
                    generationCreatedAt: targetGenerationCreatedAt,
                  }).then(
                    ({ removed }) => {
                      clearPendingSteerCancel(conversationId, localId);
                      if (removed === true) {
                        /* Cancel won the race against its own POST. The words are
                           off the server now, so they go back to the user through
                           the same boundary as an immediate cancel: whole, and
                           into the queue when the composer will not take them.
                           Clearing the marker without this loses the message. */
                        rehomeSteer(accepted());
                        return;
                      }
                      /* The server kept the steer: it is live and will still
                         reach the agent. The chip the optimistic cancel hid
                         comes back through the ordinary acknowledgement, so it
                         settles like any other accepted steer. */
                      acceptResponse();
                      notify({
                        message: localize('com_ui_steer_already_applied'),
                        status: 'info',
                      });
                    },
                    () => {
                      clearPendingSteerCancel(conversationId, localId);
                      /* Unknown outcome, but the POST was accepted: treat the
                         steer as live rather than claiming it is gone. */
                      acceptResponse();
                      notify({
                        message: localize('com_ui_steer_cancel_failed'),
                        status: 'warning',
                      });
                    },
                  );
                  return;
                }
                acceptResponse();
              } finally {
                settleDispatch();
              }
            },
            onError: (error) => {
              try {
                clearPendingSteerCancel(conversationId, localId);
                if (isSteerAcceptedOrSettled(conversationId, localId)) {
                  replaceSteerChip(conversationId, localId, null);
                  return;
                }
                const originStillVisible = visibleConversationRef.current === conversationId;
                const route = routeSteerFailure(error, generationProtocolVersion);
                if (route === 'send-after-run') {
                  // The run finished before the steer landed. While the final SSE
                  // is still settling, `ask()`'s in-flight guard would drop a
                  // direct send: queue it so the run-end drain fires it instead.
                  // The explicit empty array stops `ask` from vacuuming composer
                  // files staged for a DIFFERENT draft. A refused send (`false`)
                  // falls back to the queue too: the chip is already gone, so
                  // dropping the text here would lose it silently.
                  replaceSteerChip(conversationId, localId, null);
                  if (!originStillVisible || isSubmittingRef.current) {
                    restoreRejectedSteer();
                    return;
                  }
                  sendOrRestore();
                  return;
                }
                if (route === 'send-when-idle') {
                  replaceSteerChip(conversationId, localId, null);
                  // The rejection can land AFTER the final SSE consumed the
                  // run-end signal (common on an unsupported SDK near run end):
                  // queueing then has nothing left to drain it, so mirror the
                  // NO_ACTIVE_RUN fallback and send once submission settled:
                  // queueing the refusal instead of dropping the text.
                  if (originStillVisible && !isSubmittingRef.current) {
                    sendOrRestore();
                    return;
                  }
                  restoreRejectedSteer();
                  notify({
                    message: localize('com_ui_steer_paused_queued'),
                    status: 'info',
                  });
                  return;
                }
                if (route === 'requeue') {
                  /** A different live generation now owns this conversation. A
                   * normal-send fallback would replace that newer run (especially
                   * from a stale tab), so retain the instruction for its run-end
                   * drain regardless of this tab's local submission state. */
                  replaceSteerChip(conversationId, localId, null);
                  restoreRejectedSteer();
                  notify({
                    message: localize('com_ui_steer_paused_queued'),
                    status: 'info',
                  });
                  return;
                }
                // A concrete origin 4xx proves the steer was rejected and keeps
                // the ordinary failed controls (edit/queue/remove/retry); a
                // transport or 5xx ambiguity gets the locked "delivery unknown"
                // surface instead.
                upsertSteerChip(
                  conversationId,
                  steerAttemptChip(attempt, {
                    steerId: localId,
                    status: 'failed',
                    ...(route === 'uncertain' && { deliveryUncertain: true }),
                    ...(preempt && { preempt: true }),
                  }),
                );
              } finally {
                settleDispatch();
              }
            },
          },
        );
      });
      return true;
    },
    [
      hasRealConvoId,
      conversationId,
      upsertSteerChip,
      replaceSteerChip,
      acknowledgeSteer,
      settleReceiptReplay,
      queueRecoveredSteer,
      rehomeSteer,
      reclaimRejectedChipQuotes,
      steerMessage,
      sendNow,
      enqueue,
      restoreQueued,
      rewakeDrain,
      registerQueuedOrigin,
      isSteerAcceptedOrSettled,
      hasPendingSteerCancel,
      clearPendingSteerCancel,
      cancelSteer,
      notify,
      localize,
      activeGenerationCreatedAt,
      activeGenerationProtocolVersion,
      visibleConversationRef,
      isSubmittingRef,
    ],
  );
}
