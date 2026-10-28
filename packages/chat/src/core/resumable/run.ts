import type { TSubmission } from 'librechat-data-provider';

/** A pending timer, as the scheduler that set it returns it. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * The clock and frame source a resumable run waits on. The browser supplies its globals; a test
 * or another runtime supplies its own.
 */
export interface ResumableScheduler {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  now: () => number;
}

/** The browser's timers and animation frames. */
export const browserScheduler: ResumableScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  now: () => Date.now(),
};

/**
 * What one chat pane knows about the generation it is attached to, across every submission and
 * reconnect: the live connection and its retry ladder, the submission it serves, the stream ids
 * it created optimistically, and the frame retries still waiting on a response placeholder.
 * The pane owns one for its lifetime; every subscription reads and fences against it.
 */
export class ResumableRun {
  /** Closes the live connection; replaced by every subscription. */
  stream: AbortController | null = null;
  /** Removes the foreground re-attach listener owned by the newest subscription; exactly one
   *  is registered at a time. */
  stopForegroundReattach: (() => void) | null = null;
  reconnectAttempt = 0;
  reconnectTimeout: TimerHandle | null = null;
  /** The submission this pane serves; a subscription whose submission is no longer this one is
   *  stale. */
  submission: TSubmission | null = null;
  /** Suppresses the normal close/cleanup idle transition while a stale generation is being
   *  atomically handed off to its live replacement. */
  replacementHandoff = false;
  readonly optimisticStreamIds: Set<string> = new Set();
  readonly createdStreamIds: Set<string> = new Set();
  /** Pending action whose tool-call content part hasn't rendered yet, retried on the next frame
   *  so a fast pause-before-render race still attaches. */
  pendingActionRetry: number | null = null;
  /** EVERY steer retry frame, not only the newest one. Several steers can be applied before
   *  their shared response placeholder renders; retaining one handle let the older chains
   *  outlive navigation/terminal cleanup and mutate a later generation that reused the same
   *  response id. */
  readonly steerRetryFrames: Set<number> = new Set();
  /** EVERY outstanding label-retry frame, not a single handle: labels fire two events per slot
   *  (reservation, then fill), so concurrent retry chains are the norm: a single handle would
   *  let cleanup cancel only the newest chain while the others kept running for up to 120
   *  frames and could apply a stale label to a replacement generation that reuses the same
   *  response id (edits do). */
  readonly activityLabelRetryFrames: Set<number> = new Set();
  /**
   * Set once a SYNC has replaced the response with the server's completion-local snapshot,
   * which discards the prefix an edited resubmission retained. From that point incoming indices
   * are absolute and `editPrefixLength` must no longer be applied, by run steps or labels.
   */
  editPrefixCleared = false;
  editPrefixFirstPartFolded = false;
  /** Generation the cleared-prefix state above belongs to, so it is dropped when a new
   *  generation starts rather than when a subscribe happens to be live. */
  prefixStateGenerationId: string | null = null;
  /** The generation epoch the pane's stream is attached to, kept so a run left mid-stream can
   *  carry it. A server that reports no epoch leaves it unset. */
  subscribedEpoch: number | null = null;
  /** Whether the current submission's run end already reached the queue drain. A run that
   *  ended attached must not also be resolved as detached when the user later leaves. */
  runEndPublished = false;
  /** Whether the server named the current submission's user message (`created`, or a resume's
   *  sync). Only a run whose identity it confirmed is remembered when the user leaves. */
  identityConfirmed = false;

  constructor(readonly scheduler: ResumableScheduler = browserScheduler) {}

  /** Drops the backoff still waiting to re-attach, if any. */
  clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      this.scheduler.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  cancelSteerRetryFrames(): void {
    for (const frameId of this.steerRetryFrames) {
      this.scheduler.cancelFrame(frameId);
    }
    this.steerRetryFrames.clear();
  }

  /** Cancels every frame retry still waiting on a response placeholder. */
  cancelRetryFrames(): void {
    if (this.pendingActionRetry != null) {
      this.scheduler.cancelFrame(this.pendingActionRetry);
      this.pendingActionRetry = null;
    }
    for (const frameId of this.activityLabelRetryFrames) {
      this.scheduler.cancelFrame(frameId);
    }
    this.activityLabelRetryFrames.clear();
    this.cancelSteerRetryFrames();
  }

  /**
   * A NEW generation starts with its retained prefix intact, so the cleared-prefix state from a
   * previous one must not carry over. Keyed on the submission's `clientRequestId`, which is new
   * per edit attempt and stable across reconnects.
   */
  bindPrefixState(generationId: string): void {
    if (this.prefixStateGenerationId === generationId) {
      return;
    }
    this.prefixStateGenerationId = generationId;
    this.editPrefixCleared = false;
    this.editPrefixFirstPartFolded = false;
  }

  /** Forgets a stream once its run has ended. */
  releaseStream(streamId: string): void {
    this.optimisticStreamIds.delete(streamId);
    this.createdStreamIds.delete(streamId);
  }
}
