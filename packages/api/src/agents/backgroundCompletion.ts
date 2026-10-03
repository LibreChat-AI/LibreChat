/** Deadline after which an invocation owner requests cancellation. */
export const BACKGROUND_TASK_TIMEOUT_MS: number = 30 * 60 * 1000;
/** Gives a cooperative tool a short window to settle after cancellation before
 * its automatic completion delivery is retired. */
export const BACKGROUND_TASK_ABORT_GRACE_MS: number = 60 * 1000;
/** Three missed heartbeats prove the process-local executor has been lost. */
export const BACKGROUND_TOOL_PRODUCER_LEASE_MS: number = 30_000;
export const BACKGROUND_TOOL_PRODUCER_HEARTBEAT_MS: number = 10_000;
/** Recorded as the result of a background tool the server had to stop while shutting down. */
export const BACKGROUND_TASK_SHUTDOWN_MESSAGE: string =
  'Background task was interrupted because its server shut down before it finished. Run it again if you still need the result.';
/** Kept at the end of the background drain for the final durable receipt writes. */
export const BACKGROUND_SHUTDOWN_FLUSH_RESERVE_MS: number = 2_000;
/** Left after the background drain for the shutdown tasks that run after it. */
export const BACKGROUND_SHUTDOWN_TEARDOWN_RESERVE_MS: number = 2_000;

/** Host-owned identity recorded before ordinary background tool work begins. */
export interface BackgroundToolWakeupRegistration {
  taskId: string;
  toolCallId: string;
  toolName: string;
  userId: string;
  tenantId?: string;
  conversationId: string;
  parentMessageId: string;
  parentAgentId?: string;
  createdAt: number;
}

export interface BackgroundToolWakeupRetireOptions {
  /** Retire only before a resolver owns the delivery. */
  onlyIfUnclaimed?: boolean;
  /** Reconcile only after the delivery is irreversibly dead-lettered. */
  onlyIfDead?: boolean;
  /** Report success only when this call retired it, not when it was already delivered. */
  requireTransition?: boolean;
}

/** Process-local handle for the durable delivery admitted before launch. */
export interface BackgroundToolWakeupAdmission {
  /** Renews durable proof that the process-local executor still owns work. */
  renew: () => Promise<boolean>;
  /** Persists terminal output on the pre-admitted delivery before the parent
   * message projection exists. */
  persistResult?: (result: {
    status: 'completed' | 'error' | 'cancelled';
    output: string;
    settledAt: Date;
  }) => Promise<boolean>;
  /** Retires a delivery whose terminal result can no longer be made durable.
   * Manual polling requires an atomic unclaimed-only transition: once a
   * resolver owns a lease, its prepared continuation cannot be cancelled. */
  retire: (reason: string, options?: BackgroundToolWakeupRetireOptions) => Promise<boolean>;
  /** Best effort: makes a waiting delivery claimable now that a result it can
   * consume exists, e.g. a parent-message projection written without a receipt. */
  expedite?: () => void;
}

/** Durable ownership repair used by a manual poll after an automatic
 * continuation delivery has irreversibly dead-lettered. `claimId` names the
 * batch-root delivery that owns every claimed sibling, not necessarily the
 * polled task's own pre-admitted delivery. */
export interface BackgroundToolDeadClaimRecoveryInput {
  userId: string;
  conversationId: string;
  messageId: string;
  claimId: string;
  batchId?: string;
  /** Automatic repair cannot reopen a committed manual handoff. */
  onlyIfUnreconciled?: true;
  /** Omitted for the legacy automatic-wakeup recovery path. */
  kind?: 'manual' | 'wakeup';
  /** Required to prove that a manual claim's owning generation is no longer active. */
  generationId?: string;
}

export type BackgroundToolDeadClaimRecovery = (
  input: BackgroundToolDeadClaimRecoveryInput,
) => Promise<boolean>;

/** A background tool completion whose result has not reached its conversation yet,
 * read from the durable delivery store rather than a process-local registry. */
export interface PendingBackgroundCompletion {
  taskId: string;
  toolCallId: string;
  toolName: string;
  dispatchedAt: Date;
  /** The tool's terminal outcome once it settled; absent while it still runs. */
  result?: { status: 'completed' | 'error' | 'cancelled'; settledAt: Date };
  /** An automatic delivery holds the result and is starting its turn. */
  claimedByWakeup: boolean;
}

/**
 * What cancelling an undelivered completion did: `discarded` retired its delivery,
 * so the result never arrives; `running` found the tool still executing where this
 * process cannot stop it; `delivering` found the result already being delivered;
 * `not_pending` found no undelivered completion for the task.
 */
export type BackgroundCompletionDiscardOutcome =
  | 'discarded'
  | 'running'
  | 'delivering'
  | 'not_pending';

/** Durable view and control of one principal's undelivered background completions. */
export interface PendingBackgroundCompletionControls {
  /** `complete` is false when undelivered or dead-lettered results were truncated. */
  list: (input: { userId: string; conversationId: string }) => Promise<{
    completions: PendingBackgroundCompletion[];
    /** Completions whose automatic delivery dead-lettered; only a poll recovers them. */
    dead: PendingBackgroundCompletion[];
    complete: boolean;
  }>;
  /** Subagent tasks whose completion wake-up has not been delivered yet. */
  listSubagentWakeups: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<{ taskIds: string[]; complete: boolean }>;
  discard: (input: {
    userId: string;
    conversationId: string;
    taskId: string;
  }) => Promise<BackgroundCompletionDiscardOutcome>;
  /** Retires a task's pending delivery after a manual poll claimed its result. */
  settleClaimed: (input: {
    userId: string;
    conversationId: string;
    taskId: string;
  }) => Promise<boolean>;
}
