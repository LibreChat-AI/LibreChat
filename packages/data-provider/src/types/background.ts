export type BackgroundTaskStatus = 'running' | 'completed' | 'error' | 'cancelled';

/**
 * Whether a finished task's result has reached the agent. `pending` results still
 * arrive as a new turn; `failed` ones never will. Absent for tasks without
 * automatic delivery.
 */
export type BackgroundTaskDelivery = 'pending' | 'delivered' | 'failed';

/**
 * Public projection of one ordinary background tool task. Results, artifacts
 * and errors stay server-side; the list carries identity, status and timing.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolName: string;
  toolCallId: string;
  messageId?: string;
  /** Distinguishes repeated provider call ids within one response. */
  stepId?: string;
  status: BackgroundTaskStatus;
  cancellationRequested: boolean;
  /** ISO-8601 dispatch time. */
  startedAt: string;
  /** ISO-8601 terminal time. Absent while the task is running. */
  settledAt?: string;
  delivery?: BackgroundTaskDelivery;
};

export type BackgroundTaskIndex = {
  conversationId: string;
  tasks: BackgroundTaskSummary[];
  /** False when the durable store is unavailable or its bounded list is incomplete. */
  complete?: boolean;
  /** Whether the deployment accepts user cancellation of ordinary tools. */
  cancellable: boolean;
};

export type BackgroundTaskCancelRequest = {
  /** Tasks to cancel; omitted cancels every running task in the conversation. */
  taskIds?: string[];
};

export type BackgroundTaskCancelOutcome =
  | 'not_found'
  | 'unavailable'
  | 'requested'
  | 'already_requested'
  | 'settled';

export type BackgroundTaskCancelResponse = {
  results: Array<{ taskId: string; status: BackgroundTaskCancelOutcome }>;
};
