export {
  GenerationJobManager,
  GenerationJobManagerClass,
  type CreateGenerationJobOptions,
  type GenerationJobManagerOptions,
  type TerminalJobClaim,
  type GenerationSettledEvent,
  type GenerationSettledListener,
  GENERATION_RECOVERY_FAILED_ERROR,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from './GenerationJobManager';

export type {
  SerializableJobData,
  SteerQueueItem,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  JobStatus,
  JobMetadataPatch,
  GenerationProtocolVersion,
  GenerationPredecessorState,
  ParkedSteerClaim,
  IJobStore,
  IJobStoreV2,
  DetachedAgentEventActionStoreMode,
} from './interfaces/IJobStore';
// Canonical "is this approval live?" predicate — one definition shared by the
// stores, the approval lifecycle, and the status route / message middleware.
export {
  GenerationPublicationFencedError,
  JobPredecessorMismatchError,
  isPendingActionExpired,
  isPendingActionStale,
} from './interfaces/IJobStore';
// Canonical "did this generation actually stop?" predicate — shared by every caller
// that settles durable state on an abort's outcome.
export { isStopConfirmed } from './interfaces/IJobStore';
export {
  STEER_ENQUEUE_NOT_RUNNING,
  STEER_ENQUEUE_QUEUE_FULL,
  STEER_ENQUEUE_RECEIPT_FULL,
  STEER_QUEUE_MAX_DEPTH,
} from './interfaces/IJobStore';
export { SteeringLifecycle, toPendingSteer } from './SteeringLifecycle';
export {
  ApprovalLifecycle,
  PendingActionExpiredError,
  PENDING_ACTION_EXPIRED_CODE,
} from './ApprovalLifecycle';
export type { ApprovalLifecycleCallbacks, ApprovalPauseOptions } from './ApprovalLifecycle';
export {
  assertJobStoreV2,
  getMissingJobStoreV2Methods,
  JOB_STORE_V2_REQUIRED_METHODS,
} from './jobStoreCapabilities';
export type { JobStoreV2RequiredMethod } from './jobStoreCapabilities';
export {
  buildRecoveredSteerPayload,
  canonicalRecoveryFileIds,
  getSteerRecoveryFailure,
  RecoveredSteerPayloadMismatchError,
} from './SteerRecovery';
export type { RecoveredSteerPayload } from './SteerRecovery';

export { createStreamServices } from './createStreamServices';
export type { StreamServicesConfig, StreamServices } from './createStreamServices';
export { filterPersistableAbortContent, hasPersistableAbortContent } from './abortContent';
export { getGenerationElapsedMs } from './elapsed';
export {
  projectTerminalEvent,
  TRANSIENT_MESSAGE_FIELDS,
  TRANSIENT_FILE_FIELDS,
  TRANSIENT_ATTACHMENT_FIELDS,
} from './terminalProjection';
export type {
  ProjectedFinalEvent,
  ProjectedMessageFields,
  TransientMessageField,
} from './terminalProjection';

// Implementations (for advanced use cases)
export { InMemoryJobStore } from './implementations/InMemoryJobStore';
export { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
export { RedisJobStore } from './implementations/RedisJobStore';
export { RedisEventTransport } from './implementations/RedisEventTransport';

export { waitForGenerationPersistence } from './persistence';
export { waitForGenerationSettled } from './settled';
export type { GenerationSettledSource, GenerationSettledWaitOptions } from './settled';

export type { GenerationSettlementState } from './interfaces/IJobStore';
