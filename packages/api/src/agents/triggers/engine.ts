import { randomUUID } from 'node:crypto';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { logger, runAsSystem } from '@librechat/data-schemas';
import type { AgentTriggerExecutionResult } from './host';
import { createAgentTriggerBatchEnvelope } from './batch';
import { AgentTriggerDispatchError } from './dispatch';
import { AgentTriggerExecutionError } from './host';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_CAP_MS = 5 * 60_000;
const DEFAULT_TICK_MS = 1_000;
const DEFAULT_MAX_IDLE_TICK_MS = 15_000;
const ORDERING_RECHECK_MS = 250;
const ACTIVE_HANDLING_RECHECK_MS = 5_000;
const DEFAULT_DEFER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const MAX_FAILURE_CODE_LENGTH = 128;
const MAX_FAILURE_MESSAGE_LENGTH = 2048;

function startedHandling(
  delivery: Pick<AgentTriggerDeliveryRecord, 'envelope'>,
  result: AgentTriggerExecutionResult,
  startedAt: Date,
): AgentTriggerDeliveryRecord['handling'] | undefined {
  const envelope = delivery.envelope;
  if (
    envelope == null ||
    typeof envelope !== 'object' ||
    !('mode' in envelope) ||
    envelope.mode !== 'continue' ||
    !('target' in envelope) ||
    envelope.target == null ||
    typeof envelope.target !== 'object' ||
    !('bindingId' in envelope.target) ||
    result.mode !== 'continue' ||
    result.status === 'settled' ||
    result.streamId == null ||
    result.generationCreatedAt == null
  ) {
    return undefined;
  }
  return {
    status: 'started',
    conversationId: result.conversationId,
    streamId: result.streamId,
    generationCreatedAt: result.generationCreatedAt,
    startedAt,
  };
}

/** A pre-dispatch condition that must not consume the delivery's retry budget. */
export class AgentTriggerDeliveryDeferredError extends Error {
  readonly delayMs: number;

  constructor(message: string, delayMs: number = DEFAULT_DEFER_MS) {
    super(message);
    this.name = 'AgentTriggerDeliveryDeferredError';
    this.delayMs = positiveInteger(delayMs, DEFAULT_DEFER_MS, 'delayMs');
  }
}

export type AgentTriggerDeliveryStatus =
  | 'staging'
  | 'capability_staging'
  | 'batched'
  | 'pending'
  | 'capability_pending'
  | 'leased'
  | 'capability_leased'
  | 'succeeded'
  | 'capability_dead'
  | 'dead';

export interface AgentTriggerDeliveryFailure {
  code: string;
  message: string;
  certainty: 'definite' | 'ambiguous';
  retryable: boolean;
  attemptedAt: Date;
  status?: number;
}

export interface AgentTriggerDeliveryRecord {
  id: string;
  user: string;
  claimToken: string;
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  laneSequence: number;
  envelope: unknown;
  status: AgentTriggerDeliveryStatus;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  envelopeBytes?: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  batchSize?: number;
  batchBytes?: number;
  batchMemberIds?: Array<{ toString(): string } | string>;
  batchRootId?: { toString(): string } | string;
  batchMembersSettledAt?: Date;
  awaitTerminalHandling?: boolean;
  leaseBy?: string;
  leaseUntil?: Date;
  lastError?: AgentTriggerDeliveryFailure;
  handling?: {
    status: 'started' | 'applied' | 'completed_no_action' | 'failed' | 'cancelled';
    conversationId: string;
    streamId: string;
    generationCreatedAt: number;
    startedAt: Date;
    settledAt?: Date;
    error?: string;
    action?: { toolName: string; toolCallId?: string };
  };
}

export interface AgentTriggerOrderingBlock {
  availableAt: Date;
  leaseUntil?: Date;
  reason?: 'active_handling';
}

