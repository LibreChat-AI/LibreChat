import type { Document, Types } from 'mongoose';
import type { IAgentEventActorReconciliation } from './convo';

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
export const AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1 = 'event_actor_detached_action_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1 =
  'background_tool_completion_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2 =
  'background_tool_completion_receipt_v2';
export const AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1 = 'agent_queued_turn_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2 = 'agent_queued_turn_v2';
export const AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS: number = 64 * 1024;
export type AgentTriggerDeliveryOutcome = 'succeeded' | 'retry' | 'dead';

export interface AgentTriggerHandlingState {
  status: 'started' | 'applied' | 'completed_no_action' | 'failed' | 'cancelled';
  conversationId: string;
  streamId: string;
  generationCreatedAt: number;
  startedAt: Date;
  settledAt?: Date;
  error?: string;
  action?: {
    toolName: string;
    toolCallId?: string;
  };
}

/** Private terminal proof for one delivery-owned event-actor invocation. */
export interface AgentEventActorReceipt {
  bindingId: string;
  resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  checkpoint: IAgentEventActorReconciliation['checkpoint'];
  action: {
    toolName: string;
    toolCallId?: string;
  };
  settledAt: Date;
}

/** Private launch authority for one delivery-owned detached expected action. */
export interface AgentEventActorDetachedAction {
  version: 1;
  invocationId: string;
  expectedToolName: string;
  toolName: string;
  toolCallId: string;
  /** Stable graph-turn identity, independent of retry allocation. */
  turnId: string;
  taskId: string;
  idempotencyKey: string;
  launchAttempt: number;
  status: 'reserved' | 'running' | 'launch_indeterminate' | 'succeeded' | 'failed' | 'cancelled';
  reservedAt: Date;
  observedAt: Date;
  /** A recovery fence, not relaunch authority. Expiry only permits the exact
   * launch to be marked indeterminate while late terminal proof remains valid. */
  recoveryAfter: Date;
  launchedAt?: Date;
  settledAt?: Date;
  result?: string;
  error?: string;
}

export interface AgentTriggerDeliveryFailure {
  code: string;
  message: string;
  certainty: 'definite' | 'ambiguous';
  retryable: boolean;
  attemptedAt: Date;
  status?: number;
}

/** Private terminal result produced before a background-completion delivery is
 * resolved. It is independent of the parent message projection because a fast
 * task can settle before that response row exists. */
export interface AgentBackgroundToolResultReceipt {
  status: 'completed' | 'error' | 'cancelled';
  output: string;
  settledAt: Date;
  resultClaim?: {
    kind: 'wakeup';
    claimId: string;
    claimedAt: Date;
  };
}

export interface AgentTriggerDeliveryHistoryEntry {
  attempt: number;
  outcome: AgentTriggerDeliveryOutcome;
  at: Date;
  workerId: string;
  error?: AgentTriggerDeliveryFailure;
}

