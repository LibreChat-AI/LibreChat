import { useCallback, useRef } from 'react';
import { v4 } from 'uuid';
import { useRecoilCallback } from 'recoil';
import type { TPendingSteer } from 'librechat-data-provider';
import type { QueuedMessage, QueuedMessageOrigin } from '~/store/families';
import type { GenerationProtocolVersion } from '~/data-provider';
import type { SteerCarriedContext } from '~/utils';
import {
  appendAppliedSteerIds,
  carriedSteerContext,
  insertQueuedOrigin,
  hydrateFileDeliveryMetadata,
} from '~/utils';
import { fetchStreamStatus, getGenerationProtocolVersion } from '~/data-provider';
import { useFileMapContext } from '~/Providers';
import store from '~/store';

/** A server-reported steer, or a local one that carries its own client-only
 *  context (quotes / skill picks) because its chip may already be gone. */
type ConvertibleSteer = TPendingSteer &
  SteerCarriedContext & { queuedOrigin?: QueuedMessageOrigin };

interface SteerConvertOptions {
  /** Live-delivered terminal steers also have a parked server copy (the
   *  terminal drain parks before knowing the final reached a subscriber);
   *  set on final/abort/error surfaces to reconcile that durable copy. */
  claimParked?: boolean;
  /** Server-side id the parked copy is keyed under when it differs from the
   *  chip landing key (a `new`-held abort claims under the resolved job id). */
  claimConversationId?: string;
  /** Protocol selected for the source generation. V2 may bind the queued
   * follow-up to a durable receipt; v1 must remain an ordinary local item. */
  generationProtocolVersion?: GenerationProtocolVersion;
  /** Exact recovery sources that a post-terminal status read proved were not
   *  consumed by THIS recovery generation. Never set for an arbitrary or
   *  pre-start status response: those can be stale after a successful start. */
  allowPreviouslyConvertedIds?: readonly string[];
  /** Local failures have no durable receipt to reclaim on a later send. */
  bindRecoverySource?: boolean;
}

/**
 * Converts server-reported leftover steers into queued follow-up chips.
 * Converted ids join the applied set so a 202 ACK that lands after the run
 * ended drops its chip instead of re-minting a stranded `pending` one: the
 * set must survive run end for exactly that race, so it is capped, not
 * cleared. Safe to call from multiple delivery paths for the same steers
 * (final SSE event AND abort HTTP response): chip removal and queue
 * insertion both dedupe by steer id.
 *
 * `claimParked` fires ONE fire-and-forget /chat/status fetch per conversion
 * batch. The replayable response reconciles the durable parked copy through
 * the same id-deduped conversion, so a lost final/status response cannot erase
 * the only recovery source. Exact recovery or explicit dismissal commits the
 * server-side removal.
 */
