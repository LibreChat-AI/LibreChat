export type EarlyBufferRecoveryMethod = 'redis' | 'snapshot';
export type EarlyBufferRecoveryOutcome = 'success' | 'failed' | 'not_required';
export type EarlyBufferRecoveryFailureReason =
  | 'durable_state_missing'
  | 'durable_frontier_gap'
  | 'snapshot_missing'
  | 'subscriber_never_attached'
  | 'subscriber_disconnected'
  | 'reconstruction_error'
  | 'overflow_marker_persistence_failed';

export interface EarlyBufferOverflowState {
  id: string;
  occurredAt: number;
  durableEvents: number;
  droppedEvents: number;
  droppedBytes: number;
  /** True while the owner is flushing accepted durable appends and has not
   * published the final recovery frontier yet. */
  persistencePending?: boolean;
  recoveryMethod?: EarlyBufferRecoveryMethod;
  recoveryOutcome?: EarlyBufferRecoveryOutcome;
  recoveryCompletedAt?: number;
  recoveryFailureReason?: EarlyBufferRecoveryFailureReason;
}
