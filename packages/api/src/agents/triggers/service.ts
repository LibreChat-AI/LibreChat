import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
  logger,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  AgentTriggerDeliveryMethods,
  AgentTriggerDeliveryStatusRecord,
} from '@librechat/data-schemas';
import type {
  AgentTriggerDeliveryFailure,
  AgentTriggerDeliveryEngine,
  AgentTriggerDeliveryEngineDeps,
  AgentTriggerDeliveryEngineOptions,
  AgentTriggerDeliveryRecord,
  AgentTriggerDeliveryStore,
} from './engine';
import type {
  AgentTriggerExecutionHost,
  AgentTriggerExecutionHostDeps,
  AgentTriggerExecutionResult,
} from './host';
import type { AgentTriggerEnqueueOptions, PreparedAgentTriggerDelivery } from './delivery';
import type { BoundAddress } from '../../app/origin';
import { AgentTriggerDeliveryDeferredError, createAgentTriggerDeliveryEngine } from './engine';
import { BACKGROUND_TOOL_COMPLETION_SOURCE } from '../backgroundCompletionWakeup';
import { isShutdownInProgress, registerShutdownTask } from '../../app/shutdown';
import { SUBAGENT_COMPLETION_SOURCE } from '../subagentCompletionWakeup';
import { generateAgentTriggerToken } from '../../crypto/jwt';
import { prepareAgentTriggerDelivery } from './delivery';
import { selfOriginFromAddress } from '../../app/origin';
import { createAgentTriggerExecutionHost } from './host';
import { parseAgentTriggerEnvelope } from './envelope';
import { createIdleRecoveryLoop } from '../recovery';
import { WAITING_RETRY_CAP_MS } from './backoff';

/** Internal sources whose deliveries wait on a result or on their parent generation. */
const COMPLETION_WAKEUP_SOURCES = [BACKGROUND_TOOL_COMPLETION_SOURCE, SUBAGENT_COMPLETION_SOURCE];

export const AGENT_TRIGGER_TOKEN_TTL = '60s';
const DEFAULT_USER_DRAIN_TIMEOUT_MS = 35_000;
const DEFAULT_USER_DRAIN_POLL_MS = 100;
const DEFAULT_PURGE_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_PURGE_RECOVERY_MAX_IDLE_INTERVAL_MS = 2 * 60_000;
const DEFAULT_PURGE_RECOVERY_LIMIT = 25;

export interface AgentTriggerServiceOptions {
  completionResultBatchSize?: number;
  address?: BoundAddress | string | null;
  idlePolling?: {
    queuedTurnMaxIntervalMs?: number;
    maintenanceMaxIntervalMs?: number;
    deliveryMaxIntervalMs?: number;
    completionWaitMaxIntervalMs?: number;
  };
}

/** A principal's deliveries resuming one conversation, or exact deliveries. */
export type AgentTriggerCompletionExpedite =
  | { user: string; conversationId: string; taskIds?: string[] }
  | { deliveryKeys: string[] };

export interface AgentTriggerServiceDeps {
  fetch?: AgentTriggerExecutionHostDeps['fetch'];
  getTimezone?: AgentTriggerExecutionHostDeps['getTimezone'];
  prepareContinue?: AgentTriggerExecutionHostDeps['prepareContinue'];
  mintToken?: AgentTriggerExecutionHostDeps['mintToken'];
  timeoutMs?: number;
  methods?: AgentTriggerDeliveryPersistence;
  deliveryOptions?: AgentTriggerDeliveryEngineOptions;
  isPrincipalActive?: (userId: string) => boolean | Promise<boolean>;
  userDrainTimeoutMs?: number;
  userDrainPollMs?: number;
  purgeRecoveryIntervalMs?: number;
  purgeRecoveryLimit?: number;
  reclaimCheckpointDeletions?: (limit: number, activity?: { found: boolean }) => Promise<number>;
  supportsDetachedActionCompletion?: () => boolean;
  settleSourceBeforeDeadLetter?: AgentTriggerDeliveryEngineDeps['settleSourceBeforeDeadLetter'];
  /** Subscribes to generations reaching a terminal state; returns an unsubscribe. */
  subscribeGenerationSettled?: (
    listener: (event: AgentTriggerGenerationSettledEvent) => void,
  ) => () => void;
}

