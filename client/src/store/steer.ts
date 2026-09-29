import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TMessage } from 'librechat-data-provider';

/**
 * Measured pixel height of the in-flight steer overlay for a conversation.
 * The overlay floats above the composer over the bottom of the message scroll
 * area; the messages reserve an equal band of bottom padding (see
 * `MessagesView`) so the newest message clears it at rest and older messages
 * scroll behind it. `InFlightSteers` publishes its height here and resets it to
 * 0 on unmount, so the entry is never stale — the atomFamily is not GC'd, but
 * each holds a single number per visited conversation.
 */
export const steerOverlayHeightFamily = atomFamily((_conversationId: string) => atom<number>(0));

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