export interface AgentTriggerDeliveryStore {
  claimNext: (input: {
    workerId: string;
    claimToken: string;
    now: Date;
    leaseUntil: Date;
  }) => Promise<AgentTriggerDeliveryRecord | null>;
  findEarlierUnsettled: (
    delivery: AgentTriggerDeliveryRecord,
  ) => Promise<AgentTriggerOrderingBlock | null>;
  getBatch: (
    delivery: Pick<AgentTriggerDeliveryRecord, 'id' | 'batchMemberIds'>,
  ) => Promise<Array<Pick<AgentTriggerDeliveryRecord, 'id' | 'deliveryKey' | 'envelope'>>>;
  release: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    availableAt: Date;
  }) => Promise<boolean>;
  beginAttempt: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    now: Date;
  }) => Promise<number | null>;
  defer: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    attempt: number;
    availableAt: Date;
  }) => Promise<boolean | 'expedited'>;
  complete: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    attempt: number;
    result: AgentTriggerExecutionResult;
    settledAt: Date;
    handling?: AgentTriggerDeliveryRecord['handling'];
    awaitTerminalHandling?: true;
  }) => Promise<boolean>;
  retry: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    attempt: number;
    error: AgentTriggerDeliveryFailure;
    availableAt: Date;
  }) => Promise<boolean>;
  dead: (input: {
    id: string;
    workerId: string;
    claimToken: string;
    attempt: number;
    error: AgentTriggerDeliveryFailure;
    settledAt: Date;
    receiptRetryAt?: Date;
  }) => Promise<boolean>;
}

export interface AgentTriggerDeliveryEngineOptions {
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  tickMs?: number;
  /** Ceiling for the poll interval while the queue stays empty; any wake or claimed
   *  delivery snaps polling back to `tickMs`, so only true idleness ever waits this long. */
  maxIdleTickMs?: number;
}

export interface AgentTriggerDeliveryEngineDeps {
  store: AgentTriggerDeliveryStore;
  dispatch: (
    envelope: unknown,
    options?: { signal?: AbortSignal; attempt?: number; maxAttempts?: number },
  ) => Promise<AgentTriggerExecutionResult>;
  /** Source-owned terminalization must commit before its delivery can become
   * dead, including recovery after a crash that exhausted the attempt budget. */
  settleSourceBeforeDeadLetter?: (
    envelope: unknown,
    failure: AgentTriggerDeliveryFailure,
  ) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  workerId?: string;
}

interface ClaimPassResult {
  count: number;
  processing: Promise<void>[];
  claimFailed?: boolean;
}