/** The part of a settled generation that decides which waiting deliveries it may unblock. */
export interface AgentTriggerGenerationSettledEvent {
  userId: string;
  conversationId: string;
}

export interface AgentTriggerDeliveryReceipt {
  id: string;
  deliveryKey: string;
  status: Exclude<AgentTriggerStoredRecord['status'], 'batched'>;
  availableAt: Date;
  replayed: boolean;
}

export class AgentTriggerServiceUnavailableError extends AgentTriggerDeliveryDeferredError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTriggerServiceUnavailableError';
  }
}

export interface AgentTriggerStoredHistoryEntry {
  attempt: number;
  outcome: 'succeeded' | 'retry' | 'dead';
  at: Date;
  workerId: string;
  error?: AgentTriggerDeliveryFailure;
}

export interface AgentTriggerStoredRecord extends Omit<AgentTriggerDeliveryRecord, 'claimToken'> {
  claimToken?: string;
  tenantId?: string;
  result?: unknown;
  history?: AgentTriggerStoredHistoryEntry[];
  settledAt?: Date;
  expiresAt?: Date;
  requeueCount?: number;
}

/** Persistence contract implemented by the data-schemas method bundle. */
export interface AgentTriggerDeliveryPersistence {
  ensureAgentTriggerDeliveryIndexes: () => Promise<void>;
  enqueueAgentTriggerDelivery: (
    input: PreparedAgentTriggerDelivery,
  ) => Promise<{ delivery: AgentTriggerStoredRecord; replayed: boolean }>;
  claimNextAgentTriggerDelivery: (
    input: Parameters<AgentTriggerDeliveryStore['claimNext']>[0] & {
      workerCapabilities?: string[];
    },
  ) => ReturnType<AgentTriggerDeliveryStore['claimNext']>;
  findEarlierAgentTriggerDelivery: AgentTriggerDeliveryStore['findEarlierUnsettled'];
  getAgentTriggerDeliveryBatch: AgentTriggerDeliveryStore['getBatch'];
  releaseAgentTriggerDelivery: AgentTriggerDeliveryStore['release'];
  beginAgentTriggerDeliveryAttempt: AgentTriggerDeliveryStore['beginAttempt'];
  deferAgentTriggerDeliveryAttempt: AgentTriggerDeliveryStore['defer'];
  completeAgentTriggerDelivery: AgentTriggerDeliveryMethods['completeAgentTriggerDelivery'];
  retireAgentTriggerDelivery: AgentTriggerDeliveryMethods['retireAgentTriggerDelivery'];
  renewAgentTriggerDeliveryProducerLease: AgentTriggerDeliveryMethods['renewAgentTriggerDeliveryProducerLease'];
  persistAgentBackgroundToolResult?: AgentTriggerDeliveryMethods['persistAgentBackgroundToolResult'];
  expediteAgentTriggerDeliveries?: AgentTriggerDeliveryMethods['expediteAgentTriggerDeliveries'];
  getAgentBackgroundToolResultClaim?: AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim'];
  releaseAgentBackgroundToolResultClaims?: AgentTriggerDeliveryMethods['releaseAgentBackgroundToolResultClaims'];
  retryAgentTriggerDelivery: AgentTriggerDeliveryStore['retry'];
  deadLetterAgentTriggerDelivery: AgentTriggerDeliveryMethods['deadLetterAgentTriggerDelivery'];
  getAgentTriggerDelivery: (deliveryKey: string) => Promise<AgentTriggerStoredRecord | null>;
  getAgentTriggerDeliveryStatus: (
    deliveryKey: string,
    userId: string,
    sourceKeyId: string,
    tenantId?: string,
  ) => Promise<AgentTriggerDeliveryStatusRecord | null>;
  getAgentTriggerDeadLetters: (limit?: number) => Promise<AgentTriggerStoredRecord[]>;
  requeueAgentTriggerDelivery: (
    id: string,
    availableAt: Date,
  ) => Promise<AgentTriggerStoredRecord | null>;
  countActiveAgentTriggerDeliveriesByUser: (userId: string, now: Date) => Promise<number>;
  recoverAgentTriggerLanePublications: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  recoverAgentTriggerBatchReceipts: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  reclaimInactiveAgentTriggerLanes: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  prepareAgentTriggerUserPurge: (
    userId: string,
    fenceStartedAt: Date,
    tenantId?: string,
  ) => Promise<void>;
  cancelAgentTriggerUserPurge: (userId: string, fenceStartedAt: Date) => Promise<boolean>;
  recoverAgentTriggerUserPurges: (limit?: number, activity?: { found: boolean }) => Promise<number>;
  expireLegacyAgentEventActorReceipts?: (
    now: Date,
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  deleteAgentTriggerDeliveriesByUser: (userId: string) => Promise<void>;
}

export interface AgentTriggerService {
  initialize: (options?: AgentTriggerServiceOptions) => Promise<void>;
  stop: () => Promise<void>;
  dispatch: (
    envelope: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<AgentTriggerExecutionResult>;
  enqueue: (
    envelope: unknown,
    options?: AgentTriggerEnqueueOptions,
  ) => Promise<AgentTriggerDeliveryReceipt>;
  getDelivery: (deliveryKey: string) => Promise<AgentTriggerStoredRecord | null>;
  getDeliveryStatus: (
    deliveryKey: string,
    userId: string,
    sourceKeyId: string,
    tenantId?: string,
  ) => Promise<AgentTriggerDeliveryStatusRecord | null>;
  getDeadLetters: (limit?: number) => Promise<AgentTriggerStoredRecord[]>;
  requeue: (id: string, availableAt?: Date) => Promise<AgentTriggerStoredRecord | null>;
  retire: (
    deliveryKey: string,
    sourceId: string,
    reason: string,
    options?: { onlyIfUnclaimed?: boolean; onlyIfDead?: boolean; requireTransition?: boolean },
  ) => Promise<boolean>;
  renewProducerLease: (deliveryKey: string, sourceId: string, leaseUntil: Date) => Promise<boolean>;
  persistBackgroundToolResult: (input: {
    deliveryKey: string;
    sourceId: string;
    result: {
      status: 'completed' | 'error' | 'cancelled';
      output: string;
      settledAt: Date;
    };
  }) => Promise<boolean>;
  getBackgroundToolResultClaim: (
    input: Parameters<AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim']>[0],
  ) => ReturnType<AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim']>;
  getBackgroundCompletionResultBatchSize: () => number;
  /** Longest a waiting completion delivery re-checks readiness. */
  getCompletionWaitMaxIntervalMs: () => number;
  /** Best effort: moves waiting completion deliveries forward after what they wait on changed. */
  expediteCompletionWakeups: (input: AgentTriggerCompletionExpedite) => void;
  releaseBackgroundToolResultClaims: AgentTriggerDeliveryMethods['releaseAgentBackgroundToolResultClaims'];
  drainUser: (userId: string) => Promise<void>;
  prepareUserPurge: (userId: string, fenceStartedAt: Date, tenantId?: string) => Promise<void>;
  cancelUserPurge: (userId: string, fenceStartedAt: Date) => Promise<boolean>;
  purgeUser: (userId: string) => Promise<void>;
}

/** A producer can commit durable state before an inline finalizer fails. Keep
 * its authoritative result intact, but wake maintenance for the remaining marker.
 * Rejections are uncertain commits, so they also request recovery. Healthy writes
 * do not turn every delivered event into a full maintenance sweep. */
async function withMaintenanceRecovery<T>(
  operation: (recovery: { required: boolean }) => Promise<T>,
  wake: () => void,
): Promise<T> {
  const recovery = { required: false };
  try {
    return await operation(recovery);
  } catch (error) {
    recovery.required = true;
    throw error;
  } finally {
    if (recovery.required) wake();
  }
}

function createDeliveryStore(
  methods: AgentTriggerDeliveryPersistence,
  supportsDetachedActionCompletion: () => boolean,
  wakeMaintenance: () => void,
): AgentTriggerDeliveryStore {
  return {
    claimNext: (input) =>
      methods.claimNextAgentTriggerDelivery({
        ...input,
        workerCapabilities: [
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
          AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
          ...(supportsDetachedActionCompletion()
            ? [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1]
            : []),
        ],
      }),
    findEarlierUnsettled: methods.findEarlierAgentTriggerDelivery,
    getBatch: methods.getAgentTriggerDeliveryBatch,
    release: methods.releaseAgentTriggerDelivery,
    beginAttempt: methods.beginAgentTriggerDeliveryAttempt,
    defer: methods.deferAgentTriggerDeliveryAttempt,
    complete: (input) =>
      withMaintenanceRecovery(
        (recovery) => methods.completeAgentTriggerDelivery(input, recovery),
        wakeMaintenance,
      ),
    retry: methods.retryAgentTriggerDelivery,
    dead: (input) =>
      withMaintenanceRecovery(
        (recovery) => methods.deadLetterAgentTriggerDelivery(input, recovery),
        wakeMaintenance,
      ),
  };
}

function publicReceiptStatus(
  status: AgentTriggerStoredRecord['status'],
): AgentTriggerDeliveryReceipt['status'] {
  if (status === 'batched' || status === 'capability_pending') {
    return 'pending';
  }
  if (status === 'capability_staging') {
    return 'staging';
  }
  if (status === 'capability_dead') {
    return 'dead';
  }
  return status === 'capability_leased' ? 'leased' : status;
}

function requireDeliveryOrigin(boundOrigin: string | undefined): void {
  const value = process.env.AGENT_TRIGGERS_SELF_URL ?? boundOrigin;
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new AgentTriggerServiceUnavailableError(
      'Durable agent trigger delivery requires a valid listener address or AGENT_TRIGGERS_SELF_URL',
    );
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new AgentTriggerServiceUnavailableError(
      'Durable agent trigger delivery requires an HTTP(S) self URL without credentials',
    );
  }
}

/** Production composition for trusted, in-process trigger producers. */
export function createAgentTriggerService(deps: AgentTriggerServiceDeps = {}): AgentTriggerService {
  const userDrainTimeoutMs = deps.userDrainTimeoutMs ?? DEFAULT_USER_DRAIN_TIMEOUT_MS;
  const userDrainPollMs = deps.userDrainPollMs ?? DEFAULT_USER_DRAIN_POLL_MS;
  const purgeRecoveryIntervalMs =
    deps.purgeRecoveryIntervalMs ?? DEFAULT_PURGE_RECOVERY_INTERVAL_MS;
  const purgeRecoveryLimit = deps.purgeRecoveryLimit ?? DEFAULT_PURGE_RECOVERY_LIMIT;
  const supportsDetachedActionCompletion = deps.supportsDetachedActionCompletion ?? (() => false);
  if (!Number.isSafeInteger(userDrainTimeoutMs) || userDrainTimeoutMs <= 0) {
    throw new TypeError('userDrainTimeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(userDrainPollMs) || userDrainPollMs <= 0) {
    throw new TypeError('userDrainPollMs must be a positive integer');
  }
  if (!Number.isSafeInteger(purgeRecoveryIntervalMs) || purgeRecoveryIntervalMs <= 0) {
    throw new TypeError('purgeRecoveryIntervalMs must be a positive integer');
  }
  if (!Number.isSafeInteger(purgeRecoveryLimit) || purgeRecoveryLimit <= 0) {
    throw new TypeError('purgeRecoveryLimit must be a positive integer');
  }
  let boundOrigin: string | undefined;
  let backgroundCompletionResultBatchSize = 8;
  let completionWaitMaxIntervalMs = WAITING_RETRY_CAP_MS;
  let deliveryEngine: AgentTriggerDeliveryEngine | undefined;
  let initializePromise: Promise<void> | undefined;
  let purgeRecoveryPromise: Promise<boolean> | undefined;
  let purgeRecoveryLoop: ReturnType<typeof createIdleRecoveryLoop> | undefined;
  let deliveryReady = false;
  let stopping = false;
  const isPrincipalActive = deps.isPrincipalActive;
  const host: AgentTriggerExecutionHost = createAgentTriggerExecutionHost({
    getBaseUrl: (options) => {
      const origin =
        options?.localOnly === true
          ? boundOrigin
          : (process.env.AGENT_TRIGGERS_SELF_URL ?? boundOrigin);
      if (origin == null) {
        throw new Error('Agent trigger service has not been initialized with a listener address');
      }
      return origin;
    },
    mintToken:
      deps.mintToken ??
      ((principal) => generateAgentTriggerToken(principal.userId, AGENT_TRIGGER_TOKEN_TTL)),
    ...(deps.fetch != null && { fetch: deps.fetch }),
    ...(deps.getTimezone != null && { getTimezone: deps.getTimezone }),
    ...(deps.prepareContinue != null && {
      prepareContinue: deps.prepareContinue,
    }),
    ...(deps.timeoutMs != null && { timeoutMs: deps.timeoutMs }),
  });

  const requireMethods = (): AgentTriggerDeliveryPersistence => {
    if (deps.methods == null || !deliveryReady || isShutdownInProgress()) {
      throw new AgentTriggerServiceUnavailableError(
        'Durable agent trigger delivery is not ready on this server',
      );
    }
    return deps.methods;
  };

  const requireCleanupMethods = (): AgentTriggerDeliveryPersistence => {
    if (deps.methods == null) {
      throw new AgentTriggerServiceUnavailableError(
        'Durable agent trigger delivery is not configured on this server',
      );
    }
    return deps.methods;
  };

  const requireActivePrincipal = async (userId: string): Promise<void> => {
    if (isPrincipalActive != null && !(await runAsSystem(async () => isPrincipalActive(userId)))) {
      throw new AgentTriggerServiceUnavailableError(
        'Agent trigger delivery principal is no longer active',
      );
    }
  };

  const dispatchForActivePrincipal = async (
    envelope: unknown,
    options?: { signal?: AbortSignal; attempt?: number; maxAttempts?: number },
  ): Promise<AgentTriggerExecutionResult> => {
    const parsed = parseAgentTriggerEnvelope(envelope);
    await requireActivePrincipal(parsed.principal.userId);
    return host.dispatch(parsed, options);
  };

  const drainUser = async (userId: string): Promise<void> => {
    const methods = requireMethods();
    await deliveryEngine?.cancelUser(userId);

    try {
      const deadline = Date.now() + userDrainTimeoutMs;
      while (
        (await runAsSystem(async () =>
          methods.countActiveAgentTriggerDeliveriesByUser(userId, new Date()),
        )) > 0
      ) {
        if (Date.now() >= deadline) {
          throw new AgentTriggerServiceUnavailableError(
            `Timed out draining active agent trigger deliveries for user ${userId}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, userDrainPollMs));
      }
    } finally {
      deliveryEngine?.releaseUserCancellation(userId);
    }
  };

  const recoverPurges = (): Promise<boolean> => {
    if (deps.methods == null || stopping) {
      return Promise.resolve(false);
    }
    if (purgeRecoveryPromise != null) {
      return purgeRecoveryPromise;
    }
    const methods = deps.methods;
    /** Independent maintenance operations fail alone: a rejection is logged
     * and counted as zero progress instead of aborting the pass, so one broken
     * cleanup (e.g. an engine-specific query rejection) can never starve the
     * others. Batch-receipt recovery is NOT independent: lane reclamation
     * consumes the lane-cleanup markers, and running it against a
     * half-recovered batch clears a request that a later successful recovery
     * can no longer re-arm, retaining the lane permanently — so reclamation
     * still waits for a batch-recovery pass that did not fail. */
    let failed = false;
    const activity = { found: false };
    const isolated = async (label: string, run: () => Promise<number>): Promise<number> => {
      try {
        return await run();
      } catch (error) {
        failed = true;
        logger.error(
          `[agent-triggers] durable delivery maintenance step failed (${label}):`,
          error,
        );
        return 0;
      }
    };
    const current = runAsSystem(async () => {
      const [
        purgedUsers,
        publishedLanes,
        batchRecovery,
        expiredLegacyActorReceipts,
        retiredCheckpointDeletions,
      ] = await Promise.all([
        isolated('user purges', () =>
          methods.recoverAgentTriggerUserPurges(purgeRecoveryLimit, activity),
        ),
        isolated('lane publications', () =>
          methods.recoverAgentTriggerLanePublications(purgeRecoveryLimit, activity),
        ),
        methods.recoverAgentTriggerBatchReceipts(purgeRecoveryLimit, activity).then(
          (count) => ({ succeeded: true as const, count }),
          (error) => {
            failed = true;
            logger.error(
              '[agent-triggers] durable delivery maintenance step failed (batch receipts):',
              error,
            );
            return { succeeded: false as const, count: 0 };
          },
        ),
        isolated(
          'legacy actor receipts',
          () =>
            methods.expireLegacyAgentEventActorReceipts?.(
              new Date(),
              purgeRecoveryLimit,
              activity,
            ) ?? Promise.resolve(0),
        ),
        isolated(
          'checkpoint deletion evidence',
          () =>
            deps.reclaimCheckpointDeletions?.(purgeRecoveryLimit, activity) ?? Promise.resolve(0),
        ),
      ]);
      const recoveredBatches = batchRecovery.count;
      const reclaimedLanes = batchRecovery.succeeded
        ? await isolated('lane reclamation', () =>
            methods.reclaimInactiveAgentTriggerLanes(purgeRecoveryLimit, activity),
          )
        : 0;
      if (publishedLanes > 0) {
        deliveryEngine?.wake();
      }
      if (
        purgedUsers > 0 ||
        publishedLanes > 0 ||
        recoveredBatches > 0 ||
        reclaimedLanes > 0 ||
        expiredLegacyActorReceipts > 0 ||
        retiredCheckpointDeletions > 0
      ) {
        logger.info('[agent-triggers] recovered durable delivery maintenance', {
          purgedUsers,
          publishedLanes,
          recoveredBatches,
          reclaimedLanes,
          expiredLegacyActorReceipts,
          retiredCheckpointDeletions,
        });
      }
      return (
        !failed &&
        !activity.found &&
        purgedUsers === 0 &&
        publishedLanes === 0 &&
        recoveredBatches === 0 &&
        reclaimedLanes === 0 &&
        expiredLegacyActorReceipts === 0 &&
        retiredCheckpointDeletions === 0
      );
    })
      .catch((error) => {
        logger.error('[agent-triggers] durable delivery maintenance failed:', error);
        return false;
      })
      .finally(() => {
        if (purgeRecoveryPromise === current) {
          purgeRecoveryPromise = undefined;
        }
      });
    purgeRecoveryPromise = current;
    return current;
  };

  const startPurgeRecovery = (): void => {
    void purgeRecoveryLoop?.start();
  };

  /** Moves waiting completion deliveries forward when what they wait on has
   * changed, and marks held ones so their next deferral re-checks at once. The
   * claim pass always runs: a matching delivery may already be due here without
   * having moved. Best effort: a missed expedite only means the delivery
   * re-checks at its backoff instead of immediately. */
  const expediteCompletions = (input: AgentTriggerCompletionExpedite): void => {
    const expedite = deps.methods?.expediteAgentTriggerDeliveries;
    if (expedite == null || !deliveryReady || stopping) {
      return;
    }
    void runAsSystem(() =>
      expedite({
        ...('user' in input
          ? {
              user: input.user,
              conversationId: input.conversationId,
              ...(input.taskIds != null && { taskIds: input.taskIds }),
            }
          : { deliveryKeys: input.deliveryKeys }),
        sourceIds:
          'user' in input && input.taskIds != null
            ? [SUBAGENT_COMPLETION_SOURCE]
            : COMPLETION_WAKEUP_SOURCES,
        now: new Date(),
      }),
    )
      .then(() => deliveryEngine?.wake())
      .catch((error) =>
        logger.warn('[agent-triggers] failed to expedite waiting completion deliveries:', error),
      );
  };

  let unsubscribeGenerationSettled: (() => void) | undefined;

  const stop = async (): Promise<void> => {
    stopping = true;
    deliveryReady = false;
    unsubscribeGenerationSettled?.();
    unsubscribeGenerationSettled = undefined;
    await purgeRecoveryLoop?.stop();
    await initializePromise?.catch(() => undefined);
    await deliveryEngine?.stop();
    await purgeRecoveryPromise?.catch(() => undefined);
  };

  if (deps.methods != null) {
    registerShutdownTask('agent trigger delivery engine', stop, {
      phase: 'pre-drain',
      priority: 100,
    });
  }

  return {
    initialize: (options = {}) => {
      backgroundCompletionResultBatchSize = options.completionResultBatchSize ?? 8;
      completionWaitMaxIntervalMs =
        options.idlePolling?.completionWaitMaxIntervalMs ?? WAITING_RETRY_CAP_MS;
      boundOrigin = selfOriginFromAddress(options.address) ?? boundOrigin;
      if (deps.methods == null || deliveryReady) {
        return Promise.resolve();
      }
      if (initializePromise != null) {
        return initializePromise;
      }
      if (stopping || isShutdownInProgress()) {
        return Promise.reject(
          new AgentTriggerServiceUnavailableError(
            'Durable agent trigger delivery cannot start during shutdown',
          ),
        );
      }
      const methods = deps.methods;
      initializePromise = runAsSystem(async () => {
        requireDeliveryOrigin(boundOrigin);
        purgeRecoveryLoop = createIdleRecoveryLoop({
          intervalMs: purgeRecoveryIntervalMs,
          maxIdleIntervalMs:
            options.idlePolling?.maintenanceMaxIntervalMs ??
            Math.max(purgeRecoveryIntervalMs, DEFAULT_PURGE_RECOVERY_MAX_IDLE_INTERVAL_MS),
          scan: recoverPurges,
          onError: (error) =>
            logger.error('[agent-triggers] durable delivery maintenance failed:', error),
        });
        await methods.ensureAgentTriggerDeliveryIndexes();
        if (stopping || isShutdownInProgress()) {
          throw new AgentTriggerServiceUnavailableError(
            'Durable agent trigger delivery cannot start during shutdown',
          );
        }
        deliveryEngine = createAgentTriggerDeliveryEngine(
          {
            store: createDeliveryStore(methods, supportsDetachedActionCompletion, () =>
              purgeRecoveryLoop?.wake(),
            ),
            dispatch: dispatchForActivePrincipal,
            ...(deps.settleSourceBeforeDeadLetter != null && {
              settleSourceBeforeDeadLetter: deps.settleSourceBeforeDeadLetter,
            }),
          },
          {
            ...deps.deliveryOptions,
            ...(options.idlePolling?.deliveryMaxIntervalMs != null && {
              maxIdleTickMs: options.idlePolling.deliveryMaxIntervalMs,
            }),
          },
        );
        deliveryReady = true;
        deliveryEngine.start();
        /** Deliveries waiting on a parent resume that parent's conversation, so a
         * settled generation wakes only those, not every waiting task of the user. */
        unsubscribeGenerationSettled ??= deps.subscribeGenerationSettled?.(
          ({ userId, conversationId }) => expediteCompletions({ user: userId, conversationId }),
        );
        startPurgeRecovery();
        logger.info('[agent-triggers] durable delivery engine started');
      }).finally(() => {
        initializePromise = undefined;
      });
      return initializePromise;
    },
    stop,
    dispatch: dispatchForActivePrincipal,
    enqueue: async (envelope, options) => {
      const methods = requireMethods();
      const prepared = prepareAgentTriggerDelivery(envelope, options);
      const awaitTerminalHandling =
        prepared.envelope.mode === 'continue' &&
        prepared.envelope.target.bindingId != null &&
        prepared.envelope.target.sourceKeyId != null;
      const durableDelivery: PreparedAgentTriggerDelivery = {
        ...prepared,
        ...(awaitTerminalHandling && { awaitTerminalHandling: true }),
      };
      await requireActivePrincipal(String(prepared.user));
      const queued = await runAsSystem(async () =>
        withMaintenanceRecovery(
          () => methods.enqueueAgentTriggerDelivery(durableDelivery),
          () => purgeRecoveryLoop?.wake(),
        ),
      );
      try {
        await requireActivePrincipal(String(prepared.user));
      } catch (error) {
        await drainUser(String(prepared.user));
        throw error;
      }
      const eligibleAt = queued.delivery.availableAt;
      if (eligibleAt instanceof Date && eligibleAt.getTime() > Date.now()) {
        deliveryEngine?.noteEligibleAt(eligibleAt);
      } else {
        deliveryEngine?.wake();
      }
      const effective =
        queued.delivery.status === 'batched'
          ? await runAsSystem(async () =>
              methods.getAgentTriggerDeliveryStatus(
                prepared.deliveryKey,
                prepared.user,
                prepared.envelope.event.source.id,
                prepared.tenantId,
              ),
            )
          : null;
      return {
        id: queued.delivery.id,
        deliveryKey: queued.delivery.deliveryKey,
        status: publicReceiptStatus(effective?.status ?? queued.delivery.status),
        availableAt: effective?.availableAt ?? queued.delivery.availableAt,
        replayed: queued.replayed,
      };
    },
    getDelivery: (deliveryKey) =>
      runAsSystem(async () => requireMethods().getAgentTriggerDelivery(deliveryKey)),
    getDeliveryStatus: (deliveryKey, userId, sourceKeyId, tenantId) =>
      runAsSystem(async () =>
        requireMethods().getAgentTriggerDeliveryStatus(deliveryKey, userId, sourceKeyId, tenantId),
      ),
    getDeadLetters: (limit) =>
      runAsSystem(async () => requireMethods().getAgentTriggerDeadLetters(limit)),
    requeue: (id, availableAt = new Date()) =>
      runAsSystem(async () => {
        const methods = requireMethods();
        const revived = await withMaintenanceRecovery(
          () => methods.requeueAgentTriggerDelivery(id, availableAt),
          () => purgeRecoveryLoop?.wake(),
        );
        if (revived != null) {
          if (availableAt.getTime() > Date.now()) {
            deliveryEngine?.noteEligibleAt(availableAt);
          } else {
            deliveryEngine?.wake();
          }
        }
        return revived;
      }),
    retire: (deliveryKey, sourceId, reason, options) =>
      runAsSystem(async () => {
        const methods = requireCleanupMethods();
        const retired = await withMaintenanceRecovery(
          (recovery) =>
            methods.retireAgentTriggerDelivery(
              {
                deliveryKey,
                sourceId,
                reason,
                settledAt: new Date(),
                ...(options?.onlyIfUnclaimed === true ? { onlyIfUnclaimed: true } : {}),
                ...(options?.onlyIfDead === true ? { onlyIfDead: true } : {}),
                ...(options?.requireTransition === true ? { requireTransition: true } : {}),
              },
              recovery,
            ),
          () => purgeRecoveryLoop?.wake(),
        );
        if (retired) {
          deliveryEngine?.wake();
        }
        return retired;
      }),
    // A background tool keeps running while the server drains, and its result must
    // still reach the durable receipt, so producer writes stay available after
    // admissions and the delivery engine stop.
    renewProducerLease: (deliveryKey, sourceId, leaseUntil) =>
      runAsSystem(async () =>
        requireCleanupMethods().renewAgentTriggerDeliveryProducerLease({
          deliveryKey,
          sourceId,
          leaseUntil,
        }),
      ),
    persistBackgroundToolResult: (input) =>
      runAsSystem(async () => {
        const persist = requireCleanupMethods().persistAgentBackgroundToolResult;
        const persisted = persist == null ? false : await persist(input);
        if (persisted) {
          expediteCompletions({ deliveryKeys: [input.deliveryKey] });
        }
        return persisted;
      }),
    getBackgroundToolResultClaim: (input) =>
      runAsSystem(async () => {
        const getClaim = requireMethods().getAgentBackgroundToolResultClaim;
        return getClaim == null ? null : getClaim(input);
      }),
    getBackgroundCompletionResultBatchSize: () => backgroundCompletionResultBatchSize,
    getCompletionWaitMaxIntervalMs: () => completionWaitMaxIntervalMs,
    expediteCompletionWakeups: (input) => expediteCompletions(input),
    releaseBackgroundToolResultClaims: (input) =>
      runAsSystem(async () => {
        const release = requireMethods().releaseAgentBackgroundToolResultClaims;
        return release == null ? false : release(input);
      }),
    drainUser,
    prepareUserPurge: (userId, fenceStartedAt, tenantId) =>
      runAsSystem(async () => {
        const methods = requireCleanupMethods();
        await withMaintenanceRecovery(
          () => methods.prepareAgentTriggerUserPurge(userId, fenceStartedAt, tenantId),
          () => purgeRecoveryLoop?.wake(),
        );
        purgeRecoveryLoop?.wake();
      }),
    cancelUserPurge: (userId, fenceStartedAt) =>
      runAsSystem(async () =>
        requireCleanupMethods().cancelAgentTriggerUserPurge(userId, fenceStartedAt),
      ),
    // Account deletion may reach this post-commit cleanup after graceful
    // shutdown has begun. Persistence remains usable even though admissions
    // and the delivery engine are deliberately no longer ready.
    purgeUser: (userId) =>
      runAsSystem(async () => {
        const methods = requireCleanupMethods();
        await withMaintenanceRecovery(
          () => methods.deleteAgentTriggerDeliveriesByUser(userId),
          () => purgeRecoveryLoop?.wake(),
        );
        purgeRecoveryLoop?.wake();
      }),
  };
}
