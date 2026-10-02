import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Collection, Document, WithId } from 'mongodb';

type JobStatus = 'running' | 'completed' | 'failed';

interface JobState extends Document {
  _id: string;
  status: JobStatus;
  owner?: string;
  expiresAt: Date;
  updatedAt: Date;
}

interface DistributedJobOptions {
  leaseMs?: number;
  refreshMs?: number;
  completionTtlMs?: number;
  failureTtlMs?: number;
  pollMs?: number;
  onLeaseLost: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  cancellationGraceMs?: number;
  operationTimeoutMs?: number;
}

interface OwnershipOperationOptions {
  signal: AbortSignal;
  maxTimeMS: number;
  timeoutMS: number;
}

type HandlerOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_REFRESH_MS = 60 * 1000;
const DEFAULT_COMPLETION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 30 * 1000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_CANCELLATION_GRACE_MS = 5000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const LEASE_SAFETY_MS = 5000;
const CANCELLED = Symbol('cancelled');
const SETTLEMENT_TIMEOUT = Symbol('settlement-timeout');

class OwnershipOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Distributed job ownership operation "${operation}" exceeded ${timeoutMs}ms`);
    this.name = 'OwnershipOperationTimeoutError';
  }
}

const getAbortError = (jobId: string, signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error(`Distributed job ${jobId} was cancelled`);

const getRemainingMs = (deadlineAt?: number): number | undefined =>
  deadlineAt == null ? undefined : Math.max(0, deadlineAt - Date.now());

const sleep = (duration: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(getAbortError('acquisition', signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

const waitUntil = <T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
  timeoutValue: typeof SETTLEMENT_TIMEOUT,
): Promise<T | typeof SETTLEMENT_TIMEOUT> => {
  const remainingMs = getRemainingMs(deadlineAt);
  if (remainingMs == null) {
    return promise;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(timeoutValue), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(timeoutValue);
      },
    );
  });
};

async function runOwnershipOperation<T>(
  operation: string,
  operationTimeoutMs: number,
  deadlineAt: number | undefined,
  run: (options: OwnershipOperationOptions) => Promise<T>,
  cancellationSignal?: AbortSignal,
): Promise<T> {
  const remainingMs = getRemainingMs(deadlineAt);
  const timeoutMs = Math.max(
    1,
    Math.min(operationTimeoutMs, remainingMs == null ? operationTimeoutMs : remainingMs),
  );
  if (remainingMs === 0) {
    throw new OwnershipOperationTimeoutError(operation, timeoutMs);
  }

  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      cancellationSignal?.removeEventListener('abort', onCancellation);
    };
    const resolveOnce = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const failUnsafe = () => {
      controller.abort();
      rejectOnce(new OwnershipOperationTimeoutError(operation, timeoutMs));
    };
    const onCancellation = () => {
      controller.abort(cancellationSignal?.reason);
      rejectOnce(
        cancellationSignal == null
          ? new OwnershipOperationTimeoutError(operation, timeoutMs)
          : getAbortError(operation, cancellationSignal),
      );
    };
    const timer = setTimeout(failUnsafe, timeoutMs);

    if (cancellationSignal?.aborted) {
      onCancellation();
      return;
    }
    cancellationSignal?.addEventListener('abort', onCancellation, { once: true });
    run({
      signal: controller.signal,
      maxTimeMS: timeoutMs,
      timeoutMS: timeoutMs,
    }).then(resolveOnce, (error: unknown) => rejectOnce(error));
  });
}

async function tryAcquire(
  collection: Collection<JobState>,
  jobId: string,
  owner: string,
  leaseMs: number,
  operationTimeoutMs: number,
  deadlineAt: number | undefined,
  cancellationSignal: AbortSignal,
): Promise<Date | undefined> {
  const now = new Date();

  try {
    const state = await runOwnershipOperation(
      'acquire',
      operationTimeoutMs,
      deadlineAt,
      (operationOptions) =>
        collection.findOneAndUpdate(
          {
            _id: jobId,
            $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
          },
          {
            $set: {
              status: 'running',
              owner,
              expiresAt: new Date(now.getTime() + leaseMs),
              updatedAt: now,
            },
          },
          {
            upsert: true,
            returnDocument: 'after',
            includeResultMetadata: false,
            ...operationOptions,
          },
        ),
      cancellationSignal,
    );
    return state?.owner === owner ? state.expiresAt : undefined;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return;
    }
    throw error;
  }
}

/**
 * Runs one logical job across replicas under a renewable MongoDB lease.
 *
 * The caller supplies a durable collection shared by every replica rather than
 * cache-backed FlowState storage, which may be Redis or process-local memory.
 * Each successful renewal moves `expiresAt` forward from the current time, so
 * it acts as the owner's heartbeat-derived stale deadline rather than a fixed
 * limit on the total job duration.
 *
 * Cancellation first asks the handler to stop and keeps renewing its lease until
 * the handler confirms settlement. After ownership is acquired, an owner that
 * cannot confirm handler or ownership-operation settlement fail-stops without
 * making the lease acquirable; this prevents stale work from overlapping a new
 * owner. Acquisition failures never start the handler and can safely be retried.
 */
export async function runDistributedJob<T>(
  collection: Collection<JobState>,
  jobId: string,
  handler: (signal: AbortSignal) => Promise<T>,
  options: DistributedJobOptions,
): Promise<T | undefined> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const completionTtlMs = options.completionTtlMs ?? DEFAULT_COMPLETION_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs;
  const cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
  const defaultOperationTimeoutMs = Math.min(
    DEFAULT_OPERATION_TIMEOUT_MS,
    leaseMs - LEASE_SAFETY_MS - 1,
  );
  const operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;
  if (
    !Number.isFinite(leaseMs) ||
    !Number.isFinite(refreshMs) ||
    leaseMs <= LEASE_SAFETY_MS ||
    refreshMs <= 0 ||
    refreshMs >= leaseMs - LEASE_SAFETY_MS
  ) {
    throw new RangeError(
      `Invalid distributed job timing: leaseMs must exceed ${LEASE_SAFETY_MS}ms and refreshMs must be positive with at least ${LEASE_SAFETY_MS}ms safety margin`,
    );
  }
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError('Distributed job timeout must be a positive finite number');
  }
  if (!Number.isFinite(cancellationGraceMs) || cancellationGraceMs < 0) {
    throw new RangeError('Distributed job cancellation grace must be a finite non-negative number');
  }
  if (
    !Number.isFinite(operationTimeoutMs) ||
    operationTimeoutMs <= 0 ||
    operationTimeoutMs >= leaseMs - LEASE_SAFETY_MS
  ) {
    throw new RangeError(
      `Distributed job operation timeout must be positive and leave at least ${LEASE_SAFETY_MS}ms before lease expiry`,
    );
  }

  const { onLeaseLost } = options;
  const owner = crypto.randomUUID();
  const startedAt = Date.now();
  const deadlineAt = timeoutMs == null ? undefined : startedAt + timeoutMs;
  const controller = new AbortController();
  let cancellationDeadlineAt: number | undefined;
  const requestCancellation = (reason: Error, settleBy: number | undefined) => {
    if (controller.signal.aborted) {
      return;
    }
    cancellationDeadlineAt = settleBy;
    controller.abort(reason);
  };
  const abortFromCaller = () => {
    const callerDeadlineAt = Date.now() + cancellationGraceMs;
    requestCancellation(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error(`Distributed job ${jobId} was cancelled`),
      deadlineAt == null ? callerDeadlineAt : Math.min(deadlineAt, callerDeadlineAt),
    );
  };
  let cancellationTimer: NodeJS.Timeout | undefined;
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (deadlineAt != null) {
    cancellationTimer = setTimeout(
      () => {
        requestCancellation(
          new Error(`Distributed job ${jobId} did not complete within ${timeoutMs}ms`),
          deadlineAt,
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );
  }

  let acquiredExpiry: Date | undefined;
  try {
    if (controller.signal.aborted) {
      throw getAbortError(jobId, controller.signal);
    }
    while (acquiredExpiry == null) {
      try {
        acquiredExpiry = await tryAcquire(
          collection,
          jobId,
          owner,
          leaseMs,
          operationTimeoutMs,
          deadlineAt,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.error(`[DistributedJob] Could not acquire ${jobId}`, error);
        }
        throw error;
      }
      if (acquiredExpiry != null) {
        break;
      }

      let state: WithId<JobState> | null;
      try {
        state = await runOwnershipOperation(
          'lookup',
          operationTimeoutMs,
          deadlineAt,
          (operationOptions) => collection.findOne({ _id: jobId }, operationOptions),
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.error(`[DistributedJob] Could not inspect ${jobId}`, error);
        }
        throw error;
      }
      if (state?.status === 'completed' && state.expiresAt > new Date()) {
        return;
      }
      const remainingMs = getRemainingMs(deadlineAt);
      await sleep(remainingMs == null ? pollMs : Math.min(pollMs, remainingMs), controller.signal);
    }

    if (deadlineAt != null && !controller.signal.aborted) {
      clearTimeout(cancellationTimer);
      const abortAt = Math.max(Date.now(), deadlineAt - cancellationGraceMs);
      cancellationTimer = setTimeout(
        () => {
          requestCancellation(
            new Error(`Distributed job ${jobId} did not complete within ${timeoutMs}ms`),
            deadlineAt,
          );
        },
        Math.max(0, abortAt - Date.now()),
      );
    }

    let leaseExpiresAt = acquiredExpiry.getTime();
    let leaseLost = false;
    let finalizing = false;
    let refreshing = false;
    let watchdogTimer: NodeJS.Timeout | undefined;
    let refreshInFlight: Promise<void> = Promise.resolve();
    let rejectFatal!: (error: Error) => void;
    const fatal = new Promise<never>((_resolve, reject) => {
      rejectFatal = reject;
    });

    const loseLease = (message: string, error?: unknown) => {
      if (leaseLost) {
        return;
      }
      leaseLost = true;
      clearInterval(refreshTimer);
      clearTimeout(watchdogTimer);
      const leaseError = new Error(`Lost distributed job lease for ${jobId}`);
      logger.error(message, error);
      onLeaseLost();
      rejectFatal(leaseError);
    };

    const scheduleWatchdog = () => {
      clearTimeout(watchdogTimer);
      const delay = Math.max(0, leaseExpiresAt - Date.now() - LEASE_SAFETY_MS);
      watchdogTimer = setTimeout(() => {
        loseLease(`[DistributedJob] Lease renewal deadline reached for ${jobId}`);
      }, delay);
      watchdogTimer.unref();
    };

    const refreshLease = async () => {
      try {
        const now = new Date();
        const result = await runOwnershipOperation(
          'renew',
          operationTimeoutMs,
          deadlineAt,
          (operationOptions) =>
            collection.updateOne(
              { _id: jobId, status: 'running', owner, expiresAt: { $gt: now } },
              {
                $set: {
                  expiresAt: new Date(now.getTime() + leaseMs),
                  updatedAt: now,
                },
              },
              operationOptions,
            ),
        );
        if (result.matchedCount !== 1) {
          if (!finalizing) {
            loseLease(`[DistributedJob] Lost lease for ${jobId}`);
          }
          return;
        }
        leaseExpiresAt = now.getTime() + leaseMs;
        scheduleWatchdog();
      } catch (error) {
        loseLease(`[DistributedJob] Lease renewal failed for ${jobId}`, error);
      }
    };

    const refreshTimer = setInterval(() => {
      if (finalizing || refreshing) {
        return;
      }
      refreshing = true;
      refreshInFlight = refreshLease().finally(() => {
        refreshing = false;
      });
    }, refreshMs);
    refreshTimer.unref();
    scheduleWatchdog();

    const getFinalizationDeadline = () => cancellationDeadlineAt ?? deadlineAt;
    const stopRenewal = async () => {
      finalizing = true;
      clearInterval(refreshTimer);
      const refreshSettled = await Promise.race([
        waitUntil(refreshInFlight, getFinalizationDeadline(), SETTLEMENT_TIMEOUT),
        fatal,
      ]);
      if (refreshSettled === SETTLEMENT_TIMEOUT) {
        loseLease(`[DistributedJob] Timed out waiting for lease renewal to settle for ${jobId}`);
        return await fatal;
      }
      if (leaseLost) {
        return await fatal;
      }
    };

    const finalizeFailure = async (error: unknown, cancelled: boolean): Promise<never> => {
      await stopRenewal();
      const now = new Date();
      try {
        const failure = await Promise.race([
          runOwnershipOperation(
            'fail',
            operationTimeoutMs,
            getFinalizationDeadline(),
            (operationOptions) =>
              collection.updateOne(
                { _id: jobId, status: 'running', owner, expiresAt: { $gt: now } },
                {
                  $set: {
                    status: 'failed',
                    expiresAt: cancelled ? now : new Date(now.getTime() + failureTtlMs),
                    updatedAt: now,
                  },
                  $unset: { owner: '' },
                },
                operationOptions,
              ),
          ),
          fatal,
        ]);
        if (failure.matchedCount !== 1) {
          loseLease(`[DistributedJob] Lost lease while failing ${jobId}`);
          return await fatal;
        }
      } catch (finalizationError) {
        loseLease(
          `[DistributedJob] Could not safely finalize failure for ${jobId}`,
          finalizationError,
        );
        return await fatal;
      }
      throw error;
    };

    const handlerOutcome: Promise<HandlerOutcome<T>> = Promise.resolve()
      .then(() => handler(controller.signal))
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      );
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      if (controller.signal.aborted) {
        resolve(CANCELLED);
        return;
      }
      controller.signal.addEventListener('abort', () => resolve(CANCELLED), { once: true });
    });

    try {
      const first = await Promise.race([handlerOutcome, cancelled, fatal]);
      if (first === CANCELLED) {
        const settled = await Promise.race([
          waitUntil(handlerOutcome, cancellationDeadlineAt, SETTLEMENT_TIMEOUT),
          fatal,
        ]);
        if (settled === SETTLEMENT_TIMEOUT) {
          loseLease(
            `[DistributedJob] Handler did not settle safely after cancellation for ${jobId}`,
            getAbortError(jobId, controller.signal),
          );
          return await fatal;
        }
        return await finalizeFailure(getAbortError(jobId, controller.signal), true);
      }

      if (controller.signal.aborted) {
        return await finalizeFailure(getAbortError(jobId, controller.signal), true);
      }
      if (first.status === 'rejected') {
        return await finalizeFailure(first.reason, false);
      }

      await stopRenewal();
      if (controller.signal.aborted) {
        return await finalizeFailure(getAbortError(jobId, controller.signal), true);
      }
      const now = new Date();
      try {
        const completion = await Promise.race([
          runOwnershipOperation('complete', operationTimeoutMs, deadlineAt, (operationOptions) =>
            collection.updateOne(
              { _id: jobId, status: 'running', owner, expiresAt: { $gt: now } },
              {
                $set: {
                  status: 'completed',
                  expiresAt: new Date(now.getTime() + completionTtlMs),
                  updatedAt: now,
                },
                $unset: { owner: '' },
              },
              operationOptions,
            ),
          ),
          fatal,
        ]);
        if (completion.matchedCount !== 1) {
          loseLease(`[DistributedJob] Lost lease while completing ${jobId}`);
          return await fatal;
        }
      } catch (error) {
        loseLease(`[DistributedJob] Could not safely complete ${jobId}`, error);
        return await fatal;
      }
      return first.value;
    } finally {
      clearInterval(refreshTimer);
      clearTimeout(watchdogTimer);
    }
  } finally {
    clearTimeout(cancellationTimer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
