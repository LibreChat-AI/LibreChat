import { createHash } from 'node:crypto';
import type { FilterQuery, Model, Types } from 'mongoose';
import type {
  AgentBackgroundToolResultReceipt,
  AgentEventActorDetachedAction,
  AgentTriggerDeliveryClaim,
  AgentEventActorReceipt,
  AgentTriggerDeliveryFailure,
  AgentTriggerHandlingState,
  AgentTriggerDeliveryRecord,
  AgentTriggerDeliveryStatusRecord,
  AgentTriggerOrderingBlock,
  IAgentTriggerDelivery,
  IAgentTriggerDeliveryDocument,
  IAgentTriggerLaneSequence,
  IAgentTriggerLaneSequenceDocument,
  IAgentTriggerUserPurge,
  IAgentTriggerUserPurgeDocument,
} from '~/types/triggerDelivery';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
} from '~/types/triggerDelivery';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

const DUPLICATE_KEY = 11000;
const LEASE_SKEW_MARGIN_MS = 30_000;
const SUCCESS_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 2048;
const MAX_DEAD_LETTER_LIMIT = 200;
const DEFAULT_PURGE_RECOVERY_LIMIT = 25;
const MAX_PURGE_RECOVERY_LIMIT = 200;
const HISTORY_LIMIT = 64;
const MAX_BATCH_SIZE = 8;
const MAX_BATCH_BYTES = 512 * 1024;
/** Bounds the claim's compare-and-swap retries. Each lost round means another
 * worker claimed the row this one read, so the queue is making progress. */
export const CLAIM_CAS_MAX_ATTEMPTS = 16;
/** Candidates fetched per claim read; losing claimers advance through the
 * batch instead of re-reading the same head-of-queue row. */
const CLAIM_CANDIDATE_BATCH = 8;
/** Matches the per-conversation background task limit, so a listing is complete
 * unless durable rows outlived that limit across restarts; it then says so. */
const MAX_PENDING_BACKGROUND_COMPLETIONS = 200;
/** Every status before a delivery settles, i.e. whose result has not reached its conversation. */
const DEAD_STATUSES: IAgentTriggerDelivery['status'][] = ['dead', 'capability_dead'];
const UNDELIVERED_STATUSES: IAgentTriggerDelivery['status'][] = [
  'staging',
  'capability_staging',
  'batched',
  'pending',
  'capability_pending',
  'leased',
  'capability_leased',
];
/** Capability work is inert to legacy claimers while preserving their lane
 * behavior: publishing is `staging`; queued work is `leased` without a lease
 * owner/deadline; execution adds a private lease; dead work is terminal. */
const LEGACY_CAPABILITY_SHIELD_AT = new Date('9999-12-31T23:59:59.999Z');
const LEGACY_CAPABILITY_SHIELD_OWNER = 'librechat-capability-shield';

function isStagingStatus(status: IAgentTriggerDelivery['status']): boolean {
  return status === 'staging' || status === 'capability_staging';
}

function isStagingDelivery(
  delivery: Pick<IAgentTriggerDelivery, 'status' | 'capabilityStatus'>,
): boolean {
  return isStagingStatus(delivery.status) || delivery.capabilityStatus === 'publishing';
}

const stagingDeliveryScope = {
  $or: [{ status: { $in: ['staging', 'capability_staging'] } }, { capabilityStatus: 'publishing' }],
};
const capabilityStatusProjection = {
  publishing: 'capability_staging',
  pending: 'capability_pending',
  leased: 'capability_leased',
  dead: 'capability_dead',
} as const;

type DuplicateKeyError = { code?: number };

export type AgentEventActorReceiptMetric = {
  operation: 'read' | 'settle' | 'backfill';
  outcome: 'hit' | 'miss' | 'success' | 'replay' | 'conflict';
  resolution?: AgentEventActorReceipt['resolution'];
};

let observeAgentEventActorReceipt = (_metric: AgentEventActorReceiptMetric): void => undefined;

/** Installs one process-local, low-cardinality observer at the storage boundary. */
export function setAgentEventActorReceiptMetricObserver(
  observer?: (metric: AgentEventActorReceiptMetric) => void,
): void {
  observeAgentEventActorReceipt = observer ?? (() => undefined);
}

/** Emits one already-bounded receipt metric through the configured observer. */
export function recordAgentEventActorReceiptMetric(metric: AgentEventActorReceiptMetric): void {
  try {
    observeAgentEventActorReceipt(metric);
  } catch (error) {
    logger.warn('[trigger-delivery] Event actor receipt metric observer failed', error);
  }
}

export class AgentTriggerClaimContentionError extends Error {
  constructor(attempts: number) {
    super(`Agent trigger claim lost ${attempts} compare-and-swap rounds to concurrent workers`);
    this.name = 'AgentTriggerClaimContentionError';
  }
}

export class AgentTriggerDeliveryConflictError extends Error {
  constructor(deliveryKey: string) {
    super(`Agent trigger delivery key ${deliveryKey} was reused with different content`);
    this.name = 'AgentTriggerDeliveryConflictError';
  }
}

export interface EnqueueAgentTriggerDeliveryInput {
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  envelope: unknown;
  user: string | Types.ObjectId;
  tenantId?: string;
  availableAt: Date;
  envelopeBytes?: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  awaitTerminalHandling?: boolean;
  requiredWorkerCapability?: string;
  producerLeaseUntil?: Date;
}

export type AgentTriggerProducerLeaseStatus =
  | { status: 'live'; leaseUntil: Date }
  | { status: 'expired'; leaseUntil: Date }
  | { status: 'missing' };

export interface PersistAgentBackgroundToolResultInput {
  deliveryKey: string;
  sourceId: string;
  result: AgentBackgroundToolResultReceipt;
}

export type AgentBackgroundToolResultClaim =
  | { status: 'not_ready' }
  | { status: 'claimed'; claimId: string }
  | {
      status: 'acquired';
      results: Array<{
        taskId: string;
        toolCallId: string;
        toolName: string;
        status: AgentBackgroundToolResultReceipt['status'];
        output: string;
      }>;
    };

export interface AgentTriggerDeliveryFence {
  id: string;
  workerId: string;
  claimToken: string;
}

export interface SettleAgentTriggerHandlingOutcomeInput {
  deliveryKey: string;
  conversationId: string;
  generationCreatedAt: number;
  status: Exclude<AgentTriggerHandlingState['status'], 'started'>;
  settledAt: Date;
  error?: string;
  action?: AgentTriggerHandlingState['action'];
}

export interface SettleAgentEventActorReceiptInput {
  deliveryKey: string;
  user: string | Types.ObjectId;
  tenantId?: string;
  bindingId: string;
  conversationId: string;
  generationCreatedAt: number;
  status: 'applied' | 'failed';
  settledAt: Date;
  error?: string;
  /** Present for executions that acquired the delivery-owned action CAS.
   * Absent only for mixed-version terminal rows created before this field. */
  requiresActionAdmission?: true;
  receipt: Omit<AgentEventActorReceipt, 'bindingId' | 'settledAt'>;
}

export interface AdmitAgentEventActorActionInput extends GetAgentEventActorReceiptInput {
  admittedAt: Date;
  admissionId: string;
}

export interface AgentEventActorActionAdmissionInput extends GetAgentEventActorReceiptInput {
  admissionId: string;
}

/** Durable transition receipt. Storage unavailability remains an exception;
 * callers never collapse it into a conflict or a negative acknowledgement. */
export interface AgentEventActorDetachedTransitionResult {
  status: 'applied' | 'already_applied' | 'conflict';
}

export interface ReserveAgentEventActorDetachedActionInput extends GetAgentEventActorReceiptInput {
  generationCreatedAt: number;
  turnId: string;
  invocationId: string;
  expectedToolName: string;
  toolName: string;
  toolCallId: string;
  reservedAt: Date;
  recoveryAfter: Date;
}

export interface UpdateAgentEventActorDetachedActionInput extends GetAgentEventActorReceiptInput {
  generationCreatedAt: number;
  taskId: string;
  idempotencyKey: string;
  observedAt: Date;
}

export interface MarkAgentEventActorDetachedActionRunningInput
  extends UpdateAgentEventActorDetachedActionInput {
  recoveryAfter: Date;
}

export interface SettleAgentEventActorDetachedActionInput
  extends UpdateAgentEventActorDetachedActionInput {
  status: 'succeeded' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
}

export interface GetAgentEventActorReceiptInput {
  deliveryKey: string;
  user: string | Types.ObjectId;
  tenantId?: string;
  bindingId: string;
  conversationId: string;
}

export type BackfillAgentEventActorReceiptInput = SettleAgentEventActorReceiptInput;

export interface AgentEventActorReceiptStorageMetrics {
  retainedByResolution: Record<AgentEventActorReceipt['resolution'], number>;
  expiryEligible: number;
  retryDeliveries: number;
  deadDeliveries: number;
}

/** A background tool completion that has not reached its conversation yet. */
export interface PendingAgentBackgroundToolCompletion {
  deliveryKey: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  dispatchedAt: Date;
  /** The tool's terminal outcome once it settled; absent while it still runs. */
  result?: { status: AgentBackgroundToolResultReceipt['status']; settledAt: Date };
  /** An automatic delivery holds the result and is starting its turn. */
  claimedByWakeup: boolean;
}

export interface PendingAgentBackgroundToolCompletions {
  completions: PendingAgentBackgroundToolCompletion[];
  /** Completions whose delivery dead-lettered: never delivered, recoverable only by a poll. */
  dead: PendingAgentBackgroundToolCompletion[];
  /** The first page overflowed; separate reads may not cover one complete snapshot. */
  truncated: boolean;
}

export interface UndeliveredAgentTriggerTaskIds {
  taskIds: string[];
  truncated: boolean;
}

/** Selects deferred internal deliveries whose readiness condition just changed. */
export interface ExpediteAgentTriggerDeliveriesInput {
  sourceIds: readonly string[];
  /** Exact deliveries, e.g. the one whose result just became durable. */
  deliveryKeys?: readonly string[];
  /** Every matching delivery of one principal, e.g. after one of its generations settled. */
  user?: string | Types.ObjectId;
  /** Narrows a principal's selection to deliveries that resume this conversation. */
  conversationId?: string;
  /** Exact tasks within a principal's conversation, including a repaired attempt's predecessor. */
  taskIds?: readonly string[];
  now: Date;
}

export interface ExpediteAgentTriggerDeliveriesResult {
  /** Deferred, unheld deliveries moved to `now`. */
  expedited: number;
  /** Deliveries a worker held, marked so their next deferral re-checks at once. */
  held: number;
}

export interface AgentTriggerDeliveryMethods {
  ensureAgentTriggerDeliveryIndexes: () => Promise<void>;
  enqueueAgentTriggerDelivery: (
    input: EnqueueAgentTriggerDeliveryInput,
  ) => Promise<{ delivery: AgentTriggerDeliveryRecord; replayed: boolean }>;
  claimNextAgentTriggerDelivery: (input: {
    workerId: string;
    claimToken: string;
    now: Date;
    leaseUntil: Date;
    workerCapabilities?: string[];
  }) => Promise<AgentTriggerDeliveryClaim | null>;
  findEarlierAgentTriggerDelivery: (
    delivery: Pick<AgentTriggerDeliveryRecord, 'orderingKey' | 'laneSequence'>,
  ) => Promise<AgentTriggerOrderingBlock | null>;
  getAgentTriggerDeliveryBatch: (
    delivery: Pick<AgentTriggerDeliveryRecord, 'id' | 'batchMemberIds'>,
  ) => Promise<AgentTriggerDeliveryRecord[]>;
  releaseAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & { availableAt: Date },
  ) => Promise<boolean>;
  beginAgentTriggerDeliveryAttempt: (
    input: AgentTriggerDeliveryFence & { now: Date },
  ) => Promise<number | null>;
  /** `expedited` when readiness changed while the delivery was held: it is due now instead. */
  deferAgentTriggerDeliveryAttempt: (
    input: AgentTriggerDeliveryFence & { attempt: number; availableAt: Date },
  ) => Promise<boolean | 'expedited'>;
  completeAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      result: unknown;
      settledAt: Date;
      handling?: AgentTriggerHandlingState;
      awaitTerminalHandling?: true;
    },
    recovery?: { required: boolean },
  ) => Promise<boolean>;
  retireAgentTriggerDelivery: (
    input: {
      deliveryKey: string;
      sourceId: string;
      settledAt: Date;
      reason: string;
      onlyIfUnclaimed?: boolean;
      onlyIfDead?: boolean;
      /** Accept transport success without a terminal handling receipt, unless the
       * delivery explicitly keeps its lane open for terminal handling. */
      allowSucceeded?: boolean;
      /** True only when this call retired the delivery, not when it had already
       * succeeded, e.g. delivered by a resolver that won the race. */
      requireTransition?: boolean;
    },
    recovery?: { required: boolean },
  ) => Promise<boolean>;
  renewAgentTriggerDeliveryProducerLease: (input: {
    deliveryKey: string;
    sourceId: string;
    leaseUntil: Date;
  }) => Promise<boolean>;
  getAgentTriggerDeliveryProducerLease: (input: {
    deliveryKey: string;
    sourceId: string;
    now: Date;
  }) => Promise<AgentTriggerProducerLeaseStatus>;
  listPendingAgentBackgroundToolCompletions: (input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
    /** One task's completion, e.g. to discard it. */
    taskId?: string;
    limit?: number;
  }) => Promise<PendingAgentBackgroundToolCompletions>;
  /** Task ids of one conversation's undelivered internal deliveries from one source. */
  listUndeliveredAgentTriggerTaskIds: (input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
  }) => Promise<UndeliveredAgentTriggerTaskIds>;
  expediteAgentTriggerDeliveries: (
    input: ExpediteAgentTriggerDeliveriesInput,
  ) => Promise<ExpediteAgentTriggerDeliveriesResult>;
  persistAgentBackgroundToolResult: (
    input: PersistAgentBackgroundToolResultInput,
  ) => Promise<boolean>;
  getAgentBackgroundToolResult: (input: {
    deliveryKey: string;
    sourceId: string;
  }) => Promise<AgentBackgroundToolResultReceipt | null>;
  getAgentBackgroundToolResultClaim: (input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    taskId: string;
  }) => Promise<AgentBackgroundToolResultReceipt['resultClaim'] | null>;
  claimAgentBackgroundToolResults: (input: {
    deliveryKey: string;
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    agentId?: string;
    claimId: string;
    limit?: number;
  }) => Promise<AgentBackgroundToolResultClaim>;
  releaseAgentBackgroundToolResultClaims: (input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    claimId: string;
  }) => Promise<boolean>;
  settleAgentTriggerHandlingOutcome: (
    input: SettleAgentTriggerHandlingOutcomeInput,
  ) => Promise<boolean>;
  admitAgentEventActorAction: (input: AdmitAgentEventActorActionInput) => Promise<boolean>;
  releaseAgentEventActorAction: (input: AgentEventActorActionAdmissionInput) => Promise<boolean>;
  getAgentEventActorActionAdmission: (
    input: GetAgentEventActorReceiptInput,
  ) => Promise<string | null>;
  hasAgentEventActorActionAdmission: (
    input: AgentEventActorActionAdmissionInput,
  ) => Promise<boolean>;
  reserveAgentEventActorDetachedAction: (
    input: ReserveAgentEventActorDetachedActionInput,
  ) => Promise<{
    status: 'reserved' | 'replay' | 'conflict';
    action: AgentEventActorDetachedAction;
  }>;
  markAgentEventActorDetachedActionRunning: (
    input: MarkAgentEventActorDetachedActionRunningInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  markAgentEventActorDetachedActionLaunchIndeterminate: (
    input: UpdateAgentEventActorDetachedActionInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  settleAgentEventActorDetachedAction: (
    input: SettleAgentEventActorDetachedActionInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  getAgentEventActorDetachedAction: (
    input: GetAgentEventActorReceiptInput & { generationCreatedAt: number },
  ) => Promise<AgentEventActorDetachedAction | null>;
  settleAgentEventActorReceipt: (input: SettleAgentEventActorReceiptInput) => Promise<boolean>;
  getAgentEventActorReceipt: (
    input: GetAgentEventActorReceiptInput,
  ) => Promise<AgentEventActorReceipt | null>;
  backfillAgentEventActorReceipt: (input: BackfillAgentEventActorReceiptInput) => Promise<boolean>;
  getAgentEventActorReceiptStorageMetrics: (
    now: Date,
  ) => Promise<AgentEventActorReceiptStorageMetrics>;
  retryAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      availableAt: Date;
    },
  ) => Promise<boolean>;
  deadLetterAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      settledAt: Date;
      receiptRetryAt?: Date;
    },
    recovery?: { required: boolean },
  ) => Promise<boolean>;
  getAgentTriggerDelivery: (deliveryKey: string) => Promise<AgentTriggerDeliveryRecord | null>;
  getAgentTriggerDeliveryStatus: (
    deliveryKey: string,
    user: string | Types.ObjectId,
    sourceKeyId: string,
    tenantId?: string,
  ) => Promise<AgentTriggerDeliveryStatusRecord | null>;
  getAgentTriggerDeadLetters: (limit?: number) => Promise<AgentTriggerDeliveryRecord[]>;
  requeueAgentTriggerDelivery: (
    id: string,
    availableAt: Date,
  ) => Promise<AgentTriggerDeliveryRecord | null>;
  countActiveAgentTriggerDeliveriesByUser: (
    user: string | Types.ObjectId,
    now: Date,
  ) => Promise<number>;
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
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
    tenantId?: string,
  ) => Promise<void>;
  cancelAgentTriggerUserPurge: (
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
  ) => Promise<boolean>;
  recoverAgentTriggerUserPurges: (limit?: number, activity?: { found: boolean }) => Promise<number>;
  deleteAgentTriggerDeliveriesByUser: (user: string | Types.ObjectId) => Promise<void>;
  eraseAgentTriggerDeliveryConversationResults: (
    user: string | Types.ObjectId,
    conversationIds: string[],
  ) => Promise<void>;
  prepareAgentTriggerConversationResultErasure: (
    user: string | Types.ObjectId,
    conversationIds: string[],
  ) => Promise<void>;
}

