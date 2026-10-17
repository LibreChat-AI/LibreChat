import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TMessage } from 'librechat-data-provider';
import type { Atom, PrimitiveAtom } from 'jotai';
import type { GenerationProtocolVersion } from '../../core/protocol';
import type { PendingSteer } from '../../core/steer/types';
import type { Family } from './family';

/**
 * Set synchronously before a bubble's arm request and cleared on settlement.
 * Purely a UX gate: with the atomic in-place arm, a double-arm is harmless
 * server-side (the run seals once and drains the whole queue in order), but
 * every escalation control advertises "one interrupt at a time" by disabling,
 * and the chip-derived check cannot see an arm until its response lands.
 */
export const escalatingSteerFamily: Family<boolean> = atomFamily((_conversationId: string) =>
  atom<boolean>(false),
);

/** A server-owned follow-up and its admission handoff, keyed by conversation.
 * The drawing never enters history. Its guard survives the drawing until a
 * successor generation owns the pane or terminal evidence settles the turn. */
export type RevealedQueuedTurn = {
  clientRequestId: string;
  /** The drawing follows this response only while history has no successor. */
  parentMessageId: string;
  /** Completion boundary, advanced as later queued turns are admitted. */
  generationCreatedAt?: number;
  /** Immutable queue lineage, independent of the display/completion boundary. */
  queueParentMessageId?: string;
  queuePredecessorCreatedAt?: number;
  text: string;
  files?: TMessage['files'];
  quotes?: string[];
  manualSkills?: string[];
  revealedAt: string;
};

export const revealedQueuedTurnFamily: Family<RevealedQueuedTurn | null> = atomFamily(
  (_conversationId: string) => atom<RevealedQueuedTurn | null>(null),
);

/** Client ids cancelled before the steer POST receives its authoritative id. */
export const pendingSteerCancelClientIdsFamily: Family<string[]> = atomFamily(
  (_conversationId: string) => atom<string[]>([]),
);

/**
 * Steer ids whose applied event landed in THIS session, pending their one-shot
 * receipt draw-in. `SteerPart` consumes its id on mount so the animation plays
 * exactly once, at the live chip to inline hand-off, never on reload, share, or
 * a later revisit. Global rather than per-conversation: steer ids are unique,
 * and the applied part renders in surfaces that don't know their convo id. */
export const liveAppliedSteerIdsAtom: PrimitiveAtom<string[]> = atom<string[]>([]);

/** Membership view of `liveAppliedSteerIdsAtom` so each `SteerPart` subscribes to
 *  its own id only: stamping/consuming one steer re-renders that part, not
 *  every mounted historical part in a long conversation. */
export const liveAppliedSteerFamily: Family<boolean, Atom<boolean>> = atomFamily(
  (steerId: string) =>
    atom((get) => steerId.length > 0 && get(liveAppliedSteerIdsAtom).includes(steerId)),
);

/**
 * Per-conversation steers awaiting injection. Reconciled against the server:
 * `on_steer_applied` removes its chip; `sync`/`resumeState.pendingSteers`
 * replaces the list on reconnect; run-end reports convert leftovers into
 * `queuedMessagesByConvoId` entries.
 */
export const pendingSteersByConvoId: Family<PendingSteer[]> = atomFamily(
  (_conversationId: string) => atom<PendingSteer[]>([]),
);

/**
 * Server steer ids whose `on_steer_applied` event already landed. The 202 ACK
 * and the SSE ride different connections, so the applied event can arrive
 * FIRST; the ACK handler checks this set and drops its local chip instead of
 * minting a `pending` chip whose only removal event has already passed. A late
 * ACK can land after the run's final event, so the set is capped
 * (`appendAppliedSteerIds`), never cleared.
 */
export const appliedSteerIdsByConvoId: Family<string[]> = atomFamily((_conversationId: string) =>
  atom<string[]>([]),
);

/** Optimistic ids the server has proven accepted via ACK or SYNC. Separate
 * from `appliedSteerIdsByConvoId`: accepted-but-still-queued steers must not
 * be suppressed by terminal conversion, but a late POST error must not
 * resurrect them after Cancel/Edit/Convert removes the visible chip. */
export const acceptedSteerClientIdsByConvoId: Family<string[]> = atomFamily(
  (_conversationId: string) => atom<string[]>([]),
);

/** Server generation epoch currently attached for each conversation. Stream
 * ids are conversation-scoped and reused by later turns; every mutation that
 * can affect a live run carries this value as an optimistic concurrency fence. */
export const activeGenerationCreatedAtByConvoId: Family<number | null> = atomFamily(
  (_conversationId: string) => atom<number | null>(null),
);

/** Negotiated behavior contract for the active generation. Missing echoes are
 * legacy by definition, so the safe default is always v1. */
export const activeGenerationProtocolVersionByConvoId: Family<GenerationProtocolVersion> =
  atomFamily((_conversationId: string) => atom<GenerationProtocolVersion>(1));

const clearFamily = <Param>(family: {
  getParams(): Iterable<Param>;
  remove(param: Param): void;
}) => {
  for (const param of [...family.getParams()]) {
    family.remove(param);
  }
};

/** Drops every per-conversation steer atom, so the next read of any key starts from its
 *  default. Isolates tests that share the default store. */
export function resetSteerFamilies(): void {
  clearFamily(escalatingSteerFamily);
  clearFamily(revealedQueuedTurnFamily);
  clearFamily(pendingSteerCancelClientIdsFamily);
  clearFamily(liveAppliedSteerFamily);
  clearFamily(pendingSteersByConvoId);
  clearFamily(appliedSteerIdsByConvoId);
  clearFamily(acceptedSteerClientIdsByConvoId);
  clearFamily(activeGenerationCreatedAtByConvoId);
  clearFamily(activeGenerationProtocolVersionByConvoId);
}
