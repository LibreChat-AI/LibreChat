import type { TPendingSteer, TSteerUpdatedEvent } from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '../protocol';
import type { PendingSteer, QueuedMessage } from './types';
import type { FileDeliveryMetadataMap } from '../files';
import { hydrateFileDeliveryMetadata } from '../files';
import { carriedSteerContext } from './steer';

/** Default sweep for a run that has genuinely ended (final/error/404): a
 *  `pending` chip behind a server id that no `on_steer_applied` will ever
 *  confirm, or a `failed` chip that never reached the server at all. Either
 *  one left behind survives past this run end and renders under whatever
 *  comes next, since `PendingSteers` reads the same atom keyed only by
 *  conversation, not by run. */
export const RUN_ENDED_STATUSES: readonly PendingSteer['status'][] = ['pending', 'failed'];

/** Sweep for an intentional abort, where the run may still be live
 *  server-side: a server-ACK'd `pending` chip is injected regardless, so
 *  sweeping it here would send the same words a second time as a queued turn. */
export const ABORT_SWEEP_STATUSES: readonly PendingSteer['status'][] = ['failed'];

/**
 * Local chips with no injection-boundary event left to resolve them.
 * `statuses` defaults to `RUN_ENDED_STATUSES` for terminals where the run is
 * actually over; pass `['failed']` for a path (like intentional abort) where
 * the run may still be live server-side and a server-ACK'd `pending` chip
 * must be left alone: the server injects it regardless, and sweeping it here
 * would resend the same words as a duplicate queued turn.
 *
 * `sending` chips are never included: they have their own in-flight POST
 * whose `onSuccess`/`onError` will settle them, and sweeping them here too
 * would race that callback, since a late ACK's re-add in
 * `resolveAcknowledgedSteer` could then double-queue the same words.
 * Uncertain failures are also excluded. Protocol v2 makes an explicit retry
 * idempotent, but a local queue conversion would create a second submission.
 */
export function selectLocalSteersForQueue(
  chips: PendingSteer[],
  statuses: readonly PendingSteer['status'][] = RUN_ENDED_STATUSES,
  /** Ids the caller has already routed elsewhere this run end; matched against
   *  both ids a chip can be known by, since either may be the one excluded. */
  excluded: ReadonlySet<string> = new Set(),
): TPendingSteer[] {
  const allowed = new Set(statuses);
  return chips
    .filter(
      (steer) =>
        allowed.has(steer.status) &&
        steer.deliveryUncertain !== true &&
        !excluded.has(steer.steerId) &&
        (steer.clientSteerId == null || !excluded.has(steer.clientSteerId)),
    )
    .map((steer) => ({
      steerId: steer.steerId,
      ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
      text: steer.text,
      createdAt: steer.createdAt,
      ...(steer.files && steer.files.length > 0 && { files: steer.files }),
      ...(steer.queuedOrigin && { queuedOrigin: steer.queuedOrigin }),
    }));
}

/** Client ids the server has proven it accepted, from any list of server steers. */
export function acceptedClientSteerIds(
  steers: ReadonlyArray<{ clientSteerId?: string }> | undefined,
): string[] {
  return (steers ?? []).flatMap((steer) => (steer.clientSteerId ? [steer.clientSteerId] : []));
}

/**
 * Replaces the chip list with the server's still-queued steers (sync or
 * resume). Local `failed` entries are kept so their text stays recoverable,
 * and a reseeded chip keeps its quotes and skill picks (from the local chip,
 * or the server item's persisted quotes when no chip survives). An empty list
 * clears stale local pending chips: a steer applied while the client was away
 * is absent here because its inline part already rides the content.
 */
