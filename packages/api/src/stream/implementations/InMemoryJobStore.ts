import { logger } from '@librechat/data-schemas';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type {
  SerializableJobData,
  CreatedJobData,
  ReplacedGeneration,
  SteerArmOutcome,
  SteerArmResult,
  SteerEnqueueReceiptResult,
  SteerEnqueueVersionedResult,
  TerminalSteerAdmissionPolicy,
  TerminalSteerAdmissionResult,
  SteerQueueItem,
  SteerReceipt,
  SteerReceiptInput,
  UsageMetadata,
  IJobStoreV2,
  JobStatus,
  JobMetadataPatch,
  JobStatusTransition,
  IdempotencyClaimValue,
  IdempotencyClaimResult,
  ParkedSteerClaim,
} from '~/stream/interfaces/IJobStore';
import type { EarlyBufferOverflowState } from '../../types/earlyBufferRecovery';
import type { RecoveredSteerPayload } from '~/stream/SteerRecovery';
import {
  JobStatusTransitionDeadlineError,
  JobPredecessorMismatchError,
  STEER_ENQUEUE_NOT_RUNNING,
  STEER_ENQUEUE_QUEUE_FULL,
  STEER_ENQUEUE_RECEIPT_FULL,
  STEER_QUEUE_MAX_DEPTH,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
  PAUSE_PERSISTENCE_TIMEOUT_MS,
  PROVIDER_DRAIN_TIMEOUT_MS,
  isPendingActionStale,
  toWireRunSteps,
} from '~/stream/interfaces/IJobStore';
import {
  isRecoveredSteerPayload,
  recoveredSteerPayloadMatches,
  RecoveredSteerPayloadMismatchError,
} from '~/stream/SteerRecovery';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { toPendingSteer } from '~/stream/SteeringLifecycle';

/** Recovery window for parked steers (mirrors Redis's completed-job TTL). */
export const PARKED_STEERS_TTL_MS: number = 5 * 60 * 1000;
const STEER_RECEIPT_TTL_MS: number = 20 * 60 * 1000;
const STEER_RECEIPT_MAX_PER_STREAM: number = 100;
const CREATE_REPLACEMENT_RECEIPT_MAX = 32;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const TERMINAL_PERSISTENCE_RETENTION_MS = 5 * 60 * 1000;
/** Bounded window a terminal job owing a host lifecycle hook is retained for retry before
 *  it is reaped even if unacknowledged (a permanently-failing hook cannot leak forever).
 *  Mirrors the Redis store's 24h host-action TTL. */
const HOST_ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;

function assertCreateIdempotencyArguments(
  claimKey?: string,
  claimToken?: string,
  clientRequestId?: string,
): void {
  const supplied = [claimKey, claimToken, clientRequestId].filter((value) => value != null).length;
  if (
    (supplied !== 0 && supplied !== 3) ||
    (supplied === 3 &&
      (claimKey!.length === 0 ||
        claimKey!.length > 1024 ||
        claimToken!.length === 0 ||
        claimToken!.length > 128 ||
        !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId!)))
  ) {
    throw new Error('Invalid generation job idempotency arguments');
  }
}

function isValidParkedSteer(value: unknown): value is { steerId: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.steerId !== 'string' || item.steerId.length === 0) {
    return false;
  }
  if (
    item.clientSteerId != null &&
    (typeof item.clientSteerId !== 'string' || item.clientSteerId.length === 0)
  ) {
    return false;
  }
  if (item.text != null && typeof item.text !== 'string') {
    return false;
  }
  if (
    item.createdAt != null &&
    (typeof item.createdAt !== 'number' ||
      !Number.isSafeInteger(item.createdAt) ||
      item.createdAt < 0)
  ) {
    return false;
  }
  if (
    item.recoveringCreatedAt != null &&
    (typeof item.recoveringCreatedAt !== 'number' ||
      !Number.isSafeInteger(item.recoveringCreatedAt) ||
      item.recoveringCreatedAt < 0)
  ) {
    return false;
  }
  return true;
}

function usesReceiptSafeProtocol(job: SerializableJobData | null | undefined): boolean {
  return job?.generationProtocolVersion === 2;
}

function normalizeGenerationProtocol(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1;
}

function isValidGenerationProtocolMarker(value: unknown): boolean {
  return value == null || value === 1 || value === 2;
}

/**
 * Content state for a job - volatile, in-memory only.
 * Uses WeakRef to allow garbage collection of graph when no longer needed.
 */
interface ContentState {
  contentParts: Agents.MessageContentComplex[];
  graphRef: WeakRef<StandardGraph> | null;
  collectedUsage: UsageMetadata[];
}

/**
 * In-memory implementation of IJobStoreV2.
 * Suitable for single-instance deployments.
 * For horizontal scaling, use RedisJobStore.
 *
 * Content state is tied to jobs:
 * - Uses WeakRef to graph for live access to contentParts and contentData (run steps)
 * - No chunk persistence needed - same instance handles generation and reconnects
 */
export class InMemoryJobStore implements IJobStoreV2 {
  readonly detachedAgentEventActionStoreMode = 'process_local' as const;

  private jobs = new Map<string, SerializableJobData>();
  private contentState = new Map<string, ContentState>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Maps userId -> Set of streamIds (conversationIds) for active jobs */
  private userJobMap = new Map<string, Set<string>>();

  /**
   * Maps streamId -> last generation-activity timestamp. Refreshed via
   * recordActivity() on each emitted chunk so the stale-job failsafe reaps on
   * inactivity (a hung generation) rather than age (a long but live stream).
   */
  private lastActivity = new Map<string, number>();

  /** Maps streamId -> FIFO queue of pending steer messages. */
  private steerQueues = new Map<string, SteerQueueItem[]>();

  /** FIFO items removed from the pending queue but not yet durably applied.
   * Keeping this independently of receipts also protects legacy steers that
   * do not carry a clientSteerId. */
  private claimedSteers = new Map<string, SteerQueueItem[]>();

  /** Stream ids whose steer queue was closed by a terminal drain. Reopened by createJob. */
  private closedSteerQueues = new Set<string>();

  /** Parked terminally-drained steers — lifecycle-independent of `jobs` (the
   *  default completeJob path deletes the job record immediately). */
  private parkedSteers = new Map<string, { payload: string; expiresAt: number }>();

  /** Conversation-scoped lost-ACK receipts; deliberately survives job replacement. */
  private steerReceipts = new Map<
    string,
    Map<string, { receipt: SteerReceipt; expiresAt: number }>
  >();

  /** Maps idempotency key -> claimed stream + expiry, deduping retried start requests. */
  private idempotencyClaims = new Map<
    string,
    { value: IdempotencyClaimValue; expiresAt: number }
  >();

  /** Time to keep completed jobs before cleanup (0 = immediate) */
  private ttlAfterComplete = 0;

  /** Maximum number of concurrent jobs */
  private maxJobs = 1000;

  /** Store-lifetime generation clock. A completed job may be deleted before a
   * same-millisecond replacement starts, so the current jobs map alone cannot
   * guarantee a distinct checkpoint namespace. */
  private lastGenerationEpoch = 0;

  /** Latest per-stream epoch retained briefly after its job disappears. This
   * is also the conditional-create fence: a delayed queue drain must not treat
   * an empty job slot as proof that no intervening generation ran. */
  private generationEpochs = new Map<string, { createdAt: number; expiresAt: number }>();

  /**
   * Failsafe timeout (ms) for jobs stuck in "running" status. Mirrors
   * RedisJobStore's running-job TTL: a crashed or hung generation that never
   * reaches a terminal state would otherwise retain its content state forever,
   * leaking the full message context until the process runs out of memory.
   * 0 disables the failsafe. Default: 20 minutes.
   */
  private staleJobTimeout = 1_200_000;

  constructor(options?: { ttlAfterComplete?: number; maxJobs?: number; staleJobTimeout?: number }) {
    if (options?.ttlAfterComplete) {
      this.ttlAfterComplete = options.ttlAfterComplete;
    }
    if (options?.maxJobs) {
      this.maxJobs = options.maxJobs;
    }
    if (options?.staleJobTimeout !== undefined) {
      this.staleJobTimeout = options.staleJobTimeout;
    }
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[InMemoryJobStore] Initialized with cleanup interval');
  }

  private getRetainedGenerationEpoch(streamId: string, now = Date.now()): number | undefined {
    const retained = this.generationEpochs.get(streamId);
    if (retained == null) {
      return undefined;
    }
    if (retained.expiresAt <= now) {
      this.generationEpochs.delete(streamId);
      return undefined;
    }
    return retained.createdAt;
  }