export interface IAgentTriggerDelivery {
  _id?: Types.ObjectId;
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  /** Monotonic sequence allocated while holding the lane publication fence. */
  laneSequence: number;
  envelope: unknown;
  user: Types.ObjectId;
  tenantId?: string;
  status: AgentTriggerDeliveryStatus;
  /** Keeps a delivery invisible to pre-capability workers during rolling deploys. */
  requiredWorkerCapability?: string;
  /** Private lifecycle for capability-owned work. The outer delivery status
   * remains a legacy-known, nonclaimable compatibility shield. */
  capabilityStatus?: 'publishing' | 'pending' | 'leased' | 'dead';
  /** Canonical claim ordering timestamp. Old rows omit it and sort first. */
  claimAvailableAt?: Date;
  capabilityLeaseBy?: string;
  capabilityLeaseUntil?: Date;
  capabilityClaimToken?: string;
  /** Durable liveness evidence for process-owned capability work. */
  producerLeaseUntil?: Date;
  /** Durable source of truth for a background completion. */
  backgroundToolResult?: AgentBackgroundToolResultReceipt;
  /** Conversation-deletion fence preventing a late producer from restoring private output. */
  backgroundToolResultErasedAt?: Date;
  backgroundToolResultDeletionPendingAt?: Date;
  attempts: number;
  availableAt: Date;
  envelopeBytes?: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  batchSize?: number;
  batchBytes?: number;
  batchMemberIds?: Types.ObjectId[];
  batchRootId?: Types.ObjectId;
  batchRootRequeueCount?: number;
  batchMembersSettledAt?: Date;
  /** Keeps this binding lane serialized until its admitted child turn reaches
   *  an authoritative terminal handling outcome. */
  awaitTerminalHandling?: boolean;
  handling?: AgentTriggerHandlingState;
  actorReceipt?: AgentEventActorReceipt;
  /** Durable launch identity; excluded from ordinary delivery reads. */
  actorDetachedAction?: AgentEventActorDetachedAction;
  /** Bounded audit trail for terminal attempts replaced by an explicit retry. */
  actorDetachedActionHistory?: AgentEventActorDetachedAction[];
  /** Delivery-owned serialization point acquired exactly once before an event
   * actor may invoke an external action. */
  actorActionAdmittedAt?: Date;
  /** Attempt identity that fences admission takeover and release. */
  actorActionAdmissionId?: string;
  /** Account-deletion fence that atomically closes action admission on this delivery. */
  actorActionAdmissionClosedAt?: Date;
  leaseBy?: string;
  leaseUntil?: Date;
  claimToken?: string;
  lastError?: AgentTriggerDeliveryFailure;
  result?: unknown;
  history?: AgentTriggerDeliveryHistoryEntry[];
  settledAt?: Date;
  expiresAt?: Date;
  requeueCount?: number;
  /** Fairness cursor for bounded recovery of rows stranded before lane publication. */
  stagingRecoveryAt?: Date;
  /** Durable proof that successful settlement still owes lane cleanup publication. */
  laneCleanupPendingAt?: Date;
  /** Readiness changed while a worker held this delivery; its next deferral re-checks at once. */
  wakeRequestedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerDeliveryDocument
  extends Omit<IAgentTriggerDelivery, '_id'>,
    Document {}

export interface AgentTriggerDeliveryRecord
  extends Omit<IAgentTriggerDelivery, '_id' | 'createdAt'> {
  id: string;
  createdAt: Date;
}

/** Owner-scoped projection safe for public delivery-status reads. */
export type AgentTriggerDeliveryStatusRecord = Pick<
  AgentTriggerDeliveryRecord,
  | 'deliveryKey'
  | 'status'
  | 'attempts'
  | 'availableAt'
  | 'createdAt'
  | 'settledAt'
  | 'result'
  | 'lastError'
  | 'handling'
>;

export interface IAgentTriggerLaneSequence {
  _id: string;
  value: number;
  user: Types.ObjectId;
  tenantId?: string;
  /** Latest delivery admitted to this lane. Used to reclaim inactive lane counters safely. */
  tailDeliveryId?: Types.ObjectId;
  /** Delivery currently owning the serialized sequence/publication step. */
  publisherDeliveryId?: Types.ObjectId;
  /** Requeue generation captured when this publisher reservation was acquired. */
  publisherRequeueCount?: number;
  publisherStartedAt?: Date;
  cleanupRequestedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerLaneSequenceDocument
  extends Omit<IAgentTriggerLaneSequence, '_id'>,
    Document<string> {}

/** Durable proof that trigger payload cleanup must survive the deleting process. */
export interface IAgentTriggerUserPurge {
  _id: Types.ObjectId;
  fenceStartedAt: Date;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerUserPurgeDocument
  extends Omit<IAgentTriggerUserPurge, '_id'>,
    Document {}

export interface AgentTriggerDeliveryClaim extends AgentTriggerDeliveryRecord {
  claimToken: string;
  leaseBy: string;
  leaseUntil: Date;
  status: 'leased' | 'capability_leased';
}

export interface AgentTriggerOrderingBlock {
  availableAt: Date;
  leaseUntil?: Date;
  reason?: 'active_handling';
}
