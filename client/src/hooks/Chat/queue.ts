import { atom } from 'jotai';
import { atomFamily, RESET } from 'jotai/utils';
import type { TMessage } from 'librechat-data-provider';
import type { PrimitiveAtom } from 'jotai';
import type { GenerationProtocolVersion } from '~/data-provider/SSE/protocol';

/**
 * A steer message submitted mid-run. Server truth: `sending` covers the POST
 * in flight, `pending` means the server queued it (awaiting its injection
 * boundary — the next tool batch, or the next safe token boundary when
 * `preempt` was armed), `failed` keeps the text recoverable after a rejected
 * POST. The chip disappears when `on_steer_applied` lands (the inline content
 * part becomes the durable record).
 */
export type PendingSteer = {
  steerId: string;
  /** Optimistic id echoed by server state when SYNC beats the POST callback. */
  clientSteerId?: string;
  text: string;
  status: 'sending' | 'pending' | 'failed';
  /** The transport failed without a definitive server rejection. The durable
   * enqueue may have committed. Same-id Retry is safe only under protocol v2;
   * edit/queue/remove stay hidden until ownership is resolved. */
  deliveryUncertain?: boolean;
  /** Protocol selected for the generation that owns this attempt. */
  generationProtocolVersion?: GenerationProtocolVersion;
  createdAt: number;
  /** Attachments steered with the message (refs; already uploaded). */
  files?: TMessage['files'];
  /** Quoted excerpts riding this steer (also sent on the POST — the server
   *  merges them into the injected turn); kept on the chip so a steer that
   *  never injects restores onto the queued item with them intact. */
  quotes?: string[];
  /** Manual skill picks, carried for restoration only (a skill pick
   *  configures a NEW turn's run, so it never rides the steer POST). */
  manualSkills?: string[];
  /** Full-generation setting carried for restoration only; it cannot alter a live steer. */
  reasoningOverride?: TMessage['reasoningOverride'];
  /** Asked the run to seal generation at the next safe boundary rather than
   *  wait for a tool step. Labelling only — the server owns the behaviour and
   *  echoes what it actually armed. */
  preempt?: boolean;
  /** Monotonic server revision; delayed ACKs cannot undo SSE corrections. */
  preemptRevision?: number;
  /** Exact server generation this steer belongs to. Conversation ids are
   * reused by later turns, so retries/arm/cancel must retain this epoch rather
   * than mutating whatever generation currently occupies the conversation. */
  generationCreatedAt?: number;
  /** Exact client queue identity/order to restore if this accepted steer is
   *  returned as a terminal leftover before injection. */
  queuedOrigin?: QueuedMessageOrigin;
};

/** A message composed during a run, queued to send after it finishes.
 *  Attachments ride the queued item (already uploaded at attach time) and are
 *  passed to `ask` as `overrideFiles` on drain — steering itself is text-only,
 *  so any during-run submit with media routes here as one unit. */
export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  /** Server authority for an Agent queued turn. Absence means the row remains
   * on the legacy mounted-client drain path (including a definite old-server
   * fallback). `uncertain` is deliberately still server-owned: falling back
   * after an ambiguous POST could submit the same words twice. */
  server?: {
    id?: string;
    status: 'sending' | 'uncertain' | 'indeterminate' | 'rejected' | 'queued' | 'claimed';
    errorCode?: string;
    errorMessage?: string;
    /** Observation time for a transport-ambiguous enqueue. The logical item
     * may be much older than the request that just became uncertain. */
    uncertainSince?: number;
    /** The bounded reconciliation window elapsed without authoritative
     * evidence. The outcome remains ambiguous and must never become resendable. */
    reconciliationExpired?: boolean;
    /** Current one-based projection; server sequence remains the stable
     * fallback when predecessors settle and positions close up. */
    position?: number;
    revision?: number;
  };
  /** A row the run-end drain must not submit on its own. Set when a steer the
   * server REJECTED is swept into the queue so its words stay recoverable:
   * the failure surface offers Retry and "Send as new", and auto-sending here
   * would start a turn the user never asked for with text that was refused. */
  needsExplicitSend?: boolean;
  /** Set when the user chose "Disable Queue" on this row, so only that choice can undo the hold. */
  heldByUser?: boolean;
  /** Stable identity for server enqueue/retry. Recovered steer rows also use
   * it to dismiss their parked source; a later recovery attempt gets a fresh
   * identity. */
  clientRequestId?: string;
  /** Exact visible branch leaf captured when this turn entered the server
   * queue. The server revalidates it before admitting the fresh successor. */
  parentMessageId?: string;
  /** Correlation used only to durably dismiss/reclaim the parked source. */
  recoveryClientSteerId?: string;
  recoverySteerId?: string;
  /** Generation observed before this queued follow-up became eligible. */
  expectedPredecessorCreatedAt?: number;
  files?: TMessage['files'];
  /** Quote chips consumed from the composer at enqueue time; passed to `ask`
   *  as `overrideQuotes` on drain so they pair with THIS message. */
  quotes?: string[];
  /** Manual skill picks consumed from the composer at enqueue time; passed
   *  to `ask` as `overrideManualSkills` on drain. */
  manualSkills?: string[];
  /** Request-scoped reasoning setting captured when this item was queued. */
  reasoningOverride?: TMessage['reasoningOverride'];
  /** Front-inserted by "Interrupt & send": stays ahead of chronologically
   *  older items when leftover steers are merged back into the queue. */
  priority?: boolean;
};