  private retainGenerationEpoch(streamId: string, createdAt: number, now = Date.now()): void {
    const retained = this.generationEpochs.get(streamId);
    if (retained != null && retained.createdAt > createdAt) {
      return;
    }
    this.generationEpochs.set(streamId, {
      createdAt,
      expiresAt: now + PARKED_STEERS_TTL_MS,
    });
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    initialMetadata: JobMetadataPatch = {},
    recoveredSteerId?: string,
    idempotencyClaimKey?: string,
    idempotencyClaimToken?: string,
    idempotencyClientRequestId?: string,
    recoveredSteerPayload?: RecoveredSteerPayload,
    creationAttemptId?: string,
    expectedPredecessorCreatedAt?: number,
    rejectActivePredecessor?: boolean,
  ): Promise<CreatedJobData> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('Generation job requires a non-empty user id');
    }
    assertCreateIdempotencyArguments(
      idempotencyClaimKey,
      idempotencyClaimToken,
      idempotencyClientRequestId,
    );
    if (
      creationAttemptId != null &&
      (creationAttemptId.length === 0 || creationAttemptId.length > 128)
    ) {
      throw new Error('Invalid generation creation attempt id');
    }
    if (
      expectedPredecessorCreatedAt != null &&
      (!Number.isSafeInteger(expectedPredecessorCreatedAt) || expectedPredecessorCreatedAt < 0)
    ) {
      throw new Error('Invalid expected generation predecessor');
    }
    if (rejectActivePredecessor != null && typeof rejectActivePredecessor !== 'boolean') {
      throw new Error('Invalid active generation predecessor policy');
    }
    const providerExecutionId = initialMetadata.providerExecutionId;
    if (
      providerExecutionId != null &&
      (providerExecutionId.length === 0 || providerExecutionId.length > 128)
    ) {
      throw new Error('Invalid provider execution id');
    }
    const safeInitialMetadata = { ...initialMetadata };
    delete safeInitialMetadata.providerDrained;
    const assertOwnerCompatible = (): void => {
      const existingJob = this.jobs.get(streamId);
      if (
        existingJob != null &&
        (typeof existingJob.userId !== 'string' ||
          existingJob.userId.length === 0 ||
          existingJob.userId !== userId ||
          (existingJob.tenantId != null && existingJob.tenantId !== tenantId))
      ) {
        throw recoveredSteerId != null
          ? new RecoveredSteerPayloadMismatchError('owner_mismatch')
          : new Error('Generation job owner mismatch');
      }

      const parked = this.parkedSteers.get(streamId);
      if (parked == null || parked.expiresAt <= Date.now()) {
        return;
      }
      let parsed: {
        userId?: unknown;
        tenantId?: unknown;
        generationProtocolVersion?: unknown;
        steers?: unknown;
      };
      try {
        parsed = JSON.parse(parked.payload) as typeof parsed;
      } catch {
        throw new Error('Generation recovery state is corrupt');
      }
      if (
        parsed == null ||
        typeof parsed !== 'object' ||
        typeof parsed.userId !== 'string' ||
        parsed.userId.length === 0 ||
        !isValidGenerationProtocolMarker(parsed.generationProtocolVersion) ||
        !Array.isArray(parsed.steers) ||
        parsed.steers.length === 0 ||
        !parsed.steers.every(isValidParkedSteer)
      ) {
        throw new Error('Generation recovery state is corrupt');
      }
      if (parsed.userId !== userId || (parsed.tenantId != null && parsed.tenantId !== tenantId)) {
        throw recoveredSteerId != null
          ? new RecoveredSteerPayloadMismatchError('owner_mismatch')
          : new Error('Generation job owner mismatch');
      }
    };

    const assertExpectedPredecessorCompatible = (): void => {
      const current = this.jobs.get(streamId);
      const currentCreatedAt = current?.createdAt ?? this.getRetainedGenerationEpoch(streamId);
      if (
        current?.terminalHostActionPending === true ||
        (rejectActivePredecessor === true &&
          (current?.status === 'running' ||
            current?.status === 'requires_action' ||
            current?.terminalPersistencePending === true))
      ) {
        throw new JobPredecessorMismatchError({
          createdAt: current.createdAt,
          active: true,
          verified: true,
          status: current.status,
          ...(current.conversationId !== undefined && {
            conversationId: current.conversationId,
          }),
        });
      }
      if (
        expectedPredecessorCreatedAt == null ||
        currentCreatedAt === expectedPredecessorCreatedAt
      ) {
        return;
      }
      throw new JobPredecessorMismatchError({
        createdAt: currentCreatedAt ?? expectedPredecessorCreatedAt,
        active: current?.status === 'running' || current?.status === 'requires_action',
        verified: currentCreatedAt != null,
        ...(current !== undefined && { status: current.status }),
        ...(current?.conversationId !== undefined && {
          conversationId: current.conversationId,
        }),
      });
    };

    /** Validate the source and payload before any predecessor/parked mutation.
     * This closure is re-run after the only await below, making the validation
     * and subsequent lease one synchronous in-memory transaction. */
    const assertRecoveryCompatible = (): void => {
      if (recoveredSteerId == null) {
        if (recoveredSteerPayload != null) {
          throw new RecoveredSteerPayloadMismatchError('invalid_payload');
        }
        return;
      }
      if (!isRecoveredSteerPayload(recoveredSteerPayload)) {
        throw new RecoveredSteerPayloadMismatchError('invalid_payload');
      }
      if (initialMetadata.generationProtocolVersion === 1) {
        throw new RecoveredSteerPayloadMismatchError('protocol_mismatch');
      }

      let candidate: ReturnType<typeof toPendingSteer> | undefined;
      let sourceProtocol: 1 | 2 = 1;
      const parked = this.parkedSteers.get(streamId);
      if (parked != null && parked.expiresAt > Date.now()) {
        try {
          const parsed = JSON.parse(parked.payload) as {
            generationProtocolVersion?: unknown;
            steers?: Array<ReturnType<typeof toPendingSteer>>;
          };
          candidate = parsed.steers?.find((item) => item.steerId === recoveredSteerId);
          sourceProtocol = normalizeGenerationProtocol(parsed.generationProtocolVersion);
        } catch {
          // assertOwnerCompatible reports the more specific corruption error.
        }
      }

      if (candidate == null) {
        sourceProtocol = normalizeGenerationProtocol(
          this.jobs.get(streamId)?.generationProtocolVersion,
        );
        const queued = [
          ...this.claimedSteerItems(streamId, this.jobs.get(streamId)?.createdAt),
          ...(this.steerQueues.get(streamId) ?? []),
        ];
        const item = queued.find((queuedItem) => queuedItem.steerId === recoveredSteerId);
        candidate = item == null ? undefined : toPendingSteer(item);
      }

      if (candidate == null) {
        throw new RecoveredSteerPayloadMismatchError('source_missing');
      }
      if (sourceProtocol !== 2) {
        throw new RecoveredSteerPayloadMismatchError('protocol_mismatch');
      }
      if (!recoveredSteerPayloadMatches(candidate, recoveredSteerPayload)) {
        throw new RecoveredSteerPayloadMismatchError();
      }
    };

    // Validate before capacity eviction and repeat after its only await. This
    // preserves both an existing foreign job and malformed/foreign recovery
    // payload even when another creator races the eviction yield.
    assertOwnerCompatible();
    assertExpectedPredecessorCompatible();
    assertRecoveryCompatible();
    if (idempotencyClaimKey != null && idempotencyClaimToken != null) {
      const claim = this.idempotencyClaims.get(idempotencyClaimKey);
      if (
        claim == null ||
        claim.expiresAt <= Date.now() ||
        claim.value.claimToken !== idempotencyClaimToken ||
        claim.value.startedAt != null
      ) {
        throw new Error('Generation idempotency claim was taken over before job creation');
      }
    }
    if (!this.jobs.has(streamId) && this.jobs.size >= this.maxJobs) {
      await this.evictOldest();
    }
    assertOwnerCompatible();
    assertExpectedPredecessorCompatible();
    assertRecoveryCompatible();

    // Re-read after the possible eviction await. A concurrent creator can
    // install this stream while capacity eviction yields; this is the exact
    // predecessor the synchronous replacement below will overwrite.
    const previousJob = this.jobs.get(streamId);
    const previousCreatedAt = previousJob?.createdAt ?? this.getRetainedGenerationEpoch(streamId);
    const now = Date.now();
    const createdAt = Math.max(
      now,
      previousCreatedAt == null ? 0 : previousCreatedAt + 1,
      this.lastGenerationEpoch + 1,
    );
    const replacedJobs: ReplacedGeneration[] = [];
    const replacedEpochs = new Set<number>();
    const addReplacedJob = (replaced: ReplacedGeneration): void => {
      if (replacedEpochs.has(replaced.createdAt)) {
        return;
      }
      if (replacedJobs.length >= CREATE_REPLACEMENT_RECEIPT_MAX) {
        throw new Error('Generation replacement receipt chain is full');
      }
      replacedEpochs.add(replaced.createdAt);
      replacedJobs.push(replaced);
    };
    const previousReceipt = previousJob as CreatedJobData | undefined;
    for (const inherited of previousReceipt?.replacedJobs ??
      (previousReceipt?.replacedJob != null ? [previousReceipt.replacedJob] : [])) {
      addReplacedJob(inherited);
    }
    if (previousJob != null) {
      const replaced: ReplacedGeneration = {
        createdAt: previousJob.createdAt,
        status: previousJob.status,
        ...(previousJob.conversationId !== undefined && {
          conversationId: previousJob.conversationId,
        }),
      };
      if (previousJob.providerAbortReady != null) {
        Object.defineProperty(replaced, 'providerAbortReady', {
          value: previousJob.providerAbortReady,
          enumerable: false,
        });
      }
      if (previousJob.providerExecutionId != null) {
        Object.defineProperty(replaced, 'providerExecutionId', {
          value: previousJob.providerExecutionId,
          enumerable: false,
        });
      }
      if (previousJob.providerDrained != null) {
        Object.defineProperty(replaced, 'providerDrained', {
          value: previousJob.providerDrained,
          enumerable: false,
        });
      }
      addReplacedJob(replaced);
    }
    this.lastGenerationEpoch = createdAt;
    const job: CreatedJobData = {
      ...safeInitialMetadata,
      streamId,
      userId,
      ...(tenantId && { tenantId }),
      status: 'running',
      createdAt,
      generationProtocolVersion: initialMetadata.generationProtocolVersion === 1 ? 1 : 2,
      ...(initialMetadata.generationProtocolVersion !== 1 && {
        checkpointNamespace: createCheckpointNamespace(userId, tenantId),
      }),
      ...(conversationId !== undefined && { conversationId }),
      ...(idempotencyClientRequestId !== undefined && {
        idempotencyClientRequestId,
      }),
      ...(recoveredSteerId !== undefined && { recoveredSteerId }),
      providerAbortReady: false,
      ...(providerExecutionId != null && { providerDrained: true }),
      syncSent: false,
    };
    if (creationAttemptId != null) {
      Object.defineProperty(job, 'creationAttemptId', {
        value: creationAttemptId,
        enumerable: false,
        configurable: true,
      });
    }
    if (previousJob != null) {
      Object.defineProperty(job, 'replacedJob', {
        value: replacedJobs[replacedJobs.length - 1],
        enumerable: false,
        configurable: true,
      });
    }
    if (replacedJobs.length > 0) {
      Object.defineProperty(job, 'replacedJobs', {
        value: replacedJobs,
        enumerable: false,
        configurable: true,
      });
    }

    // Re-check after the possible eviction await. A stale creator must not
    // park/replace state after another request took over its pre-create lease.
    const liveClaim =
      idempotencyClaimKey != null ? this.idempotencyClaims.get(idempotencyClaimKey) : undefined;
    if (
      idempotencyClaimKey != null &&
      idempotencyClaimToken != null &&
      (liveClaim == null ||
        liveClaim.expiresAt <= Date.now() ||
        liveClaim.value.claimToken !== idempotencyClaimToken ||
        liveClaim.value.startedAt != null)
    ) {
      throw new Error('Generation idempotency claim was taken over before job creation');
    }

    if (previousJob != null) {
      this.parkQueuedSteers(streamId, previousJob, now);
    }
    this.jobs.set(streamId, job);
    this.retainGenerationEpoch(streamId, job.createdAt, now);
    this.leaseParkedSteer(streamId, recoveredSteerId, userId, tenantId, job.createdAt);
    this.contentState.delete(streamId);
    // Clear any prior activity timestamp so a replacement reusing this streamId
    // (the controller handles job replacement) falls back to the fresh createdAt
    // and isn't reaped on the previous generation's stale last-activity time.
    this.lastActivity.delete(streamId);
    // Steer queues are keyed by streamId only, so a replacement must not
    // inherit the replaced run's undrained steers or its closed flag. Any
    // acknowledged items were copied into owner-gated parked recovery above.
    this.steerQueues.delete(streamId);
    this.claimedSteers.delete(streamId);
    this.closedSteerQueues.delete(streamId);

    if (liveClaim != null) {
      liveClaim.value = { ...liveClaim.value, startedAt: job.createdAt };
    }

    // Track job by userId (tenant-qualified when available) for efficient user-scoped queries
    const userKey = tenantId ? `${tenantId}:${userId}` : userId;
    if (previousJob != null) {
      const previousUserKey = previousJob.tenantId
        ? `${previousJob.tenantId}:${previousJob.userId}`
        : previousJob.userId;
      if (previousUserKey !== userKey) {
        const previousUserJobs = this.userJobMap.get(previousUserKey);
        previousUserJobs?.delete(streamId);
        if (previousUserJobs?.size === 0) {
          this.userJobMap.delete(previousUserKey);
        }
      }
    }
    let userJobs = this.userJobMap.get(userKey);
    if (!userJobs) {
      userJobs = new Set();
      this.userJobMap.set(userKey, userJobs);
    }
    userJobs.add(streamId);

    const createdJob: CreatedJobData = previousJob == null ? job : { ...job };
    if (previousJob != null) {
      if (creationAttemptId != null) {
        Object.defineProperty(createdJob, 'creationAttemptId', {
          value: creationAttemptId,
          enumerable: false,
          configurable: true,
        });
      }
      Object.defineProperty(createdJob, 'replacedJob', {
        value: {
          createdAt: previousJob.createdAt,
          status: previousJob.status,
          ...(previousJob.conversationId !== undefined && {
            conversationId: previousJob.conversationId,
          }),
        },
        enumerable: false,
        configurable: true,
        writable: false,
      });
      Object.defineProperty(createdJob, 'replacedJobs', {
        value: replacedJobs,
        enumerable: false,
        configurable: true,
      });
    }

    logger.debug(`[InMemoryJobStore] Created job: ${streamId}`);

    return createdJob;
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    return this.jobs.get(streamId) ?? null;
  }

  async acknowledgeReplacedJobs(
    streamId: string,
    creationAttemptId: string,
    replacedCreatedAts: readonly number[],
  ): Promise<boolean> {
    const job = this.jobs.get(streamId) as CreatedJobData | undefined;
    if (job?.creationAttemptId !== creationAttemptId) {
      return false;
    }
    const acknowledged = new Set(replacedCreatedAts);
    const current = job.replacedJobs ?? (job.replacedJob != null ? [job.replacedJob] : []);
    const retained = current.filter((receipt) => !acknowledged.has(receipt.createdAt));
    delete job.replacedJobs;
    delete job.replacedJob;
    if (retained.length > 0) {
      Object.defineProperty(job, 'replacedJobs', {
        value: retained,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(job, 'replacedJob', {
        value: retained[retained.length - 1],
        enumerable: false,
        configurable: true,
      });
    }
    return true;
  }

  async updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedCreatedAt?: number,
  ): Promise<void> {
    const job = this.jobs.get(streamId);
    if (!job || (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)) {
      return;
    }
    if (
      updates.status != null &&
      ['complete', 'error', 'aborted'].includes(updates.status) &&
      (job.status === 'running' || job.status === 'requires_action')
    ) {
      const { status, ...patch } = updates;
      await this.transitionStatus(streamId, {
        from: job.status,
        to: status,
        patch,
        expectCreatedAt: expectedCreatedAt ?? job.createdAt,
      });
      return;
    }
    // Plain field writer. Membership-aware status transitions
    // (running ⇄ requires_action) go solely through transitionStatus.
    Object.assign(job, updates);
  }

  async markProviderExecutionDrained(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (job?.createdAt !== expectedCreatedAt || job.providerExecutionId !== providerExecutionId) {
      return false;
    }
    job.providerDrained = true;
    return true;
  }

  async beginProviderExecution(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (
      job?.createdAt !== expectedCreatedAt ||
      job.providerExecutionId !== providerExecutionId ||
      job.status !== 'running' ||
      job.providerDrained !== true
    ) {
      return false;
    }
    job.providerDrained = false;
    job.providerExecutionStartedId = providerExecutionId;
    return true;
  }

  async finalizeTerminalPersistence(
    streamId: string,
    expectedCreatedAt: number,
    finalEvent: string,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job || job.createdAt !== expectedCreatedAt || job.terminalPersistencePending !== true) {
      return false;
    }
    job.terminalPersistencePending = false;
    job.finalEvent = finalEvent;
    return true;
  }

  /**
   * Atomic in-memory: the single-threaded event loop makes the
   * read-check-write sequence indivisible, so the status guard is exact.
   * Membership/counts derive from `job.status` directly, so there are no
   * sets to reconcile here.
   */
  async transitionStatus(streamId: string, args: JobStatusTransition): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job || job.status !== args.from) {
      return false;
    }
    if (args.expectActionId != null && job.pendingActionId !== args.expectActionId) {
      return false;
    }
    if (args.expectCreatedAt != null && job.createdAt !== args.expectCreatedAt) {
      return false;
    }
    if (args.notAfterMs != null && Date.now() >= args.notAfterMs) {
      throw new JobStatusTransitionDeadlineError(args.notAfterMs);
    }
    if (['complete', 'error', 'aborted'].includes(args.to)) {
      if (!this.isParkedRecoveryCompatible(streamId, job)) {
        return false;
      }
      this.parkQueuedSteers(streamId, job, Date.now());
    }
    job.status = args.to;
    if (args.patch) {
      Object.assign(job, args.patch);
    }
    for (const field of args.clear ?? []) {
      delete job[field];
    }
    const receiptEntries = this.steerReceipts.get(streamId)?.values() ?? [];
    if (args.to === 'requires_action' && args.patch?.pendingAction?.expiresAt == null) {
      // Unlike Redis, this store has no paused-job backstop eviction. Preserve
      // the receipt for the full (potentially unbounded) approval lifetime.
      for (const entry of receiptEntries) {
        if (entry.receipt.generationCreatedAt === job.createdAt) {
          entry.expiresAt = Infinity;
        }
      }
    } else {
      const normalExpiry = Date.now() + STEER_RECEIPT_TTL_MS;
      const requestedExpiry =
        args.steerReceiptTtlSeconds != null
          ? Date.now() + Math.max(1, args.steerReceiptTtlSeconds) * 1000
          : 0;
      const terminalExpiry = ['complete', 'error', 'aborted'].includes(args.to)
        ? Date.now() + PARKED_STEERS_TTL_MS
        : 0;
      const targetExpiry = Math.max(
        requestedExpiry,
        terminalExpiry,
        args.from === 'requires_action' ? normalExpiry : 0,
      );
      if (targetExpiry > 0) {
        for (const entry of receiptEntries) {
          if (entry.receipt.generationCreatedAt !== job.createdAt) {
            continue;
          }
          entry.expiresAt = Number.isFinite(entry.expiresAt)
            ? Math.max(entry.expiresAt, targetExpiry)
            : targetExpiry;
        }
      }
    }
    if (args.to === 'running') {
      this.extendRecoveryLease(streamId, job, this.runningRecoveryLeaseExpiry(Date.now()));
    } else if (args.to === 'requires_action') {
      const approvalExpiry = args.patch?.pendingAction?.expiresAt;
      this.extendRecoveryLease(
        streamId,
        job,
        approvalExpiry == null
          ? Number.POSITIVE_INFINITY
          : Math.max(
              this.runningRecoveryLeaseExpiry(Date.now()),
              approvalExpiry + PARKED_STEERS_TTL_MS,
            ),
      );
    }
    return true;
  }

  async transitionStatusAndDrainSteers(
    streamId: string,
    args: JobStatusTransition,
  ): Promise<SteerQueueItem[] | null> {
    if (!['complete', 'error', 'aborted'].includes(args.to)) {
      throw new Error('Steer-draining status transitions must be terminal');
    }
    const job = this.jobs.get(streamId);
    if (
      !job ||
      job.status !== args.from ||
      (args.expectActionId != null && job.pendingActionId !== args.expectActionId) ||
      (args.expectCreatedAt != null && job.createdAt !== args.expectCreatedAt)
    ) {
      return null;
    }
    const seen = new Set<string>();
    const drained = [
      ...this.claimedSteerItems(streamId, job.createdAt),
      ...(this.steerQueues.get(streamId) ?? []),
    ]
      .filter((item) => {
        if (seen.has(item.steerId)) {
          return false;
        }
        seen.add(item.steerId);
        return true;
      })
      .map((item) => ({ ...item }));

    // transitionStatus contains no await, so the validation, snapshot, and
    // terminal mutation remain one indivisible event-loop operation.
    const transitioned = await this.transitionStatus(streamId, args);
    return transitioned ? drained : null;
  }

  async claimIdempotencyKey(
    key: string,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<IdempotencyClaimResult> {
    const now = Date.now();
    const existing = this.idempotencyClaims.get(key);
    if (existing && existing.expiresAt > now) {
      return { claimed: false, existing: existing.value };
    }
    this.idempotencyClaims.set(key, {
      value,
      expiresAt: now + ttlSeconds * 1000,
    });
    return { claimed: true, existing: value };
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    const existing = this.idempotencyClaims.get(key);
    if (existing == null) {
      return false;
    }
    if (existing.expiresAt > Date.now()) {
      return true;
    }
    this.idempotencyClaims.delete(key);
    return false;
  }

  async getIdempotencyClaim(key: string): Promise<IdempotencyClaimValue | null> {
    const existing = this.idempotencyClaims.get(key);
    if (existing == null) {
      return null;
    }
    if (existing.expiresAt <= Date.now()) {
      this.idempotencyClaims.delete(key);
      return null;
    }
    return { ...existing.value };
  }

  async takeoverIdempotencyKey(
    key: string,
    expected: IdempotencyClaimValue,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<boolean> {
    const current = this.idempotencyClaims.get(key);
    if (
      current == null ||
      current.expiresAt <= Date.now() ||
      current.value.claimToken !== expected.claimToken ||
      current.value.startedAt != null
    ) {
      return false;
    }
    this.idempotencyClaims.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async markIdempotencyKeyStarted(
    key: string,
    claimToken: string,
    startedAt: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const current = this.idempotencyClaims.get(key);
    if (
      claimToken.length === 0 ||
      current == null ||
      current.expiresAt <= Date.now() ||
      current.value.claimToken !== claimToken ||
      (current.value.startedAt != null && current.value.startedAt !== startedAt)
    ) {
      return false;
    }
    current.value = { ...current.value, startedAt };
    current.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }

  async adoptIdempotencyKeyForJob(
    key: string,
    expected: IdempotencyClaimValue,
    streamId: string,
    userId: string,
    clientRequestId: string,
    tenantId: string | undefined,
    expectedCreatedAt: number,
    ttlSeconds: number,
    allowMissingClientRequestId = false,
  ): Promise<boolean> {
    const claim = this.idempotencyClaims.get(key);
    const job = this.jobs.get(streamId);
    if (
      claim == null ||
      claim.expiresAt <= Date.now() ||
      claim.value.claimToken !== expected.claimToken ||
      claim.value.startedAt != null ||
      job == null ||
      job.userId !== userId ||
      (job.tenantId != null && job.tenantId !== tenantId) ||
      (job.idempotencyClientRequestId == null
        ? !allowMissingClientRequestId
        : job.idempotencyClientRequestId !== clientRequestId) ||
      job.createdAt !== expectedCreatedAt ||
      (job.status !== 'running' && job.status !== 'requires_action')
    ) {
      return false;
    }
    claim.value = {
      ...claim.value,
      startedAt: job.createdAt,
      generationProtocolVersion: normalizeGenerationProtocol(job.generationProtocolVersion),
    };
    claim.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }

  async releaseIdempotencyKey(key: string, expected?: IdempotencyClaimValue): Promise<void> {
    if (
      expected != null &&
      this.idempotencyClaims.get(key)?.value.claimToken !== expected.claimToken
    ) {
      return;
    }
    this.idempotencyClaims.delete(key);
  }

  async deleteJob(streamId: string, expectedCreatedAt?: number): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job || (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)) {
      return false;
    }

    this.retainGenerationEpoch(streamId, job.createdAt);
    this.jobs.delete(streamId);
    this.contentState.delete(streamId);
    this.lastActivity.delete(streamId);
    this.steerQueues.delete(streamId);
    this.claimedSteers.delete(streamId);
    this.closedSteerQueues.delete(streamId);
    const userKey = job.tenantId ? `${job.tenantId}:${job.userId}` : job.userId;
    const userJobs = this.userJobMap.get(userKey);
    userJobs?.delete(streamId);
    if (userJobs?.size === 0) {
      this.userJobMap.delete(userKey);
    }
    logger.debug(`[InMemoryJobStore] Deleted job: ${streamId}`);
    return true;
  }

  /**
   * Refresh a job's last-activity timestamp (called on each emitted chunk) so the
   * stale-job failsafe in cleanup() reaps on inactivity rather than total age,
   * mirroring RedisJobStore refreshing the running TTL on each appendChunk.
   */
  recordActivity(streamId: string, expectedCreatedAt?: number): void {
    const job = this.jobs.get(streamId);
    if (job && (expectedCreatedAt == null || job.createdAt === expectedCreatedAt)) {
      const now = Date.now();
      this.lastActivity.set(streamId, now);
      const receiptExpiry = now + STEER_RECEIPT_TTL_MS;
      for (const entry of this.steerReceipts.get(streamId)?.values() ?? []) {
        if (entry.receipt.generationCreatedAt === job.createdAt) {
          entry.expiresAt = Math.max(entry.expiresAt, receiptExpiry);
        }
      }
      this.extendRecoveryLease(streamId, job, this.runningRecoveryLeaseExpiry(now));
    }
  }

  async hasJob(streamId: string): Promise<boolean> {
    return this.jobs.has(streamId);
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    const running: SerializableJobData[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        running.push(job);
      }
    }
    return running;
  }

  async getRequiresActionJobs(): Promise<SerializableJobData[]> {
    const paused: SerializableJobData[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'requires_action') {
        paused.push(job);
      }
    }
    return paused;
  }

  async getTerminalHostActionJobs(): Promise<SerializableJobData[]> {
    const pending: SerializableJobData[] = [];
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.terminalHostActionPending !== true) {
        continue;
      }
      if (
        job.providerDrained === false &&
        job.completedAt != null &&
        now - job.completedAt >= PROVIDER_DRAIN_TIMEOUT_MS
      ) {
        // No owner can renew this terminal segment. The pre-CAS snapshot is
        // already retained; force the same bounded recovery used by callers
        // waiting for a provider drain so one crashed process cannot hold the
        // conversation lane forever.
        job.providerDrained = true;
      }
      if (job.providerDrained !== false) {
        // Enumerating IS the retry attempt: refresh retention so evidence outlives a host
        // dependency that is unreachable for longer than the retention window.
        job.terminalHostActionRefreshedAt = now;
        pending.push(job);
      }
    }
    return pending;
  }

  async clearTerminalHostAction(streamId: string, expectedCreatedAt?: number): Promise<void> {
    const job = this.jobs.get(streamId);
    // Identity-fenced: a replacement generation at this streamId (a newer createdAt) must
    // not have a predecessor's marker cleared on its behalf.
    if (job == null || (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)) {
      return;
    }
    delete job.terminalHostActionPending;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    const toDelete: Array<{ streamId: string; createdAt: number }> = [];
    let staleRunning = 0;

    // Expired parked steers are otherwise only purged by a claim.
    for (const [streamId, parked] of this.parkedSteers) {
      if (parked.expiresAt <= now) {
        this.parkedSteers.delete(streamId);
      }
    }

    // Idempotency keys are unique per submission, so expired claims are never
    // overwritten — prune them here to keep the map bounded.
    for (const [key, claim] of this.idempotencyClaims) {
      if (claim.expiresAt <= now) {
        this.idempotencyClaims.delete(key);
      }
    }

    for (const [streamId, retained] of this.generationEpochs) {
      if (retained.expiresAt <= now) {
        this.generationEpochs.delete(streamId);
      }
    }

    for (const [streamId, job] of this.jobs) {
      if (job.status === 'requires_action' && job.terminalPersistencePending === true) {
        const startedAt = job.terminalPersistenceStartedAt ?? job.createdAt;
        if (now - startedAt < PAUSE_PERSISTENCE_TIMEOUT_MS) {
          // The pause owner is still within its response-write lease. Cleanup
          // must not win the race and abort an action before that write settles.
          continue;
        }
        if (job.pendingActionId == null) {
          logger.error(
            `[InMemoryJobStore] Refusing stale pause-persistence cleanup without an action fence: ${streamId}`,
          );
          continue;
        }
        const failed = await this.transitionStatusAndDrainSteers(streamId, {
          from: 'requires_action',
          to: 'error',
          expectActionId: job.pendingActionId,
          expectCreatedAt: job.createdAt,
          patch: {
            completedAt: now,
            error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
            ...(job.agentEventDeliveryKey != null && {
              terminalHostActionPending: true,
            }),
          },
          clear: [
            'pendingAction',
            'pendingActionId',
            'terminalPersistencePending',
            'terminalPersistenceStartedAt',
          ],
        });
        if (failed == null) {
          continue;
        }
        logger.error(`[InMemoryJobStore] Pause persistence timed out: ${streamId}`);
      }

      const isFinished = ['complete', 'error', 'aborted'].includes(job.status);
      // A terminal job that still owes a host lifecycle hook is retained (like a
      // reconcile-preserved job) so a later cleanup pass can enumerate and retry it —
      // but only within a bounded window, so a permanently-failing hook cannot leak.
      const hostActionHeld =
        job.terminalHostActionPending === true &&
        now - (job.terminalHostActionRefreshedAt ?? job.completedAt ?? 0) <=
          HOST_ACTION_RETENTION_MS;
      if (
        isFinished &&
        job.completedAt &&
        job.preserveForScheduleReconcile !== true &&
        !hostActionHeld
      ) {
        // A pending final event is a persistence barrier, not an ordinary
        // completed row. Give its owner/recovery path a bounded window even
        // when normal terminal retention is configured to zero.
        const terminalTtl =
          job.terminalPersistencePending === true
            ? Math.max(this.ttlAfterComplete, TERMINAL_PERSISTENCE_RETENTION_MS)
            : this.ttlAfterComplete;
        if (terminalTtl === 0 || now - job.completedAt > terminalTtl) {
          toDelete.push({ streamId, createdAt: job.createdAt });
        }
      } else if (job.status === 'requires_action' && isPendingActionStale(job)) {
        // Stale approval (expired, or missing/malformed pendingAction):
        // finalize it (aborted) so it stops occupying the user slot and its
        // content state is reclaimed, mirroring ApprovalLifecycle.expire().
        // Skipping it (active-list filter) alone would leave it resident.
        // 202-accepted steers frozen across the pause are parked first —
        // deleting the job would silently drop them otherwise.
        if (!this.isParkedRecoveryCompatible(streamId, job)) {
          logger.error(
            `[InMemoryJobStore] Refusing stale approval cleanup with invalid recovery state: ${streamId}`,
          );
          continue;
        }
        this.parkQueuedSteers(streamId, job, now);
        job.status = 'aborted';
        job.completedAt = now;
        job.error = 'Approval expired before a decision was made';
        // Store-won expiry (the manager's own sweep did not win the CAS): mark the host
        // action pending so the manager relay still runs its lifecycle hook, and RETAIN the
        // job (even under zero terminal retention) so a sweep can enumerate it — cleared and
        // reaped once the hook acknowledges.
        job.terminalHostActionPending = true;
        delete job.pendingAction;
        delete job.pendingActionId;
      } else if (this.staleJobTimeout > 0 && job.status === 'running') {
        // Failsafe: reap jobs stuck in "running" with no generation activity for
        // longer than the stale timeout. These are crashed/hung generations that
        // never reached a terminal state; without this they accumulate their
        // content state in memory until the process OOMs. Reaping keys off the
        // most recent liveness signal (not creation time) so a long but live
        // stream is never reaped, and a just-resumed approval (fresh
        // `lastActiveAt`) wins over a stale per-chunk `lastActivity` entry.
        const lastActive = Math.max(
          this.lastActivity.get(streamId) ?? 0,
          job.lastActiveAt ?? 0,
          job.createdAt,
        );
        if (now - lastActive > this.staleJobTimeout) {
          // A crashed/hung run never reached a finalization drain — park the
          // 202-accepted queue before the delete drops it.
          if (!this.isParkedRecoveryCompatible(streamId, job)) {
            logger.error(
              `[InMemoryJobStore] Refusing stale job cleanup with invalid recovery state: ${streamId}`,
            );
            continue;
          }
          this.parkQueuedSteers(streamId, job, now);
          toDelete.push({ streamId, createdAt: job.createdAt });
          staleRunning++;
        }
      }
    }

    // Park/reaper processing above gets first chance to extend receipts and
    // classify claimed items. Pruning first could erase the only durable copy
    // of a drained steer immediately before terminal recovery snapshots it.
    for (const [streamId, receipts] of this.steerReceipts) {
      for (const [clientSteerId, entry] of receipts) {
        if (entry.expiresAt <= now) {
          receipts.delete(clientSteerId);
        }
      }
      if (receipts.size === 0) {
        this.steerReceipts.delete(streamId);
      }
    }

    for (const { streamId, createdAt } of toDelete) {
      await this.deleteJob(streamId, createdAt);
    }

    if (staleRunning > 0) {
      logger.warn(
        `[InMemoryJobStore] Reaped ${staleRunning} stale running job(s) exceeding ${this.staleJobTimeout}ms (likely crashed/hung generations)`,
      );
    }

    if (toDelete.length > 0) {
      logger.debug(`[InMemoryJobStore] Cleaned up ${toDelete.length} expired jobs`);
    }

    return toDelete.length;
  }

  private async evictOldest(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [streamId, job] of this.jobs) {
      if (job.createdAt < oldestTime) {
        oldestTime = job.createdAt;
        oldestId = streamId;
      }
    }

    if (oldestId) {
      logger.warn(`[InMemoryJobStore] Evicting oldest job: ${oldestId}`);
      const job = this.jobs.get(oldestId);
      if (!job) {
        return;
      }
      this.parkQueuedSteers(oldestId, job, Date.now());
      await this.deleteJob(oldestId, job.createdAt);
    }
  }

  /** Get job count (for monitoring) */
  async getJobCount(): Promise<number> {
    return this.jobs.size;
  }

  /** Get job count by status (for monitoring) */
  async getJobCountByStatus(status: JobStatus): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === status) {
        count++;
      }
    }
    return count;
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.jobs.clear();
    this.contentState.clear();
    this.userJobMap.clear();
    this.steerQueues.clear();
    this.claimedSteers.clear();
    this.closedSteerQueues.clear();
    this.parkedSteers.clear();
    this.steerReceipts.clear();
    this.idempotencyClaims.clear();
    this.lastActivity.clear();
    this.generationEpochs.clear();
    logger.debug('[InMemoryJobStore] Destroyed');
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   */
  async getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.getJobIdsByUser(userId, tenantId, false);
  }

  async getCleanupBlockingJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.getJobIdsByUser(userId, tenantId, true);
  }

  async getCleanupJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.getJobIdsByUser(userId, tenantId, true);
  }

  async getRetainedJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    const ownerKeys = tenantId ? [`${tenantId}:${userId}`, userId] : [userId];
    const streamIds = new Set(ownerKeys.flatMap((key) => [...(this.userJobMap.get(key) ?? [])]));
    return [...streamIds].filter((streamId) => {
      const job = this.jobs.get(streamId);
      return job?.userId === userId && (job.tenantId == null || job.tenantId === tenantId);
    });
  }

  private getJobIdsByUser(
    userId: string,
    tenantId: string | undefined,
    includeUndrained: boolean,
  ): string[] {
    const userKey = tenantId ? `${tenantId}:${userId}` : userId;
    const trackedIds = this.userJobMap.get(userKey);
    if (!trackedIds || trackedIds.size === 0) {
      return [];
    }

    const activeIds: string[] = [];

    for (const streamId of trackedIds) {
      const job = this.jobs.get(streamId);
      const jobUserKey = job?.tenantId ? `${job.tenantId}:${job.userId}` : job?.userId;
      if (job == null || jobUserKey !== userKey) {
        // A same-stream replacement may move from a legacy user scope into a
        // tenant-qualified scope. Never expose/count the replacement through
        // stale predecessor membership.
        trackedIds.delete(streamId);
        continue;
      }
      // Include running jobs and jobs paused for human review (e.g. tool approval).
      // A pending-approval job still occupies the user's conversation slot — but
      // only while its prompt is live: a past-`expiresAt` approval no longer
      // counts as active (cleanup/expiry will finalize it).
      if (
        job.status === 'running' ||
        job.status === 'requires_action' ||
        (includeUndrained &&
          (job.providerDrained === false ||
            job.terminalPersistencePending === true ||
            job.terminalHostActionPending === true))
      ) {
        if (
          job.status === 'requires_action' &&
          isPendingActionStale(job) &&
          !(
            includeUndrained &&
            (job.providerDrained === false ||
              job.terminalPersistencePending === true ||
              job.terminalHostActionPending === true)
          )
        ) {
          continue;
        }
        activeIds.push(streamId);
      } else if (
        job.providerDrained !== false &&
        job.terminalPersistencePending !== true &&
        job.terminalHostActionPending !== true
      ) {
        // Self-healing: job completed/deleted but mapping wasn't cleaned - fix it now
        trackedIds.delete(streamId);
      }
    }

    // Clean up empty set
    if (trackedIds.size === 0) {
      this.userJobMap.delete(userKey);
    }

    return activeIds;
  }

  // ===== Content State Methods =====

  /**
   * Set the graph reference for a job.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  setGraph(streamId: string, graph: StandardGraph, expectedCreatedAt?: number): void {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return;
    }
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.graphRef = new WeakRef(graph);
    } else {
      this.contentState.set(streamId, {
        contentParts: [],
        graphRef: new WeakRef(graph),
        collectedUsage: [],
      });
    }
  }

  /**
   * Set content parts reference for a job.
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): void {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return;
    }
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.contentParts = contentParts;
    } else {
      this.contentState.set(streamId, {
        contentParts,
        graphRef: null,
        collectedUsage: [],
      });
    }
  }

  /**
   * Set collected usage reference for a job.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    expectedCreatedAt?: number,
  ): void {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return;
    }
    const existing = this.contentState.get(streamId);
    if (existing) {
      existing.collectedUsage = collectedUsage;
    } else {
      this.contentState.set(streamId, {
        contentParts: [],
        graphRef: null,
        collectedUsage,
      });
    }
  }

  /**
   * Get collected usage for a job.
   */
  getCollectedUsage(streamId: string, expectedCreatedAt?: number): UsageMetadata[] {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return [];
    }
    const state = this.contentState.get(streamId);
    return state?.collectedUsage ?? [];
  }

  /**
   * Get content parts for a job.
   * Returns live content from stored reference.
   */
  async getContentParts(
    streamId: string,
    expectedCreatedAt?: number,
    _options?: { durableOnly?: boolean },
  ): Promise<{
    content: Agents.MessageContentComplex[];
    reconstructedEventCount?: number;
    durableEventCount?: number;
  } | null> {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return null;
    }
    const state = this.contentState.get(streamId);
    if (!state?.contentParts) {
      return null;
    }
    return {
      content: state.contentParts,
      ...(_options?.durableOnly === true && {
        reconstructedEventCount: state.contentParts.length,
        durableEventCount: state.contentParts.length,
      }),
    };
  }

  async settleEarlyBufferRecovery(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    settlement: Pick<
      EarlyBufferOverflowState,
      'recoveryMethod' | 'recoveryOutcome' | 'recoveryCompletedAt' | 'recoveryFailureReason'
    >,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    const overflow = job?.earlyBufferOverflow;
    if (
      job?.createdAt !== expectedCreatedAt ||
      overflow?.id !== overflowId ||
      overflow.recoveryOutcome != null
    ) {
      return false;
    }
    job.earlyBufferOverflow = { ...overflow, ...settlement };
    return true;
  }

  async finalizeEarlyBufferOverflow(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    finalizedOverflow: EarlyBufferOverflowState,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    const overflow = job?.earlyBufferOverflow;
    if (
      job?.createdAt !== expectedCreatedAt ||
      overflow?.id !== overflowId ||
      overflow.persistencePending !== true ||
      overflow.recoveryOutcome != null
    ) {
      return false;
    }
    job.earlyBufferOverflow = finalizedOverflow;
    return true;
  }

  async hasSubscriberAttached(streamId: string, expectedCreatedAt: number): Promise<boolean> {
    const job = this.jobs.get(streamId);
    return job?.createdAt === expectedCreatedAt && job.firstSubscriberAttachedAt != null;
  }

  async claimFirstSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    attachedAt: number,
    subscriberId: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (job?.createdAt !== expectedCreatedAt) {
      return false;
    }
    job.activeSubscriberLeases ??= {};
    job.activeSubscriberLeases[subscriberId] = leaseExpiresAt;
    const firstSubscriber = job.firstSubscriberAttachedAt == null;
    job.firstSubscriberAttachedAt ??= attachedAt;
    return firstSubscriber;
  }

  async detachSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    subscriberId: string,
  ): Promise<void> {
    const job = this.jobs.get(streamId);
    if (job?.createdAt !== expectedCreatedAt) {
      return;
    }
    delete job.activeSubscriberLeases?.[subscriberId];
  }

  async hasActiveSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    observedAt: number,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (job?.createdAt !== expectedCreatedAt) {
      return false;
    }
    for (const [subscriberId, expiresAt] of Object.entries(job.activeSubscriberLeases ?? {})) {
      if (expiresAt <= observedAt) {
        delete job.activeSubscriberLeases?.[subscriberId];
      }
    }
    return Object.keys(job.activeSubscriberLeases ?? {}).length > 0;
  }

  /**
   * Get run steps for a job from graph.contentData.
   * Uses WeakRef - may return empty if graph has been GC'd.
   */
  async getRunSteps(streamId: string, expectedCreatedAt?: number): Promise<Agents.RunStep[]> {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return [];
    }
    const state = this.contentState.get(streamId);
    if (!state?.graphRef) {
      return [];
    }

    // Dereference WeakRef - may return undefined if GC'd
    const graph = state.graphRef.deref();
    return toWireRunSteps(graph?.contentData ?? []);
  }

  /**
   * No-op for in-memory - content available via graph reference.
   */
  async appendChunk(
    streamId: string,
    _event: unknown,
    expectedCreatedAt?: number,
    deliveredSteer?: SteerQueueItem,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!job || (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)) {
      return false;
    }
    if (job.status !== 'running' && job.status !== 'requires_action') {
      return false;
    }
    if (deliveredSteer != null) {
      if (job.status !== 'running' || this.closedSteerQueues.has(streamId)) {
        return false;
      }
      if (usesReceiptSafeProtocol(job)) {
        const claimed = this.claimedSteers.get(streamId);
        const claimedIndex =
          claimed?.findIndex(
            (item) =>
              item.steerId === deliveredSteer.steerId &&
              item.clientSteerId === deliveredSteer.clientSteerId,
          ) ?? -1;
        if (claimed == null || claimedIndex < 0) {
          return false;
        }
        if (deliveredSteer.clientSteerId != null) {
          const receipt = this.steerReceipts
            .get(streamId)
            ?.get(deliveredSteer.clientSteerId)?.receipt;
          if (
            receipt == null ||
            receipt.clientSteerId !== deliveredSteer.clientSteerId ||
            receipt.generationCreatedAt !== job.createdAt ||
            receipt.state !== 'claimed' ||
            receipt.item.steerId !== deliveredSteer.steerId ||
            receipt.item.clientSteerId !== deliveredSteer.clientSteerId
          ) {
            return false;
          }
        }
        claimed.splice(claimedIndex, 1);
        if (claimed.length === 0) {
          this.claimedSteers.delete(streamId);
        }
      }
    }
    if (usesReceiptSafeProtocol(job) && deliveredSteer?.clientSteerId != null) {
      const receipt = this.steerReceipts.get(streamId)?.get(deliveredSteer.clientSteerId)?.receipt;
      if (receipt != null) {
        receipt.item = { ...deliveredSteer };
        receipt.state = 'delivered';
      }
    }
    // Content itself is available via the live graph reference.
    return true;
  }

  /**
   * Clear content state for a job.
   */
  clearContentState(streamId: string, expectedCreatedAt?: number): void {
    const job = this.jobs.get(streamId);
    if (job && expectedCreatedAt != null && job.createdAt !== expectedCreatedAt) {
      return;
    }
    this.contentState.delete(streamId);
  }

  // ===== Steering Queue Methods =====
  // Single-threaded event loop makes each read-check-write indivisible, so
  // the status guard and depth cap are exact without extra locking.

  async enqueueSteer(
    streamId: string,
    item: SteerQueueItem,
    expectedCreatedAt?: number,
  ): Promise<number> {
    const result = await this.enqueueSteerVersioned(streamId, item, false, expectedCreatedAt);
    return typeof result === 'number' ? result : result.position;
  }

  async enqueueSteerVersioned(
    streamId: string,
    item: SteerQueueItem,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueVersionedResult> {
    const job = this.jobs.get(streamId);
    if (!job || job.status !== 'running' || this.closedSteerQueues.has(streamId)) {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    if (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt) {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    let queue = this.steerQueues.get(streamId);
    if (!queue) {
      queue = [];
      this.steerQueues.set(streamId, queue);
    }
    if (queue.length >= STEER_QUEUE_MAX_DEPTH) {
      return STEER_ENQUEUE_QUEUE_FULL;
    }
    const persisted: SteerQueueItem = {
      ...item,
      ...(wantsPreempt && {
        preemptRevision: 1,
        ...(job.preemptCapable === true && { preempt: true }),
      }),
    };
    if (
      persisted.quotes != null &&
      (job.steerQuotesExecutionId == null || job.steerQuotesExecutionId !== job.providerExecutionId)
    ) {
      delete persisted.quotes;
    }
    queue.push(persisted);
    return { item: { ...persisted }, position: queue.length };
  }

  private normalizeSteerReceipt(
    streamId: string,
    entry: { receipt: SteerReceipt; expiresAt: number },
  ): void {
    const receipt = entry.receipt;
    const job = this.jobs.get(streamId);
    const sameActiveGeneration =
      usesReceiptSafeProtocol(job) &&
      job?.createdAt === receipt.generationCreatedAt &&
      (job.status === 'running' || job.status === 'requires_action');
    if (receipt.state === 'claimed') {
      if (!sameActiveGeneration) {
        receipt.state = 'leftover';
      }
      return;
    }
    if (
      receipt.state === 'queued' &&
      (!sameActiveGeneration ||
        !(this.steerQueues.get(streamId) ?? []).some(
          (item) => item.clientSteerId === receipt.clientSteerId,
        ))
    ) {
      /** New drains atomically move queued→claimed. A still-queued receipt
       * without a list item is therefore either an older same-generation
       * drain (delivered) or a terminal/replacement deletion (leftover). */
      // Durable application explicitly writes `delivered`. Queue absence by
      // itself is never proof of delivery (TTL loss/crash must recover text).
      receipt.state = 'leftover';
    }
  }

  private claimedSteerItems(streamId: string, generationCreatedAt?: number): SteerQueueItem[] {
    const job = this.jobs.get(streamId);
    if (
      !usesReceiptSafeProtocol(job) ||
      (generationCreatedAt != null && job?.createdAt !== generationCreatedAt)
    ) {
      return [];
    }
    return (this.claimedSteers.get(streamId) ?? []).map((item) => ({
      ...item,
    }));
  }

  async getSteerReceipt(streamId: string, clientSteerId: string): Promise<SteerReceipt | null> {
    const entry = this.steerReceipts.get(streamId)?.get(clientSteerId);
    if (entry == null) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.steerReceipts.get(streamId)?.delete(clientSteerId);
      return null;
    }
    this.normalizeSteerReceipt(streamId, entry);
    return { ...entry.receipt, item: { ...entry.receipt.item } };
  }

  async enqueueSteerWithReceipt(
    streamId: string,
    item: SteerQueueItem,
    receiptInput: SteerReceiptInput,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueReceiptResult> {
    /** Inline with no await: the event loop cannot interleave two identical
     * claims between lookup and insert. */
    const existingEntry = this.steerReceipts.get(streamId)?.get(receiptInput.clientSteerId);
    if (existingEntry != null && existingEntry.expiresAt > Date.now()) {
      this.normalizeSteerReceipt(streamId, existingEntry);
      return {
        ...existingEntry.receipt,
        item: { ...existingEntry.receipt.item },
      };
    }
    if (existingEntry != null) {
      this.steerReceipts.get(streamId)?.delete(receiptInput.clientSteerId);
    }

    const job = this.jobs.get(streamId);
    if (
      !job ||
      job.status !== 'running' ||
      this.closedSteerQueues.has(streamId) ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    if (!usesReceiptSafeProtocol(job)) {
      return this.enqueueSteerVersioned(streamId, item, wantsPreempt, expectedCreatedAt);
    }
    let queue = this.steerQueues.get(streamId);
    if (!queue) {
      queue = [];
      this.steerQueues.set(streamId, queue);
    }
    if (queue.length >= STEER_QUEUE_MAX_DEPTH) {
      return STEER_ENQUEUE_QUEUE_FULL;
    }
    let receipts = this.steerReceipts.get(streamId);
    if (receipts == null) {
      receipts = new Map();
      this.steerReceipts.set(streamId, receipts);
    }
    for (const [id, entry] of receipts) {
      if (entry.expiresAt <= Date.now()) {
        receipts.delete(id);
      }
    }
    if (receipts.size >= STEER_RECEIPT_MAX_PER_STREAM) {
      return STEER_ENQUEUE_RECEIPT_FULL;
    }
    const persisted: SteerQueueItem = {
      ...item,
      ...(wantsPreempt && {
        preemptRevision: 1,
        ...(job.preemptCapable === true && { preempt: true }),
      }),
    };
    if (
      persisted.quotes != null &&
      (job.steerQuotesExecutionId == null || job.steerQuotesExecutionId !== job.providerExecutionId)
    ) {
      delete persisted.quotes;
    }
    queue.push(persisted);
    const receipt: SteerReceipt = {
      ...receiptInput,
      item: { ...persisted },
      position: queue.length,
      state: 'queued',
    };
    receipts.set(receipt.clientSteerId, {
      receipt,
      expiresAt: Date.now() + STEER_RECEIPT_TTL_MS,
    });
    return { ...receipt, item: { ...receipt.item } };
  }

  private settleSteerReceipts(
    streamId: string,
    items: SteerQueueItem[],
    state: SteerReceipt['state'],
  ): void {
    const job = this.jobs.get(streamId);
    if (job != null && !usesReceiptSafeProtocol(job)) {
      return;
    }
    const receipts = this.steerReceipts.get(streamId);
    if (receipts == null) {
      return;
    }
    for (const item of items) {
      if (!item.clientSteerId) {
        continue;
      }
      const receipt = receipts.get(item.clientSteerId)?.receipt;
      if (receipt != null) {
        receipt.item = { ...item };
        receipt.state = state;
      }
    }
  }

  /** With `expectedCreatedAt`, refuses when the job was replaced — a stale
   *  run's drain must never consume (or close) a replacement job's queue. */
  async drainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    const job = this.jobs.get(streamId);
    if (
      job?.status !== 'running' ||
      this.closedSteerQueues.has(streamId) ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return [];
    }
    const queue = this.steerQueues.get(streamId);
    if (!queue || queue.length === 0) {
      return [];
    }
    if (!usesReceiptSafeProtocol(job)) {
      return queue.splice(0);
    }
    for (const item of queue) {
      if (item.clientSteerId == null) {
        continue;
      }
      const receipt = this.steerReceipts.get(streamId)?.get(item.clientSteerId)?.receipt;
      if (
        receipt == null ||
        receipt.clientSteerId !== item.clientSteerId ||
        receipt.generationCreatedAt !== job.createdAt ||
        receipt.state !== 'queued' ||
        receipt.item.steerId !== item.steerId ||
        receipt.item.clientSteerId !== item.clientSteerId
      ) {
        throw new Error(`Invalid steer receipt while draining ${streamId}`);
      }
    }
    const drained = queue.splice(0);
    const priorClaims = this.claimedSteers.get(streamId) ?? [];
    this.claimedSteers.set(streamId, [...priorClaims, ...drained]);
    this.settleSteerReceipts(streamId, drained, 'claimed');
    const claimExpiry = Date.now() + STEER_RECEIPT_TTL_MS;
    for (const item of drained) {
      if (item.clientSteerId == null) {
        continue;
      }
      const entry = this.steerReceipts.get(streamId)?.get(item.clientSteerId);
      if (entry != null) {
        entry.expiresAt = Math.max(entry.expiresAt, claimExpiry);
      }
    }
    return drained;
  }

  async restoreClaimedSteers(
    streamId: string,
    items: SteerQueueItem[],
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (
      !job ||
      job.status !== 'running' ||
      this.closedSteerQueues.has(streamId) ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return false;
    }
    if (!usesReceiptSafeProtocol(job)) {
      const current = this.steerQueues.get(streamId) ?? [];
      const currentIds = new Set(current.map((item) => item.steerId));
      this.steerQueues.set(streamId, [
        ...items.filter((item) => !currentIds.has(item.steerId)),
        ...current,
      ]);
      return true;
    }
    const claimed = this.claimedSteers.get(streamId) ?? [];
    const incomingIds = new Set(items.map((item) => item.steerId));
    const actuallyClaimed = claimed.filter((item) => incomingIds.has(item.steerId));
    if (actuallyClaimed.length !== items.length) {
      return false;
    }
    for (const item of actuallyClaimed) {
      if (item.clientSteerId == null) {
        continue;
      }
      const receipt = this.steerReceipts.get(streamId)?.get(item.clientSteerId)?.receipt;
      if (
        receipt == null ||
        receipt.generationCreatedAt !== job.createdAt ||
        receipt.state !== 'claimed' ||
        receipt.item.steerId !== item.steerId ||
        receipt.item.clientSteerId !== item.clientSteerId
      ) {
        return false;
      }
    }
    const remainingClaims = claimed.filter((item) => !incomingIds.has(item.steerId));
    if (remainingClaims.length > 0) {
      this.claimedSteers.set(streamId, remainingClaims);
    } else {
      this.claimedSteers.delete(streamId);
    }
    const current = this.steerQueues.get(streamId) ?? [];
    const currentIds = new Set(current.map((item) => item.steerId));
    const restored = actuallyClaimed.filter((item) => !currentIds.has(item.steerId));
    if (restored.length > 0) {
      this.steerQueues.set(streamId, [...restored, ...current]);
      this.settleSteerReceipts(streamId, restored, 'queued');
    }
    return true;
  }

  async admitTerminalSteers(
    streamId: string,
    policy: TerminalSteerAdmissionPolicy,
    expectedCreatedAt?: number,
  ): Promise<TerminalSteerAdmissionResult> {
    const job = this.jobs.get(streamId);
    if (
      job?.status !== 'running' ||
      this.closedSteerQueues.has(streamId) ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)
    ) {
      return { outcome: 'unavailable' };
    }
    const queue = this.steerQueues.get(streamId);
    if (!policy.allowClaim || job.generationProtocolVersion !== 2) {
      this.closedSteerQueues.add(streamId);
      return { outcome: 'sealed' };
    }
    if (queue == null || queue.length === 0) {
      if (policy.keepOpenWhenEmpty) {
        return { outcome: 'open' };
      }
      this.closedSteerQueues.add(streamId);
      return { outcome: 'sealed' };
    }
    const items = await this.drainSteers(streamId, expectedCreatedAt);
    if (items.length === 0) {
      this.closedSteerQueues.add(streamId);
      return { outcome: 'sealed' };
    }
    return { outcome: 'claimed', items };
  }

  async closeAndDrainSteers(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[]> {
    const job = this.jobs.get(streamId);
    if (job == null || (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt)) {
      return [];
    }
    if (!this.isParkedRecoveryCompatible(streamId, job)) {
      throw new Error('Generation recovery state is corrupt or belongs to another owner');
    }
    this.closedSteerQueues.add(streamId);
    const queued = this.steerQueues.get(streamId)?.splice(0) ?? [];
    const combined = [
      ...(usesReceiptSafeProtocol(job) ? this.claimedSteerItems(streamId, expectedCreatedAt) : []),
      ...queued,
    ];
    const seen = new Set<string>();
    const leftovers = combined.filter((item) => {
      if (seen.has(item.steerId)) {
        return false;
      }
      seen.add(item.steerId);
      return true;
    });
    this.settleSteerReceipts(streamId, leftovers, 'leftover');
    this.claimedSteers.delete(streamId);
    this.parkLeftovers(streamId, leftovers, job, Date.now());
    return leftovers;
  }

  async peekSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    if (expectedCreatedAt != null && this.jobs.get(streamId)?.createdAt !== expectedCreatedAt) {
      return [];
    }
    const queue = this.steerQueues.get(streamId);
    return queue ? [...queue] : [];
  }

  async peekClaimedSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    const job = this.jobs.get(streamId);
    if (
      !usesReceiptSafeProtocol(job) ||
      (expectedCreatedAt != null && job?.createdAt !== expectedCreatedAt)
    ) {
      return [];
    }
    return this.claimedSteerItems(streamId, expectedCreatedAt);
  }

  async clearSteers(streamId: string): Promise<void> {
    this.settleSteerReceipts(
      streamId,
      [...this.claimedSteerItems(streamId), ...(this.steerQueues.get(streamId) ?? [])],
      'leftover',
    );
    this.steerQueues.delete(streamId);
    this.claimedSteers.delete(streamId);
  }

  async removeSteer(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (expectedCreatedAt != null && job?.createdAt !== expectedCreatedAt) {
      return false;
    }
    const queue = this.steerQueues.get(streamId);
    if (queue == null) {
      return false;
    }
    let index = -1;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i] as unknown;
      if (
        item == null ||
        typeof item !== 'object' ||
        !('steerId' in item) ||
        typeof item.steerId !== 'string' ||
        item.steerId.length === 0
      ) {
        throw new Error(`Invalid steer queue item while cancelling ${streamId}`);
      }
      if (item.steerId === steerId) {
        if (index >= 0) {
          throw new Error(`Duplicate steer id while cancelling ${streamId}`);
        }
        index = i;
      }
    }
    if (index < 0) {
      return false;
    }
    const target = queue[index];
    if (target.clientSteerId != null && job == null) {
      throw new Error(`Invalid steer receipt while cancelling ${streamId}`);
    }
    const receipt = job
      ? this.queuedReceiptForMutation(streamId, job, target, 'cancelling')
      : undefined;
    queue.splice(index, 1);
    if (receipt != null) {
      receipt.item = { ...target };
      receipt.state = 'cancelled';
    }
    return true;
  }

  async armSteer(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmOutcome> {
    return (await this.armSteerVersioned(streamId, steerId, expectedCreatedAt)).outcome;
  }

  private queuedReceiptForMutation(
    streamId: string,
    job: SerializableJobData,
    item: SteerQueueItem,
    operation: string,
  ): SteerReceipt | undefined {
    if (!usesReceiptSafeProtocol(job)) {
      return undefined;
    }
    if (item.clientSteerId == null) {
      return undefined;
    }
    const receipt = this.steerReceipts.get(streamId)?.get(item.clientSteerId)?.receipt as unknown;
    if (
      receipt == null ||
      typeof receipt !== 'object' ||
      !('item' in receipt) ||
      receipt.item == null ||
      typeof receipt.item !== 'object' ||
      !('clientSteerId' in receipt) ||
      receipt.clientSteerId !== item.clientSteerId ||
      !('generationCreatedAt' in receipt) ||
      receipt.generationCreatedAt !== job.createdAt ||
      !('state' in receipt) ||
      receipt.state !== 'queued' ||
      !('steerId' in receipt.item) ||
      receipt.item.steerId !== item.steerId ||
      !('clientSteerId' in receipt.item) ||
      receipt.item.clientSteerId !== item.clientSteerId
    ) {
      throw new Error(`Invalid steer receipt while ${operation} ${streamId}`);
    }
    return receipt as SteerReceipt;
  }

  async armSteerVersioned(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmResult> {
    const job = this.jobs.get(streamId);
    if (!job || job.status !== 'running' || this.closedSteerQueues.has(streamId)) {
      return { outcome: 'missing' };
    }
    if (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt) {
      return { outcome: 'missing' };
    }
    const item = this.steerQueues.get(streamId)?.find((entry) => entry.steerId === steerId);
    if (item == null) {
      return { outcome: 'missing' };
    }
    if (job.preemptCapable !== true) {
      return { outcome: 'incapable' };
    }
    const receipt = this.queuedReceiptForMutation(streamId, job, item, 'arming');
    item.preemptRevision = (item.preemptRevision ?? 0) + 1;
    item.preempt = true;
    if (receipt != null) {
      receipt.item = { ...item };
    }
    return {
      outcome: 'armed',
      revision: item.preemptRevision,
      item: { ...item },
    };
  }

  async downgradeSteerPreempts(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[] | null> {
    const job = this.jobs.get(streamId);
    if (
      !job ||
      (expectedCreatedAt != null && job.createdAt !== expectedCreatedAt) ||
      job.preemptCapable === true
    ) {
      return null;
    }
    const preempted = (this.steerQueues.get(streamId) ?? []).filter(
      (item) => item.preempt === true,
    );
    const receipts = new Map<SteerQueueItem, SteerReceipt | undefined>();
    for (const item of preempted) {
      receipts.set(item, this.queuedReceiptForMutation(streamId, job, item, 'downgrading'));
    }
    const changed: SteerQueueItem[] = [];
    for (const item of preempted) {
      if (item.preempt === true) {
        delete item.preempt;
        item.preemptRevision = (item.preemptRevision ?? 0) + 1;
        const receipt = receipts.get(item);
        if (receipt != null) {
          receipt.item = { ...item };
        }
        changed.push({ ...item });
      }
    }
    return changed;
  }

  async parkSteers(streamId: string, payload: string, expectedCreatedAt?: number): Promise<void> {
    const job = this.jobs.get(streamId);
    if (expectedCreatedAt != null && job?.createdAt !== expectedCreatedAt) {
      return;
    }
    let normalizedPayload = payload;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      parsed.generationProtocolVersion =
        job != null
          ? normalizeGenerationProtocol(job.generationProtocolVersion)
          : normalizeGenerationProtocol(parsed.generationProtocolVersion);
      normalizedPayload = JSON.stringify(parsed);
    } catch {
      // Keep malformed payloads bounded by the normal TTL; owner-gated reads
      // fail closed rather than losing evidence needed for diagnosis.
    }
    this.parkedSteers.set(streamId, {
      payload: normalizedPayload,
      expiresAt: Date.now() + PARKED_STEERS_TTL_MS,
    });
  }

  async claimParkedSteers(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
  ): Promise<string | undefined> {
    return (await this.claimParkedSteersDetailed(streamId, ownerUserId, ownerTenantId, 2))?.payload;
  }

  async claimParkedSteersDetailed(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    requestedProtocolVersion: 1 | 2 = 1,
  ): Promise<ParkedSteerClaim | undefined> {
    const parked = this.parkedSteers.get(streamId);
    if (!parked || parked.expiresAt <= Date.now()) {
      this.parkedSteers.delete(streamId);
      return undefined;
    }
    let parsed: {
      userId?: string;
      tenantId?: string;
      generationProtocolVersion?: unknown;
      steers?: Array<
        ReturnType<typeof toPendingSteer> & {
          recoveringCreatedAt?: number;
        }
      >;
    };
    try {
      parsed = JSON.parse(parked.payload) as typeof parsed;
    } catch {
      return undefined;
    }
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      typeof parsed.userId !== 'string' ||
      parsed.userId.length === 0 ||
      !Array.isArray(parsed.steers) ||
      parsed.steers.length === 0 ||
      !parsed.steers.every(isValidParkedSteer) ||
      !isValidGenerationProtocolMarker(parsed.generationProtocolVersion) ||
      parsed.userId !== ownerUserId ||
      (parsed.tenantId != null && parsed.tenantId !== ownerTenantId)
    ) {
      return undefined;
    }
    const job = this.jobs.get(streamId);
    const activeRecovery =
      job?.generationProtocolVersion === 2 &&
      (job.status === 'running' || job.status === 'requires_action') &&
      typeof job.recoveredSteerId === 'string' &&
      job.recoveredSteerId.length > 0 &&
      job.userId === ownerUserId &&
      (job.tenantId == null || job.tenantId === ownerTenantId);
    const leased: NonNullable<typeof parsed.steers> = [];
    const visible: NonNullable<typeof parsed.steers> = [];
    for (const item of parsed.steers) {
      if (
        activeRecovery &&
        item.steerId === job.recoveredSteerId &&
        item.recoveringCreatedAt === job.createdAt
      ) {
        leased.push(item);
        continue;
      }
      const { recoveringCreatedAt: _recoveringCreatedAt, ...visibleItem } = item;
      visible.push(visibleItem);
    }
    const generationProtocolVersion =
      parsed.generationProtocolVersion === 2 && requestedProtocolVersion === 2 ? 2 : 1;
    if (generationProtocolVersion === 1 && leased.length === 0) {
      // Preserve the legacy GETDEL contract when no v2 recovery owns a source.
      this.parkedSteers.delete(streamId);
      return {
        generationProtocolVersion,
        payload: JSON.stringify({
          ...parsed,
          generationProtocolVersion,
          steers: visible,
        }),
      };
    }
    if (visible.length === 0) {
      return undefined;
    }
    if (generationProtocolVersion === 1) {
      parked.payload = JSON.stringify({
        userId: parsed.userId,
        ...(parsed.tenantId != null && { tenantId: parsed.tenantId }),
        generationProtocolVersion: 2,
        steers: leased,
      });
    }
    return {
      generationProtocolVersion,
      payload: JSON.stringify({
        userId: parsed.userId,
        ...(parsed.tenantId != null && { tenantId: parsed.tenantId }),
        generationProtocolVersion,
        steers: visible,
      }),
    };
  }

  async discardSteerLeftover(
    streamId: string,
    clientSteerId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    expectedGenerationCreatedAt?: number,
  ): Promise<boolean> {
    const entry = this.steerReceipts.get(streamId)?.get(clientSteerId);
    if (
      entry?.receipt.state !== 'leftover' ||
      (expectedGenerationCreatedAt != null &&
        entry.receipt.generationCreatedAt !== expectedGenerationCreatedAt) ||
      entry.receipt.item.steerId !== steerId ||
      entry.receipt.userId !== ownerUserId ||
      (entry.receipt.tenantId != null && entry.receipt.tenantId !== ownerTenantId)
    ) {
      return false;
    }
    const activeJob = this.jobs.get(streamId);
    if (
      activeJob?.recoveredSteerId === steerId &&
      activeJob.userId === ownerUserId &&
      (activeJob.tenantId == null || activeJob.tenantId === ownerTenantId) &&
      (activeJob.status === 'running' || activeJob.status === 'requires_action')
    ) {
      // A stale tab can still hold a leftover chip after another tab starts its
      // recovery. Once createJob leases the source, that recovery owns the
      // terminal action; cancelling it here would invalidate an in-flight turn
      // after its ordinary user message may already have been persisted.
      return false;
    }
    const parked = this.parkedSteers.get(streamId);
    if (parked != null && parked.expiresAt > Date.now()) {
      try {
        const parsed = JSON.parse(parked.payload) as {
          userId?: string;
          tenantId?: string;
          steers?: Array<{ steerId?: string }>;
        };
        if (
          parsed.userId !== ownerUserId ||
          (parsed.tenantId != null && parsed.tenantId !== ownerTenantId) ||
          !Array.isArray(parsed.steers) ||
          parsed.steers.length === 0 ||
          !parsed.steers.every(isValidParkedSteer)
        ) {
          return false;
        }
        parsed.steers = parsed.steers.filter((item) => item.steerId !== steerId);
        if (parsed.steers.length === 0) {
          this.parkedSteers.delete(streamId);
        } else {
          parked.payload = JSON.stringify(parsed);
        }
      } catch {
        return false;
      }
    }
    entry.receipt.state = 'cancelled';
    return true;
  }

  private parkLeftovers(
    streamId: string,
    items: SteerQueueItem[],
    job: SerializableJobData | null | undefined,
    now: number,
  ): void {
    if (items.length === 0 || job == null) {
      return;
    }
    let prior: Array<ReturnType<typeof toPendingSteer>> = [];
    let parkedProtocol = normalizeGenerationProtocol(job.generationProtocolVersion);
    const existing = this.parkedSteers.get(streamId);
    if (existing != null && existing.expiresAt > now) {
      try {
        const parsed = JSON.parse(existing.payload) as {
          userId?: string;
          tenantId?: string;
          generationProtocolVersion?: unknown;
          steers?: Array<ReturnType<typeof toPendingSteer>>;
        };
        if (
          parsed.userId === job.userId &&
          (parsed.tenantId == null || parsed.tenantId === job.tenantId) &&
          isValidGenerationProtocolMarker(parsed.generationProtocolVersion) &&
          Array.isArray(parsed.steers)
        ) {
          prior = parsed.steers;
          parkedProtocol = Math.max(
            parkedProtocol,
            normalizeGenerationProtocol(parsed.generationProtocolVersion),
          ) as 1 | 2;
        }
      } catch {
        // Replace malformed legacy recovery state with the authoritative items.
      }
    }
    const seen = new Set<string>();
    const merged = [...prior, ...items.map(toPendingSteer)].filter((item) => {
      if (seen.has(item.steerId)) {
        return false;
      }
      seen.add(item.steerId);
      return true;
    });
    this.parkedSteers.set(streamId, {
      payload: JSON.stringify({
        userId: job.userId,
        ...(job.tenantId != null && { tenantId: job.tenantId }),
        generationProtocolVersion: parkedProtocol,
        steers: merged,
      }),
      expiresAt: now + PARKED_STEERS_TTL_MS,
    });
    const receiptExpiry = now + PARKED_STEERS_TTL_MS;
    for (const item of items) {
      if (item.clientSteerId == null) {
        continue;
      }
      const entry = this.steerReceipts.get(streamId)?.get(item.clientSteerId);
      if (entry != null) {
        entry.expiresAt = Number.isFinite(entry.expiresAt)
          ? Math.max(entry.expiresAt, receiptExpiry)
          : receiptExpiry;
      }
    }
  }

  /** Lease without deleting: an initialization failure makes the item visible
   * again as soon as this generation becomes terminal. */
  private leaseParkedSteer(
    streamId: string,
    steerId: string | undefined,
    ownerUserId: string,
    ownerTenantId?: string,
    createdAt?: number,
  ): void {
    if (!usesReceiptSafeProtocol(this.jobs.get(streamId))) {
      return;
    }
    const parked = this.parkedSteers.get(streamId);
    if (parked == null || parked.expiresAt <= Date.now()) {
      return;
    }
    try {
      const parsed = JSON.parse(parked.payload) as {
        userId: string;
        tenantId?: string;
        steers?: Array<{
          steerId: string;
          clientSteerId?: string;
          recoveringCreatedAt?: number;
        }>;
      };
      if (!Array.isArray(parsed.steers)) {
        return;
      }
      if (
        parsed.userId !== ownerUserId ||
        (parsed.tenantId != null && parsed.tenantId !== ownerTenantId)
      ) {
        return;
      }
      for (const item of parsed.steers) {
        delete item.recoveringCreatedAt;
      }
      const leased =
        steerId != null ? parsed.steers.find((item) => item.steerId === steerId) : null;
      if (leased != null && createdAt != null) {
        leased.recoveringCreatedAt = createdAt;
        const job = this.jobs.get(streamId);
        if (job?.createdAt === createdAt) {
          this.extendRecoveryLease(
            streamId,
            job,
            this.runningRecoveryLeaseExpiry(Date.now()),
            parsed,
            leased,
          );
        }
      }
      parked.payload = JSON.stringify(parsed);
    } catch {
      // Malformed recovery state remains bounded by its TTL.
    }
  }

  /** A recovery source must outlive the generation that hides it, plus one
   * normal parked-recovery window after a stale-job reap exposes it again. */
  private runningRecoveryLeaseExpiry(now: number): number {
    return this.staleJobTimeout > 0
      ? now + this.staleJobTimeout + PARKED_STEERS_TTL_MS
      : Number.POSITIVE_INFINITY;
  }

  private extendRecoveryLease(
    streamId: string,
    job: SerializableJobData,
    expiresAt: number,
    parsedPayload?: {
      userId: string;
      tenantId?: string;
      steers?: Array<{
        steerId: string;
        clientSteerId?: string;
        recoveringCreatedAt?: number;
      }>;
    },
    parsedLeasedItem?: {
      steerId: string;
      clientSteerId?: string;
      recoveringCreatedAt?: number;
    },
  ): void {
    if (job.recoveredSteerId == null) {
      return;
    }
    const parked = this.parkedSteers.get(streamId);
    if (parked == null || parked.expiresAt <= Date.now()) {
      return;
    }
    try {
      const parsed =
        parsedPayload ??
        (JSON.parse(parked.payload) as {
          userId: string;
          tenantId?: string;
          steers?: Array<{
            steerId: string;
            clientSteerId?: string;
            recoveringCreatedAt?: number;
          }>;
        });
      const leased =
        parsedLeasedItem ??
        parsed.steers?.find(
          (item) =>
            item.steerId === job.recoveredSteerId && item.recoveringCreatedAt === job.createdAt,
        );
      if (
        leased == null ||
        parsed.userId !== job.userId ||
        (parsed.tenantId != null && parsed.tenantId !== job.tenantId)
      ) {
        return;
      }
      parked.expiresAt = Math.max(parked.expiresAt, expiresAt);
      if (leased.clientSteerId != null) {
        const receiptEntry = this.steerReceipts.get(streamId)?.get(leased.clientSteerId);
        if (receiptEntry != null) {
          receiptEntry.expiresAt = Math.max(receiptEntry.expiresAt, expiresAt);
        }
      }
    } catch {
      // Malformed recovery state remains bounded by its existing TTL.
    }
  }

  async consumeParkedSteer(
    streamId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId: string | undefined,
    expectedCreatedAt: number,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (
      job?.createdAt !== expectedCreatedAt ||
      job.userId !== ownerUserId ||
      job.recoveredSteerId !== steerId ||
      (job.tenantId != null && job.tenantId !== ownerTenantId)
    ) {
      return false;
    }
    const parked = this.parkedSteers.get(streamId);
    if (parked == null || parked.expiresAt <= Date.now()) {
      return true;
    }
    try {
      const parsed = JSON.parse(parked.payload) as {
        userId: string;
        tenantId?: string;
        steers?: Array<{
          steerId: string;
          clientSteerId?: string;
          recoveringCreatedAt?: number;
        }>;
      };
      if (
        parsed.userId !== ownerUserId ||
        (parsed.tenantId != null && parsed.tenantId !== ownerTenantId) ||
        !Array.isArray(parsed.steers) ||
        parsed.steers.length === 0 ||
        !parsed.steers.every(isValidParkedSteer)
      ) {
        return false;
      }
      const consumed = parsed.steers.find(
        (item) => item.steerId === steerId && item.recoveringCreatedAt === expectedCreatedAt,
      );
      if (consumed == null) {
        return false;
      }
      if (consumed.clientSteerId != null) {
        const receipt = this.steerReceipts.get(streamId)?.get(consumed.clientSteerId)?.receipt;
        if (
          receipt?.state !== 'leftover' ||
          receipt.item.steerId !== steerId ||
          receipt.userId !== ownerUserId ||
          (receipt.tenantId != null && receipt.tenantId !== ownerTenantId)
        ) {
          return false;
        }
        receipt.state = 'recovered';
      }
      parsed.steers = parsed.steers.filter((item) => item !== consumed);
      if (parsed.steers.length === 0) {
        this.parkedSteers.delete(streamId);
      } else {
        parked.payload = JSON.stringify(parsed);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Terminal cleanup (approval expiry, stale-running reap) must not drop
   *  202-accepted steers with the job. */
  private isParkedRecoveryCompatible(streamId: string, job: SerializableJobData): boolean {
    const parked = this.parkedSteers.get(streamId);
    if (parked == null || parked.expiresAt <= Date.now()) {
      return true;
    }
    try {
      const parsed = JSON.parse(parked.payload) as {
        userId?: unknown;
        tenantId?: unknown;
        generationProtocolVersion?: unknown;
        steers?: unknown;
      };
      return (
        parsed != null &&
        typeof parsed === 'object' &&
        typeof parsed.userId === 'string' &&
        parsed.userId.length > 0 &&
        parsed.userId === job.userId &&
        (parsed.tenantId == null || parsed.tenantId === job.tenantId) &&
        isValidGenerationProtocolMarker(parsed.generationProtocolVersion) &&
        Array.isArray(parsed.steers) &&
        parsed.steers.length > 0 &&
        parsed.steers.every(isValidParkedSteer)
      );
    } catch {
      return false;
    }
  }

  private parkQueuedSteers(streamId: string, job: SerializableJobData, now: number): void {
    const combined = [
      ...this.claimedSteerItems(streamId, job.createdAt),
      ...(this.steerQueues.get(streamId) ?? []),
    ];
    const seen = new Set<string>();
    const queue = combined.filter((item) => {
      if (seen.has(item.steerId)) {
        return false;
      }
      seen.add(item.steerId);
      return true;
    });
    if (queue.length === 0) {
      return;
    }
    this.settleSteerReceipts(streamId, queue, 'leftover');
    this.parkLeftovers(streamId, queue, job, now);
    this.steerQueues.delete(streamId);
    this.claimedSteers.delete(streamId);
  }
}