export function seedPendingSteers(
  prev: PendingSteer[],
  steers: TPendingSteer[] | undefined,
  options: {
    generationCreatedAt?: number;
    generationProtocolVersion: GenerationProtocolVersion;
    storedFiles?: FileDeliveryMetadataMap;
  },
): PendingSteer[] {
  const { generationCreatedAt, generationProtocolVersion, storedFiles } = options;
  const chipById = new Map(prev.map((chip) => [chip.steerId, chip]));
  const claimedIds = new Set(
    (steers ?? []).flatMap((steer) =>
      steer.clientSteerId ? [steer.steerId, steer.clientSteerId] : [steer.steerId],
    ),
  );
  return [
    ...(steers ?? []).map((steer) => {
      const localChip =
        chipById.get(steer.steerId) ??
        (steer.clientSteerId ? chipById.get(steer.clientSteerId) : undefined);
      const keepLocalPreempt = (localChip?.preemptRevision ?? 0) > (steer.preemptRevision ?? 0);
      const chipGenerationCreatedAt = generationCreatedAt ?? localChip?.generationCreatedAt;
      const restoredFiles = hydrateFileDeliveryMetadata(steer.files, localChip?.files, storedFiles);
      return {
        steerId: steer.steerId,
        ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
        text: steer.text,
        status: 'pending' as const,
        createdAt: steer.createdAt ?? Date.now(),
        ...(restoredFiles && restoredFiles.length > 0 && { files: restoredFiles }),
        ...((keepLocalPreempt ? localChip?.preempt : steer.preempt) === true && {
          preempt: true,
        }),
        ...((keepLocalPreempt ? localChip?.preemptRevision : steer.preemptRevision) != null && {
          preemptRevision: keepLocalPreempt ? localChip?.preemptRevision : steer.preemptRevision,
        }),
        ...(localChip?.queuedOrigin && { queuedOrigin: localChip.queuedOrigin }),
        ...(chipGenerationCreatedAt != null && {
          generationCreatedAt: chipGenerationCreatedAt,
        }),
        generationProtocolVersion,
        // The local chip carries skill picks the server never sees; a fresh
        // tab has no chip, so fall back to the server item's persisted quotes
        // rather than reseeding the chip without them.
        ...carriedSteerContext(localChip ?? steer),
      };
    }),
    ...prev.filter((steer) => steer.status === 'failed' && !claimedIds.has(steer.steerId)),
  ];
}

/** Capability can change while the same generation resumes after HITL.
 *  Patches labels in place; this event never removes or reorders a chip.
 *  Returns `prev` itself when nothing changed. */
export function updatePendingSteerLabels(
  prev: PendingSteer[],
  steers: TSteerUpdatedEvent['steers'],
): PendingSteer[] {
  const byId = new Map<string, TSteerUpdatedEvent['steers'][number]>();
  for (const steer of steers) {
    byId.set(steer.steerId, steer);
    if (steer.clientSteerId) {
      byId.set(steer.clientSteerId, steer);
    }
  }
  let changed = false;
  const next = prev.map((steer) => {
    const update = byId.get(steer.steerId);
    if (update == null) {
      return steer;
    }
    const correlated = update.clientSteerId === steer.steerId && steer.steerId !== update.steerId;
    const base = correlated
      ? {
          ...steer,
          steerId: update.steerId,
          clientSteerId: update.clientSteerId,
          status: 'pending' as const,
        }
      : steer;
    if (update.preemptRevision < (base.preemptRevision ?? 0)) {
      changed ||= base !== steer;
      return base;
    }
    if (
      Boolean(base.preempt) === update.preempt &&
      base.preemptRevision === update.preemptRevision
    ) {
      changed ||= base !== steer;
      return base;
    }
    changed = true;
    if (update.preempt) {
      return {
        ...base,
        preempt: true,
        preemptRevision: update.preemptRevision,
      };
    }
    const { preempt: _preempt, ...ordinary } = base;
    return { ...ordinary, preemptRevision: update.preemptRevision };
  });
  return changed ? next : prev;
}

/** The chips with every steer named in `ids` removed; `prev` itself when none matched. */
export function removePendingSteers(prev: PendingSteer[], ids: Iterable<string>): PendingSteer[] {
  const settled = new Set(ids);
  return prev.some((steer) => settled.has(steer.steerId))
    ? prev.filter((steer) => !settled.has(steer.steerId))
    : prev;
}

/** The quotes a settled chip holds, which an applied part without quotes would lose. */
export function settledSteerQuotes(
  chips: PendingSteer[],
  settledIds: readonly string[],
): string[] | undefined {
  const quotes = chips.find(
    (steer) => settledIds.includes(steer.steerId) && (steer.quotes?.length ?? 0) > 0,
  )?.quotes;
  return quotes != null && quotes.length > 0 ? quotes : undefined;
}

/** A terminal boundary may have re-homed a steer while its applied event was
 *  waiting for the response placeholder. The applied event is authoritative,
 *  so its recovery copy leaves the queue before it can drain as a duplicate.
 *  Returns `prev` itself when no row matched. */
export function withoutRecoveredSteers(
  prev: QueuedMessage[],
  settledIds: readonly string[],
): QueuedMessage[] {
  const recovered = (item: QueuedMessage) =>
    (item.recoverySteerId != null && settledIds.includes(item.recoverySteerId)) ||
    (item.recoveryClientSteerId != null && settledIds.includes(item.recoveryClientSteerId));
  return prev.some(recovered) ? prev.filter((item) => !recovered(item)) : prev;
}
