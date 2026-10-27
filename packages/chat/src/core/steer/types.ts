import type { TMessage } from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '../protocol';

/**
 * A steer message submitted mid-run. Server truth: `sending` covers the POST
 * in flight, `pending` means the server queued it (awaiting its injection
 * boundary: the next tool batch, or the next safe token boundary when
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
  /** Quoted excerpts riding this steer (also sent on the POST; the server
   *  merges them into the injected turn); kept on the chip so a steer that
   *  never injects restores onto the queued item with them intact. */
  quotes?: string[];
  /** Manual skill picks, carried for restoration only (a skill pick
   *  configures a NEW turn's run, so it never rides the steer POST). */
  manualSkills?: string[];
  /** Full-generation setting carried for restoration only; it cannot alter a live steer. */
  reasoningOverride?: TMessage['reasoningOverride'];
  /** Asked the run to seal generation at the next safe boundary rather than
   *  wait for a tool step. Labelling only; the server owns the behaviour and
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
 *  passed to `ask` as `overrideFiles` on drain. Steering itself is text-only,
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

/** The host's `ask`, as the drain calls it to send one queued message as a new turn. The
 *  overrides carry everything the message was queued with, so `ask` does not take what the
 *  composer has staged for the user's next message instead. Returns `false` when it refused
 *  without sending, which puts the message back in the queue. */
export type QueuedTurnAsk = (
  props: { text: string; overrideUserMessageId?: string },
  options: {
    overrideFiles: NonNullable<QueuedMessage['files']>;
    overrideQuotes: string[];
    overrideManualSkills: string[];
    overrideReasoning: QueuedMessage['reasoningOverride'] | null;
    overrideClientRequestId?: string;
    overrideRecoverySteerId?: string;
    overrideExpectedPredecessorCreatedAt?: number;
    overrideQueuedMessageOrigin?: QueuedMessageOrigin;
  },
) => false | void;

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

/** A run whose stream this pane closed while it was still generating, because the user left its
 *  chat. The server keeps going and deletes the job once it finishes, so the run's end is learned
 *  from the persisted response when the user comes back instead of from the stream. Only a run
 *  whose identity the server confirmed is remembered: its epoch, and the user message `created`
 *  or a resume's sync named. A run left before then, a regeneration (whose new reply history
 *  cannot tell from the one it replaces), or a run on a server that reports no epoch is not, and
 *  its follow-up waits for a manual send. */
export type DetachedRun = {
  /** The user message the run answers, as the server named it. */
  userMessageId: string;
  /** The response placeholder's id, when the submission carried one. */
  responseMessageId?: string;
  /** The run's generation epoch. It dates the run's response and lets the queue drain match
   *  server admission receipts. */
  generationCreatedAt: number;
};

/** The run the user pressed Stop on, named by its generation epoch. A stopped run's response
 *  persists like a completed one, so a run stopped and then left before its abort event arrived
 *  must not be resolved as detached and drain the queue. Only a different run resets it, so a
 *  stopped run the user leaves, reattaches to and leaves again stays stopped. */
export type StoppedRun = { generationCreatedAt: number };

/** Composer state consumed into a queued item alongside the text. */
export interface QueuedMessageContext {
  quotes?: string[];
  manualSkills?: string[];
  reasoningOverride?: TMessage['reasoningOverride'];
  clientRequestId?: string;
  recoverySteerId?: string;
  expectedPredecessorCreatedAt?: number;
  queuedMessageOrigin?: QueuedMessageOrigin;
}