/** Snapshot of a queued item's logical position while it is temporarily sent
 * into a live run. Neighbour ids make restoration resilient to concurrent
 * drains and sends without minting a replacement item. */
export type QueuedMessageOrigin = {
  item: QueuedMessage;
  beforeIds: string[];
  afterIds: string[];
};

export type SettledQueuedTurnReceipt = {
  clientRequestId: string;
  status: 'admitted' | 'admitted_pending_boundary' | 'indeterminate' | 'cancelled' | 'dead';
  effectivePredecessorCreatedAt?: number;
  rootPredecessor?: true;
  boundaryConsumed?: boolean;
};

/**
 * One-shot run-termination signal written by the SSE final/error handlers and
 * consumed (reset to null) by `useQueueDrain`. Keyed by chat index like
 * `isSubmittingFamily`. Carrying the outcome lets the drain skip auto-send on
 * user aborts/errors while `startedAsNewConvo` migrates a queue keyed under
 * `Constants.NEW_CONVO` to the real conversation id.
 */
export type RunEnd = {
  conversationId: string | null;
  outcome: 'completed' | 'aborted' | 'error';
  startedAsNewConvo?: boolean;
  endedAt: number;
  /** Exact terminal epoch whose idle transition may release one queued start. */
  generationCreatedAt?: number;
  /** The completed run's response, which a revealed queued follow-up parents to. */
  responseMessageId?: string;
  /** Armed "Interrupt & send" flag traveling with a PARKED signal, so
   *  another run on the same pane can neither consume nor clear it. */
  interruptArmed?: boolean;
};

export type DrainAfterAbort = {
  conversationId: string;
  generationCreatedAt: number;
};

/**
 * Per-conversation client-side queue of follow-up messages. Drained one per
 * run completion by `useQueueDrain` (each dequeued message starts a normal
 * turn whose own final event drains the next).
 */
export const queuedMessagesByConvoId = atomFamily((_conversationId: string) =>
  atom<QueuedMessage[]>([]),
);

/** Monotonic client knowledge of terminal server queue receipts. Admission
 * records preserve boundary multiplicity by request identity. Other terminal
 * records exist only while their original enqueue callback is outstanding. */
export const settledQueuedTurnReceiptsByConvoId = atomFamily((_conversationId: string) =>
  atom<SettledQueuedTurnReceipt[]>([]),
);

/** Enqueue callbacks that can still race newer GET/cancellation evidence.
 * Entries retire as soon as that one callback settles. */
export const pendingQueuedTurnEnqueueIdsByConvoId = atomFamily((_conversationId: string) =>
  atom<string[]>([]),
);

/** The oldest terminal epoch in a queue of them, behind the nullable one-shot API stream writers
 * use: writing a signal appends it, writing `null` consumes only the visible (oldest) one, and
 * `RESET` clears them all. */
const runEndQueue = (signals: PrimitiveAtom<RunEnd[]>) =>
  atom(
    (get) => get(signals)[0] ?? null,
    (_get, set, value: RunEnd | null | typeof RESET) => {
      if (value === RESET) {
        set(signals, []);
        return;
      }
      if (value == null) {
        set(signals, (prev) => prev.slice(1));
        return;
      }
      set(signals, (prev) => [...prev, value]);
    },
  );

/** A pane can receive A's terminal frame after the user has navigated to and
 * started B. Keep each terminal epoch until the queue drain has either parked
 * or consumed it; a single replaceable slot loses A when B finishes first. */
const runEndsByIndex = atomFamily((_index: string | number) => atom<RunEnd[]>([]));

/** One-shot run-termination signal for a pane, written by the SSE final/error handlers and
 * consumed by `useQueueDrain`. */
export const runEndByIndex = atomFamily((index: string | number) =>
  runEndQueue(runEndsByIndex(index)),
);

/** Foreign terminal epochs are moved off the shared pane immediately. This
 * per-conversation carrier is queued for the same reason as the pane carrier:
 * successive epochs cannot overwrite one another while the chat is hidden. */
const pendingRunEndsByConvoId = atomFamily((_conversationId: string) => atom<RunEnd[]>([]));

export const pendingRunEndByConvoId = atomFamily((conversationId: string) =>
  runEndQueue(pendingRunEndsByConvoId(conversationId)),
);

/**
 * One-shot override armed by "interrupt & send": the next `aborted` run-end
 * for the exact conversation generation drains the queue exactly once (a
 * plain Stop press leaves queued chips for manual send). `false` remains the
 * clear value used by stream reconciliation paths.
 */
export const drainAfterAbortByIndex = atomFamily((_index: string | number) =>
  atom<DrainAfterAbort | false>(false),
);

const clearFamily = <Param>(family: {
  getParams(): Iterable<Param>;
  remove(param: Param): void;
}) => {
  for (const param of [...family.getParams()]) {
    family.remove(param);
  }
};

/** Drops every per-key queue atom, so the next read of any key starts from its default. Isolates
 *  tests that share the default store. */
export function resetQueueFamilies(): void {
  clearFamily(queuedMessagesByConvoId);
  clearFamily(settledQueuedTurnReceiptsByConvoId);
  clearFamily(pendingQueuedTurnEnqueueIdsByConvoId);
  clearFamily(pendingRunEndsByConvoId);
  clearFamily(pendingRunEndByConvoId);
  clearFamily(drainAfterAbortByIndex);
  clearFamily(runEndsByIndex);
  clearFamily(runEndByIndex);
}
