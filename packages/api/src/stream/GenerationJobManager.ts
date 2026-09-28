import { randomUUID } from 'crypto';
import { logger, getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import {
  Constants,
  ContentTypes,
  StepTypes,
  UsageEvents,
  ApprovalEvents,
  SteerEvents,
  parseTextParts,
  hasToolCallErrorPrefix,
  reconcileContextUsageFromEvent,
} from 'librechat-data-provider';
import type {
  TMessageContentParts,
  TContextUsageEvent,
  TTokenUsageEvent,
  Agents,
} from 'librechat-data-provider';
import type { StandardGraph } from '@librechat/agents';
import type {
  SerializableJobData,
  GenerationSettlementState,
  CreatedJobData,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  IJobStore,
  IJobStoreV2,
  IdempotencyClaimResult,
  IdempotencyClaimValue,
  PreemptMessage,
  SteerQueueItem,
  DetachedAgentEventActionStoreMode,
} from './interfaces/IJobStore';
import type {
  EarlyBufferOverflowState,
  EarlyBufferRecoveryFailureReason,
  EarlyBufferRecoveryOutcome,
} from '../types/earlyBufferRecovery';
import type { AgentStartupTelemetry } from '~/agents/startup';
import type { RecoveredSteerPayload } from './SteerRecovery';
import type { SteerContentView } from './SteeringLifecycle';
import type { GenerationJobStore } from '~/app/metrics';
import type * as t from '~/types';
import {
  recordGenerationStreamEarlyBufferOverflow,
  recordGenerationStreamResumePendingEvents,
  recordGenerationStreamSubscription,
  recordGenerationStreamAttachment,
  recordGenerationStreamRecovery,
  setGenerationJobsInFlight,
  recordGenerationJob,
} from '~/app/metrics';
import {
  GenerationPublicationFencedError,
  JobCreationSupersededError,
  JobPredecessorMismatchError,
  isPendingActionStale,
  isPendingActionExpired,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
  PROVIDER_DRAIN_TIMEOUT_MS,
  STEER_QUEUE_MAX_DEPTH,
} from './interfaces/IJobStore';
import { isRecoveredSteerPayload, RecoveredSteerPayloadMismatchError } from './SteerRecovery';
import { projectTerminalEvent } from './terminalProjection';
import { assertJobStoreV2 } from './jobStoreCapabilities';

/**
 * Tombstone budget per generation. Twice the queue depth so a full queue's
 * worth of removals plus in-flight arms fit without eviction in practice.
 */
const PREEMPT_TOMBSTONE_MAX = STEER_QUEUE_MAX_DEPTH * 2;
import {
  SteeringLifecycle,
  toPendingSteer,
  synthesizeAppliedSteerEvents,
} from './SteeringLifecycle';
import { synthesizeActivityLabelGapEvents } from '~/agents/activityLabels/wiring';
import { synthesizeReasoningLabelGapEvents } from '~/agents/reasoningLabels';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';
import { attachAskUserQuestionAnswers, normalizeResumeRunStepIndices } from '~/agents/hitl/resume';
import { emitChunkWithReceipt } from './internal/chunkPublication';
import { resolveCoalesceWindowMs } from './internal/coalescing';
import {
  REDIS_ABORT_TERMINAL_GRACE_MS,
  REDIS_EVENT_REORDER_TIMEOUT_MS,
  REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS,
} from './internal/timing';
import { filterPersistableAbortContent } from './abortContent';
import { toClientPendingAction } from '~/agents/hitl/policy';
import { ApprovalLifecycle, pausePersistenceActionId } from './ApprovalLifecycle';
import { projectPendingMCPOAuthPrompts } from '~/mcp/oauth/resume';
import { sanitizeJobMetadata } from './metadata';

/** Terminal error surfaced to a client still attached when its approval window lapses. */
const APPROVAL_EXPIRED_ERROR = 'Approval expired before a decision was made';

/** Error surfaced to any client still attached when a stale/hung job is reaped. */
const REAPED_JOB_ERROR = 'Generation timed out';

/** Un-awaited coalesced publications allowed per stream before the emitter
 * awaits a receipt. Healthy settlement keeps outstanding counts in the single
 * digits; this trips only when Redis stalls, bounding buffered batches and
 * queued commands by pacing the producer instead of growing without limit. */
const MAX_OUTSTANDING_COALESCED_RECEIPTS = 256;
const PROVIDER_DRAIN_POLL_MS = 50;

/**
 * The settlement budget is the opt-in. Graceful shutdown owns the real deadline and passes what
 * is actually left, so open provider executions get the full remaining window to record their
 * drains. A bare `destroy()` — test teardown, a direct reset — supplies nothing and must not
 * block on executions that were begun and never drained.
 */
const SHUTDOWN_SETTLEMENT_FALLBACK_MS = 0;
type ToolExecutionStatus = 'success' | 'error' | 'cancelled';
type ToolCallWithExecutionStatus = Agents.AgentToolCall & {
  executionStatus?: ToolExecutionStatus;
};

/** Current agents SDK releases serialize tool failures into one of these
 * host-authored prefixes but do not yet carry ToolMessage.status on the wire.
 * Stamp the result on the exact call while the completion envelope still has
 * that identity; never infer it later from the aggregate step close. */
function completedToolExecutionStatus(call: Agents.ToolCall): ToolExecutionStatus {
  if (call.inputValidationError === true) {
    return 'error';
  }
  const output = call.output;
  return typeof output === 'string' &&
    (hasToolCallErrorPrefix(output) ||
      /^Error processing tool(?::|$)/i.test(output) ||
      /^Error:[\s\S]*\n Please fix your mistakes\.$/i.test(output))
    ? 'error'
    : 'success';
}

/** Bounded completed-request replay horizon. It exceeds the default 24-hour
 * approval window; if a custom/live job outlasts it, `resumeClaimedGeneration`
 * atomically adopts the reacquired claim instead of replacing that job. */
const IDEMPOTENCY_TTL_SECONDS = 25 * 60 * 60;
/** The legacy, user/request-scoped key deliberately outlives the same-slot
 * primary. During a rolling upgrade this keeps old replicas fenced while a
 * new replica can reconstruct an expired primary from the legacy tombstone. */
const LEGACY_IDEMPOTENCY_TTL_SECONDS = 26 * 60 * 60;
const OAUTH_TOOL_CALL_PREFIX = `oauth${Constants.mcp_delimiter}`;
const SHUTDOWN_SUBSCRIBER_ERROR = 'Server is shutting down';
const SHUTDOWN_JOB_ERROR = 'Generation interrupted because its server shut down';
const SHUTTING_DOWN_ERROR = 'Generation job manager is shutting down';
/** Internal transport signal: durable terminal state exists, but its DONE
 * publication failed. HTTP subscribers must reconnect rather than treating
 * this as an application-level generation error. */
export const TERMINAL_PUBLICATION_RECONNECT_ERROR =
  'Terminal publication failed; reconnect to load the durable result';
export const GENERATION_RECOVERY_FAILED_ERROR = 'generation_recovery_failed';
/** Upper bound for a terminal owner's required persistence barrier. A crashed
 * owner leaves the durable pending bit behind; the next read or subscriber
 * promotes it to conservative reconciliation after this window. */
const TERMINAL_PERSISTENCE_TIMEOUT_MS = 30_000;
/** Hard bounds for a runtime's local early-event replay buffer. The buffer
 * bridges emission to first attachment, but a generation streaming with no
 * attached subscriber would otherwise grow it for its entire duration. On
 * overflow the buffer is discarded and closed: Redis mode recovers from the
 * durable chunk log, in-memory reconnects recover from the resume snapshot. */
const EARLY_EVENT_BUFFER_MAX_EVENTS = 5_000;
const EARLY_EVENT_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
const SLOW_ATTACHMENT_BOOTSTRAP_MS = 3_000;
const SUBSCRIBER_LEASE_TTL_MS = 30_000;
const SUBSCRIBER_LEASE_REFRESH_MS = 10_000;
const EARLY_BUFFER_OVERFLOW_PERSISTENCE_TIMEOUT_MS = 3_000;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
type TokenIdempotencyClaim = IdempotencyClaimValue & {
  claimedAt: number;
  claimToken: string;
  generationProtocolVersion: 1 | 2;
};

function normalizeClaimProtocol(
  value: Pick<IdempotencyClaimValue, 'generationProtocolVersion'>,
): 1 | 2 {
  return value.generationProtocolVersion === 2 ? 2 : 1;
}

function assertClaimCoordinates(
  value: IdempotencyClaimValue | undefined,
  context: string,
): asserts value is IdempotencyClaimValue {
  if (
    value == null ||
    typeof value !== 'object' ||
    typeof value.streamId !== 'string' ||
    value.streamId.length === 0 ||
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0 ||
    !Number.isSafeInteger(value.claimedAt) ||
    (value.claimedAt as number) < 0 ||
    (value.startedAt != null && (!Number.isSafeInteger(value.startedAt) || value.startedAt < 0)) ||
    (value.generationProtocolVersion != null &&
      value.generationProtocolVersion !== 1 &&
      value.generationProtocolVersion !== 2)
  ) {
    throw new Error(`Invalid ${context} generation idempotency claim`);
  }
}

/** A token-bearing value was written by the bridge-capable manager. Its full
 * coordinates are therefore mandatory; an empty/malformed token must never be
 * reinterpreted as a harmless old-server value. */
function normalizeTokenClaim(
  value: IdempotencyClaimValue | undefined,
  context: string,
): TokenIdempotencyClaim {
  assertClaimCoordinates(value, context);
  if (
    typeof value.claimToken !== 'string' ||
    value.claimToken.length === 0 ||
    value.claimToken.length > 128 ||
    (value.previousClaimToken != null &&
      (typeof value.previousClaimToken !== 'string' ||
        value.previousClaimToken.length === 0 ||
        value.previousClaimToken.length > 128 ||
        value.previousClaimToken === value.claimToken))
  ) {
    throw new Error(`Invalid ${context} generation idempotency claim token`);
  }
  return {
    ...value,
    claimedAt: value.claimedAt as number,
    claimToken: value.claimToken,
    generationProtocolVersion: normalizeClaimProtocol(value),
  };
}

/** Old replicas wrote a claimedAt/stream pointer but no lease token. They are
 * authoritative duplicate evidence, not a lease a new replica may take over.
 * Stream correlation is intentionally left to the controller: pre-upgrade new
 * chats used a random stream while current retries derive a stable UUID. */
function normalizeTokenlessLegacyClaim(
  value: IdempotencyClaimValue | undefined,
): IdempotencyClaimValue {
  assertClaimCoordinates(value, 'legacy');
  if (
    value.claimToken != null ||
    value.previousClaimToken != null ||
    value.startedAt != null ||
    normalizeClaimProtocol(value) !== 1
  ) {
    throw new Error('Invalid tokenless legacy generation idempotency claim');
  }
  return { ...value, generationProtocolVersion: 1 };
}

function assertClaimMatchesRequest(
  value: TokenIdempotencyClaim,
  streamId: string,
  conversationId: string,
): void {
  if (value.streamId !== streamId || value.conversationId !== conversationId) {
    throw new Error('Mismatched generation idempotency claim coordinates');
  }
}

function claimsMirrorExactly(left: TokenIdempotencyClaim, right: TokenIdempotencyClaim): boolean {
  return (
    left.streamId === right.streamId &&
    left.conversationId === right.conversationId &&
    left.claimedAt === right.claimedAt &&
    left.claimToken === right.claimToken &&
    left.previousClaimToken === right.previousClaimToken &&
    left.generationProtocolVersion === right.generationProtocolVersion &&
    left.startedAt === right.startedAt
  );
}

/** The legacy and primary values are mirrors. The only legitimate transient
 * asymmetry is primary.startedAt being present before the follow-up legacy
 * mark; the caller reconciles that one direction explicitly. */
function assertClaimMirrors(legacy: TokenIdempotencyClaim, primary: TokenIdempotencyClaim): void {
  const startedRepair = legacy.startedAt == null && primary.startedAt != null;
  if (
    legacy.streamId !== primary.streamId ||
    legacy.conversationId !== primary.conversationId ||
    legacy.claimedAt !== primary.claimedAt ||
    legacy.claimToken !== primary.claimToken ||
    legacy.previousClaimToken !== primary.previousClaimToken ||
    (legacy.generationProtocolVersion !== primary.generationProtocolVersion && !startedRepair) ||
    (legacy.startedAt != null && legacy.startedAt !== primary.startedAt)
  ) {
    throw new Error('Mismatched legacy and primary generation idempotency claims');
  }
}

/** Proof of the only repairable unstarted token split: takeover wrote the
 * primary with an explicit predecessor token, then its reply/legacy CAS was
 * interrupted. Arbitrary token mismatches remain fail-closed. */
function isClaimTakeoverOf(
  predecessor: TokenIdempotencyClaim,
  candidate: TokenIdempotencyClaim,
): boolean {
  return (
    candidate.previousClaimToken === predecessor.claimToken &&
    candidate.claimToken !== predecessor.claimToken &&
    candidate.streamId === predecessor.streamId &&
    candidate.conversationId === predecessor.conversationId &&
    candidate.generationProtocolVersion === predecessor.generationProtocolVersion &&
    candidate.claimedAt >= predecessor.claimedAt
  );
}

function isRecoverableTakeoverSplit(
  legacy: TokenIdempotencyClaim,
  primary: TokenIdempotencyClaim,
): boolean {
  return (
    legacy.startedAt == null && primary.startedAt == null && isClaimTakeoverOf(legacy, primary)
  );
}

/**
 * Name the reason a terminal-state CAS was lost, off the job that now holds the
 * conversation. Losing to natural completion IS a stop; losing to a replacement, or to
 * deletion, is not — and callers settle durable state on that distinction.
 */
function classifyLostAbortRace(
  jobStillActive: boolean,
  currentJob: SerializableJobData | null,
  abortedCreatedAt: number,
): NonNullable<AbortResult['failureReason']> {
  if (jobStillActive) {
    return 'job_still_active';
  }
  if (currentJob == null) {
    return 'job_not_found';
  }
  if (currentJob.createdAt !== abortedCreatedAt) {
    return 'generation_replaced';
  }
  return 'already_settled';
}

function buildTerminalPersistenceReconcile(
  job: Pick<SerializableJobData, 'createdAt' | 'conversationId' | 'status'>,
): t.FinalEvent {
  const aborted = job.status === 'aborted';
  return {
    final: true,
    reconcile: true,
    reconcileReason: aborted ? 'abort_persistence_failed' : 'terminal_payload_missing',
    /** A completion whose outcome-defining write is unknown must not trigger
     * completed-run follow-up draining. Surface it conservatively as an error;
     * the persisted history refetch remains authoritative if the write won
     * before the owner disappeared. */
    terminalStatus: aborted ? 'aborted' : 'error',
    generationCreatedAt: job.createdAt,
    conversation: { conversationId: job.conversationId },
  };
}

function getSteerUserSubmittedPaths(content: readonly TMessageContentParts[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index]?.type === 'steer') {
      paths.push(`/content/${index}`);
    }
  }
  return paths;
}

function getToolCallName(toolCall: unknown): unknown {
  return toolCall != null && typeof toolCall === 'object' && 'name' in toolCall
    ? toolCall.name
    : undefined;
}

function hasOAuthToolCall(toolCalls: unknown): boolean {
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((toolCall) => {
      const name = getToolCallName(toolCall);
      return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
    })
  );
}

/** One recovery projection for both still-queued and already-drained steers.
 * Claimed items remain non-drainable, but a reconnect must still render them
 * until their applied chunk is durably committed. */
function mergeUnresolvedSteers(...groups: SteerQueueItem[][]): SteerQueueItem[] {
  const byId = new Map<string, SteerQueueItem>();
  for (const group of groups) {
    for (const item of group) {
      byId.set(item.steerId, item);
    }
  }
  // Each group is already FIFO and callers pass the claimed prefix before the
  // still-queued suffix. Map preserves first insertion position while still
  // letting a later duplicate refresh its value; timestamps and random UUIDs
  // are not safe ordering keys for two accepts in the same millisecond.
  return [...byId.values()];
}

function omitAlreadyAppliedSteers(items: SteerQueueItem[], content: unknown[]): SteerQueueItem[] {
  const appliedIds = new Set<string>();
  for (const part of content) {
    if (
      part != null &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === ContentTypes.STEER &&
      'steerId' in part &&
      typeof part.steerId === 'string'
    ) {
      appliedIds.add(part.steerId);
    }
  }
  return items.filter((item) => !appliedIds.has(item.steerId));
}

/**
 * Streaming deltas eligible for windowed publish/append coalescing. High-volume,
 * order-preserved by per-event sequences, and consumed for the generation fence
 * only — unlike control events, nothing awaits their publication for correctness.
 */
function isCoalescableDeltaEvent(eventType: string | undefined): boolean {
  return (
    eventType === 'on_message_delta' ||
    eventType === 'on_reasoning_delta' ||
    eventType === 'on_run_step_delta'
  );
}

function getReplayStepId(event: t.ServerSentEvent): unknown {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return undefined;
  }

  if (event.event === 'on_run_step' || event.event === 'on_run_step_delta') {
    return 'id' in event.data ? event.data.id : undefined;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    return result != null && typeof result === 'object' && 'id' in result ? result.id : undefined;
  }

  return undefined;
}

function isOAuthReplayEvent(event: t.ServerSentEvent): boolean {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return false;
  }

  if (event.event === 'on_run_step') {
    const stepDetails = 'stepDetails' in event.data ? event.data.stepDetails : undefined;
    return (
      stepDetails != null &&
      typeof stepDetails === 'object' &&
      'tool_calls' in stepDetails &&
      hasOAuthToolCall(stepDetails.tool_calls)
    );
  }

  if (event.event === 'on_run_step_delta') {
    const delta = 'delta' in event.data ? event.data.delta : undefined;
    if (delta == null || typeof delta !== 'object') {
      return false;
    }
    if (!('tool_calls' in delta) || !hasOAuthToolCall(delta.tool_calls)) {
      return false;
    }

    return true;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    if (result == null || typeof result !== 'object' || !('tool_call' in result)) {
      return false;
    }
    const name = getToolCallName(result.tool_call);
    return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
  }

  return false;
}

function normalizeRunStepReplayIndices(
  replayEvents: t.ResumeState['replayEvents'],
  runSteps: readonly Agents.RunStep[],
): t.ResumeState['replayEvents'] {
  if (!replayEvents) {
    return replayEvents;
  }
  const runStepsById = new Map(runSteps.map((runStep) => [runStep.id, runStep]));
  return replayEvents.map((event) => {
    if (event.event !== 'on_run_step' || event.data == null || typeof event.data !== 'object') {
      return event;
    }
    const stepId = 'id' in event.data ? event.data.id : undefined;
    const normalizedRunStep = typeof stepId === 'string' ? runStepsById.get(stepId) : undefined;
    const eventIndex = 'index' in event.data ? event.data.index : undefined;
    if (!normalizedRunStep || normalizedRunStep.index === eventIndex) {
      return event;
    }
    return {
      ...event,
      data: {
        ...event.data,
        index: normalizedRunStep.index,
      },
    };
  });
}

/**
 * Configuration options for GenerationJobManager
 */
export interface GenerationJobManagerOptions {
  jobStore?: IJobStore;
  eventTransport?: IEventTransport;
  /**
   * If true, cleans up event transport immediately when job completes.
   * If false, keeps EventEmitters until periodic cleanup for late reconnections.
   * Default: true (immediate cleanup to save memory)
   */
  cleanupOnComplete?: boolean;
}

/** Host-owned lifecycle seam for durable work layered on agent generations.
 * Delivery is at-least-once: implementations must be idempotent by generation. */
export type ApprovalExpiredHandler = (
  streamId: string,
  job: SerializableJobData,
) => void | Promise<void>;

export type TerminalHostActionHandler = (
  streamId: string,
  job: SerializableJobData,
  runSteps: Agents.RunStep[],
  content: Agents.MessageContentComplex[],
) => void | Promise<void>;

export interface CreateGenerationJobOptions {
  startupTelemetry?: AgentStartupTelemetry;
  initialMetadata?: Partial<t.GenerationJobMetadata>;
  /** A terminal steer being handed off as this new normal turn. The store
   * leases this exact parked item while the generation is active; persistence
   * commits its removal through `consumeRecovered`. */
  recoveredSteerId?: string;
  /** Exact user-visible source proof checked inside the store's atomic create.
   * Required whenever `recoveredSteerId` is present. */
  recoveredSteerPayload?: RecoveredSteerPayload;
  idempotencyClientRequestId?: string;
  idempotencyClaimToken?: string;
  /** Optional compare-and-set fence from the client's last authoritative
   * status result. Creation may proceed only if that exact epoch is still
   * current or the stream has no durable job. */
  expectedPredecessorCreatedAt?: number;
  /** Atomically refuse to replace a running/paused predecessor while allowing
   * an absent or terminal predecessor. Used by automatic continuations. */
  rejectActivePredecessor?: boolean;
}

/**
 * Proof that this manager won the only legal `running -> terminal` transition
 * for one generation. Controllers must publish their terminal event only after
 * receiving this claim, then pass the same object to {@link finishTerminalJob}
 * from a `finally` block.
 */
/** A generation reached a terminal state and released its runtime. */
export interface GenerationSettledEvent {
  streamId: string;
  conversationId: string;
  userId: string;
  status: TerminalJobClaim['status'];
}

export type GenerationSettledListener = (event: GenerationSettledEvent) => void;

export interface TerminalJobClaim {
  readonly streamId: string;
  readonly createdAt: number;
  readonly conversationId?: string;
  /** The generation's owner, so settlement can be announced to that principal's waiters. */
  readonly userId?: string;
  readonly status: 'complete' | 'error' | 'aborted';
  readonly error?: string;
  /** The winner must durably publish either its normal FINAL or a
   * reconciliation payload before cleanup may remove the job. */
  readonly persistencePending?: true;
  /** Exact queued + claimed steers atomically parked by the winning CAS. */
  readonly drainedSteers: readonly SteerQueueItem[];
}

/**
 * Runtime state for active jobs - not serializable, kept in-memory per instance.
 * Contains AbortController, ready promise, and other non-serializable state.
 *
 * @property abortController - Controller to abort the generation
 * @property readyPromise - Resolves immediately (legacy, kept for API compatibility)
 * @property resolveReady - Function to resolve readyPromise
 * @property finalEvent - Cached final event for late subscribers
 * @property errorEvent - Cached error event for late subscribers (errors before client connects)
 * @property syncSent - Whether sync event was sent (reset when all subscribers leave)
 * @property earlyEventBuffer - Buffer for events emitted before first subscriber connects
 * @property earlyEventSequencePromises - Redis sequence assignments corresponding to buffered
 *   events. Their absolute values identify the exact ordering frontier after replay.
 * @property hasSubscriber - Whether at least one subscriber has connected
 * @property allSubscribersLeftHandlers - Internal handlers for disconnect events.
 *   These are stored separately from eventTransport subscribers to avoid being counted
 *   in subscriber count. This is critical: if these were registered via subscribe(),
 *   they would count as subscribers, causing isFirstSubscriber() to return false
 *   when the real client connects, which would prevent readyPromise from resolving.
 */
interface RuntimeJobState {
  createdAt: number;
  abortController: AbortController;
  /** Removes this generation's cross-replica abort listener without touching a replacement. */
  abortUnsubscribe?: () => void;
  /** A durable successor has stopped this provider but has not yet activated
   * its own abort registration. Keep this runtime's transport callbacks as a
   * channel handoff bridge until the successor explicitly releases them. */
  replacementTransportHold?: boolean;
  /** Stored-terminal discovery proved that this held predecessor needs the
   * receipt-aware retirement lifecycle once the successor releases the hold. */
  replacementRetirementPending?: boolean;
  /**
   * Cooperative-seal requests for THIS generation. Armed by `requestPreempt`
   * (locally or via a fenced cross-replica publish), polled O(1) by the run's
   * `shouldPreempt`, and cleared by `noteSteersRemoved` when the steer drains
   * at any boundary or is cancelled. Lives and dies with the runtime object —
   * no terminal bookkeeping needed beyond the listener release.
   */
  preempt?: {
    /** Generation identity this request set belongs to. */
    createdAt: number;
    /** Server-minted steerIds requested but not yet drained/cancelled. */
    ids: Set<string>;
    /**
     * Run-scoped wake callbacks handed to the SDK's `StreamPreemption`.
     * Notified after an arm is ACCEPTED so the model attempt can look at a
     * request the per-chunk poll cannot reach — a provider that has gone
     * silent, or one streaming reasoning that will never become sealable.
     *
     * Hints only. `ids` above stays the sole authority, so a spurious or
     * duplicate wake costs one O(1) re-read and nothing else.
     */
    wakes?: Set<() => void>;
    /**
     * steerIds whose removal was observed BEFORE their arm. Arm and clear are
     * published by different replicas over different connections, so a steer
     * drained at a tool boundary during the arming replica's enqueue round
     * trip can have its clear land first — without this tombstone the late
     * arm would resurrect a request no steer backs, sealing an unrelated
     * stretch of generation. steerIds are single-use UUIDs, so a tombstoned
     * id can never legitimately be re-armed.
     */
    cleared: Set<string>;
    /** Lowest revision a still-queued steer may use after a non-terminal
     * capability downgrade. Unlike `cleared`, this allows a later explicit
     * arm whose store-assigned revision is newer. */
    minArmRevision: Map<string, number>;
  };
  /** Removes this generation's cross-replica preempt listener without touching a replacement. */
  preemptUnsubscribe?: () => void;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  startupTelemetry?: AgentStartupTelemetry;
  finalEvent?: t.ServerSentEvent;
  errorEvent?: string;
  /** Local, runtime-scoped terminal handlers. Avoids broadcasting predecessor errors to a
   * replacement generation that reuses the same durable stream ID. */
  localErrorHandlers: Set<t.ErrorHandler>;
  /** Prevents a repeated approval-expiry sweep from republishing the same terminal event. */
  approvalExpiryPublished?: boolean;
  /** Prevents a local or cross-replica stale-pause relay from retiring and
   * republishing the same exact runtime more than once. */
  pausePersistenceTimeoutRetired?: boolean;
  syncSent: boolean;
  earlyEventBuffer: t.ServerSentEvent[];
  /** Estimated serialized size of earlyEventBuffer, for the overflow guard. */
  earlyEventBufferBytes: number;
  /** Closed after the first attachment drains the buffer in Redis mode (the
   * durable chunk log owns later recovery) or after an overflow discard. A
   * closed buffer never re-accumulates events for this runtime. */
  earlyEventBufferClosed: boolean;
  /** The buffer was discarded by the overflow guard before a subscriber
   * consumed it. Non-resume attachments are redirected to the resume path,
   * which reconstructs the discarded output from durable/snapshot state. */
  earlyEventBufferOverflowed?: true;
  earlyBufferOverflow?: EarlyBufferOverflowState;
  earlyEventSequencePromises: Array<Promise<void | number>>;
  /** Initial subscribers eligible to receive the local pre-attachment replay. */
  earlyReplayHandlers: Set<t.ChunkHandler>;
  /** Per-resume capture handlers that bridge an in-memory snapshot to transport attachment. */
  resumeCaptureHandlers: Set<(event: t.ServerSentEvent, sequence: number) => void>;
  /** Monotonic local emission sequence used to establish an exact resume snapshot frontier. */
  emissionSequence: number;
  /** Count of emitted Redis envelopes that are eligible for durable append. */
  durableEventSequence: number;
  /** Emissions that started before an in-memory resume snapshot and must become snapshot-visible
   *  before the graph/job state is read. The event identity also suppresses their later publish. */
  inFlightSnapshotEmissions: Map<
    number,
    { event: t.ServerSentEvent; snapshotReady: Promise<void> }
  >;
  /** Prevents later events from overtaking the initial `created` metadata write and publish. */
  createdEventPublication?: Promise<void>;
  /** Coalesced delta publications emitted but not yet settled by a window flush. */
  outstandingCoalescedReceipts?: number;
  hasSubscriber: boolean;
  everHadSubscriber: boolean;
  /** Ordered, non-blocking durable subscriber lifecycle writes. */
  subscriberStateWrite?: Promise<unknown>;
  /** Whether this runtime's local subscriber group is represented durably. */
  subscriberStateAttached: boolean;
  subscriberLeaseId: string;
  subscriberLeaseTimer?: ReturnType<typeof setInterval>;
  subscriberLeaseRenewalPending?: boolean;
  /** One-shot telemetry callback retained until a durable first-subscriber claim succeeds. */
  onFirstSubscriberLeaseClaim?: (firstSubscriber: boolean) => void;
  /** Advances whenever every local SSE subscriber for one attachment generation leaves. */
  attachmentGeneration: number;
  /** Attachment generation whose partial-response disconnect cleanup was most recently started. */
  lastSubscriberCleanupGeneration?: number;
  allSubscribersLeftHandlers?: Array<(...args: unknown[]) => void | Promise<void>>;
}

interface FencedRuntimeRetirementContext {
  controller: AbortController;
  timer?: NodeJS.Timeout;
  cleanupStarted?: boolean;
}

interface PreparedSubscription {
  runtime: RuntimeJobState;
  jobData: SerializableJobData | null;
  deferDeliveryUntilActivated: boolean;
}

type DeferredDelivery =
  | { type: 'chunk'; event: t.ServerSentEvent }
  | { type: 'done'; event: t.ServerSentEvent }
  | { type: 'error'; error: string };

/**
 * Manages generation jobs for resumable LLM streams.
 *
 * Architecture: Composes two pluggable services via dependency injection:
 * - jobStore: Job metadata + content state (InMemory → Redis for horizontal scaling)
 * - eventTransport: Pub/sub events (InMemory → Redis Pub/Sub for horizontal scaling)
 *
 * Content state is tied to jobs:
 * - In-memory: jobStore holds WeakRef to graph for live content/run steps access
 * - Redis: jobStore persists chunks, reconstructs content on demand
 *
 * All storage methods are async to support both in-memory and external stores (Redis, etc.).
 *
 * @example Redis injection:
 * ```ts
 * const manager = new GenerationJobManagerClass({
 *   jobStore: new RedisJobStore(redisClient),
 *   eventTransport: new RedisPubSubTransport(redisClient),
 * });
 * ```
 */
class GenerationJobManagerClass {
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private jobStore: IJobStoreV2;
  /** Guarded human-review lifecycle (pause / resolve / expire) over the store. */
  private _approvals: ApprovalLifecycle;
  /** FIFO steering queue (enqueue / drain / peek / clear) over the store. */
  private _steering: SteeringLifecycle;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private eventTransport: IEventTransport;

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  /** Jobs actively owned by this process, pinned to their durable creation epoch. */
  private ownedJobs = new Map<string, number>();

  /** Serializes replay-event read/modify/write updates per stream. */
  private replayEventWriteQueues = new Map<string, Promise<void>>();

  /** Serializes token-usage read/modify/write updates per stream. */
  private tokenUsageWriteQueues = new Map<string, Promise<void>>();

  /** Serializes whole-array run-step snapshots so an older save cannot overwrite completion. */
  private runStepWriteQueues = new Map<string, Promise<void>>();

  /** Coalesces reconnects waiting on the same owner-side overflow flush. */
  private earlyBufferOverflowWaiters = new Map<string, Promise<SerializableJobData | null>>();

  /** Partial-response and disconnect-state writes still draining during shutdown. */
  private subscriberCleanupPromises = new Set<Promise<void>>();

  /** Makes terminal cleanup idempotent while keeping claims opaque to callers. */
  private terminalFinishPromises = new WeakMap<TerminalJobClaim, Promise<void>>();
  private generationSettledListeners = new Set<GenerationSettledListener>();

  /** Exact local runtime observed when a claim won; never clean a later runtime. */
  private terminalClaimRuntimes = new WeakMap<TerminalJobClaim, RuntimeJobState | null>();

  /** Claims whose durable final exists but whose DONE transport publication
   * failed. Retain their job record through normal finish so the forced
   * reconnect can replay that authoritative final payload. */
  private terminalPublicationFailures = new WeakSet<TerminalJobClaim>();

  /** Persistence-pending error claims whose terminal output was already
   * reconciled by a competing owner or stale-owner recovery. */
  private terminalErrorPublicationSuppressions = new WeakSet<TerminalJobClaim>();

  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Generation-scoped retirement callbacks must not outlive the configured
   * store/transport pair that created them. */
  private fencedRuntimeRetirements = new Map<RuntimeJobState, FencedRuntimeRetirementContext>();

  /** Suppresses the stream-global disconnect callback while an exact fenced
   * predecessor detaches. The callback may otherwise target a same-stream
   * successor that never owned the departing SSE response. */
  private fencedSubscriberDetachments = new Set<string>();

  /** Rejects new jobs once graceful shutdown has started. */
  private shuttingDown = false;

  /**
   * Provider executions this process has begun and not yet drained, awaited during shutdown so
   * each can record its own drain once its trailing writes settle. Opened in
   * `beginProviderExecution` and closed in `markProviderExecutionDrained` — the two chokepoints
   * every entry point (interactive, resume, remote API) already passes through — so no caller
   * has to remember to register, and a new entry point cannot silently opt out.
   */
  private readonly openProviderExecutions = new Map<
    string,
    { promise: Promise<void>; settle: () => void }
  >();

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether streaming-delta publish/append coalescing is enabled (Redis only).
   * Off (the default) preserves the awaited per-event emitChunk contract exactly. */
  private _deltaCoalescingEnabled = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;

  /** Optional host hook; the generic stream runtime does not know what external
   * durable work (scheduled chats, webhooks, etc.) a generation represents. */
  private approvalExpiredHandler: ApprovalExpiredHandler | undefined;
  private terminalHostActionHandler: TerminalHostActionHandler | undefined;

  constructor(options?: GenerationJobManagerOptions) {
    const jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    assertJobStoreV2(jobStore);
    this.jobStore = jobStore;
    this._approvals = this.createApprovalLifecycle(this.jobStore);
    this._steering = new SteeringLifecycle(this.jobStore);
    this.eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }

  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  initialize(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.jobStore.initialize();

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[GenerationJobManager] Initialized');
  }

  /**
   * Configure the manager with custom stores.
   * Call this BEFORE initialize() to use Redis or other stores.
   *
   * @example Using Redis
   * ```ts
   * import { createStreamServicesFromCache } from '~/stream/createStreamServices';
   * import { cacheConfig, ioredisClient } from '~/cache';
   *
   * const services = createStreamServicesFromCache({ cacheConfig, ioredisClient });
   * GenerationJobManager.configure(services);
   * GenerationJobManager.initialize();
   * ```
   */
  configure(services: {
    jobStore: IJobStore;
    eventTransport: IEventTransport;
    isRedis?: boolean;
    cleanupOnComplete?: boolean;
  }): void {
    assertJobStoreV2(services.jobStore);
    this.cancelFencedRuntimeRetirements();
    const previousStore = this.storeLabel;
    if (this.cleanupInterval) {
      logger.warn(
        '[GenerationJobManager] Reconfiguring after initialization - destroying existing services',
      );
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;

      const replacedJobStore = this.jobStore;
      const replacedEventTransport = this.eventTransport;
      const pendingSubscriberCleanups = [...this.subscriberCleanupPromises];
      for (const runtime of this.runtimeState.values()) {
        runtime.startupTelemetry?.end('aborted');
        runtime.startupTelemetry = undefined;
        this.stopSubscriberLease(runtime);
        this.releaseAbortSubscription(runtime, true);
        runtime.abortController.abort();
      }

      // Detach the old transport synchronously so it cannot deliver into a replacement runtime.
      // Its store can finish draining already-started disconnect persistence in the background.
      try {
        replacedEventTransport.destroy();
      } catch (err) {
        logger.error('[GenerationJobManager] Failed to destroy replaced event transport:', err);
      }
      void Promise.allSettled(pendingSubscriberCleanups)
        .then(() => replacedJobStore.destroy())
        .catch((err) => {
          logger.error('[GenerationJobManager] Failed to destroy replaced job store:', err);
        });

      this.runtimeState.clear();
      this.subscriberCleanupPromises.clear();
      this.runStepBuffers?.clear();
      this.replayEventWriteQueues.clear();
      this.tokenUsageWriteQueues.clear();
      this.runStepWriteQueues.clear();
      this.earlyBufferOverflowWaiters.clear();
    }

    this.ownedJobs.clear();
    /** The trackers belong to the services being replaced; a stale one would make a later
     *  graceful destroy() wait its whole budget on an execution that can never drain. */
    this.releaseOpenProviderExecutions();
    setGenerationJobsInFlight(previousStore, 0);

    this.jobStore = services.jobStore;
    this._approvals = this.createApprovalLifecycle(this.jobStore);
    this._steering = new SteeringLifecycle(this.jobStore);
    this.eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    /** Coalescing needs BOTH configured services to actually batch: the flush
     * capabilities are how implementations advertise it. A custom transport
     * without them would silently lose the awaited per-event ordering contract
     * (its receipts are un-awaited on the coalescable path), and a batching
     * transport over a per-event store would let the durable log trail the
     * sequence counter by a full window, breaking the resume frontier. */
    this._deltaCoalescingEnabled =
      this._isRedis &&
      resolveCoalesceWindowMs() > 0 &&
      typeof services.eventTransport.flushPendingChunks === 'function' &&
      typeof services.jobStore.flushPendingAppends === 'function';
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.shuttingDown = false;
    this.syncRunningJobMetrics();

    logger.info(
      `[GenerationJobManager] Configured with ${this._isRedis ? 'Redis' : 'in-memory'} stores`,
    );
  }

  /**
   * Check if using Redis stores.
   */
  get isRedis(): boolean {
    return this._isRedis;
  }

  /**
   * Store-selected detached Event Actor execution guarantee. In-memory stores
   * support the same lifecycle within one process; Redis additionally makes it
   * recoverable across restarts and replica handoffs.
   */
  get detachedAgentEventActionStoreMode(): DetachedAgentEventActionStoreMode | undefined {
    return this.jobStore.detachedAgentEventActionStoreMode;
  }

  get supportsDetachedAgentEventActions(): boolean {
    return this.detachedAgentEventActionStoreMode != null;
  }

  /** Installs the application-owned approval-expiry hook without coupling the
   * stream package to any particular trigger/scheduler implementation. */
  setApprovalExpiredHandler(handler?: ApprovalExpiredHandler): void {
    this.approvalExpiredHandler = handler;
  }

  /** Installs a durable, generation-fenced terminal lifecycle adapter. */
  setTerminalHostActionHandler(handler?: TerminalHostActionHandler): void {
    this.terminalHostActionHandler = handler;
  }

  /**
   * Event-driven retry for a durable terminal host action whose external
   * evidence arrived after the generation itself became terminal. The exact
   * generation fence prevents a delayed callback from touching a replacement;
   * the periodic recovery sweep remains the restart/replica fallback.
   */
  async retryTerminalHostAction(streamId: string, expectedCreatedAt: number): Promise<boolean> {
    const job = await this.jobStore.getJob(streamId);
    if (
      job?.createdAt !== expectedCreatedAt ||
      job.status === 'running' ||
      job.status === 'requires_action' ||
      job.providerDrained === false ||
      job.terminalHostActionPending !== true
    ) {
      return false;
    }
    return this.runTerminalHostActionHandler(streamId, job);
  }

  private get storeLabel(): GenerationJobStore {
    return this._isRedis ? 'redis' : 'memory';
  }

  private syncRunningJobMetrics(store: GenerationJobStore = this.storeLabel): void {
    setGenerationJobsInFlight(store, this.ownedJobs.size);
  }

  private createApprovalLifecycle(store: IJobStoreV2): ApprovalLifecycle {
    return new ApprovalLifecycle(store, {
      onPaused: (streamId, createdAt) => this.releaseJobOwnership(streamId, createdAt),
      onResumed: (streamId, createdAt) => this.acquireResumedJobOwnership(streamId, createdAt),
      onExpired: (streamId, createdAt) => this.releaseJobOwnership(streamId, createdAt),
      onPausePersistenceFailed: (streamId, createdAt, error, drainedSteers) =>
        this.finishTimedOutPausePersistence(streamId, createdAt, error, drainedSteers, true),
    });
  }

  /**
   * The approval lifecycle already won the exact barrier-to-error CAS. Reuse
   * the normal terminal finisher so attached clients receive the durable error
   * and every runtime/ownership resource is retired with the same epoch guards
   * as an ordinary generation failure.
   */
  private async finishTimedOutPausePersistence(
    streamId: string,
    createdAt: number,
    error: string,
    drainedSteers: SteerQueueItem[],
    transitionWonLocally = false,
  ): Promise<void> {
    const observedRuntime = this.runtimeState.get(streamId);
    const runtime = observedRuntime?.createdAt === createdAt ? observedRuntime : undefined;
    if (runtime?.pausePersistenceTimeoutRetired === true) {
      return;
    }
    const job = await this.jobStore.getJob(streamId);
    if (job?.createdAt !== createdAt) {
      /** A locally-won CAS may have used a zero completed TTL, or a
       * replacement may have landed before this follow-up read. The claim's
       * generation tag still makes publication/runtime cleanup safe. A relay,
       * by contrast, needs the durable timeout row as its proof. */
      if (!transitionWonLocally) {
        this.reconcileInactiveGeneration(streamId, createdAt, job, runtime);
        return;
      }
    }
    if (job?.createdAt === createdAt && (job.status !== 'error' || job.error !== error)) {
      return;
    }

    if (runtime) {
      runtime.pausePersistenceTimeoutRetired = true;
    }

    const claim: TerminalJobClaim = Object.freeze({
      streamId,
      createdAt,
      ...(job?.createdAt === createdAt &&
        job.conversationId != null && { conversationId: job.conversationId }),
      ...(job?.createdAt === createdAt && job.userId != null && { userId: job.userId }),
      status: 'error' as const,
      error,
      drainedSteers: Object.freeze([...drainedSteers]),
    });
    this.terminalClaimRuntimes.set(claim, runtime ?? null);
    await this.finishTerminalJob(claim);
  }

  private acquireJobOwnership(streamId: string, createdAt: number): void {
    this.ownedJobs.set(streamId, createdAt);
    this.syncRunningJobMetrics();
  }

  private acquireResumedJobOwnership(streamId: string, createdAt: number): void {
    const ownedCreatedAt = this.ownedJobs.get(streamId);
    if (ownedCreatedAt != null && ownedCreatedAt !== createdAt) {
      return;
    }
    this.acquireJobOwnership(streamId, createdAt);
  }

  private releaseJobOwnership(streamId: string, expectedCreatedAt?: number): boolean {
    if (expectedCreatedAt != null && this.ownedJobs.get(streamId) !== expectedCreatedAt) {
      return false;
    }
    const released = this.ownedJobs.delete(streamId);
    if (released) {
      this.syncRunningJobMetrics();
    }
    return released;
  }

  /**
   * Releases this generation's cross-replica listeners — abort AND preempt —
   * and drops any armed preempt requests. Every terminal site that retires a
   * runtime goes through here, so preempt state cannot outlive the
   * generation it belongs to.
   */
  private releaseAbortSubscription(runtime: RuntimeJobState, force = false): void {
    if (runtime.replacementTransportHold === true && !force) {
      return;
    }
    if (force) {
      runtime.replacementTransportHold = false;
    }
    this.releasePreemptSubscription(runtime, force);
    const unsubscribe = runtime.abortUnsubscribe;
    runtime.abortUnsubscribe = undefined;
    if (!unsubscribe) {
      return;
    }

    try {
      unsubscribe();
    } catch (err) {
      logger.error('[GenerationJobManager] Failed to release abort subscription:', err);
    }
  }

  private releasePreemptSubscription(runtime: RuntimeJobState, force = false): void {
    if (runtime.replacementTransportHold === true && !force) {
      return;
    }
    runtime.preempt = undefined;
    const unsubscribe = runtime.preemptUnsubscribe;
    runtime.preemptUnsubscribe = undefined;
    if (!unsubscribe) {
      return;
    }

    try {
      unsubscribe();
    } catch (err) {
      logger.error('[GenerationJobManager] Failed to release preempt subscription:', err);
    }
  }

  private reconcileInactiveGeneration(
    streamId: string,
    createdAt: number,
    currentJob: SerializableJobData | null,
    observedRuntime?: RuntimeJobState,
  ): void {
    if (currentJob?.createdAt === createdAt) {
      if (currentJob.status === 'running') {
        return;
      }
      if (currentJob.status === 'requires_action') {
        this.releaseJobOwnership(streamId, createdAt);
        return;
      }
    }

    if (
      observedRuntime?.createdAt === createdAt &&
      this.runtimeState.get(streamId) === observedRuntime
    ) {
      this.releaseAbortSubscription(observedRuntime);
      observedRuntime.abortController.abort();
    }
    this.releaseJobOwnership(streamId, createdAt);
  }

  private async reconcileLostTerminalTransition(
    streamId: string,
    createdAt: number,
    observedRuntime?: RuntimeJobState,
  ): Promise<void> {
    const currentJob = await this.jobStore.getJob(streamId);
    this.reconcileInactiveGeneration(streamId, createdAt, currentJob, observedRuntime);
  }

  private async reconcileFencedRuntimeHandoff(
    streamId: string,
    runtime: RuntimeJobState,
    currentJob: SerializableJobData | null,
  ): Promise<void> {
    const ownsExactProvider = this.ownedJobs.get(streamId) === runtime.createdAt;
    if (!runtime.abortController.signal.aborted) {
      runtime.abortController.abort();
    }
    const abortProofPersisted = await this.persistFencedRuntimeAbortProof(
      streamId,
      runtime,
      ownsExactProvider,
    );
    if (abortProofPersisted) {
      this.reconcileInactiveGeneration(streamId, runtime.createdAt, currentJob, runtime);
    }
    this.preserveFencedRuntimeUntilHandoff(streamId, runtime);
  }

  /** Promotes a terminal claim whose persistence owner disappeared to a conservative
   * terminal payload. The store CAS races safely with a slow owner: whichever
   * side finalizes first chooses the only payload subscribers may consume. */
  private async recoverStaleTerminalPersistence(
    jobData: SerializableJobData,
  ): Promise<SerializableJobData | null> {
    if (
      jobData.terminalPersistencePending !== true ||
      !['complete', 'error', 'aborted'].includes(jobData.status)
    ) {
      return jobData;
    }
    const startedAt =
      jobData.terminalPersistenceStartedAt ?? jobData.completedAt ?? jobData.createdAt;
    if (Date.now() - startedAt < TERMINAL_PERSISTENCE_TIMEOUT_MS) {
      return jobData;
    }
    const observedRuntime = this.runtimeState.get(jobData.streamId);
    let runtime = observedRuntime?.createdAt === jobData.createdAt ? observedRuntime : undefined;
    /** Preserve the pre-await object when one exists, but also admit a predecessor
     * attachment created while terminal finalization is in flight. Every late
     * read remains generation-fenced, so a successor runtime is never captured. */
    const captureMatchingRuntime = (): RuntimeJobState | undefined => {
      if (runtime) {
        return runtime;
      }
      const candidate = this.runtimeState.get(jobData.streamId);
      if (candidate?.createdAt === jobData.createdAt) {
        runtime = candidate;
      }
      return runtime;
    };

    const reconcileEvent = buildTerminalPersistenceReconcile(jobData);
    const serialized = JSON.stringify(reconcileEvent);
    const recovered = await this.jobStore.finalizeTerminalPersistence(
      jobData.streamId,
      jobData.createdAt,
      serialized,
    );
    if (!recovered) {
      const currentJob = await this.jobStore.getJob(jobData.streamId);
      const predecessorRuntime = captureMatchingRuntime();
      if (predecessorRuntime && currentJob?.createdAt !== jobData.createdAt) {
        await this.reconcileFencedRuntimeHandoff(jobData.streamId, predecessorRuntime, currentJob);
      }
      return currentJob;
    }

    const recoveredRuntime = captureMatchingRuntime();
    if (recoveredRuntime) {
      recoveredRuntime.finalEvent = reconcileEvent;
    }
    try {
      await this.eventTransport.emitDone(jobData.streamId, reconcileEvent, jobData.createdAt);
    } catch (err) {
      if (err instanceof GenerationPublicationFencedError) {
        const currentJob = await this.jobStore.getJob(jobData.streamId);
        const predecessorRuntime = captureMatchingRuntime();
        if (predecessorRuntime) {
          await this.reconcileFencedRuntimeHandoff(
            jobData.streamId,
            predecessorRuntime,
            currentJob,
          );
        } else {
          this.reconcileInactiveGeneration(jobData.streamId, jobData.createdAt, currentJob);
        }
        return currentJob;
      }
      logger.error(
        `[GenerationJobManager] Failed to publish stale terminal-persistence recovery ${jobData.streamId}:`,
        err,
      );
    }
    return {
      ...jobData,
      terminalPersistencePending: false,
      finalEvent: serialized,
    };
  }

  private async registerAbortSubscription(
    streamId: string,
    runtime: RuntimeJobState,
  ): Promise<void> {
    if (!this.eventTransport.onAbort) {
      return;
    }

    const unsubscribe = await this.eventTransport.onAbort(streamId, (generationId) => {
      const currentRuntime = this.runtimeState.get(streamId);
      if (
        currentRuntime !== runtime ||
        (generationId != null && currentRuntime.createdAt !== generationId)
      ) {
        return false;
      }

      const ownsProvider = this.ownedJobs.get(streamId) === currentRuntime.createdAt;
      if (!currentRuntime.abortController.signal.aborted) {
        logger.debug(`[GenerationJobManager] Received cross-replica abort for ${streamId}`);
        currentRuntime.abortController.abort();
        this.releaseAbortSubscription(currentRuntime);
      }
      return ownsProvider;
    });

    if (typeof unsubscribe === 'function') {
      runtime.abortUnsubscribe = unsubscribe;
    }
    if (this.runtimeState.get(streamId) !== runtime || runtime.abortController.signal.aborted) {
      this.releaseAbortSubscription(runtime);
    }
  }

  private ensurePreemptState(
    runtime: RuntimeJobState,
    createdAt: number,
  ): NonNullable<RuntimeJobState['preempt']> {
    runtime.preempt ??= {
      createdAt,
      ids: new Set(),
      cleared: new Set(),
      minArmRevision: new Map(),
    };
    return runtime.preempt;
  }

  /**
   * Arms ids that have not already been observed as removed. Returns how many
   * were actually accepted: a tombstoned id (its steer already drained at an
   * ordinary boundary while this request was in flight) or an over-cap id is
   * skipped, and the caller must not report those as armed.
   */
  private armPreemptIds(
    runtime: RuntimeJobState,
    createdAt: number,
    steerIds: string[],
    revisions?: Record<string, number>,
  ): number {
    const state = this.ensurePreemptState(runtime, createdAt);
    let accepted = 0;
    for (const id of steerIds) {
      const revision = revisions?.[id] ?? 0;
      if (
        state.cleared.has(id) ||
        revision < (state.minArmRevision.get(id) ?? 0) ||
        state.ids.size >= STEER_QUEUE_MAX_DEPTH
      ) {
        continue;
      }
      state.ids.add(id);
      accepted += 1;
    }
    if (accepted > 0) {
      this.notePreemptArmed(state);
    }
    return accepted;
  }

  /**
   * Wakes the live model attempt after an accepted arm. Called for local and
   * cross-replica arms alike, since both land here through `armPreemptIds`.
   *
   * Errors are swallowed per listener: a wake is an optimization over the
   * per-chunk poll, and a throwing listener must not fail the arm that a
   * queued steer already depends on.
   */
  private notePreemptArmed(state: NonNullable<RuntimeJobState['preempt']>): void {
    if (state.wakes == null) {
      return;
    }
    for (const wake of state.wakes) {
      try {
        wake();
      } catch (error) {
        logger.error('[GenerationJobManager] Preempt wake listener failed:', error);
      }
    }
  }

  /**
   * Registers a wake listener for the SDK's `StreamPreemption.subscribe`.
   * Returns the unsubscribe the SDK calls when the model attempt ends.
   *
   * Fenced on `createdAt` like every other preempt entry point: a run wiring
   * itself to a replaced generation must not be woken by the replacement's
   * arms. A mismatch yields an inert unsubscribe rather than throwing, so the
   * run still starts — it simply falls back to the per-chunk poll.
   *
   * An arm that ALREADY happened is replayed on registration. Requests are
   * level-triggered, and the window between a job becoming steerable and the
   * SDK installing its listener is real: an interrupt landing there would be
   * recorded with no callbacks to notify, and on a silent or reasoning-only
   * turn no later chunk poll may ever run — the exact stall this channel
   * exists to remove. The replay makes the host correct on its own terms
   * rather than resting on when the SDK first reads the flag.
   */
  subscribePreempt(streamId: string, wake: () => void, jobCreatedAt?: number): () => void {
    const runtime = this.runtimeState.get(streamId);
    if (runtime == null || (jobCreatedAt != null && runtime.createdAt !== jobCreatedAt)) {
      return () => {};
    }
    const state = this.ensurePreemptState(runtime, jobCreatedAt ?? runtime.createdAt);
    state.wakes ??= new Set();
    const wakes = state.wakes;
    wakes.add(wake);
    if (state.ids.size > 0) {
      /** Only the new listener, and only after it is registered: waking the
       *  whole set would re-notify runs that already looked, and waking before
       *  registration would leave a concurrent arm with nowhere to land. */
      this.notePreemptArmed({ ...state, wakes: new Set([wake]) });
    }
    return () => {
      wakes.delete(wake);
    };
  }

  /** Non-terminal disarm used by a capable→incapable owner handover. The
   * queue item remains valid, so this records a revision floor instead of the
   * permanent removal tombstone used by `clearPreemptIds`. */
  private downgradePreemptIds(
    runtime: RuntimeJobState,
    createdAt: number,
    steers: Array<{ steerId: string; preemptRevision?: number }>,
  ): void {
    const state = this.ensurePreemptState(runtime, createdAt);
    for (const steer of steers) {
      state.ids.delete(steer.steerId);
      state.minArmRevision.set(steer.steerId, (steer.preemptRevision ?? 0) + 1);
    }
  }

  /**
   * Disarms ids and tombstones them against a late-arriving arm. The
   * tombstone set is bounded by EVICTING its oldest entry rather than
   * refusing new ones: every drained or cancelled steer is tombstoned, not
   * just preempting ones, so a refusing cap would silently stop recording
   * after a long generation and let the late-arm race resurface. Set
   * iteration is insertion-ordered, so the first key is the oldest.
   */
  private clearPreemptIds(runtime: RuntimeJobState, createdAt: number, steerIds: string[]): void {
    const state = this.ensurePreemptState(runtime, createdAt);
    for (const id of steerIds) {
      state.ids.delete(id);
      if (state.cleared.has(id)) {
        continue;
      }
      if (state.cleared.size >= PREEMPT_TOMBSTONE_MAX) {
        const oldest = state.cleared.values().next().value;
        if (oldest != null) {
          state.cleared.delete(oldest);
        }
      }
      state.cleared.add(id);
    }
  }

  /**
   * Pub/sub delivery is not durable: an ARM can sit in a subscriber buffer
   * until after the steer drained and a handover reconciliation observed an
   * empty queue. Re-check the generation-fenced queue on receipt so that late
   * message cannot resurrect an interrupt with no payload behind it.
   *
   * The durable revision, rather than the publication's revision, is used for
   * a still-preempting item. This preserves liveness when an older duplicate
   * arrives after a later explicit arm, while `preempt: false` advances the
   * local floor and keeps a pre-downgrade publication from re-arming it.
   */
  private async validateAndArmPreemptMessage(
    streamId: string,
    runtime: RuntimeJobState,
    msg: PreemptMessage,
  ): Promise<void> {
    const queued = await this._steering.peek(streamId, msg.createdAt);
    const currentRuntime = this.runtimeState.get(streamId);
    if (currentRuntime !== runtime || currentRuntime.createdAt !== msg.createdAt) {
      return;
    }

    const queuedById = new Map(queued.map((item) => [item.steerId, item]));
    const backedIds: string[] = [];
    const backedRevisions: Record<string, number> = {};
    const removedIds: string[] = [];
    const downgraded: SteerQueueItem[] = [];

    for (const steerId of msg.steerIds) {
      const item = queuedById.get(steerId);
      if (item == null) {
        removedIds.push(steerId);
        continue;
      }
      if (item.preempt !== true) {
        downgraded.push(item);
        continue;
      }

      const durableRevision = item.preemptRevision ?? 0;
      const publishedRevision = msg.revisions?.[steerId] ?? 0;
      if (publishedRevision > durableRevision) {
        /** The publication cannot be backed by this authoritative snapshot. */
        continue;
      }
      backedIds.push(steerId);
      backedRevisions[steerId] = durableRevision;
    }

    if (removedIds.length > 0) {
      this.clearPreemptIds(currentRuntime, msg.createdAt, removedIds);
    }
    if (downgraded.length > 0) {
      this.downgradePreemptIds(currentRuntime, msg.createdAt, downgraded);
    }
    if (backedIds.length > 0) {
      /** A local drain/CLEAR during the queue read has already tombstoned the
       * id, and `armPreemptIds` re-checks that state synchronously here. */
      this.armPreemptIds(currentRuntime, msg.createdAt, backedIds, backedRevisions);
    }
  }

  /**
   * Mirrors {@link registerAbortSubscription} for cooperative preempts. The
   * same double fence applies — runtime object identity plus the generation
   * `createdAt` carried by every {@link PreemptMessage} — so a stale
   * cross-replica publish can never arm a replacement job on the same
   * streamId. Arm requests cap at {@link STEER_QUEUE_MAX_DEPTH}, matching
   * the durable queue they mirror.
   *
   * Never rejects. Every caller fires this without awaiting (see the
   * createJob registration for why), so a propagating subscription error
   * would surface as an unhandled rejection: an alarming stack trace in
   * LibreChat's own server, which installs a global handler and keeps
   * serving, and a dead process for any other consumer of this package,
   * which under Node's default `--unhandled-rejections=throw` does not.
   * Neither is warranted — a failed subscription degrades this generation's
   * preemptive steers to the next tool boundary, the documented fallback.
   */
  private async registerPreemptSubscription(
    streamId: string,
    runtime: RuntimeJobState,
  ): Promise<void> {
    if (!this.eventTransport.onPreempt) {
      return;
    }

    try {
      const unsubscribe = await this.eventTransport.onPreempt(streamId, (msg) => {
        const currentRuntime = this.runtimeState.get(streamId);
        if (currentRuntime !== runtime || currentRuntime.createdAt !== msg.createdAt) {
          return;
        }

        if (msg.op === 'clear') {
          this.clearPreemptIds(currentRuntime, msg.createdAt, msg.steerIds);
          return;
        }

        void this.validateAndArmPreemptMessage(streamId, runtime, msg).catch((error) => {
          logger.error(
            `[GenerationJobManager] Failed to validate preempt arm for ${streamId}; ` +
              'the queued steer will apply at the next tool boundary:',
            error,
          );
        });
      });

      if (typeof unsubscribe === 'function') {
        runtime.preemptUnsubscribe = unsubscribe;
      }
      if (this.runtimeState.get(streamId) !== runtime || runtime.abortController.signal.aborted) {
        this.releasePreemptSubscription(runtime);
      }
    } catch (err) {
      logger.error(
        `[GenerationJobManager] Failed to subscribe to preempts for ${streamId}; ` +
          'steers on this generation will apply at the next tool boundary:',
        err,
      );
    }
  }

  private rejectSubscriptionDuringShutdown(
    subscriptionType: 'initial' | 'resume',
    onError?: t.ErrorHandler,
  ): boolean {
    if (!this.shuttingDown) {
      return false;
    }

    recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
    onError?.(SHUTDOWN_SUBSCRIBER_ERROR);
    return true;
  }

  private detachSubscriptionDuringShutdown(
    subscription: { unsubscribe: t.UnsubscribeFn } | null,
  ): boolean {
    if (!this.shuttingDown) {
      return false;
    }

    subscription?.unsubscribe();
    return true;
  }

  private registerAllSubscribersLeft(streamId: string): void {
    this.eventTransport.onAllSubscribersLeft(streamId, () => {
      if (this.fencedSubscriberDetachments.has(streamId)) {
        return;
      }
      const runtime = this.runtimeState.get(streamId);
      if (!runtime) {
        return;
      }

      runtime.syncSent = false;
      runtime.hasSubscriber = false;
      runtime.attachmentGeneration++;
      runtime.lastSubscriberCleanupGeneration = runtime.attachmentGeneration;
      this.stopSubscriberLease(runtime);

      runtime.subscriberStateWrite = (runtime.subscriberStateWrite ?? Promise.resolve())
        .then(async () => {
          if (!runtime.subscriberStateAttached) {
            return;
          }
          await this.jobStore.detachSubscriber(
            streamId,
            runtime.createdAt,
            runtime.subscriberLeaseId,
          );
          runtime.subscriberStateAttached = false;
        })
        .catch((detachError) => {
          logger.error(
            '[GenerationJobManager] Failed to persist subscriber detachment',
            detachError,
          );
        });

      // Terminal delivery closes the SSE subscription too, but it is not a user
      // disconnect. Running partial-response handlers here can overwrite the
      // already-saved final response as unfinished.
      if (runtime.finalEvent || runtime.errorEvent) {
        return;
      }

      if (runtime.everHadSubscriber) {
        recordGenerationStreamAttachment(this.storeLabel, 'disconnected');
      }

      const cleanup = Promise.all([
        runtime.subscriberStateWrite,
        this.persistSubscriberCleanup(streamId, runtime),
      ]).then(() => undefined);
      this.subscriberCleanupPromises.add(cleanup);
      void cleanup.then(
        () => this.subscriberCleanupPromises.delete(cleanup),
        (err) => {
          this.subscriberCleanupPromises.delete(cleanup);
          logger.error(`[GenerationJobManager] Failed to clean up disconnected subscriber:`, err);
        },
      );
    });
  }

  private stopSubscriberLease(runtime: RuntimeJobState): void {
    if (runtime.subscriberLeaseTimer != null) {
      clearInterval(runtime.subscriberLeaseTimer);
      runtime.subscriberLeaseTimer = undefined;
    }
  }

  private startSubscriberLease(streamId: string, runtime: RuntimeJobState): void {
    if (runtime.subscriberLeaseTimer != null) {
      return;
    }
    runtime.subscriberLeaseTimer = setInterval(() => {
      if (!runtime.hasSubscriber || runtime.subscriberLeaseRenewalPending === true) {
        return;
      }
      runtime.subscriberLeaseRenewalPending = true;
      runtime.subscriberStateWrite = (runtime.subscriberStateWrite ?? Promise.resolve())
        .then(() => {
          const refreshedAt = Date.now();
          return this.jobStore.claimFirstSubscriber(
            streamId,
            runtime.createdAt,
            refreshedAt,
            runtime.subscriberLeaseId,
            refreshedAt + SUBSCRIBER_LEASE_TTL_MS,
          );
        })
        .then((firstSubscriber) => {
          runtime.subscriberStateAttached = true;
          runtime.onFirstSubscriberLeaseClaim?.(firstSubscriber);
          return firstSubscriber;
        })
        .catch((leaseError) => {
          logger.error('[GenerationJobManager] Failed to renew subscriber lease', leaseError);
          return false;
        })
        .finally(() => {
          runtime.subscriberLeaseRenewalPending = false;
        });
    }, SUBSCRIBER_LEASE_REFRESH_MS);
    runtime.subscriberLeaseTimer.unref?.();
  }

  private async persistSubscriberCleanup(
    streamId: string,
    runtime: RuntimeJobState,
  ): Promise<void> {
    const persistSyncState = this.jobStore
      .updateJob(streamId, { syncSent: false }, runtime.createdAt)
      .catch((err) => {
        logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
      });
    const handlers = runtime.allSubscribersLeftHandlers
      ? [...runtime.allSubscribersLeftHandlers]
      : [];

    if (handlers.length === 0) {
      await persistSyncState;
      return;
    }

    try {
      const result = await this.jobStore.getContentParts(streamId, runtime.createdAt);
      const parts = result?.content ?? [];
      const handlerResults = await Promise.allSettled(
        handlers.map((handler) => Promise.resolve().then(() => handler(parts))),
      );
      for (const handlerResult of handlerResults) {
        if (handlerResult.status === 'rejected') {
          logger.error(
            `[GenerationJobManager] Error in allSubscribersLeft handler:`,
            handlerResult.reason,
          );
        }
      }
    } catch (err) {
      logger.error(
        `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers:`,
        err,
      );
    }

    await persistSyncState;
  }

  private async drainSubscriberCleanups(): Promise<void> {
    const pending = [...this.subscriberCleanupPromises];
    if (pending.length === 0) {
      return;
    }

    await Promise.allSettled(pending);
    if (this.subscriberCleanupPromises.size > 0) {
      await this.drainSubscriberCleanups();
    }
  }

  /**
   * Get the job store instance (for advanced use cases).
   */
  getJobStore(): IJobStoreV2 {
    return this.jobStore;
  }

  /**
   * Create a new generation job.
   *
   * This sets up:
   * 1. Serializable job data in the job store
   * 2. Runtime state including the legacy, immediately-resolved readyPromise facade
   * 3. allSubscribersLeft callback for handling client disconnections
   *
   * Generation starts independently of SSE attachment. Early events are buffered locally and,
   * in Redis mode, persisted/published for replay when the client subscribes.
   *
   * @param streamId - Unique identifier for this stream
   * @param userId - User who initiated the request
   * @param conversationId - Optional conversation ID for lookup
   * @returns A facade object for the GenerationJob
   */
  private async notifyReplacedGeneration(
    streamId: string,
    predecessorCreatedAt: number,
    predecessorConversationId?: string,
    fallbackConversationId?: string,
    replacementCreationAttemptId?: string,
    stopProvider = true,
  ): Promise<boolean> {
    const reconcileEvent: t.ServerSentEvent = {
      final: true,
      reconcile: true,
      reconcileReason: 'generation_replaced',
      generationCreatedAt: predecessorCreatedAt,
      conversation: {
        conversationId: predecessorConversationId ?? fallbackConversationId ?? streamId,
      },
    } satisfies t.FinalEvent;
    const localPredecessor = this.runtimeState.get(streamId);
    const ownsExactLocalProvider =
      localPredecessor?.createdAt === predecessorCreatedAt &&
      this.ownedJobs.get(streamId) === predecessorCreatedAt;
    const stoppedExactLocalProvider = stopProvider && ownsExactLocalProvider;
    if (localPredecessor?.createdAt === predecessorCreatedAt) {
      localPredecessor.finalEvent = reconcileEvent;
      if (stopProvider) {
        // The durable replacement transaction has already removed this active
        // epoch. Retire its local provider immediately, before any fallible
        // cross-node publication. A terminal receipt, however, has no live
        // provider and may still be completing required persistence locally.
        localPredecessor.startupTelemetry?.end('replaced');
        localPredecessor.startupTelemetry = undefined;
        localPredecessor.replacementTransportHold = true;
        localPredecessor.abortController.abort();
        // Keep its transport registrations until the successor's abort
        // subscription is active. Removing the last callback while an older
        // registration is still resolving can unsubscribe the shared Redis
        // channel, then strand the successor in the resubscribe gap.
      }
    }
    // Stop the provider before closing attached clients. Both signals are
    // generation-tagged and serve different consumers; this ordering keeps a
    // remote owner from emitting a last post-handoff chunk.
    let delivered = true;
    if (stopProvider && !stoppedExactLocalProvider) {
      try {
        if (!this._isRedis) {
          // Multiple managers can share an in-memory transport in one process.
          // Best-effort delivery stops an exact predecessor owned by another
          // manager; only Redis handoffs require the durable owner proof below.
          this.eventTransport.emitAbort?.(streamId, predecessorCreatedAt);
        } else if (this.eventTransport.emitAbortConfirmed != null) {
          const ownerAcknowledged = await this.eventTransport.emitAbortConfirmed(
            streamId,
            predecessorCreatedAt,
          );
          if (!ownerAcknowledged) {
            throw new Error('Generation owner did not acknowledge the replacement abort');
          }
        } else {
          throw new Error('Event transport cannot confirm generation-owner aborts');
        }
      } catch (err) {
        delivered = false;
        logger.error(
          `[GenerationJobManager] Failed to stop replaced generation ${streamId}@${predecessorCreatedAt}:`,
          err,
        );
      }
    }
    try {
      if (
        replacementCreationAttemptId != null &&
        this.eventTransport.emitReplacedDoneConfirmed != null
      ) {
        await this.eventTransport.emitReplacedDoneConfirmed(
          streamId,
          reconcileEvent,
          predecessorCreatedAt,
          replacementCreationAttemptId,
        );
      } else {
        await this.eventTransport.emitDone(streamId, reconcileEvent, predecessorCreatedAt);
      }
    } catch (err) {
      delivered = false;
      if (!(err instanceof GenerationPublicationFencedError)) {
        logger.error(
          `[GenerationJobManager] Failed to notify replaced generation ${streamId}@${predecessorCreatedAt}:`,
          err,
        );
      }
    }
    return delivered;
  }

  /** Finish local resource cleanup when a replacement cannot be exposed after
   * it already stopped the previous provider. The epoch and object checks keep
   * this from touching a newer runtime installed during any preceding await. */
  private retireStoppedPredecessorRuntime(streamId: string, replacementCreatedAt: number): void {
    const predecessor = this.runtimeState.get(streamId);
    if (
      predecessor == null ||
      predecessor.createdAt >= replacementCreatedAt ||
      !predecessor.abortController.signal.aborted
    ) {
      return;
    }
    if (this.runtimeState.get(streamId) === predecessor) {
      this.stopSubscriberLease(predecessor);
      this.runtimeState.delete(streamId);
      this.releaseJobOwnership(streamId, predecessor.createdAt);
      this.releaseAbortSubscription(predecessor, true);
      this.runStepBuffers?.delete(streamId);
      this.replayEventWriteQueues.delete(streamId);
      this.tokenUsageWriteQueues.delete(streamId);
      this.runStepWriteQueues.delete(streamId);
      this.jobStore.clearContentState(streamId, predecessor.createdAt);
      try {
        // The replacement cannot be exposed, so neither generation can
        // safely finish this connection. Delete runtime ownership before
        // closing: allSubscribersLeft may run synchronously and must not
        // persist a partial response for the already-replaced predecessor.
        this.eventTransport.closeLocalSubscribers?.(streamId, TERMINAL_PUBLICATION_RECONNECT_ERROR);
      } catch (error) {
        logger.error(
          `[GenerationJobManager] Failed to recycle subscribers for stopped predecessor ${streamId}:`,
          error,
        );
      }
    }
  }

  /** Deliver every transaction-time predecessor receipt retained by the
   * current creation attempt, then epoch/attempt-fenced acknowledge only the
   * receipts whose provider/client handoff completed. A replacement racing the
   * acknowledgement inherits the still-unacknowledged chain and retries it. */
  private async processDurableReplacementReceipts(
    streamId: string,
    job: CreatedJobData,
    fallbackConversationId?: string,
    acknowledgeOwnedReceipts = true,
  ): Promise<boolean> {
    const receipts = job.replacedJobs ?? (job.replacedJob != null ? [job.replacedJob] : []);
    if (receipts.length === 0) {
      return true;
    }

    const acknowledged: number[] = [];
    let allReceiptsDelivered = true;
    for (const receipt of receipts) {
      // A paused run has already released provider ownership. If resume won
      // before this atomic replacement, the receipt status is running and the
      // resumed owner must acknowledge like any other live provider.
      const hadRunningProvider =
        receipt.status === 'running' && receipt.providerAbortReady !== false;
      let delivered = await this.notifyReplacedGeneration(
        streamId,
        receipt.createdAt,
        receipt.conversationId,
        fallbackConversationId,
        job.creationAttemptId,
        hadRunningProvider,
      );
      if (delivered && receipt.providerDrained === false) {
        if (!receipt.providerExecutionId) {
          logger.error(
            `[GenerationJobManager] Replacement receipt lacks provider identity: ${streamId}/${receipt.createdAt}`,
          );
          delivered = false;
        } else {
          try {
            await this.waitForProviderExecutionDrain(
              streamId,
              receipt.createdAt,
              receipt.providerExecutionId,
            );
          } catch (error) {
            logger.error(
              `[GenerationJobManager] Replaced provider did not drain: ${streamId}/${receipt.createdAt}`,
              error,
            );
            delivered = false;
          }
        }
      }
      if (delivered) {
        acknowledged.push(receipt.createdAt);
      } else {
        allReceiptsDelivered = false;
      }
    }

    if (
      acknowledged.length > 0 &&
      acknowledgeOwnedReceipts &&
      job.creationAttemptId != null &&
      this.jobStore.acknowledgeReplacedJobs != null
    ) {
      try {
        await this.jobStore.acknowledgeReplacedJobs(streamId, job.creationAttemptId, acknowledged);
      } catch (error) {
        // The acknowledgement is cleanup, not ownership proof. A lost reply
        // either committed the trim or leaves the receipts for the next
        // replacement to deliver again.
        logger.error(
          `[GenerationJobManager] Failed to acknowledge replacement receipts for ${streamId}:`,
          error,
        );
      }
    }
    return allReceiptsDelivered;
  }

  /** A legacy started-mark EVAL can commit and lose its reply. Probe both
   * mirrors before failing closed: the same-slot primary is authoritative for
   * the full claim lineage, and the legacy key is safe only when it contains
   * that exact lineage plus this job's started epoch/protocol. SET-NX may
   * recreate an unexpectedly missing legacy mirror with the already-started
   * primary value, which establishes the rollout fence before exposure. */
  private async confirmLegacyStartedFence(
    streamId: string,
    userId: string,
    conversationId: string,
    clientRequestId: string,
    claimToken: string,
    job: Pick<SerializableJobData, 'createdAt' | 'generationProtocolVersion'>,
  ): Promise<boolean> {
    const fallback: TokenIdempotencyClaim = {
      streamId,
      conversationId,
      claimedAt: Date.now(),
      claimToken,
      startedAt: job.createdAt,
      generationProtocolVersion: normalizeClaimProtocol(job),
    };
    const primaryResult = await this.jobStore.claimIdempotencyKey(
      this.generationClaimKey(userId, clientRequestId, streamId),
      fallback,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (primaryResult.claimed) {
      // Atomic job creation with an idempotency token must have marked this
      // same-slot key. Recreating it is a conservative tombstone, not proof
      // that the generation was safely admitted.
      return false;
    }
    const primary = normalizeTokenClaim(primaryResult.existing, 'primary started fence');
    assertClaimMatchesRequest(primary, streamId, conversationId);
    if (
      primary.claimToken !== claimToken ||
      primary.startedAt !== job.createdAt ||
      primary.generationProtocolVersion !== normalizeClaimProtocol(job)
    ) {
      return false;
    }

    const legacyResult = await this.jobStore.claimIdempotencyKey(
      this.legacyGenerationClaimKey(userId, clientRequestId),
      primary,
      LEGACY_IDEMPOTENCY_TTL_SECONDS,
    );
    const legacy = legacyResult.claimed
      ? primary
      : normalizeTokenClaim(legacyResult.existing, 'legacy started fence');
    return claimsMirrorExactly(legacy, primary);
  }

  /**
   * A Redis script can commit a job and its started idempotency tombstone, then
   * lose the reply before the store repairs cross-slot membership. Recover only
   * when the durable job's opaque attempt id (and, when present, its started
   * claim) proves this invocation created this owner/tenant/epoch. The same-status transition is
   * intentionally idempotent: besides refreshing the live TTL, Redis uses it to
   * reconcile the running/user membership sets that live outside the stream's
   * cluster slot.
   */
  private async recoverCommittedCreate(
    streamId: string,
    userId: string,
    conversationId: string | undefined,
    tenantId: string | undefined,
    options: CreateGenerationJobOptions,
    creationAttemptId: string,
  ): Promise<CreatedJobData | null> {
    const clientRequestId = options.idempotencyClientRequestId;
    const claimToken = options.idempotencyClaimToken;
    const expectedConversationId = conversationId ?? streamId;
    const matchesCommittedCreate = (job: SerializableJobData | null): job is CreatedJobData =>
      job != null &&
      job.status === 'running' &&
      (job as CreatedJobData).creationAttemptId === creationAttemptId &&
      job.userId === userId &&
      (job.tenantId ?? undefined) === tenantId &&
      (job.conversationId ?? streamId) === expectedConversationId &&
      (job.idempotencyClientRequestId ?? undefined) === clientRequestId;

    let committedJob = (await this.jobStore.getJob(streamId)) as CreatedJobData | null;
    if (
      committedJob != null &&
      committedJob.userId === userId &&
      (committedJob.tenantId ?? undefined) === tenantId
    ) {
      // Keep a non-null snapshot across the awaited handoff. `committedJob` is
      // mutable because later recovery may refresh it, so TypeScript cannot
      // safely retain a narrowing on that outer binding across the await.
      const currentCommittedJob = committedJob;
      const ownsCommittedCreate = matchesCommittedCreate(currentCommittedJob);
      const predecessorsDelivered = await this.processDurableReplacementReceipts(
        streamId,
        currentCommittedJob,
        conversationId,
        // A superseded/lost-reply helper may deliver the current creator's
        // receipts, but only that exact opaque creation attempt may clear
        // them. Otherwise it can race the owner's stale return value: the
        // helper ACKs first, the owner's replacement-authorized publish is
        // fenced, and the owner incorrectly terminalizes itself.
        ownsCommittedCreate,
      );
      if (ownsCommittedCreate && !predecessorsDelivered) {
        await this.terminalizeUnexposedGeneration(
          streamId,
          currentCommittedJob,
          'Generation predecessor handoff could not be confirmed',
        );
        return null;
      }
    }
    if (!matchesCommittedCreate(committedJob)) {
      return null;
    }

    // Same-slot creation proof comes first. Cross-slot legacy verification may
    // be unavailable after the commit; in that case this exact epoch is
    // terminalized below instead of leaving a provider-less running ghost.
    if (clientRequestId != null && claimToken != null) {
      try {
        const primaryKey = this.generationClaimKey(userId, clientRequestId, streamId);
        const primaryFallback: TokenIdempotencyClaim = {
          streamId,
          conversationId: expectedConversationId,
          claimedAt: Date.now(),
          claimToken,
          startedAt: committedJob.createdAt,
          generationProtocolVersion: normalizeClaimProtocol(committedJob),
        };
        const primaryResult = await this.jobStore.claimIdempotencyKey(
          primaryKey,
          primaryFallback,
          IDEMPOTENCY_TTL_SECONDS,
        );
        const primary = primaryResult.claimed
          ? primaryFallback
          : normalizeTokenClaim(primaryResult.existing, 'primary create recovery');
        assertClaimMatchesRequest(primary, streamId, expectedConversationId);
        if (
          primary.claimToken !== claimToken ||
          primary.startedAt !== committedJob.createdAt ||
          primary.generationProtocolVersion !== normalizeClaimProtocol(committedJob)
        ) {
          await this.terminalizeUnexposedGeneration(
            streamId,
            committedJob,
            'Generation idempotency proof did not match its ambiguous create',
          );
          return null;
        }

        const legacyResult = await this.jobStore.claimIdempotencyKey(
          this.legacyGenerationClaimKey(userId, clientRequestId),
          primary,
          LEGACY_IDEMPOTENCY_TTL_SECONDS,
        );
        const legacy = legacyResult.claimed
          ? primary
          : normalizeTokenClaim(legacyResult.existing, 'legacy create recovery');
        assertClaimMatchesRequest(legacy, streamId, expectedConversationId);
        if (legacy.claimToken !== claimToken) {
          await this.terminalizeUnexposedGeneration(
            streamId,
            committedJob,
            'Generation legacy idempotency proof did not match its ambiguous create',
          );
          return null;
        }
        if (!claimsMirrorExactly(legacy, primary)) {
          assertClaimMirrors(legacy, primary);
          await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, legacy, primary);
        }

        if (primaryResult.claimed) {
          // JOB_CREATE with an idempotency token marks this same-slot key in
          // its atomic script. Recreating a missing key is a conservative
          // tombstone repair, not enough evidence to expose the generation.
          await this.terminalizeUnexposedGeneration(
            streamId,
            committedJob,
            'Generation primary idempotency proof was missing after its ambiguous create',
          );
          return null;
        }
      } catch (error) {
        await this.terminalizeUnexposedGeneration(
          streamId,
          committedJob,
          'Generation idempotency rollout fence could not be recovered',
        );
        throw error;
      }
    }

    let repairError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const repaired = await this.jobStore.transitionStatus(streamId, {
          from: 'running',
          to: 'running',
          expectCreatedAt: committedJob.createdAt,
        });
        if (repaired) {
          const confirmed = await this.jobStore.getJob(streamId);
          if (matchesCommittedCreate(confirmed)) {
            return confirmed;
          }
          return null;
        }
      } catch (error) {
        // The repair itself can commit and lose its reply. A second identical
        // CAS is safe and gives us a positive, membership-reconciled result.
        repairError = error;
      }

      const current = await this.jobStore.getJob(streamId);
      if (!matchesCommittedCreate(current)) {
        return null;
      }
      committedJob = current;
    }

    if (repairError != null) {
      logger.error(
        `[GenerationJobManager] Failed to confirm membership for recovered generation ${streamId}:`,
        repairError,
      );
    }
    await this.terminalizeUnexposedGeneration(
      streamId,
      committedJob,
      'Generation membership could not be recovered after an ambiguous create',
    );
    return null;
  }

  /** Persist a conservative FINAL for a job whose generation was never exposed
   * to its controller. This prevents both a provider-less running ghost and a
   * terminal hash that makes every duplicate retry wait until Redis TTL expiry. */
  private async terminalizeUnexposedGeneration(
    streamId: string,
    job: Pick<
      SerializableJobData,
      'createdAt' | 'conversationId' | 'providerExecutionId' | 'agentEventDeliveryKey' | 'userId'
    >,
    message: string,
  ): Promise<boolean> {
    try {
      const finalEvent: t.FinalEvent = {
        final: true,
        reconcile: true,
        reconcileReason: 'terminal_payload_missing',
        terminalStatus: 'error',
        generationCreatedAt: job.createdAt,
        conversation: { conversationId: job.conversationId ?? streamId },
      };
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (
            await this.jobStore.transitionStatus(streamId, {
              from: 'running',
              to: 'error',
              patch: {
                completedAt: Date.now(),
                error: message,
                finalEvent: JSON.stringify(finalEvent),
                ...(job.agentEventDeliveryKey != null &&
                  this.terminalHostActionHandler != null && {
                    terminalHostActionPending: true,
                  }),
              },
              expectCreatedAt: job.createdAt,
            })
          ) {
            /** A direct terminal transition builds no claim, so it announces itself. */
            this.notifyGenerationSettled({
              streamId,
              conversationId: job.conversationId,
              userId: job.userId,
              status: 'error',
            });
            return true;
          }
        } catch (error) {
          // As with create, the terminal CAS may have committed before the reply
          // was lost. Probe its exact epoch before retrying.
          lastError = error;
        }

        try {
          const current = await this.jobStore.getJob(streamId);
          if (current?.createdAt === job.createdAt && current.status === 'error') {
            this.notifyGenerationSettled({
              streamId,
              conversationId: current.conversationId,
              userId: current.userId,
              status: 'error',
            });
            return true;
          }
          if (
            current == null ||
            current.createdAt !== job.createdAt ||
            (current.status !== 'running' && current.status !== 'requires_action')
          ) {
            return true;
          }
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError != null) {
        logger.error(
          `[GenerationJobManager] Failed to terminalize unexposed generation ${streamId}:`,
          lastError,
        );
      }
      return false;
    } finally {
      if (job.providerExecutionId) {
        await this.markProviderExecutionDrained(
          streamId,
          job.createdAt,
          job.providerExecutionId,
        ).catch((error) => {
          logger.error(
            `[GenerationJobManager] Failed to mark unexposed provider drained ${streamId}:`,
            error,
          );
        });
      }
    }
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    options: CreateGenerationJobOptions = {},
  ): Promise<t.GenerationJob> {
    if (this.shuttingDown) {
      throw new Error(SHUTTING_DOWN_ERROR);
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('Generation job requires a non-empty user id');
    }
    const hasClientRequestId = options.idempotencyClientRequestId != null;
    const hasClaimToken = options.idempotencyClaimToken != null;
    if (hasClientRequestId !== hasClaimToken) {
      throw new Error(
        'Generation idempotency request id and claim token must be provided together',
      );
    }
    if (
      hasClientRequestId &&
      (!CLIENT_REQUEST_ID_PATTERN.test(options.idempotencyClientRequestId!) ||
        options.idempotencyClaimToken!.length === 0 ||
        options.idempotencyClaimToken!.length > 128)
    ) {
      throw new Error('Generation idempotency request id or claim token is invalid');
    }
    if (
      options.expectedPredecessorCreatedAt != null &&
      (!Number.isSafeInteger(options.expectedPredecessorCreatedAt) ||
        options.expectedPredecessorCreatedAt < 0)
    ) {
      throw new Error('Invalid expected generation predecessor');
    }
    if (
      options.rejectActivePredecessor != null &&
      typeof options.rejectActivePredecessor !== 'boolean'
    ) {
      throw new Error('Invalid active generation predecessor policy');
    }

    const tenantId = getTenantId();
    const safeTenantId = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
    const creationAttemptId = randomUUID();
    const sanitizedMetadata = sanitizeJobMetadata(options.initialMetadata ?? {});
    /** Translate the transient capability assertion into its execution-bound
     * marker: valid only while `providerExecutionId` still names this owner,
     * so a legacy replica winning a later HITL resume (which rewrites the
     * execution id without knowing this field) self-invalidates it. */
    const { steerQuotesCapable, ...storedMetadata } = sanitizedMetadata;
    const initialMetadata = {
      ...storedMetadata,
      ...(steerQuotesCapable === true && {
        steerQuotesExecutionId: creationAttemptId,
      }),
      providerExecutionId: creationAttemptId,
      providerDrained: true,
    };
    if (
      (options.recoveredSteerId != null) !== (options.recoveredSteerPayload != null) ||
      (options.recoveredSteerPayload != null &&
        !isRecoveredSteerPayload(options.recoveredSteerPayload))
    ) {
      throw new RecoveredSteerPayloadMismatchError('invalid_payload');
    }
    // Capture the active epoch before the store atomically replaces it. A
    // subscriber attached to that predecessor filters events by generation,
    // so replacement must explicitly close/handoff that old attachment.
    const observedPredecessorJob = await this.jobStore.getJob(streamId);
    let jobData: CreatedJobData;
    try {
      jobData = await this.jobStore.createJob(
        streamId,
        userId,
        conversationId,
        safeTenantId,
        initialMetadata,
        options.recoveredSteerId,
        options.idempotencyClientRequestId != null
          ? this.generationClaimKey(userId, options.idempotencyClientRequestId, streamId)
          : undefined,
        options.idempotencyClaimToken,
        options.idempotencyClientRequestId,
        options.recoveredSteerPayload,
        creationAttemptId,
        options.expectedPredecessorCreatedAt,
        options.rejectActivePredecessor,
      );
    } catch (error) {
      if (error instanceof JobPredecessorMismatchError) {
        throw error;
      }
      if (error instanceof JobCreationSupersededError) {
        if (error.createdJob.providerExecutionId) {
          await this.markProviderExecutionDrained(
            streamId,
            error.createdJob.createdAt,
            error.createdJob.providerExecutionId,
          ).catch((drainError) => {
            logger.error(
              `[GenerationJobManager] Failed to mark superseded unexposed provider drained ${streamId}:`,
              drainError,
            );
          });
        }
        try {
          const current = (await this.jobStore.getJob(streamId)) as CreatedJobData | null;
          if (
            current != null &&
            current.userId === userId &&
            (current.tenantId ?? undefined) === safeTenantId
          ) {
            await this.processDurableReplacementReceipts(streamId, current, conversationId, false);
          }
        } catch (handoffError) {
          logger.error(
            `[GenerationJobManager] Failed to process superseded creation receipts ${streamId}:`,
            handoffError,
          );
        }
        throw error;
      }

      let recovered: CreatedJobData | null = null;
      try {
        recovered = await this.recoverCommittedCreate(
          streamId,
          userId,
          conversationId,
          safeTenantId,
          options,
          creationAttemptId,
        );
      } catch (recoveryError) {
        logger.error(
          `[GenerationJobManager] Failed to reconcile ambiguous job creation ${streamId}:`,
          recoveryError,
        );
      }
      if (recovered == null) {
        throw error;
      }
      jobData = recovered;
    }

    if (options.idempotencyClientRequestId != null && options.idempotencyClaimToken != null) {
      let legacyMarked = false;
      let legacyMarkError: unknown;
      try {
        legacyMarked = await this.jobStore.markIdempotencyKeyStarted(
          this.legacyGenerationClaimKey(userId, options.idempotencyClientRequestId),
          options.idempotencyClaimToken,
          jobData.createdAt,
          LEGACY_IDEMPOTENCY_TTL_SECONDS,
        );
      } catch (error) {
        legacyMarkError = error;
        logger.error(
          '[GenerationJobManager] Failed to mark the legacy generation idempotency tombstone:',
          error,
        );
      }
      if (!legacyMarked) {
        try {
          legacyMarked = await this.confirmLegacyStartedFence(
            streamId,
            userId,
            conversationId ?? streamId,
            options.idempotencyClientRequestId,
            options.idempotencyClaimToken,
            jobData,
          );
        } catch (error) {
          legacyMarkError = error;
          logger.error(
            '[GenerationJobManager] Failed to verify the legacy generation idempotency tombstone:',
            error,
          );
        }
      }
      if (!legacyMarked) {
        // The primary was committed atomically with this job, so generation
        // ownership is no longer ambiguous on new replicas. Do not let the
        // provider start while an old replica could still interpret an
        // unmarked/mismatched legacy key as an abandoned request.
        await this.processDurableReplacementReceipts(streamId, jobData, conversationId).catch(
          (handoffError) => {
            logger.error(
              `[GenerationJobManager] Failed to hand off predecessor after legacy fence failure ${streamId}:`,
              handoffError,
            );
            return false;
          },
        );
        await this.terminalizeUnexposedGeneration(
          streamId,
          jobData,
          'Generation idempotency rollout fence could not be committed',
        );
        // If this create replaced a local provider, durable rollback is no
        // longer possible. The receipt path below is skipped on this failure,
        // so stop and retire that exact older runtime before returning.
        const replacedLocal = this.runtimeState.get(streamId);
        if (replacedLocal != null && replacedLocal.createdAt < jobData.createdAt) {
          replacedLocal.abortController.abort();
          this.retireStoppedPredecessorRuntime(streamId, jobData.createdAt);
        }
        if (legacyMarkError != null) {
          logger.error(
            '[GenerationJobManager] Legacy generation idempotency fence remained ambiguous:',
            legacyMarkError,
          );
        }
        throw new Error('Generation idempotency rollout fence could not be committed');
      }
    }
    const currentRuntimeBeforeInstall = this.runtimeState.get(streamId);
    const ownedCreatedAtBeforeInstall = this.ownedJobs.get(streamId);
    if (
      (currentRuntimeBeforeInstall != null &&
        currentRuntimeBeforeInstall.createdAt > jobData.createdAt) ||
      (ownedCreatedAtBeforeInstall != null && ownedCreatedAtBeforeInstall > jobData.createdAt)
    ) {
      if (jobData.providerExecutionId) {
        await this.markProviderExecutionDrained(
          streamId,
          jobData.createdAt,
          jobData.providerExecutionId,
        );
      }
      throw new Error('Generation job was replaced during initialization');
    }
    if (this.shuttingDown) {
      await this.processDurableReplacementReceipts(streamId, jobData, conversationId).catch(
        (handoffError) => {
          logger.error(
            `[GenerationJobManager] Failed to hand off predecessor during shutdown ${streamId}:`,
            handoffError,
          );
          return false;
        },
      );
      await this.completeJob(streamId, SHUTDOWN_JOB_ERROR, jobData.createdAt);
      if (jobData.providerExecutionId) {
        await this.markProviderExecutionDrained(
          streamId,
          jobData.createdAt,
          jobData.providerExecutionId,
        );
      }
      const replacedLocal = this.runtimeState.get(streamId);
      if (replacedLocal != null && replacedLocal.createdAt < jobData.createdAt) {
        replacedLocal.abortController.abort();
        this.retireStoppedPredecessorRuntime(streamId, jobData.createdAt);
      }
      throw new Error(SHUTTING_DOWN_ERROR);
    }

    if (!(await this.processDurableReplacementReceipts(streamId, jobData, conversationId))) {
      await this.terminalizeUnexposedGeneration(
        streamId,
        jobData,
        'Generation predecessor handoff could not be confirmed',
      );
      this.retireStoppedPredecessorRuntime(streamId, jobData.createdAt);
      throw new Error('Generation predecessor handoff could not be confirmed');
    }

    const replacementEpochs = new Map<number, string | undefined>();
    const exactPredecessors =
      jobData.replacedJobs ?? (jobData.replacedJob != null ? [jobData.replacedJob] : []);
    const exactPredecessorsByEpoch = new Map(
      exactPredecessors.map((predecessor) => [predecessor.createdAt, predecessor]),
    );
    const observedPredecessorReceipt = observedPredecessorJob
      ? exactPredecessorsByEpoch.get(observedPredecessorJob.createdAt)
      : undefined;
    if (
      observedPredecessorJob &&
      observedPredecessorJob.createdAt !== jobData.createdAt &&
      (observedPredecessorJob.status === 'running' ||
        observedPredecessorJob.status === 'requires_action') &&
      // The transaction-time predecessor is authoritative for the same
      // epoch. A pre-read may say running even though it terminalized before
      // replacement; do not publish a contradictory replaced/abort pair.
      observedPredecessorReceipt == null
    ) {
      replacementEpochs.set(
        observedPredecessorJob.createdAt,
        observedPredecessorJob.conversationId,
      );
    }
    const localPredecessor = this.runtimeState.get(streamId);
    const localPredecessorReceipt = localPredecessor
      ? exactPredecessorsByEpoch.get(localPredecessor.createdAt)
      : undefined;
    if (
      localPredecessor &&
      localPredecessor.createdAt < jobData.createdAt &&
      !localPredecessor.finalEvent &&
      !localPredecessor.errorEvent &&
      localPredecessorReceipt == null
    ) {
      replacementEpochs.set(localPredecessor.createdAt, observedPredecessorJob?.conversationId);
    }
    for (const [predecessorCreatedAt, predecessorConversationId] of replacementEpochs) {
      await this.notifyReplacedGeneration(
        streamId,
        predecessorCreatedAt,
        predecessorConversationId,
        conversationId,
      );
    }

    // Every predecessor handoff above can yield. A newer same-process create
    // may have installed its runtime while this older invocation was waiting;
    // never let the stale continuation overwrite ownership or abort that newer
    // runtime. No await is permitted between this guard and the synchronous
    // ownership/runtime installation below.
    const runtimeImmediatelyBeforeInstall = this.runtimeState.get(streamId);
    const ownedImmediatelyBeforeInstall = this.ownedJobs.get(streamId);
    if (
      (runtimeImmediatelyBeforeInstall != null &&
        runtimeImmediatelyBeforeInstall.createdAt > jobData.createdAt) ||
      (ownedImmediatelyBeforeInstall != null && ownedImmediatelyBeforeInstall > jobData.createdAt)
    ) {
      if (jobData.providerExecutionId) {
        await this.markProviderExecutionDrained(
          streamId,
          jobData.createdAt,
          jobData.providerExecutionId,
        );
      }
      throw new Error('Generation job was replaced during initialization');
    }

    this.acquireJobOwnership(streamId, jobData.createdAt);
    recordGenerationJob(this.storeLabel, 'created');

    const replacedRuntime = this.runtimeState.get(streamId);
    if (replacedRuntime) {
      replacedRuntime.startupTelemetry?.end('replaced');
      replacedRuntime.startupTelemetry = undefined;
      this.stopSubscriberLease(replacedRuntime);
      const durableReceipt = exactPredecessorsByEpoch.get(replacedRuntime.createdAt);
      if (
        durableReceipt == null ||
        durableReceipt.status === 'running' ||
        durableReceipt.status === 'requires_action'
      ) {
        replacedRuntime.abortController.abort();
      }
    }

    /**
     * Create runtime state with readyPromise.
     *
     * With the resumable stream architecture, we no longer need to wait for the
     * first subscriber before starting generation:
     * - Redis mode: Events are persisted and can be replayed via sync
     * - In-memory mode: Content is aggregated and sent via sync on connect
     *
     * We resolve readyPromise immediately to eliminate startup latency.
     * The sync mechanism handles late-connecting clients.
     */
    const readyPromise = Promise.resolve();
    const resolveReady = (): void => undefined;

    const runtime: RuntimeJobState = {
      createdAt: jobData.createdAt,
      abortController: new AbortController(),
      readyPromise,
      resolveReady,
      startupTelemetry: options.startupTelemetry,
      syncSent: false,
      earlyEventBuffer: [],
      earlyEventBufferBytes: 0,
      earlyEventBufferClosed: false,
      earlyEventSequencePromises: [],
      earlyReplayHandlers: new Set(),
      resumeCaptureHandlers: new Set(),
      localErrorHandlers: new Set(),
      emissionSequence: 0,
      durableEventSequence: 0,
      inFlightSnapshotEmissions: new Map(),
      hasSubscriber: false,
      everHadSubscriber: jobData.firstSubscriberAttachedAt != null,
      subscriberStateAttached: false,
      subscriberLeaseId: randomUUID(),
      attachmentGeneration: 0,
    };
    this.runtimeState.set(streamId, runtime);

    try {
      this.registerAllSubscribersLeft(streamId);

      await this.registerAbortSubscription(streamId, runtime);
      if (replacedRuntime != null && replacedRuntime !== runtime) {
        // Keep at least one abort registration on the shared Redis channel
        // across same-stream replacement. This also lets a predecessor whose
        // registration was still becoming ready dispose itself without
        // briefly unsubscribing the successor.
        this.releaseReplacementTransportHold(streamId, replacedRuntime);
      }
      // This epoch is not exposed to its controller until the durable bit and
      // owner listener agree. A replacement that wins before this write sees
      // explicit false and can safely skip an acknowledgement because no
      // provider could have started; a lost write reply is confirmed below.
      await this.jobStore.updateJob(streamId, { providerAbortReady: true }, runtime.createdAt);
      /**
       * NOT awaited, unlike abort. Abort must be deliverable before the job
       * is exposed — a missed abort strands a run. A missed preempt only
       * degrades that steer to the next tool boundary, which is the
       * documented fallback, so blocking job creation on a second channel
       * subscription would trade a real hang risk for a cosmetic guarantee.
       * The registration's own lost-race tail releases it if the runtime is
       * retired before the subscription resolves, and it swallows and logs
       * its own failures, so this detached call cannot reject.
       */
      void this.registerPreemptSubscription(streamId, runtime);
      if (this.runtimeState.get(streamId) !== runtime) {
        throw new Error('Generation job was replaced during initialization');
      }
      const confirmedJobData = await this.jobStore.getJob(streamId);
      if (
        this.runtimeState.get(streamId) !== runtime ||
        !confirmedJobData ||
        confirmedJobData.createdAt !== runtime.createdAt ||
        confirmedJobData.status !== 'running' ||
        confirmedJobData.providerAbortReady !== true
      ) {
        throw new Error('Generation job was replaced during initialization');
      }
      if (this.shuttingDown) {
        throw new Error(SHUTTING_DOWN_ERROR);
      }
    } catch (error) {
      if (replacedRuntime != null && replacedRuntime !== runtime) {
        this.releaseReplacementTransportHold(streamId, replacedRuntime);
      }
      // The durable job already exists, but the caller has not received its
      // generation identity yet. Finalize that exact epoch here so a controller
      // catch never needs to issue an unsafe unscoped terminal mutation.
      let message = SHUTDOWN_JOB_ERROR;
      if (!this.shuttingDown) {
        message = error instanceof Error ? error.message : String(error);
      }
      await this.completeJob(streamId, message, jobData.createdAt).catch((finalizeError) => {
        logger.error(
          `[GenerationJobManager] Failed to finalize partially initialized job ${streamId}:`,
          finalizeError,
        );
      });
      if (jobData.providerExecutionId) {
        await this.markProviderExecutionDrained(
          streamId,
          jobData.createdAt,
          jobData.providerExecutionId,
        ).catch((drainError) => {
          logger.error(
            `[GenerationJobManager] Failed to mark partially initialized provider drained ${streamId}:`,
            drainError,
          );
        });
      }
      if (
        this.runtimeState.get(streamId) === runtime &&
        runtime.replacementTransportHold !== true
      ) {
        this.releaseAbortSubscription(runtime);
        runtime.abortController.abort();
        this.stopSubscriberLease(runtime);
        this.runtimeState.delete(streamId);
        this.releaseJobOwnership(streamId, runtime.createdAt);
      }
      throw error;
    }

    logger.debug(`[GenerationJobManager] Created job: ${streamId}`);

    // Return facade for backwards compatibility
    return this.buildJobFacade(streamId, jobData, runtime);
  }

  /**
   * Build a GenerationJob facade from composed services.
   *
   * This facade provides a unified API (job.emitter, job.abortController, etc.)
   * while internally delegating to the injected services (jobStore, eventTransport,
   * contentState). This allows swapping implementations (e.g., Redis) without
   * changing consumer code.
   *
   * IMPORTANT: The emitterProxy.on('allSubscribersLeft') handler registration
   * does NOT use eventTransport.subscribe(). This is intentional:
   *
   * If we used subscribe() for internal handlers, those handlers would count
   * as subscribers. When the real SSE client connects, isFirstSubscriber()
   * would return false (because internal handler was "first"), and readyPromise
   * would never resolve - causing a 5-second timeout delay before generation starts.
   *
   * Instead, allSubscribersLeft handlers are stored in runtime.allSubscribersLeftHandlers
   * and called directly from the onAllSubscribersLeft callback in createJob().
   *
   * @param streamId - The stream identifier
   * @param jobData - Serializable job metadata from job store
   * @param runtime - Non-serializable runtime state (abort controller, promises, etc.)
   * @returns A GenerationJob facade object
   */
  private buildJobFacade(
    streamId: string,
    jobData: SerializableJobData,
    runtime: RuntimeJobState,
  ): t.GenerationJob {
    /**
     * Proxy emitter that delegates to eventTransport for most operations.
     * Exception: allSubscribersLeft handlers are stored separately to avoid
     * incrementing subscriber count (see class JSDoc above).
     */
    const emitterProxy = {
      on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
        if (event === 'allSubscribersLeft') {
          // Store handler for internal callback - don't use subscribe() to avoid counting as a subscriber
          if (!runtime.allSubscribersLeftHandlers) {
            runtime.allSubscribersLeftHandlers = [];
          }
          runtime.allSubscribersLeftHandlers.push(handler);
        }
      },
      emit: () => {
        /* handled via eventTransport */
      },
      listenerCount: () => this.eventTransport.getSubscriberCount(streamId),
      setMaxListeners: () => {
        /* no-op for proxy */
      },
      removeAllListeners: () => this.eventTransport.cleanup(streamId),
      off: () => {
        /* handled via unsubscribe */
      },
    };

    return {
      streamId,
      emitter: emitterProxy as unknown as t.GenerationJob['emitter'],
      status: jobData.status as t.GenerationJobStatus,
      createdAt: jobData.createdAt,
      completedAt: jobData.completedAt,
      abortController: runtime.abortController,
      error: jobData.error,
      metadata: {
        userId: jobData.userId,
        tenantId: jobData.tenantId,
        conversationId: jobData.conversationId,
        checkpointNamespace: jobData.checkpointNamespace,
        generationProtocolVersion: jobData.generationProtocolVersion,
        earlyBufferOverflow: jobData.earlyBufferOverflow,
        userMessage: jobData.userMessage,
        responseMessageId: jobData.responseMessageId,
        isRegenerate: jobData.isRegenerate,
        mcpRequestBody: jobData.mcpRequestBody,
        userSubmittedPaths: jobData.userSubmittedPaths,
        userSubmittedMessageFieldPaths: jobData.userSubmittedMessageFieldPaths,
        sender: jobData.sender,
        endpoint: jobData.endpoint,
        iconURL: jobData.iconURL,
        model: jobData.model,
        promptTokens: jobData.promptTokens,
        // Surface the originating agent so the resume route can refuse to rebuild a
        // paused run on a different agent.
        agent_id: jobData.agent_id,
        // Surface whether the turn was temporary so a resume keeps it non-persisted.
        isTemporary: jobData.isTemporary,
        retentionExpiresAt: jobData.retentionExpiresAt,
        agentEventDeliveryKey: jobData.agentEventDeliveryKey,
        agentEventInvocationKey: jobData.agentEventInvocationKey,
        agentEventInvocationGenerationCreatedAt: jobData.agentEventInvocationGenerationCreatedAt,
        agentEventDetachedActionProducerRequired: jobData.agentEventDetachedActionProducerRequired,
        agentEventDetachedTerminalEvidence: jobData.agentEventDetachedTerminalEvidence,
        agentEventBindingId: jobData.agentEventBindingId,
        agentEventExpectedAction: jobData.agentEventExpectedAction,
        agentEventSuspension: jobData.agentEventSuspension,
        scheduleId: jobData.scheduleId,
        scheduledFor: jobData.scheduledFor,
        scheduleConfigRevision: jobData.scheduleConfigRevision,
        scheduleManual: jobData.scheduleManual,
        scheduleOutcome: jobData.scheduleOutcome,
        scheduleOutcomeError: jobData.scheduleOutcomeError,
        preserveForScheduleReconcile: jobData.preserveForScheduleReconcile,
        // Surface deferred tools discovered before the pause so the resume route can
        // replay them into createRun (the rebuilt graph passes `messages: []`).
        discoveredTools: jobData.discoveredTools,
        activityPhaseSnapshot: jobData.activityPhaseSnapshot,
        compactionSemanticIndex: jobData.compactionSemanticIndex,
        contextMeta: jobData.contextMeta,
        // Surface the owning replica's seal capability so the steer route can
        // honour it instead of probing its own (possibly older) SDK.
        preemptCapable: jobData.preemptCapable,
        // Same owner-recorded pattern for quote handling, execution-bound so a
        // legacy resume's execution rewrite invalidates a stale assertion.
        steerQuotesExecutionId: jobData.steerQuotesExecutionId,
        providerExecutionId: jobData.providerExecutionId,
        providerExecutionStartedId: jobData.providerExecutionStartedId,
        providerDrained: jobData.providerDrained,
        steersClosed: jobData.steersClosed,
        idempotencyClientRequestId: jobData.idempotencyClientRequestId,
        agentEventLegacyTurnToken: jobData.agentEventLegacyTurnToken,
        terminalPersistencePending: jobData.terminalPersistencePending,
        terminalHostActionPending: jobData.terminalHostActionPending,
        terminalPersistenceStartedAt: jobData.terminalPersistenceStartedAt,
        // Surface the pending review so status/resume routes built on the
        // facade can render the prompt for a `requires_action` job.
        pendingAction: jobData.pendingAction,
        resolvedAskUserQuestions: jobData.resolvedAskUserQuestions,
      },
      readyPromise: runtime.readyPromise,
      resolveReady: runtime.resolveReady,
      finalEvent: runtime.finalEvent,
      syncSent: runtime.syncSent,
    };
  }

  /**
   * Get or create runtime state for a job.
   *
   * This enables cross-replica support in Redis mode:
   * - If runtime exists locally (same replica), return it
   * - If job exists in Redis but not locally (cross-replica), create minimal runtime
   *
   * The lazily-created runtime state is sufficient for:
   * - Subscribing to events (via Redis pub/sub)
   * - Getting resume state
   * - Handling reconnections
   * - Receiving cross-replica abort signals (via Redis pub/sub)
   *
   * @param streamId - The stream identifier
   * @returns Runtime state or null if job doesn't exist anywhere
   */
  private async getOrCreateRuntimeState(
    streamId: string,
    knownJobData?: SerializableJobData | null,
  ): Promise<RuntimeJobState | null> {
    const jobData =
      knownJobData === undefined ? await this.jobStore.getJob(streamId) : knownJobData;
    if (!jobData) {
      return null;
    }

    const concurrentRuntime = this.runtimeState.get(streamId);
    if (concurrentRuntime?.createdAt === jobData.createdAt) {
      if (jobData.earlyBufferOverflow != null) {
        concurrentRuntime.earlyBufferOverflow = jobData.earlyBufferOverflow;
        concurrentRuntime.earlyEventBufferClosed = true;
        concurrentRuntime.earlyEventBufferOverflowed = true;
        this.resetEarlyEventBuffer(concurrentRuntime);
      }
      this.reconcileInactiveGeneration(streamId, jobData.createdAt, jobData, concurrentRuntime);
      return concurrentRuntime;
    }
    if (concurrentRuntime && concurrentRuntime.createdAt > jobData.createdAt) {
      return concurrentRuntime;
    }
    if (concurrentRuntime) {
      concurrentRuntime.startupTelemetry?.end('replaced');
      concurrentRuntime.startupTelemetry = undefined;
      this.stopSubscriberLease(concurrentRuntime);
      this.releaseAbortSubscription(concurrentRuntime);
      concurrentRuntime.abortController.abort();
    }

    // Cross-replica scenario: create (or replace) the minimal runtime state
    // from the durable generation currently owning this stream ID.
    logger.debug(`[GenerationJobManager] Creating cross-replica runtime for ${streamId}`);

    const readyPromise = Promise.resolve();
    const resolveReady = (): void => undefined;

    // Parse finalEvent from Redis if available
    let finalEvent: t.ServerSentEvent | undefined;
    if (jobData.finalEvent) {
      try {
        /** Records written before projection shipped, or by an older replica,
         * are projected on read so replay never re-delivers or re-caches an
         * oversized payload. */
        finalEvent = projectTerminalEvent(JSON.parse(jobData.finalEvent) as t.ServerSentEvent);
      } catch {
        // Ignore parse errors
      }
    }

    const runtime: RuntimeJobState = {
      createdAt: jobData.createdAt,
      abortController: new AbortController(),
      readyPromise,
      resolveReady,
      syncSent: jobData.syncSent ?? false,
      earlyEventBuffer: [],
      earlyEventBufferBytes: 0,
      earlyEventBufferClosed: false,
      earlyEventSequencePromises: [],
      earlyReplayHandlers: new Set(),
      resumeCaptureHandlers: new Set(),
      localErrorHandlers: new Set(),
      emissionSequence: 0,
      durableEventSequence: jobData.durableEventCount ?? 0,
      inFlightSnapshotEmissions: new Map(),
      hasSubscriber: false,
      everHadSubscriber: false,
      subscriberStateAttached: false,
      subscriberLeaseId: randomUUID(),
      attachmentGeneration: 0,
      finalEvent,
      errorEvent: jobData.error,
      earlyBufferOverflow: jobData.earlyBufferOverflow,
      ...(jobData.earlyBufferOverflow != null && {
        earlyEventBufferClosed: true,
        earlyEventBufferOverflowed: true,
      }),
    };

    this.runtimeState.set(streamId, runtime);

    this.registerAllSubscribersLeft(streamId);

    if (jobData.status === 'running' || jobData.status === 'requires_action') {
      await this.registerAbortSubscription(streamId, runtime);
      /** Best-effort, non-blocking — see the createJob registration. */
      void this.registerPreemptSubscription(streamId, runtime);
    }

    const runtimeAfterAbortRegistration = this.runtimeState.get(streamId);
    if (runtimeAfterAbortRegistration !== runtime) {
      return runtimeAfterAbortRegistration ?? null;
    }

    /**
     * `onAbort` may require an asynchronous Redis subscription. A replacement can
     * become durable on another replica while that subscription is activating,
     * without changing this process's runtime map. Re-read the owner before
     * exposing the facade, and reconcile again if the generation moved.
     */
    const confirmedJobData = await this.jobStore.getJob(streamId);
    if (this.runtimeState.get(streamId) !== runtime) {
      return this.runtimeState.get(streamId) ?? null;
    }
    if (!confirmedJobData) {
      this.releaseAbortSubscription(runtime);
      runtime.abortController.abort();
      this.stopSubscriberLease(runtime);
      this.runtimeState.delete(streamId);
      return null;
    }
    if (confirmedJobData.createdAt !== runtime.createdAt) {
      return this.getOrCreateRuntimeState(streamId, confirmedJobData);
    }
    this.reconcileInactiveGeneration(
      streamId,
      confirmedJobData.createdAt,
      confirmedJobData,
      runtime,
    );

    return runtime;
  }

  /** Durable deletion evidence does not depend on a replica's runtime attachment. */
  async getCleanupJob(
    streamId: string,
  ): Promise<Pick<t.GenerationJob, 'createdAt' | 'status' | 'metadata'> | undefined> {
    let job = await this.jobStore.getJob(streamId);
    if (job?.terminalPersistencePending === true) {
      await this.recoverStaleTerminalPersistence(job);
      job = await this.jobStore.getJob(streamId);
    }
    if (job == null) return undefined;
    return {
      createdAt: job.createdAt,
      status: job.status,
      metadata: {
        userId: job.userId,
        tenantId: job.tenantId,
        conversationId: job.conversationId,
        providerDrained: job.providerDrained,
        terminalPersistencePending: job.terminalPersistencePending,
        terminalHostActionPending: job.terminalHostActionPending,
      },
    };
  }

  async getJob(streamId: string): Promise<t.GenerationJob | undefined> {
    let jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return undefined;
    }
    jobData = await this.recoverStaleTerminalPersistence(jobData);
    if (!jobData) {
      return undefined;
    }

    const runtime = await this.getOrCreateRuntimeState(streamId, jobData);
    if (
      !runtime ||
      this.runtimeState.get(streamId) !== runtime ||
      runtime.createdAt !== jobData.createdAt
    ) {
      return undefined;
    }

    return this.buildJobFacade(streamId, jobData, runtime);
  }

  /**
   * Check if a job exists.
   */
  async hasJob(streamId: string): Promise<boolean> {
    return this.jobStore.hasJob(streamId);
  }

  /**
   * Atomically claim a start-generation request for `(userId, clientRequestId)`.
   * The first caller wins (`claimed: true`) and should create the job; a retried
   * request for the same submission loses and receives the original stream so it
   * can attach to it instead of starting a second billed generation.
   */
  async claimGeneration(
    userId: string,
    clientRequestId: string,
    streamId: string,
    conversationId: string,
    generationProtocolVersion?: 1 | 2,
  ): Promise<IdempotencyClaimResult> {
    const value: TokenIdempotencyClaim = {
      streamId,
      conversationId,
      claimedAt: Date.now(),
      claimToken: randomUUID(),
      generationProtocolVersion: generationProtocolVersion === 2 ? 2 : 1,
    };

    // Old replicas know only this key. Claiming it first means a mixed fleet
    // still has exactly one admission winner; the primary is a mirror/fence,
    // never an independent chance to start a billed generation.
    const legacyResult = await this.jobStore.claimIdempotencyKey(
      this.legacyGenerationClaimKey(userId, clientRequestId),
      value,
      LEGACY_IDEMPOTENCY_TTL_SECONDS,
    );

    if (legacyResult.claimed) {
      const primaryResult = await this.jobStore.claimIdempotencyKey(
        this.generationClaimKey(userId, clientRequestId, streamId),
        value,
        IDEMPOTENCY_TTL_SECONDS,
      );
      if (primaryResult.claimed) {
        return { claimed: true, existing: value, source: 'primary' };
      }

      // This is a crash/expiry repair: an authoritative primary survived while
      // its longer-lived legacy mirror was unexpectedly absent. Point the
      // legacy key at that primary and remain a duplicate; never let the fresh
      // legacy SET turn into a second owner.
      const primary = normalizeTokenClaim(primaryResult.existing, 'primary');
      assertClaimMatchesRequest(primary, streamId, conversationId);
      await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, value, primary);
      return { claimed: false, existing: primary, source: 'primary' };
    }

    if (legacyResult.existing?.claimToken == null) {
      return {
        claimed: false,
        existing: normalizeTokenlessLegacyClaim(legacyResult.existing),
        source: 'legacy',
      };
    }

    const legacy = normalizeTokenClaim(legacyResult.existing, 'legacy');
    assertClaimMatchesRequest(legacy, streamId, conversationId);
    const primaryResult = await this.jobStore.claimIdempotencyKey(
      this.generationClaimKey(userId, clientRequestId, streamId),
      legacy,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (primaryResult.claimed) {
      // We merely repaired the mirror for the already-existing owner. This
      // retry is still a duplicate and must not create a generation.
      return { claimed: false, existing: legacy, source: 'primary' };
    }

    const primary = normalizeTokenClaim(primaryResult.existing, 'primary');
    assertClaimMatchesRequest(primary, streamId, conversationId);
    if (isRecoverableTakeoverSplit(legacy, primary)) {
      await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, legacy, primary);
      return { claimed: false, existing: primary, source: 'primary' };
    }
    assertClaimMirrors(legacy, primary);
    if (primary.startedAt != null && legacy.startedAt == null) {
      await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, legacy, primary);
    }
    return { claimed: false, existing: primary, source: 'primary' };
  }

  /** Checks the mixed-version admission key without creating or repairing a
   * claim. This is deliberately weaker than `claimGeneration`: callers may
   * use it only to exempt a confirmed retry from request rate limiting; the
   * controller must still perform the authoritative claim transition. */
  async hasGenerationClaim(userId: string, clientRequestId: string): Promise<boolean> {
    if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
      return false;
    }
    return (
      (await this.jobStore.hasIdempotencyKey?.(
        this.legacyGenerationClaimKey(userId, clientRequestId),
      )) === true
    );
  }

  /** Returns immutable proof that one exact request crossed generation
   * admission, even after the generation job itself has completed or been
   * replaced. Built-in stores retain this started receipt for the bounded
   * idempotency horizon; legacy custom stores fall back to the live job. */
  async getGenerationAdmissionEvidence(
    userId: string,
    clientRequestId: string,
    streamId: string,
    conversationId: string = streamId,
  ): Promise<{ generationId: string; generationCreatedAt: number } | null> {
    if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
      return null;
    }
    const getClaim = this.jobStore.getIdempotencyClaim;
    if (getClaim != null) {
      const claim = await getClaim.call(
        this.jobStore,
        this.generationClaimKey(userId, clientRequestId, streamId),
      );
      if (claim == null) {
        return null;
      }
      const normalized = normalizeTokenClaim(claim, 'admission evidence');
      assertClaimMatchesRequest(normalized, streamId, conversationId);
      if (normalized.startedAt == null) {
        return null;
      }
      return {
        generationId: normalized.streamId,
        generationCreatedAt: normalized.startedAt,
      };
    }

    const job = await this.jobStore.getJob(streamId);
    if (
      job == null ||
      job.userId !== userId ||
      (job.conversationId ?? streamId) !== conversationId ||
      job.idempotencyClientRequestId !== clientRequestId
    ) {
      return null;
    }
    return { generationId: streamId, generationCreatedAt: job.createdAt };
  }

  /** Atomically prevents an unpublished automatic continuation from starting
   * after its delivery has been retired for manual recovery. If recovery wins
   * the unstarted idempotency claim (directly or through the existing takeover
   * CAS), it converts that exact token into a started tombstone. A concurrent
   * `createJob` still holding the predecessor token then fails its atomic
   * create, while later duplicate POSTs take the settled/refetch path.
   *
   * `started` means job creation won the claim race; the caller must inspect
   * the generation itself before releasing any result ownership. */
  async fenceGenerationClaimForRecovery(
    userId: string,
    clientRequestId: string,
    streamId: string,
    conversationId: string,
  ): Promise<'fenced' | 'started' | 'unavailable'> {
    const observed = await this.claimGeneration(userId, clientRequestId, streamId, conversationId);
    if (observed.existing == null) {
      return 'unavailable';
    }
    if (observed.existing.startedAt != null) {
      return 'started';
    }

    let owned = observed;
    if (!observed.claimed) {
      owned = await this.takeoverGeneration(userId, clientRequestId, streamId, observed.existing);
      if (owned.existing?.startedAt != null) {
        return 'started';
      }
      if (!owned.claimed || owned.existing == null) {
        return 'unavailable';
      }
    }

    const claim = normalizeTokenClaim(owned.existing, 'background completion recovery fence');
    if (claim.startedAt != null) {
      return 'started';
    }
    await this.tombstoneObservedGenerationClaim(
      userId,
      clientRequestId,
      streamId,
      claim,
      Date.now(),
      claim.generationProtocolVersion === 2 ? 2 : 1,
    );
    return 'fenced';
  }

  private generationClaimKey(userId: string, clientRequestId: string, streamId: string): string {
    return `{${streamId}}:${userId}:${clientRequestId}`;
  }

  /** Exact pre-bridge physical key through RedisJobStore.KEYS.idempotency:
   * `stream:idem:{userId:clientRequestId}`. The braces belong in the store key
   * argument because current stores no longer add a second hash tag. */
  private legacyGenerationClaimKey(userId: string, clientRequestId: string): string {
    return `{${userId}:${clientRequestId}}`;
  }

  /** Finish one proven cross-slot bridge step. A failed CAS may mean another
   * replica already completed the same value, so probe it before declaring an
   * ambiguous outcome. The probe's SET-NX behavior also safely recreates an
   * unexpectedly expired legacy mirror with the authoritative primary value. */
  private async synchronizeLegacyGenerationClaim(
    userId: string,
    clientRequestId: string,
    expectedLegacy: TokenIdempotencyClaim,
    primary: TokenIdempotencyClaim,
  ): Promise<void> {
    const legacyKey = this.legacyGenerationClaimKey(userId, clientRequestId);
    let synchronizationError: unknown;
    let synchronized = false;
    try {
      synchronized = await this.jobStore.takeoverIdempotencyKey(
        legacyKey,
        expectedLegacy,
        primary,
        LEGACY_IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // A single-key CAS can commit and then lose its reply. Probe below before
      // treating the bridge as split or attempting any rollback.
      synchronizationError = error;
    }
    if (synchronized) {
      return;
    }

    const probe = await this.jobStore.claimIdempotencyKey(
      legacyKey,
      primary,
      LEGACY_IDEMPOTENCY_TTL_SECONDS,
    );
    const current = probe.claimed ? primary : normalizeTokenClaim(probe.existing, 'legacy');
    if (claimsMirrorExactly(current, primary)) {
      return;
    }
    if (synchronizationError != null) {
      throw synchronizationError;
    }
    assertClaimMirrors(current, primary);
    throw new Error('Legacy generation idempotency claim could not be synchronized');
  }

  /** Once an exact same-owner generation carrying this request id has been
   * observed, its later completion/deletion cannot erase the historical fact
   * that the request already started. Convert the freshly reacquired mirrors
   * into started tombstones even when the live-job adoption CAS loses that
   * race. The token CAS/probe never overwrites an unrelated claimant. */
  private async tombstoneObservedGenerationClaim(
    userId: string,
    clientRequestId: string,
    streamId: string,
    claim: TokenIdempotencyClaim,
    createdAt: number,
    generationProtocolVersion: 1 | 2,
  ): Promise<TokenIdempotencyClaim> {
    const tombstone: TokenIdempotencyClaim = {
      ...claim,
      startedAt: createdAt,
      generationProtocolVersion,
    };
    const primaryKey = this.generationClaimKey(userId, clientRequestId, streamId);
    let markError: unknown;
    let marked = false;
    try {
      marked = await this.jobStore.takeoverIdempotencyKey(
        primaryKey,
        claim,
        tombstone,
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // The CAS can commit and lose its reply. Resolve only the exact value we
      // intended; a same-key unrelated token or coordinates remain fail-closed.
      markError = error;
    }

    if (!marked) {
      const probe = await this.jobStore.claimIdempotencyKey(
        primaryKey,
        tombstone,
        IDEMPOTENCY_TTL_SECONDS,
      );
      const current = probe.claimed
        ? tombstone
        : normalizeTokenClaim(probe.existing, 'observed generation tombstone');
      if (!claimsMirrorExactly(current, tombstone)) {
        if (markError != null) {
          throw markError;
        }
        throw new Error('Observed generation idempotency claim changed before it was fenced');
      }
    }

    await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, claim, tombstone);
    return tombstone;
  }

  async takeoverGeneration(
    userId: string,
    clientRequestId: string,
    streamId: string,
    expected: IdempotencyClaimValue,
  ): Promise<IdempotencyClaimResult> {
    if (expected.claimToken == null) {
      return {
        claimed: false,
        existing: normalizeTokenlessLegacyClaim(expected),
        source: 'legacy',
      };
    }

    const expectedClaim = normalizeTokenClaim(expected, 'takeover');
    assertClaimMatchesRequest(expectedClaim, streamId, expectedClaim.conversationId);
    const primaryKey = this.generationClaimKey(userId, clientRequestId, streamId);
    const legacyKey = this.legacyGenerationClaimKey(userId, clientRequestId);

    // Read-or-bind both mirrors before the CAS. `claimIdempotencyKey` is the
    // store's cluster-safe single-key probe; if an expired mirror is absent it
    // recreates the old owner rather than opening a second admission window.
    const primaryProbe = await this.jobStore.claimIdempotencyKey(
      primaryKey,
      expectedClaim,
      IDEMPOTENCY_TTL_SECONDS,
    );
    const primary = primaryProbe.claimed
      ? expectedClaim
      : normalizeTokenClaim(primaryProbe.existing, 'primary');
    const legacyProbe = await this.jobStore.claimIdempotencyKey(
      legacyKey,
      expectedClaim,
      LEGACY_IDEMPOTENCY_TTL_SECONDS,
    );
    const legacy = legacyProbe.claimed
      ? expectedClaim
      : normalizeTokenClaim(legacyProbe.existing, 'legacy');
    assertClaimMatchesRequest(primary, streamId, expectedClaim.conversationId);
    assertClaimMatchesRequest(legacy, streamId, expectedClaim.conversationId);
    if (isRecoverableTakeoverSplit(legacy, primary)) {
      await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, legacy, primary);
      return { claimed: false, existing: primary, source: 'primary' };
    }
    assertClaimMirrors(legacy, primary);

    if (primary.startedAt != null) {
      if (legacy.startedAt == null) {
        await this.synchronizeLegacyGenerationClaim(userId, clientRequestId, legacy, primary);
      }
      return { claimed: false, existing: primary, source: 'primary' };
    }

    const value: TokenIdempotencyClaim = {
      streamId,
      conversationId: expectedClaim.conversationId,
      claimedAt: Math.max(
        Date.now(),
        Math.min(Number.MAX_SAFE_INTEGER, expectedClaim.claimedAt + 1),
      ),
      claimToken: randomUUID(),
      previousClaimToken: expectedClaim.claimToken,
      generationProtocolVersion: expectedClaim.generationProtocolVersion,
    };
    let primaryTaken: boolean;
    try {
      primaryTaken = await this.jobStore.takeoverIdempotencyKey(
        primaryKey,
        expectedClaim,
        value,
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // A single-key CAS can commit and then lose its reply. Resolve only a
      // split carrying this predecessor token; unrelated mismatches remain
      // outcome-ambiguous and fail closed.
      const [observedPrimaryResult, observedLegacyResult] = await Promise.all([
        this.jobStore.claimIdempotencyKey(primaryKey, expectedClaim, IDEMPOTENCY_TTL_SECONDS),
        this.jobStore.claimIdempotencyKey(legacyKey, expectedClaim, LEGACY_IDEMPOTENCY_TTL_SECONDS),
      ]);
      const observedPrimary = observedPrimaryResult.claimed
        ? expectedClaim
        : normalizeTokenClaim(observedPrimaryResult.existing, 'primary');
      const observedLegacy = observedLegacyResult.claimed
        ? expectedClaim
        : normalizeTokenClaim(observedLegacyResult.existing, 'legacy');

      if (isRecoverableTakeoverSplit(observedLegacy, observedPrimary)) {
        await this.synchronizeLegacyGenerationClaim(
          userId,
          clientRequestId,
          observedLegacy,
          observedPrimary,
        );
        return claimsMirrorExactly(observedPrimary, value)
          ? { claimed: true, existing: value, source: 'primary' }
          : { claimed: false, existing: observedPrimary, source: 'primary' };
      }
      if (claimsMirrorExactly(observedLegacy, observedPrimary)) {
        if (claimsMirrorExactly(observedPrimary, value)) {
          return { claimed: true, existing: value, source: 'primary' };
        }
        if (isClaimTakeoverOf(expectedClaim, observedPrimary)) {
          return {
            claimed: false,
            existing: observedPrimary,
            source: 'primary',
          };
        }
      }
      throw error;
    }
    if (!primaryTaken) {
      return { claimed: false, source: 'primary' };
    }

    try {
      const legacyTaken = await this.jobStore.takeoverIdempotencyKey(
        legacyKey,
        expectedClaim,
        value,
        LEGACY_IDEMPOTENCY_TTL_SECONDS,
      );
      if (!legacyTaken) {
        // Do not strand a new primary token that is not mirrored to old
        // replicas. Compare-release only the token installed above.
        await this.jobStore.releaseIdempotencyKey(primaryKey, value);
        return { claimed: false, source: 'primary' };
      }
    } catch (error) {
      await this.jobStore.releaseIdempotencyKey(primaryKey, value).catch((releaseError) => {
        logger.error(
          '[GenerationJobManager] Failed to roll back an unmirrored primary idempotency takeover:',
          releaseError,
        );
      });
      throw error;
    }

    return { claimed: true, existing: value, source: 'primary' };
  }

  /** A fixed replay lease can expire while a long generation is still active.
   * If the identical client request reacquires that lease, atomically bind it
   * back to the matching live job instead of letting createJob replace/rebill
   * the generation. A different clientRequestId remains a genuinely new turn. */
  async resumeClaimedGeneration(
    userId: string,
    clientRequestId: string,
    streamId: string,
    claim: IdempotencyClaimValue,
  ): Promise<IdempotencyClaimValue | null> {
    const normalizedClaim = normalizeTokenClaim(claim, 'reacquired');
    assertClaimMatchesRequest(normalizedClaim, streamId, normalizedClaim.conversationId);
    const tenantId = getTenantId();
    const safeTenantId = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
    const job = await this.jobStore.getJob(streamId);
    if (
      job == null ||
      job.userId !== userId ||
      (job.tenantId != null && job.tenantId !== safeTenantId) ||
      (job.status !== 'running' && job.status !== 'requires_action')
    ) {
      return null;
    }
    const missingClientRequestId = job.idempotencyClientRequestId == null;
    if (!missingClientRequestId && job.idempotencyClientRequestId !== clientRequestId) {
      return null;
    }
    const conversationMatches = (job.conversationId ?? streamId) === normalizedClaim.conversationId;
    const jobProtocol = normalizeClaimProtocol(job);
    let adoptionError: unknown;
    let adopted = false;
    try {
      adopted = await this.jobStore.adoptIdempotencyKeyForJob(
        this.generationClaimKey(userId, clientRequestId, streamId),
        normalizedClaim,
        streamId,
        userId,
        clientRequestId,
        safeTenantId,
        job.createdAt,
        IDEMPOTENCY_TTL_SECONDS,
        missingClientRequestId,
      );
    } catch (error) {
      adoptionError = error;
    }
    if (!adopted) {
      try {
        await this.tombstoneObservedGenerationClaim(
          userId,
          clientRequestId,
          streamId,
          normalizedClaim,
          job.createdAt,
          jobProtocol,
        );
      } catch (tombstoneError) {
        if (adoptionError != null) {
          throw adoptionError;
        }
        throw tombstoneError;
      }
      throw new Error(
        'Live generation settled while its idempotency claim was conservatively fenced',
      );
    }
    const adoptedClaim: TokenIdempotencyClaim = {
      ...normalizedClaim,
      streamId,
      conversationId: normalizedClaim.conversationId,
      startedAt: job.createdAt,
      generationProtocolVersion: jobProtocol,
    };
    await this.synchronizeLegacyGenerationClaim(
      userId,
      clientRequestId,
      normalizedClaim,
      adoptedClaim,
    );

    if (missingClientRequestId || !conversationMatches) {
      // The exact same-owner/tenant/epoch job is active, but old metadata
      // cannot prove that this retry should attach to its UI. Both fresh
      // claims are now started tombstones: stay on the controller's 503 path
      // while active, and settle after deletion without ever allowing a
      // takeover/rebill.
      throw new Error(
        'Active legacy generation was conservatively fenced without attaching the retry',
      );
    }
    return adoptedClaim;
  }

  /**
   * Release a start-generation claim so the submission can be retried (e.g. the
   * start failed before generation began).
   */
  async releaseGeneration(
    userId: string,
    clientRequestId: string,
    streamId: string,
    expected?: IdempotencyClaimValue,
  ): Promise<void> {
    // Releasing without a token would let a stale/old request delete another
    // replica's owner. Tokenless legacy claims are duplicate-only and are
    // never owned by this manager.
    if (expected?.claimToken == null) {
      return;
    }
    const expectedClaim = normalizeTokenClaim(expected, 'release');
    assertClaimMatchesRequest(expectedClaim, streamId, expectedClaim.conversationId);

    const primaryKey = this.generationClaimKey(userId, clientRequestId, streamId);
    const primaryProbe = await this.jobStore.claimIdempotencyKey(
      primaryKey,
      expectedClaim,
      IDEMPOTENCY_TTL_SECONDS,
    );
    const primary = primaryProbe.claimed
      ? expectedClaim
      : normalizeTokenClaim(primaryProbe.existing, 'primary');
    assertClaimMirrors(expectedClaim, primary);
    if (primary.startedAt != null) {
      // createJob may have committed the primary before a later initialization
      // or legacy-mark failure. The caller still holds its pre-create value;
      // deleting the now-started tombstone would make a retry bill again.
      return;
    }
    await this.jobStore.releaseIdempotencyKey(primaryKey, expectedClaim);

    const legacyKey = this.legacyGenerationClaimKey(userId, clientRequestId);
    const legacyProbe = await this.jobStore.claimIdempotencyKey(
      legacyKey,
      expectedClaim,
      LEGACY_IDEMPOTENCY_TTL_SECONDS,
    );
    const legacy = legacyProbe.claimed
      ? expectedClaim
      : normalizeTokenClaim(legacyProbe.existing, 'legacy');
    assertClaimMirrors(legacy, expectedClaim);
    if (legacy.startedAt != null) {
      return;
    }
    await this.jobStore.releaseIdempotencyKey(legacyKey, expectedClaim);
  }

  /** Observes identity and final-save ownership without attaching a runtime or
   * promoting a slow terminal writer to stale-owner recovery. */
  async getGenerationSettlementState(
    streamId: string,
  ): Promise<GenerationSettlementState | undefined> {
    const job = await this.jobStore.getJob(streamId);
    if (job == null) return undefined;
    return {
      createdAt: job.createdAt,
      status: job.status,
      terminalPersistencePending: job.terminalPersistencePending,
    };
  }

  /** Get job status. */
  async getJobStatus(streamId: string): Promise<t.GenerationJobStatus | undefined> {
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.status as t.GenerationJobStatus | undefined;
  }

  /**
   * Atomically win terminal ownership for a running generation and park the
   * exact steer leftovers in the same transaction. A controller must not emit
   * a terminal client event before this succeeds: abort, pause, and completion
   * can all race on the same generation epoch.
   */
  /**
   * Drain both delta coalescers ahead of a terminal status CAS. Coalesced
   * deltas still buffered for a stream must land under its live status:
   * flushed after the CAS they fence against the generation's own completion,
   * and the false receipts retire a healthy runtime and error-close its
   * subscribers ahead of the terminal frame. Every terminal transition that
   * can interrupt a live emitter (claim, abort, shutdown) must call this
   * before its CAS; no-op (two Map lookups) when coalescing is off or idle.
   */
  private async flushCoalescedStreamBuffers(streamId: string): Promise<void> {
    await Promise.all([
      this.jobStore.flushPendingAppends?.(streamId),
      this.eventTransport.flushPendingChunks?.(streamId),
    ]);
  }

  private async persistAgentEventRunStepEvidence(
    streamId: string,
    job: Pick<SerializableJobData, 'createdAt' | 'agentEventDeliveryKey'>,
  ): Promise<void> {
    if (job.agentEventDeliveryKey == null) {
      return;
    }
    const buffered = this.runStepBuffers?.get(streamId);
    if (buffered?.createdAt === job.createdAt && this.jobStore.saveRunSteps != null) {
      await this.queueJobWrite(this.runStepWriteQueues, streamId, () =>
        this.jobStore.saveRunSteps!(streamId, [...buffered.steps], job.createdAt),
      );
    }
  }

  async claimTerminalJob(
    streamId: string,
    status: TerminalJobClaim['status'],
    error?: string,
    expectedCreatedAt?: number,
    options: {
      persistencePending?: boolean;
      failedPauseActionId?: string;
    } = {},
  ): Promise<TerminalJobClaim | null> {
    if (
      options.failedPauseActionId != null &&
      (status !== 'error' || options.persistencePending === true)
    ) {
      throw new Error('A failed pause-persistence claim must be a non-pending error terminal');
    }
    const observedRuntime = this.runtimeState.get(streamId);
    const targetCreatedAt = expectedCreatedAt ?? observedRuntime?.createdAt;
    let jobData = await this.jobStore.getJob(streamId);
    if (!jobData || (targetCreatedAt != null && jobData.createdAt !== targetCreatedAt)) {
      if (targetCreatedAt != null) {
        this.reconcileInactiveGeneration(streamId, targetCreatedAt, jobData, observedRuntime);
      }
      logger.debug(
        `[GenerationJobManager] Skipping stale terminal claim for replaced job: ${streamId}`,
      );
      return null;
    }
    const failedPauseActionId = options.failedPauseActionId;
    const failedPauseBarrierId =
      failedPauseActionId != null ? pausePersistenceActionId(failedPauseActionId) : undefined;
    if (failedPauseBarrierId != null) {
      /** The required response write failed while this exact controller still
       * owns the pause barrier. Terminalize from the barrier state itself;
       * releasing it first would let a waiting approval resume win the next
       * `requires_action -> running` CAS before the error transition. */
      if (
        jobData.status !== 'requires_action' ||
        jobData.terminalPersistencePending !== true ||
        jobData.pendingAction?.actionId !== failedPauseActionId ||
        jobData.pendingActionId !== failedPauseBarrierId
      ) {
        return null;
      }
    } else if (
      jobData.status === 'requires_action' &&
      jobData.terminalPersistencePending === true
    ) {
      jobData = await this._approvals.waitForPausePersistence(streamId, jobData.createdAt);
      if (!jobData || (targetCreatedAt != null && jobData.createdAt !== targetCreatedAt)) {
        return null;
      }
    }
    const sourceStatus = jobData.status;
    const canClaim =
      sourceStatus === 'running' || (status === 'error' && sourceStatus === 'requires_action');
    if (!canClaim) {
      this.reconcileInactiveGeneration(streamId, jobData.createdAt, jobData, observedRuntime);
      logger.debug(
        `[GenerationJobManager] Skipping ${status} claim for job ${streamId}: ${jobData.status}`,
      );
      return null;
    }

    const createdAt = jobData.createdAt;
    const runtime = observedRuntime?.createdAt === createdAt ? observedRuntime : undefined;
    const terminalError = status === 'error' ? (error ?? 'Generation failed') : undefined;
    await this.flushCoalescedStreamBuffers(streamId);
    await this.persistAgentEventRunStepEvidence(streamId, jobData);
    const completedAt = Date.now();
    const drainedSteers = await this.jobStore.transitionStatusAndDrainSteers(streamId, {
      from: sourceStatus,
      to: status,
      expectCreatedAt: createdAt,
      ...(sourceStatus === 'requires_action' && {
        ...(failedPauseBarrierId != null
          ? { expectActionId: failedPauseBarrierId }
          : jobData.pendingActionId != null && {
              expectActionId: jobData.pendingActionId,
            }),
      }),
      patch: {
        completedAt,
        ...(terminalError != null && { error: terminalError }),
        ...(jobData.agentEventDeliveryKey != null &&
          this.terminalHostActionHandler != null && {
            terminalHostActionPending: true,
          }),
        ...(options.persistencePending === true && {
          terminalPersistencePending: true,
          terminalPersistenceStartedAt: completedAt,
        }),
      },
      ...(sourceStatus === 'requires_action' && {
        clear: [
          'pendingAction',
          'pendingActionId',
          ...(failedPauseBarrierId != null
            ? ['terminalPersistencePending', 'terminalPersistenceStartedAt']
            : []),
        ] as (keyof SerializableJobData)[],
      }),
    });
    if (drainedSteers == null) {
      await this.reconcileLostTerminalTransition(streamId, createdAt, runtime);
      return null;
    }

    const claim: TerminalJobClaim = Object.freeze({
      streamId,
      createdAt,
      ...(jobData.conversationId != null && {
        conversationId: jobData.conversationId,
      }),
      ...(jobData.userId != null && { userId: jobData.userId }),
      status,
      ...(terminalError != null && { error: terminalError }),
      ...(options.persistencePending === true && {
        persistencePending: true as const,
      }),
      drainedSteers: Object.freeze([...drainedSteers]),
    });
    this.terminalClaimRuntimes.set(claim, runtime ?? null);

    // An aborted claim must stop its exact generation immediately. Cleanup is
    // still deferred to finishTerminalJob so terminal publication can happen
    // first and is guaranteed a finally-paired resource release.
    if (status === 'aborted') {
      try {
        this.eventTransport.emitAbort?.(streamId, createdAt);
      } catch (abortError) {
        logger.error(
          `[GenerationJobManager] Failed to publish terminal abort for ${streamId}:`,
          abortError,
        );
      }
      if (runtime && this.runtimeState.get(streamId) === runtime) {
        this.releaseAbortSubscription(runtime);
        runtime.abortController.abort();
      }
    }

    return claim;
  }

  /**
   * Durably settle and publish a persistence-owning terminal claim. Passing a
   * normal event means the controller's required writes succeeded; `null`
   * publishes conservative reconciliation instead. The store CAS also races a
   * stale-owner recovery, and whichever side wins supplies the only payload
   * this method will publish.
   */
  async publishTerminalClaim(
    claim: TerminalJobClaim,
    finalEvent: t.ServerSentEvent | null,
  ): Promise<{
    finalEvent: t.ServerSentEvent;
    persistenceFailed: boolean;
    publicationFenced?: true;
  }> {
    if (!this.terminalClaimRuntimes.has(claim) || claim.persistencePending !== true) {
      throw new Error('Terminal persistence claim was not issued by this manager');
    }

    const { streamId, createdAt } = claim;
    const claimedRuntime = this.terminalClaimRuntimes.get(claim) ?? undefined;
    const runtime =
      claimedRuntime &&
      claimedRuntime.createdAt === createdAt &&
      this.runtimeState.get(streamId) === claimedRuntime
        ? claimedRuntime
        : undefined;
    const reconcileEvent = buildTerminalPersistenceReconcile({
      createdAt,
      conversationId: claim.conversationId,
      status: claim.status,
    });
    /** The caller's event still carries prompt-building inputs, so everything
     * this method stores, publishes or caches uses the projected payload. The
     * projection allocates a new object whenever it excludes anything, so
     * `intendedEvent` — not the caller's reference — is what the success
     * bookkeeping below compares identity against. */
    const intendedEvent = finalEvent == null ? null : projectTerminalEvent(finalEvent);
    const desiredEvent = intendedEvent ?? reconcileEvent;
    let publicationEvent: t.ServerSentEvent | null = null;
    let durable = false;

    try {
      const finalized = await this.jobStore.finalizeTerminalPersistence(
        streamId,
        createdAt,
        JSON.stringify(desiredEvent),
      );
      if (finalized) {
        publicationEvent = desiredEvent;
        durable = true;
      } else {
        const settledJob = await this.jobStore.getJob(streamId);
        if (
          settledJob?.createdAt === createdAt &&
          settledJob.terminalPersistencePending !== true &&
          settledJob.finalEvent
        ) {
          /** Written by whichever side won the CAS, possibly a replica that
           * predates projection. Project on read so a legacy oversized record
           * is not republished unchanged. */
          publicationEvent = projectTerminalEvent(
            JSON.parse(settledJob.finalEvent) as t.ServerSentEvent,
          );
          durable = true;
        }
      }
    } catch (settleError) {
      logger.error(
        `[GenerationJobManager] Failed to finalize terminal persistence for ${streamId}:`,
        settleError,
      );
    }

    /** If durable finalization itself failed, leave the marker for bounded
     * stale-owner recovery but still close an already-attached client with the
     * conservative frame. Do not cache that best-effort frame on the runtime:
     * late subscribers must honor the durable pending marker. */
    if (!publicationEvent) {
      publicationEvent = reconcileEvent;
    } else if (runtime) {
      runtime.finalEvent = publicationEvent;
    }
    const persistenceFailed =
      intendedEvent == null ||
      !durable ||
      publicationEvent !== intendedEvent ||
      ('reconcile' in publicationEvent && publicationEvent.reconcile === true);

    try {
      if (runtime?.createdEventPublication) {
        await runtime.createdEventPublication;
      }
      await this.eventTransport.emitDone(streamId, publicationEvent, createdAt);
    } catch (publicationError) {
      if (publicationError instanceof GenerationPublicationFencedError) {
        return {
          finalEvent: publicationEvent,
          persistenceFailed,
          publicationFenced: true,
        };
      }
      logger.error(
        `[GenerationJobManager] Failed to publish terminal persistence result ${streamId}:`,
        publicationError,
      );
      if (durable) {
        this.terminalPublicationFailures.add(claim);
      }
      /** Publication can yield long enough for a same-stream replacement to
       * install its own runtime/subscriber. Close only while the exact runtime
       * captured by this terminal claim is still current; the check and the
       * synchronous close call deliberately have no await between them. */
      if (runtime && this.runtimeState.get(streamId) === runtime) {
        try {
          this.eventTransport.closeLocalSubscribers?.(
            streamId,
            TERMINAL_PUBLICATION_RECONNECT_ERROR,
          );
        } catch (closeError) {
          logger.error(
            `[GenerationJobManager] Failed to close local subscribers after terminal publication failure ${streamId}:`,
            closeError,
          );
        }
      }
      throw publicationError;
    }

    if (!persistenceFailed && runtime?.startupTelemetry) {
      this.recordStartupEvent(runtime, publicationEvent);
    }
    return { finalEvent: publicationEvent, persistenceFailed };
  }

  /**
   * Release resources owned by a successful terminal claim. Reusing the same
   * claim is idempotent, and every local mutation is pinned to the runtime
   * object and generation epoch captured when the CAS won.
   */
  /**
   * Calls `listener` after each generation owned by this process reaches a
   * terminal state and its runtime is released — by completion, error, or
   * abort. Listeners run synchronously and must not throw; failures are logged
   * and never affect terminal cleanup. Returns an unsubscribe function.
   */
  onGenerationSettled(listener: GenerationSettledListener): () => void {
    this.generationSettledListeners.add(listener);
    return () => {
      this.generationSettledListeners.delete(listener);
    };
  }

  private notifyGenerationSettled(
    target: Pick<TerminalJobClaim, 'streamId' | 'conversationId' | 'userId' | 'status'>,
  ): void {
    if (target.userId == null || this.generationSettledListeners.size === 0) {
      return;
    }
    const event: GenerationSettledEvent = {
      streamId: target.streamId,
      conversationId: target.conversationId ?? target.streamId,
      userId: target.userId,
      status: target.status,
    };
    for (const listener of this.generationSettledListeners) {
      try {
        listener(event);
      } catch (listenerError) {
        logger.error('[GenerationJobManager] Generation settled listener failed', listenerError);
      }
    }
  }

  finishTerminalJob(claim: TerminalJobClaim): Promise<void> {
    const inFlight = this.terminalFinishPromises.get(claim);
    if (inFlight) {
      return inFlight;
    }
    if (!this.terminalClaimRuntimes.has(claim)) {
      return Promise.reject(new Error('Terminal claim was not issued by this manager'));
    }

    const finishing = this.finishTerminalJobInternal(claim);
    this.terminalFinishPromises.set(claim, finishing);
    return finishing;
  }

  private async finishTerminalJobInternal(claim: TerminalJobClaim): Promise<void> {
    const { streamId, createdAt, status, error } = claim;
    const retainForTerminalReplay = this.terminalPublicationFailures.has(claim);
    const claimedRuntime = this.terminalClaimRuntimes.get(claim) ?? undefined;
    const runtime =
      claimedRuntime &&
      claimedRuntime.createdAt === createdAt &&
      this.runtimeState.get(streamId) === claimedRuntime
        ? claimedRuntime
        : undefined;
    await runtime?.subscriberStateWrite?.catch(() => undefined);
    let cleanupError: unknown;
    let retainTerminalHostEvidence = false;
    let persistedLifecycle: SerializableJobData | null | undefined = null;
    if (runtime != null) {
      persistedLifecycle = await this.jobStore.getJob(streamId).catch((lifecycleError) => {
        logger.error('[GenerationJobManager] Failed to read terminal subscriber lifecycle', {
          streamId,
          error: lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
        });
        return undefined;
      });
    }
    const generationHadSubscriber =
      runtime?.everHadSubscriber === true ||
      (persistedLifecycle?.createdAt === createdAt &&
        persistedLifecycle.firstSubscriberAttachedAt != null);
    const unresolvedOverflow =
      runtime?.earlyBufferOverflow?.recoveryOutcome == null
        ? runtime?.earlyBufferOverflow
        : undefined;
    if (runtime != null && unresolvedOverflow != null) {
      let remoteSubscriberActive: boolean | undefined =
        persistedLifecycle === undefined ? undefined : false;
      if (persistedLifecycle?.createdAt === createdAt) {
        remoteSubscriberActive = await this.jobStore
          .hasActiveSubscriber(streamId, createdAt, Date.now())
          .catch((leaseError) => {
            logger.error(
              '[GenerationJobManager] Failed to read active subscriber leases',
              leaseError,
            );
            return undefined;
          });
      }
      /** A failed lease read is not evidence of an active subscriber. Leave the
       * overflow unresolved so a later resume must still validate recovery. */
      if (runtime.hasSubscriber || remoteSubscriberActive != null) {
        const subscriberActive = runtime.hasSubscriber || remoteSubscriberActive === true;
        let unobservedFailureReason: EarlyBufferRecoveryFailureReason | undefined;
        if (!subscriberActive) {
          unobservedFailureReason = generationHadSubscriber
            ? 'subscriber_disconnected'
            : 'subscriber_never_attached';
        }
        await this.settleEarlyBufferRecovery(
          streamId,
          runtime,
          unresolvedOverflow,
          subscriberActive ? 'not_required' : 'failed',
          0,
          0,
          0,
          unobservedFailureReason,
        ).catch((recoveryError) => {
          logger.error(
            '[GenerationJobManager] Failed to settle unobserved early buffer recovery',
            recoveryError,
          );
        });
      }
    }

    // Error jobs stay durable long enough for late subscribers to receive the
    // stored error. A publication failure must never bypass the finally cleanup.
    try {
      const claimedTerminalJob = await this.jobStore.getJob(streamId);
      if (
        claimedTerminalJob?.createdAt === createdAt &&
        claimedTerminalJob.terminalHostActionPending === true
      ) {
        retainTerminalHostEvidence =
          claimedTerminalJob.providerDrained === false ||
          !(await this.runTerminalHostActionHandler(streamId, claimedTerminalJob));
      }
      if (status === 'error' && !this.terminalErrorPublicationSuppressions.has(claim)) {
        const terminalError = error ?? 'Generation failed';
        if (runtime) {
          runtime.errorEvent = terminalError;
        }
        try {
          if (runtime?.createdEventPublication) {
            await runtime.createdEventPublication;
          }
          await this.eventTransport.emitError(streamId, terminalError, createdAt);
        } catch (publishError) {
          if (!(publishError instanceof GenerationPublicationFencedError)) {
            logger.error(
              `[GenerationJobManager] Failed to publish terminal error for ${streamId}:`,
              publishError,
            );
            if (runtime && this.runtimeState.get(streamId) === runtime) {
              for (const notify of [...runtime.localErrorHandlers]) {
                try {
                  notify(terminalError);
                } catch (notifyError) {
                  logger.error(
                    `[GenerationJobManager] Failed to notify terminal error for ${streamId}:`,
                    notifyError,
                  );
                }
              }
            }
          }
        }
      } else if (this._cleanupOnComplete) {
        // A failed finalization write deliberately leaves any terminal pending
        // marker for bounded stale-owner recovery. Every normally finalized
        // persistence-owning claim clears it before reaching this cleanup. A
        // durable final whose DONE publish failed is retained for reconnect
        // replay even though its pending marker is already clear.
        const terminalJob = await this.jobStore.getJob(streamId);
        if (
          !retainForTerminalReplay &&
          terminalJob?.providerDrained !== false &&
          terminalJob?.preserveForScheduleReconcile !== true &&
          terminalJob?.terminalHostActionPending !== true &&
          (terminalJob?.createdAt !== createdAt || terminalJob.terminalPersistencePending !== true)
        ) {
          // A same-stream replacement created after the claim makes this a safe
          // no-op rather than deleting the replacement generation.
          await this.jobStore.deleteJob(streamId, createdAt);
        }
      }
    } catch (err) {
      cleanupError = err;
      retainTerminalHostEvidence = true;
    } finally {
      if (runtime && this.runtimeState.get(streamId) === runtime) {
        if (!generationHadSubscriber) {
          recordGenerationStreamAttachment(this.storeLabel, 'never_attached');
        }
        this.releaseAbortSubscription(runtime);
        runtime.abortController.abort();
        if (status === 'error') {
          runtime.startupTelemetry?.end('error', new Error(error ?? 'Generation failed'));
        } else if (status === 'aborted') {
          runtime.startupTelemetry?.end('aborted');
        } else {
          runtime.startupTelemetry?.end('completed_without_delta');
        }
        runtime.startupTelemetry = undefined;
        if (!retainTerminalHostEvidence) {
          this.jobStore.clearContentState(streamId, createdAt);
          this.runStepBuffers?.delete(streamId);
        }
        this.replayEventWriteQueues.delete(streamId);
        this.tokenUsageWriteQueues.delete(streamId);
        this.runStepWriteQueues.delete(streamId);
        if (status !== 'error' && this._cleanupOnComplete) {
          this.stopSubscriberLease(runtime);
          this.runtimeState.delete(streamId);
        }
      }

      this.releaseJobOwnership(streamId, createdAt);
      this.terminalPublicationFailures.delete(claim);
      this.terminalErrorPublicationSuppressions.delete(claim);
      let metricStatus: 'completed' | 'error' | 'aborted' = 'aborted';
      if (status === 'complete') {
        metricStatus = 'completed';
      } else if (status === 'error') {
        metricStatus = 'error';
      }
      recordGenerationJob(this.storeLabel, metricStatus);
      this.notifyGenerationSettled(claim);
    }

    if (cleanupError != null) {
      throw cleanupError;
    }
    logger.debug(
      status === 'error'
        ? `[GenerationJobManager] Job completed with error (keeping for late subscribers): ${streamId}`
        : `[GenerationJobManager] Job ${status}: ${streamId}`,
    );
  }

  /**
   * Mark job as complete.
   * Returns true only when this caller won the terminal CAS and finished it;
   * controllers can safely gate generation-owned cleanup on that result.
   * If cleanupOnComplete is true (default), immediately cleans up job resources.
   * Exception: Jobs with errors are NOT immediately deleted to allow late-connecting
   * clients to receive the error (race condition where error occurs before client connects).
   * Note: eventTransport is NOT cleaned up here to allow the final event to be
   * fully transmitted. It will be cleaned up when subscribers disconnect or
   * by the periodic cleanup job.
   */
  async completeJob(
    streamId: string,
    error?: string,
    expectedCreatedAt?: number,
    options: { beforeErrorPublication?: () => Promise<void> } = {},
  ): Promise<boolean> {
    const beforeErrorPublication = error ? options.beforeErrorPublication : undefined;
    const claim = await this.claimTerminalJob(
      streamId,
      error ? 'error' : 'complete',
      error,
      expectedCreatedAt,
      beforeErrorPublication ? { persistencePending: true } : undefined,
    );
    if (!claim) {
      return false;
    }

    if (beforeErrorPublication) {
      let persistenceFinalized = false;
      try {
        await beforeErrorPublication();
        persistenceFinalized = await this.jobStore.finalizeTerminalPersistence(
          streamId,
          claim.createdAt,
          JSON.stringify(
            buildTerminalPersistenceReconcile({
              createdAt: claim.createdAt,
              conversationId: claim.conversationId,
              status: claim.status,
            }),
          ),
        );
      } catch (persistenceError) {
        logger.error(
          `[GenerationJobManager] Failed required error persistence for ${streamId}:`,
          persistenceError,
        );
        try {
          await this.publishTerminalClaim(claim, null);
        } catch (publishError) {
          logger.error(
            `[GenerationJobManager] Failed to publish error persistence reconciliation for ${streamId}:`,
            publishError,
          );
        }
      }

      if (!persistenceFinalized) {
        this.terminalErrorPublicationSuppressions.add(claim);
      }
    }

    await this.finishTerminalJob(claim);
    return true;
  }

  /**
   * Atomically fail the exact paused action whose required unfinished-response
   * write did not succeed. Unlike `finishPausePersistence` followed by
   * `completeJob`, this never exposes the ordinary action id between those two
   * decisions, so a waiting/concurrent resume cannot drive an unpersisted turn.
   */
  async failPausePersistence(
    streamId: string,
    actionId: string,
    error: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    if (actionId.length === 0) {
      return false;
    }
    const claim = await this.claimTerminalJob(streamId, 'error', error, expectedCreatedAt, {
      failedPauseActionId: actionId,
    });
    if (!claim) {
      return false;
    }
    await this.finishTerminalJob(claim);
    return true;
  }

  /**
   * Abort a job (user-initiated).
   * Returns all data needed for token spending and message saving.
   *
   * Cross-replica support (Redis mode):
   * - Emits abort signal via Redis pub/sub
   * - The replica running generation receives signal and aborts its AbortController
   *
   * `options.transformAbortContent` rewrites the reconstructed content BEFORE
   * persistence filtering and the final SSE (and before it is returned for the DB save), so a
   * host-side stamp — e.g. re-attaching a paused `ask_user_question`'s args
   * that the Redis chunk-log reconstruction dropped — reaches the LIVE client
   * too, not just the saved message. Pure/optional; identity when omitted.
   */
  async abortJob(
    streamId: string,
    options?: {
      transformAbortContent?: (
        content: TMessageContentParts[],
        jobData: SerializableJobData,
      ) => TMessageContentParts[];
      /** Required durable work (for example saving the partial response and
       * pruning the paused checkpoint) that must finish before the normal
       * FINAL lets the client submit against that history. Throwing emits a
       * conservative reconciliation frame instead of the normal payload. */
      beforePublish?: (result: AbortResult) => void | Promise<void>;
      /** Epoch observed by the authenticated route. Without this fence, a
       * same-stream replacement between authorization and the manager read
       * could be stopped by a stale request intended for its predecessor. */
      expectedCreatedAt?: number;
      /** Destructive user cleanup must wait until the provider owner has
       * completed every trailing persistence task, not merely received Stop. */
      awaitProviderDrain?: boolean;
    },
  ): Promise<AbortResult> {
    const observedRuntime = this.runtimeState.get(streamId);
    let jobData = await this.jobStore.getJob(streamId);

    if (options?.expectedCreatedAt != null && jobData?.createdAt !== options.expectedCreatedAt) {
      this.reconcileInactiveGeneration(
        streamId,
        options.expectedCreatedAt,
        jobData,
        observedRuntime?.createdAt === options.expectedCreatedAt ? observedRuntime : undefined,
      );
      logger.debug(
        `[GenerationJobManager] Refusing stale abort for replaced job: ${streamId}@${options.expectedCreatedAt}`,
      );
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData,
        success: false,
        failureReason: 'generation_replaced',
        finalEvent: null,
        collectedUsage: [],
      };
    }

    if (!jobData) {
      if (observedRuntime) {
        this.reconcileInactiveGeneration(
          streamId,
          observedRuntime.createdAt,
          jobData,
          observedRuntime,
        );
      }
      logger.warn(`[GenerationJobManager] Cannot abort - job not found: ${streamId}`);
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData: null,
        success: false,
        /** The job vanished between the caller's read and this one. No transition
         * was made and no provider drain was awaited, so this says nothing about
         * whether trailing owner work is still in flight. */
        failureReason: 'job_not_found',
        finalEvent: null,
        collectedUsage: [],
      };
    }

    if (jobData.status === 'requires_action' && jobData.terminalPersistencePending === true) {
      const unlockedJob = await this._approvals.waitForPausePersistence(
        streamId,
        jobData.createdAt,
      );
      if (!unlockedJob || unlockedJob.createdAt !== jobData.createdAt) {
        this.reconcileInactiveGeneration(streamId, jobData.createdAt, unlockedJob, observedRuntime);
        return {
          text: '',
          content: [],
          jobData: unlockedJob,
          success: false,
          /** The pause never unlocked for THIS generation: the job was either deleted
           * outright or a replacement took the conversation. A replacement is another
           * run's state — settling or pruning on it would destroy the successor. */
          failureReason: unlockedJob == null ? 'job_not_found' : 'generation_replaced',
          finalEvent: null,
          collectedUsage: [],
        };
      }
      jobData = unlockedJob;
    }

    const abortableStatus = jobData.status;
    if (abortableStatus !== 'running' && abortableStatus !== 'requires_action') {
      if (options?.awaitProviderDrain) {
        await this.waitForProviderDrainIfRequired(streamId, jobData);
      }
      this.reconcileInactiveGeneration(streamId, jobData.createdAt, jobData, observedRuntime);
      logger.debug(
        `[GenerationJobManager] Cannot abort terminal job ${streamId}: ${jobData.status}`,
      );
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData,
        success: false,
        /** No transition was needed: the generation is already terminal, and the
         * drain above (when requested) proves its provider segment can no longer
         * persist. This is a stop, just not one this call made. */
        failureReason: 'already_settled',
        finalEvent: null,
        collectedUsage: [],
      };
    }

    const runtime = observedRuntime?.createdAt === jobData.createdAt ? observedRuntime : undefined;
    /** Abort claims terminal state through its own CAS loop below (not
     * claimTerminalJob), so it must drain the coalescers itself — and ahead of
     * the content snapshot, so a chunk-log reconstruction sees the window tail. */
    await this.flushCoalescedStreamBuffers(streamId);
    await this.persistAgentEventRunStepEvidence(streamId, jobData);
    /** Snapshot before claiming terminal state. This is non-destructive: if a
     * same-epoch approval resume wins the later CAS, its content and steer
     * queue remain fully owned by that resumed run. */
    const result = await this.jobStore.getContentParts(streamId, jobData.createdAt);
    let content = result?.content ?? [];
    let abortContent = filterPersistableAbortContent(content);
    let shouldPersistAbortContent = abortContent.length > 0;

    /** Collected usage for all models */
    const collectedUsage = this.jobStore.getCollectedUsage(streamId, jobData.createdAt);

    /** Text from content parts for fallback token counting; the persisted
     *  abort record keeps steered words (they reached the model context). */
    let text = shouldPersistAbortContent
      ? parseTextParts(abortContent as TMessageContentParts[], false, {
          includeSteer: true,
        })
      : '';

    /** Claim terminal ownership and drain steers in one store transaction. A
     * destructive pre-CAS drain would corrupt a same-epoch run when approval
     * resolution wins `requires_action -> running`. The returned batch is the
     * exact queued/claimed set parked by the winning abort, so the final event
     * can restore it without a second read or a recovery race. */
    const terminalPersistenceStartedAt = Date.now();
    let transitionFrom = abortableStatus;
    let drainedSteers: SteerQueueItem[] | null = null;
    let currentAfterConflict: SerializableJobData | null = jobData;
    // An approval decision can move the same epoch between running and
    // requires_action after our read. Retry that legal same-generation state
    // change instead of telling the caller it stopped a run that is still live.
    for (let attempt = 0; attempt < 3 && drainedSteers == null; attempt++) {
      const expectedActionId =
        transitionFrom === 'requires_action' ? currentAfterConflict?.pendingActionId : undefined;
      drainedSteers = await this.jobStore.transitionStatusAndDrainSteers(streamId, {
        from: transitionFrom,
        to: 'aborted',
        expectCreatedAt: jobData.createdAt,
        ...(expectedActionId != null && { expectActionId: expectedActionId }),
        patch: {
          completedAt: terminalPersistenceStartedAt,
          terminalPersistencePending: true,
          terminalPersistenceStartedAt,
          ...(jobData.agentEventDeliveryKey != null &&
            this.terminalHostActionHandler != null && {
              terminalHostActionPending: true,
            }),
        },
      });
      if (drainedSteers != null) {
        break;
      }
      currentAfterConflict = await this.jobStore.getJob(streamId);
      if (
        currentAfterConflict?.createdAt === jobData.createdAt &&
        currentAfterConflict.status === 'requires_action' &&
        currentAfterConflict.terminalPersistencePending === true
      ) {
        currentAfterConflict = await this._approvals.waitForPausePersistence(
          streamId,
          jobData.createdAt,
        );
      }
      if (
        currentAfterConflict?.createdAt !== jobData.createdAt ||
        (currentAfterConflict.status !== 'running' &&
          currentAfterConflict.status !== 'requires_action')
      ) {
        break;
      }
      if (
        currentAfterConflict.status === transitionFrom &&
        (transitionFrom !== 'requires_action' ||
          currentAfterConflict.pendingActionId === expectedActionId)
      ) {
        break;
      }
      transitionFrom = currentAfterConflict.status;
    }
    if (drainedSteers == null) {
      const currentJob = await this.jobStore.getJob(streamId);
      this.reconcileInactiveGeneration(streamId, jobData.createdAt, currentJob, runtime);
      const jobStillActive =
        currentJob?.createdAt === jobData.createdAt &&
        (currentJob.status === 'running' || currentJob.status === 'requires_action');
      if (options?.awaitProviderDrain) {
        if (jobStillActive || currentJob?.createdAt !== jobData.createdAt) {
          throw new Error(`Failed to stop provider execution before user cleanup: ${streamId}`);
        }
        await this.waitForProviderDrainIfRequired(streamId, currentJob ?? jobData);
      }
      return {
        success: false,
        /** The drain above already ran when the caller required one, so an
         * `already_settled` verdict here is a fully drained generation. */
        failureReason: classifyLostAbortRace(jobStillActive, currentJob, jobData.createdAt),
        jobData,
        content: abortContent,
        finalEvent: null,
        text,
        collectedUsage,
      };
    }
    // The successful CAS may follow a same-generation approval transition.
    // Use the snapshot that selected the winning source status so host-side
    // content transforms see metadata committed by that transition.
    jobData = currentAfterConflict ?? jobData;
    const terminalClaim: TerminalJobClaim = Object.freeze({
      streamId,
      createdAt: jobData.createdAt,
      ...(jobData.conversationId != null && {
        conversationId: jobData.conversationId,
      }),
      ...(jobData.userId != null && { userId: jobData.userId }),
      status: 'aborted',
      persistencePending: true,
      drainedSteers: Object.freeze([...drainedSteers]),
    });
    this.terminalClaimRuntimes.set(terminalClaim, runtime ?? null);

    try {
      const pendingSteers = drainedSteers.map(toPendingSteer);

      // Signal only the generation whose terminal transaction won above. The
      // transport tag prevents a delayed predecessor abort from reaching a
      // same-stream replacement on another replica.
      if (this.eventTransport.emitAbort) {
        try {
          this.eventTransport.emitAbort(streamId, jobData.createdAt);
        } catch (abortError) {
          logger.error(
            `[GenerationJobManager] Failed to publish terminal abort for ${streamId}:`,
            abortError,
          );
        }
      }
      if (runtime) {
        this.releaseAbortSubscription(runtime);
      }
      runtime?.abortController.abort();

      // A chunk append racing the initial non-destructive snapshot either
      // commits before the terminal CAS or loses its own running-status guard.
      // Re-read after our CAS so the abort payload includes every committed
      // part while never borrowing content from a replacement epoch.
      try {
        const committed = await this.jobStore.getContentParts(streamId, jobData.createdAt);
        if (committed) {
          content = committed.content;
        }
      } catch (contentError) {
        logger.warn(
          `[GenerationJobManager] Failed to refresh committed abort content for ${streamId}:`,
          contentError,
        );
      }
      /** The owner publishes run state (context meta) ahead of each model call
       * and awaits that write, so a publish that landed after the initial read
       * describes the call whose partial output the snapshot above carries.
       * Read it back from the same epoch so the stopped response persists the
       * tier that produced its bytes, not the one seen before the claim. */
      try {
        const refreshed = await this.jobStore.getJob(streamId);
        if (refreshed?.createdAt === jobData.createdAt && refreshed.contextMeta != null) {
          jobData = { ...jobData, contextMeta: refreshed.contextMeta };
        }
      } catch (metadataError) {
        logger.warn(
          `[GenerationJobManager] Failed to refresh committed abort metadata for ${streamId}:`,
          metadataError,
        );
      }
      if (options?.transformAbortContent) {
        content = options.transformAbortContent(
          content as TMessageContentParts[],
          jobData,
        ) as typeof content;
      }
      // Answer stamps use ordinals from the unfiltered chunk reconstruction.
      // Filter only after the transform so sparse/empty/OAuth parts cannot
      // shift a retained ID-less ask answer onto a different tool call.
      abortContent = filterPersistableAbortContent(content);
      shouldPersistAbortContent = abortContent.length > 0;
      text = shouldPersistAbortContent
        ? parseTextParts(abortContent as TMessageContentParts[], false, {
            includeSteer: true,
          })
        : '';

      /** Detect "early abort" - aborted before any generation happened (e.g., during tool loading)
      In this case, no messages were saved to DB, so frontend shouldn't navigate to conversation */
      const isEarlyAbort = !shouldPersistAbortContent && jobData.createdEventEmitted !== true;

      /** Final event for abort */
      const userMessageId = jobData.userMessage?.messageId;
      const userSubmittedPaths = [
        ...new Set([
          ...(jobData.userSubmittedPaths ?? []),
          ...getSteerUserSubmittedPaths(abortContent as TMessageContentParts[]),
        ]),
      ];
      const userSubmittedMessageFieldPaths = jobData.userSubmittedMessageFieldPaths ?? [];

      const abortFinalEvent: t.ServerSentEvent = {
        final: true,
        // Don't include conversation for early aborts - it doesn't exist in DB
        conversation: isEarlyAbort ? null : { conversationId: jobData.conversationId },
        title: 'New Chat',
        requestMessage: jobData.userMessage
          ? {
              messageId: userMessageId,
              parentMessageId: jobData.userMessage.parentMessageId,
              conversationId: jobData.conversationId,
              text: jobData.userMessage.text ?? '',
              quotes: jobData.userMessage.quotes,
              isCreatedByUser: true,
            }
          : null,
        responseMessage: isEarlyAbort
          ? null
          : {
              messageId: jobData.responseMessageId ?? `${userMessageId ?? 'aborted'}_`,
              parentMessageId: userMessageId,
              conversationId: jobData.conversationId,
              content: abortContent,
              sender: jobData.sender ?? 'AI',
              endpoint: jobData.endpoint,
              iconURL: jobData.iconURL,
              model: jobData.model,
              unfinished: true,
              error: false,
              isCreatedByUser: false,
              ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
              ...(userSubmittedMessageFieldPaths.length > 0 && {
                userSubmittedMessageFieldPaths,
              }),
            },
        aborted: true,
        // Flag for early abort - no messages saved, frontend should go to new chat
        earlyAbort: isEarlyAbort,
        ...(pendingSteers.length > 0 && { pendingSteers }),
      } satisfies t.FinalEvent as t.ServerSentEvent;

      const abortResult: AbortResult = {
        success: true,
        jobData,
        content: abortContent,
        finalEvent: abortFinalEvent,
        text,
        collectedUsage,
        ...(pendingSteers.length > 0 && { pendingSteers }),
      };

      let requiredPersistenceFailed = false;
      try {
        if (options?.beforePublish) {
          await options.beforePublish(abortResult);
        }
      } catch (persistenceError) {
        requiredPersistenceFailed = true;
        logger.error(
          `[GenerationJobManager] Required abort persistence failed for ${streamId}:`,
          persistenceError,
        );
      }

      const publication = await this.publishTerminalClaim(
        terminalClaim,
        requiredPersistenceFailed ? null : abortFinalEvent,
      );

      return {
        ...abortResult,
        finalEvent: publication.finalEvent,
        ...(publication.persistenceFailed && { persistenceFailed: true }),
      };
    } finally {
      try {
        const mustDrainForTerminalEvidence = jobData.agentEventDeliveryKey != null;
        if (options?.awaitProviderDrain || mustDrainForTerminalEvidence) {
          await this.waitForProviderDrainIfRequired(streamId, jobData);
          await this.persistAgentEventRunStepEvidence(streamId, jobData);
        }
      } finally {
        await this.finishTerminalJob(terminalClaim);
      }
    }
  }

  /**
   * Subscribe to a job's event stream.
   *
   * This is called when an SSE client connects to /chat/stream/:streamId.
   * On first subscription:
   * - Resolves readyPromise (legacy, for API compatibility)
   * - Replays any buffered early events (e.g., 'created' event)
   *
   * Supports cross-replica reconnection in Redis mode:
   * - If job exists in Redis but not locally, creates minimal runtime state
   * - Events are delivered via Redis pub/sub, not in-memory EventEmitter
   *
   * @param streamId - The stream to subscribe to
   * @param onChunk - Handler for chunk events (streamed tokens, run steps, etc.)
   * @param onDone - Handler for completion event (includes final message)
   * @param onError - Handler for error events
   * @param options - Subscription configuration
   * @param options.skipBufferReplay - When true, skips replaying the earlyEventBuffer.
   *   Use this when a sync event was already sent (resume), since the sync's
   *   aggregatedContent already includes all buffered events.
   * @returns Subscription object with unsubscribe function, or null if job not found
   */
  async subscribe(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    options?: t.SubscribeOptions,
  ): Promise<t.StreamSubscription | null> {
    return this.attachSubscription(streamId, onChunk, onDone, onError, options);
  }

  private async attachSubscription(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    options?: t.SubscribeOptions,
    prepared?: PreparedSubscription,
  ): Promise<(t.StreamSubscription & { activate?: () => void }) | null> {
    const attachmentStartedAt = Date.now();
    const subscriptionType = options?.skipBufferReplay ? 'resume' : 'initial';
    if (options?.signal?.aborted) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      return null;
    }
    if (this.rejectSubscriptionDuringShutdown(subscriptionType, onError)) {
      return null;
    }

    // Read the durable generation first, then reconcile any lazily-created
    // runtime against it. This also avoids the historical second Redis lookup
    // when a cross-replica subscriber has no local runtime yet.
    let jobData = prepared ? prepared.jobData : await this.jobStore.getJob(streamId);
    if (jobData) {
      jobData = await this.recoverStaleTerminalPersistence(jobData);
    }
    if (options?.signal?.aborted) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      return null;
    }
    if (this.rejectSubscriptionDuringShutdown(subscriptionType, onError)) {
      return null;
    }
    if (options?.expectedCreatedAt != null && jobData?.createdAt !== options.expectedCreatedAt) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
      return null;
    }

    const runtime = prepared?.runtime ?? (await this.getOrCreateRuntimeState(streamId, jobData));
    if (options?.signal?.aborted) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      return null;
    }
    if (this.rejectSubscriptionDuringShutdown(subscriptionType, onError)) {
      return null;
    }
    if (!runtime) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
      return null;
    }
    if (options?.expectedCreatedAt != null && runtime.createdAt !== options.expectedCreatedAt) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
      return null;
    }

    if (
      this.runtimeState.get(streamId) !== runtime ||
      (jobData && runtime.createdAt !== jobData.createdAt)
    ) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      return null;
    }

    let subscriptionActive = true;
    let createdEventDelivered = options?.skipBufferReplay === true;
    let terminalEventDelivered = false;
    let terminalEventQueued = false;
    let terminalPersistenceTimer: NodeJS.Timeout | null = null;
    /** Identity-fenced initial subscriptions remain paused until a final
     * durable job check immediately before replay. This prevents a job
     * replacement during attachment awaits from leaking either replayed or
     * live events into the stale request. Resume subscriptions already use
     * the same pause for their sync-first protocol. */
    let deliveryActivated =
      prepared?.deferDeliveryUntilActivated !== true && options?.expectedCreatedAt == null;
    let deferredDeliveries: DeferredDelivery[] = [];
    let subscription: {
      ready?: Promise<void>;
      unsubscribe: t.UnsubscribeFn;
      activate?: () => void;
    } | null = null;
    const releaseSubscriberOnlyAbortSubscription = (generationId?: number): void => {
      if (
        generationId == null ||
        generationId !== runtime.createdAt ||
        this.ownedJobs.get(streamId) === runtime.createdAt
      ) {
        return;
      }
      this.releaseAbortSubscription(runtime);
      runtime.abortController.abort();
    };
    const deliverChunk = (event: t.ServerSentEvent): void => {
      if (!subscriptionActive || terminalEventDelivered) {
        return;
      }
      if ('created' in event) {
        if (createdEventDelivered) {
          return;
        }
        createdEventDelivered = true;
      }
      onChunk(event);
    };
    const deliverDone = (event: t.ServerSentEvent): void => {
      if (!subscriptionActive || terminalEventDelivered) {
        return;
      }
      terminalEventDelivered = true;
      runtime.finalEvent = event;
      try {
        onDone?.(event);
      } finally {
        subscription?.unsubscribe();
      }
    };
    const deliverError = (error: string): void => {
      if (!subscriptionActive || terminalEventDelivered) {
        return;
      }
      terminalEventDelivered = true;
      // These internal close signals only recycle this process's SSE response; they are not
      // durable terminal job errors. Leave errorEvent unset so a reconnect can replay the
      // authoritative store state instead of inheriting a process-local transport failure.
      if (error !== SHUTDOWN_SUBSCRIBER_ERROR && error !== TERMINAL_PUBLICATION_RECONNECT_ERROR) {
        runtime.errorEvent = error;
      }
      try {
        onError?.(error);
      } finally {
        subscription?.unsubscribe();
      }
    };
    const queueChunk = (event: t.ServerSentEvent): void => {
      if (!subscriptionActive || terminalEventDelivered || terminalEventQueued) {
        return;
      }
      if (!deliveryActivated) {
        deferredDeliveries.push({ type: 'chunk', event });
        return;
      }
      deliverChunk(event);
    };
    const queueDone = (rawEvent: t.ServerSentEvent, generationId?: number): void => {
      if (generationId != null && generationId !== runtime.createdAt) {
        return;
      }
      if (!subscriptionActive || terminalEventDelivered || terminalEventQueued) {
        return;
      }
      /** The only choke point every terminal delivery to this subscriber passes
       * through, so it is where a frame published by a replica that predates
       * projection gets excluded. Store-read paths are already projected; a live
       * Pub/Sub FINAL from an old generation owner during a rolling deploy is
       * not, and without this it would be cached on the runtime and forwarded to
       * the browser with its prompt inputs intact. Idempotent, and returns the
       * identical reference for an already-projected frame. */
      const event = projectTerminalEvent(rawEvent);
      if (!deliveryActivated) {
        terminalEventQueued = true;
        runtime.finalEvent = event;
        deferredDeliveries.push({ type: 'done', event });
        return;
      }
      deliverDone(event);
    };
    const queueError = (error: string, generationId?: number): void => {
      if (generationId != null && generationId !== runtime.createdAt) {
        return;
      }
      if (!subscriptionActive || terminalEventDelivered || terminalEventQueued) {
        return;
      }
      if (!deliveryActivated) {
        terminalEventQueued = true;
        if (error !== SHUTDOWN_SUBSCRIBER_ERROR && error !== TERMINAL_PUBLICATION_RECONNECT_ERROR) {
          runtime.errorEvent = error;
        }
        deferredDeliveries.push({ type: 'error', error });
        return;
      }
      deliverError(error);
    };
    const activateDelivery = (): void => {
      if (!subscriptionActive || deliveryActivated) {
        return;
      }

      deliveryActivated = true;
      const deliveries = deferredDeliveries;
      deferredDeliveries = [];

      for (const delivery of deliveries) {
        if (!subscriptionActive) {
          return;
        }
        if (delivery.type === 'chunk') {
          deliverChunk(delivery.event);
        } else if (delivery.type === 'done') {
          terminalEventQueued = false;
          deliverDone(delivery.event);
        } else {
          terminalEventQueued = false;
          deliverError(delivery.error);
        }
      }
    };

    const deferSequenceDelivery =
      this._isRedis && !runtime.hasSubscriber && !options?.skipBufferReplay;
    const transportSubscription = this.eventTransport.subscribe(
      streamId,
      {
        onChunk: (event, generationId) => {
          const currentRuntime = this.runtimeState.get(streamId);
          const isMatchingTerminalDrain =
            currentRuntime == null && generationId === runtime.createdAt;
          if (
            (currentRuntime !== runtime && !isMatchingTerminalDrain) ||
            (generationId != null && generationId !== runtime.createdAt)
          ) {
            return;
          }
          const e = event as t.ServerSentEvent;
          if (!(e as Record<string, unknown>)._internal) {
            queueChunk(e);
          }
        },
        onDone: (event, generationId) => {
          releaseSubscriberOnlyAbortSubscription(generationId);
          queueDone(event as t.ServerSentEvent, generationId);
        },
        onError: (error, generationId) => {
          releaseSubscriberOnlyAbortSubscription(generationId);
          queueError(error, generationId);
        },
      },
      {
        // Redis can publish an early buffered event before the EVAL response carrying its
        // sequence reaches this process. Hold sequenced pub/sub delivery until replay and
        // sync establish the exact frontier, otherwise the new subscriber sees it twice.
        deferSequenceDelivery,
      },
    );
    runtime.localErrorHandlers.add(queueError);
    if (!options?.skipBufferReplay) {
      runtime.earlyReplayHandlers.add(queueChunk);
    }
    let resolveDetached!: () => void;
    const detached = new Promise<void>((resolve) => {
      resolveDetached = resolve;
    });
    const detachSignal = options?.signal;
    const detachOnAbort = (): void => {
      subscription?.unsubscribe();
    };
    subscription = {
      ready: transportSubscription.ready,
      ...(prepared?.deferDeliveryUntilActivated === true && {
        activate: activateDelivery,
      }),
      unsubscribe: (): void => {
        if (!subscriptionActive) {
          return;
        }
        subscriptionActive = false;
        if (terminalPersistenceTimer) {
          clearTimeout(terminalPersistenceTimer);
          terminalPersistenceTimer = null;
        }
        deferredDeliveries = [];
        runtime.earlyReplayHandlers.delete(queueChunk);
        runtime.localErrorHandlers.delete(queueError);
        detachSignal?.removeEventListener('abort', detachOnAbort);
        const fencedLastSubscriber =
          runtime.localErrorHandlers.size === 0 &&
          (this.fencedRuntimeRetirements.has(runtime) ||
            this.runtimeState.get(streamId) !== runtime);
        const addFencedDetachmentSuppression =
          fencedLastSubscriber && !this.fencedSubscriberDetachments.has(streamId);
        if (fencedLastSubscriber) {
          runtime.syncSent = false;
          runtime.hasSubscriber = false;
          runtime.attachmentGeneration++;
          runtime.lastSubscriberCleanupGeneration = runtime.attachmentGeneration;
        }
        if (addFencedDetachmentSuppression) {
          this.fencedSubscriberDetachments.add(streamId);
        }
        try {
          this.cleanupUnobservedFencedRuntime(streamId, runtime);
          transportSubscription.unsubscribe();
        } finally {
          if (addFencedDetachmentSuppression) {
            this.fencedSubscriberDetachments.delete(streamId);
          }
        }
        resolveDetached();
      },
    };
    if (detachSignal?.aborted) {
      subscription.unsubscribe();
    } else {
      detachSignal?.addEventListener('abort', detachOnAbort, { once: true });
    }
    if (terminalEventDelivered) {
      subscription.unsubscribe();
    }

    const waitWhileAttached = async (pending: Promise<unknown>): Promise<boolean> => {
      await Promise.race([pending, detached]);
      return subscriptionActive;
    };

    const stillMatchesExpectedGeneration = async (): Promise<boolean> => {
      if (options?.expectedCreatedAt == null) {
        return true;
      }
      const currentJob = await this.jobStore.getJob(streamId);
      return (
        currentJob?.createdAt === options.expectedCreatedAt &&
        runtime.createdAt === options.expectedCreatedAt &&
        this.runtimeState.get(streamId) === runtime
      );
    };

    try {
      if (subscription.ready && !(await waitWhileAttached(subscription.ready))) {
        recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
        return null;
      }
      if (this.detachSubscriptionDuringShutdown(subscription)) {
        recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
        return null;
      }
      if (!(await stillMatchesExpectedGeneration())) {
        subscription.unsubscribe();
        recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
        return null;
      }
    } catch (err) {
      subscription.unsubscribe();
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      throw err;
    }

    const isFirst = this.eventTransport.isFirstSubscriber(streamId);

    if (!runtime.hasSubscriber) {
      runtime.hasSubscriber = true;
      const attachedAt = Date.now();
      if (!runtime.everHadSubscriber) {
        const bootstrapSlow = attachedAt - attachmentStartedAt >= SLOW_ATTACHMENT_BOOTSTRAP_MS;
        runtime.everHadSubscriber = true;
        runtime.onFirstSubscriberLeaseClaim = (firstSubscriber) => {
          if (!firstSubscriber) {
            return;
          }
          runtime.onFirstSubscriberLeaseClaim = undefined;
          recordGenerationStreamAttachment(
            this.storeLabel,
            'attached',
            Math.max(0, attachedAt - runtime.createdAt) / 1000,
          );
          if (bootstrapSlow) {
            recordGenerationStreamAttachment(this.storeLabel, 'bootstrap_slow');
          }
        };
      }
      this.startSubscriberLease(streamId, runtime);
      const subscriberClaim = (runtime.subscriberStateWrite ?? Promise.resolve())
        .then(async () => {
          const firstSubscriber = await this.jobStore.claimFirstSubscriber(
            streamId,
            runtime.createdAt,
            attachedAt,
            runtime.subscriberLeaseId,
            Date.now() + SUBSCRIBER_LEASE_TTL_MS,
          );
          runtime.subscriberStateAttached = true;
          return firstSubscriber;
        })
        .catch((claimError) => {
          logger.error(
            '[GenerationJobManager] Failed to persist subscriber attachment',
            claimError,
          );
          return false;
        });
      runtime.subscriberStateWrite = subscriberClaim;
      void subscriberClaim.then((firstSubscriber) =>
        runtime.onFirstSubscriberLeaseClaim?.(firstSubscriber),
      );
      const attachmentGeneration = runtime.attachmentGeneration;
      const earlyPublicationFence = this.waitForEarlyEventPublications(runtime);
      if (!(await waitWhileAttached(earlyPublicationFence))) {
        this.continueEarlyEventBootstrap(
          streamId,
          runtime,
          earlyPublicationFence,
          jobData,
          attachmentGeneration,
          deferSequenceDelivery,
        );
        return null;
      }
      if (this.detachSubscriptionDuringShutdown(subscription)) {
        return null;
      }
      if (!(await stillMatchesExpectedGeneration())) {
        subscription.unsubscribe();
        recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
        return null;
      }

      /**
       * Redis sequences are conversation-scoped and may start above zero. Use the
       * absolute sequences assigned to the exact events replayed below; a relative
       * buffer count can skip live events from a later turn.
       *
       * When no local replay occurs (including resume), undefined tells the transport
       * to trust the current Redis counter.
       */
      let replayedNextSeq: number | undefined;
      const bufferedEvents = runtime.earlyEventBuffer;
      const sequencePromises = runtime.earlyEventSequencePromises;
      const hasEarlyReplaySubscribers = runtime.earlyReplayHandlers.size > 0;

      try {
        if (bufferedEvents.length > 0) {
          if (!hasEarlyReplaySubscribers) {
            logger.debug(
              `[GenerationJobManager] Skipping ${bufferedEvents.length} buffered events for ${streamId} (skipBufferReplay)`,
            );
          } else {
            const sequences = await Promise.all(sequencePromises);
            const assignedSequences = sequences.filter(
              (sequence): sequence is number => typeof sequence === 'number',
            );
            if (assignedSequences.length > 0) {
              replayedNextSeq = Math.max(...assignedSequences) + 1;
            }
            logger.debug(
              `[GenerationJobManager] Replaying ${bufferedEvents.length} buffered events for ${streamId}`,
            );
            for (const bufferedEvent of bufferedEvents) {
              for (const replayHandler of runtime.earlyReplayHandlers) {
                replayHandler(bufferedEvent);
              }
            }
          }
        } else if (this._isRedis && hasEarlyReplaySubscribers && jobData?.userMessage) {
          /**
           * Cross-replica fallback: metadata can be visible before the generating
           * replica publishes `created`. Emit the fallback before releasing buffered
           * live events so `created` remains the first user-facing event. deliverChunk
           * suppresses the original publication whether it is already pending or
           * arrives after synchronization.
           */
          logger.debug(
            `[GenerationJobManager] Cross-replica subscribe: emitting created event from metadata for ${streamId}`,
          );
          const fallbackCreatedEvent: t.ServerSentEvent = {
            created: true,
            message: {
              ...jobData.userMessage,
              sender: 'User',
              isCreatedByUser: true,
            },
            streamId,
          };
          for (const replayHandler of runtime.earlyReplayHandlers) {
            replayHandler(fallbackCreatedEvent);
          }
        }
      } finally {
        this.resetEarlyEventBuffer(runtime);
        if (this._isRedis) {
          /** After the first attachment, the durable chunk log and pub/sub own
           * recovery; re-buffering on a later detach would grow for the rest
           * of a detached run. Cross-replica subscribers already attach with
           * no local buffer, so a closed buffer follows the same path. */
          runtime.earlyEventBufferClosed = true;
        }
        try {
          const reorderSync = this.eventTransport.syncReorderBuffer?.(streamId, replayedNextSeq);
          if (reorderSync) {
            await waitWhileAttached(reorderSync);
          }
        } catch (err) {
          logger.warn(
            `[GenerationJobManager] Failed to sync reorder buffer for ${streamId}; proceeding with current nextSeq:`,
            err,
          );
        }
      }

      if (!subscriptionActive) {
        return null;
      }
      if (this.detachSubscriptionDuringShutdown(subscription)) {
        return null;
      }
    }

    if (this.detachSubscriptionDuringShutdown(subscription)) {
      return null;
    }

    if (
      runtime.earlyEventBufferOverflowed === true &&
      !options?.skipBufferReplay &&
      !runtime.finalEvent &&
      !runtime.errorEvent
    ) {
      /** The overflow guard discarded the pre-attachment buffer, so a
       * non-resume attachment cannot be made whole from local replay. Close
       * the transport with the reconnect signal instead of streaming a
       * silently truncated response: the client re-attaches with resume=true
       * and its sync frame carries full durable/snapshot state. */
      queueError(TERMINAL_PUBLICATION_RECONNECT_ERROR);
    }

    recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'success');

    if (isFirst) {
      runtime.resolveReady();
      logger.debug(
        `[GenerationJobManager] First subscriber ready, resolving promise for ${streamId}`,
      );
    }

    if (prepared?.deferDeliveryUntilActivated !== true && options?.expectedCreatedAt != null) {
      activateDelivery();
    }

    const scheduleTerminalPersistenceCheck = (delayMs: number): void => {
      if (!subscriptionActive || terminalEventDelivered || terminalPersistenceTimer) {
        return;
      }
      terminalPersistenceTimer = setTimeout(() => {
        terminalPersistenceTimer = null;
        void deliverStoredTerminal();
      }, delayMs);
      terminalPersistenceTimer.unref?.();
    };

    const deliverStoredTerminal = async (): Promise<void> => {
      try {
        if (this.shuttingDown || !subscriptionActive || terminalEventDelivered) {
          return;
        }

        let terminalJob = await this.jobStore.getJob(streamId);
        if (terminalJob?.createdAt !== runtime.createdAt) {
          if (terminalJob) {
            await this.reconcileFencedRuntimeHandoff(streamId, runtime, terminalJob);
          } else {
            queueError(TERMINAL_PUBLICATION_RECONNECT_ERROR);
          }
          return;
        }
        if (
          terminalJob?.terminalPersistencePending === true &&
          ['complete', 'error', 'aborted'].includes(terminalJob.status)
        ) {
          terminalJob = await this.recoverStaleTerminalPersistence(terminalJob);
          if (terminalJob?.createdAt !== runtime.createdAt) {
            if (terminalJob) {
              await this.reconcileFencedRuntimeHandoff(streamId, runtime, terminalJob);
            } else {
              queueError(TERMINAL_PUBLICATION_RECONNECT_ERROR);
            }
            return;
          }
          if (terminalJob?.terminalPersistencePending === true) {
            const startedAt =
              terminalJob.terminalPersistenceStartedAt ??
              terminalJob.completedAt ??
              terminalJob.createdAt;
            const remaining = Math.max(
              1,
              TERMINAL_PERSISTENCE_TIMEOUT_MS - (Date.now() - startedAt),
            );
            // Poll modestly so a successfully persisted payload whose pub/sub
            // frame was lost is delivered promptly, while the hard deadline
            // still recovers a crashed owner.
            scheduleTerminalPersistenceCheck(Math.min(1000, remaining));
            return;
          }
        }
        if (
          this.shuttingDown ||
          !subscriptionActive ||
          terminalEventDelivered ||
          !terminalJob ||
          (terminalJob.status !== 'complete' &&
            terminalJob.status !== 'error' &&
            terminalJob.status !== 'aborted')
        ) {
          return;
        }

        // A durable error takes precedence for every terminal status. Approval expiry uses
        // `aborted` so a late subscriber still needs the stored terminal error.
        if (runtime.errorEvent || terminalJob.error) {
          const errorToSend = runtime.errorEvent ?? terminalJob.error;
          if (errorToSend) {
            logger.debug(
              `[GenerationJobManager] Sending stored error to late subscriber: ${streamId}`,
            );
            runtime.errorEvent = errorToSend;
            queueError(errorToSend);
          }
          return;
        }

        let finalEvent = runtime.finalEvent;
        if (!finalEvent && terminalJob.finalEvent) {
          try {
            /** Same mixed-deployment concern as the cross-replica runtime: a
             * stored record may predate projection. */
            finalEvent = projectTerminalEvent(
              JSON.parse(terminalJob.finalEvent) as t.ServerSentEvent,
            );
          } catch (err) {
            logger.warn(
              `[GenerationJobManager] Failed to parse stored final event for ${streamId}:`,
              err,
            );
          }
        }
        if (finalEvent) {
          runtime.finalEvent = finalEvent;
          queueDone(finalEvent);
          return;
        }

        /** The terminal CAS can commit just before its owner crashes, leaving
         * no normal FINAL payload. Never strand a late SSE subscriber on that
         * durable terminal row: send a control-only terminal event that tells
         * the client to refetch messages/status and reconcile parked steers.
         * This is deliberately not an error event, so no user-facing failure
         * card is fabricated for a generation whose DB writes may be complete. */
        const reconcileEvent: t.ServerSentEvent = {
          final: true,
          reconcile: true,
          reconcileReason: 'terminal_payload_missing',
          terminalStatus: terminalJob.status,
          generationCreatedAt: terminalJob.createdAt,
          conversation: {
            conversationId: terminalJob.conversationId ?? streamId,
          },
        } satisfies t.FinalEvent;
        logger.warn(
          `[GenerationJobManager] Terminal job has no final payload; requesting client reconciliation: ${streamId}`,
        );
        runtime.finalEvent = reconcileEvent;
        queueDone(reconcileEvent);
      } catch (err) {
        logger.warn(
          `[GenerationJobManager] Failed to refresh terminal state for ${streamId}:`,
          err,
        );
        scheduleTerminalPersistenceCheck(1000);
      }
    };

    // Only schedule stored terminal delivery after the attachment is fully prepared.
    // The async function resolves before setImmediate runs, giving the route its
    // unsubscribe handle before a terminal callback can end the response.
    setImmediate(() => {
      void deliverStoredTerminal();
    });

    return subscription;
  }

  /**
   * Wait until every buffered publication has an authoritative Redis sequence before replay.
   * Replaying while a publication is unresolved can deliver the local copy and then deliver the
   * same event again when its late pub/sub message arrives.
   */
  private async waitForEarlyEventPublications(runtime: RuntimeJobState): Promise<void> {
    const pending = [...runtime.earlyEventSequencePromises];
    if (pending.length === 0) {
      return;
    }

    await Promise.all(pending);
  }

  private resetEarlyEventBuffer(runtime: RuntimeJobState): void {
    runtime.earlyEventBuffer = [];
    runtime.earlyEventSequencePromises = [];
    runtime.earlyEventBufferBytes = 0;
  }

  /**
   * Buffers a pre-attachment event for local replay, enforcing hard bounds.
   *
   * A generation streaming with no attached subscriber can run for its entire
   * duration; unbounded buffering here retained every emitted event in memory,
   * with GC cost climbing alongside the heap. On overflow the whole buffer is
   * discarded and closed — the durable chunk log (Redis) or the resume
   * snapshot (in-memory) already owns recovery for late subscribers.
   *
   * @returns whether the event was accepted into the buffer.
   */
  private async bufferEarlyEvent(
    streamId: string,
    runtime: RuntimeJobState,
    event: t.ServerSentEvent,
  ): Promise<boolean> {
    if (runtime.earlyEventBufferClosed) {
      return false;
    }
    const estimatedBytes = JSON.stringify(event).length;
    if (
      runtime.earlyEventBuffer.length >= EARLY_EVENT_BUFFER_MAX_EVENTS ||
      runtime.earlyEventBufferBytes + estimatedBytes > EARLY_EVENT_BUFFER_MAX_BYTES
    ) {
      await this.overflowEarlyEventBuffer(streamId, runtime, 1, estimatedBytes);
      return false;
    }
    runtime.earlyEventBuffer.push(event);
    runtime.earlyEventBufferBytes += estimatedBytes;
    return true;
  }

  private async overflowEarlyEventBuffer(
    streamId: string,
    runtime: RuntimeJobState,
    rejectedEvents = 0,
    rejectedBytes = 0,
  ): Promise<void> {
    const droppedEvents = runtime.earlyEventBuffer.length + rejectedEvents;
    const droppedBytes = runtime.earlyEventBufferBytes + rejectedBytes;
    const overflow: EarlyBufferOverflowState = {
      id: randomUUID(),
      occurredAt: Date.now(),
      durableEvents: this._isRedis ? runtime.durableEventSequence : runtime.emissionSequence,
      droppedEvents,
      droppedBytes,
      persistencePending: true,
    };
    runtime.earlyEventBufferClosed = true;
    runtime.earlyEventBufferOverflowed = true;
    runtime.earlyBufferOverflow = overflow;
    recordGenerationStreamEarlyBufferOverflow(this.storeLabel);
    logger.warn(
      '[GenerationJobManager] Early event buffer overflow; late subscriber recovery required',
      {
        recoveryId: overflow.id,
        store: this.storeLabel,
        droppedEvents,
        droppedBytes,
      },
    );
    try {
      /** Publish an admission fence before releasing the local recovery copy.
       * Detached Redis events are durably appended before publication below,
       * so a replica that races before this write includes every earlier
       * publication in its snapshot. A replica that observes this marker waits
       * for the finalized frontier before it can activate. */
      await this.jobStore.updateJob(streamId, { earlyBufferOverflow: overflow }, runtime.createdAt);
      await this.jobStore.flushPendingAppends?.(streamId);
      const frontierJob = await this.jobStore.getJob(streamId);
      if (frontierJob?.createdAt !== runtime.createdAt) {
        throw new Error('Early buffer overflow generation was replaced before persistence');
      }
      const finalizedOverflow: EarlyBufferOverflowState = {
        ...overflow,
        durableEvents: this._isRedis
          ? (frontierJob.durableEventCount ?? runtime.durableEventSequence)
          : runtime.emissionSequence,
        persistencePending: false,
      };
      const finalized = await this.jobStore.finalizeEarlyBufferOverflow(
        streamId,
        runtime.createdAt,
        overflow.id,
        finalizedOverflow,
      );
      const persistedJob = await this.jobStore.getJob(streamId);
      if (
        !finalized ||
        persistedJob?.createdAt !== runtime.createdAt ||
        persistedJob.earlyBufferOverflow?.id !== overflow.id ||
        persistedJob.earlyBufferOverflow.persistencePending === true
      ) {
        if (
          persistedJob?.createdAt === runtime.createdAt &&
          persistedJob.earlyBufferOverflow?.id === overflow.id &&
          persistedJob.earlyBufferOverflow.recoveryOutcome != null
        ) {
          runtime.earlyBufferOverflow = persistedJob.earlyBufferOverflow;
          this.resetEarlyEventBuffer(runtime);
          throw new Error(GENERATION_RECOVERY_FAILED_ERROR);
        }
        throw new Error('Early buffer overflow marker was not durably persisted');
      }
      runtime.earlyBufferOverflow = finalizedOverflow;
      this.resetEarlyEventBuffer(runtime);
    } catch (err) {
      this.resetEarlyEventBuffer(runtime);
      if (
        err instanceof Error &&
        err.message === GENERATION_RECOVERY_FAILED_ERROR &&
        runtime.earlyBufferOverflow?.recoveryOutcome != null
      ) {
        throw err;
      }
      logger.error('[GenerationJobManager] Failed to persist early buffer overflow identity', {
        recoveryId: overflow.id,
        store: this.storeLabel,
        error: err instanceof Error ? err.message : String(err),
      });
      const settlement = {
        recoveryMethod: this._isRedis ? ('redis' as const) : ('snapshot' as const),
        recoveryOutcome: 'failed' as const,
        recoveryCompletedAt: Date.now(),
        recoveryFailureReason: 'overflow_marker_persistence_failed' as const,
      };
      runtime.earlyBufferOverflow = { ...overflow, ...settlement };
      recordGenerationStreamRecovery(
        this.storeLabel,
        settlement.recoveryMethod,
        settlement.recoveryOutcome,
        Math.max(0, settlement.recoveryCompletedAt - overflow.occurredAt) / 1000,
        0,
        0,
      );
      await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt).catch(
        (terminalError) => {
          logger.error(
            '[GenerationJobManager] Failed to terminalize after overflow marker persistence failure',
            terminalError,
          );
        },
      );
      throw new Error(GENERATION_RECOVERY_FAILED_ERROR, { cause: err });
    }
  }

  /**
   * If the subscriber that owns Redis attachment bootstrap disconnects, finish the
   * replay/sync for any concurrent subscriber. Otherwise the transport-wide reorder
   * fence remains closed forever because later subscribers observe hasSubscriber=true.
   */
  private continueEarlyEventBootstrap(
    streamId: string,
    runtime: RuntimeJobState,
    publicationFence: Promise<void>,
    jobData: SerializableJobData | null,
    attachmentGeneration: number,
    sequenceDeliveryDeferred: boolean,
  ): void {
    if (this.eventTransport.getSubscriberCount(streamId) === 0) {
      return;
    }

    void publicationFence
      .then(async () => {
        if (
          this.shuttingDown ||
          this.eventTransport.getSubscriberCount(streamId) === 0 ||
          this.runtimeState.get(streamId) !== runtime ||
          runtime.attachmentGeneration !== attachmentGeneration
        ) {
          return;
        }

        let replayedNextSeq: number | undefined;
        try {
          const hasEarlyReplaySubscribers = runtime.earlyReplayHandlers.size > 0;
          if (hasEarlyReplaySubscribers && runtime.earlyEventBuffer.length > 0) {
            const sequences = await Promise.all(runtime.earlyEventSequencePromises);
            const assignedSequences = sequences.filter(
              (sequence): sequence is number => typeof sequence === 'number',
            );
            if (sequenceDeliveryDeferred && assignedSequences.length > 0) {
              replayedNextSeq = Math.max(...assignedSequences) + 1;
            }
            for (const [index, bufferedEvent] of runtime.earlyEventBuffer.entries()) {
              /**
               * A canceled resume bootstrap does not defer Redis delivery. Any event with an
               * assigned sequence was therefore already published to the surviving subscriber;
               * replaying it locally would duplicate the event. Failed publications have no
               * sequence and still need the local replay. When delivery was deferred, replay
               * every buffered event and prune its pending pub/sub copy during synchronization.
               */
              if (!sequenceDeliveryDeferred && typeof sequences[index] === 'number') {
                continue;
              }
              for (const replayHandler of runtime.earlyReplayHandlers) {
                replayHandler(bufferedEvent);
              }
            }
          } else if (hasEarlyReplaySubscribers && jobData?.userMessage) {
            const fallbackCreatedEvent: t.ServerSentEvent = {
              created: true,
              message: {
                ...jobData.userMessage,
                sender: 'User',
                isCreatedByUser: true,
              },
              streamId,
            };
            for (const replayHandler of runtime.earlyReplayHandlers) {
              replayHandler(fallbackCreatedEvent);
            }
          }
        } finally {
          this.resetEarlyEventBuffer(runtime);
          if (this._isRedis) {
            /** Same closure as the owning-subscriber bootstrap above. */
            runtime.earlyEventBufferClosed = true;
          }
          await this.eventTransport.syncReorderBuffer?.(streamId, replayedNextSeq);
        }
      })
      .catch((err) => {
        logger.warn(
          `[GenerationJobManager] Failed to finish detached attachment bootstrap for ${streamId}:`,
          err,
        );
      });
  }

  private async waitForFinalizedEarlyBufferOverflow(
    streamId: string,
    jobData: SerializableJobData,
  ): Promise<SerializableJobData | null> {
    const overflow = jobData.earlyBufferOverflow;
    if (overflow?.persistencePending !== true) {
      return jobData;
    }

    const waiterKey = `${streamId}:${jobData.createdAt}:${overflow.id}`;
    const existing = this.earlyBufferOverflowWaiters.get(waiterKey);
    if (existing) {
      return existing;
    }

    const waiter = (async (): Promise<SerializableJobData | null> => {
      const deadline = Date.now() + EARLY_BUFFER_OVERFLOW_PERSISTENCE_TIMEOUT_MS;
      let delayMs = 100;
      let current: SerializableJobData | null = jobData;
      while (
        current?.createdAt === jobData.createdAt &&
        current.earlyBufferOverflow?.id === overflow.id &&
        current.earlyBufferOverflow.persistencePending === true &&
        Date.now() < deadline
      ) {
        const remainingMs = deadline - Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
        current = await this.jobStore.getJob(streamId);
        delayMs = Math.min(delayMs * 2, 1000);
      }
      return current;
    })();
    this.earlyBufferOverflowWaiters.set(waiterKey, waiter);
    try {
      return await waiter;
    } finally {
      if (this.earlyBufferOverflowWaiters.get(waiterKey) === waiter) {
        this.earlyBufferOverflowWaiters.delete(waiterKey);
      }
    }
  }

  private async settleEarlyBufferRecovery(
    streamId: string,
    runtime: RuntimeJobState,
    overflow: EarlyBufferOverflowState,
    outcome: EarlyBufferRecoveryOutcome,
    durationMs: number,
    reconstructedEvents: number,
    reconstructedContent: number,
    failureReason?: EarlyBufferRecoveryFailureReason,
  ): Promise<EarlyBufferRecoveryOutcome | undefined> {
    const recoveryMethod = this._isRedis ? 'redis' : 'snapshot';
    const settlement = {
      recoveryMethod,
      recoveryOutcome: outcome,
      recoveryCompletedAt: Date.now(),
      ...(failureReason != null && { recoveryFailureReason: failureReason }),
    } as const;
    const settled = await this.jobStore.settleEarlyBufferRecovery(
      streamId,
      runtime.createdAt,
      overflow.id,
      settlement,
    );
    if (!settled) {
      const winningJob = await this.jobStore.getJob(streamId);
      const winningOverflow = winningJob?.earlyBufferOverflow;
      if (
        winningJob?.createdAt === runtime.createdAt &&
        winningOverflow?.id === overflow.id &&
        winningOverflow.recoveryOutcome != null
      ) {
        runtime.earlyBufferOverflow = winningOverflow;
        return winningOverflow.recoveryOutcome;
      }
      return undefined;
    }
    runtime.earlyBufferOverflow = { ...overflow, ...settlement };
    recordGenerationStreamRecovery(
      this.storeLabel,
      recoveryMethod,
      outcome,
      Math.max(0, durationMs) / 1000,
      reconstructedEvents,
      reconstructedContent,
    );
    logger.info('[GenerationJobManager] Early buffer recovery completed', {
      recoveryId: overflow.id,
      store: this.storeLabel,
      method: recoveryMethod,
      outcome,
      durationMs,
      reconstructedEvents,
      reconstructedContent,
      ...(failureReason != null && { failureReason }),
    });
    return outcome;
  }

  /**
   * Snapshots resume state and attaches a paused live subscription.
   *
   * In-memory emissions during the snapshot-to-attachment interval are captured per resume,
   * so overlapping reconnects do not compete for the shared early-event buffer. Live delivery
   * remains paused until the caller writes its sync frame and activates the subscription.
   */
  async subscribeWithResume(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    options?: Pick<t.SubscribeOptions, 'signal' | 'expectedCreatedAt'>,
  ): Promise<t.SubscribeWithResumeResult> {
    if (options?.signal?.aborted) {
      recordGenerationStreamSubscription(this.storeLabel, 'resume', 'error');
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }

    if (this.rejectSubscriptionDuringShutdown('resume', onError)) {
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }

    const runtime = await this.getOrCreateRuntimeState(streamId);
    if (options?.signal?.aborted) {
      recordGenerationStreamSubscription(this.storeLabel, 'resume', 'error');
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }
    if (this.rejectSubscriptionDuringShutdown('resume', onError)) {
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }
    if (!runtime) {
      recordGenerationStreamSubscription(this.storeLabel, 'resume_state', 'missing');
      recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }
    if (options?.expectedCreatedAt != null && runtime.createdAt !== options.expectedCreatedAt) {
      recordGenerationStreamSubscription(this.storeLabel, 'resume_state', 'missing');
      recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }

    if (runtime.earlyBufferOverflow?.persistencePending === true) {
      const pendingMarker = runtime.earlyBufferOverflow;
      const currentJob = await this.jobStore.getJob(streamId);
      if (
        currentJob?.createdAt !== runtime.createdAt ||
        currentJob.earlyBufferOverflow?.id !== pendingMarker.id
      ) {
        recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
        return { subscription: null, resumeState: null, pendingEvents: [] };
      }
      const finalizedJob = await this.waitForFinalizedEarlyBufferOverflow(streamId, currentJob);
      if (finalizedJob?.createdAt !== runtime.createdAt) {
        recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
        return { subscription: null, resumeState: null, pendingEvents: [] };
      }
      await this.getOrCreateRuntimeState(streamId, finalizedJob);
      if (finalizedJob.earlyBufferOverflow?.persistencePending === true) {
        await this.settleEarlyBufferRecovery(
          streamId,
          runtime,
          pendingMarker,
          'failed',
          EARLY_BUFFER_OVERFLOW_PERSISTENCE_TIMEOUT_MS,
          0,
          0,
          'overflow_marker_persistence_failed',
        );
        await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt);
        onError?.(GENERATION_RECOVERY_FAILED_ERROR);
        return { subscription: null, resumeState: null, pendingEvents: [] };
      }
    }

    if (
      runtime.earlyBufferOverflow?.recoveryOutcome === 'failed' &&
      !runtime.finalEvent &&
      !runtime.errorEvent
    ) {
      await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt);
      onError?.(GENERATION_RECOVERY_FAILED_ERROR);
      return { subscription: null, resumeState: null, pendingEvents: [] };
    }

    const snapshotOverflowId = runtime.earlyBufferOverflow?.id;
    const pendingOverflow =
      runtime.earlyBufferOverflow?.recoveryOutcome == null &&
      !runtime.finalEvent &&
      !runtime.errorEvent
        ? runtime.earlyBufferOverflow
        : undefined;
    const recoveryStartedAt = pendingOverflow == null ? undefined : Date.now();
    let recoveryContentSnapshot: Awaited<ReturnType<IJobStore['getContentParts']>> | undefined;
    let recoverySettled = false;
    if (pendingOverflow != null) {
      logger.info('[GenerationJobManager] Early buffer recovery started', {
        recoveryId: pendingOverflow.id,
        store: this.storeLabel,
        method: this._isRedis ? 'redis' : 'snapshot',
      });
    }

    const capturedPendingEvents: t.ServerSentEvent[] = [];
    const pendingEvents: t.ServerSentEvent[] = [];
    const capturedEventSet = new Set<t.ServerSentEvent>();
    const snapshotCoveredEventSet = new Set<t.ServerSentEvent>();
    const seenEmissionEvents = new Set<t.ServerSentEvent>();
    const unclassifiedEmissions: Array<{
      event: t.ServerSentEvent;
      sequence: number;
    }> = [];
    let snapshotFrontier = 0;
    let snapshotClassified = this._isRedis;
    const classifyEmission = (event: t.ServerSentEvent, sequence: number): void => {
      if (sequence <= snapshotFrontier) {
        snapshotCoveredEventSet.add(event);
        return;
      }
      capturedEventSet.add(event);
      capturedPendingEvents.push(event);
      pendingEvents.push(event);
    };
    const capturePendingEvent = (event: t.ServerSentEvent, sequence: number): void => {
      if (seenEmissionEvents.has(event)) {
        return;
      }
      seenEmissionEvents.add(event);
      if (!snapshotClassified) {
        unclassifiedEmissions.push({ event, sequence });
        return;
      }
      classifyEmission(event, sequence);
    };
    let resumeState: t.ResumeState | null = null;
    let jobData: SerializableJobData | null = null;
    const removeCaptureHandler = (): void => {
      runtime.resumeCaptureHandlers.delete(capturePendingEvent);
    };
    const discardCapturedEvents = (): void => {
      removeCaptureHandler();
      capturedPendingEvents.length = 0;
      pendingEvents.length = 0;
      unclassifiedEmissions.length = 0;
      capturedEventSet.clear();
      snapshotCoveredEventSet.clear();
    };
    const restoreCapturedEvents = (): void => {
      if (capturedPendingEvents.length === 0) {
        return;
      }
      const currentRuntime = this.runtimeState.get(streamId);
      if (
        currentRuntime &&
        !currentRuntime.hasSubscriber &&
        !currentRuntime.earlyEventBufferClosed
      ) {
        const bufferedEvents = new Set(currentRuntime.earlyEventBuffer);
        const missingEvents = capturedPendingEvents.filter((event) => !bufferedEvents.has(event));
        if (missingEvents.length > 0) {
          let restoredBytes = 0;
          for (const event of missingEvents) {
            restoredBytes += JSON.stringify(event).length;
          }
          const overflows =
            currentRuntime.earlyEventBuffer.length + missingEvents.length >
              EARLY_EVENT_BUFFER_MAX_EVENTS ||
            currentRuntime.earlyEventBufferBytes + restoredBytes > EARLY_EVENT_BUFFER_MAX_BYTES;
          if (overflows) {
            void this.overflowEarlyEventBuffer(
              streamId,
              currentRuntime,
              missingEvents.length,
              restoredBytes,
            ).catch((err) => {
              logger.error('[GenerationJobManager] Failed to persist early buffer overflow', err);
            });
          } else {
            currentRuntime.earlyEventBuffer = [
              ...missingEvents,
              ...currentRuntime.earlyEventBuffer,
            ];
            currentRuntime.earlyEventBufferBytes += restoredBytes;
          }
        }
      }
      capturedPendingEvents.length = 0;
      capturedEventSet.clear();
    };
    let subscription: (t.StreamSubscription & { activate?: () => void }) | null = null;
    try {
      if (!this._isRedis) {
        runtime.resumeCaptureHandlers.add(capturePendingEvent);
        while (true) {
          const candidateFrontier = runtime.emissionSequence;
          const preSnapshotEmissions = [...runtime.inFlightSnapshotEmissions.entries()].filter(
            ([sequence]) => sequence <= candidateFrontier,
          );
          await Promise.all(preSnapshotEmissions.map(([, emission]) => emission.snapshotReady));
          const [candidateState, candidateJob] = await Promise.all([
            this.getResumeState(streamId, options?.expectedCreatedAt, {
              durableOnly: false,
              onContentSnapshot: (snapshot) => {
                recoveryContentSnapshot = snapshot;
              },
            }),
            this.jobStore.getJob(streamId),
          ]);
          if (
            runtime.emissionSequence !== candidateFrontier &&
            !options?.signal?.aborted &&
            !this.shuttingDown
          ) {
            continue;
          }

          snapshotFrontier = candidateFrontier;
          resumeState = candidateState ? structuredClone(candidateState) : null;
          jobData = candidateJob;
          for (const [, emission] of preSnapshotEmissions) {
            seenEmissionEvents.add(emission.event);
            snapshotCoveredEventSet.add(emission.event);
          }
          for (const emission of unclassifiedEmissions) {
            classifyEmission(emission.event, emission.sequence);
          }
          unclassifiedEmissions.length = 0;
          snapshotClassified = true;
          break;
        }
      } else {
        [resumeState, jobData] = await Promise.all([
          this.getResumeState(streamId, options?.expectedCreatedAt, {
            durableOnly: pendingOverflow != null,
            onContentSnapshot: (snapshot) => {
              recoveryContentSnapshot = snapshot;
            },
          }),
          this.jobStore.getJob(streamId),
        ]);
      }

      if (pendingOverflow != null && recoveryStartedAt != null) {
        const contentSnapshot = recoveryContentSnapshot;
        const reconstructedEvents = this._isRedis
          ? (contentSnapshot?.reconstructedEventCount ?? 0)
          : snapshotFrontier;
        const durableEvents = this._isRedis
          ? (contentSnapshot?.durableEventCount ?? 0)
          : snapshotFrontier;
        const reconstructedContent = resumeState?.aggregatedContent?.length ?? 0;
        let failureReason: EarlyBufferRecoveryFailureReason | undefined;
        if (resumeState == null || contentSnapshot == null) {
          failureReason = this._isRedis ? 'durable_state_missing' : 'snapshot_missing';
        } else if (
          durableEvents < pendingOverflow.durableEvents ||
          reconstructedEvents !== durableEvents
        ) {
          failureReason = 'durable_frontier_gap';
        }
        const durationMs = Date.now() - recoveryStartedAt;
        if (failureReason == null) {
          const winningOutcome = await this.settleEarlyBufferRecovery(
            streamId,
            runtime,
            pendingOverflow,
            'success',
            durationMs,
            reconstructedEvents,
            reconstructedContent,
          );
          recoverySettled = winningOutcome != null;
          if (winningOutcome == null) {
            const currentJob = await this.jobStore.getJob(streamId);
            if (currentJob?.createdAt !== runtime.createdAt) {
              removeCaptureHandler();
              if (currentJob != null) {
                await this.reconcileFencedRuntimeHandoff(streamId, runtime, currentJob);
              }
              recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
              return { subscription: null, resumeState: null, pendingEvents: [] };
            }
          }
          if (winningOutcome === 'not_required') {
            discardCapturedEvents();
            return { subscription: null, resumeState, pendingEvents: [] };
          }
          if (winningOutcome !== 'success') {
            discardCapturedEvents();
            await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt);
            onError?.(GENERATION_RECOVERY_FAILED_ERROR);
            return { subscription: null, resumeState: null, pendingEvents: [] };
          }
        } else {
          const winningOutcome = await this.settleEarlyBufferRecovery(
            streamId,
            runtime,
            pendingOverflow,
            'failed',
            durationMs,
            reconstructedEvents,
            reconstructedContent,
            failureReason,
          );
          recoverySettled = winningOutcome != null;
          if (winningOutcome == null) {
            const currentJob = await this.jobStore.getJob(streamId);
            if (currentJob?.createdAt !== runtime.createdAt) {
              removeCaptureHandler();
              if (currentJob != null) {
                await this.reconcileFencedRuntimeHandoff(streamId, runtime, currentJob);
              }
              recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
              return { subscription: null, resumeState: null, pendingEvents: [] };
            }
          }
          if (winningOutcome === 'not_required') {
            discardCapturedEvents();
            return { subscription: null, resumeState, pendingEvents: [] };
          }
          if (winningOutcome !== 'success') {
            discardCapturedEvents();
            await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt);
            onError?.(GENERATION_RECOVERY_FAILED_ERROR);
            return { subscription: null, resumeState: null, pendingEvents: [] };
          }
          /** Another replica proved the generation recoverable, but this
           * attachment's snapshot is still incomplete. Keep the generation
           * healthy and fail this request closed so its normal retry can read
           * the durable winner's now-established frontier. */
          throw new Error('Concurrent recovery succeeded; retry this attachment');
        }
      }

      if (options?.signal?.aborted) {
        removeCaptureHandler();
        recordGenerationStreamSubscription(this.storeLabel, 'resume', 'error');
        return { subscription: null, resumeState, pendingEvents: [] };
      }
      if (this.rejectSubscriptionDuringShutdown('resume', onError)) {
        removeCaptureHandler();
        return { subscription: null, resumeState, pendingEvents: [] };
      }
      if (
        options?.expectedCreatedAt != null &&
        (jobData?.createdAt !== options.expectedCreatedAt ||
          runtime.createdAt !== options.expectedCreatedAt ||
          this.runtimeState.get(streamId) !== runtime)
      ) {
        removeCaptureHandler();
        recordGenerationStreamSubscription(this.storeLabel, 'resume_state', 'missing');
        recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
        return { subscription: null, resumeState: null, pendingEvents: [] };
      }
      recordGenerationStreamSubscription(
        this.storeLabel,
        'resume_state',
        resumeState ? 'found' : 'missing',
      );

      const forwardLiveChunk = (event: t.ServerSentEvent): void => {
        if (capturedEventSet.has(event) || snapshotCoveredEventSet.has(event)) {
          return;
        }
        onChunk(event);
      };
      subscription = await this.attachSubscription(
        streamId,
        forwardLiveChunk,
        onDone,
        onError,
        {
          skipBufferReplay: true,
          signal: options?.signal,
          expectedCreatedAt: options?.expectedCreatedAt,
        },
        {
          runtime,
          jobData,
          deferDeliveryUntilActivated: true,
        },
      );
      if (pendingEvents.length > 0) {
        recordGenerationStreamResumePendingEvents(this.storeLabel, pendingEvents.length);
        logger.debug(
          `[GenerationJobManager] Captured ${pendingEvents.length} gap events for ${streamId}`,
        );
      }
      const cancelResumeSubscription = (): t.SubscribeWithResumeResult => {
        removeCaptureHandler();
        subscription?.unsubscribe();
        restoreCapturedEvents();
        snapshotCoveredEventSet.clear();
        return { subscription: null, resumeState, pendingEvents: [] };
      };
      if (!subscription?.activate || options?.signal?.aborted) {
        return cancelResumeSubscription();
      }
      if (this.detachSubscriptionDuringShutdown(subscription)) {
        return cancelResumeSubscription();
      }

      // Close the snapshot→subscribe race: getResumeState() snapshots BEFORE we attach the
      // subscription, so a pause that becomes durable in that window is in neither
      // resumeState.pendingAction nor (Redis mode) pendingEvents — and trackReplayEvent does
      // not persist approval events — leaving the client attached to a paused job with no
      // approval UI. Re-read the live job AFTER subscribing; if it is now requires_action and
      // the snapshot didn't already carry the action, surface it as a pending event so the
      // approval prompt renders. Idempotent: a pause landing AFTER attach is delivered live
      // too, and the client's handler just sets the current action, so a duplicate is benign.
      const liveJob = await this.jobStore.getJob(streamId);
      if (options?.signal?.aborted || this.detachSubscriptionDuringShutdown(subscription)) {
        return cancelResumeSubscription();
      }
      if (!liveJob || liveJob.createdAt !== runtime.createdAt) {
        return cancelResumeSubscription();
      }
      const liveOverflow = liveJob.earlyBufferOverflow;
      if (liveOverflow != null) {
        runtime.earlyBufferOverflow = liveOverflow;
        runtime.earlyEventBufferOverflowed = true;
        runtime.earlyEventBufferClosed = true;
        this.resetEarlyEventBuffer(runtime);
        if (
          !runtime.finalEvent &&
          !runtime.errorEvent &&
          (liveOverflow.recoveryOutcome === 'failed' || snapshotOverflowId !== liveOverflow.id)
        ) {
          /** The owner can discard its local buffer before the durable marker
           * write becomes visible here. This final pre-activation read closes
           * that window: retire the paused attachment and rebuild its snapshot
           * through the durable-only recovery path now reflected in `runtime`. */
          cancelResumeSubscription();
          return this.subscribeWithResume(streamId, onChunk, onDone, onError, options);
        }
      }
      if (!resumeState?.pendingAction) {
        if (
          liveJob?.status === 'requires_action' &&
          liveJob.pendingAction != null &&
          !isPendingActionStale(liveJob)
        ) {
          pendingEvents.push({
            event: ApprovalEvents.ON_PENDING_ACTION,
            data: toClientPendingAction(liveJob.pendingAction) as unknown as Record<
              string,
              unknown
            >,
          });
        }
      }

      // Same snapshot→subscribe race for steers: a steer accepted (and possibly
      // applied) in the window is invisible to the snapshot, since the Redis
      // `on_steer_applied` publish is fire-and-forget and the sync payload has no
      // pendingSteers (in-memory covers it via the early buffer, where this
      // re-check is a cheap no-op). Always re-peek for still-active jobs,
      // treating a missing snapshot queue as empty; terminal jobs skip because
      // the final event owns steer delivery. The content re-read runs only when
      // the queue shows gap activity, and synthesis sources from the FRESH
      // content view so an applied steer with no snapshot id still surfaces.
      const jobActive = liveJob?.status === 'running' || liveJob?.status === 'requires_action';
      /** Shared by the steer and activity-label gap passes below: whichever
       *  needs the fresh content view first pays for it, the other reuses it.
       *  Both reconcile the same snapshot→subscribe window, so re-reading per
       *  feature would bill two round trips for one question. */
      let freshContent: t.ServerSentEvent[] | undefined;
      let freshContentRead = false;
      const readFreshContent = async (): Promise<unknown[] | undefined> => {
        if (!freshContentRead) {
          freshContentRead = true;
          const contentResult = await this.jobStore.getContentParts(streamId, liveJob?.createdAt);
          freshContent = contentResult?.content as t.ServerSentEvent[] | undefined;
        }
        return freshContent as unknown[] | undefined;
      };
      if (resumeState != null && jobActive) {
        const snapshotSteers = resumeState.pendingSteers ?? [];
        const [liveQueue, liveClaims] = await Promise.all([
          this.jobStore.peekSteers(streamId, liveJob.createdAt),
          this.jobStore.peekClaimedSteers(streamId, liveJob.createdAt),
        ]);
        if (options?.signal?.aborted || this.detachSubscriptionDuringShutdown(subscription)) {
          return cancelResumeSubscription();
        }
        const liveUnresolved = mergeUnresolvedSteers(liveClaims, liveQueue);
        const livePending = liveUnresolved.map(toPendingSteer);
        /** Identity alone misses in-place mutations such as an interrupt flag
         * downgrade in this exact gap. Compare the client-safe projections so
         * revision/correlation/files/preempt changes replace stale snapshot
         * truth even when FIFO membership is unchanged. */
        let queueChanged = JSON.stringify(livePending) !== JSON.stringify(snapshotSteers);
        if (queueChanged) {
          resumeState.pendingSteers = livePending.length > 0 ? livePending : undefined;
        }
        // Always compare a fresh content frontier after attaching. A steer can
        // be accepted+applied wholly between the initial XRANGE and queue
        // reads, leaving both snapshots empty while its pub/sub event also
        // predates the subscription.
        const content = await readFreshContent();
        if (options?.signal?.aborted || this.detachSubscriptionDuringShutdown(subscription)) {
          return cancelResumeSubscription();
        }
        const freshUnresolved = omitAlreadyAppliedSteers(
          liveUnresolved,
          (content ?? []) as unknown[],
        );
        const freshPending = freshUnresolved.map(toPendingSteer);
        if (JSON.stringify(freshPending) !== JSON.stringify(resumeState.pendingSteers ?? [])) {
          queueChanged = true;
          resumeState.pendingSteers = freshPending.length > 0 ? freshPending : undefined;
        }
        const gapEvents = synthesizeAppliedSteerEvents(
          (resumeState.aggregatedContent ?? []) as SteerContentView,
          liveQueue,
          (content ?? []) as SteerContentView,
          {
            conversationId: streamId,
            responseMessageId: resumeState.responseMessageId,
          },
        );
        if (gapEvents.length > 0) {
          pendingEvents.push(...gapEvents);
        }
      }

      /**
       * Same snapshot→subscribe race for activity labels: the label publish is
       * fire-and-forget, so a slot claimed (or filled) in the window is in
       * neither the snapshot nor the chunk replay the client already applied.
       * Compare the snapshot content view against a fresh read and re-emit any
       * label whose text/pending state moved; the client applier is idempotent
       * and refuses stale pending placeholders.
       *
       * Gated on the run's own flag, falling back to the snapshot when the
       * flag is absent. Reconciling unconditionally would be simpler and would
       * also close the residual window below, but it bills a content read to
       * every resume of every run — including deployments with the feature
       * off — which the steer pass deliberately avoids ("an unchanged empty
       * queue skips the content re-read").
       *
       * The residual: if `markActivityLabels` lost its write AND the first
       * label is claimed inside the gap, this is skipped. The flag is a
       * SEPARATE write from the durable label append, so that is genuinely
       * possible rather than implying a broken store — which is why the mark
       * is retried at run setup instead of being fire-and-forget. When the
       * steer pass above already fetched content, this check is free.
       */
      const snapshotHasActivityLabels =
        resumeState?.aggregatedContent?.some(
          (part) => (part as { type?: string } | null)?.type === 'activity_label',
        ) === true;
      const snapshotHasReasoningLabels =
        resumeState?.aggregatedContent?.some(
          (part) =>
            (
              part as {
                type?: string;
                reasoning_label_revision?: unknown;
              } | null
            )?.type === 'think' &&
            typeof (part as { reasoning_label_revision?: unknown }).reasoning_label_revision ===
              'number',
        ) === true;
      if (
        resumeState != null &&
        jobActive &&
        (liveJob?.activityLabels === true ||
          snapshotHasActivityLabels ||
          snapshotHasReasoningLabels)
      ) {
        const labelContent = await readFreshContent();
        if (options?.signal?.aborted || this.detachSubscriptionDuringShutdown(subscription)) {
          return cancelResumeSubscription();
        }
        if (labelContent != null) {
          const labelGapEvents = synthesizeActivityLabelGapEvents(
            (resumeState.aggregatedContent ?? []) as Parameters<
              typeof synthesizeActivityLabelGapEvents
            >[0],
            labelContent as Parameters<typeof synthesizeActivityLabelGapEvents>[1],
            {
              conversationId: streamId,
              responseMessageId: resumeState.responseMessageId,
            },
          );
          if (labelGapEvents.length > 0) {
            pendingEvents.push(...(labelGapEvents as t.ServerSentEvent[]));
          }
          const reasoningGapEvents = synthesizeReasoningLabelGapEvents(
            (resumeState.aggregatedContent ?? []) as Parameters<
              typeof synthesizeReasoningLabelGapEvents
            >[0],
            labelContent as Parameters<typeof synthesizeReasoningLabelGapEvents>[1],
            {
              conversationId: streamId,
              responseMessageId: resumeState.responseMessageId,
            },
          );
          if (reasoningGapEvents.length > 0) {
            pendingEvents.push(...(reasoningGapEvents as t.ServerSentEvent[]));
          }
        }
      }

      // Reconciliation is complete. Events that arrive after this point already belong to the
      // paused transport subscription and must remain there for activation rather than being
      // appended to a pending-events array the caller may already be serializing.
      removeCaptureHandler();
      const activate = subscription.activate;
      let activated = false;
      let closed = false;
      const resumeSubscription: t.ResumeSubscription = {
        unsubscribe: () => {
          if (closed) {
            return;
          }
          closed = true;
          removeCaptureHandler();
          subscription?.unsubscribe();
          if (!activated) {
            restoreCapturedEvents();
          }
          capturedEventSet.clear();
          snapshotCoveredEventSet.clear();
        },
        activate: () => {
          if (closed || activated) {
            return;
          }
          activated = true;
          removeCaptureHandler();
          activate();
          capturedPendingEvents.length = 0;
          capturedEventSet.clear();
          snapshotCoveredEventSet.clear();
        },
      };
      return { subscription: resumeSubscription, resumeState, pendingEvents };
    } catch (err) {
      removeCaptureHandler();
      subscription?.unsubscribe();
      restoreCapturedEvents();
      snapshotCoveredEventSet.clear();
      if (pendingOverflow != null && recoveryStartedAt != null && !recoverySettled) {
        const winningOutcome = await this.settleEarlyBufferRecovery(
          streamId,
          runtime,
          pendingOverflow,
          'failed',
          Date.now() - recoveryStartedAt,
          0,
          0,
          'reconstruction_error',
        ).catch((settlementError) => {
          logger.error(
            '[GenerationJobManager] Failed to settle early buffer recovery error',
            settlementError,
          );
          return undefined;
        });
        if (winningOutcome == null) {
          const currentJob = await this.jobStore.getJob(streamId);
          if (currentJob?.createdAt !== runtime.createdAt) {
            if (currentJob != null) {
              await this.reconcileFencedRuntimeHandoff(streamId, runtime, currentJob);
            }
            recordGenerationStreamSubscription(this.storeLabel, 'resume', 'not_found');
            return { subscription: null, resumeState: null, pendingEvents: [] };
          }
        }
        if (winningOutcome === 'not_required') {
          return { subscription: null, resumeState: null, pendingEvents: [] };
        }
        if (winningOutcome !== 'success') {
          await this.completeJob(
            streamId,
            GENERATION_RECOVERY_FAILED_ERROR,
            runtime.createdAt,
          ).catch((terminalError) => {
            logger.error(
              '[GenerationJobManager] Failed to terminalize early buffer recovery error',
              terminalError,
            );
          });
          onError?.(GENERATION_RECOVERY_FAILED_ERROR);
          return { subscription: null, resumeState: null, pendingEvents: [] };
        }
      }
      throw err;
    }
  }

  /**
   * Emit a chunk event to all subscribers.
   * Uses runtime state check for performance (avoids async job store lookup per token).
   *
   * If no subscriber has connected yet, buffers the event for replay when they do.
   * This ensures early events (like 'created') aren't lost due to race conditions.
   *
   * In Redis mode, awaits the publish to guarantee event ordering.
   * This is critical for streaming deltas (tool args, message content) to arrive in order.
   *
   * `options.durable` additionally awaits the Redis chunk append BEFORE the
   * transport publish (still best-effort on failure): events whose durable
   * record is the recovery source (e.g. `on_steer_applied`) must be in the
   * chunk log before any subscriber can observe the publish, or a
   * cross-replica reconnect can reconstruct content without them. The default
   * stays fire-and-forget — no added latency on the per-delta hot path.
   */
  /**
   * Flags a run as producing activity labels. Read back on resume so label
   * gap-reconciliation can be skipped for runs without the feature WITHOUT
   * inspecting content — the first label can be claimed inside the
   * snapshot->subscribe window, so content is not a reliable signal.
   * Best-effort: the flag is an optimization hint, never correctness.
   */
  async markActivityLabels(streamId: string, expectedCreatedAt?: number): Promise<void> {
    /** Deliberately REJECTS on failure. This flag gates resume gap
     *  reconciliation, so the caller retries it; swallowing the error here
     *  resolved successfully and made that retry unreachable, leaving the
     *  flag absent after a transient write failure. */
    await this.jobStore.updateJob(streamId, { activityLabels: true }, expectedCreatedAt);
  }

  /** Publish a durable non-streaming control event from any API replica.
   * `emitChunk` intentionally requires a local runtime, but steer/arm routes
   * may execute on a non-owner during horizontal deployment. When the owner
   * is local we retain the normal ordering/buffering path; otherwise the
   * generation-fenced chunk append commits before direct transport publish. */
  async emitChunkFromAnyReplica(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<boolean> {
    const runtime = this.runtimeState.get(streamId);
    if (
      runtime != null &&
      runtime.createdAt === expectedCreatedAt &&
      this.isCurrentRuntime(streamId, runtime)
    ) {
      await this.emitChunk(streamId, event, {
        durable: true,
        expectedCreatedAt,
      });
      return true;
    }
    if (!('event' in event) || event.data === undefined) {
      return false;
    }
    const appended = await this.jobStore.appendChunk(
      streamId,
      { event: event.event, data: event.data },
      expectedCreatedAt,
    );
    if (appended === false) {
      return false;
    }
    const published = await emitChunkWithReceipt(
      this.eventTransport,
      streamId,
      event,
      expectedCreatedAt,
    );
    return published !== false;
  }

  async emitChunk(
    streamId: string,
    event: t.ServerSentEvent,
    options?: {
      durable?: boolean;
      expectedCreatedAt?: number;
      /** Atomically settles a claimed steer with its durable applied event. */
      deliveredSteer?: SteerQueueItem;
    },
  ): Promise<void> {
    const runtime = this.runtimeState.get(streamId);
    if (
      !runtime ||
      (options?.expectedCreatedAt != null && runtime.createdAt !== options.expectedCreatedAt) ||
      !this.isCurrentRuntime(streamId, runtime)
    ) {
      if (options?.durable === true) {
        throw new Error(`Durable chunk owner was fenced out for ${streamId}`);
      }
      return;
    }
    const sequence = ++runtime.emissionSequence;
    let signalSnapshotReady!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      signalSnapshotReady = resolve;
    });
    let snapshotReadySignaled = false;
    const markSnapshotReady = (): void => {
      if (snapshotReadySignaled) {
        return;
      }
      snapshotReadySignaled = true;
      signalSnapshotReady();
    };
    runtime.inFlightSnapshotEmissions.set(sequence, { event, snapshotReady });

    try {
      const isCreatedEvent = 'created' in event;
      const pendingCreatedEvent = runtime.createdEventPublication;
      if (!isCreatedEvent) {
        if (pendingCreatedEvent) {
          await pendingCreatedEvent;
          if (!this.isCurrentRuntime(streamId, runtime)) {
            if (options?.durable === true) {
              throw new Error(`Durable chunk owner was fenced out for ${streamId}`);
            }
            return;
          }
        }
        await this.emitChunkNow(streamId, event, runtime, sequence, markSnapshotReady, options);
        return;
      }

      if (pendingCreatedEvent) {
        await pendingCreatedEvent;
        if (!this.isCurrentRuntime(streamId, runtime)) {
          if (options?.durable === true) {
            throw new Error(`Durable chunk owner was fenced out for ${streamId}`);
          }
          return;
        }
      }

      let releaseCreatedEvent!: () => void;
      const createdEventPublication = new Promise<void>((resolve) => {
        releaseCreatedEvent = resolve;
      });
      runtime.createdEventPublication = createdEventPublication;

      try {
        await this.emitChunkNow(streamId, event, runtime, sequence, markSnapshotReady, options);
      } finally {
        releaseCreatedEvent();
        if (runtime.createdEventPublication === createdEventPublication) {
          runtime.createdEventPublication = undefined;
        }
      }
    } finally {
      markSnapshotReady();
      if (runtime.inFlightSnapshotEmissions.get(sequence)?.event === event) {
        runtime.inFlightSnapshotEmissions.delete(sequence);
      }
    }
  }

  private async emitChunkNow(
    streamId: string,
    event: t.ServerSentEvent,
    runtime: RuntimeJobState,
    sequence: number,
    markSnapshotReady: () => void,
    options?: { durable?: boolean; deliveredSteer?: SteerQueueItem },
  ): Promise<void> {
    if (!this.isCurrentRuntime(streamId, runtime)) {
      if (options?.durable === true) {
        throw new Error(`Durable chunk owner was fenced out for ${streamId}`);
      }
      return;
    }

    // Refresh job activity so the store's stale-job failsafe reaps on inactivity
    // (a hung generation), not on age (a long but live stream). Parity with
    // RedisJobStore refreshing the running TTL on each appendChunk.
    this.jobStore.recordActivity?.(streamId, runtime.createdAt);

    const eventTracking = this.trackEvent(streamId, event, runtime.createdAt);
    if (eventTracking) {
      await eventTracking;
      if (!this.isCurrentRuntime(streamId, runtime)) {
        if (options?.durable === true) {
          throw new Error(`Durable chunk owner was fenced out for ${streamId}`);
        }
        return;
      }
    }
    markSnapshotReady();

    // Retain run-step identity independently of the live graph. Paused in-memory
    // runs release that graph before a later request rebuilds the run, but the
    // resume path still needs the original step ids to correlate tool results.
    const eventObj = event as Record<string, unknown>;
    const eventType = eventObj.event as string | undefined;
    const eventData = eventObj.data;
    if (
      (eventType === 'on_run_step' ||
        eventType === 'on_run_step_completed' ||
        eventType === 'on_run_step_closed') &&
      eventData != null &&
      typeof eventData === 'object'
    ) {
      this.saveRunStepFromEvent(
        streamId,
        eventType,
        eventData as Record<string, unknown>,
        runtime.createdAt,
      );
    }

    /**
     * One decision drives both durable-log and publish batching: the append and
     * the sequence allocation for an event must stay tightly coupled in time, or
     * the resume frontier (chunk-log snapshot → sequence-counter sync) misreads
     * a window's tail as already-delivered or as duplicates. Before first-subscriber
     * admission, each append is awaited for snapshot safety; batching that path
     * would add a full window of producer latency to every delta.
     */
    const coalescableDelta =
      this._deltaCoalescingEnabled &&
      (runtime.hasSubscriber || runtime.everHadSubscriber) &&
      !runtime.startupTelemetry &&
      options?.durable !== true &&
      options?.deliveredSteer == null &&
      isCoalescableDeltaEvent(eventType);

    const detachedAtAppend = !runtime.hasSubscriber;
    const admissionFenceRequired = detachedAtAppend && !runtime.everHadSubscriber;
    const subscriberAdmission = admissionFenceRequired
      ? this.jobStore.hasSubscriberAttached(streamId, runtime.createdAt).catch((error) => {
          logger.warn(
            '[GenerationJobManager] Failed to read generation-wide subscriber admission',
            error,
          );
          return false;
        })
      : undefined;

    // For Redis mode, persist chunk for later reconstruction (fire-and-forget for resumability)
    if (this._isRedis) {
      // The SSE event structure is { event: string, data: unknown, ... }
      // The aggregator expects { event: string, data: unknown } where data is the payload
      if (eventType && eventData !== undefined) {
        runtime.durableEventSequence += 1;
        // Store in format expected by aggregateContent: { event, data }
        const appendPromise = this.jobStore.appendChunk(
          streamId,
          { event: eventType, data: eventData },
          runtime.createdAt,
          options?.deliveredSteer,
          coalescableDelta ? { coalesce: true } : undefined,
        );

        /** Before the generation-wide first-subscriber admission, publication
         * is the cross-replica boundary: its durable record must already exist
         * before another replica can snapshot. The admission probe runs beside
         * the append, so the first event after a remote attachment remains
         * fenced and later events recover the normal fire-and-forget path. */
        if (options?.durable === true || admissionFenceRequired) {
          let appended: boolean;
          try {
            appended = await appendPromise;
          } catch (error) {
            if (options?.deliveredSteer == null) {
              this.retireRuntimeAfterDurableFence(streamId, runtime);
            }
            throw error;
          }
          if (appended === false) {
            if (options?.deliveredSteer == null) {
              this.retireRuntimeAfterDurableFence(streamId, runtime);
            }
            throw new Error(`Durable chunk append was fenced out for ${streamId}`);
          }
          if (!this.isCurrentRuntime(streamId, runtime)) {
            return;
          }
        } else {
          void appendPromise
            .then((appended) => {
              if (appended === false && options?.deliveredSteer == null) {
                this.retireRuntimeAfterDurableFence(streamId, runtime);
              }
            })
            .catch((err) => {
              logger.error(`[GenerationJobManager] Failed to append chunk:`, err);
              if (options?.deliveredSteer == null) {
                this.retireRuntimeAfterDurableFence(streamId, runtime);
              }
            });
        }
      }
    } else if (options?.deliveredSteer != null) {
      const settled = await this.jobStore.appendChunk(
        streamId,
        event,
        runtime.createdAt,
        options.deliveredSteer,
      );
      if (settled === false) {
        throw new Error(`Steer receipt settlement was fenced out for ${streamId}`);
      }
    }

    if (!this.isCurrentRuntime(streamId, runtime)) {
      return;
    }

    if (!this._isRedis && runtime.resumeCaptureHandlers.size > 0) {
      for (const captureHandler of runtime.resumeCaptureHandlers) {
        captureHandler(event, sequence);
      }
    }

    if ((await subscriberAdmission) === true) {
      runtime.everHadSubscriber = true;
    }

    const detached = !runtime.hasSubscriber;
    const buffered = detached && (await this.bufferEarlyEvent(streamId, runtime, event));
    if (detached && !this._isRedis) {
      if (runtime.startupTelemetry) {
        this.recordStartupEvent(runtime, event);
      }
      return;
    }

    /**
     * Streaming deltas dominate publication volume, and their receipt is consumed
     * only for the generation fence (`false` retires the runtime) — never awaited
     * for content correctness. Marking them coalescable lets the Redis transport
     * batch a window of them into one sequenced frame, and NOT awaiting here takes
     * the per-delta publish round trip off the provider-stream consumption path.
     * The fence continuation mirrors the fire-and-forget appendChunk fence above.
     * Fenced emissions (durable, steer receipts, created) and telemetry-observed
     * runs stay on the awaited per-event path below.
     */
    if (coalescableDelta) {
      const publication = emitChunkWithReceipt(
        this.eventTransport,
        streamId,
        event,
        runtime.createdAt,
        { coalesce: true },
      );
      if (buffered) {
        runtime.earlyEventSequencePromises.push(
          publication.then(
            (published) => (typeof published === 'number' ? published : undefined),
            () => undefined,
          ),
        );
      }
      runtime.outstandingCoalescedReceipts = (runtime.outstandingCoalescedReceipts ?? 0) + 1;
      void publication.then(
        (published) => {
          runtime.outstandingCoalescedReceipts = (runtime.outstandingCoalescedReceipts ?? 1) - 1;
          if (published === false) {
            this.retireRuntimeAfterDurableFence(streamId, runtime);
          }
        },
        (err) => {
          runtime.outstandingCoalescedReceipts = (runtime.outstandingCoalescedReceipts ?? 1) - 1;
          logger.error(`[GenerationJobManager] Failed to publish coalesced chunk:`, err);
        },
      );
      /**
       * Backpressure only under distress. Healthy settlement is one window plus
       * a round trip (~30ms), so outstanding receipts sit in the single digits
       * even at hundreds of deltas per second and this await never runs. If
       * Redis stalls, the un-awaited path would otherwise accumulate batches,
       * resolver closures, and queued commands without bound — awaiting one
       * receipt paces the producer to Redis exactly like the flag-off path,
       * with memory capped near the threshold instead of one delta.
       */
      if (runtime.outstandingCoalescedReceipts >= MAX_OUTSTANDING_COALESCED_RECEIPTS) {
        await publication.catch(() => undefined);
      }
      return;
    }

    if (!buffered && !runtime.startupTelemetry) {
      try {
        const published = await emitChunkWithReceipt(
          this.eventTransport,
          streamId,
          event,
          runtime.createdAt,
        );
        if (published === false) {
          this.retireRuntimeAfterDurableFence(streamId, runtime);
          if (options?.durable === true && options.deliveredSteer == null) {
            throw new Error(`Durable chunk publication was fenced out for ${streamId}`);
          }
        }
      } catch (error) {
        if (options?.deliveredSteer == null) {
          throw error;
        }
        /** The applied part and receipt were committed together above. A
         * subscriber/transport failure after that point is a delivery problem,
         * not a storage failure: reconnect replay owns recovery, while
         * rejecting here would make AgentClient roll back host content that
         * the receipt already calls delivered. */
        logger.error(
          `[GenerationJobManager] Failed to publish committed steer ${options.deliveredSteer.steerId}:`,
          error,
        );
      }
      return;
    }

    const publication = emitChunkWithReceipt(
      this.eventTransport,
      streamId,
      event,
      runtime.createdAt,
    );
    if (buffered) {
      // Store a non-rejecting sequence receipt before yielding. The absolute value
      // establishes the exact replay frontier; a failed/unsequenced publication
      // contributes no frontier but can still be replayed from the local buffer.
      runtime.earlyEventSequencePromises.push(
        publication.then(
          (published) => (typeof published === 'number' ? published : undefined),
          () => undefined,
        ),
      );
    }

    const published = await publication.catch((error) => {
      if (options?.deliveredSteer == null) {
        throw error;
      }
      /** Same post-commit rule as the direct publication path above. The
       * buffered event and durable chunk remain replayable. */
      logger.error(
        `[GenerationJobManager] Failed to publish committed steer ${options.deliveredSteer.steerId}:`,
        error,
      );
      return undefined;
    });
    if (published === false) {
      this.retireRuntimeAfterDurableFence(streamId, runtime);
      if (options?.durable === true && options.deliveredSteer == null) {
        throw new Error(`Durable chunk publication was fenced out for ${streamId}`);
      }
      return;
    }
    // The false branch returned above, so any remaining receipt is either a
    // sequence number or an unsequenced success.
    if (runtime.startupTelemetry) {
      this.recordStartupEvent(runtime, event);
    }
  }

  private async getReplacementHandoffState(
    streamId: string,
    predecessorCreatedAt: number,
  ): Promise<'none' | 'pending' | 'settled'> {
    try {
      const current = (await this.jobStore.getJob(streamId)) as CreatedJobData | null;
      if (current == null) {
        /** A fenced append proves that a newer durable owner existed. Its job
         * may disappear after publishing predecessor DONE but before this poll,
         * so absence is a settled handoff that still needs delivery grace. */
        return 'settled';
      }
      if (current.createdAt <= predecessorCreatedAt) {
        return 'none';
      }
      const receipts =
        current.replacedJobs ?? (current.replacedJob != null ? [current.replacedJob] : []);
      return receipts.some((receipt) => receipt.createdAt === predecessorCreatedAt)
        ? 'pending'
        : 'settled';
    } catch (error) {
      logger.warn(
        `[GenerationJobManager] Failed to inspect replacement handoff for fenced generation ${streamId}:`,
        error,
      );
      // A transient read failure cannot prove that DONE publication finished.
      return 'pending';
    }
  }

  private async getReplacementHandoffStateBeforeDeadline(
    streamId: string,
    predecessorCreatedAt: number,
    deadlineAt: number,
    lifecycleSignal: AbortSignal,
  ): Promise<'none' | 'pending' | 'settled' | 'deadline' | 'cancelled'> {
    if (lifecycleSignal.aborted) {
      return 'cancelled';
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return 'deadline';
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let removeCancellationListener: (() => void) | undefined;
    try {
      const cancellation = new Promise<'cancelled'>((resolve) => {
        const onCancelled = (): void => resolve('cancelled');
        removeCancellationListener = (): void =>
          lifecycleSignal.removeEventListener('abort', onCancelled);
        lifecycleSignal.addEventListener('abort', onCancelled, { once: true });
        if (lifecycleSignal.aborted) {
          onCancelled();
        }
      });
      const deadline = new Promise<'deadline'>((resolve) => {
        deadlineTimer = setTimeout(() => resolve('deadline'), remainingMs);
        deadlineTimer.unref?.();
      });
      return await Promise.race([
        this.getReplacementHandoffState(streamId, predecessorCreatedAt),
        deadline,
        cancellation,
      ]);
    } finally {
      if (deadlineTimer != null) {
        clearTimeout(deadlineTimer);
      }
      removeCancellationListener?.();
    }
  }

  private cancelFencedRuntimeRetirements(): void {
    for (const retirement of this.fencedRuntimeRetirements.values()) {
      if (retirement.timer != null) {
        clearTimeout(retirement.timer);
        retirement.timer = undefined;
      }
      retirement.controller.abort();
    }
    this.fencedRuntimeRetirements.clear();
  }

  private scheduleFencedRuntimeRetirement(
    streamId: string,
    runtime: RuntimeJobState,
    startedAt: number,
    retirement: FencedRuntimeRetirementContext,
    handoffPendingObserved = false,
    postHandoffGraceApplied = false,
    requestedDelayMs = REDIS_ABORT_TERMINAL_GRACE_MS,
  ): void {
    const lifecycleSignal = retirement.controller.signal;
    if (lifecycleSignal.aborted || this.fencedRuntimeRetirements.get(runtime) !== retirement) {
      return;
    }
    const remainingMs = REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS - (Date.now() - startedAt);
    /** Handoff inspection is capped at 30 seconds. Once inspection ends, the
     * final delivery grace is intentionally un-clamped and may extend the
     * generation-scoped hold by one reorder window. */
    const delayMs = postHandoffGraceApplied
      ? Math.max(1, requestedDelayMs)
      : Math.max(1, Math.min(requestedDelayMs, remainingMs));
    const retirementTimer = setTimeout(() => {
      if (retirement.timer === retirementTimer) {
        retirement.timer = undefined;
      }
      if (lifecycleSignal.aborted) {
        return;
      }
      void this.finishFencedRuntimeRetirement(
        streamId,
        runtime,
        startedAt,
        retirement,
        handoffPendingObserved,
        postHandoffGraceApplied,
        lifecycleSignal,
      );
    }, delayMs);
    retirement.timer = retirementTimer;
    retirementTimer.unref?.();
  }

  private async finishFencedRuntimeRetirement(
    streamId: string,
    runtime: RuntimeJobState,
    startedAt: number,
    retirement: FencedRuntimeRetirementContext,
    handoffPendingObserved: boolean,
    postHandoffGraceApplied: boolean,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    if (
      this.shuttingDown ||
      lifecycleSignal.aborted ||
      this.fencedRuntimeRetirements.get(runtime) !== retirement
    ) {
      return;
    }
    if (
      runtime.localErrorHandlers.size === 0 &&
      this.cleanupUnobservedFencedRuntime(streamId, runtime)
    ) {
      return;
    }
    if (!postHandoffGraceApplied) {
      const deadlineAt = startedAt + REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS;
      const handoffState = await this.getReplacementHandoffStateBeforeDeadline(
        streamId,
        runtime.createdAt,
        deadlineAt,
        lifecycleSignal,
      );
      if (this.shuttingDown || lifecycleSignal.aborted || handoffState === 'cancelled') {
        return;
      }
      if (handoffState === 'pending' && Date.now() < deadlineAt) {
        this.scheduleFencedRuntimeRetirement(streamId, runtime, startedAt, retirement, true);
        return;
      }
      if (
        handoffPendingObserved ||
        handoffState === 'pending' ||
        handoffState === 'settled' ||
        handoffState === 'deadline'
      ) {
        this.scheduleFencedRuntimeRetirement(
          streamId,
          runtime,
          startedAt,
          retirement,
          handoffPendingObserved || handoffState === 'pending',
          true,
          REDIS_EVENT_REORDER_TIMEOUT_MS * 2,
        );
        return;
      }
    }

    if (this.fencedRuntimeRetirements.get(runtime) !== retirement) {
      return;
    }
    retirement.cleanupStarted = true;
    this.cleanupFencedRuntime(streamId, runtime);
    if (this.fencedRuntimeRetirements.get(runtime) === retirement) {
      this.fencedRuntimeRetirements.delete(runtime);
    }
  }

  private cleanupUnobservedFencedRuntime(streamId: string, runtime: RuntimeJobState): boolean {
    if (runtime.localErrorHandlers.size !== 0) {
      return false;
    }
    const retirement = this.fencedRuntimeRetirements.get(runtime);
    if (retirement == null || retirement.cleanupStarted === true) {
      return false;
    }
    retirement.cleanupStarted = true;
    if (retirement.timer != null) {
      clearTimeout(retirement.timer);
      retirement.timer = undefined;
    }
    retirement.controller.abort();
    this.fencedRuntimeRetirements.delete(runtime);
    this.cleanupFencedRuntime(streamId, runtime);
    return true;
  }

  private async persistFencedRuntimeAbortProof(
    streamId: string,
    runtime: RuntimeJobState,
    ownsExactProvider: boolean,
  ): Promise<boolean> {
    const recordAbortAcknowledgement = this.eventTransport.recordAbortAcknowledgement;
    if (!this._isRedis || !ownsExactProvider) {
      return true;
    }
    if (recordAbortAcknowledgement == null) {
      return false;
    }

    try {
      const confirmed = await recordAbortAcknowledgement.call(
        this.eventTransport,
        streamId,
        runtime.createdAt,
      );
      if (!confirmed) {
        logger.warn(
          `[GenerationJobManager] Abort proof was not persisted for fenced generation ${streamId}`,
        );
      }
      return confirmed;
    } catch (error) {
      logger.error(
        `[GenerationJobManager] Failed to persist abort proof for fenced generation ${streamId}:`,
        error,
      );
      return false;
    }
  }

  private recordFencedRuntimeAbortProof(
    streamId: string,
    runtime: RuntimeJobState,
    ownsExactProvider: boolean,
  ): void {
    void this.persistFencedRuntimeAbortProof(streamId, runtime, ownsExactProvider);
  }

  private cleanupFencedRuntime(streamId: string, runtime: RuntimeJobState): void {
    if (runtime.replacementTransportHold !== true) {
      this.releaseAbortSubscription(runtime);
      this.releaseJobOwnership(streamId, runtime.createdAt);
      this.jobStore.clearContentState(streamId, runtime.createdAt);

      if (this.runtimeState.get(streamId) === runtime) {
        this.stopSubscriberLease(runtime);
        this.runtimeState.delete(streamId);
        this.runStepBuffers?.delete(streamId);
        this.replayEventWriteQueues.delete(streamId);
        this.tokenUsageWriteQueues.delete(streamId);
        this.runStepWriteQueues.delete(streamId);
      }
    }

    // finalEvent/errorEvent are cached before transport dispatch, so they do
    // not prove that an attached SSE response closed. Each captured handler
    // ignores this reconnect signal when its terminal is already queued.
    for (const notify of [...runtime.localErrorHandlers]) {
      try {
        notify(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      } catch (error) {
        logger.error(
          `[GenerationJobManager] Failed to recycle a subscriber for fenced generation ${streamId}:`,
          error,
        );
      }
    }
  }

  /** A generation-fenced append returning false is same-slot proof that this
   * epoch is no longer the durable owner. Stop its provider immediately, then
   * preserve captured subscribers while a durable successor still owns their
   * handoff receipt. A newer runtime is never touched. */
  private retireRuntimeAfterDurableFence(streamId: string, runtime: RuntimeJobState): void {
    if (this.runtimeState.get(streamId) !== runtime) {
      return;
    }
    if (this.fencedRuntimeRetirements.has(runtime)) {
      return;
    }
    /** A runtime whose stop signal already landed (cross-replica abort,
     * replacement handshake) observes this fence as a consequence of its own
     * termination — most often a coalesced window draining after the abort
     * CAS. Those flows own terminal delivery and cleanup; the forced teardown
     * below would error-close local subscribers in a race with the FINAL
     * frame they are about to receive. It remains the backstop for the
     * lost-signal case, which is exactly a fence on a NOT-yet-aborted owner. */
    if (runtime.abortController.signal.aborted) {
      return;
    }
    runtime.startupTelemetry?.end('replaced');
    runtime.startupTelemetry = undefined;
    const ownsExactProvider = this.ownedJobs.get(streamId) === runtime.createdAt;
    runtime.abortController.abort();
    this.recordFencedRuntimeAbortProof(streamId, runtime, ownsExactProvider);
    this.preserveFencedRuntimeUntilHandoff(streamId, runtime);
  }

  private preserveFencedRuntimeUntilHandoff(streamId: string, runtime: RuntimeJobState): void {
    const currentRuntime = this.runtimeState.get(streamId);
    if (
      this.shuttingDown ||
      (currentRuntime !== runtime &&
        (currentRuntime == null || currentRuntime.createdAt <= runtime.createdAt)) ||
      this.fencedRuntimeRetirements.has(runtime)
    ) {
      return;
    }
    if (runtime.replacementTransportHold === true) {
      runtime.replacementRetirementPending = true;
      return;
    }
    if (runtime.localErrorHandlers.size === 0) {
      this.cleanupFencedRuntime(streamId, runtime);
      return;
    }
    const retirement: FencedRuntimeRetirementContext = {
      controller: new AbortController(),
    };
    this.fencedRuntimeRetirements.set(runtime, retirement);
    this.scheduleFencedRuntimeRetirement(streamId, runtime, Date.now(), retirement);
  }

  private releaseReplacementTransportHold(streamId: string, runtime: RuntimeJobState): void {
    const retirementPending = runtime.replacementRetirementPending === true;
    runtime.replacementRetirementPending = false;
    this.releaseAbortSubscription(runtime, true);
    if (retirementPending) {
      this.preserveFencedRuntimeUntilHandoff(streamId, runtime);
    }
  }

  private isCurrentRuntime(streamId: string, runtime: RuntimeJobState): boolean {
    return this.runtimeState.get(streamId) === runtime && !runtime.abortController.signal.aborted;
  }

  private recordStartupEvent(runtime: RuntimeJobState, event: t.ServerSentEvent): void {
    const telemetry = runtime.startupTelemetry;
    if (!telemetry) {
      return;
    }
    if ('created' in event) {
      telemetry.mark('request_message_queued');
      return;
    }
    if (!telemetry.recordGenerationEvent(event)) {
      return;
    }
    runtime.startupTelemetry = undefined;
  }

  private trackEvent(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> | undefined {
    if ('created' in event) {
      return this.trackUserMessage(streamId, event, expectedCreatedAt);
    }
    if (!('event' in event)) {
      return;
    }
    if (event.event === 'title') {
      return this.trackTitleEvent(streamId, event, expectedCreatedAt);
    }
    if (event.event === UsageEvents.ON_CONTEXT_USAGE) {
      return this.trackContextUsage(streamId, event, expectedCreatedAt);
    }
    if (event.event === UsageEvents.ON_TOKEN_USAGE) {
      return this.trackTokenUsage(streamId, event, expectedCreatedAt);
    }
    if (
      (event.event === 'on_run_step' ||
        event.event === 'on_run_step_delta' ||
        event.event === 'on_run_step_completed') &&
      isOAuthReplayEvent(event)
    ) {
      return this.trackReplayEvent(streamId, event, expectedCreatedAt);
    }
  }

  /**
   * Extract and save a run step from its wire envelope. Completed events wrap
   * the authoritative step under `result`; live and closed events carry their
   * payload directly. The terminal close is the authoritative execution status:
   * a tool-end payload may contain an error output even though the step closes
   * as failed.
   */
  private saveRunStepFromEvent(
    streamId: string,
    eventType: 'on_run_step' | 'on_run_step_completed' | 'on_run_step_closed',
    data: Record<string, unknown>,
    expectedCreatedAt: number,
  ): void {
    const candidate = eventType === 'on_run_step_completed' ? data.result : data;
    if (
      candidate == null ||
      typeof candidate !== 'object' ||
      !('id' in candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0
    ) {
      return;
    }

    if (eventType === 'on_run_step') {
      this.accumulateRunStep(streamId, candidate as Agents.RunStep, expectedCreatedAt);
      return;
    }

    if (eventType === 'on_run_step_closed') {
      const closed = candidate as Agents.RunStepClosedEvent;
      if (
        closed.status !== 'completed' &&
        closed.status !== 'cancelled' &&
        closed.status !== 'failed'
      ) {
        return;
      }
      const bufferState = this.runStepBuffers?.get(streamId);
      const existingStep =
        bufferState?.createdAt === expectedCreatedAt
          ? bufferState.steps.find((step) => step.id === closed.id)
          : undefined;
      if (existingStep == null) {
        return;
      }
      const terminalCalls =
        existingStep.stepDetails.type === StepTypes.TOOL_CALLS
          ? ((existingStep.stepDetails.tool_calls ?? []) as ToolCallWithExecutionStatus[])
          : [];
      const unresolvedCalls = terminalCalls.filter((call) => call.executionStatus == null);
      const calls: Agents.AgentToolCall[] =
        closed.status !== 'completed' && unresolvedCalls.length === 1
          ? terminalCalls.map((call) =>
              call === unresolvedCalls[0]
                ? {
                    ...call,
                    executionStatus: closed.status === 'failed' ? 'error' : 'cancelled',
                  }
                : call,
            )
          : terminalCalls;
      this.accumulateRunStep(
        streamId,
        {
          ...existingStep,
          status: closed.status,
          ...(existingStep.stepDetails.type === StepTypes.TOOL_CALLS && {
            stepDetails: { ...existingStep.stepDetails, tool_calls: calls },
          }),
        },
        expectedCreatedAt,
      );
      return;
    }

    if ('stepDetails' in candidate) {
      this.accumulateRunStep(
        streamId,
        { ...(candidate as Agents.RunStep), status: 'completed' },
        expectedCreatedAt,
      );
      return;
    }

    const completion = candidate as Agents.ToolEndEvent;
    const completedToolCall = completion.tool_call;
    if (completedToolCall == null) {
      return;
    }
    const bufferState = this.runStepBuffers?.get(streamId);
    const existingStep =
      bufferState?.createdAt === expectedCreatedAt
        ? bufferState.steps.find((step) => step.id === completion.id)
        : undefined;
    const existingCalls =
      existingStep?.stepDetails?.type === StepTypes.TOOL_CALLS
        ? (existingStep.stepDetails.tool_calls ?? [])
        : [];
    const completedCallId = completedToolCall.id;
    const executionStatus = completedToolExecutionStatus(completedToolCall);
    const existingCallIndex =
      completedCallId == null ? -1 : existingCalls.findIndex((call) => call.id === completedCallId);
    const completedCalls = [...existingCalls];
    if (existingCallIndex >= 0) {
      const existingCall = completedCalls[existingCallIndex];
      completedCalls[existingCallIndex] =
        'function' in existingCall
          ? ({
              id: existingCall.id,
              type: 'function',
              executionStatus,
              function: {
                ...existingCall.function,
                output: completedToolCall.output,
              },
              ...('inputValidationError' in completedToolCall &&
                completedToolCall.inputValidationError === true && {
                  inputValidationError: true,
                }),
            } as ToolCallWithExecutionStatus)
          : { ...existingCall, ...completedToolCall, executionStatus };
    } else {
      completedCalls.push({
        ...completedToolCall,
        executionStatus,
      } as ToolCallWithExecutionStatus);
    }

    this.accumulateRunStep(
      streamId,
      {
        ...(existingStep ?? {
          id: completion.id,
          index: completion.index,
          type: StepTypes.TOOL_CALLS,
        }),
        status: 'completed',
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: completedCalls,
        },
      },
      expectedCreatedAt,
    );
  }

  /**
   * Accumulate run steps for a stream.
   * Redis stores flush this buffer for cross-replica recovery; in-memory stores
   * retain it as a fallback after a paused run's live graph has been released.
   */
  private runStepBuffers: Map<string, { createdAt: number; steps: Agents.RunStep[] }> | null = null;

  private accumulateRunStep(
    streamId: string,
    runStep: Agents.RunStep,
    expectedCreatedAt: number,
  ): void {
    // Lazy initialization keeps the per-stream allocation off non-agent paths.
    if (!this.runStepBuffers) {
      this.runStepBuffers = new Map();
    }

    let bufferState = this.runStepBuffers.get(streamId);
    if (!bufferState || bufferState.createdAt !== expectedCreatedAt) {
      bufferState = { createdAt: expectedCreatedAt, steps: [] };
      this.runStepBuffers.set(streamId, bufferState);
    }
    const buffer = bufferState.steps;

    // Update or add run step
    const existingIdx = buffer.findIndex((rs) => rs.id === runStep.id);
    if (existingIdx >= 0) {
      buffer[existingIdx] = runStep;
    } else {
      buffer.push(runStep);
    }

    // Save to Redis
    if (this.jobStore.saveRunSteps) {
      const snapshot = [...buffer];
      void this.queueJobWrite(this.runStepWriteQueues, streamId, () =>
        this.jobStore.saveRunSteps!(streamId, snapshot, expectedCreatedAt),
      ).catch((err) => {
        logger.error(`[GenerationJobManager] Failed to save run steps:`, err);
      });
    }
  }

  /**
   * Persist the last title event so resume sync can replay it. Content
   * aggregation only reconstructs message parts, so UI-only events need their
   * own metadata slot.
   */
  private async trackTitleEvent(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    if (!('event' in event) || event.event !== 'title') {
      return;
    }

    await this.jobStore.updateJob(
      streamId,
      {
        titleEvent: JSON.stringify(event),
      },
      expectedCreatedAt,
    );
  }

  /**
   * Persist the latest context usage snapshot (one per model call) so a
   * resuming client can restore the context gauge without waiting for the
   * next model call.
   */
  private async trackContextUsage(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    if (!('event' in event) || event.event !== UsageEvents.ON_CONTEXT_USAGE) {
      return;
    }

    /** Share the token-usage queue so snapshot + usage writes are serialized per
     *  stream: `persistTokenUsage` reconciles the stored snapshot (read-modify-
     *  write), and a snapshot landing between its read and write — or a stale
     *  reconciled write landing after a newer snapshot — would clobber the newer
     *  run's gauge when visible calls interleave. FIFO ordering keeps each call's
     *  pre-invoke snapshot ahead of its own usage and behind the next snapshot. */
    await this.queueJobWrite(this.tokenUsageWriteQueues, streamId, () =>
      this.jobStore.updateJob(
        streamId,
        {
          contextUsage: JSON.stringify((event as { data?: unknown }).data ?? null),
        },
        expectedCreatedAt,
      ),
    );
  }

  /**
   * Chains a read/modify/write job update onto the stream's queue so
   * concurrent writers can't clobber each other's merged state.
   */
  private async queueJobWrite(
    queues: Map<string, Promise<void>>,
    streamId: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const previousWrite = queues.get(streamId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => {
        // Keep the queue moving even if a prior metadata write failed.
      })
      .then(write);

    queues.set(streamId, nextWrite);

    try {
      await nextWrite;
    } finally {
      if (queues.get(streamId) === nextWrite) {
        queues.delete(streamId);
      }
    }
  }

  /**
   * Persist replay-only stream events that are needed to reconstruct active
   * UI state on resume but are not represented by aggregated message content.
   */
  private async trackReplayEvent(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    if (!isOAuthReplayEvent(event)) {
      return;
    }

    await this.queueJobWrite(this.replayEventWriteQueues, streamId, () =>
      this.persistReplayEvent(streamId, event, expectedCreatedAt),
    );
  }

  /**
   * Persist per-model-call token usage so resuming clients can rebuild
   * usage totals on any replica (the live collectedUsage array only exists
   * on the generating instance).
   */
  private async trackTokenUsage(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    if (!('event' in event) || event.event !== UsageEvents.ON_TOKEN_USAGE) {
      return;
    }

    await this.queueJobWrite(this.tokenUsageWriteQueues, streamId, () =>
      this.persistTokenUsage(streamId, event as { data?: unknown }, expectedCreatedAt),
    );
  }

  private async persistTokenUsage(
    streamId: string,
    event: { data?: unknown },
    expectedCreatedAt: number,
  ): Promise<void> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData || jobData.createdAt !== expectedCreatedAt || event.data == null) {
      return;
    }

    let tokenUsage: unknown[] = [];
    if (jobData.tokenUsage) {
      try {
        tokenUsage = JSON.parse(jobData.tokenUsage) as unknown[];
      } catch {
        tokenUsage = [];
      }
    }
    tokenUsage.push(event.data);

    const update: Partial<SerializableJobData> = {
      tokenUsage: JSON.stringify(tokenUsage),
    };

    /** Reconcile the resume snapshot to this call's ACTUAL prompt tokens. A primary
     *  usage is the post-invoke truth for the call the latest stored snapshot
     *  precedes (no snapshot is captured between a call's pre-invoke dispatch and
     *  its usage), so a resuming client restores the real context instead of the
     *  calibration-inflated estimate — and a mid-call resume (no usage yet) simply
     *  keeps the raw snapshot rather than mis-applying an earlier call's tokens. */
    const usage = event.data as TTokenUsageEvent;
    if (usage.usage_type == null && jobData.contextUsage) {
      try {
        const snapshot = JSON.parse(jobData.contextUsage) as TContextUsageEvent | null;
        if (
          snapshot != null &&
          (snapshot.runId == null || usage.runId == null || snapshot.runId === usage.runId)
        ) {
          const { completedOutputTokens, ...reconciled } = reconcileContextUsageFromEvent(
            snapshot,
            usage,
          );
          update.contextUsage = JSON.stringify({
            ...reconciled,
            resumedOutputTokens: completedOutputTokens,
          });
        }
      } catch {
        /* leave the stored snapshot as-is on parse failure */
      }
    }

    await this.jobStore.updateJob(streamId, update, expectedCreatedAt);
  }

  private async persistReplayEvent(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData || jobData.createdAt !== expectedCreatedAt) {
      return;
    }

    let replayEvents: t.ServerSentEvent[] = [];
    if (jobData.replayEvents) {
      try {
        replayEvents = JSON.parse(jobData.replayEvents) as t.ServerSentEvent[];
      } catch {
        replayEvents = [];
      }
    }

    const stepId = getReplayStepId(event);
    const eventName = 'event' in event ? event.event : undefined;
    const existingIndex =
      stepId == null
        ? -1
        : replayEvents.findIndex((candidate) => {
            if (!('event' in candidate) || candidate.event !== eventName) {
              return false;
            }
            return getReplayStepId(candidate) === stepId;
          });

    if (existingIndex >= 0) {
      replayEvents[existingIndex] = event;
    } else {
      replayEvents.push(event);
    }

    await this.jobStore.updateJob(
      streamId,
      {
        replayEvents: JSON.stringify(replayEvents),
      },
      expectedCreatedAt,
    );
  }

  /**
   * Persist user message metadata from the created event.
   * Awaited in emitChunk so the HSET commits before the PUBLISH,
   * guaranteeing any cross-replica getJob() after the pub/sub window
   * finds userMessage in Redis.
   */
  private async trackUserMessage(
    streamId: string,
    event: t.ServerSentEvent,
    expectedCreatedAt: number,
  ): Promise<void> {
    if (!('created' in event)) {
      return;
    }

    const { message } = event;
    const extra = message as {
      manualSkills?: string[];
      alwaysAppliedSkills?: string[];
      files?: unknown[];
    };
    const updates: Partial<SerializableJobData> = {
      createdEventEmitted: true,
      userMessage: {
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
        conversationId: message.conversationId,
        text: message.text,
        quotes: message.quotes,
        // Persist the turn's uploaded files so a HITL resume sources them from the job
        // (this authoritative writer), not a user DB row whose save can still be racing
        // the approval prompt.
        ...(Array.isArray(extra.files) && extra.files.length > 0 && { files: extra.files }),
        // Carry skill selections so a HITL resume's reconstructed requestMessage keeps
        // its pills — this is the authoritative writer of job.metadata.userMessage and
        // would otherwise drop them (the emitted created message includes them).
        ...(Array.isArray(extra.manualSkills) &&
          extra.manualSkills.length > 0 && {
            manualSkills: extra.manualSkills,
          }),
        ...(Array.isArray(extra.alwaysAppliedSkills) &&
          extra.alwaysAppliedSkills.length > 0 && {
            alwaysAppliedSkills: extra.alwaysAppliedSkills,
          }),
      },
    };

    if (message.conversationId) {
      updates.conversationId = message.conversationId;
    }

    await this.jobStore.updateJob(streamId, updates, expectedCreatedAt);
  }

  /**
   * Update job metadata.
   */
  async updateMetadata(
    streamId: string,
    metadata: Partial<t.GenerationJobMetadata>,
    expectedCreatedAt?: number,
  ): Promise<void> {
    const generationId = expectedCreatedAt ?? this.runtimeState.get(streamId)?.createdAt;
    const updates: Partial<SerializableJobData> = {
      ...sanitizeJobMetadata(metadata),
      ...(metadata.userSubmittedPaths && {
        userSubmittedPaths: metadata.userSubmittedPaths,
      }),
      ...(metadata.userSubmittedMessageFieldPaths && {
        userSubmittedMessageFieldPaths: metadata.userSubmittedMessageFieldPaths,
      }),
    };
    await this.jobStore.updateJob(streamId, updates, generationId);
  }

  /** Stages exact detached terminal evidence in the generation-owned job outbox
   * and verifies the epoch-fenced write before the external result leaves memory. */
  async persistAgentEventDetachedTerminalEvidence(
    streamId: string,
    expectedCreatedAt: number,
    evidence: NonNullable<t.GenerationJobMetadata['agentEventDetachedTerminalEvidence']>,
  ): Promise<boolean> {
    await this.jobStore.updateJob(
      streamId,
      { agentEventDetachedTerminalEvidence: evidence },
      expectedCreatedAt,
    );
    const persisted = await this.jobStore.getJob(streamId);
    const actual = persisted?.agentEventDetachedTerminalEvidence;
    return (
      persisted?.createdAt === expectedCreatedAt &&
      actual?.version === evidence.version &&
      actual.deliveryKey === evidence.deliveryKey &&
      actual.generationCreatedAt === evidence.generationCreatedAt &&
      actual.taskId === evidence.taskId &&
      actual.idempotencyKey === evidence.idempotencyKey &&
      actual.status === evidence.status &&
      actual.result === evidence.result &&
      actual.error === evidence.error &&
      actual.observedAt === evidence.observedAt
    );
  }

  /** Records that one exact provider segment has completed every trailing write.
   * The opaque segment id prevents a paused controller from acknowledging a
   * later HITL resume that reuses the same generation epoch. */

  /**
   * Wait for tracked generations to settle, bounded so shutdown still finishes inside a
   * container stop grace period. Anything still outstanding is left alone: asserting a drain
   * it has not reached is the unsafe direction, so we log and let the deployment's
   * hard-kill handling own that case.
   */
  private async awaitGenerationSettlements(budget: number): Promise<void> {
    const deadline = Date.now() + budget;
    /** Re-snapshot until the set drains. A settlement can be registered while an earlier
     *  one is being awaited — the controller registers its detached chain just before its
     *  initialization settlement resolves — and a one-time snapshot would return between
     *  the two, tearing down the store and transport under a still-running provider. */
    while (this.openProviderExecutions.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const pending = [...this.openProviderExecutions.values()].map((entry) => entry.promise);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
    const unsettled = this.openProviderExecutions.size;
    if (unsettled > 0) {
      logger.warn(
        `[GenerationJobManager] ${unsettled} provider execution(s) did not drain within ${budget}ms of shutdown; their drains are unrecorded`,
      );
    }
  }

  async markProviderExecutionDrained(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    try {
      return await this.recordProviderExecutionDrain(
        streamId,
        expectedCreatedAt,
        providerExecutionId,
      );
    } finally {
      /** Settles the shutdown wait whether or not the record succeeded: a drain that failed
       *  to write has nothing further to wait for, and holding shutdown open on it would only
       *  push the process into the force-exit with the same unrecorded marker. */
      this.closeProviderExecution(streamId, expectedCreatedAt, providerExecutionId);
    }
  }

  private async recordProviderExecutionDrain(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    if (providerExecutionId.length === 0 || providerExecutionId.length > 128) {
      return false;
    }

    const observedJob = await this.jobStore.getJob(streamId);
    if (
      observedJob?.createdAt === expectedCreatedAt &&
      observedJob.providerExecutionId === providerExecutionId
    ) {
      // `providerDrained` is also the cross-replica host-settlement readiness
      // fence. Flush the complete generation-fenced run-step snapshot before
      // advertising that no more provider evidence can arrive.
      await this.persistAgentEventRunStepEvidence(streamId, observedJob);
    }

    const [marked, recorded] = await Promise.all([
      this.jobStore.markProviderExecutionDrained?.(
        streamId,
        expectedCreatedAt,
        providerExecutionId,
      ) ?? Promise.resolve(false),
      this.eventTransport.recordProviderDrain?.(streamId, expectedCreatedAt, providerExecutionId) ??
        Promise.resolve(false),
    ]);
    const job = await this.jobStore.getJob(streamId);
    if (
      marked &&
      job?.createdAt === expectedCreatedAt &&
      job.providerExecutionId === providerExecutionId &&
      job.providerDrained === true &&
      job.terminalHostActionPending === true
    ) {
      if (job.status === 'aborted' && job.error === APPROVAL_EXPIRED_ERROR) {
        await this.runApprovalExpiredHandler(streamId, job);
      } else {
        await this.runTerminalHostActionHandler(streamId, job);
      }
    }
    if (
      marked &&
      recorded &&
      this._cleanupOnComplete &&
      job?.createdAt === expectedCreatedAt &&
      job.providerExecutionId === providerExecutionId &&
      job.providerDrained === true &&
      job.preserveForScheduleReconcile !== true &&
      job.terminalPersistencePending !== true &&
      job.terminalHostActionPending !== true &&
      (job.status === 'complete' || job.status === 'aborted')
    ) {
      await this.jobStore.deleteJob(streamId, expectedCreatedAt);
    }
    return marked;
  }

  /** Starts the initial provider owner only if account deletion, abort, or a
   * replacement has not already changed the exact running generation. */
  async beginProviderExecution(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    if (providerExecutionId.length === 0 || providerExecutionId.length > 128) {
      return false;
    }
    /** A provider that has not started by the time shutdown begins must not start. The
     *  settlement wait only covers executions begun before it returned; one begun after it
     *  would commit `providerDrained: false` against a store that is about to close and
     *  fence its successor. Callers already treat `false` as "stopped before provider
     *  startup", and nothing has been committed. */
    if (this.shuttingDown) {
      return false;
    }
    /** Opened before the CAS and closed only on a definitive `false`. A rejected reply is
     *  ambiguous — the store may already have committed `providerDrained: false` — and every
     *  caller treats it that way, running or cleaning up and recording the drain either way.
     *  Leaving the tracker open makes shutdown wait for that record instead of tearing the
     *  transport down underneath it; the deadline still bounds the wait if it never comes. */
    this.openProviderExecution(streamId, expectedCreatedAt, providerExecutionId);
    const started =
      (await this.jobStore.beginProviderExecution?.(
        streamId,
        expectedCreatedAt,
        providerExecutionId,
      )) ?? false;
    if (!started) {
      this.closeProviderExecution(streamId, expectedCreatedAt, providerExecutionId);
    }
    return started;
  }

  private providerExecutionKey(
    streamId: string,
    createdAt: number,
    providerExecutionId: string,
  ): string {
    return `${streamId}:${createdAt}:${providerExecutionId}`;
  }

  private openProviderExecution(
    streamId: string,
    createdAt: number,
    providerExecutionId: string,
  ): void {
    const key = this.providerExecutionKey(streamId, createdAt, providerExecutionId);
    if (this.openProviderExecutions.has(key)) {
      return;
    }
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.openProviderExecutions.set(key, { promise, settle });
  }

  private closeProviderExecution(
    streamId: string,
    createdAt: number,
    providerExecutionId: string,
  ): void {
    const key = this.providerExecutionKey(streamId, createdAt, providerExecutionId);
    const entry = this.openProviderExecutions.get(key);
    if (entry == null) {
      return;
    }
    this.openProviderExecutions.delete(key);
    entry.settle();
  }

  /**
   * Release the tracker for an execution whose owner will never record its drain — a run
   * that settled its provider work but failed terminalization and deliberately publishes no
   * marker. Nothing is written: shutdown simply stops waiting on it, and the absent marker
   * keeps telling a successor the truth.
   */
  abandonProviderExecution(streamId: string, createdAt: number, providerExecutionId: string): void {
    this.closeProviderExecution(streamId, createdAt, providerExecutionId);
  }

  /** Settle and drop every open tracker; used wherever the services they belong to go away. */
  private releaseOpenProviderExecutions(): void {
    for (const entry of this.openProviderExecutions.values()) {
      entry.settle();
    }
    this.openProviderExecutions.clear();
  }

  private async waitForProviderExecutionDrain(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<void> {
    const deadline = Date.now() + PROVIDER_DRAIN_TIMEOUT_MS;
    for (;;) {
      if (
        (await this.eventTransport
          .hasProviderDrain?.(streamId, expectedCreatedAt, providerExecutionId)
          .catch(() => false)) === true
      ) {
        return;
      }
      const job = await this.jobStore.getJob(streamId);
      if (
        job?.createdAt === expectedCreatedAt &&
        job.providerExecutionId === providerExecutionId &&
        job.providerDrained === true
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for provider execution to drain: ${streamId}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PROVIDER_DRAIN_POLL_MS);
      });
    }
  }

  private async waitForProviderDrainIfRequired(
    streamId: string,
    job: SerializableJobData,
  ): Promise<void> {
    if (!job.providerExecutionId) {
      if (job.providerDrained !== false) {
        return;
      }
      throw new Error(`Cannot confirm provider execution drain for legacy job: ${streamId}`);
    }
    // Never trust the caller's pre-abort `providerDrained` snapshot here. The
    // provider can win its exact begin CAS after that read but before the
    // terminal CAS. Re-read the exact segment only after terminal ownership is
    // committed, when no not-yet-started provider can begin anymore.
    await this.waitForProviderExecutionDrain(streamId, job.createdAt, job.providerExecutionId);
  }

  /**
   * Set reference to the graph's contentParts array.
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): void {
    const runtime = this.runtimeState.get(streamId);
    if (!runtime || (expectedCreatedAt != null && runtime.createdAt !== expectedCreatedAt)) {
      return;
    }
    this.jobStore.setContentParts(streamId, contentParts, runtime.createdAt);
  }

  /**
   * Set reference to the collectedUsage array.
   * This array accumulates token usage from all models during generation.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    expectedCreatedAt?: number,
  ): void {
    const runtime = this.runtimeState.get(streamId);
    if (!runtime || (expectedCreatedAt != null && runtime.createdAt !== expectedCreatedAt)) {
      return;
    }
    this.jobStore.setCollectedUsage(streamId, collectedUsage, runtime.createdAt);
  }

  /**
   * Set reference to the graph instance.
   */
  setGraph(streamId: string, graph: StandardGraph, expectedCreatedAt?: number): void {
    const runtime = this.runtimeState.get(streamId);
    if (!runtime || (expectedCreatedAt != null && runtime.createdAt !== expectedCreatedAt)) {
      return;
    }
    this.jobStore.setGraph(streamId, graph, runtime.createdAt);
  }

  /**
   * The guarded human-review lifecycle for paused runs:
   * `approvals.pause()` / `peek()` / `resolve()` / `expire()`.
   *
   * This is the seam approval routes, the status endpoint, and the run wiring
   * cross — it owns the legal `requires_action` transitions and is race-safe
   * against concurrent resumes (a double-resolve would otherwise drive the run
   * twice). The job's chunks, run steps, and user-active-set membership are
   * preserved across a pause so the resume path can rebuild context; the store
   * refreshes the job-hash TTL to give the user the full window to respond.
   */
  get approvals(): ApprovalLifecycle {
    return this._approvals;
  }

  /**
   * The FIFO steering queue for mid-run user messages:
   * `steering.enqueue()` / `drain()` / `peek()` / `clear()`.
   *
   * The steer route enqueues from any instance; the owning process's
   * run-scoped PostToolBatch hook drains at the next tool-batch boundary.
   * Finalization paths drain leftovers into the final/abort events so the
   * client can convert them to queued follow-ups.
   */
  get steering(): SteeringLifecycle {
    return this._steering;
  }

  /**
   * Arms a cooperative-seal request for one queued steer and reports whether
   * the arm actually reached an owner. Never touches job status.
   *
   * Returns true when this replica owns the generation (armed locally), or
   * when the fenced publish was received by at least one subscriber. Returns
   * FALSE when the publish failed or nobody was listening: the steer is still
   * durably queued and will inject at the next tool boundary, but nothing
   * will seal for it, so the caller must not acknowledge it as interrupting.
   * The owner's own `createdAt` fence still decides whether to honour it.
   */
  async requestPreempt(
    streamId: string,
    steerId: string,
    jobCreatedAt: number,
    revision = 0,
  ): Promise<boolean> {
    /**
     * `ownedJobs`, NOT `runtimeState`: a cross-replica `getJob` installs a
     * facade runtime on THIS replica via `getOrCreateRuntimeState`, so a
     * matching `runtime.createdAt` proves only that we have looked at the
     * job — not that we generate it. Arming that facade would satisfy
     * nothing while reporting success.
     */
    const ownedHere = this.ownedJobs.get(streamId) === jobCreatedAt;
    const runtime = this.runtimeState.get(streamId);
    if (ownedHere && runtime != null && runtime.createdAt === jobCreatedAt) {
      /** Zero accepted means the id was tombstoned (its steer drained at an
       *  ordinary boundary mid-request) — not an arm, so do not claim one. */
      return (
        this.armPreemptIds(runtime, jobCreatedAt, [steerId], {
          [steerId]: revision,
        }) > 0
      );
    }
    if (this.eventTransport.emitPreempt == null) {
      /** Single-process transport: the local arm is the whole mechanism. */
      return false;
    }
    try {
      await this.eventTransport.emitPreempt(streamId, {
        op: 'arm',
        createdAt: jobCreatedAt,
        steerIds: [steerId],
        revisions: { [steerId]: revision },
      });
      /**
       * Best effort, and deliberately not read as proof. The publisher's
       * subscriber count includes THIS replica's own facade subscription, so
       * it cannot distinguish "the owner heard" from "we heard ourselves";
       * proving owner receipt would need a correlated request/response over
       * pub-sub. See the acknowledgement-semantics note on the PR.
       */
      return true;
    } catch (error) {
      logger.error(`[GenerationJobManager] Failed to publish preempt arm for ${streamId}:`, error);
      return false;
    }
  }

  /** O(1) level-triggered poll consumed by the run's `shouldPreempt`. */
  isPreemptRequested(streamId: string): boolean {
    return (this.runtimeState.get(streamId)?.preempt?.ids.size ?? 0) > 0;
  }

  /**
   * Clears preempt requests for steers that left the durable queue — drained
   * at a boundary (tool or preempt), cancelled, or dropped. The fenced
   * cross-replica `clear` keeps a request from outliving its steer on the
   * generating replica; without a fence identity the publish is skipped and
   * the empty-boundary path's self-clear bounds the damage to one seal.
   */
  noteSteersRemoved(streamId: string, steerIds: string[], jobCreatedAt?: number): Promise<boolean> {
    if (steerIds.length === 0) {
      return Promise.resolve(true);
    }
    const runtime = this.runtimeState.get(streamId);
    if (runtime != null && (jobCreatedAt == null || runtime.createdAt === jobCreatedAt)) {
      this.clearPreemptIds(runtime, jobCreatedAt ?? runtime.createdAt, steerIds);
    }
    const createdAt = jobCreatedAt ?? runtime?.createdAt;
    if (createdAt == null || this.eventTransport.emitPreempt == null) {
      /** Nothing to publish: the local disarm above is the whole mechanism. */
      return Promise.resolve(true);
    }
    /**
     * Awaitable so a CANCEL retries and logs before responding. A dropped
     * clear is worse than a dropped arm: the owner keeps a level-triggered
     * request for a steer that no longer exists, seals its next chunk,
     * drains nothing, and truncates an unrelated answer. Retried once — a
     * transient publish error is the common case and the retry is cheap.
     *
     * The returned boolean means "published without error", NOT "the owner
     * disarmed": the delivery count includes this replica's own facade
     * subscription, so publication cannot prove receipt. It is for logging
     * only and must not be surfaced as a guarantee. Proving receipt needs a
     * correlated request/response over pub-sub.
     *
     * Damage is bounded regardless: if the clear is lost the owner seals
     * once, the empty-boundary self-clear disarms the generation, and the
     * turn is persisted `unfinished: true` rather than silently truncated.
     */
    const publish = (): Promise<void> =>
      Promise.resolve().then(async () => {
        await this.eventTransport.emitPreempt?.(streamId, {
          op: 'clear',
          createdAt,
          steerIds,
        });
      });
    return publish().then(
      () => true,
      () =>
        publish().then(
          () => true,
          (error: unknown) => {
            logger.error(
              `[GenerationJobManager] Failed to publish preempt clear for ${streamId} after retry; ` +
                'the owner may seal once before its empty boundary self-clears:',
              error,
            );
            return false;
          },
        ),
    );
  }

  /**
   * Rebuilds the armed set from the DURABLE queue for a generation whose
   * ownership just moved (HITL resume landing on another replica).
   *
   * An arm lives only in the owning replica's runtime plus a transient
   * pub/sub message, while the steer's `preempt` flag is durable on the queue
   * item. A replica that never observed the original arm therefore starts
   * with an empty set and its poll stays false, so an interrupt the user
   * already had acknowledged would silently wait for an ordinary tool
   * boundary.
   *
   * REPLACES the armed set rather than adding to it. A replica that only ever
   * read this job still installed a facade runtime and subscribed, so it can
   * have accepted an arm and then missed the best-effort clear that followed
   * the drain. Promotion to owner makes that orphan live, and a union would
   * keep it: the first resumed stream seals on a steer no longer in the
   * queue, drains nothing, and truncates the resumed answer as
   * `preempt_incomplete`. The durable queue is the only authority at a
   * handover, so anything absent from it is disarmed and tombstoned here —
   * tombstoned because an arm that outlived its steer must not be able to
   * come back a second time.
   */
  async rearmQueuedPreempts(streamId: string, jobCreatedAt: number): Promise<number> {
    /** A capable→incapable HITL handover must rewrite durable truth before it
     * rebuilds runtime arms. The store returns the exact ids it downgraded so
     * they can be tombstoned against an arm publication that was already in
     * flight when the approval transition changed capability. `[]` still
     * proves the live owner is incapable; `null` means capable/missing/stale
     * and falls through to the ordinary reconciliation below. */
    const downgraded = await this._steering.downgradePreempts(streamId, jobCreatedAt);
    if (downgraded != null) {
      const runtime = this.runtimeState.get(streamId);
      if (runtime != null && runtime.createdAt === jobCreatedAt) {
        this.downgradePreemptIds(runtime, jobCreatedAt, downgraded);
      }
      if (downgraded.length > 0) {
        await this.emitChunk(
          streamId,
          {
            event: SteerEvents.ON_STEER_UPDATED,
            data: {
              conversationId: streamId,
              steers: downgraded.map((steer) => ({
                steerId: steer.steerId,
                ...(steer.clientSteerId && {
                  clientSteerId: steer.clientSteerId,
                }),
                preempt: false,
                preemptRevision: steer.preemptRevision ?? 0,
              })),
            },
          },
          { durable: true, expectedCreatedAt: jobCreatedAt },
        );
      }
      return 0;
    }

    /**
     * The armed set is snapshotted BEFORE the queue is read, and that order is
     * the entire safety argument. `approvals.resolve` has already reopened
     * steering by the time this runs, so a concurrent replica can enqueue a
     * preempt steer and publish its arm while the `peek` is in flight. Reading
     * the queue first would leave that arm present locally but missing from a
     * snapshot taken before it existed, and this method would tombstone a live
     * interrupt the route already acknowledged — unrecoverable, since the
     * tombstone also blocks the re-arm.
     *
     * Taking the arms first makes that impossible without a lock or a second
     * round trip: a steer is durably enqueued BEFORE its arm is published, so
     * any id in this snapshot was already queued when it was armed, and the
     * later `peek` is guaranteed to observe it unless it has since drained —
     * which is precisely the orphan this reconciliation exists to drop.
     */
    const runtime = this.runtimeState.get(streamId);
    const armedBeforeRead =
      runtime?.preempt != null && runtime.createdAt === jobCreatedAt
        ? [...runtime.preempt.ids]
        : [];

    const queued = await this._steering.peek(streamId, jobCreatedAt);
    const backedItems = queued.filter((item) => item.preempt === true);
    const backed = new Set(backedItems.map((item) => item.steerId));

    /** The generation can be replaced across the read; only disarm the runtime
     *  the snapshot was taken from. */
    if (runtime != null && this.runtimeState.get(streamId) === runtime) {
      const orphaned = armedBeforeRead.filter((id) => !backed.has(id));
      if (orphaned.length > 0) {
        logger.warn(
          `[GenerationJobManager] Dropping ${orphaned.length} preempt arm(s) with no queued steer ` +
            `while ownership of ${streamId} moves`,
        );
        this.clearPreemptIds(runtime, jobCreatedAt, orphaned);
      }
    }

    let rearmed = 0;
    for (const item of backedItems) {
      await this.requestPreempt(streamId, item.steerId, jobCreatedAt, item.preemptRevision ?? 0);
      rearmed += 1;
    }
    return rearmed;
  }

  /**
   * Snapshot of the ids armed right now, taken BEFORE a drain so the
   * empty-boundary disarm can scope itself to them.
   */
  getArmedPreemptIds(streamId: string, jobCreatedAt?: number): string[] {
    const runtime = this.runtimeState.get(streamId);
    if (runtime?.preempt == null) {
      return [];
    }
    if (jobCreatedAt != null && runtime.createdAt !== jobCreatedAt) {
      return [];
    }
    return [...runtime.preempt.ids];
  }

  /**
   * Disarms the requests a spent boundary was responsible for. Called when a
   * boundary drains nothing: the seal is already spent and those ids refer to
   * steers no longer in the queue, so leaving them armed would seal again on
   * the next chunk and truncate an unrelated answer.
   *
   * Scoped to an explicit id list rather than wiping the set: a second steer
   * can enqueue and arm between the atomic drain returning empty and this
   * call, and that arm is backed by a live queue item that has not been
   * injected yet.
   */
  clearPreemptRequests(streamId: string, steerIds: string[], jobCreatedAt?: number): void {
    if (steerIds.length === 0) {
      return;
    }
    const runtime = this.runtimeState.get(streamId);
    if (runtime?.preempt == null) {
      return;
    }
    if (jobCreatedAt != null && runtime.createdAt !== jobCreatedAt) {
      return;
    }
    this.clearPreemptIds(runtime, runtime.createdAt, steerIds);
  }

  /**
   * Get resume state for reconnecting clients.
   */
  async getResumeState(
    streamId: string,
    expectedCreatedAt?: number,
    options?: {
      durableOnly?: boolean;
      validateEarlyBufferRecovery?: boolean;
      onContentSnapshot?: (snapshot: Awaited<ReturnType<IJobStore['getContentParts']>>) => void;
    },
  ): Promise<t.ResumeState | null> {
    const recoveryStartedAt =
      options?.validateEarlyBufferRecovery === true ? Date.now() : undefined;
    let jobData = await this.jobStore.getJob(streamId);
    if (!jobData || (expectedCreatedAt != null && jobData.createdAt !== expectedCreatedAt)) {
      return null;
    }
    if (jobData.earlyBufferOverflow?.persistencePending === true) {
      const initialCreatedAt = jobData.createdAt;
      jobData = await this.waitForFinalizedEarlyBufferOverflow(streamId, jobData);
      if (!jobData || jobData.createdAt !== initialCreatedAt) {
        return null;
      }
      if (
        jobData.earlyBufferOverflow?.persistencePending === true &&
        options?.validateEarlyBufferRecovery !== true
      ) {
        return null;
      }
    }
    const unresolvedOverflowValidation =
      options?.validateEarlyBufferRecovery === true &&
      jobData.earlyBufferOverflow != null &&
      jobData.earlyBufferOverflow.recoveryOutcome == null;
    const validationRuntime =
      options?.validateEarlyBufferRecovery === true
        ? await this.getOrCreateRuntimeState(streamId, jobData)
        : undefined;
    if (
      options?.validateEarlyBufferRecovery === true &&
      (validationRuntime == null || validationRuntime.createdAt !== jobData.createdAt)
    ) {
      throw new Error('Generation changed during HITL recovery validation');
    }
    if (
      options?.validateEarlyBufferRecovery === true &&
      jobData.earlyBufferOverflow?.recoveryOutcome === 'failed'
    ) {
      await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, jobData.createdAt);
      throw new Error(GENERATION_RECOVERY_FAILED_ERROR);
    }

    /** Independent reads (streamId-only): parallel to collapse 3 Redis round trips into 1.
     *  Safe despite readCachedGraph's cache-drop side effect — each call catches its own
     *  unusable-graph throw and falls back to reconstruction, so ordering cannot change the result. */
    const [result, runSteps, queuedSteers, claimedSteers] = await Promise.all([
      this.jobStore.getContentParts(streamId, jobData.createdAt, {
        durableOnly: options?.durableOnly === true || unresolvedOverflowValidation,
      }),
      this.jobStore.getRunSteps(streamId, jobData.createdAt),
      this.jobStore.peekSteers(streamId, jobData.createdAt),
      this.jobStore.peekClaimedSteers(streamId, jobData.createdAt),
    ]);
    options?.onContentSnapshot?.(result);
    const pendingOverflow = unresolvedOverflowValidation ? jobData.earlyBufferOverflow : undefined;
    if (pendingOverflow != null) {
      const runtime = validationRuntime!;
      const reconstructedEvents = this._isRedis
        ? (result?.reconstructedEventCount ?? 0)
        : runtime.emissionSequence;
      const durableEvents = this._isRedis
        ? (result?.durableEventCount ?? 0)
        : runtime.emissionSequence;
      let failureReason: EarlyBufferRecoveryFailureReason | undefined;
      if (pendingOverflow.persistencePending === true) {
        failureReason = 'overflow_marker_persistence_failed';
      } else if (result == null) {
        failureReason = 'durable_state_missing';
      } else if (
        durableEvents < pendingOverflow.durableEvents ||
        reconstructedEvents !== durableEvents
      ) {
        failureReason = 'durable_frontier_gap';
      }
      const winningOutcome = await this.settleEarlyBufferRecovery(
        streamId,
        runtime,
        pendingOverflow,
        failureReason == null ? 'success' : 'failed',
        recoveryStartedAt == null ? 0 : Date.now() - recoveryStartedAt,
        reconstructedEvents,
        result?.content.length ?? 0,
        failureReason,
      );
      if (winningOutcome == null) {
        const currentJob = await this.jobStore.getJob(streamId);
        if (currentJob?.createdAt !== jobData.createdAt) {
          throw new Error('Generation changed during HITL recovery validation');
        }
      }
      if (failureReason != null && winningOutcome === 'success') {
        throw new Error('Concurrent recovery succeeded; retry HITL resume');
      }
      if (winningOutcome === 'not_required') {
        throw new Error('HITL recovery no longer required for this generation');
      }
      if (winningOutcome !== 'success') {
        await this.completeJob(streamId, GENERATION_RECOVERY_FAILED_ERROR, runtime.createdAt);
        throw new Error(GENERATION_RECOVERY_FAILED_ERROR);
      }
    }
    const reconstructedContent = result?.content ?? [];
    const bufferState = this.runStepBuffers?.get(streamId);
    const bufferedRunSteps = bufferState?.createdAt === jobData.createdAt ? bufferState.steps : [];
    const runStepsById = new Map(runSteps.map((runStep) => [runStep.id, runStep]));
    for (const runStep of bufferedRunSteps) {
      runStepsById.set(runStep.id, runStep);
    }
    const effectiveRunSteps = normalizeResumeRunStepIndices(
      [...runStepsById.values()],
      reconstructedContent,
    );
    let titleEvent: t.ResumeState['titleEvent'];
    if (jobData.titleEvent) {
      try {
        titleEvent = JSON.parse(jobData.titleEvent) as t.ResumeState['titleEvent'];
      } catch {
        // Ignore malformed persisted title events.
      }
    }
    let replayEvents: t.ResumeState['replayEvents'];
    if (jobData.replayEvents) {
      try {
        replayEvents = JSON.parse(jobData.replayEvents) as t.ResumeState['replayEvents'];
        replayEvents = normalizeRunStepReplayIndices(replayEvents, effectiveRunSteps);
      } catch {
        // Ignore malformed persisted replay events.
      }
    }

    let contextUsage: t.ResumeState['contextUsage'];
    if (jobData.contextUsage) {
      try {
        contextUsage = JSON.parse(jobData.contextUsage) as t.ResumeState['contextUsage'];
      } catch {
        // Ignore malformed persisted context usage.
      }
    }

    /** Persisted per model call by trackTokenUsage — unlike the live
     *  collectedUsage reference, this survives cross-replica resumes. */
    let collectedUsage: t.ResumeState['collectedUsage'];
    if (jobData.tokenUsage) {
      try {
        const parsed = JSON.parse(jobData.tokenUsage) as t.ResumeState['collectedUsage'];
        collectedUsage = parsed && parsed.length > 0 ? parsed : undefined;
      } catch {
        // Ignore malformed persisted token usage.
      }
    }

    /** Steers still queued (not yet injected); injected ones are already in aggregatedContent. */
    const pendingSteers = omitAlreadyAppliedSteers(
      mergeUnresolvedSteers(claimedSteers, queuedSteers),
      reconstructedContent as unknown[],
    ).map(toPendingSteer);

    /** The four component reads are generation-fenced, but replacement can
     * land after the initial job read and make all of them return empty. Do
     * not turn that into a plausible-looking snapshot with predecessor
     * metadata; verify the same generation is still live after the snapshot. */
    const verifiedJob = await this.jobStore.getJob(streamId);
    if (!verifiedJob || verifiedJob.createdAt !== jobData.createdAt) {
      return null;
    }
    /** Redis reconstruction has no completion event for ask_user_question.
     * Apply the answer stamps from the generation-fenced job read so reload,
     * status, resume, and abort all expose the same authoritative content. */
    const aggregatedContent = attachAskUserQuestionAnswers(
      reconstructedContent,
      verifiedJob.resolvedAskUserQuestions ?? [],
    );

    logger.debug(`[GenerationJobManager] getResumeState:`, {
      streamId,
      runStepsLength: effectiveRunSteps.length,
      aggregatedContentLength: aggregatedContent.length,
      collectedUsageLength: collectedUsage?.length ?? 0,
    });

    return {
      runSteps: effectiveRunSteps,
      aggregatedContent,
      userMessage: jobData.userMessage,
      responseMessageId: jobData.responseMessageId,
      isRegenerate: jobData.isRegenerate,
      conversationId: jobData.conversationId,
      sender: jobData.sender,
      iconURL: jobData.iconURL,
      model: jobData.model,
      titleEvent,
      replayEvents,
      pendingOAuthPrompts: projectPendingMCPOAuthPrompts(replayEvents, effectiveRunSteps),
      collectedUsage,
      contextUsage,
      // Carry the live pending approval in the resume contract so a reloading /
      // cross-replica client can rebuild the prompt from resumeState. Client-safe
      // projection: the stored record's resumeContext/requestFingerprint stay server-only.
      pendingAction:
        verifiedJob.status === 'requires_action' && !isPendingActionStale(verifiedJob)
          ? toClientPendingAction(verifiedJob.pendingAction)
          : undefined,
      pendingSteers: pendingSteers.length > 0 ? pendingSteers : undefined,
    } satisfies t.ResumeState;
  }

  /**
   * Mark that sync has been sent.
   * Persists to Redis for cross-replica consistency.
   */
  markSyncSent(streamId: string, expectedCreatedAt?: number): void {
    const runtime = this.runtimeState.get(streamId);
    if (runtime && (expectedCreatedAt == null || runtime.createdAt === expectedCreatedAt)) {
      runtime.syncSent = true;
    }
    // Persist to Redis for cross-replica consistency
    this.jobStore
      .updateJob(streamId, { syncSent: true }, expectedCreatedAt ?? runtime?.createdAt)
      .catch((err) => {
        logger.error(`[GenerationJobManager] Failed to persist syncSent flag:`, err);
      });
  }

  /**
   * Check if sync has been sent.
   * Checks local runtime first, then falls back to Redis for cross-replica scenarios.
   */
  async wasSyncSent(streamId: string): Promise<boolean> {
    const localSyncSent = this.runtimeState.get(streamId)?.syncSent;
    if (localSyncSent !== undefined) {
      return localSyncSent;
    }
    // Cross-replica: check Redis
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.syncSent ?? false;
  }

  /**
   * Emit a done event.
   * Persists finalEvent to Redis for cross-replica access.
   */
  async emitDone(
    streamId: string,
    rawEvent: t.ServerSentEvent,
    expectedCreatedAt?: number,
  ): Promise<void> {
    /** Exclude prompt-building inputs before this event reaches the runtime
     * cache, the durable job hash or the transport. */
    const event = projectTerminalEvent(rawEvent);
    const runtime = this.runtimeState.get(streamId);
    const generationId = expectedCreatedAt ?? runtime?.createdAt;
    const matchingRuntime =
      runtime && (generationId == null || runtime.createdAt === generationId) ? runtime : undefined;
    if (matchingRuntime) {
      matchingRuntime.finalEvent = event;
    }
    if (matchingRuntime?.createdEventPublication) {
      await matchingRuntime.createdEventPublication;
    }
    // Persist finalEvent to Redis for cross-replica consistency
    this.jobStore
      .updateJob(streamId, { finalEvent: JSON.stringify(event) }, generationId)
      .catch((err) => {
        logger.error(`[GenerationJobManager] Failed to persist finalEvent:`, err);
      });
    await this.eventTransport.emitDone(streamId, event, generationId);
    if (matchingRuntime?.startupTelemetry) {
      this.recordStartupEvent(matchingRuntime, event);
    }
  }

  /**
   * Emit an error event.
   * Stores the error for late-connecting subscribers (race condition where error
   * occurs before client connects to SSE stream).
   */
  async emitError(streamId: string, error: string, expectedCreatedAt?: number): Promise<void> {
    const runtime = this.runtimeState.get(streamId);
    const generationId = expectedCreatedAt ?? runtime?.createdAt;
    const matchingRuntime =
      runtime && (generationId == null || runtime.createdAt === generationId) ? runtime : undefined;
    if (matchingRuntime) {
      matchingRuntime.errorEvent = error;
    }
    if (matchingRuntime?.createdEventPublication) {
      await matchingRuntime.createdEventPublication;
    }
    // Persist error to job store for cross-replica consistency
    this.jobStore.updateJob(streamId, { error }, generationId).catch((err) => {
      logger.error(`[GenerationJobManager] Failed to persist error:`, err);
    });
    await this.eventTransport.emitError(streamId, error, generationId);
    matchingRuntime?.startupTelemetry?.mark('first_response_event_queued');
  }

  /**
   * Expire a single observed-stale pending approval NOW (immediate, not via the periodic
   * sweep): run the `requires_action → aborted` CAS — pinned to `actionId` so a concurrent
   * resolve + re-pause on a fresh action isn't aborted — and, on success, emit the terminal
   * `APPROVAL_EXPIRED_ERROR` so any attached SSE client gets a terminal event instead of a
   * hung stream. The durable checkpoint remains bounded by its Mongo TTL; deleting the
   * thread eagerly here could race a replacement generation. Used by the periodic sweeper
   * and by the resume route, which observes a just-expired action when the user submits a
   * decision after the TTL lapsed. Returns true if this call expired the action.
   */
  async expireApproval(
    streamId: string,
    actionId?: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const observedRuntime = this.runtimeState.get(streamId);
    let observedJob: SerializableJobData | null = null;
    if (expectedCreatedAt == null) {
      try {
        observedJob = await this.jobStore.getJob(streamId);
      } catch (err) {
        logger.warn(
          `[GenerationJobManager] Failed to read approval before expiry ${streamId}`,
          err,
        );
      }
    }
    const expiredJob = await this._approvals.expireWithIdentity(
      streamId,
      actionId,
      expectedCreatedAt ?? observedJob?.createdAt,
      // Only retain a durable host-action marker when a host adapter is installed to
      // consume it — a store with no handler owes no action and accumulates nothing.
      {
        markHostActionPending:
          this.approvalExpiredHandler != null || this.terminalHostActionHandler != null,
      },
    );
    if (expiredJob == null) {
      return false;
    }

    await this.runApprovalExpiredHandler(streamId, expiredJob);
    await this.notifyApprovalExpiredRuntime(streamId, expiredJob.createdAt, observedRuntime);
    /** Expiry is a direct `requires_action -> aborted` transition that never builds a
     * terminal claim, so it announces settlement itself. */
    this.notifyGenerationSettled({
      streamId,
      conversationId: expiredJob.conversationId,
      userId: expiredJob.userId,
      status: 'aborted',
    });
    /** Terminal now; releasing ownership keeps the sweep's relay branch from
     * announcing this generation a second time. */
    this.releaseJobOwnership(streamId, expiredJob.createdAt);
    return true;
  }

  private async runApprovalExpiredHandler(
    streamId: string,
    job: SerializableJobData,
  ): Promise<void> {
    try {
      await this.approvalExpiredHandler?.(streamId, job);
      if (job.agentEventDeliveryKey != null) {
        await this.terminalHostActionHandler?.(
          streamId,
          job,
          await this.getTerminalRunSteps(streamId, job),
          (await this.jobStore.getContentParts(streamId, job.createdAt))?.content ?? [],
        );
      }
      // Success: the durable host action is settled. Clear its pending marker, fenced to
      // this exact generation so a replacement at the same streamId keeps its own state.
      // A no-op handler (or none) clears harmlessly, so non-scheduled jobs never linger.
      await this.jobStore.clearTerminalHostAction?.(streamId, job.createdAt);
    } catch (err) {
      // Expiry itself already won its exact CAS. Keep terminal notification moving; the
      // `terminalHostActionPending` marker stays set so a later cleanup pass (this or
      // another replica, across restarts) re-enumerates the job and retries this
      // idempotent hook until it acknowledges.
      logger.error(`[GenerationJobManager] Approval-expiry host hook failed: ${streamId}`, err);
    }
  }

  private async runTerminalHostActionHandler(
    streamId: string,
    job: SerializableJobData,
  ): Promise<boolean> {
    try {
      if (job.agentEventDeliveryKey != null) {
        await this.terminalHostActionHandler?.(
          streamId,
          job,
          await this.getTerminalRunSteps(streamId, job),
          (await this.jobStore.getContentParts(streamId, job.createdAt))?.content ?? [],
        );
      }
      await this.jobStore.clearTerminalHostAction?.(streamId, job.createdAt);
      this.jobStore.clearContentState(streamId, job.createdAt);
      const buffered = this.runStepBuffers?.get(streamId);
      if (buffered?.createdAt === job.createdAt) {
        this.runStepBuffers?.delete(streamId);
      }
      return true;
    } catch (err) {
      logger.error(`[GenerationJobManager] Terminal host hook failed: ${streamId}`, err);
      return false;
    }
  }

  private async getTerminalRunSteps(
    streamId: string,
    job: Pick<SerializableJobData, 'createdAt'>,
  ): Promise<Agents.RunStep[]> {
    const persistedRunSteps = await this.jobStore.getRunSteps(streamId, job.createdAt);
    const buffered = this.runStepBuffers?.get(streamId);
    const runStepsById = new Map(persistedRunSteps.map((step) => [step.id, step]));
    if (buffered?.createdAt === job.createdAt) {
      for (const step of buffered.steps) {
        const persisted = runStepsById.get(step.id);
        // A stale/in-progress event must never erase authoritative completed
        // evidence recovered from the durable owner.
        if (persisted?.status !== 'completed' || step.status === 'completed') {
          runStepsById.set(step.id, step);
        }
      }
    }
    return [...runStepsById.values()].sort((left, right) => left.index - right.index);
  }

  private async notifyApprovalExpiredRuntime(
    streamId: string,
    createdAt: number,
    runtime: RuntimeJobState | undefined,
  ): Promise<void> {
    if (runtime?.createdAt === createdAt && runtime.approvalExpiryPublished) {
      return;
    }

    if (runtime?.createdAt === createdAt) {
      runtime.errorEvent = APPROVAL_EXPIRED_ERROR;
      runtime.startupTelemetry?.mark('first_response_event_queued');
    }
    try {
      await this.eventTransport.emitError(streamId, APPROVAL_EXPIRED_ERROR, createdAt);
      if (runtime?.createdAt === createdAt) {
        runtime.approvalExpiryPublished = true;
      }
    } catch (err) {
      if (!(err instanceof GenerationPublicationFencedError)) {
        logger.error(`[GenerationJobManager] Failed to publish expired approval ${streamId}`, err);
        if (runtime?.createdAt === createdAt) {
          for (const notify of [...runtime.localErrorHandlers]) {
            try {
              notify(APPROVAL_EXPIRED_ERROR);
            } catch (notifyError) {
              logger.error(
                `[GenerationJobManager] Failed to notify expired approval ${streamId}`,
                notifyError,
              );
            }
          }
        }
      }
    }
    if (runtime?.createdAt === createdAt) {
      this.releaseAbortSubscription(runtime);
      runtime.abortController.abort();
    }
  }

  private async expireStaleApprovals(): Promise<void> {
    let changed = false;
    // Scan durable pauses as well as local runtimes. A process can restart while an
    // approval waits; if expiry were limited to runtimeState, store cleanup would
    // terminalize that ownerless job without crossing the host lifecycle hook.
    const candidates = new Map<string, SerializableJobData>();
    if (this.jobStore.getRequiresActionJobs) {
      try {
        for (const job of await this.jobStore.getRequiresActionJobs()) {
          candidates.set(job.streamId, job);
        }
      } catch (err) {
        logger.error('[GenerationJobManager] Failed to enumerate pending approvals', err);
      }
    }
    // Also scan terminal jobs that still owe a host lifecycle hook. An expired approval is
    // no longer in the requires_action index, so without this a failed host hook (e.g. the
    // schedule outcome write) would never be retried on a replica or after a restart that
    // has no local runtime — the exact clustered-entrypoint gap, which runs no reconciler.
    if (this.jobStore.getTerminalHostActionJobs) {
      try {
        for (const job of await this.jobStore.getTerminalHostActionJobs()) {
          candidates.set(job.streamId, job);
        }
      } catch (err) {
        logger.error('[GenerationJobManager] Failed to enumerate pending host actions', err);
      }
    }
    // Detached completion generations live in a versioned recovery lane. An
    // older replica knows only the ordinary terminal-host-action index and
    // therefore cannot deserialize away the original invocation identity or
    // acknowledge the completion against the wrong mailbox delivery.
    if (this.jobStore.getDetachedAgentEventTerminalHostActionJobs) {
      try {
        for (const job of await this.jobStore.getDetachedAgentEventTerminalHostActionJobs()) {
          candidates.set(job.streamId, job);
        }
      } catch (err) {
        logger.error(
          '[GenerationJobManager] Failed to enumerate detached Event Actor host actions',
          err,
        );
      }
    }
    const streamIds = new Set([...this.runtimeState.keys(), ...candidates.keys()]);
    for (const streamId of streamIds) {
      let job: SerializableJobData | null;
      try {
        job = candidates.get(streamId) ?? (await this.jobStore.getJob(streamId));
      } catch (err) {
        logger.error(
          `[GenerationJobManager] Failed to read job during approval expiry sweep: ${streamId}`,
          err,
        );
        continue;
      }
      // Loser-replica relay: in a multi-replica deployment another replica's store
      // cleanup (`cleanupRequiresActionIndex`) can win the requires_action → aborted
      // approval-expiry CAS — it sets the hash error but cannot emit (the store has no
      // event transport). A client subscribed on THIS replica would then never get a
      // terminal event until the reap path. If the job is already aborted *for approval
      // expiry* and we haven't emitted here, relay the terminal error to our subscriber.
      // The `errorEvent` flag (set by emitError) keeps this idempotent vs the win path.
      const runtime = this.runtimeState.get(streamId);
      if (job?.status === 'aborted' && job.error === APPROVAL_EXPIRED_ERROR) {
        // Retry the durable host hook ONLY while its marker is unacknowledged, so a
        // successful ack prevents duplicate work. The terminal SSE relay below is
        // separately idempotent (emitError's errorEvent flag) and always runs so a
        // loser-replica subscriber still gets a terminal event.
        if (job.terminalHostActionPending === true && job.providerDrained !== false) {
          await this.runApprovalExpiredHandler(streamId, job);
        }
        await this.notifyApprovalExpiredRuntime(streamId, job.createdAt, runtime);
        const released = this.releaseJobOwnership(streamId, job.createdAt);
        if (released) {
          /** The store won the expiry CAS, so no local claim announced it. */
          this.notifyGenerationSettled({
            streamId,
            conversationId: job.conversationId,
            userId: job.userId,
            status: 'aborted',
          });
        }
        changed = released || changed;
        continue;
      }
      if (
        job != null &&
        job.status !== 'running' &&
        job.status !== 'requires_action' &&
        job.terminalHostActionPending === true &&
        job.providerDrained !== false
      ) {
        await this.runTerminalHostActionHandler(streamId, job);
        changed = this.releaseJobOwnership(streamId, job.createdAt) || changed;
        continue;
      }
      if (!job || job.status !== 'requires_action' || !isPendingActionExpired(job)) {
        continue;
      }
      // Pass the OBSERVED action id so the expire CAS only fires for the action we read
      // as stale. Between this read and the CAS, the user could resolve it and the run
      // re-pause on a fresh action; without the id, the CAS (status-only) would abort
      // that valid new pause and leave it terminal.
      const didExpire = await this.expireApproval(
        streamId,
        job.pendingAction?.actionId,
        job.createdAt,
      );
      if (!didExpire) {
        continue;
      }
      changed = true;
      logger.debug(`[GenerationJobManager] Expired pending approval: ${streamId}`);
    }
    if (changed) {
      this.syncRunningJobMetrics();
    }
  }

  /**
   * Let the manager (rather than store-only cleanup) win stale pause barriers
   * whenever this replica has the runtime. That preserves the same atomic
   * fail-closed store transition while also notifying an attached client and
   * releasing process-local graph/listener resources.
   */
  private async failStalePausePersistenceBarriers(): Promise<void> {
    for (const [streamId, runtime] of [...this.runtimeState]) {
      try {
        await this._approvals.failStalePausePersistence(streamId, runtime.createdAt);
        /** Another replica's store-only cleanup may have won the same exact
         * CAS first. Relay that durable timeout into this replica's attached
         * runtime even though there is no barrier left for the lifecycle call
         * above to transition. */
        await this.finishTimedOutPausePersistence(
          streamId,
          runtime.createdAt,
          PAUSE_PERSISTENCE_TIMEOUT_ERROR,
          [],
        );
      } catch (error) {
        logger.error(
          `[GenerationJobManager] Failed to inspect stale pause persistence: ${streamId}`,
          error,
        );
      }
    }
  }

  private async cleanup(): Promise<void> {
    // A crashed pause writer must never become resumable merely because its
    // lease elapsed. Give a locally-observed runtime the first chance to fail
    // closed so its attached subscriber receives the terminal error.
    await this.failStalePausePersistenceBarriers();

    // Finalize approvals whose window lapsed before the store's own cleanup, so a
    // client still attached to a paused stream gets a terminal event instead of a
    // connection that hangs open until it gives up.
    await this.expireStaleApprovals();

    const count = await this.jobStore.cleanup();
    let runningJobsChanged = false;

    // Cleanup runtime state for deleted jobs
    for (const [streamId, observedRuntime] of this.runtimeState) {
      const jobExists = await this.jobStore.hasJob(streamId);
      if (jobExists) {
        const shouldInspectRemoteTerminal =
          this.ownedJobs.get(streamId) !== observedRuntime.createdAt &&
          this.eventTransport.getSubscriberCount(streamId) === 0;
        if (!shouldInspectRemoteTerminal) {
          continue;
        }

        const currentJob = await this.jobStore.getJob(streamId);
        if (
          currentJob?.createdAt === observedRuntime.createdAt &&
          currentJob.terminalHostActionPending === true
        ) {
          // The callback retry still owns this generation's evidence. Retain
          // runtime buffers until it acknowledges and clears the durable marker.
          continue;
        }
        const isRetainedTerminal =
          currentJob?.createdAt === observedRuntime.createdAt &&
          currentJob.status !== 'running' &&
          currentJob.status !== 'requires_action';
        if (!isRetainedTerminal || this.runtimeState.get(streamId) !== observedRuntime) {
          continue;
        }

        this.reconcileInactiveGeneration(
          streamId,
          observedRuntime.createdAt,
          currentJob,
          observedRuntime,
        );
        this.stopSubscriberLease(observedRuntime);
        this.runtimeState.delete(streamId);
        this.runStepBuffers?.delete(streamId);
        this.replayEventWriteQueues.delete(streamId);
        this.tokenUsageWriteQueues.delete(streamId);
        this.runStepWriteQueues.delete(streamId);
        this.jobStore.clearContentState(streamId, observedRuntime.createdAt);
        this.eventTransport.cleanup(streamId);
        continue;
      }

      // A replacement generation can reuse the same streamId while hasJob()
      // is in flight. Never reap the replacement runtime based on the stale
      // absence observed for its predecessor.
      if (this.runtimeState.get(streamId) !== observedRuntime) {
        this.releaseAbortSubscription(observedRuntime);
        if (!observedRuntime.abortController.signal.aborted) {
          observedRuntime.abortController.abort();
        }
        continue;
      }
      /**
       * Abort any still-pending generation whose job has been reaped (e.g. a
       * stale "running" job removed by the store's failsafe timeout). This
       * unwinds the hung in-flight work so its client/graph references can be
       * garbage collected, rather than leaking via the pending promise.
       */
      if (!observedRuntime.abortController.signal.aborted) {
        observedRuntime.abortController.abort();
      }
      // If a client is still attached when the job is reaped, send a terminal
      // error first so the SSE connection closes instead of hanging open with no
      // final/done event (the route only ends the response from onDone/onError).
      if (this.eventTransport.getSubscriberCount(streamId) > 0) {
        try {
          await this.eventTransport.emitError(
            streamId,
            REAPED_JOB_ERROR,
            observedRuntime.createdAt,
          );
          observedRuntime.startupTelemetry?.mark('first_response_event_queued');
        } catch (err) {
          if (err instanceof GenerationPublicationFencedError) {
            const currentJob = await this.jobStore.getJob(streamId);
            await this.reconcileFencedRuntimeHandoff(streamId, observedRuntime, currentJob);
            continue;
          }
          logger.error(`[GenerationJobManager] Failed to notify reaped stream ${streamId}:`, err);
        }
      }
      // emitError() is asynchronous; a replacement may have appeared while
      // the terminal event was being published.
      if (this.runtimeState.get(streamId) !== observedRuntime) {
        continue;
      }
      observedRuntime.startupTelemetry?.end('error', new Error(REAPED_JOB_ERROR));
      observedRuntime.startupTelemetry = undefined;
      this.releaseAbortSubscription(observedRuntime);
      this.stopSubscriberLease(observedRuntime);
      this.runtimeState.delete(streamId);
      runningJobsChanged = this.ownedJobs.delete(streamId) || runningJobsChanged;
      this.runStepBuffers?.delete(streamId);
      this.jobStore.clearContentState(streamId, observedRuntime.createdAt);
      this.eventTransport.cleanup(streamId);
    }

    // Also check runStepBuffers for any orphaned entries.
    if (this.runStepBuffers) {
      for (const streamId of this.runStepBuffers.keys()) {
        if (!(await this.jobStore.hasJob(streamId))) {
          this.runStepBuffers.delete(streamId);
        }
      }
    }

    // Check eventTransport for orphaned streams (e.g., connections dropped without clean close)
    // These are streams that exist in eventTransport but have no corresponding job
    for (const streamId of this.eventTransport.getTrackedStreamIds()) {
      if (!(await this.jobStore.hasJob(streamId)) && !this.runtimeState.has(streamId)) {
        this.eventTransport.cleanup(streamId);
      }
    }

    if (runningJobsChanged) {
      this.syncRunningJobMetrics();
    }

    if (count > 0) {
      logger.debug(`[GenerationJobManager] Cleaned up ${count} expired jobs`);
    }
  }

  /**
   * Get stream info for status endpoint.
   */
  async getStreamInfo(streamId: string): Promise<{
    active: boolean;
    status: t.GenerationJobStatus;
    aggregatedContent?: Agents.MessageContentComplex[];
    createdAt: number;
  } | null> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return null;
    }

    const result = await this.jobStore.getContentParts(streamId, jobData.createdAt);
    const aggregatedContent = result?.content ?? [];

    return {
      active: jobData.status === 'running',
      status: jobData.status as t.GenerationJobStatus,
      aggregatedContent,
      createdAt: jobData.createdAt,
    };
  }

  /**
   * Get total job count.
   */
  async getJobCount(): Promise<number> {
    return this.jobStore.getJobCount();
  }

  /** Returns sizes of internal runtime maps for diagnostics */
  getRuntimeStats(): {
    runtimeStateSize: number;
    fencedRuntimeRetirements: number;
    runStepBufferSize: number;
    eventTransportStreams: number;
    earlyBufferedEvents: number;
    earlyBufferedBytes: number;
  } {
    let earlyBufferedEvents = 0;
    let earlyBufferedBytes = 0;
    for (const runtime of this.runtimeState.values()) {
      earlyBufferedEvents += runtime.earlyEventBuffer.length;
      earlyBufferedBytes += runtime.earlyEventBufferBytes;
    }
    return {
      runtimeStateSize: this.runtimeState.size,
      fencedRuntimeRetirements: this.fencedRuntimeRetirements.size,
      runStepBufferSize: this.runStepBuffers?.size ?? 0,
      eventTransportStreams: this.eventTransport.getTrackedStreamIds().length,
      earlyBufferedEvents,
      earlyBufferedBytes,
    };
  }

  /**
   * Get job count by status.
   */
  async getJobCountByStatus(): Promise<Record<t.GenerationJobStatus, number>> {
    const [running, complete, error, aborted, requires_action] = await Promise.all([
      this.jobStore.getJobCountByStatus('running'),
      this.jobStore.getJobCountByStatus('complete'),
      this.jobStore.getJobCountByStatus('error'),
      this.jobStore.getJobCountByStatus('aborted'),
      this.jobStore.getJobCountByStatus('requires_action'),
    ]);
    return { running, complete, error, aborted, requires_action };
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsForUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.jobStore.getActiveJobIdsByUser(userId, tenantId);
  }

  /** Returns every generation whose provider can still mutate user-owned data,
   * including a terminal generation whose controller is finishing trailing writes. */
  async getCleanupBlockingJobIdsForUser(userId: string, tenantId?: string): Promise<string[]> {
    const ownerQuery = this.jobStore.getCleanupJobIdsByUser;
    const readOwner = (tenant?: string) =>
      ownerQuery != null
        ? ownerQuery.call(this.jobStore, userId, tenant)
        : this.jobStore.getCleanupBlockingJobIdsByUser(userId, tenant);
    const [current, legacy, hostActions, detachedActions] = await Promise.all([
      readOwner(tenantId),
      tenantId == null ? [] : readOwner(),
      ownerQuery == null ? (this.jobStore.getTerminalHostActionJobs?.() ?? []) : [],
      ownerQuery == null
        ? (this.jobStore.getDetachedAgentEventTerminalHostActionJobs?.() ?? [])
        : [],
    ]);
    const pending = [...hostActions, ...detachedActions].filter(
      (job) =>
        job.userId === userId &&
        (!job.tenantId || job.tenantId === tenantId) &&
        job.terminalHostActionPending === true,
    );
    const streamIds = [...new Set([...current, ...legacy, ...pending.map((job) => job.streamId)])];
    const jobs = await Promise.all(streamIds.map((streamId) => this.jobStore.getJob(streamId)));
    return streamIds.filter((_, index) => {
      const job = jobs[index];
      return job?.userId === userId && (!job.tenantId || job.tenantId === tenantId);
    });
  }

  /** Also includes retained paused jobs whose checkpoints belong to this account. */
  async getAccountCleanupJobIdsForUser(userId: string, tenantId?: string): Promise<string[]> {
    const [retained, blocking] = await Promise.all([
      this.jobStore.getRetainedJobIdsByUser?.(userId, tenantId) ?? [],
      this.getCleanupBlockingJobIdsForUser(userId, tenantId),
    ]);
    return [...new Set([...retained, ...blocking])];
  }

  /** Resolves every cleanup-blocking run attached to any target conversation.
   * Remote API runs use response IDs as stream identities, so conversation
   * deletion cannot assume one stream per conversation. */
  async getCleanupBlockingJobIdsForConversations(
    userId: string,
    conversationIds: readonly string[],
    tenantId?: string,
  ): Promise<string[]> {
    if (conversationIds.length === 0) {
      return [];
    }
    const targets = new Set(conversationIds);
    const streamIds = await this.getCleanupBlockingJobIdsForUser(userId, tenantId);
    const jobs = await Promise.all(streamIds.map((streamId) => this.jobStore.getJob(streamId)));
    return streamIds.filter((_, index) => {
      const job = jobs[index];
      return job != null && job.userId === userId && targets.has(job.conversationId ?? '');
    });
  }

  private async finalizeOwnedJobsForShutdown(): Promise<void> {
    const ownedJobs = [...this.ownedJobs];
    if (ownedJobs.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      ownedJobs.map(async ([streamId, createdAt]) => {
        const job = await this.jobStore.getJob(streamId);
        if (!job || job.createdAt !== createdAt || job.status !== 'running') {
          return;
        }
        const runtime = this.runtimeState.get(streamId);
        if (
          runtime?.createdAt === createdAt &&
          runtime.allSubscribersLeftHandlers?.length &&
          runtime.lastSubscriberCleanupGeneration !== runtime.attachmentGeneration
        ) {
          runtime.lastSubscriberCleanupGeneration = runtime.attachmentGeneration;
          await this.persistSubscriberCleanup(streamId, runtime);
        }
        const claim = await this.claimTerminalJob(streamId, 'error', SHUTDOWN_JOB_ERROR, createdAt);
        if (claim == null) {
          return;
        }
        await this.finishTerminalJob(claim);
      }),
    );

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') {
        logger.error(
          `[GenerationJobManager] Failed to finalize owned job ${ownedJobs[index][0]} during shutdown:`,
          result.reason,
        );
      }
    }
    this.syncRunningJobMetrics();
  }

  /**
   * Stop accepting jobs and close only this process's attached SSE responses.
   *
   * This runs before HTTP drain. Durable finalization waits until post-drain, when only jobs
   * still owned by this process are atomically moved to a terminal state.
   */
  prepareForShutdown(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.cancelFencedRuntimeRetirements();

    for (const runtime of this.runtimeState.values()) {
      runtime.startupTelemetry?.end('aborted');
      runtime.startupTelemetry = undefined;
    }

    const streamIds = new Set([
      ...this.runtimeState.keys(),
      ...this.eventTransport.getTrackedStreamIds(),
    ]);
    for (const streamId of streamIds) {
      this.eventTransport.closeLocalSubscribers?.(streamId, SHUTDOWN_SUBSCRIBER_ERROR);
    }
  }

  /**
   * Destroy the manager.
   * Cleans up all resources including runtime state, buffers, and stores.
   */
  async destroy(options: { settlementBudgetMs?: number } = {}): Promise<void> {
    const settlementBudgetMs = Number.isFinite(options.settlementBudgetMs)
      ? Math.max(0, options.settlementBudgetMs as number)
      : SHUTDOWN_SETTLEMENT_FALLBACK_MS;
    /** Anchored here, not after subscriber cleanup: that cleanup is unbounded, and the caller's
     *  budget was measured against the force-exit timer that keeps running through it. */
    const settlementDeadline = Date.now() + settlementBudgetMs;
    this.shuttingDown = true;
    this.cancelFencedRuntimeRetirements();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const runtime of this.runtimeState.values()) {
      runtime.startupTelemetry?.end('aborted');
      runtime.startupTelemetry = undefined;
      this.stopSubscriberLease(runtime);
      this.releaseAbortSubscription(runtime, true);
      runtime.abortController.abort();
    }

    await this.drainSubscriberCleanups();
    await this.awaitGenerationSettlements(Math.max(0, settlementDeadline - Date.now()));
    await this.finalizeOwnedJobsForShutdown();
    await this.jobStore.destroy();
    this.eventTransport.destroy();
    /** Whatever the bounded wait left behind must not outlive this store: a later
     *  `configure()`/`initialize()` in the same process would otherwise wait a full budget
     *  on executions that can never drain. */
    this.releaseOpenProviderExecutions();
    this.runtimeState.clear();
    this.ownedJobs.clear();
    this.syncRunningJobMetrics();
    this.runStepBuffers?.clear();
    this.replayEventWriteQueues.clear();
    this.tokenUsageWriteQueues.clear();
    this.runStepWriteQueues.clear();
    this.earlyBufferOverflowWaiters.clear();

    logger.debug('[GenerationJobManager] Destroyed');
  }
}

export const GenerationJobManager: GenerationJobManagerClass = new GenerationJobManagerClass();
export { GenerationJobManagerClass };