function normalizeFailure(error: AgentTriggerDeliveryFailure): AgentTriggerDeliveryFailure {
  return {
    ...error,
    code: error.code.slice(0, MAX_ERROR_CODE_LENGTH),
    message: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function toRecord(delivery: IAgentTriggerDelivery): AgentTriggerDeliveryRecord {
  if (delivery._id == null || delivery.createdAt == null) {
    throw new Error('Persisted agent trigger delivery is missing its identity or creation time');
  }
  /** A pre-shield worker can requeue and finish a capability delivery without
   * knowing to update its private lifecycle. Its terminal success is exact
   * execution evidence, so stale private metadata cannot override it. */
  const shieldedCapability =
    delivery.requiredWorkerCapability != null && delivery.status !== 'succeeded'
      ? delivery.capabilityStatus
      : undefined;
  const projectedStatus =
    shieldedCapability == null ? delivery.status : capabilityStatusProjection[shieldedCapability];
  return {
    id: String(delivery._id),
    deliveryKey: delivery.deliveryKey,
    fingerprint: delivery.fingerprint,
    orderingKey: delivery.orderingKey,
    laneSequence: delivery.laneSequence,
    envelope: delivery.envelope,
    user: delivery.user,
    status: projectedStatus,
    attempts: delivery.attempts,
    availableAt: shieldedCapability
      ? (delivery.claimAvailableAt ?? delivery.availableAt)
      : delivery.availableAt,
    createdAt: delivery.createdAt,
    ...(delivery.tenantId != null && { tenantId: delivery.tenantId }),
    ...(delivery.requiredWorkerCapability != null && {
      requiredWorkerCapability: delivery.requiredWorkerCapability,
    }),
    ...((shieldedCapability ? delivery.capabilityLeaseBy : delivery.leaseBy) != null && {
      leaseBy: shieldedCapability ? delivery.capabilityLeaseBy : delivery.leaseBy,
    }),
    ...((shieldedCapability ? delivery.capabilityLeaseUntil : delivery.leaseUntil) != null && {
      leaseUntil: shieldedCapability ? delivery.capabilityLeaseUntil : delivery.leaseUntil,
    }),
    ...((shieldedCapability ? delivery.capabilityClaimToken : delivery.claimToken) != null && {
      claimToken: shieldedCapability ? delivery.capabilityClaimToken : delivery.claimToken,
    }),
    ...(delivery.lastError != null && { lastError: delivery.lastError }),
    ...(delivery.result !== undefined && { result: delivery.result }),
    ...(delivery.history != null && { history: delivery.history }),
    ...(delivery.settledAt != null && { settledAt: delivery.settledAt }),
    ...(delivery.expiresAt != null && { expiresAt: delivery.expiresAt }),
    ...(delivery.requeueCount != null && {
      requeueCount: delivery.requeueCount,
    }),
    ...(delivery.updatedAt != null && { updatedAt: delivery.updatedAt }),
    ...(delivery.envelopeBytes != null && {
      envelopeBytes: delivery.envelopeBytes,
    }),
    ...(delivery.coalesceKey != null && { coalesceKey: delivery.coalesceKey }),
    ...(delivery.coalesceFrom != null && {
      coalesceFrom: delivery.coalesceFrom,
    }),
    ...(delivery.coalesceUntil != null && {
      coalesceUntil: delivery.coalesceUntil,
    }),
    ...(delivery.batchSize != null && { batchSize: delivery.batchSize }),
    ...(delivery.batchBytes != null && { batchBytes: delivery.batchBytes }),
    ...(delivery.batchMemberIds != null && {
      batchMemberIds: delivery.batchMemberIds,
    }),
    ...(delivery.batchRootId != null && { batchRootId: delivery.batchRootId }),
    ...(delivery.batchMembersSettledAt != null && {
      batchMembersSettledAt: delivery.batchMembersSettledAt,
    }),
    ...(delivery.awaitTerminalHandling != null && {
      awaitTerminalHandling: delivery.awaitTerminalHandling,
    }),
    ...(delivery.handling != null && { handling: delivery.handling }),
    ...(delivery.actorReceipt != null && {
      actorReceipt: delivery.actorReceipt,
    }),
  };
}

function requireClaim(delivery: IAgentTriggerDelivery | null): AgentTriggerDeliveryClaim | null {
  if (delivery == null) {
    return null;
  }
  const record = toRecord(delivery);
  if (
    !['leased', 'capability_leased'].includes(record.status) ||
    record.claimToken == null ||
    record.leaseBy == null ||
    record.leaseUntil == null
  ) {
    throw new Error('Claimed agent trigger delivery is missing its lease fence');
  }
  return record as AgentTriggerDeliveryClaim;
}

export function createAgentTriggerDeliveryMethods(
  mongoose: typeof import('mongoose'),
  deps: {
    purgeQueuedTurnsForUser?: (user: string | Types.ObjectId) => Promise<unknown>;
  } = {},
): AgentTriggerDeliveryMethods {
  const Delivery = () =>
    mongoose.models.AgentTriggerDelivery as Model<IAgentTriggerDeliveryDocument>;
  const LaneSequence = () =>
    mongoose.models.AgentTriggerLaneSequence as Model<IAgentTriggerLaneSequenceDocument>;
  const UserPurge = () =>
    mongoose.models.AgentTriggerUserPurge as Model<IAgentTriggerUserPurgeDocument>;

  async function ensureAgentTriggerDeliveryIndexes(): Promise<void> {
    await Promise.all([
      createIndexesWithRetry(Delivery()),
      createIndexesWithRetry(LaneSequence()),
      createIndexesWithRetry(UserPurge()),
    ]);
  }

  async function abandonLanePublisher(lane: IAgentTriggerLaneSequence): Promise<boolean> {
    const publisherDeliveryId = lane.publisherDeliveryId;
    if (publisherDeliveryId == null) {
      return false;
    }
    if (!Number.isSafeInteger(lane.value) || lane.value <= 0) {
      throw new Error('Agent trigger lane publisher has an invalid sequence');
    }
    const publisherFence = {
      _id: lane._id,
      value: lane.value,
      publisherDeliveryId,
      ...(lane.publisherRequeueCount == null
        ? { publisherRequeueCount: { $exists: false } }
        : { publisherRequeueCount: lane.publisherRequeueCount }),
    };
    if (lane.value === 1) {
      const deleted = await LaneSequence().deleteOne(publisherFence);
      return deleted.deletedCount === 1;
    }
    const released = await LaneSequence().updateOne(publisherFence, {
      $inc: { value: -1 },
      $set: { cleanupRequestedAt: new Date() },
      $unset: {
        publisherDeliveryId: 1,
        publisherRequeueCount: 1,
        publisherStartedAt: 1,
      },
    });
    return released.modifiedCount === 1;
  }

  async function recoverLanePublisher(lane: IAgentTriggerLaneSequence): Promise<boolean> {
    const publisherDeliveryId = lane.publisherDeliveryId;
    if (publisherDeliveryId == null) {
      return false;
    }
    if (!Number.isSafeInteger(lane.value) || lane.value <= 0) {
      throw new Error('Agent trigger lane publisher has an invalid sequence');
    }

    const staged = await Delivery().findById(publisherDeliveryId).lean<IAgentTriggerDelivery>();
    const publicationGeneration = lane.publisherRequeueCount ?? staged?.requeueCount ?? 0;
    if (lane.publisherRequeueCount == null) {
      /** Upgrade a publisher acquired by a pre-generation binary before
       * touching its delivery. The exact lane fence prevents a stale helper
       * from adopting the requeue generation of a later publisher. */
      const adopted = await LaneSequence().updateOne(
        {
          _id: lane._id,
          value: lane.value,
          publisherDeliveryId,
          publisherRequeueCount: { $exists: false },
        },
        { $set: { publisherRequeueCount: publicationGeneration } },
        { timestamps: false },
      );
      if (adopted.modifiedCount !== 1) {
        return false;
      }
    }
    const publicationLane = {
      ...lane,
      publisherRequeueCount: publicationGeneration,
    };
    let batchRoot: IAgentTriggerDelivery | null = null;
    if (
      staged?._id != null &&
      staged.coalesceKey != null &&
      (staged.batchMemberIds?.length ?? 0) === 0
    ) {
      batchRoot = await Delivery()
        .findOne({
          orderingKey: lane._id,
          batchMemberIds: staged._id,
        })
        .lean<IAgentTriggerDelivery>();
      if (
        batchRoot == null &&
        lane.tailDeliveryId != null &&
        staged.coalesceFrom != null &&
        staged.coalesceUntil != null &&
        staged.coalesceUntil.getTime() > Date.now() &&
        staged.envelopeBytes != null &&
        staged.envelopeBytes <= MAX_BATCH_BYTES
      ) {
        batchRoot = await Delivery()
          .findOneAndUpdate(
            {
              _id: { $ne: staged._id },
              $or: [{ _id: lane.tailDeliveryId }, { batchMemberIds: lane.tailDeliveryId }],
              orderingKey: lane._id,
              coalesceKey: staged.coalesceKey,
              status: 'pending',
              coalesceFrom: { $lte: staged.coalesceUntil },
              coalesceUntil: {
                $gt: new Date(),
                $gte: staged.coalesceFrom,
              },
              batchMemberIds: { $ne: staged._id },
              batchSize: { $lt: MAX_BATCH_SIZE },
              batchBytes: { $lte: MAX_BATCH_BYTES - staged.envelopeBytes },
            },
            {
              $inc: { batchSize: 1, batchBytes: staged.envelopeBytes },
              $max: { coalesceFrom: staged.coalesceFrom },
              $min: {
                coalesceUntil: staged.coalesceUntil,
                availableAt: staged.coalesceUntil,
              },
              $push: { batchMemberIds: staged._id },
              ...(staged.awaitTerminalHandling === true && {
                $set: { awaitTerminalHandling: true },
              }),
            },
            { new: true, sort: { laneSequence: -1, _id: -1 } },
          )
          .lean<IAgentTriggerDelivery>();
        if (batchRoot == null) {
          batchRoot = await Delivery()
            .findOne({ orderingKey: lane._id, batchMemberIds: staged._id })
            .lean<IAgentTriggerDelivery>();
        }
      }
      if (
        batchRoot?._id != null &&
        staged.awaitTerminalHandling === true &&
        batchRoot.awaitTerminalHandling !== true
      ) {
        const promoted = await Delivery().updateOne(
          { _id: batchRoot._id, batchMemberIds: staged._id },
          { $set: { awaitTerminalHandling: true } },
        );
        if (promoted.matchedCount !== 1) {
          throw new Error('Failed to promote terminal handling onto the trigger batch root');
        }
        batchRoot.awaitTerminalHandling = true;
      }
    }
    let publishedStatus: IAgentTriggerDelivery['status'] = 'pending';
    if (batchRoot != null) {
      publishedStatus = 'batched';
    } else if (staged?.capabilityStatus === 'publishing') {
      publishedStatus = 'leased';
    } else if (staged?.requiredWorkerCapability != null) {
      publishedStatus = 'capability_pending';
    }
    const published = await Delivery().updateOne(
      {
        _id: publisherDeliveryId,
        orderingKey: lane._id,
        ...stagingDeliveryScope,
        requeueCount: publicationGeneration,
      },
      {
        $set: {
          status: publishedStatus,
          laneSequence: lane.value,
          ...(staged?.capabilityStatus === 'publishing' && {
            capabilityStatus: 'pending',
            availableAt: staged.claimAvailableAt ?? staged.availableAt,
          }),
          ...(batchRoot?._id != null && {
            batchRootId: batchRoot._id,
            batchRootRequeueCount: batchRoot.requeueCount ?? 0,
          }),
        },
        $unset: {
          stagingRecoveryAt: 1,
          ...(staged?.capabilityStatus === 'publishing' && {
            leaseBy: 1,
            leaseUntil: 1,
            claimToken: 1,
          }),
        },
      },
    );
    let publicationCommitted = published.modifiedCount === 1;
    if (published.modifiedCount === 0) {
      let current = await Delivery()
        .findById(publisherDeliveryId)
        .select('orderingKey laneSequence status capabilityStatus batchRootId requeueCount')
        .lean<
          Pick<
            IAgentTriggerDelivery,
            | 'orderingKey'
            | 'laneSequence'
            | 'status'
            | 'capabilityStatus'
            | 'batchRootId'
            | 'requeueCount'
          >
        >();
      if (
        batchRoot?._id != null &&
        current != null &&
        current.orderingKey === lane._id &&
        !isStagingDelivery(current) &&
        current.laneSequence !== lane.value
      ) {
        await Delivery().updateOne(
          {
            _id: publisherDeliveryId,
            orderingKey: lane._id,
            status: current.status,
            requeueCount: publicationGeneration,
          },
          {
            $set: {
              laneSequence: lane.value,
              batchRootId: batchRoot._id,
              batchRootRequeueCount: batchRoot.requeueCount ?? 0,
            },
          },
        );
        current = await Delivery()
          .findById(publisherDeliveryId)
          .select('orderingKey laneSequence status capabilityStatus batchRootId requeueCount')
          .lean<
            Pick<
              IAgentTriggerDelivery,
              | 'orderingKey'
              | 'laneSequence'
              | 'status'
              | 'capabilityStatus'
              | 'batchRootId'
              | 'requeueCount'
            >
          >();
      }
      publicationCommitted =
        current != null &&
        current.orderingKey === lane._id &&
        !isStagingDelivery(current) &&
        current.requeueCount === publicationGeneration &&
        current.laneSequence === lane.value;
      if (current?.orderingKey === lane._id && isStagingDelivery(current)) {
        if (current.requeueCount !== publicationGeneration) {
          return abandonLanePublisher(publicationLane);
        }
        throw new Error('Failed to publish the reserved agent trigger delivery');
      }
    }

    const publisherFence = {
      _id: lane._id,
      value: lane.value,
      publisherDeliveryId,
      publisherRequeueCount: publicationGeneration,
    };
    if (publicationCommitted) {
      const released = await LaneSequence().updateOne(publisherFence, {
        $set: { tailDeliveryId: publisherDeliveryId },
        $unset: {
          publisherDeliveryId: 1,
          publisherRequeueCount: 1,
          publisherStartedAt: 1,
        },
      });
      return published.modifiedCount === 1 || released.modifiedCount === 1;
    }

    // The selected row was published by a competing replica before this
    // reservation was acquired (or was removed by account cleanup). No later
    // reservation can exist while this fence is held, so the unused sequence
    // can be rolled back without creating a gap or regressing the lane tail.
    return abandonLanePublisher(publicationLane);
  }

  /** A dead batch root owns requeue before any constituent is reset. Staging
   * recovery replays this preparation, so a crash cannot leave a dead root
   * beside members that were silently advanced to a new generation. */
  async function prepareBatchMembersForRequeue(root: IAgentTriggerDelivery): Promise<void> {
    const memberIds = root.batchMemberIds ?? [];
    const requeueCount = root.requeueCount ?? 0;
    if (memberIds.length === 0 || requeueCount <= 0 || root._id == null) {
      return;
    }
    const previousRequeueCount = requeueCount - 1;
    await Delivery().updateMany(
      {
        _id: { $in: memberIds },
        orderingKey: root.orderingKey,
        batchRootId: root._id,
        status: { $in: ['staging', 'batched', 'succeeded', 'dead'] },
        ...(previousRequeueCount === 0
          ? {
              $or: [{ batchRootRequeueCount: 0 }, { batchRootRequeueCount: { $exists: false } }],
            }
          : { batchRootRequeueCount: previousRequeueCount }),
      },
      {
        $set: {
          status: 'batched',
          attempts: 0,
          batchRootId: root._id,
          batchRootRequeueCount: requeueCount,
        },
        $unset: {
          lastError: 1,
          result: 1,
          settledAt: 1,
          expiresAt: 1,
          handling: 1,
        },
      },
    );
    const preparedCount = await Delivery().countDocuments({
      _id: { $in: memberIds },
      orderingKey: root.orderingKey,
      status: 'batched',
      batchRootId: root._id,
      batchRootRequeueCount: requeueCount,
    });
    if (preparedCount !== memberIds.length) {
      throw new Error('Not every agent trigger batch receipt could be prepared for requeue');
    }
  }

  async function publishStagedDelivery(
    delivery: IAgentTriggerDelivery,
  ): Promise<IAgentTriggerDelivery> {
    if (delivery._id == null) {
      throw new Error('Staged agent trigger delivery is missing its identity');
    }
    const deliveryId = delivery._id;
    const orderingKey = delivery.orderingKey;

    const adoptLegacyPublishedCapability = async (
      candidate: IAgentTriggerDelivery,
    ): Promise<IAgentTriggerDelivery | null> => {
      if (
        candidate._id == null ||
        candidate.capabilityStatus !== 'publishing' ||
        !['pending', 'capability_pending'].includes(candidate.status) ||
        candidate.laneSequence <= 0
      ) {
        return null;
      }
      const adopted = await Delivery()
        .findOneAndUpdate(
          {
            _id: candidate._id,
            status: { $in: ['pending', 'capability_pending'] },
            capabilityStatus: 'publishing',
            laneSequence: candidate.laneSequence,
          },
          {
            $set: {
              status: 'leased',
              capabilityStatus: 'pending',
              availableAt: candidate.claimAvailableAt ?? candidate.availableAt,
            },
            $unset: {
              stagingRecoveryAt: 1,
              leaseBy: 1,
              leaseUntil: 1,
              claimToken: 1,
            },
          },
          { new: true },
        )
        .lean<IAgentTriggerDelivery>();
      if (adopted == null) {
        return null;
      }
      const adoptedLane = await LaneSequence()
        .findOne({ _id: orderingKey, publisherDeliveryId: candidate._id })
        .lean<IAgentTriggerLaneSequence>();
      if (adoptedLane != null) {
        await recoverLanePublisher(adoptedLane);
      }
      return adopted;
    };

    for (;;) {
      const current = await Delivery().findById(deliveryId).lean<IAgentTriggerDelivery>();
      if (current == null) {
        throw new Error('Staged agent trigger delivery disappeared before publication');
      }
      if (!isStagingDelivery(current)) {
        return current;
      }
      const adoptedCurrent = await adoptLegacyPublishedCapability(current);
      if (adoptedCurrent != null) {
        return adoptedCurrent;
      }
      if ((await UserPurge().exists({ _id: current.user })) != null) {
        return current;
      }
      await prepareBatchMembersForRequeue(current);

      const lane = await LaneSequence().findById(orderingKey).lean<IAgentTriggerLaneSequence>();
      if (lane?.publisherDeliveryId != null) {
        if ((await UserPurge().exists({ _id: lane.user })) != null) {
          return current;
        }
        await recoverLanePublisher(lane);
        continue;
      }

      const legacyPublished = await Delivery()
        .findOne({
          orderingKey,
          status: { $in: ['pending', 'capability_pending'] },
          capabilityStatus: 'publishing',
          laneSequence: { $gt: 0 },
        })
        .sort({ laneSequence: 1, _id: 1 })
        .lean<IAgentTriggerDelivery>();
      if (legacyPublished != null) {
        await adoptLegacyPublishedCapability(legacyPublished);
        continue;
      }

      // The durable staging row exists before sequence allocation. Publishing
      // the oldest visible row first lets any replica repair a writer that
      // stopped in that gap without allowing a later enqueue to overtake it.
      const next = await Delivery()
        .findOne({ orderingKey, ...stagingDeliveryScope })
        // updatedAt is the current staging admission time: initial enqueue
        // sets it on insert, while explicit requeue refreshes it so an old
        // dead letter is admitted behind staging work that already exists.
        .sort({ updatedAt: 1, _id: 1 })
        .lean<IAgentTriggerDelivery>();
      if (next?._id == null) {
        continue;
      }

      let acquired: IAgentTriggerLaneSequence | null = null;
      try {
        acquired = await LaneSequence()
          .findOneAndUpdate(
            { _id: orderingKey, publisherDeliveryId: { $exists: false } },
            {
              $inc: { value: 1 },
              $set: {
                publisherDeliveryId: next._id,
                publisherRequeueCount: next.requeueCount ?? 0,
                publisherStartedAt: new Date(),
              },
              $unset: { cleanupRequestedAt: 1 },
              $setOnInsert: {
                user: next.user,
                ...(next.tenantId != null && { tenantId: next.tenantId }),
              },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
          )
          .lean<IAgentTriggerLaneSequence>();
      } catch (error) {
        if ((error as DuplicateKeyError)?.code !== DUPLICATE_KEY) {
          throw error;
        }
      }
      if (acquired == null) {
        continue;
      }

      // Account deletion creates this durable marker before it can delete
      // rows or lanes. Recheck after acquisition to close the cross-collection
      // race in which the marker appears between the first check and upsert.
      if ((await UserPurge().exists({ _id: next.user })) != null) {
        await abandonLanePublisher(acquired);
        return current;
      }

      await recoverLanePublisher(acquired);
    }
  }

  async function enqueueAgentTriggerDelivery(
    input: EnqueueAgentTriggerDeliveryInput,
  ): Promise<{ delivery: AgentTriggerDeliveryRecord; replayed: boolean }> {
    if (
      input.requiredWorkerCapability != null &&
      input.requiredWorkerCapability !== AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1 &&
      input.requiredWorkerCapability !==
        AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2 &&
      input.requiredWorkerCapability !== AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1 &&
      input.requiredWorkerCapability !== AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1 &&
      input.requiredWorkerCapability !== AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2
    ) {
      throw new TypeError('Agent trigger delivery requires an unsupported worker capability');
    }
    if (input.requiredWorkerCapability != null && input.coalesceKey != null) {
      throw new TypeError('Capability-fenced agent trigger deliveries cannot be batched');
    }
    let staged: IAgentTriggerDelivery;
    let replayed = false;
    try {
      const created = await Delivery().create({
        ...input,
        ...(input.requiredWorkerCapability == null
          ? {}
          : {
              capabilityStatus: 'publishing',
              claimAvailableAt: input.availableAt,
              leaseUntil: LEGACY_CAPABILITY_SHIELD_AT,
            }),
        ...(input.coalesceKey == null
          ? {}
          : {
              batchSize: 1,
              batchBytes: input.envelopeBytes,
              batchMemberIds: [],
            }),
        laneSequence: 0,
        status: 'staging',
        claimAvailableAt: input.availableAt,
        availableAt:
          input.requiredWorkerCapability == null ? input.availableAt : LEGACY_CAPABILITY_SHIELD_AT,
        attempts: 0,
        requeueCount: 0,
        stagingRecoveryAt: new Date(),
      });
      staged = created.toObject();
    } catch (error) {
      if ((error as DuplicateKeyError)?.code !== DUPLICATE_KEY) {
        throw error;
      }
      const existing = await Delivery()
        .findOne({ deliveryKey: input.deliveryKey })
        .lean<IAgentTriggerDelivery>();
      if (existing == null) {
        throw error;
      }
      if (existing.fingerprint !== input.fingerprint) {
        throw new AgentTriggerDeliveryConflictError(input.deliveryKey);
      }
      if (!isStagingDelivery(existing)) {
        return { delivery: toRecord(existing), replayed: true };
      }
      staged = existing;
      replayed = true;
    }

    const published = await publishStagedDelivery(staged);
    return { delivery: toRecord(published), replayed };
  }

  /** Repairs abandoned reservations and staging rows left by crashed writers. */
  async function recoverAgentTriggerLanePublications(
    limit = DEFAULT_PURGE_RECOVERY_LIMIT,
    activity?: { found: boolean },
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Agent trigger lane recovery limit must be a positive integer');
    }
    const boundedLimit = Math.min(limit, MAX_PURGE_RECOVERY_LIMIT);
    const lanes = await LaneSequence()
      .find({
        publisherDeliveryId: { $exists: true },
        publisherStartedAt: { $exists: true },
      })
      .sort({ publisherStartedAt: 1, _id: 1 })
      .limit(boundedLimit)
      .lean<IAgentTriggerLaneSequence[]>();
    if (activity != null && lanes.length > 0) activity.found = true;
    let recovered = 0;
    const recoveryCursor = new Date();
    for (const lane of lanes) {
      if ((await UserPurge().exists({ _id: lane.user })) != null) {
        if (lane.publisherDeliveryId != null && lane.publisherStartedAt != null) {
          await LaneSequence().updateOne(
            {
              _id: lane._id,
              value: lane.value,
              publisherDeliveryId: lane.publisherDeliveryId,
              ...(lane.publisherRequeueCount == null
                ? { publisherRequeueCount: { $exists: false } }
                : { publisherRequeueCount: lane.publisherRequeueCount }),
              publisherStartedAt: lane.publisherStartedAt,
            },
            { $set: { publisherStartedAt: recoveryCursor } },
            { timestamps: false },
          );
        }
        continue;
      }
      if (await recoverLanePublisher(lane)) {
        recovered += 1;
      }
    }

    let remaining = boundedLimit - recovered;
    if (remaining <= 0) {
      return recovered;
    }
    /** Pre-cursor replicas can leave staging rows outside the sparse recovery
     * index. Backfill them in bounded batches before using the indexed scan. */
    const legacyStaged = await Delivery()
      .find({
        ...stagingDeliveryScope,
        stagingRecoveryAt: { $exists: false },
      })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(remaining)
      .lean<IAgentTriggerDelivery[]>();
    const legacyCursor = new Date();
    for (const delivery of legacyStaged) {
      if (delivery._id != null) {
        await Delivery().updateOne(
          {
            _id: delivery._id,
            ...stagingDeliveryScope,
            stagingRecoveryAt: { $exists: false },
          },
          { $set: { stagingRecoveryAt: legacyCursor } },
          { timestamps: false },
        );
      }
    }
    remaining -= legacyStaged.length;
    const legacyIds = legacyStaged.flatMap((delivery) =>
      delivery._id != null ? [delivery._id] : [],
    );
    const indexedStaged =
      remaining > 0
        ? await Delivery()
            .find({
              ...stagingDeliveryScope,
              stagingRecoveryAt: { $exists: true },
              ...(legacyIds.length > 0 && { _id: { $nin: legacyIds } }),
            })
            .sort({ stagingRecoveryAt: 1, _id: 1 })
            .limit(remaining)
            .lean<IAgentTriggerDelivery[]>()
        : [];
    if (activity != null && (legacyStaged.length > 0 || indexedStaged.length > 0)) {
      activity.found = true;
    }
    const staged = [
      ...legacyStaged.map((delivery) => ({
        ...delivery,
        stagingRecoveryAt: legacyCursor,
      })),
      ...indexedStaged,
    ];
    const stagingRecoveryCursor = new Date();
    const rotateStagingRecovery = async (delivery: IAgentTriggerDelivery): Promise<void> => {
      if (delivery._id == null || delivery.stagingRecoveryAt == null) {
        return;
      }
      await Delivery().updateOne(
        {
          _id: delivery._id,
          ...stagingDeliveryScope,
          stagingRecoveryAt: delivery.stagingRecoveryAt,
        },
        { $set: { stagingRecoveryAt: stagingRecoveryCursor } },
        { timestamps: false },
      );
    };
    for (const delivery of staged) {
      try {
        const published = await publishStagedDelivery(delivery);
        if (!isStagingDelivery(published)) {
          recovered += 1;
        } else {
          await rotateStagingRecovery(delivery);
        }
      } catch (error) {
        // Account deletion can remove a staged row while a replica is helping
        // it. Suppress only that confirmed race; operational failures remain
        // visible to the maintenance loop.
        if (delivery._id != null && (await Delivery().exists({ _id: delivery._id })) == null) {
          continue;
        }
        await rotateStagingRecovery(delivery);
        throw error;
      }
    }
    return recovered;
  }

  async function reclaimLaneIfInactive(orderingKey: string): Promise<boolean> {
    const lane = await LaneSequence().findById(orderingKey).lean<IAgentTriggerLaneSequence>();
    if (lane?.cleanupRequestedAt == null) {
      return false;
    }
    const stillRetained = await Delivery().exists({
      orderingKey,
      $or: [
        {
          status: {
            $in: [
              'staging',
              'capability_staging',
              'batched',
              'pending',
              'capability_pending',
              'leased',
              'capability_leased',
              'capability_dead',
              'dead',
            ],
          },
        },
        {
          status: 'succeeded',
          batchRootId: { $exists: false },
          awaitTerminalHandling: true,
          'handling.status': 'started',
        },
      ],
    });
    if (stillRetained != null) {
      await LaneSequence().updateOne(
        { _id: orderingKey, cleanupRequestedAt: lane.cleanupRequestedAt },
        { $unset: { cleanupRequestedAt: 1 } },
      );
      return false;
    }
    const deleted = await LaneSequence().deleteOne({
      _id: orderingKey,
      ...(lane.tailDeliveryId == null
        ? { tailDeliveryId: { $exists: false } }
        : { tailDeliveryId: lane.tailDeliveryId }),
      cleanupRequestedAt: lane.cleanupRequestedAt,
      publisherDeliveryId: { $exists: false },
    });
    return deleted.deletedCount === 1;
  }

  async function fulfillLaneCleanupRequest(
    delivery: Pick<IAgentTriggerDelivery, '_id' | 'orderingKey' | 'laneCleanupPendingAt'>,
  ): Promise<boolean> {
    if (delivery._id == null || delivery.laneCleanupPendingAt == null) {
      return false;
    }
    await LaneSequence().updateOne(
      { _id: delivery.orderingKey },
      { $set: { cleanupRequestedAt: delivery.laneCleanupPendingAt } },
    );
    await Delivery().updateOne(
      {
        _id: delivery._id,
        status: 'succeeded',
        laneCleanupPendingAt: delivery.laneCleanupPendingAt,
      },
      { $unset: { laneCleanupPendingAt: 1 } },
      { timestamps: false },
    );
    return reclaimLaneIfInactive(delivery.orderingKey);
  }

  /** Bounds high-cardinality ordering metadata after the final retained job settles. */
  async function reclaimInactiveAgentTriggerLanes(
    limit = DEFAULT_PURGE_RECOVERY_LIMIT,
    activity?: { found: boolean },
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Agent trigger lane reclamation limit must be a positive integer');
    }
    const boundedLimit = Math.min(limit, MAX_PURGE_RECOVERY_LIMIT);
    const pendingCleanup = await Delivery()
      .find({ status: 'succeeded', laneCleanupPendingAt: { $exists: true } })
      .sort({ laneCleanupPendingAt: 1, _id: 1 })
      .limit(boundedLimit)
      .select('_id orderingKey laneCleanupPendingAt')
      .lean<Array<Pick<IAgentTriggerDelivery, '_id' | 'orderingKey' | 'laneCleanupPendingAt'>>>();
    if (activity != null && pendingCleanup.length > 0) activity.found = true;
    let reclaimed = 0;
    for (const delivery of pendingCleanup) {
      if (await fulfillLaneCleanupRequest(delivery)) {
        reclaimed += 1;
      }
    }

    const remaining = boundedLimit - pendingCleanup.length;
    if (remaining <= 0) {
      return reclaimed;
    }
    const lanes = await LaneSequence()
      .find({ cleanupRequestedAt: { $exists: true } })
      .sort({ cleanupRequestedAt: 1, _id: 1 })
      .limit(remaining)
      .select('_id')
      .lean<Array<Pick<IAgentTriggerLaneSequence, '_id'>>>();
    if (activity != null && lanes.length > 0) activity.found = true;
    for (const lane of lanes) {
      if (await reclaimLaneIfInactive(lane._id)) {
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  async function claimNextAgentTriggerDelivery(input: {
    workerId: string;
    claimToken: string;
    now: Date;
    leaseUntil: Date;
    workerCapabilities?: string[];
  }): Promise<AgentTriggerDeliveryClaim | null> {
    const expiredBefore = new Date(input.now.getTime() - LEASE_SKEW_MARGIN_MS);
    const workerCapabilities = [...new Set(input.workerCapabilities ?? [])];
    if (workerCapabilities.some((value) => value.length === 0 || value.length > 128)) {
      throw new TypeError('Agent trigger worker capability is invalid');
    }
    const capabilityConditions =
      workerCapabilities.length === 0
        ? []
        : [
            {
              requiredWorkerCapability: { $in: workerCapabilities },
              capabilityStatus: 'pending',
              claimAvailableAt: { $lte: input.now },
              status: { $in: ['pending', 'leased'] },
            },
            {
              requiredWorkerCapability: { $in: workerCapabilities },
              capabilityStatus: 'leased',
              capabilityLeaseUntil: { $lte: expiredBefore },
              status: 'leased',
            },
            {
              requiredWorkerCapability: { $in: workerCapabilities },
              status: 'capability_pending',
              availableAt: { $lte: input.now },
            },
            {
              requiredWorkerCapability: { $in: workerCapabilities },
              status: 'capability_leased',
              leaseUntil: { $lte: expiredBefore },
            },
            {
              /** A pre-shield replica can explicitly requeue the legacy-visible
               * dead shell. Its publication leaves the private lifecycle at
               * `dead`; the capable claimant atomically adopts that requeue. */
              requiredWorkerCapability: { $in: workerCapabilities },
              status: 'capability_pending',
              capabilityStatus: 'dead',
              settledAt: { $exists: false },
              availableAt: { $lte: input.now },
            },
          ];
    const claimableFilter: FilterQuery<IAgentTriggerDelivery> = {
      $or: [
        {
          requiredWorkerCapability: { $exists: false },
          status: 'pending',
          availableAt: { $lte: input.now },
        },
        {
          requiredWorkerCapability: { $exists: false },
          status: 'leased',
          leaseUntil: { $lte: expiredBefore },
        },
        ...capabilityConditions,
      ],
    };
    /** The claim's written values depend on the row's own lifecycle, which a
     * classic update cannot branch on and Amazon DocumentDB will not accept as
     * an aggregation pipeline. Read the oldest claimable candidates under the
     * same sort, then claim one by pinning its exact `_id` and lifecycle state
     * with a compare-and-swap. Ownership is still granted only by the fenced
     * write, so concurrent workers cannot both win. Reading a BATCH is what
     * keeps concurrent claimers from convoying on one head-of-queue row: a
     * worker that loses a candidate moves to the next from the same read
     * instead of re-reading, so a fleet of claimers spreads across the batch
     * while each still prefers the oldest work. An empty queue costs the one
     * read it costs today; a successful claim costs one additional round trip. */
    let casAttempts = 0;
    while (casAttempts < CLAIM_CAS_MAX_ATTEMPTS) {
      const candidates = await Delivery()
        .find(claimableFilter)
        .read('primary')
        .sort({ claimAvailableAt: 1, availableAt: 1, createdAt: 1, _id: 1 })
        .limit(CLAIM_CANDIDATE_BATCH)
        .select('_id status capabilityStatus availableAt')
        .lean<
          Array<Pick<IAgentTriggerDelivery, '_id' | 'status' | 'capabilityStatus' | 'availableAt'>>
        >();
      if (candidates.length === 0) {
        return null;
      }
      for (const candidate of candidates) {
        if (casAttempts >= CLAIM_CAS_MAX_ATTEMPTS) {
          break;
        }
        casAttempts += 1;
        const hasCapabilityLifecycle = candidate.capabilityStatus !== undefined;
        const adoptsDeadCapability =
          candidate.status === 'capability_pending' && candidate.capabilityStatus === 'dead';
        const claimedStatus: IAgentTriggerDelivery['status'] =
          !hasCapabilityLifecycle &&
          (candidate.status === 'capability_pending' || candidate.status === 'capability_leased')
            ? 'capability_leased'
            : 'leased';
        const claimed = await Delivery()
          .findOneAndUpdate(
            {
              ...claimableFilter,
              _id: candidate._id,
              status: candidate.status,
              capabilityStatus: hasCapabilityLifecycle
                ? candidate.capabilityStatus
                : { $exists: false },
              /** The adoption write copies the read-time `availableAt` into the
               * ordering key, so the fence must pin it: a concurrent requeue
               * that bumps it (without changing the pinned lifecycle pair)
               * would otherwise get a stale ordering stamp. */
              ...(adoptsDeadCapability ? { availableAt: candidate.availableAt } : {}),
            },
            {
              $set: {
                status: claimedStatus,
                ...(adoptsDeadCapability ? { claimAvailableAt: candidate.availableAt } : {}),
                ...(hasCapabilityLifecycle
                  ? {
                      capabilityStatus: 'leased',
                      capabilityLeaseBy: input.workerId,
                      capabilityLeaseUntil: input.leaseUntil,
                      capabilityClaimToken: input.claimToken,
                    }
                  : {}),
                leaseBy: hasCapabilityLifecycle ? LEGACY_CAPABILITY_SHIELD_OWNER : input.workerId,
                leaseUntil: hasCapabilityLifecycle ? LEGACY_CAPABILITY_SHIELD_AT : input.leaseUntil,
                claimToken: hasCapabilityLifecycle
                  ? LEGACY_CAPABILITY_SHIELD_OWNER
                  : input.claimToken,
                updatedAt: input.now,
              },
              $unset: {
                settledAt: 1,
                expiresAt: 1,
                ...(hasCapabilityLifecycle
                  ? {}
                  : { capabilityLeaseBy: 1, capabilityLeaseUntil: 1, capabilityClaimToken: 1 }),
              },
            },
            { new: true, timestamps: false },
          )
          .lean<IAgentTriggerDelivery>();
        if (claimed != null) {
          return requireClaim(claimed);
        }
      }
    }
    /** Exhausting the budget means every attempted row was taken by another
     * worker — heavy contention, not an empty queue. `null` is the engine's
     * confirmed-empty signal and advances its idle backoff, which would leave
     * queued work waiting; the typed throw lands on the engine's retryable
     * claim-failure path, which holds the polling cadence instead. */
    throw new AgentTriggerClaimContentionError(CLAIM_CAS_MAX_ATTEMPTS);
  }

  async function findEarlierAgentTriggerDelivery(
    delivery: Pick<AgentTriggerDeliveryRecord, 'orderingKey' | 'laneSequence'>,
  ): Promise<AgentTriggerOrderingBlock | null> {
    const earlier = await Delivery()
      .findOne({
        orderingKey: delivery.orderingKey,
        laneSequence: { $lt: delivery.laneSequence },
        $or: [
          {
            requiredWorkerCapability: { $exists: false },
            status: { $in: ['pending', 'leased'] },
          },
          {
            status: { $in: ['capability_pending', 'capability_leased'] },
          },
          {
            requiredWorkerCapability: { $exists: true },
            capabilityStatus: { $in: ['publishing', 'pending', 'leased'] },
          },
          {
            status: 'succeeded',
            batchRootId: { $exists: false },
            awaitTerminalHandling: true,
            'handling.status': 'started',
          },
        ],
      })
      .sort({ laneSequence: 1 })
      .select(
        'availableAt claimAvailableAt leaseUntil capabilityLeaseUntil status capabilityStatus handling.status',
      )
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | 'availableAt'
          | 'claimAvailableAt'
          | 'leaseUntil'
          | 'capabilityLeaseUntil'
          | 'status'
          | 'capabilityStatus'
          | 'handling'
        >
      >();
    if (earlier == null) {
      return null;
    }
    const shieldedCapability = earlier.capabilityStatus != null;
    const leaseUntil = shieldedCapability ? earlier.capabilityLeaseUntil : earlier.leaseUntil;
    return {
      availableAt: shieldedCapability
        ? (earlier.claimAvailableAt ?? earlier.availableAt)
        : earlier.availableAt,
      ...(leaseUntil != null && { leaseUntil }),
      ...(earlier.status === 'succeeded' &&
        earlier.handling?.status === 'started' && {
          reason: 'active_handling' as const,
        }),
    };
  }

  async function getAgentTriggerDeliveryBatch(
    delivery: Pick<AgentTriggerDeliveryRecord, 'id' | 'batchMemberIds'>,
  ): Promise<AgentTriggerDeliveryRecord[]> {
    const memberIds = delivery.batchMemberIds ?? [];
    if (memberIds.length === 0) {
      return [];
    }
    const members = await Delivery()
      .find({ _id: { $in: memberIds } })
      .lean<IAgentTriggerDelivery[]>();
    const byId = new Map(members.map((member) => [String(member._id), member]));
    return memberIds.map((id) => {
      const member = byId.get(String(id));
      if (member == null) {
        throw new Error('Agent trigger batch member is missing');
      }
      if (member.batchRootId != null && String(member.batchRootId) !== delivery.id) {
        throw new Error('Agent trigger batch member belongs to another root');
      }
      return toRecord(member);
    });
  }

  async function propagateBatchHandling(
    root: Pick<
      IAgentTriggerDelivery,
      '_id' | 'orderingKey' | 'batchMemberIds' | 'status' | 'settledAt' | 'handling'
    >,
  ): Promise<void> {
    if (root._id == null || root.handling == null || !root.batchMemberIds?.length) {
      return;
    }
    const status = root.handling.status;
    const retiresDeadMembers =
      root.status === 'succeeded' && status !== 'started' && root.handling.settledAt != null;
    await Delivery().updateMany(
      {
        _id: { $in: root.batchMemberIds },
        orderingKey: root.orderingKey,
        batchRootId: root._id,
        ...(retiresDeadMembers && {
          status: { $in: ['staging', 'batched', 'succeeded', 'dead'] },
        }),
        $or:
          status === 'started'
            ? [{ 'handling.status': 'started' }, { 'handling.status': { $exists: false } }]
            : [
                { 'handling.status': { $in: ['started', status] } },
                { 'handling.status': { $exists: false } },
              ],
      },
      {
        $set: {
          handling: root.handling,
          ...(retiresDeadMembers && {
            status: 'succeeded',
            settledAt: root.settledAt ?? root.handling.settledAt,
          }),
          ...(status !== 'started' &&
            root.handling.settledAt != null && {
              expiresAt: new Date(root.handling.settledAt.getTime() + SUCCESS_RETENTION_MS),
            }),
        },
        ...(retiresDeadMembers && { $unset: { lastError: 1 } }),
      },
    );
  }

  async function finalizeAgentEventActorDelivery(
    root: Pick<
      IAgentTriggerDelivery,
      '_id' | 'orderingKey' | 'batchMemberIds' | 'status' | 'settledAt' | 'handling'
    >,
    settledAt: Date,
  ): Promise<void> {
    await propagateBatchHandling(root);
    /** Actor receipt finalization is terminal regardless of the mailbox
     * rollout flag. Publishing cleanup unconditionally is safe because the
     * lane reclaimer independently refuses any still-active lane. */
    await LaneSequence().updateOne(
      { _id: root.orderingKey },
      { $set: { cleanupRequestedAt: settledAt } },
    );
    await reclaimLaneIfInactive(root.orderingKey);
  }

  async function settleBatchMembers(
    root: Pick<
      IAgentTriggerDelivery,
      | '_id'
      | 'orderingKey'
      | 'batchMemberIds'
      | 'batchMembersSettledAt'
      | 'requeueCount'
      | 'awaitTerminalHandling'
      | 'handling'
    >,
    input: {
      attempt: number;
      workerId: string;
      status: 'succeeded' | 'dead';
      settledAt: Date;
      result?: unknown;
      error?: AgentTriggerDeliveryFailure;
    },
  ): Promise<void> {
    if (root._id == null || root.batchMembersSettledAt != null) {
      return;
    }
    const memberIds = root.batchMemberIds ?? [];
    if (memberIds.length > 0) {
      const error = input.error == null ? undefined : normalizeFailure(input.error);
      const batchRootRequeueCount = root.requeueCount ?? 0;
      const awaitsTerminalHandling =
        root.awaitTerminalHandling === true && root.handling?.status === 'started';
      const settlement =
        input.status === 'succeeded'
          ? {
              status: input.status,
              attempts: input.attempt,
              result: input.result,
              settledAt: input.settledAt,
              ...(!awaitsTerminalHandling && {
                expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
              }),
              batchRootId: root._id,
              ...(root.handling != null && { handling: root.handling }),
            }
          : {
              status: input.status,
              attempts: input.attempt,
              settledAt: input.settledAt,
              lastError: error,
              batchRootId: root._id,
            };
      await Delivery().updateMany(
        {
          _id: { $in: memberIds },
          orderingKey: root.orderingKey,
          status: { $in: ['staging', 'batched'] },
          ...(batchRootRequeueCount === 0
            ? {
                $or: [{ batchRootRequeueCount: 0 }, { batchRootRequeueCount: { $exists: false } }],
              }
            : { batchRootRequeueCount }),
        },
        {
          $set: settlement,
          $unset: {
            leaseBy: 1,
            leaseUntil: 1,
            claimToken: 1,
            ...(input.status === 'succeeded'
              ? {
                  lastError: 1,
                  ...(awaitsTerminalHandling && { expiresAt: 1 }),
                }
              : { result: 1, expiresAt: 1 }),
          },
          $push: {
            history: {
              $each: [
                {
                  attempt: input.attempt,
                  outcome: input.status === 'succeeded' ? 'succeeded' : 'dead',
                  at: input.settledAt,
                  workerId: input.workerId,
                  ...(error == null ? {} : { error }),
                },
              ],
              $slice: -HISTORY_LIMIT,
            },
          },
        },
      );
      const settledCount = await Delivery().countDocuments({
        _id: { $in: memberIds },
        orderingKey: root.orderingKey,
        status: input.status,
      });
      if (settledCount !== memberIds.length) {
        throw new Error('Not every agent trigger batch receipt could be settled');
      }
      if (input.status === 'succeeded' && root.handling != null) {
        const authoritative = await Delivery()
          .findById(root._id)
          .select('_id orderingKey batchMemberIds status settledAt handling')
          .lean<
            Pick<
              IAgentTriggerDelivery,
              '_id' | 'orderingKey' | 'batchMemberIds' | 'status' | 'settledAt' | 'handling'
            >
          >();
        if (authoritative != null) {
          await propagateBatchHandling(authoritative);
        }
      }
    }
    await Delivery().updateOne(
      {
        _id: root._id,
        status: input.status,
        batchMembersSettledAt: { $exists: false },
      },
      { $set: { batchMembersSettledAt: input.settledAt } },
      { timestamps: false },
    );
  }

  async function recoverAgentTriggerBatchReceipts(
    limit = DEFAULT_PURGE_RECOVERY_LIMIT,
    activity?: { found: boolean },
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Agent trigger batch recovery limit must be a positive integer');
    }
    const roots = await Delivery()
      .find({
        status: { $in: ['succeeded', 'dead'] },
        batchMemberIds: { $exists: true, $ne: [] },
        batchMembersSettledAt: { $exists: false },
      })
      .sort({ settledAt: 1, _id: 1 })
      .limit(Math.min(limit, MAX_PURGE_RECOVERY_LIMIT))
      .lean<IAgentTriggerDelivery[]>();
    if (activity != null && roots.length > 0) activity.found = true;
    let recovered = 0;
    for (const root of roots) {
      if (root.settledAt == null || (root.status !== 'succeeded' && root.status !== 'dead')) {
        continue;
      }
      const error = root.status === 'dead' ? root.lastError : undefined;
      await settleBatchMembers(root, {
        attempt: Math.max(root.attempts, 1),
        workerId: 'batch-recovery',
        status: root.status,
        settledAt: root.settledAt,
        ...(root.status === 'succeeded' ? { result: root.result } : {}),
        ...(error == null ? {} : { error }),
      });
      if (root.status === 'succeeded') {
        await fulfillLaneCleanupRequest(root);
      }
      recovered += 1;
    }
    return recovered;
  }

  const ordinaryFence = (input: AgentTriggerDeliveryFence) => ({
    status: 'leased' as const,
    requiredWorkerCapability: { $exists: false },
    leaseBy: input.workerId,
    claimToken: input.claimToken,
  });

  const legacyCapabilityFence = (input: AgentTriggerDeliveryFence) => ({
    status: 'capability_leased',
    requiredWorkerCapability: { $exists: true },
    leaseBy: input.workerId,
    claimToken: input.claimToken,
  });

  const shieldCapabilityFence = (input: AgentTriggerDeliveryFence) => ({
    status: 'leased' as const,
    requiredWorkerCapability: { $exists: true },
    capabilityStatus: 'leased' as const,
    capabilityLeaseBy: input.workerId,
    capabilityClaimToken: input.claimToken,
  });

  const fence = (input: AgentTriggerDeliveryFence) => ({
    _id: input.id,
    $or: [ordinaryFence(input), legacyCapabilityFence(input), shieldCapabilityFence(input)],
  });

  /** Readiness signals and the lease release must meet in one fenced write. Try
   * the unmarked state first, then the marked state: a concurrent expedite can
   * only add a marker while this lease is held. After release, expedite's second
   * update sees an unheld row. No pipeline updates or unfenced follow-up needed. */
  async function releaseWaitingDelivery(
    input: AgentTriggerDeliveryFence & { availableAt: Date; attempt?: number },
  ): Promise<boolean | 'expedited'> {
    const attemptFence = input.attempt == null ? {} : { attempts: input.attempt };
    const attemptChange = input.attempt == null ? {} : { $inc: { attempts: -1 } };
    const profiles = [
      { filter: shieldCapabilityFence(input), status: 'leased', capabilityStatus: 'pending' },
      { filter: legacyCapabilityFence(input), status: 'capability_pending' },
      { filter: ordinaryFence(input), status: 'pending' },
    ] as const;
    for (const marked of [false, true]) {
      for (const profile of profiles) {
        const availableAt = marked ? new Date() : input.availableAt;
        const result = await Delivery().updateOne(
          {
            _id: input.id,
            ...profile.filter,
            ...attemptFence,
            wakeRequestedAt: { $exists: marked },
          },
          {
            ...attemptChange,
            $set: {
              status: profile.status,
              ...('capabilityStatus' in profile && { capabilityStatus: profile.capabilityStatus }),
              availableAt,
              claimAvailableAt: availableAt,
            },
            $unset: {
              leaseBy: 1,
              leaseUntil: 1,
              claimToken: 1,
              capabilityLeaseBy: 1,
              capabilityLeaseUntil: 1,
              capabilityClaimToken: 1,
              wakeRequestedAt: 1,
            },
          },
        );
        if (result.modifiedCount === 1) {
          return marked ? 'expedited' : true;
        }
      }
    }
    return false;
  }

  async function releaseAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & { availableAt: Date },
  ): Promise<boolean> {
    return (await releaseWaitingDelivery(input)) !== false;
  }

  async function beginAgentTriggerDeliveryAttempt(
    input: AgentTriggerDeliveryFence & { now: Date },
  ): Promise<number | null> {
    const updated = await Delivery()
      .findOneAndUpdate(
        {
          _id: input.id,
          $or: [
            { ...ordinaryFence(input), leaseUntil: { $gt: input.now } },
            { ...legacyCapabilityFence(input), leaseUntil: { $gt: input.now } },
            {
              ...shieldCapabilityFence(input),
              capabilityLeaseUntil: { $gt: input.now },
            },
          ],
        },
        { $inc: { attempts: 1 } },
        { new: true },
      )
      .select('attempts')
      .lean<Pick<IAgentTriggerDelivery, 'attempts'>>();
    return updated?.attempts ?? null;
  }

  /** Releases a pre-dispatch deferral and restores the attempt consumed by beginAttempt. */
  async function deferAgentTriggerDeliveryAttempt(
    input: AgentTriggerDeliveryFence & { attempt: number; availableAt: Date },
  ): Promise<boolean | 'expedited'> {
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
      throw new TypeError('attempt must be a positive integer');
    }
    return releaseWaitingDelivery(input);
  }

  async function completeAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      result: unknown;
      settledAt: Date;
      handling?: AgentTriggerHandlingState;
      awaitTerminalHandling?: true;
    },
    recovery?: { required: boolean },
  ): Promise<boolean> {
    const awaitsTerminalHandling =
      input.awaitTerminalHandling === true && input.handling?.status === 'started';
    const completed = await Delivery()
      .findOneAndUpdate(
        {
          ...fence(input),
          ...(input.awaitTerminalHandling === true
            ? { awaitTerminalHandling: true }
            : { awaitTerminalHandling: { $ne: true } }),
        },
        {
          $set: {
            status: 'succeeded',
            result: input.result,
            settledAt: input.settledAt,
            ...(!awaitsTerminalHandling && {
              expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
            }),
            laneCleanupPendingAt: input.settledAt,
            ...(input.handling != null && { handling: input.handling }),
          },
          $unset: {
            leaseBy: 1,
            leaseUntil: 1,
            claimToken: 1,
            capabilityStatus: 1,
            claimAvailableAt: 1,
            capabilityLeaseBy: 1,
            capabilityLeaseUntil: 1,
            capabilityClaimToken: 1,
            lastError: 1,
            ...(awaitsTerminalHandling && { expiresAt: 1 }),
          },
          $push: {
            history: {
              $each: [
                {
                  attempt: input.attempt,
                  outcome: 'succeeded',
                  at: input.settledAt,
                  workerId: input.workerId,
                },
              ],
              $slice: -HISTORY_LIMIT,
            },
          },
        },
        { new: true },
      )
      .select(
        '_id orderingKey laneCleanupPendingAt batchMemberIds batchMembersSettledAt requeueCount awaitTerminalHandling handling',
      )
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | '_id'
          | 'orderingKey'
          | 'laneCleanupPendingAt'
          | 'batchMemberIds'
          | 'batchMembersSettledAt'
          | 'requeueCount'
          | 'awaitTerminalHandling'
          | 'handling'
        >
      >();
    if (completed?._id == null) {
      return false;
    }

    try {
      await settleBatchMembers(completed, {
        attempt: input.attempt,
        workerId: input.workerId,
        status: 'succeeded',
        settledAt: input.settledAt,
        result: input.result,
      });
      await fulfillLaneCleanupRequest(completed);
    } catch (error) {
      if (recovery != null) recovery.required = true;
      // Root success is authoritative. Maintenance retries both constituent
      // receipt settlement and the existing durable lane-cleanup marker.
      logger.warn('[agent-triggers] failed to finalize a completed trigger batch', {
        orderingKey: completed.orderingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  /** Retires an internally pre-admitted delivery when its producer can prove
   * that the result will never become dispatchable. This transition is keyed
   * by the immutable delivery identity rather than a worker lease so the
   * producer can unblock the lane even while a resolver is deferring it. */
  async function retireAgentTriggerDelivery(
    input: {
      deliveryKey: string;
      sourceId: string;
      settledAt: Date;
      reason: string;
      onlyIfUnclaimed?: boolean;
      onlyIfDead?: boolean;
      /** Accept transport success without a terminal handling receipt, unless the
       * delivery explicitly keeps its lane open for terminal handling. */
      allowSucceeded?: boolean;
      /** True only when this call retired the delivery, not when it had already
       * succeeded, e.g. delivered by a resolver that won the race. */
      requireTransition?: boolean;
    },
    recovery?: { required: boolean },
  ): Promise<boolean> {
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      Number.isNaN(input.settledAt.getTime()) ||
      (input.onlyIfUnclaimed === true && input.onlyIfDead === true)
    ) {
      throw new TypeError('Invalid agent trigger delivery retirement');
    }
    const result = {
      status: 'settled',
      backgroundToolCompletionRetired: true,
      reason: input.reason.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    };
    const statusFence = (() => {
      if (input.onlyIfDead === true) {
        return {
          $or: [
            { status: { $in: ['dead', 'capability_dead'] } },
            { status: 'leased', capabilityStatus: 'dead' },
          ],
        };
      }
      if (input.onlyIfUnclaimed === true) {
        return {
          $or: [
            { status: { $in: ['pending', 'capability_pending'] } },
            /** A capability-shielded pending row looks leased to legacy
             * workers but has no private claimant yet. */
            { status: 'leased', capabilityStatus: 'pending' },
          ],
        };
      }
      return {
        status: {
          $in: ['pending', 'leased', 'capability_pending', 'capability_leased'],
        },
      };
    })();
    const retired = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          'envelope.event.source.type': 'internal',
          'envelope.event.source.id': input.sourceId,
          ...statusFence,
        },
        {
          $set: {
            status: 'succeeded',
            result,
            settledAt: input.settledAt,
            expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
            laneCleanupPendingAt: input.settledAt,
          },
          $unset: {
            leaseBy: 1,
            leaseUntil: 1,
            claimToken: 1,
            capabilityStatus: 1,
            claimAvailableAt: 1,
            capabilityLeaseBy: 1,
            capabilityLeaseUntil: 1,
            capabilityClaimToken: 1,
            lastError: 1,
          },
        },
        { new: true },
      )
      .select('_id orderingKey laneCleanupPendingAt')
      .lean<Pick<IAgentTriggerDelivery, '_id' | 'orderingKey' | 'laneCleanupPendingAt'>>();
    if (retired?._id != null) {
      try {
        await fulfillLaneCleanupRequest(retired);
      } catch (error) {
        if (recovery != null) recovery.required = true;
        logger.warn('[agent-triggers] failed to finalize a retired internal delivery', {
          deliveryKey: input.deliveryKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
    if (input.requireTransition === true) {
      return false;
    }
    return (
      (await Delivery().exists({
        deliveryKey: input.deliveryKey,
        'envelope.event.source.type': 'internal',
        'envelope.event.source.id': input.sourceId,
        status: 'succeeded',
        $or: [
          { handling: { $exists: false } },
          { 'handling.status': { $in: ['applied', 'completed_no_action', 'failed', 'cancelled'] } },
          ...(input.allowSucceeded === true ? [{ awaitTerminalHandling: { $ne: true } }] : []),
        ],
      })) != null
    );
  }

  /** Refreshes process-owner liveness without changing delivery claim state.
   * The max transition makes a lost write receipt safe to replay and prevents
   * an older heartbeat from shortening a newer lease. */
  async function renewAgentTriggerDeliveryProducerLease(input: {
    deliveryKey: string;
    sourceId: string;
    leaseUntil: Date;
  }): Promise<boolean> {
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      !(input.leaseUntil instanceof Date) ||
      !Number.isFinite(input.leaseUntil.getTime())
    ) {
      throw new TypeError('Invalid agent trigger producer lease renewal');
    }
    const renewed = await Delivery().updateOne(
      {
        deliveryKey: input.deliveryKey,
        requiredWorkerCapability: {
          $in: [
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          ],
        },
        'envelope.event.source.type': 'internal',
        'envelope.event.source.id': input.sourceId,
        status: {
          $in: ['pending', 'leased', 'capability_pending', 'capability_leased'],
        },
        capabilityStatus: { $ne: 'dead' },
        settledAt: { $exists: false },
      },
      /** `$max` is the classic-operator form of "never shorten a newer lease":
       * it writes only when the incoming deadline is later, and sets the field
       * when it is missing. Aggregation-pipeline updates are unsupported on
       * Amazon DocumentDB (`misc/documentdb/documentdb-compat.md`). */
      { $max: { producerLeaseUntil: input.leaseUntil } },
      { timestamps: false },
    );
    return renewed.matchedCount === 1;
  }

  /** Reads only the private producer lease. Missing is intentionally distinct
   * for compatibility with rows admitted before this evidence existed. */
  async function getAgentTriggerDeliveryProducerLease(input: {
    deliveryKey: string;
    sourceId: string;
    now: Date;
  }): Promise<AgentTriggerProducerLeaseStatus> {
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new TypeError('Invalid agent trigger producer lease lookup');
    }
    const delivery = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        requiredWorkerCapability: {
          $in: [
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          ],
        },
        'envelope.event.source.type': 'internal',
        'envelope.event.source.id': input.sourceId,
      })
      .select('+producerLeaseUntil')
      .lean<Pick<IAgentTriggerDelivery, 'producerLeaseUntil'>>();
    if (delivery?.producerLeaseUntil == null) {
      return { status: 'missing' };
    }
    return delivery.producerLeaseUntil.getTime() > input.now.getTime()
      ? { status: 'live', leaseUntil: delivery.producerLeaseUntil }
      : { status: 'expired', leaseUntil: delivery.producerLeaseUntil };
  }

  /** Every background completion of one conversation that has not been
   * delivered yet: still running, or settled and waiting for a wake-up. The
   * durable delivery row outlives the process-local task registry (another
   * replica, a restart, or the registry's retention), so it is the record of
   * what is still going to arrive. Result content is never returned here. */
  async function listPendingAgentBackgroundToolCompletions(input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
    taskId?: string;
    limit?: number;
  }): Promise<PendingAgentBackgroundToolCompletions> {
    const limit = Math.min(
      input.limit ?? MAX_PENDING_BACKGROUND_COMPLETIONS,
      MAX_PENDING_BACKGROUND_COMPLETIONS,
    );
    if (
      input.conversationId.length === 0 ||
      input.conversationId.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      (input.taskId != null && (input.taskId.length === 0 || input.taskId.length > 256)) ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new TypeError('Invalid pending background completion lookup');
    }
    type CompletionRow = Pick<
      IAgentTriggerDelivery,
      'deliveryKey' | 'createdAt' | 'backgroundToolResult' | 'status' | 'capabilityStatus'
    > & { envelope?: { event?: { payload?: Record<string, unknown> } } };
    const scope = {
      user: input.user,
      'envelope.event.source.type': 'internal',
      'envelope.event.source.id': input.sourceId,
      'envelope.target.conversationId': input.conversationId,
      ...(input.taskId != null && { 'envelope.event.payload.taskId': input.taskId }),
      /** Legacy rows keep results only on the parent message. */
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
    };
    const read = (filter: FilterQuery<IAgentTriggerDelivery>) =>
      Delivery()
        .find({ ...scope, ...filter })
        .select(
          'deliveryKey createdAt status capabilityStatus envelope.event.payload ' +
            'backgroundToolResult.status backgroundToolResult.settledAt backgroundToolResult.resultClaim',
        )
        .sort({ updatedAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean<CompletionRow[]>();
    const project = (row: CompletionRow): PendingAgentBackgroundToolCompletion | undefined => {
      const payload = row.envelope?.event?.payload;
      const taskId = payload?.taskId;
      const toolCallId = payload?.toolCallId;
      const toolName = payload?.toolName;
      if (
        row.createdAt == null ||
        typeof taskId !== 'string' ||
        typeof toolCallId !== 'string' ||
        typeof toolName !== 'string'
      ) {
        return undefined;
      }
      const receipt = row.backgroundToolResult;
      return {
        deliveryKey: row.deliveryKey,
        taskId,
        toolCallId,
        toolName,
        dispatchedAt: row.createdAt,
        ...(receipt != null && {
          result: { status: receipt.status, settledAt: receipt.settledAt },
        }),
        claimedByWakeup: receipt?.resultClaim != null,
      };
    };
    const classify = (rows: CompletionRow[]): PendingAgentBackgroundToolCompletions => {
      const completions: PendingAgentBackgroundToolCompletion[] = [];
      const dead: PendingAgentBackgroundToolCompletion[] = [];
      for (const row of rows.slice(0, limit)) {
        const completion = project(row);
        if (completion == null) continue;
        if (DEAD_STATUSES.includes(row.status) || row.capabilityStatus === 'dead') {
          dead.push(completion);
        } else {
          completions.push(completion);
        }
      }
      return { completions: completions.reverse(), dead, truncated: rows.length > limit };
    };
    const first = classify(
      await read({ status: { $in: [...UNDELIVERED_STATUSES, ...DEAD_STATUSES] } }),
    );
    if (!first.truncated) return first;

    /** Overfull conversations need separate bounded reads so old dead letters
     * cannot hide pending work. Separate reads can straddle a transition, so
     * absence is not evidence of delivery until a later single read fits. */
    const [waitingRows, deadRows] = await Promise.all([
      read({ status: { $in: UNDELIVERED_STATUSES }, capabilityStatus: { $ne: 'dead' } }),
      read({
        $or: [
          { status: { $in: DEAD_STATUSES } },
          { status: { $in: UNDELIVERED_STATUSES }, capabilityStatus: 'dead' },
        ],
      }),
    ]);
    const waiting = classify(waitingRows);
    const dead = classify(deadRows);
    const failedIds = new Set(dead.dead.map(({ taskId }) => taskId));
    return {
      completions: waiting.completions.filter(({ taskId }) => !failedIds.has(taskId)),
      dead: dead.dead,
      truncated: true,
    };
  }

  async function listUndeliveredAgentTriggerTaskIds(input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
  }): Promise<UndeliveredAgentTriggerTaskIds> {
    if (
      input.conversationId.length === 0 ||
      input.conversationId.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256
    ) {
      throw new TypeError('Invalid undelivered task lookup');
    }
    const rows = await Delivery()
      .find({
        user: input.user,
        'envelope.event.source.type': 'internal',
        'envelope.event.source.id': input.sourceId,
        'envelope.target.conversationId': input.conversationId,
        status: { $in: UNDELIVERED_STATUSES },
        capabilityStatus: { $ne: 'dead' },
      })
      .select('envelope.event.payload.taskId')
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_PENDING_BACKGROUND_COMPLETIONS + 1)
      .lean<Array<{ envelope?: { event?: { payload?: { taskId?: unknown } } } }>>();
    const taskIds = rows
      .slice(0, MAX_PENDING_BACKGROUND_COMPLETIONS)
      .map((row) => row.envelope?.event?.payload?.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string');
    return { taskIds, truncated: rows.length > MAX_PENDING_BACKGROUND_COMPLETIONS };
  }

  /** Pulls deferred deliveries back to `now` when the condition they were
   * waiting on has changed, so a waiting delivery can back off without delaying
   * the moment it becomes deliverable. Unclaimed rows move now; held rows retain
   * a signal consumed atomically by readiness deferral or ordering release. */
  async function expediteAgentTriggerDeliveries(
    input: ExpediteAgentTriggerDeliveriesInput,
  ): Promise<ExpediteAgentTriggerDeliveriesResult> {
    const deliveryKeys = input.deliveryKeys ?? [];
    if (
      (input.taskIds != null &&
        (input.user == null ||
          input.conversationId == null ||
          input.taskIds.length === 0 ||
          input.taskIds.some((id) => id.length === 0 || id.length > 256))) ||
      input.sourceIds.length === 0 ||
      input.sourceIds.some((id) => id.length === 0 || id.length > 256) ||
      deliveryKeys.some((key) => key.length === 0 || key.length > 256) ||
      (deliveryKeys.length === 0 && input.user == null) ||
      (input.conversationId != null &&
        (input.conversationId.length === 0 || input.conversationId.length > 256)) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new TypeError('Invalid agent trigger delivery expedite');
    }
    const selection = {
      'envelope.event.source.type': 'internal',
      'envelope.event.source.id': { $in: [...input.sourceIds] },
      ...(deliveryKeys.length > 0 && { deliveryKey: { $in: [...deliveryKeys] } }),
      ...(input.taskIds != null && {
        'envelope.event.payload.taskId': { $in: [...input.taskIds] },
      }),
      ...(input.user != null && { user: input.user }),
      ...(input.conversationId != null && {
        'envelope.target.conversationId': input.conversationId,
      }),
    };
    /** Classic operators only: aggregation-pipeline updates are not portable. A
     * held row may be deferred on readiness its worker read before the change,
     * so it keeps a marker that its deferral honors instead of moving now. The
     * marker is written first: a row released after it was read as held is then
     * seen unheld by the move, so no release between the two escapes both. */
    const held = await Delivery().updateMany(
      {
        ...selection,
        status: { $in: ['leased', 'capability_leased'] },
        $or: [{ leaseBy: { $exists: true } }, { capabilityLeaseBy: { $exists: true } }],
      },
      { $set: { wakeRequestedAt: input.now } },
    );
    const moved = await Delivery().updateMany(
      {
        ...selection,
        availableAt: { $gt: input.now },
        leaseBy: { $exists: false },
        $or: [
          { status: { $in: ['pending', 'capability_pending'] } },
          {
            status: 'leased',
            capabilityStatus: 'pending',
            capabilityLeaseBy: { $exists: false },
          },
        ],
      },
      { $set: { availableAt: input.now, claimAvailableAt: input.now } },
    );
    return { expedited: moved.modifiedCount, held: held.matchedCount };
  }

  /** Stores terminal output on the pre-admitted delivery before attempting the
   * parent-message projection. The first terminal receipt wins; exact retries
   * are idempotent and conflicting rewrites fail closed. */
  async function persistAgentBackgroundToolResult(
    input: PersistAgentBackgroundToolResultInput,
  ): Promise<boolean> {
    const { result } = input;
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      !['completed', 'error', 'cancelled'].includes(result.status) ||
      result.output.length > AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS ||
      !(result.settledAt instanceof Date) ||
      !Number.isFinite(result.settledAt.getTime())
    ) {
      throw new TypeError('Invalid background tool result receipt');
    }
    const identity = {
      deliveryKey: input.deliveryKey,
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      'envelope.event.source.type': 'internal',
      'envelope.event.source.id': input.sourceId,
      backgroundToolResultErasedAt: { $exists: false },
    };
    const updated = await Delivery().updateOne(
      {
        ...identity,
        backgroundToolResult: { $exists: false },
        status: { $nin: ['dead', 'capability_dead', 'succeeded'] },
        capabilityStatus: { $ne: 'dead' },
      },
      { $set: { backgroundToolResult: result } },
      { timestamps: false },
    );
    if (updated.matchedCount === 1) {
      return true;
    }
    const existing = await Delivery()
      .findOne(identity)
      .select('+backgroundToolResult')
      .lean<Pick<IAgentTriggerDelivery, 'backgroundToolResult'>>();
    return (
      existing?.backgroundToolResult?.status === result.status &&
      existing.backgroundToolResult.output === result.output &&
      existing.backgroundToolResult.settledAt.getTime() === result.settledAt.getTime()
    );
  }

  async function getAgentBackgroundToolResult(input: {
    deliveryKey: string;
    sourceId: string;
  }): Promise<AgentBackgroundToolResultReceipt | null> {
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256
    ) {
      throw new TypeError('Invalid background tool result receipt lookup');
    }
    const delivery = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
        'envelope.event.source.type': 'internal',
        'envelope.event.source.id': input.sourceId,
      })
      .select('+backgroundToolResult')
      .lean<Pick<IAgentTriggerDelivery, 'backgroundToolResult'>>();
    return delivery?.backgroundToolResult ?? null;
  }

  async function getAgentBackgroundToolResultClaim(input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    taskId: string;
  }): Promise<AgentBackgroundToolResultReceipt['resultClaim'] | null> {
    const delivery = await Delivery()
      .findOne({
        ...backgroundResultIdentity(input),
        'envelope.event.payload.taskId': input.taskId,
        'backgroundToolResult.resultClaim': { $exists: true },
      })
      .select('+backgroundToolResult')
      .lean<Pick<IAgentTriggerDelivery, 'backgroundToolResult'>>();
    return delivery?.backgroundToolResult?.resultClaim ?? null;
  }

  function backgroundResultIdentity(input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    agentId?: string;
  }) {
    return {
      user: input.userId,
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      'envelope.event.source.type': 'internal',
      'envelope.event.source.id': input.sourceId,
      'envelope.target.conversationId': input.conversationId,
      'envelope.target.parentMessageId': input.parentMessageId,
      ...(input.agentId == null ? {} : { 'envelope.target.agentId': input.agentId }),
    };
  }

  function projectBackgroundResult(delivery: {
    envelope?: unknown;
    backgroundToolResult?: AgentBackgroundToolResultReceipt;
  }) {
    const envelope = delivery.envelope;
    if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return null;
    }
    const event = (envelope as { event?: unknown }).event;
    if (event == null || typeof event !== 'object' || Array.isArray(event)) {
      return null;
    }
    const payload = (event as { payload?: unknown }).payload;
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const { taskId, toolCallId, toolName } = payload as Record<string, unknown>;
    const receipt = delivery.backgroundToolResult;
    if (
      receipt == null ||
      typeof taskId !== 'string' ||
      typeof toolCallId !== 'string' ||
      typeof toolName !== 'string'
    ) {
      return null;
    }
    return {
      taskId,
      toolCallId,
      toolName,
      status: receipt.status,
      output: receipt.output,
    };
  }

  /** Elects exactly one automatic continuation for an independently persisted
   * result. A later stack layer may coalesce siblings after this ownership
   * boundary, but the durable receipt itself is never dispatched unclaimed. */
  async function claimAgentBackgroundToolResults(input: {
    deliveryKey: string;
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    agentId?: string;
    claimId: string;
    limit?: number;
  }): Promise<AgentBackgroundToolResultClaim> {
    if (
      input.deliveryKey.length === 0 ||
      input.deliveryKey.length > 256 ||
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      input.userId.length === 0 ||
      input.conversationId.length === 0 ||
      input.conversationId.length > 256 ||
      input.parentMessageId.length === 0 ||
      input.parentMessageId.length > 256 ||
      input.claimId.length === 0 ||
      input.claimId.length > 128
    ) {
      throw new TypeError('Invalid background tool result receipt claim');
    }
    const scope = backgroundResultIdentity(input);
    const projection = 'envelope +backgroundToolResult';
    let requested = await Delivery()
      .findOne({ ...scope, deliveryKey: input.deliveryKey })
      .select(projection)
      .lean<Pick<IAgentTriggerDelivery, 'envelope' | 'backgroundToolResult'>>();
    if (requested?.backgroundToolResult == null) {
      return { status: 'not_ready' };
    }
    const existingClaim = requested.backgroundToolResult.resultClaim;
    if (existingClaim != null && existingClaim.claimId !== input.claimId) {
      return { status: 'claimed', claimId: existingClaim.claimId };
    }
    if (existingClaim == null) {
      const claimed = await Delivery().updateOne(
        {
          ...scope,
          deliveryKey: input.deliveryKey,
          backgroundToolResult: { $exists: true },
          'backgroundToolResult.resultClaim': { $exists: false },
        },
        {
          $set: {
            'backgroundToolResult.resultClaim': {
              kind: 'wakeup',
              claimId: input.claimId,
              claimedAt: new Date(),
            },
          },
        },
        { timestamps: false },
      );
      if (claimed.modifiedCount !== 1) {
        requested = await Delivery()
          .findOne({ ...scope, deliveryKey: input.deliveryKey })
          .select(projection)
          .lean<Pick<IAgentTriggerDelivery, 'envelope' | 'backgroundToolResult'>>();
        const winner = requested?.backgroundToolResult?.resultClaim;
        if (winner?.claimId !== input.claimId) {
          return winner == null
            ? { status: 'not_ready' }
            : { status: 'claimed', claimId: winner.claimId };
        }
      }
    }
    const result = requested == null ? null : projectBackgroundResult(requested);
    return result == null ? { status: 'not_ready' } : { status: 'acquired', results: [result] };
  }

  async function releaseAgentBackgroundToolResultClaims(input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    claimId: string;
  }): Promise<boolean> {
    if (
      input.sourceId.length === 0 ||
      input.sourceId.length > 256 ||
      input.userId.length === 0 ||
      input.conversationId.length === 0 ||
      input.conversationId.length > 256 ||
      input.parentMessageId.length === 0 ||
      input.parentMessageId.length > 256 ||
      input.claimId.length === 0 ||
      input.claimId.length > 128
    ) {
      throw new TypeError('Invalid background tool result receipt claim release');
    }
    const scope = backgroundResultIdentity(input);
    await Delivery().updateMany(
      { ...scope, 'backgroundToolResult.resultClaim.claimId': input.claimId },
      { $unset: { 'backgroundToolResult.resultClaim': 1 } },
      { timestamps: false },
    );
    return (
      (await Delivery().exists({
        ...scope,
        'backgroundToolResult.resultClaim.claimId': input.claimId,
      })) == null
    );
  }

  async function settleAgentTriggerHandlingOutcome(
    input: SettleAgentTriggerHandlingOutcomeInput,
  ): Promise<boolean> {
    const error = input.error?.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    const terminalHandling = {
      'handling.status': input.status,
      'handling.settledAt': input.settledAt,
      expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
      ...(error != null && { 'handling.error': error }),
      ...(input.action != null && { 'handling.action': input.action }),
    };
    const terminal = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          'handling.status': 'started',
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
          actorActionAdmittedAt: { $exists: false },
        },
        {
          $set: terminalHandling,
          $unset: {
            ...(error == null && { 'handling.error': 1 }),
            ...(input.action == null && { 'handling.action': 1 }),
          },
        },
        { new: true },
      )
      .select('_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling')
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | '_id'
          | 'orderingKey'
          | 'batchMemberIds'
          | 'status'
          | 'settledAt'
          | 'awaitTerminalHandling'
          | 'handling'
        >
      >();

    let authoritative = terminal;
    if (authoritative == null) {
      const existing = await Delivery()
        .findOne({
          deliveryKey: input.deliveryKey,
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
        })
        .select('_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling')
        .lean<
          Pick<
            IAgentTriggerDelivery,
            | '_id'
            | 'orderingKey'
            | 'batchMemberIds'
            | 'status'
            | 'settledAt'
            | 'awaitTerminalHandling'
            | 'handling'
          >
        >();
      const replayed =
        existing?.handling?.status === input.status &&
        existing.handling.error === error &&
        existing.handling.action?.toolName === input.action?.toolName &&
        existing.handling.action?.toolCallId === input.action?.toolCallId;
      if (!replayed) {
        return false;
      }
      authoritative = existing;
    }

    await finalizeAgentEventActorDelivery(authoritative, input.settledAt);
    return true;
  }

  async function settleAgentEventActorReceipt(
    input: SettleAgentEventActorReceiptInput,
  ): Promise<boolean> {
    const applied =
      input.receipt.resolution === 'checkpoint_verified' ||
      input.receipt.resolution === 'history_repaired';
    if ((applied && input.status !== 'applied') || (!applied && input.status !== 'failed')) {
      recordAgentEventActorReceiptMetric({
        operation: 'settle',
        outcome: 'conflict',
        resolution: input.receipt.resolution,
      });
      return false;
    }
    if (
      input.receipt.resolution === 'checkpoint_verified' &&
      (typeof input.receipt.checkpoint.checkpointId !== 'string' ||
        input.receipt.checkpoint.checkpointId.length === 0)
    ) {
      recordAgentEventActorReceiptMetric({
        operation: 'settle',
        outcome: 'conflict',
        resolution: input.receipt.resolution,
      });
      return false;
    }
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const actorReceipt: AgentEventActorReceipt = {
      bindingId: input.bindingId,
      ...input.receipt,
      settledAt: input.settledAt,
    };
    const terminal = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          user: input.user,
          ...tenantScope,
          status: { $in: ['succeeded', 'dead'] },
          'envelope.target.bindingId': input.bindingId,
          'handling.status': 'started',
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
          actorReceipt: { $exists: false },
          ...(input.requiresActionAdmission === true
            ? { actorActionAdmittedAt: { $exists: true } }
            : { actorActionAdmittedAt: { $exists: false } }),
        },
        {
          $set: {
            status: 'succeeded',
            settledAt: input.settledAt,
            'handling.status': input.status,
            'handling.settledAt': input.settledAt,
            ...(applied && { 'handling.action': input.receipt.action }),
            ...(!applied && {
              'handling.error': (input.error ?? 'Agent event actor action was compensated').slice(
                0,
                MAX_ERROR_MESSAGE_LENGTH,
              ),
            }),
            actorReceipt,
            expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
          },
          $unset: {
            lastError: 1,
            ...(input.requiresActionAdmission === true && {
              actorActionAdmittedAt: 1,
              actorActionAdmissionId: 1,
            }),
            ...(applied && { 'handling.error': 1 }),
            ...(!applied && { 'handling.action': 1 }),
          },
        },
        { new: true },
      )
      .select(
        '_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling +actorReceipt',
      )
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | '_id'
          | 'orderingKey'
          | 'batchMemberIds'
          | 'status'
          | 'settledAt'
          | 'awaitTerminalHandling'
          | 'handling'
          | 'actorReceipt'
        >
      >();
    let authoritative = terminal;
    let replayed = false;
    if (authoritative == null) {
      authoritative = await Delivery()
        .findOneAndUpdate(
          {
            deliveryKey: input.deliveryKey,
            user: input.user,
            ...tenantScope,
            status: { $in: ['succeeded', 'dead'] },
            'envelope.target.bindingId': input.bindingId,
            'handling.conversationId': input.conversationId,
            'handling.generationCreatedAt': input.generationCreatedAt,
            'handling.status': input.status,
            actorReceipt,
          },
          {
            $set: { status: 'succeeded', settledAt: actorReceipt.settledAt },
            $max: {
              expiresAt: new Date(actorReceipt.settledAt.getTime() + SUCCESS_RETENTION_MS),
            },
            $unset: {
              lastError: 1,
              ...(input.requiresActionAdmission === true && {
                actorActionAdmittedAt: 1,
                actorActionAdmissionId: 1,
              }),
            },
          },
          { new: true },
        )
        .select(
          '_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling +actorReceipt',
        )
        .lean<
          Pick<
            IAgentTriggerDelivery,
            | '_id'
            | 'orderingKey'
            | 'batchMemberIds'
            | 'status'
            | 'settledAt'
            | 'awaitTerminalHandling'
            | 'handling'
            | 'actorReceipt'
          >
        >();
      if (authoritative == null) {
        recordAgentEventActorReceiptMetric({
          operation: 'settle',
          outcome: 'conflict',
          resolution: input.receipt.resolution,
        });
        return false;
      }
      replayed = true;
    }
    await finalizeAgentEventActorDelivery(authoritative, input.settledAt);
    recordAgentEventActorReceiptMetric({
      operation: 'settle',
      outcome: replayed ? 'replay' : 'success',
      resolution: input.receipt.resolution,
    });
    return true;
  }

  async function admitAgentEventActorAction(
    input: AdmitAgentEventActorActionInput,
  ): Promise<boolean> {
    if (Number.isNaN(input.admittedAt.getTime())) {
      throw new TypeError('admittedAt must be a valid date');
    }
    if (input.admissionId.length === 0 || input.admissionId.length > 64) {
      throw new TypeError('admissionId must contain at most 64 characters');
    }
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const admitted = await Delivery().updateOne(
      {
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        /** Loopback delivery returns `started` before the engine can persist
         * transport completion, so the child may reach action admission while
         * this exact attempt is still leased. The delivery row remains the
         * serialization point: its identity fences plus the single admission
         * marker allow only one overlapping attempt to proceed. */
        status: { $in: ['leased', 'succeeded', 'dead'] },
        'envelope.target.bindingId': input.bindingId,
        actorReceipt: { $exists: false },
        actorActionAdmittedAt: { $exists: false },
        actorActionAdmissionClosedAt: { $exists: false },
        $or: [
          { handling: { $exists: false } },
          {
            'handling.status': 'started',
            'handling.conversationId': input.conversationId,
          },
        ],
      },
      {
        $set: {
          actorActionAdmittedAt: input.admittedAt,
          actorActionAdmissionId: input.admissionId,
        },
      },
    );
    return admitted.modifiedCount === 1;
  }

  async function releaseAgentEventActorAction(
    input: AgentEventActorActionAdmissionInput,
  ): Promise<boolean> {
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const released = await Delivery().updateOne(
      {
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        $or: [
          { handling: { $exists: false } },
          { 'handling.conversationId': input.conversationId },
        ],
        actorReceipt: { $exists: false },
        actorActionAdmittedAt: { $exists: true },
        actorActionAdmissionId: input.admissionId,
      },
      { $unset: { actorActionAdmittedAt: 1, actorActionAdmissionId: 1 } },
    );
    return released.modifiedCount === 1;
  }

  async function hasAgentEventActorActionAdmission(
    input: AgentEventActorActionAdmissionInput,
  ): Promise<boolean> {
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    return (
      (await Delivery().exists({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        $or: [
          { handling: { $exists: false } },
          { 'handling.conversationId': input.conversationId },
        ],
        actorReceipt: { $exists: false },
        actorActionAdmittedAt: { $exists: true },
      })) != null
    );
  }

  /** Reads the delivery-owned action fence when the private child Conversation
   * has already been removed. The terminal owner can then release the exact
   * admission id without guessing from missing actor state. */
  async function getAgentEventActorActionAdmission(
    input: GetAgentEventActorReceiptInput,
  ): Promise<string | null> {
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const delivery = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        $or: [
          { handling: { $exists: false } },
          { 'handling.conversationId': input.conversationId },
        ],
        actorReceipt: { $exists: false },
        actorActionAdmittedAt: { $exists: true },
      })
      .select('+actorActionAdmissionId')
      .lean<Pick<IAgentTriggerDelivery, 'actorActionAdmissionId'>>();
    return typeof delivery?.actorActionAdmissionId === 'string'
      ? delivery.actorActionAdmissionId
      : null;
  }

  /** Atomically gives one replica launch authority for an exact detached expected action. */
  async function reserveAgentEventActorDetachedAction(
    input: ReserveAgentEventActorDetachedActionInput,
  ): Promise<{
    status: 'reserved' | 'replay' | 'conflict';
    action: AgentEventActorDetachedAction;
  }> {
    const requiredIdentity = [
      String(input.user),
      input.deliveryKey,
      input.bindingId,
      input.conversationId,
      String(input.generationCreatedAt),
      input.turnId,
      input.invocationId,
      input.expectedToolName,
      input.toolName,
      input.toolCallId,
    ];
    const identity = [String(input.user), input.tenantId ?? '', ...requiredIdentity.slice(1)];
    if (
      requiredIdentity.some((value) => value.length === 0) ||
      !Number.isSafeInteger(input.generationCreatedAt) ||
      input.generationCreatedAt < 0 ||
      input.turnId.length > 512 ||
      Number.isNaN(input.reservedAt.getTime()) ||
      Number.isNaN(input.recoveryAfter.getTime()) ||
      input.recoveryAfter <= input.reservedAt
    ) {
      throw new TypeError('Detached event actor action identity is invalid');
    }
    const buildAction = (launchAttempt: number): AgentEventActorDetachedAction => {
      const idempotencyKey = createHash('sha256')
        .update([...identity, String(launchAttempt)].join('\0'))
        .digest('hex');
      return {
        version: 1,
        invocationId: input.invocationId,
        expectedToolName: input.expectedToolName,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        turnId: input.turnId,
        /** Public task handles must not disclose the adapter idempotency secret. */
        taskId: `event_actor_${createHash('sha256')
          .update('librechat:event-actor:task:v1\0')
          .update(idempotencyKey)
          .digest('hex')}`,
        idempotencyKey,
        launchAttempt,
        status: 'reserved',
        reservedAt: input.reservedAt,
        observedAt: input.reservedAt,
        recoveryAfter: input.recoveryAfter,
      };
    };
    const action = buildAction(0);
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const reservationOwner = {
      $or: [
        {
          status: { $in: ['leased', 'capability_leased'] },
          handling: { $exists: false },
        },
        {
          status: { $in: ['succeeded', 'dead'] },
          'handling.status': 'started',
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
        },
      ],
    };
    const reserved = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          user: input.user,
          ...tenantScope,
          'envelope.target.bindingId': input.bindingId,
          ...reservationOwner,
          actorReceipt: { $exists: false },
          actorActionAdmittedAt: { $exists: true },
          actorDetachedAction: { $exists: false },
        },
        { $set: { actorDetachedAction: action } },
        { new: true },
      )
      .select('+actorDetachedAction')
      .lean<Pick<IAgentTriggerDelivery, 'actorDetachedAction'>>();
    if (reserved?.actorDetachedAction != null) {
      return { status: 'reserved', action: reserved.actorDetachedAction };
    }
    const existing = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        ...reservationOwner,
      })
      .select('+actorDetachedAction')
      .lean<Pick<IAgentTriggerDelivery, 'actorDetachedAction'>>();
    if (existing?.actorDetachedAction == null) {
      throw new Error('Detached event actor action reservation owner is unavailable');
    }
    const sameTurn = existing.actorDetachedAction.turnId === input.turnId;
    const sameLogicalAction =
      sameTurn &&
      existing.actorDetachedAction.invocationId === input.invocationId &&
      existing.actorDetachedAction.expectedToolName === input.expectedToolName &&
      existing.actorDetachedAction.toolName === input.toolName &&
      existing.actorDetachedAction.toolCallId === input.toolCallId;
    if (sameLogicalAction) {
      return { status: 'replay', action: existing.actorDetachedAction };
    }
    if (sameTurn) {
      return { status: 'conflict', action: existing.actorDetachedAction };
    }
    if (existing.actorDetachedAction.idempotencyKey === action.idempotencyKey) {
      return { status: 'replay', action: existing.actorDetachedAction };
    }
    if (
      !['failed', 'cancelled'].includes(existing.actorDetachedAction.status) ||
      existing.actorDetachedAction.launchAttempt >= 15
    ) {
      return { status: 'conflict', action: existing.actorDetachedAction };
    }
    const retryAction = buildAction(existing.actorDetachedAction.launchAttempt + 1);
    const retried = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          user: input.user,
          ...tenantScope,
          'envelope.target.bindingId': input.bindingId,
          ...reservationOwner,
          actorReceipt: { $exists: false },
          actorActionAdmittedAt: { $exists: true },
          'actorDetachedAction.taskId': existing.actorDetachedAction.taskId,
          'actorDetachedAction.idempotencyKey': existing.actorDetachedAction.idempotencyKey,
          'actorDetachedAction.status': existing.actorDetachedAction.status,
        },
        {
          $set: { actorDetachedAction: retryAction },
          $push: {
            actorDetachedActionHistory: {
              $each: [existing.actorDetachedAction],
              $slice: -8,
            },
          },
        },
        { new: true },
      )
      .select('+actorDetachedAction')
      .lean<Pick<IAgentTriggerDelivery, 'actorDetachedAction'>>();
    if (retried?.actorDetachedAction != null) {
      return { status: 'reserved', action: retried.actorDetachedAction };
    }
    const winner = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        ...reservationOwner,
      })
      .select('+actorDetachedAction')
      .lean<Pick<IAgentTriggerDelivery, 'actorDetachedAction'>>();
    if (winner?.actorDetachedAction == null) {
      throw new Error('Detached event actor retry reservation owner is unavailable');
    }
    return {
      status:
        winner.actorDetachedAction.idempotencyKey === retryAction.idempotencyKey
          ? 'replay'
          : 'conflict',
      action: winner.actorDetachedAction,
    };
  }

  function detachedActionScope(input: UpdateAgentEventActorDetachedActionInput) {
    return {
      deliveryKey: input.deliveryKey,
      user: input.user,
      ...(input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId }),
      'envelope.target.bindingId': input.bindingId,
      actorReceipt: { $exists: false },
      actorActionAdmittedAt: { $exists: true },
      'actorDetachedAction.taskId': input.taskId,
      'actorDetachedAction.idempotencyKey': input.idempotencyKey,
    };
  }

  /** Acknowledges launch without regressing terminal evidence from a fast completion. */
  async function markAgentEventActorDetachedActionRunning(
    input: MarkAgentEventActorDetachedActionRunningInput,
  ): Promise<AgentEventActorDetachedTransitionResult> {
    if (
      Number.isNaN(input.observedAt.getTime()) ||
      Number.isNaN(input.recoveryAfter.getTime()) ||
      input.recoveryAfter <= input.observedAt
    ) {
      throw new TypeError('Detached event actor running lease is invalid');
    }
    const scope = detachedActionScope(input);
    const running = await Delivery().updateOne(
      { ...scope, 'actorDetachedAction.status': 'reserved' },
      {
        $set: {
          'actorDetachedAction.status': 'running',
          'actorDetachedAction.launchedAt': input.observedAt,
          'actorDetachedAction.observedAt': input.observedAt,
          'actorDetachedAction.recoveryAfter': input.recoveryAfter,
        },
      },
    );
    if (running.modifiedCount === 1) {
      return { status: 'applied' };
    }
    const alreadyApplied =
      (await Delivery().exists({
        ...scope,
        'actorDetachedAction.status': {
          $in: ['running', 'succeeded', 'failed', 'cancelled'],
        },
      })) != null;
    return { status: alreadyApplied ? 'already_applied' : 'conflict' };
  }

  /** Converts an expired executor lease into durable uncertainty. This state
   * deliberately cannot be retried; only exact terminal proof may close it. */
  async function markAgentEventActorDetachedActionLaunchIndeterminate(
    input: UpdateAgentEventActorDetachedActionInput,
  ): Promise<AgentEventActorDetachedTransitionResult> {
    if (Number.isNaN(input.observedAt.getTime())) {
      throw new TypeError('observedAt must be a valid date');
    }
    const scope = detachedActionScope(input);
    const marked = await Delivery().updateOne(
      {
        ...scope,
        'actorDetachedAction.status': { $in: ['reserved', 'running'] },
        'actorDetachedAction.recoveryAfter': { $lte: input.observedAt },
      },
      {
        $set: {
          'actorDetachedAction.status': 'launch_indeterminate',
          'actorDetachedAction.observedAt': input.observedAt,
        },
      },
    );
    if (marked.modifiedCount === 1) {
      return { status: 'applied' };
    }
    const alreadyApplied =
      (await Delivery().exists({
        ...scope,
        'actorDetachedAction.status': 'launch_indeterminate',
      })) != null;
    return { status: alreadyApplied ? 'already_applied' : 'conflict' };
  }

  /** Persists exact terminal evidence once; identical callbacks replay safely. */
  async function settleAgentEventActorDetachedAction(
    input: SettleAgentEventActorDetachedActionInput,
  ): Promise<AgentEventActorDetachedTransitionResult> {
    if (
      Number.isNaN(input.observedAt.getTime()) ||
      (input.result != null && input.result.length > 32_768) ||
      (input.error != null && input.error.length > 2_048)
    ) {
      throw new TypeError('Detached event actor terminal evidence is invalid');
    }
    if (input.status === 'succeeded' ? input.error != null : input.result != null) {
      throw new TypeError('Detached event actor terminal evidence conflicts with its status');
    }
    const terminal = {
      'actorDetachedAction.status': input.status,
      'actorDetachedAction.settledAt': input.observedAt,
      'actorDetachedAction.observedAt': input.observedAt,
      ...(input.result == null ? {} : { 'actorDetachedAction.result': input.result }),
      ...(input.error == null ? {} : { 'actorDetachedAction.error': input.error }),
    };
    const scope = detachedActionScope(input);
    const settled = await Delivery().updateOne(
      {
        ...scope,
        'actorDetachedAction.status': {
          $in: ['reserved', 'running', 'launch_indeterminate'],
        },
      },
      { $set: terminal },
    );
    if (settled.modifiedCount === 1) {
      return { status: 'applied' };
    }
    /** Callback observation time is transport metadata, not terminal identity.
     * A retry may arrive later; match the exact durable outcome while retaining
     * the first settlement timestamp. */
    const alreadyApplied =
      (await Delivery().exists({
        ...scope,
        'actorDetachedAction.status': input.status,
        'actorDetachedAction.result': input.result == null ? { $exists: false } : input.result,
        'actorDetachedAction.error': input.error == null ? { $exists: false } : input.error,
      })) != null;
    return { status: alreadyApplied ? 'already_applied' : 'conflict' };
  }

  async function getAgentEventActorDetachedAction(
    input: GetAgentEventActorReceiptInput & { generationCreatedAt: number },
  ): Promise<AgentEventActorDetachedAction | null> {
    const delivery = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...(input.tenantId == null
          ? { tenantId: { $exists: false } }
          : { tenantId: input.tenantId }),
        'envelope.target.bindingId': input.bindingId,
        actorDetachedAction: { $exists: true },
      })
      .select('+actorDetachedAction')
      .lean<Pick<IAgentTriggerDelivery, 'actorDetachedAction'>>();
    return delivery?.actorDetachedAction ?? null;
  }

  async function getAgentEventActorReceipt(
    input: GetAgentEventActorReceiptInput,
  ): Promise<AgentEventActorReceipt | null> {
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const delivery = await Delivery()
      .findOne({
        deliveryKey: input.deliveryKey,
        user: input.user,
        ...tenantScope,
        'envelope.target.bindingId': input.bindingId,
        'handling.conversationId': input.conversationId,
        actorReceipt: { $exists: true },
      })
      .select('+actorReceipt')
      .lean<Pick<IAgentTriggerDelivery, 'actorReceipt'>>();
    recordAgentEventActorReceiptMetric({
      operation: 'read',
      outcome: delivery?.actorReceipt == null ? 'miss' : 'hit',
      ...(delivery?.actorReceipt?.resolution == null
        ? {}
        : { resolution: delivery.actorReceipt.resolution }),
    });
    return delivery?.actorReceipt ?? null;
  }

  /** Lazily moves one pre-ledger conversation receipt onto its already-terminal
   * delivery. The public outcome must already agree, so migration can never
   * rewrite history or manufacture a second winner. */
  async function backfillAgentEventActorReceipt(
    input: BackfillAgentEventActorReceiptInput,
  ): Promise<boolean> {
    const applied =
      input.receipt.resolution === 'checkpoint_verified' ||
      input.receipt.resolution === 'history_repaired';
    if ((applied && input.status !== 'applied') || (!applied && input.status !== 'failed')) {
      recordAgentEventActorReceiptMetric({
        operation: 'backfill',
        outcome: 'conflict',
        resolution: input.receipt.resolution,
      });
      return false;
    }
    if (
      input.receipt.resolution === 'checkpoint_verified' &&
      (typeof input.receipt.checkpoint.checkpointId !== 'string' ||
        input.receipt.checkpoint.checkpointId.length === 0)
    ) {
      recordAgentEventActorReceiptMetric({
        operation: 'backfill',
        outcome: 'conflict',
        resolution: input.receipt.resolution,
      });
      return false;
    }
    const tenantScope =
      input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId };
    const actorReceipt: AgentEventActorReceipt = {
      bindingId: input.bindingId,
      ...input.receipt,
      settledAt: input.settledAt,
    };
    const migrated = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          user: input.user,
          ...tenantScope,
          status: { $in: ['succeeded', 'dead'] },
          'envelope.target.bindingId': input.bindingId,
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
          'handling.status': input.status,
          ...(applied && { 'handling.action': input.receipt.action }),
          actorReceipt: { $exists: false },
        },
        {
          $set: {
            status: 'succeeded',
            settledAt: input.settledAt,
            actorReceipt,
          },
          $max: {
            expiresAt: new Date(input.settledAt.getTime() + SUCCESS_RETENTION_MS),
          },
          $unset: { lastError: 1 },
        },
        { new: true },
      )
      .select(
        '_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling +actorReceipt',
      )
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | '_id'
          | 'orderingKey'
          | 'batchMemberIds'
          | 'status'
          | 'settledAt'
          | 'awaitTerminalHandling'
          | 'handling'
          | 'actorReceipt'
        >
      >();
    if (migrated != null) {
      await finalizeAgentEventActorDelivery(migrated, input.settledAt);
      recordAgentEventActorReceiptMetric({
        operation: 'backfill',
        outcome: 'success',
        resolution: input.receipt.resolution,
      });
      return true;
    }
    const replayed = await Delivery()
      .findOneAndUpdate(
        {
          deliveryKey: input.deliveryKey,
          user: input.user,
          ...tenantScope,
          status: { $in: ['succeeded', 'dead'] },
          'envelope.target.bindingId': input.bindingId,
          'handling.conversationId': input.conversationId,
          'handling.generationCreatedAt': input.generationCreatedAt,
          'handling.status': input.status,
          actorReceipt,
        },
        {
          $set: { status: 'succeeded', settledAt: actorReceipt.settledAt },
          $max: {
            expiresAt: new Date(actorReceipt.settledAt.getTime() + SUCCESS_RETENTION_MS),
          },
          $unset: { lastError: 1 },
        },
        { new: true },
      )
      .select('_id orderingKey batchMemberIds status settledAt awaitTerminalHandling handling')
      .lean<
        Pick<
          IAgentTriggerDelivery,
          | '_id'
          | 'orderingKey'
          | 'batchMemberIds'
          | 'status'
          | 'settledAt'
          | 'awaitTerminalHandling'
          | 'handling'
        >
      >();
    if (replayed != null) {
      await finalizeAgentEventActorDelivery(replayed, actorReceipt.settledAt);
    }
    recordAgentEventActorReceiptMetric({
      operation: 'backfill',
      outcome: replayed != null ? 'replay' : 'conflict',
      resolution: input.receipt.resolution,
    });
    return replayed != null;
  }

  async function getAgentEventActorReceiptStorageMetrics(
    now: Date,
  ): Promise<AgentEventActorReceiptStorageMetrics> {
    const [byResolution, expiryEligible, retryDeliveries, deadDeliveries] = await Promise.all([
      Delivery().aggregate<{
        _id: AgentEventActorReceipt['resolution'];
        count: number;
      }>([
        { $match: { actorReceipt: { $exists: true } } },
        { $group: { _id: '$actorReceipt.resolution', count: { $sum: 1 } } },
      ]),
      Delivery().countDocuments({
        actorReceipt: { $exists: true },
        expiresAt: { $lte: now },
      }),
      Delivery().countDocuments({
        $or: [
          { status: { $in: ['pending', 'capability_pending'] } },
          { status: 'leased', capabilityStatus: 'pending' },
        ],
        attempts: { $gt: 0 },
        'envelope.target.bindingId': { $exists: true },
        'handling.status': 'started',
        actorReceipt: { $exists: false },
      }),
      Delivery().countDocuments({
        $or: [
          { status: { $in: ['dead', 'capability_dead'] } },
          { status: 'leased', capabilityStatus: 'dead' },
        ],
        'envelope.target.bindingId': { $exists: true },
        'handling.status': 'started',
        actorReceipt: { $exists: false },
      }),
    ]);
    const retainedByResolution: AgentEventActorReceiptStorageMetrics['retainedByResolution'] = {
      checkpoint_verified: 0,
      action_compensated: 0,
      history_repaired: 0,
    };
    for (const row of byResolution) {
      if (row._id in retainedByResolution) {
        retainedByResolution[row._id] = row.count;
      }
    }
    return {
      retainedByResolution,
      expiryEligible,
      retryDeliveries,
      deadDeliveries,
    };
  }

  async function retryAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      availableAt: Date;
    },
  ): Promise<boolean> {
    return retryDelivery(input);
  }

  async function retryDelivery(
    input: Parameters<AgentTriggerDeliveryMethods['retryAgentTriggerDelivery']>[0],
    recoverReceipt = false,
  ): Promise<boolean> {
    const error = normalizeFailure(input.error);
    const receiptFence = recoverReceipt
      ? {
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          backgroundToolResult: { $exists: true },
        }
      : {};
    const recoveredAttempt = recoverReceipt ? { attempts: 0 } : {};
    const retryUpdate = (status: 'pending' | 'capability_pending') => ({
      $set: {
        ...recoveredAttempt,
        status,
        availableAt: input.availableAt,
        claimAvailableAt: input.availableAt,
        lastError: error,
      },
      $unset: {
        leaseBy: 1,
        leaseUntil: 1,
        claimToken: 1,
        settledAt: 1,
        expiresAt: 1,
      },
      $push: {
        history: {
          $each: [
            {
              attempt: input.attempt,
              outcome: 'retry',
              at: error.attemptedAt,
              workerId: input.workerId,
              error,
            },
          ],
          $slice: -HISTORY_LIMIT,
        },
      },
    });
    const shieldResult = await Delivery().updateOne(
      { _id: input.id, ...shieldCapabilityFence(input), ...receiptFence },
      {
        $set: {
          ...recoveredAttempt,
          status: 'leased',
          availableAt: input.availableAt,
          capabilityStatus: 'pending',
          claimAvailableAt: input.availableAt,
          lastError: error,
        },
        $unset: {
          leaseBy: 1,
          leaseUntil: 1,
          claimToken: 1,
          capabilityLeaseBy: 1,
          capabilityLeaseUntil: 1,
          capabilityClaimToken: 1,
          settledAt: 1,
          expiresAt: 1,
        },
        $push: retryUpdate('pending').$push,
      },
    );
    if (shieldResult.modifiedCount === 1) {
      return true;
    }
    const capabilityResult = await Delivery().updateOne(
      { _id: input.id, ...legacyCapabilityFence(input), ...receiptFence },
      retryUpdate('capability_pending'),
    );
    if (capabilityResult.modifiedCount === 1) {
      return true;
    }
    const result = await Delivery().updateOne(
      { _id: input.id, ...ordinaryFence(input), ...receiptFence },
      retryUpdate('pending'),
    );
    return result.modifiedCount === 1;
  }

  async function deadLetterAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      settledAt: Date;
      receiptRetryAt?: Date;
    },
    recovery?: { required: boolean },
  ): Promise<boolean> {
    const error = normalizeFailure(input.error);
    if (
      error.retryable &&
      input.receiptRetryAt != null &&
      (await retryDelivery({ ...input, availableAt: input.receiptRetryAt }, true))
    ) {
      return false;
    }
    /** Publication must contend with every retryable terminal transition,
     * including a receipt committed between recovery and the dead-letter CAS. */
    const receiptFence =
      error.retryable || error.code === 'BACKGROUND_TOOL_PRODUCER_LOST'
        ? { backgroundToolResult: { $exists: false } }
        : {};
    const deadUpdate = (status: 'dead' | 'capability_dead') => ({
      $set: { status, settledAt: input.settledAt, lastError: error },
      $unset: { leaseBy: 1, leaseUntil: 1, claimToken: 1, expiresAt: 1 },
      $push: {
        history: {
          $each: [
            {
              attempt: input.attempt,
              outcome: 'dead' as const,
              at: input.settledAt,
              workerId: input.workerId,
              error,
            },
          ],
          $slice: -HISTORY_LIMIT,
        },
      },
    });
    const shieldDead = await Delivery().updateOne(
      { _id: input.id, ...shieldCapabilityFence(input), ...receiptFence },
      {
        $set: {
          // The pre-capability runtime already treats `capability_dead` as a
          // terminal, requeueable state, so it cannot block a lane successor.
          status: 'capability_dead',
          availableAt: LEGACY_CAPABILITY_SHIELD_AT,
          capabilityStatus: 'dead',
          settledAt: input.settledAt,
          lastError: error,
        },
        $unset: {
          leaseBy: 1,
          leaseUntil: 1,
          claimToken: 1,
          capabilityLeaseBy: 1,
          capabilityLeaseUntil: 1,
          capabilityClaimToken: 1,
          expiresAt: 1,
        },
        $push: deadUpdate('dead').$push,
      },
    );
    if (shieldDead.modifiedCount === 1) {
      return true;
    }
    const capabilityDead = await Delivery().updateOne(
      { _id: input.id, ...legacyCapabilityFence(input), ...receiptFence },
      deadUpdate('capability_dead'),
    );
    if (capabilityDead.modifiedCount === 1) {
      return true;
    }
    const dead = await Delivery()
      .findOneAndUpdate(
        { _id: input.id, ...ordinaryFence(input), ...receiptFence },
        deadUpdate('dead'),
        {
          new: true,
        },
      )
      .select('_id orderingKey batchMemberIds batchMembersSettledAt requeueCount')
      .lean<
        Pick<
          IAgentTriggerDelivery,
          '_id' | 'orderingKey' | 'batchMemberIds' | 'batchMembersSettledAt' | 'requeueCount'
        >
      >();
    if (dead?._id == null) {
      return false;
    }
    try {
      await settleBatchMembers(dead, {
        attempt: input.attempt,
        workerId: input.workerId,
        status: 'dead',
        settledAt: input.settledAt,
        error,
      });
    } catch (settlementError) {
      if (recovery != null) recovery.required = true;
      logger.warn('[agent-triggers] failed to settle batch dead-letter receipts', {
        deliveryId: String(dead._id),
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
      });
    }
    return true;
  }

  async function getAgentTriggerDelivery(
    deliveryKey: string,
  ): Promise<AgentTriggerDeliveryRecord | null> {
    const delivery = await Delivery()
      .findOne({ deliveryKey })
      .select('+actorReceipt')
      .lean<IAgentTriggerDelivery>();
    return delivery == null ? null : toRecord(delivery);
  }

  async function getAgentTriggerDeliveryStatus(
    deliveryKey: string,
    user: string | Types.ObjectId,
    sourceKeyId: string,
    tenantId?: string,
  ): Promise<AgentTriggerDeliveryStatusRecord | null> {
    const tenantScope =
      tenantId == null ? { tenantId: null } : { $or: [{ tenantId: null }, { tenantId }] };
    let delivery = await Delivery()
      .findOne({
        deliveryKey,
        user,
        'envelope.event.source.id': sourceKeyId,
        'envelope.event.source.type': 'remote_api_key',
        ...tenantScope,
      })
      .select(
        '-_id deliveryKey status attempts availableAt createdAt settledAt result lastError handling',
      )
      .lean<AgentTriggerDeliveryStatusRecord>();
    if (delivery != null && delivery.status === 'batched') {
      const member = await Delivery()
        .findOne({ deliveryKey, user, ...tenantScope })
        .select('batchRootId')
        .lean<Pick<IAgentTriggerDelivery, 'batchRootId'>>();
      if (member?.batchRootId == null) {
        return null;
      }
      const root = await Delivery()
        .findOne({
          _id: member.batchRootId,
          user,
          'envelope.event.source.id': sourceKeyId,
          'envelope.event.source.type': 'remote_api_key',
          ...tenantScope,
        })
        .select('-_id status attempts availableAt settledAt result lastError handling')
        .lean<
          Pick<
            AgentTriggerDeliveryStatusRecord,
            | 'status'
            | 'attempts'
            | 'availableAt'
            | 'settledAt'
            | 'result'
            | 'lastError'
            | 'handling'
          >
        >();
      if (root == null) {
        return null;
      }
      delivery = { ...delivery, ...root, deliveryKey };
    }
    return delivery;
  }

  async function getAgentTriggerDeadLetters(limit = 50): Promise<AgentTriggerDeliveryRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Agent trigger dead-letter limit must be a positive integer');
    }
    const boundedLimit = Math.min(limit, MAX_DEAD_LETTER_LIMIT);
    const deliveries = await Delivery()
      .find({
        $or: [
          { status: { $in: ['dead', 'capability_dead'] } },
          { status: { $ne: 'succeeded' }, capabilityStatus: 'dead' },
        ],
        batchRootId: { $exists: false },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(boundedLimit)
      .lean<IAgentTriggerDelivery[]>();
    return deliveries.map(toRecord);
  }

  async function requeueAgentTriggerDelivery(
    id: string,
    availableAt: Date,
  ): Promise<AgentTriggerDeliveryRecord | null> {
    const candidate = await Delivery()
      .findOne({
        _id: id,
        $or: [
          { status: { $in: ['dead', 'capability_dead'] } },
          {
            status: { $in: ['pending', 'leased'] },
            requiredWorkerCapability: { $exists: true },
            capabilityStatus: 'dead',
          },
        ],
        batchRootId: { $exists: false },
        actorReceipt: { $exists: false },
        actorActionAdmittedAt: { $exists: false },
        handling: { $exists: false },
      })
      .lean<IAgentTriggerDelivery>();
    if (candidate?._id == null) {
      return null;
    }
    const previousRequeueCount = candidate.requeueCount ?? 0;
    const shieldedCapability = candidate.capabilityStatus === 'dead';
    const stagedStatus: IAgentTriggerDelivery['status'] =
      candidate.requiredWorkerCapability == null || shieldedCapability
        ? 'staging'
        : 'capability_staging';
    /** Claim the root before touching members. A terminal receipt and requeue
     * now serialize on this CAS; staging recovery finishes member preparation
     * if the process exits before publication. */
    const staged = await Delivery()
      .findOneAndUpdate(
        {
          _id: candidate._id,
          status: candidate.status,
          ...(shieldedCapability && { capabilityStatus: 'dead' }),
          batchRootId: { $exists: false },
          actorReceipt: { $exists: false },
          actorActionAdmittedAt: { $exists: false },
          handling: { $exists: false },
          requeueCount: previousRequeueCount,
        },
        {
          $set: {
            status: stagedStatus,
            laneSequence: 0,
            attempts: 0,
            availableAt,
            claimAvailableAt: availableAt,
            ...(shieldedCapability && {
              capabilityStatus: 'publishing',
              availableAt: LEGACY_CAPABILITY_SHIELD_AT,
            }),
            stagingRecoveryAt: new Date(),
          },
          $unset: {
            leaseBy: 1,
            leaseUntil: 1,
            claimToken: 1,
            capabilityLeaseBy: 1,
            capabilityLeaseUntil: 1,
            capabilityClaimToken: 1,
            lastError: 1,
            result: 1,
            settledAt: 1,
            expiresAt: 1,
            laneCleanupPendingAt: 1,
            batchMembersSettledAt: 1,
            handling: 1,
          },
          $inc: { requeueCount: 1 },
        },
        { new: true },
      )
      .lean<IAgentTriggerDelivery>();
    if (staged == null) {
      return null;
    }

    // Requeue is a new lane admission. Publication first idempotently prepares
    // its members, then allocates a new sequence on the original lane.
    return toRecord(await publishStagedDelivery(staged));
  }

  async function countActiveAgentTriggerDeliveriesByUser(
    user: string | Types.ObjectId,
    now: Date,
  ): Promise<number> {
    return Delivery().countDocuments({
      user,
      $or: [
        {
          actorActionAdmittedAt: { $exists: true },
          actorReceipt: { $exists: false },
        },
        {
          $or: [
            {
              status: 'leased',
              requiredWorkerCapability: { $exists: false },
              leaseUntil: { $gt: now },
            },
            {
              status: 'capability_leased',
              leaseUntil: { $gt: now },
            },
            {
              status: 'leased',
              capabilityStatus: 'leased',
            },
          ],
        },
        {
          'actorDetachedAction.status': {
            $in: ['reserved', 'running', 'launch_indeterminate'],
          },
        },
      ],
    });
  }

  function requireValidFence(fenceStartedAt: Date): void {
    if (!(fenceStartedAt instanceof Date) || !Number.isFinite(fenceStartedAt.getTime())) {
      throw new TypeError('fenceStartedAt must be a valid Date');
    }
  }

  /** Arms independently retryable cleanup before the user deletion can commit. */
  async function prepareAgentTriggerUserPurge(
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
    tenantId?: string,
  ): Promise<void> {
    requireValidFence(fenceStartedAt);
    const ownsFence = await mongoose.models.User.exists({
      _id: user,
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    if (ownsFence == null) {
      throw new Error('Cannot prepare trigger purge without owning the user deletion fence');
    }
    await UserPurge().updateOne(
      { _id: user },
      {
        $set: {
          fenceStartedAt,
          ...(tenantId != null && { tenantId }),
        },
      },
      { upsert: true },
    );
    await Delivery().updateMany(
      { user },
      { $set: { actorActionAdmissionClosedAt: fenceStartedAt } },
    );
  }

  /** Disarms only the pre-commit deletion attempt that owns this marker. */
  async function cancelAgentTriggerUserPurge(
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
  ): Promise<boolean> {
    requireValidFence(fenceStartedAt);
    const ownsLiveFence = await mongoose.models.User.exists({
      _id: user,
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    if (ownsLiveFence == null) {
      return false;
    }
    await Delivery().updateMany(
      { user, actorActionAdmissionClosedAt: fenceStartedAt },
      { $unset: { actorActionAdmissionClosedAt: 1 } },
    );
    await UserPurge().deleteOne({ _id: user, fenceStartedAt });
    return true;
  }

  /** Recovers cleanup markers whose users are gone; active-user markers are never destructive. */
  async function recoverAgentTriggerUserPurges(
    limit = DEFAULT_PURGE_RECOVERY_LIMIT,
    activity?: { found: boolean },
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Agent trigger purge recovery limit must be a positive integer');
    }
    const pending = await Delivery()
      .find({
        backgroundToolResultDeletionPendingAt: { $exists: true },
      })
      .select('user envelope')
      .sort({ backgroundToolResultDeletionPendingAt: 1, _id: 1 })
      .limit(Math.min(limit, MAX_PURGE_RECOVERY_LIMIT))
      .lean<IAgentTriggerDelivery[]>();
    if (activity != null && pending.length > 0) activity.found = true;
    for (const row of pending) {
      const conversationId = (row.envelope as { target?: { conversationId?: string } }).target
        ?.conversationId;
      if (conversationId == null) {
        continue;
      }
      const exists = await mongoose.models.Conversation.exists({ user: row.user, conversationId });
      if (exists == null) {
        await eraseAgentTriggerDeliveryConversationResults(row.user, [conversationId]);
      } else {
        await Delivery().updateOne(
          { _id: row._id, backgroundToolResultDeletionPendingAt: { $exists: true } },
          { $currentDate: { backgroundToolResultDeletionPendingAt: true } },
          { timestamps: false },
        );
      }
    }
    const markers = await UserPurge()
      .find({})
      .sort({ updatedAt: 1, _id: 1 })
      .limit(Math.min(limit, MAX_PURGE_RECOVERY_LIMIT))
      .lean<IAgentTriggerUserPurge[]>();
    if (activity != null && markers.length > 0) activity.found = true;
    let recovered = 0;
    for (const marker of markers) {
      const user = await mongoose.models.User.findById(marker._id)
        .select('agentTriggerDeletionStartedAt')
        .lean<{ agentTriggerDeletionStartedAt?: Date }>();
      if (user != null) {
        if (user.agentTriggerDeletionStartedAt?.getTime() === marker.fenceStartedAt.getTime()) {
          // Move a still-owned pre-commit marker behind this bounded scan so
          // it cannot starve later markers whose users are already gone.
          await UserPurge().updateOne(
            { _id: marker._id, fenceStartedAt: marker.fenceStartedAt },
            { $currentDate: { updatedAt: true } },
          );
          continue;
        }
        await Delivery().updateMany(
          {
            user: marker._id,
            actorActionAdmissionClosedAt: marker.fenceStartedAt,
          },
          { $unset: { actorActionAdmissionClosedAt: 1 } },
        );
        await UserPurge().deleteOne({
          _id: marker._id,
          fenceStartedAt: marker.fenceStartedAt,
        });
        continue;
      }
      await deps.purgeQueuedTurnsForUser?.(marker._id);
      await Promise.all([
        Delivery().deleteMany({ user: marker._id }),
        LaneSequence().deleteMany({ user: marker._id }),
      ]);
      const result = await UserPurge().deleteOne({
        _id: marker._id,
        fenceStartedAt: marker.fenceStartedAt,
      });
      recovered += result.deletedCount;
    }
    return recovered;
  }

  async function deleteAgentTriggerDeliveriesByUser(user: string | Types.ObjectId): Promise<void> {
    await deps.purgeQueuedTurnsForUser?.(user);
    await Promise.all([Delivery().deleteMany({ user }), LaneSequence().deleteMany({ user })]);
    await UserPurge().deleteOne({ _id: user });
  }

  async function eraseAgentTriggerDeliveryConversationResults(
    user: string | Types.ObjectId,
    conversationIds: string[],
  ): Promise<void> {
    if (conversationIds.length === 0 || !mongoose.isObjectIdOrHexString(user)) {
      return;
    }
    const erasedAt = new Date();
    await Delivery().updateMany(
      {
        user,
        'envelope.target.conversationId': { $in: conversationIds },
      },
      {
        $set: { backgroundToolResultErasedAt: erasedAt },
        $unset: { backgroundToolResult: 1, backgroundToolResultDeletionPendingAt: 1 },
      },
      { timestamps: false },
    );
  }

  async function prepareAgentTriggerConversationResultErasure(
    user: string | Types.ObjectId,
    conversationIds: string[],
  ): Promise<void> {
    if (conversationIds.length === 0 || !mongoose.isObjectIdOrHexString(user)) return;
    await Delivery().updateMany(
      {
        user,
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
        'envelope.target.conversationId': { $in: conversationIds },
        backgroundToolResultErasedAt: { $exists: false },
      },
      { $set: { backgroundToolResultDeletionPendingAt: new Date() } },
      { timestamps: false },
    );
  }

  return {
    ensureAgentTriggerDeliveryIndexes,
    enqueueAgentTriggerDelivery,
    claimNextAgentTriggerDelivery,
    findEarlierAgentTriggerDelivery,
    getAgentTriggerDeliveryBatch,
    releaseAgentTriggerDelivery,
    beginAgentTriggerDeliveryAttempt,
    deferAgentTriggerDeliveryAttempt,
    completeAgentTriggerDelivery,
    retireAgentTriggerDelivery,
    renewAgentTriggerDeliveryProducerLease,
    getAgentTriggerDeliveryProducerLease,
    listPendingAgentBackgroundToolCompletions,
    listUndeliveredAgentTriggerTaskIds,
    expediteAgentTriggerDeliveries,
    persistAgentBackgroundToolResult,
    getAgentBackgroundToolResult,
    getAgentBackgroundToolResultClaim,
    claimAgentBackgroundToolResults,
    releaseAgentBackgroundToolResultClaims,
    settleAgentTriggerHandlingOutcome,
    admitAgentEventActorAction,
    releaseAgentEventActorAction,
    getAgentEventActorActionAdmission,
    hasAgentEventActorActionAdmission,
    reserveAgentEventActorDetachedAction,
    markAgentEventActorDetachedActionRunning,
    markAgentEventActorDetachedActionLaunchIndeterminate,
    settleAgentEventActorDetachedAction,
    getAgentEventActorDetachedAction,
    settleAgentEventActorReceipt,
    getAgentEventActorReceipt,
    backfillAgentEventActorReceipt,
    getAgentEventActorReceiptStorageMetrics,
    retryAgentTriggerDelivery,
    deadLetterAgentTriggerDelivery,
    getAgentTriggerDelivery,
    getAgentTriggerDeliveryStatus,
    getAgentTriggerDeadLetters,
    requeueAgentTriggerDelivery,
    countActiveAgentTriggerDeliveriesByUser,
    recoverAgentTriggerLanePublications,
    recoverAgentTriggerBatchReceipts,
    reclaimInactiveAgentTriggerLanes,
    prepareAgentTriggerUserPurge,
    cancelAgentTriggerUserPurge,
    recoverAgentTriggerUserPurges,
    deleteAgentTriggerDeliveriesByUser,
    eraseAgentTriggerDeliveryConversationResults,
    prepareAgentTriggerConversationResultErasure,
  };
}
