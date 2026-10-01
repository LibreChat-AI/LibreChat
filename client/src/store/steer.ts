import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TMessage } from 'librechat-data-provider';

/**
 * Set synchronously before a bubble's arm request and cleared on settlement.
 * Purely a UX gate: with the atomic in-place arm, a double-arm is harmless
 * server-side (the run seals once and drains the whole queue in order), but
 * every escalation control advertises "one interrupt at a time" by disabling,
 * and the chip-derived check cannot see an arm until its response lands.
 */
export const escalatingSteerFamily = atomFamily((_conversationId: string) => atom<boolean>(false));

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

export const revealedQueuedTurnFamily = atomFamily((_conversationId: string) =>
  atom<RevealedQueuedTurn | null>(null),
);

/** Client ids cancelled before the steer POST receives its authoritative id. */
export const pendingSteerCancelClientIdsFamily = atomFamily((_conversationId: string) =>
  atom<string[]>([]),
);

/**
 * Steer ids whose applied event landed in THIS session, pending their one-shot
 * receipt draw-in. `SteerPart` consumes its id on mount so the animation plays
 * exactly once, at the live chip to inline hand-off, never on reload, share, or
 * a later revisit. Global rather than per-conversation: steer ids are unique,
 * and the applied part renders in surfaces that don't know their convo id. */
export const liveAppliedSteerIdsAtom = atom<string[]>([]);

/** Membership view of `liveAppliedSteerIdsAtom` so each `SteerPart` subscribes to
 *  its own id only: stamping/consuming one steer re-renders that part, not
 *  every mounted historical part in a long conversation. */
export const liveAppliedSteerFamily = atomFamily((steerId: string) =>
  atom((get) => steerId.length > 0 && get(liveAppliedSteerIdsAtom).includes(steerId)),
);
