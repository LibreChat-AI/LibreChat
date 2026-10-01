import { useCallback } from 'react';
import { useStore } from 'jotai';
import { useRecoilCallback } from 'recoil';
import type { Snapshot } from 'recoil';
import type { PendingSteer } from '~/store/families';
import {
  getSteerErrorCode,
  isDefiniteSteerRejection,
  resolveAcknowledgedSteer,
} from '~/hooks/Chat/useSteering';
import { useSteerMessageMutation, useCancelSteerMutation } from '~/data-provider';
import { useComposerRestoreHost } from '~/Providers/ComposerRestoreContext';
import { carriedSteerContext, isLegacyDeliveryUncertain } from '~/utils';
import { pendingSteerCancelClientIdsFamily } from '~/store/steer';
import { useSteerRehome } from '~/hooks/Chat/useSteerCancel';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import store from '~/store';

/**
 * Retry or re-route a pending steer from OUTSIDE the composer. The thread's
 * pending block needs these actions without dragging the whole
 * `SteeringControls` object through the message tree.
 */
export default function useSteerRecovery(conversationId: string) {
  const { mutateAsync: steerMessage } = useSteerMessageMutation();
  const { mutateAsync: cancelSteer } = useCancelSteerMutation();
  const convertSteersToQueued = useSteerConvert();
  const rehomeSteer = useSteerRehome(conversationId);
  const { rewakeDrain } = useComposerRestoreHost();
  const jotaiStore = useStore();

  /** Whether the run this steer belongs to has finished, read live at ack time.
   *  Unmounting is not the same signal: `PendingSteers` also unmounts when the
   *  user navigates away from a run that is still going, and treating that as
   *  the end queued the accepted steer as a follow-up on top of the injection
   *  the server was already making. */
  const isRunOver = useCallback(
    (snapshot: Snapshot) => {
      const keys = snapshot.getLoadable(store.conversationKeysAtom).getValue();
      let held = false;
      for (const key of keys) {
        const convo = snapshot.getLoadable(store.conversationByIndex(key)).getValue();
        if (convo?.conversationId !== conversationId) {
          continue;
        }
        /* Comparison mode can hold one conversation in several panes, and only
           the pane that owns the run is submitting: any live pane means the
           run is still going, whichever slot comes first. */
        if (snapshot.getLoadable(store.isSubmittingFamily(key)).getValue() === true) {
          return false;
        }
        held = true;
      }
      /* Held by no slot at all: the user navigated to another chat, which says
         nothing about the run they left behind. Reading that as the end is the
         same mistake as reading the unmount as the end, one step further out. */
      return held;
    },
    [conversationId],
  );

  const markStatus = useRecoilCallback(
    ({ set }) =>
      (steerId: string, status: PendingSteer['status']) => {
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.map((steer) => (steer.steerId === steerId ? { ...steer, status } : steer)),
        );
      },
    [conversationId],
  );

  const markFailure = useRecoilCallback(
    ({ set }) =>
      (steerId: string, deliveryUncertain: boolean) => {
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.map((steer) => {
            if (steer.steerId !== steerId) {
              return steer;
            }
            const { deliveryUncertain: _deliveryUncertain, ...rest } = steer;
            return {
              ...rest,
              status: 'failed',
              ...(deliveryUncertain && { deliveryUncertain: true }),
            };
          }),
        );
      },
    [conversationId],
  );

  /**
   * The retry's 202 ACK, resolved by the SHARED implementation the composer
   * uses so the two cannot drift on epoch replacement, already-accepted client
   * ids, or the applied-id check. All this call site contributes is its own
   * observation of ordinary terminal state.
   *
   * @returns true when the caller must route the steer into the queue.
   */
  const acknowledgeRetry = useRecoilCallback(
    (cbInterface) =>
      (localId: string, steer: PendingSteer): boolean =>
        resolveAcknowledgedSteer(
          cbInterface,
          conversationId,
          localId,
          steer,
          isRunOver(cbInterface.snapshot),
        ),
    [conversationId, isRunOver],
  );

  /** Routes a steer straight into the queue: reused for a retry that degrades
   *  (no active run / paused / unsupported / queue full), for an ACK the
   *  resolver reports as unresolvable, and for `sendAsNew`, so all three get
   *  the same id-dedup, chronological merge, and applied-id bookkeeping as
   *  every other steer-to-queue conversion, instead of a blind append that a
   *  late ACK could still re-mint a chip for. */
  const queueSteer = useCallback(
    (steer: PendingSteer, bindRecoverySource?: boolean) => {
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
          },
        ],
        {
          /** The receipt belongs to the generation that produced it. The
           * conversation may already advertise a replacement generation by the
           * time a late ACK lands, and reading the protocol off that one would
           * bind (or strip) the wrong recovery identity. */
          generationProtocolVersion: steer.generationProtocolVersion,
          /** Left unset, binding follows that pinned version: only v2
           * conversations can bind a queued follow-up to a durable receipt.
           * Forcing it on a v1 row points the recovery source at machinery the
           * v1 server never parks, and the drain's explicit send dies
           * mid-commit. Local failures still pass `false` explicitly: they hold
           * no receipt to bind. */
          ...(bindRecoverySource != null && { bindRecoverySource }),
        },
      );
      /* These conversions settle asynchronously. A retry left `sending` is kept
         out of the run-end sweep, so if the run finished while the POST was in
         flight the drain has already spent its one-shot signal on a queue this
         row was not in yet. Re-post it; the composer ignores the call unless
         that run completed cleanly and no newer signal is armed. */
      rewakeDrain(conversationId);
    },
    [conversationId, convertSteersToQueued, rewakeDrain],
  );

  const retry = useRecoilCallback(
    ({ snapshot, set }) =>
      (steerId: string) => {
        const steer = snapshot
          .getLoadable(store.pendingSteersByConvoId(conversationId))
          .getValue()
          .find((item) => item.steerId === steerId);
        if (!steer || isLegacyDeliveryUncertain(steer)) {
          return;
        }
        markStatus(steerId, 'sending');
        /* Resolved through the promise rather than through `mutate`'s
           per-call callbacks, which react-query drops once the observer has no
           listeners. This hook lives in the block that unmounts the moment the
           run ends, which is exactly when a retry's ack tends to land: those
           callbacks never ran, and the chip was left saying `sending` for the
           rest of the conversation with the words neither sent nor queued. */
        /* `preempt` rides along: a chip that failed as an interrupt-steer has to
           retry AS one. Resent without it the words land at the run's next tool
           step instead of sealing the stream, which is a different action than
           the one the user asked for and the chip still claims to be. */
        /* The same identity fields the composer's retry sends. `clientSteerId`
           is what the server dedupes a committed POST on, so an uncertain
           transport cannot apply these words twice, and `generationCreatedAt`
           pins the attempt to the generation the chip belongs to rather than
           whichever turn now occupies the conversation-scoped stream id. */
        const clientSteerId = steer.clientSteerId ?? steerId;
        steerMessage({
          conversationId,
          clientSteerId,
          text: steer.text,
          files: steer.files,
          ...(steer.quotes != null && { quotes: steer.quotes }),
          ...(steer.generationCreatedAt != null && {
            generationCreatedAt: steer.generationCreatedAt,
          }),
          ...(steer.preempt === true && { preempt: true }),
        })
          .then((response) => {
            const acceptAck = () => {
              const { deliveryUncertain: _deliveryUncertain, ...resolvedSteer } = steer;
              const acknowledged: PendingSteer = {
                ...resolvedSteer,
                steerId: response.steerId,
                clientSteerId,
                status: 'pending',
                /* The server echoes what it actually armed: without the
                   capability it queues the steer and reports `preempt: false`,
                   which relabels the chip rather than failing it. */
                preempt: response.preempt === true,
              };
              /* The resolver owns the decision: an ACK for a run that already
                 ended, or for a generation since replaced, has no later SSE event
                 left to settle a `pending` chip, so the words go to the queue
                 instead of being stranded. */
              if (acknowledgeRetry(steerId, acknowledged)) {
                queueSteer(acknowledged);
              }
            };
            if (
              !jotaiStore
                .get(pendingSteerCancelClientIdsFamily(conversationId))
                .includes(clientSteerId)
            ) {
              acceptAck();
              return;
            }
            /* The user cancelled while the retry POST was in flight. The
               composer settles this same race with a deferred cancel: clearing
               the marker without one loses the words, and accepting the ACK
               without one injects them after the user asked for them back. */
            void cancelSteer({
              conversationId,
              steerId: response.steerId,
              clientSteerId,
              ...(steer.generationCreatedAt != null && {
                generationCreatedAt: steer.generationCreatedAt,
              }),
            }).then(
              ({ removed }) => {
                jotaiStore.set(pendingSteerCancelClientIdsFamily(conversationId), (ids) =>
                  ids.filter((id) => id !== clientSteerId),
                );
                if (removed !== true) {
                  /* The server kept the steer: it is live and will still reach
                     the agent. The chip the optimistic cancel hid comes back
                     through the ordinary acknowledgement, so it settles like
                     any other accepted retry. */
                  acceptAck();
                  return;
                }
                /* The cancel beat the retry's POST, so the words are off the
                   server: they come back through the same boundary as an
                   immediate cancel, whole, and queued for an explicit send
                   when the composer will not take them. */
                rehomeSteer({ ...steer, steerId: response.steerId });
              },
              () => {
                jotaiStore.set(pendingSteerCancelClientIdsFamily(conversationId), (ids) =>
                  ids.filter((id) => id !== clientSteerId),
                );
                /* Unknown cancel outcome, but the retry POST was accepted:
                   treat the steer as live rather than claiming it is gone. */
                acceptAck();
              },
            );
          })
          .catch((error: unknown) => {
            if (
              jotaiStore
                .get(pendingSteerCancelClientIdsFamily(conversationId))
                .includes(clientSteerId)
            ) {
              jotaiStore.set(pendingSteerCancelClientIdsFamily(conversationId), (ids) =>
                ids.filter((id) => id !== clientSteerId),
              );
              /* The optimistic cancel removed the sending chip, and every
                 path below settles by mapping chips that still exist: without
                 the chip back the words vanish, unsent and unqueued both. */
              set(store.pendingSteersByConvoId(conversationId), (prev) => [...prev, steer]);
            }
            const code = getSteerErrorCode(error);
            // The run ended, is paused, was replaced, or can't accept a steer
            // right now: none of that means the words are lost, just that a
            // queued follow-up is the only way left to send them. `RUN_REPLACED`
            // belongs here too, because the retry pins `generationCreatedAt` to
            // the chip's own generation: once a newer run owns the conversation
            // every retry earns that same 409 and the chip would be stuck failed
            // forever. Queueing is what the composer does with it, and unlike
            // the composer's normal-send fallback it cannot displace the
            // replacement run.
            if (
              code === 'NO_ACTIVE_RUN' ||
              code === 'RUN_PAUSED' ||
              code === 'RUN_REPLACED' ||
              code === 'STEER_UNSUPPORTED' ||
              code === 'STEER_QUEUE_FULL'
            ) {
              queueSteer(steer, false);
              return;
            }
            markFailure(steerId, !isDefiniteSteerRejection(error));
          });
      },
    [
      conversationId,
      steerMessage,
      cancelSteer,
      rehomeSteer,
      jotaiStore,
      markStatus,
      markFailure,
      acknowledgeRetry,
      queueSteer,
    ],
  );

  /** Move a failed steer into the queue: it sends when the reply finishes. */
  const sendAsNew = useRecoilCallback(
    ({ snapshot }) =>
      (steerId: string) => {
        const steer = snapshot
          .getLoadable(store.pendingSteersByConvoId(conversationId))
          .getValue()
          .find((item) => item.steerId === steerId);
        if (!steer || steer.deliveryUncertain === true) {
          return;
        }
        queueSteer(steer, false);
      },
    [conversationId, queueSteer],
  );

  return { retry, sendAsNew };
}