export default function useSteerConvert() {
  const fileMap = useFileMapContext();
  const fileMapRef = useRef(fileMap);
  fileMapRef.current = fileMap;
  const convert = useRecoilCallback(
    ({ snapshot, set }) =>
      (
        conversationId: string,
        steers: ConvertibleSteer[],
        generationProtocolVersion?: GenerationProtocolVersion,
        allowPreviouslyConvertedIds: readonly string[] = [],
        bindRecoverySource?: boolean,
      ) => {
        if (steers.length === 0) {
          return;
        }
        const negotiatedVersion =
          generationProtocolVersion ??
          snapshot
            .getLoadable(store.activeGenerationProtocolVersionByConvoId(conversationId))
            .getValue();
        const shouldBindRecoverySource = bindRecoverySource ?? negotiatedVersion === 2;
        // Restore quotes/skill picks from the local chip (matched by id)
        // before the chips are dropped below: the chip is the only carrier of
        // skill picks, and of quotes accepted by an older server whose queue
        // items did not persist them yet.
        const localChips = snapshot
          .getLoadable(store.pendingSteersByConvoId(conversationId))
          .getValue();
        const chipById = new Map(localChips.map((chip) => [chip.steerId, chip]));
        const localChipFor = (steer: ConvertibleSteer) =>
          chipById.get(steer.steerId) ??
          (steer.clientSteerId ? chipById.get(steer.clientSteerId) : undefined);
        const steerIds = new Set(
          steers.flatMap((steer) =>
            steer.clientSteerId ? [steer.steerId, steer.clientSteerId] : [steer.steerId],
          ),
        );
        // Steers already settled (applied on the server OR converted here on an
        // earlier delivery) must not re-enter the queue. Read BEFORE the append
        // below so a first-time conversion still queues, but a redelivery whose
        // item was already DRAINED out of the queue is a no-op: without this,
        // the queue-only dedup below misses a message the run-end drain already
        // submitted and re-mints it as a stranded queued chip.
        const settledSteerIds = new Set(
          snapshot.getLoadable(store.appliedSteerIdsByConvoId(conversationId)).getValue(),
        );
        const allowedRedeliveries = new Set(allowPreviouslyConvertedIds);
        set(store.appliedSteerIdsByConvoId(conversationId), (prev) =>
          appendAppliedSteerIds(prev, [...steerIds]),
        );
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.filter((steer) => !steerIds.has(steer.steerId)),
        );
        set(store.queuedMessagesByConvoId(conversationId), (prev) => {
          /** A legacy status read is destructive: if a v2 live-final path
           * already created a receipt-bound item before the claim reached an
           * old replica, that source no longer exists. Downgrade the existing
           * item in place to an ordinary local follow-up. */
          const existing = shouldBindRecoverySource
            ? prev
            : prev.map((item) => {
                const matchesClaimedSource =
                  (item.recoverySteerId != null && steerIds.has(item.recoverySteerId)) ||
                  (item.recoveryClientSteerId != null && steerIds.has(item.recoveryClientSteerId));
                if (!matchesClaimedSource) {
                  return item;
                }
                const {
                  clientRequestId: _clientRequestId,
                  recoverySteerId: _recoverySteerId,
                  recoveryClientSteerId: _recoveryClientSteerId,
                  ...ordinary
                } = item;
                return ordinary;
              });
          const fresh = steers
            .filter(
              (steer) =>
                allowedRedeliveries.has(steer.steerId) ||
                (!settledSteerIds.has(steer.steerId) &&
                  (steer.clientSteerId == null || !settledSteerIds.has(steer.clientSteerId))),
            )
            .map((steer) => {
              const local = localChipFor(steer);
              const source = local ?? steer;
              const queuedOrigin = source.queuedOrigin;
              const files = hydrateFileDeliveryMetadata(
                queuedOrigin?.item.files ?? steer.files,
                local?.files,
                fileMapRef.current,
              );
              const recoveryFields = shouldBindRecoverySource
                ? {
                    // One UUID is stable for this queued attempt and all of
                    // its POST retries. A later failed generation re-converts
                    // the durable source and receives a new key, so the old
                    // started idempotency tombstone cannot make it unsendable.
                    clientRequestId: v4(),
                    recoverySteerId: steer.steerId,
                    ...(steer.clientSteerId && { recoveryClientSteerId: steer.clientSteerId }),
                  }
                : {};
              const item =
                queuedOrigin != null
                  ? { ...queuedOrigin.item, ...recoveryFields, ...(files && { files }) }
                  : ({
                      id: steer.steerId,
                      text: steer.text,
                      createdAt: steer.createdAt ?? Date.now(),
                      ...recoveryFields,
                      ...(files && files.length > 0 && { files }),
                      // The chip is the usual source, but a reclaimed steer may
                      // have lost its chip to a competing cancel mid-round-trip.
                      ...carriedSteerContext(source),
                    } satisfies QueuedMessage);
              return {
                item,
                queuedOrigin: queuedOrigin != null ? { ...queuedOrigin, item } : undefined,
              };
            })
            .filter(({ item }) => !existing.some((queued) => queued.id === item.id));
          if (fresh.length === 0) {
            return existing;
          }
          // Each new item is placed chronologically (a steer accepted BEFORE
          // the user queued a later follow-up must drain first) EXCEPT explicit
          // front-inserts ("Interrupt & send"), whose urgency outranks age.
          //
          // Placed rather than sorted: the queue can be reordered by hand from
          // the rail, and sorting the whole list would quietly restore the order
          // the messages were written in, changing which one sends next.
          let merged: QueuedMessage[] = [...existing];
          const ordinary = fresh
            .filter(({ queuedOrigin }) => queuedOrigin == null)
            .map(({ item }) => item)
            .sort((a, b) => a.createdAt - b.createdAt);
          for (const item of ordinary) {
            const at = merged.findIndex(
              (queued) => queued.priority !== true && queued.createdAt > item.createdAt,
            );
            merged.splice(at === -1 ? merged.length : at, 0, item);
          }
          /** A steer that originated in this queue restores its exact
           *  object/identity and captured position instead of being re-minted
           *  under the server id at a merely chronological spot. */
          for (const { queuedOrigin } of fresh) {
            if (queuedOrigin != null) {
              merged = insertQueuedOrigin(merged, queuedOrigin);
            }
          }
          return merged;
        });
      },
    [],
  );

  return useCallback(
    (conversationId: string, steers: ConvertibleSteer[], options?: SteerConvertOptions) => {
      convert(
        conversationId,
        steers,
        options?.generationProtocolVersion,
        options?.allowPreviouslyConvertedIds,
        options?.bindRecoverySource,
      );
      if (options?.claimParked !== true || steers.length === 0) {
        return;
      }
      fetchStreamStatus(options.claimConversationId ?? conversationId)
        .then((status) => {
          const unrecovered = status.unrecoveredSteers ?? [];
          if (unrecovered.length > 0) {
            convert(conversationId, unrecovered, getGenerationProtocolVersion(status));
          }
        })
        .catch(() => undefined);
    },
    [convert],
  );
}
