import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TMessage } from 'librechat-data-provider';
import type { PendingSteer } from '../../core/steer/types';
import type { Family } from './family';

/* The per-conversation steer families a queued row reads. Kept apart from the module-scope atoms
 * in `./atoms` so the composer components can read them without creating a store atom when
 * their module loads. */

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

/**
 * Per-conversation steers awaiting injection. Reconciled against the server:
 * `on_steer_applied` removes its chip; `sync`/`resumeState.pendingSteers`
 * replaces the list on reconnect; run-end reports convert leftovers into
 * `queuedMessagesByConvoId` entries.
 */
export const pendingSteersByConvoId: Family<PendingSteer[]> = atomFamily(
  (_conversationId: string) => atom<PendingSteer[]>([]),
);
