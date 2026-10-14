import { atom } from 'jotai';
import { atomFamily, RESET } from 'jotai/utils';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { PrimitiveAtom, Getter } from 'jotai';
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

export const detachedRunByConvoId = atomFamily((_conversationId: string) =>
  atom<DetachedRun | null>(null),
);

/** The run the user pressed Stop on, named by its generation epoch. A stopped run's response
 *  persists like a completed one, so a run stopped and then left before its abort event arrived
 *  must not be resolved as detached and drain the queue. Only a different run resets it, so a
 *  stopped run the user leaves, reattaches to and leaves again stays stopped. */
export type StoppedRun = { generationCreatedAt: number };

export const stopRequestedByConvoId = atomFamily((_conversationId: string) =>
  atom<StoppedRun | null>(null),
);

/** Whether a Stop marker belongs to the run with this epoch. */
export function isStoppedRun(stopped: StoppedRun | null, generationCreatedAt: number): boolean {
  return stopped?.generationCreatedAt === generationCreatedAt;
}

/** Whether a detached run's end must be left for a manual send instead of read from history, which
 *  retires its marker: the user stopped it, and a stopped response persists like a completed one
 *  (a stopped compaction even settles with `unfinished: false`). */
export function isDetachedRunManual(
  get: Getter,
  conversationId: string,
  run: DetachedRun,
): boolean {
  return isStoppedRun(get(stopRequestedByConvoId(conversationId)), run.generationCreatedAt);
}

/** A compaction's outcome is the part the server stamps `initiatedBy: 'user'`. One that ended
 *  without a usable summary persists the same failed summary or error part whether it failed or
 *  was stopped, from this tab or another, and is settled rather than `unfinished`; history cannot
 *  tell which, so it never drains the queue. Failed rounds of an ordinary run carry no stamp, and
 *  a usable summary means the compaction succeeded. */
const endedWithoutSummary = (message: TMessage): boolean => {
  if (!Array.isArray(message.content)) {
    return false;
  }
  let failed = false;
  for (const part of message.content) {
    if (part?.type === ContentTypes.SUMMARY && part.initiatedBy === 'user') {
      if (part.failed !== true) {
        return false;
      }
      failed = true;
    } else if (part?.type === ContentTypes.ERROR && part.initiatedBy === 'user') {
      failed = true;
    }
  }
  return failed;
};

const writtenAt = (message: TMessage): number => {
  const stamp = message.updatedAt ?? message.createdAt;
  return stamp == null ? Number.NaN : Date.parse(stamp);
};

/**
 * The run end a detached run implies, read from persisted history: `completed` lets the queue
 * drain, while a stopped (`unfinished`) or failed response leaves the queue for a manual send, as
 * it would had the stream been attached. Only a response the server wrote at or after the run's
 * epoch can be its response, which rules out any row the run never touched. Returns `null` while
 * no such response is persisted, so nothing is drained on a guess.
 */
export function resolveDetachedRunEnd(
  conversationId: string,
  run: DetachedRun,
  messages: TMessage[] | undefined,
): RunEnd | null {
  const epoch = run.generationCreatedAt;
  const responses = (messages ?? []).filter(
    (message) =>
      message.isCreatedByUser === false &&
      message.parentMessageId === run.userMessageId &&
      writtenAt(message) >= epoch,
  );
  /** A fresh turn's placeholder is the user message id padded with `_`, which names no response;
   *  a real id is matched exactly first, since persisted ids may themselves end in `_`. */
  const exact = run.responseMessageId;
  const unpadded = exact?.replace(/_+$/, '');
  const namesResponse = exact != null && unpadded !== run.userMessageId;
  let response: TMessage | undefined;
  if (namesResponse) {
    response =
      responses.find((message) => message.messageId === exact) ??
      responses.find((message) => message.messageId === unpadded);
  }
  if (response == null && !namesResponse && responses.length === 1) {
    response = responses[0];
  }
  if (response == null) {
    return null;
  }
  let outcome: RunEnd['outcome'] = 'completed';
  if (response.error === true) {
    outcome = 'error';
  } else if (response.unfinished === true || endedWithoutSummary(response)) {
    outcome = 'aborted';
  }
  return {
    conversationId,
    outcome,
    endedAt: Date.now(),
    generationCreatedAt: epoch,
    ...(outcome === 'completed' && { responseMessageId: response.messageId }),
  };
}

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
  clearFamily(detachedRunByConvoId);
  clearFamily(stopRequestedByConvoId);
}