export interface AgentTriggerDeliveryEngine {
  start: () => void;
  /** Registers a future eligibility time so the idle poll never sleeps past it. */
  noteEligibleAt: (at: Date) => void;
  stop: () => Promise<void>;
  cancelUser: (userId: string) => Promise<void>;
  releaseUserCancellation: (userId: string) => void;
  wake: () => void;
  runTick: () => Promise<number>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function failure(error: unknown, attemptedAt: Date): AgentTriggerDeliveryFailure {
  if (error instanceof AgentTriggerExecutionError) {
    return {
      code: error.code ?? 'DELIVERY_REJECTED',
      message: error.message,
      certainty: error.certainty,
      retryable: error.retryable,
      attemptedAt,
      ...(error.status != null && { status: error.status }),
    };
  }
  if (error instanceof AgentTriggerDispatchError) {
    return {
      code: 'INVALID_ENVELOPE',
      message: error.message,
      certainty: 'definite',
      retryable: false,
      attemptedAt,
    };
  }
  return {
    code: 'DELIVERY_FAILED',
    message: error instanceof Error ? error.message : String(error),
    certainty: 'definite',
    retryable: true,
    attemptedAt,
  };
}

function normalizeFailure(failure: AgentTriggerDeliveryFailure): AgentTriggerDeliveryFailure {
  const code = failure.code.trim();
  const message = failure.message.trim();
  return {
    ...failure,
    code: (code.length === 0 ? 'DELIVERY_FAILED' : code).slice(0, MAX_FAILURE_CODE_LENGTH),
    message: (message.length === 0 ? 'Agent trigger delivery failed' : message).slice(
      0,
      MAX_FAILURE_MESSAGE_LENGTH,
    ),
  };
}

/** The delay an execution error asked for, as seconds or an HTTP date, clamped. */
function requestedRetryAfterMs(error: unknown, now: Date): number | undefined {
  if (!(error instanceof AgentTriggerExecutionError) || error.retryAfter == null) {
    return;
  }
  const seconds = Number(error.retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const absolute = Date.parse(error.retryAfter);
  if (Number.isFinite(absolute) && absolute > now.getTime()) {
    return Math.min(absolute - now.getTime(), MAX_RETRY_AFTER_MS);
  }
  return;
}

/** A readiness deferral may ask to wait longer than the default re-check, never
 * shorter: waiting producers back off by age, while every existing `retryAfter`
 * below the default keeps the cadence it has always had. */
function readinessDeferMs(error: unknown, now: Date): number {
  return Math.max(DEFAULT_DEFER_MS, requestedRetryAfterMs(error, now) ?? 0);
}

function retryAt(
  error: unknown,
  attempt: number,
  now: Date,
  baseMs: number,
  capMs: number,
  random: () => number,
): Date {
  const requestedMs = requestedRetryAfterMs(error, now);
  if (requestedMs != null) {
    return new Date(now.getTime() + requestedMs);
  }
  const exponent = Math.min(attempt - 1, 30);
  const delay = Math.min(baseMs * 2 ** exponent, capMs);
  return new Date(now.getTime() + Math.floor(delay / 2 + random() * (delay / 2)));
}

function isAccountDeletionDeferral(error: unknown): boolean {
  return (
    error instanceof AgentTriggerExecutionError &&
    error.code === 'ACCOUNT_DELETION_IN_PROGRESS' &&
    (error.status === 401 || error.status === 409)
  );
}

function isRuntimeReadinessDeferral(error: unknown): boolean {
  return error instanceof AgentTriggerExecutionError && error.deferWithoutAttempt;
}

/** Durable, lease-fenced delivery runner shared by every trusted event source. */
export function createAgentTriggerDeliveryEngine(
  deps: AgentTriggerDeliveryEngineDeps,
  options: AgentTriggerDeliveryEngineOptions = {},
): AgentTriggerDeliveryEngine {
  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY, 'concurrency');
  const leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, 'leaseMs');
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, 'retryBaseMs');
  const retryCapMs = positiveInteger(options.retryCapMs, DEFAULT_RETRY_CAP_MS, 'retryCapMs');
  const tickMs = positiveInteger(options.tickMs, DEFAULT_TICK_MS, 'tickMs');
  const maxIdleTickMs = Math.max(
    tickMs,
    positiveInteger(options.maxIdleTickMs, DEFAULT_MAX_IDLE_TICK_MS, 'maxIdleTickMs'),
  );
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const workerId = deps.workerId ?? `${process.pid}-${randomUUID()}`;
  const controllers = new Map<AbortController, string>();
  let idleStreak = 0;
  /** Future eligibility times this process has seen (sorted, deduplicated, bounded); the
   *  idle timer never sleeps past the earliest, so retries and defers are claimed when
   *  due, not when the backoff happens to wake. On overflow the latest deadline is
   *  dropped and that delivery degrades to idle-poll pickup, bounded by `maxIdleTickMs`
   *  — the same bound that covers deliveries delayed by other replicas. */
  const eligibleDeadlinesMs: number[] = [];
  const MAX_TRACKED_DEADLINES = 64;
  const processing = new Set<Promise<void>>();
  const processingByUser = new Map<string, Set<Promise<void>>>();
  const cancelledUsers = new Set<string>();
  let stopped = false;
  let started = false;
  let repumpRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let activeClaim: Promise<ClaimPassResult> | undefined;

  const processDelivery = async (delivery: AgentTriggerDeliveryRecord): Promise<void> => {
    const userId = String(delivery.user);
    if (cancelledUsers.has(userId)) {
      await deps.store.release({
        id: delivery.id,
        workerId,
        claimToken: delivery.claimToken,
        availableAt: now(),
      });
      return;
    }

    const block = await deps.store.findEarlierUnsettled(delivery);
    if (block != null) {
      const recheckAt =
        now().getTime() +
        (block.reason === 'active_handling' ? ACTIVE_HANDLING_RECHECK_MS : ORDERING_RECHECK_MS);
      const nextCheck =
        block.leaseUntil == null ? Math.max(recheckAt, block.availableAt.getTime()) : recheckAt;
      noteEligibleAt(new Date(nextCheck));
      await deps.store.release({
        id: delivery.id,
        workerId,
        claimToken: delivery.claimToken,
        availableAt: new Date(nextCheck),
      });
      return;
    }

    if (delivery.attempts >= maxAttempts) {
      const recorded = normalizeFailure(
        delivery.lastError ??
          failure(new Error('Delivery attempt limit was already exhausted'), now()),
      );
      try {
        await deps.settleSourceBeforeDeadLetter?.(delivery.envelope, recorded);
      } catch (error) {
        logger.error('[agent-triggers] source terminalization failed before dead-lettering', {
          deliveryKey: delivery.deliveryKey,
          error: error instanceof Error ? error.message : String(error),
        });
        await deps.store.release({
          id: delivery.id,
          workerId,
          claimToken: delivery.claimToken,
          availableAt: now(),
        });
        return;
      }
      const deadLettered = await deps.store.dead({
        id: delivery.id,
        workerId,
        claimToken: delivery.claimToken,
        attempt: delivery.attempts,
        error: recorded,
        settledAt: now(),
        ...(recorded.retryable && {
          receiptRetryAt: new Date(now().getTime() + retryCapMs),
        }),
      });
      if (deadLettered) {
        logger.error('[agent-triggers] delivery dead-lettered after exhausting retries', {
          deliveryKey: delivery.deliveryKey,
          attempts: delivery.attempts,
          code: recorded.code,
        });
      }
      return;
    }

    if (stopped) {
      await deps.store.release({
        id: delivery.id,
        workerId,
        claimToken: delivery.claimToken,
        availableAt: now(),
      });
      return;
    }

    if (cancelledUsers.has(userId)) {
      await deps.store.release({
        id: delivery.id,
        workerId,
        claimToken: delivery.claimToken,
        availableAt: now(),
      });
      return;
    }

    const attempt = await deps.store.beginAttempt({
      id: delivery.id,
      workerId,
      claimToken: delivery.claimToken,
      now: now(),
    });
    if (attempt == null) {
      return;
    }

    const controller = new AbortController();
    controllers.set(controller, userId);
    if (stopped || cancelledUsers.has(userId)) {
      controller.abort(new Error('Agent trigger delivery engine is stopping'));
    }
    try {
      let result: AgentTriggerExecutionResult;
      try {
        const members = await deps.store.getBatch(delivery);
        const dispatchEnvelope =
          members.length === 0
            ? delivery.envelope
            : createAgentTriggerBatchEnvelope(delivery, members);
        result = await deps.dispatch(dispatchEnvelope, {
          signal: controller.signal,
          attempt,
          maxAttempts,
        });
      } catch (error) {
        const attemptedAt = now();
        const deletionCancelled = controller.signal.aborted && cancelledUsers.has(userId);
        const deletionRejected = isAccountDeletionDeferral(error);
        const runtimeNotReady = isRuntimeReadinessDeferral(error);
        if (
          error instanceof AgentTriggerDeliveryDeferredError ||
          deletionCancelled ||
          deletionRejected ||
          runtimeNotReady
        ) {
          let delayMs = DEFAULT_DEFER_MS;
          if (error instanceof AgentTriggerDeliveryDeferredError) {
            delayMs = error.delayMs;
          } else if (runtimeNotReady) {
            delayMs = readinessDeferMs(error, attemptedAt);
          }
          const availableAt = new Date(attemptedAt.getTime() + delayMs);
          noteEligibleAt(availableAt);
          const deferred = await deps.store.defer({
            id: delivery.id,
            workerId,
            claimToken: delivery.claimToken,
            attempt,
            availableAt,
          });
          if (deferred) {
            let reason = 'pre_dispatch';
            if (deletionCancelled || deletionRejected) {
              reason = 'account_deletion';
            } else if (runtimeNotReady) {
              reason = 'runtime_readiness';
            }
            logger.info('[agent-triggers] delivery deferred without consuming an attempt', {
              deliveryKey: delivery.deliveryKey,
              reason,
              availableAt: availableAt.toISOString(),
            });
          }
          return;
        }
        const recorded = normalizeFailure(failure(error, attemptedAt));
        if (!recorded.retryable || attempt >= maxAttempts) {
          try {
            await deps.settleSourceBeforeDeadLetter?.(delivery.envelope, recorded);
          } catch (settlementError) {
            logger.error('[agent-triggers] source terminalization failed before dead-lettering', {
              deliveryKey: delivery.deliveryKey,
              error:
                settlementError instanceof Error
                  ? settlementError.message
                  : String(settlementError),
            });
            await deps.store.release({
              id: delivery.id,
              workerId,
              claimToken: delivery.claimToken,
              availableAt: attemptedAt,
            });
            return;
          }
          const deadLettered = await deps.store.dead({
            id: delivery.id,
            workerId,
            claimToken: delivery.claimToken,
            attempt,
            error: recorded,
            settledAt: attemptedAt,
            ...(recorded.retryable && {
              receiptRetryAt: new Date(attemptedAt.getTime() + retryCapMs),
            }),
          });
          if (deadLettered) {
            logger.error('[agent-triggers] delivery dead-lettered', {
              deliveryKey: delivery.deliveryKey,
              attempt,
              code: recorded.code,
              certainty: recorded.certainty,
            });
          }
          return;
        }
        const availableAt = retryAt(error, attempt, attemptedAt, retryBaseMs, retryCapMs, random);
        noteEligibleAt(availableAt);
        const retrying = await deps.store.retry({
          id: delivery.id,
          workerId,
          claimToken: delivery.claimToken,
          attempt,
          error: recorded,
          availableAt,
        });
        if (retrying) {
          logger.warn('[agent-triggers] delivery scheduled for retry', {
            deliveryKey: delivery.deliveryKey,
            attempt,
            code: recorded.code,
            certainty: recorded.certainty,
            availableAt: availableAt.toISOString(),
          });
        }
        return;
      }

      const settledAt = now();
      try {
        const handling = startedHandling(delivery, result, settledAt);
        await deps.store.complete({
          id: delivery.id,
          workerId,
          claimToken: delivery.claimToken,
          attempt,
          result,
          settledAt,
          ...(delivery.awaitTerminalHandling === true && { awaitTerminalHandling: true }),
          ...(handling != null && { handling }),
        });
      } catch (error) {
        const recorded: AgentTriggerDeliveryFailure = {
          code: 'RESULT_PERSISTENCE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          certainty: 'ambiguous',
          retryable: true,
          attemptedAt: settledAt,
        };
        const availableAt = retryAt(error, attempt, settledAt, retryBaseMs, retryCapMs, random);
        noteEligibleAt(availableAt);
        const retrying = await deps.store.retry({
          id: delivery.id,
          workerId,
          claimToken: delivery.claimToken,
          attempt,
          error: recorded,
          availableAt,
        });
        if (retrying) {
          logger.warn(
            '[agent-triggers] accepted delivery result could not be persisted; retrying',
            {
              deliveryKey: delivery.deliveryKey,
              attempt,
              availableAt: availableAt.toISOString(),
            },
          );
        }
      }
    } finally {
      controllers.delete(controller);
    }
  };

  const claimOne = (): Promise<AgentTriggerDeliveryRecord | null> => {
    const claimedAt = now();
    return deps.store.claimNext({
      workerId,
      claimToken: randomUUID(),
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + leaseMs),
    });
  };

  const runClaimPass = async (): Promise<ClaimPassResult> => {
    if (stopped) {
      return { count: 0, processing: [] };
    }
    const openSlots = concurrency - processing.size;
    if (openSlots <= 0) {
      return { count: 0, processing: [] };
    }

    const deliveries: AgentTriggerDeliveryRecord[] = [];
    try {
      const first = await claimOne();
      if (first == null) {
        return { count: 0, processing: [] };
      }
      deliveries.push(first);
    } catch (error) {
      logger.error('[agent-triggers] delivery claim failed:', error);
      return { count: 0, processing: [], claimFailed: true };
    }

    if (openSlots > 1) {
      const claimed = await Promise.allSettled(
        Array.from({ length: openSlots - 1 }, () => claimOne()),
      );
      for (const result of claimed) {
        if (result.status === 'fulfilled' && result.value != null) {
          deliveries.push(result.value);
        } else if (result.status === 'rejected') {
          logger.error('[agent-triggers] delivery claim failed:', result.reason);
        }
      }
    }

    const batch: Promise<void>[] = [];
    for (const delivery of deliveries) {
      const userId = String(delivery.user);
      const task = runAsSystem(() => processDelivery(delivery)).catch((error) => {
        logger.error('[agent-triggers] delivery processing failed:', error);
      });
      const tracked = task.finally(() => {
        processing.delete(tracked);
        const userProcessing = processingByUser.get(userId);
        userProcessing?.delete(tracked);
        if (userProcessing?.size === 0) {
          processingByUser.delete(userId);
        }
        if (started && !stopped) {
          queueMicrotask(wake);
        }
      });
      processing.add(tracked);
      const userProcessing = processingByUser.get(userId) ?? new Set<Promise<void>>();
      userProcessing.add(tracked);
      processingByUser.set(userId, userProcessing);
      batch.push(tracked);
    }
    return { count: deliveries.length, processing: batch };
  };

  const claimAvailable = (): Promise<ClaimPassResult> => {
    if (activeClaim != null) {
      return activeClaim;
    }
    /** Claim passes are started from timers and from `wake()` calls made inside
     * request handlers. Run them under the root context so a pass never joins
     * whichever request happened to wake the engine — otherwise every later tick
     * inherits that request's trace for the life of the timer chain. */
    activeClaim = context
      .with(ROOT_CONTEXT, () => runAsSystem(runClaimPass))
      .then((result) => {
        /** Only a pass that confirmed an empty queue may advance the idle backoff: work
         *  resets it, and a failed claim proves nothing, so it polls on at the base
         *  cadence — the pre-backoff status quo through an outage and at recovery. */
        idleStreak = result.count === 0 && result.claimFailed !== true ? idleStreak + 1 : 0;
        return result;
      })
      .finally(() => {
        activeClaim = undefined;
        if (repumpRequested && !stopped) {
          repumpRequested = false;
          queueMicrotask(wake);
        }
      });
    return activeClaim;
  };

  const runTick = async (): Promise<number> => {
    const batch = await claimAvailable();
    await Promise.allSettled(batch.processing);
    return batch.count;
  };

  const claimOnce = (): void => {
    if (activeClaim != null) {
      repumpRequested = true;
      return;
    }
    void claimAvailable().catch((error) =>
      logger.error('[agent-triggers] delivery claim pass failed:', error),
    );
  };

  function noteEligibleAt(at: Date): void {
    const eligibleAtMs = at.getTime();
    if (!Number.isFinite(eligibleAtMs) || stopped) {
      return;
    }
    const insertAt = eligibleDeadlinesMs.findIndex((deadline) => deadline >= eligibleAtMs);
    if (insertAt !== -1 && eligibleDeadlinesMs[insertAt] === eligibleAtMs) {
      return;
    }
    eligibleDeadlinesMs.splice(
      insertAt === -1 ? eligibleDeadlinesMs.length : insertAt,
      0,
      eligibleAtMs,
    );
    if (eligibleDeadlinesMs.length > MAX_TRACKED_DEADLINES) {
      eligibleDeadlinesMs.pop();
    }
    if (started && eligibleDeadlinesMs[0] === eligibleAtMs) {
      schedule();
    }
  }

  /** A wake is evidence of work — an enqueue or a finished delivery — so it snaps the
   *  idle backoff and the poll timer back to the base cadence before claiming. */
  function wake(): void {
    if (stopped) {
      return;
    }
    idleStreak = 0;
    if (started) {
      schedule();
    }
    claimOnce();
  }

  const schedule = () => {
    if (stopped) {
      return;
    }
    if (timer != null) {
      clearTimeout(timer);
    }
    let delay = Math.min(tickMs * 2 ** idleStreak, maxIdleTickMs);
    if (eligibleDeadlinesMs.length > 0) {
      delay = Math.max(0, Math.min(delay, eligibleDeadlinesMs[0] - now().getTime()));
    }
    /** Created under the root context too: `schedule()` runs from `wake()` inside
     * request handlers, and each tick reschedules from its own callback. */
    timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(async () => {
        if (stopped) {
          return;
        }
        const nowMs = now().getTime();
        while (eligibleDeadlinesMs.length > 0 && eligibleDeadlinesMs[0] <= nowMs) {
          eligibleDeadlinesMs.shift();
        }
        await claimAvailable().catch((error) =>
          logger.error('[agent-triggers] delivery claim pass failed:', error),
        );
        schedule();
      }, delay),
    );
    timer.unref();
  };

  return {
    start: () => {
      if (started || stopped) {
        return;
      }
      started = true;
      wake();
    },
    stop: async () => {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
      }
      for (const controller of controllers.keys()) {
        controller.abort();
      }
      await activeClaim?.catch(() => undefined);
      await Promise.allSettled([...processing]);
    },
    cancelUser: async (userId) => {
      cancelledUsers.add(userId);
      for (const [controller, activeUserId] of controllers) {
        if (activeUserId === userId) {
          controller.abort(new Error('Agent trigger delivery cancelled for account deletion'));
        }
      }
      await activeClaim?.catch(() => undefined);
      const userProcessing = processingByUser.get(userId);
      if (userProcessing != null) {
        await Promise.allSettled([...userProcessing]);
      }
    },
    releaseUserCancellation: (userId) => {
      cancelledUsers.delete(userId);
    },
    wake,
    noteEligibleAt,
    runTick,
  };
}
