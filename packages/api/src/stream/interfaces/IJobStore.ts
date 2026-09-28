import type {
  IAgentEventActorContextMeta,
  ICompactionSemanticIndexProjection,
} from '@librechat/data-schemas';
import type {
  Agents,
  TFile,
  TPendingSteer,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type { RunStep, StandardGraph } from '@librechat/agents';
import type { AgentEventDetachedTerminalEvidence } from '~/agents/triggers/types';
import type { EarlyBufferOverflowState } from '../../types/earlyBufferRecovery';
import type { ActivityPhaseSnapshot } from '~/agents/activityPhases/runtime';
import type { ResolvedAskUserQuestion } from '~/agents/hitl/resume';
import type { RecoveredSteerPayload } from '../SteerRecovery';
import type { MCPRuntimeRequestBody } from '~/mcp/types';

/**
 * Detached Event Actor execution guarantee advertised by a generation store.
 *
 * `process_local` keeps the lifecycle coherent while this process is alive.
 * `distributed` additionally permits restart recovery and replica handoff.
 * Absence means the store cannot host detached Event Actor actions.
 */
export type DetachedAgentEventActionStoreMode = 'process_local' | 'distributed';

/**
 * Rewrites string-enum members to their literal values, recursively. The SDK and
 * data-provider declare nominally distinct enums (`ContentTypes`, `StepTypes`, ...)
 * with identical string values; erasing that nominality is what lets the two run-step
 * contracts be compared structurally.
 */
type WireShape<T> = T extends string
  ? `${T}`
  : T extends readonly (infer U)[]
    ? WireShape<U>[]
    : T extends object
      ? { [K in keyof T]: WireShape<T[K]> }
      : T;

type StaticAssert<T extends true> = T;

/**
 * Compile-time proof that the SDK run step and the wire contract (`Agents.RunStep`)
 * agree structurally once enum nominality is erased: any added, removed, retyped, or
 * newly optional SDK field fails these assertions, so drift cannot silently enter
 * resume state through `toWireRunSteps`.
 *
 * `summary.content` is the one deliberately unchecked field: the SDK reuses its full
 * `MessageContentComplex` union there, while the wire contract narrows it to the plain
 * text blocks summarization actually emits. That narrowing is the single semantic
 * judgment this conversion vouches for.
 */
type _WireRunStepContractHolds = StaticAssert<
  WireShape<Omit<RunStep, 'summary'>> extends WireShape<Omit<Agents.RunStep, 'summary'>>
    ? true
    : false
>;

type _WireSummaryContractHolds = StaticAssert<
  WireShape<Omit<NonNullable<RunStep['summary']>, 'content'>> extends WireShape<
    Omit<NonNullable<Agents.RunStep['summary']>, 'content'>
  >
    ? true
    : false
>;

/**
 * Run steps living on the SDK graph serialize to exactly the wire shape
 * `Agents.RunStep` describes; the assertion is safe because
 * `_WireRunStepContractHolds` above proves the contracts identical modulo the
 * nominally-split enums, which share their string values at runtime.
 */
export function toWireRunSteps(steps: readonly RunStep[]): Agents.RunStep[] {
  return steps as Agents.RunStep[];
}

/**
 * A pause owner has this long to durably persist the interrupted turn before
 * the barrier is considered abandoned. An abandoned barrier must fail closed:
 * exposing its action id again would let a resume drive history that may never
 * have reached the message database.
 */
export const PAUSE_PERSISTENCE_TIMEOUT_MS = 30_000;
export const PAUSE_PERSISTENCE_TIMEOUT_ERROR = 'Paused response persistence timed out';
/** Maximum time a terminal provider owner may remain undrained before its
 * process is treated as lost. Terminal host settlement retains the last
 * durable evidence through this grace period, then releases the lane from a
 * crashed owner instead of refreshing its fence forever. */
export const PROVIDER_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Job status enum.
 *
 * `requires_action` is non-terminal: the run has paused for human review
 * (e.g. tool approval) and is expected to be resumed by an approval route.
 * Stores must NOT cleanup `requires_action` jobs as if they were complete.
 */
export type JobStatus = 'running' | 'complete' | 'error' | 'aborted' | 'requires_action';

/** Immutable wire/storage contract selected when a generation is created.
 * Missing markers on pre-rollout records are interpreted as protocol v1. */
export type GenerationProtocolVersion = 1 | 2;

/** Read-only durable evidence, without attaching a runtime or recovering a slow save. */
export type GenerationSettlementState = Pick<
  SerializableJobData,
  'createdAt' | 'status' | 'terminalPersistencePending'
>;

/** Serializable job data without object references, suitable for external storage. */
export interface SerializableJobData {
  streamId: string;
  userId: string;
  tenantId?: string;
  status: JobStatus;
  createdAt: number;
  generationProtocolVersion?: GenerationProtocolVersion;
  /** Saver-level checkpoint scope for this exact generation. New jobs use a
   * globally unique opaque identity; LangGraph still sees an empty root
   * `checkpoint_ns`, which the saver adapter maps to this storage scope.
   * Legacy paused jobs omit it and use the historical unscoped storage. */
  checkpointNamespace?: string;
  completedAt?: number;
  conversationId?: string;
  error?: string;

  /** Durable, non-sensitive identity and one-shot outcome for an early replay
   * buffer overflow. This lets another replica account for recovery. */
  earlyBufferOverflow?: EarlyBufferOverflowState;

  /** Generation-level first subscriber claim shared across replicas. */
  firstSubscriberAttachedAt?: number;
  /** Expiring local subscriber-group leases (in-memory store only). */
  activeSubscriberLeases?: Record<string, number>;
  /** Generation-wide durable chunk frontier maintained by the store. */
  durableEventCount?: number;

  /** Stable identity of the HTTP submission that created this generation.
   * Internal-only: lets an expired idempotency lease recognize the same live
   * job instead of replacing and billing it again. */
  idempotencyClientRequestId?: string;

  /** Parked steer leased into this ordinary recovery turn. The source text is
   * hidden while this exact generation is active and consumed only after the
   * user message is durably persisted. */
  recoveredSteerId?: string;

  /** User message metadata */
  userMessage?: {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
    /** Quoted excerpts referenced on this turn, carried so resumable/aborted
     *  reconstructions of the user message keep their `MessageQuotes`. */
    quotes?: string[];
    /** Skill selections, carried so a HITL-resumed turn's requestMessage keeps its pills. */
    manualSkills?: string[];
    alwaysAppliedSkills?: string[];
    /** Uploaded files for the turn, carried so a HITL resume sources them from the job
     *  rather than a user DB row whose save can still be racing the approval prompt. */
    files?: unknown[];
  };

  /** Response message ID for reconnection */
  responseMessageId?: string;

  /** Whether this generation replaces an existing assistant branch. */
  isRegenerate?: boolean;
  /** Exact normalized MCP placeholder identity for this turn. */
  mcpRequestBody?: MCPRuntimeRequestBody;
  /** Exact assistant-message fields authored by the user during this running job. */
  userSubmittedPaths?: string[];
  /** Exact request-only message fields embedded at caller-authored paths. */
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];

  /**
   * Whether this run has activity labels enabled (per-endpoint
   * `activityLabel: true`). Set once at run start so the resume path can
   * decide whether to reconcile label gaps WITHOUT reading content — the
   * first label of a run can be claimed inside the snapshot->subscribe
   * window, so the snapshot itself is not a reliable signal.
   */
  activityLabels?: boolean;

  /**
   * Deferred-tool names discovered (via `tool_search`) before a HITL pause, captured
   * so a resume can replay them into `createRun` — the rebuilt graph uses `messages: []`
   * (state comes from the checkpoint), so without these the rebuilt model would lose
   * the discovered tool schemas.
   */
  discoveredTools?: string[];
  /** Bounded collector state for continuing a phase across HITL resume. */
  activityPhaseSnapshot?: ActivityPhaseSnapshot;
  /** Exact bounded compaction guidance captured atomically with a HITL pause. */
  compactionSemanticIndex?: ICompactionSemanticIndexProjection;
  /** Calibration and fading state captured atomically with a HITL pause, so a resume seeds its rebuilt pruner from the same tier. */
  contextMeta?: IAgentEventActorContextMeta;
  /**
   * Whether the replica that OWNS this generation can seal mid-stream
   * (`PreemptBoundary` wiring). Recorded at createJob because the steer route
   * may land on a different replica — during a rolling deploy its own SDK
   * probe would answer for the wrong process. Absent on jobs created before
   * preempt shipped, which reads as incapable: the honest outcome.
   */
  preemptCapable?: boolean;
  /**
   * Transient owner assertion that this replica's drain merges
   * `SteerQueueItem.quotes` into the injected turn. Never stored as-is:
   * createJob and `ApprovalLifecycle.resolve` translate it into
   * `steerQuotesExecutionId` bound to the asserting owner's execution.
   */
  steerQuotesCapable?: boolean;
  /**
   * The `providerExecutionId` of the owner that asserted quote capability.
   * Valid only while it equals the LIVE `providerExecutionId`: a legacy
   * replica winning a HITL resume rewrites the execution id but cannot know
   * this field, so its stale assertion self-invalidates — which a bare
   * boolean could not do (an old resume patch omits rather than clears it).
   * The fenced enqueue evaluates the equality atomically and strips
   * `item.quotes` on mismatch, keeping the persisted item and the
   * `quotesAccepted` echo honest; the client re-stages dropped excerpts.
   */
  steerQuotesExecutionId?: string;

  /** Explicitly false until the provider-owning replica has installed its
   * generation-fenced abort subscription. Missing is conservative legacy
   * evidence and must be treated like true by replacement handoff. */
  providerAbortReady?: boolean;

  /** Opaque identity of the currently executing provider segment. A HITL resume
   * replaces it so an earlier paused segment cannot acknowledge the new run. */
  providerExecutionId?: string;
  /** Durable evidence that the current provider owner crossed its start CAS.
   * Unlike `providerDrained`, this identity survives terminal drain so host
   * compensation can distinguish a projected-but-never-started resume. */
  providerExecutionStartedId?: string;
  /** False while the identified provider segment can still mutate user data;
   * true before provider startup and after the owner has fully unwound. */
  providerDrained?: boolean;

  /** Whether the user-message created event has been emitted */
  createdEventEmitted?: boolean;

  /** Sender name for UI display */
  sender?: string;

  /** Whether sync has been sent to a client */
  syncSent: boolean;

  /** Trusted schedule identity copied atomically into the generation job. */
  scheduleId?: string;
  scheduledFor?: string;
  scheduleConfigRevision?: number;
  scheduleManual?: boolean;
  /** Terminal outcome evidence retained when the schedule row could not be updated. */
  scheduleOutcome?: 'success' | 'error' | 'interrupted' | 'skipped_balance';
  scheduleOutcomeError?: string;
  preserveForScheduleReconcile?: boolean;
  /**
   * A terminal transition (currently approval expiry) still owes a durable host
   * lifecycle hook. Set atomically with that transition and cleared only once the host
   * adapter acknowledges success, so the job is retained (not reaped) and enumerable by
   * cleanup across restarts and replicas until the hook completes. Generic: a host with
   * no action clears it immediately on its no-op success, so nothing accumulates.
   */
  terminalHostActionPending?: boolean;
  /** Redis-only durable marker for a detached Event Actor completion hook.
   * Capable stores expose it through `terminalHostActionPending` as well, but
   * keep the persisted field distinct so legacy reconciliation cannot index or
   * claim the completion through the ordinary terminal-action lane. */
  detachedAgentEventTerminalHostActionPending?: boolean;
  /** Logical terminal state hidden behind a versioned fail-closed shell while
   * a detached Event Actor host action remains unacknowledged. */
  detachedAgentEventTerminalStatus?: Extract<JobStatus, 'complete' | 'aborted' | 'error'>;
  /**
   * Last time a cleanup pass enumerated this pending host action for retry. Retention is
   * measured from this rather than `completedAt`, so evidence survives as long as some
   * replica is still actively retrying the hook (e.g. Mongo unreachable for days), while a
   * deployment that stops retrying entirely still lets it age out instead of leaking.
   */
  terminalHostActionRefreshedAt?: number;

  /** Serialized final event for replay */
  finalEvent?: string;

  /** Abort won its terminal CAS but the route is still saving the partial
   * response / pruning HITL state. No normal terminal payload may be exposed
   * while true. */
  terminalPersistencePending?: boolean;
  /** Crash-recovery deadline basis for `terminalPersistencePending`. */
  terminalPersistenceStartedAt?: number;

  /** Serialized title event for replay during active-stream resume */
  titleEvent?: string;

  /** Serialized replay-only stream events for active-stream resume */
  replayEvents?: string;

  /** Serialized latest context usage snapshot for active-stream resume */
  contextUsage?: string;

  /** Serialized token usage events for active-stream resume (cross-replica safe) */
  tokenUsage?: string;

  /** Endpoint metadata for abort handling - avoids storing functions */
  endpoint?: string;
  iconURL?: string;
  model?: string;
  promptTokens?: number;

  /**
   * Agent that initiated the run. Persisted so a HITL resume can verify it rebuilds
   * the SAME agent that paused — resuming Agent A's checkpoint on Agent B's graph
   * would mis-execute the paused tool calls.
   */
  agent_id?: string;

  /**
   * Whether the originating turn was a temporary (non-persisted) chat. Persisted so
   * a HITL resume keeps the resumed response temporary instead of saving it — the
   * resume request can't be trusted to re-send the flag.
   */
  isTemporary?: boolean;
  /** Original server-authenticated retention deadline, serialized across replicas. */
  retentionExpiresAt?: string;
  agentEventDeliveryKey?: string;
  /** Original actor invocation when an internal completion delivery owns this generation. */
  agentEventInvocationKey?: string;
  /** Original actor invocation generation retained across completion HITL resumes. */
  agentEventInvocationGenerationCreatedAt?: number;
  /** This generation must resume on a durable detached-action producer. */
  agentEventDetachedActionProducerRequired?: boolean;
  /** Durable retry payload captured before detached terminal evidence is written to Mongo. */
  agentEventDetachedTerminalEvidence?: AgentEventDetachedTerminalEvidence;
  /** Trusted actor binding copied from the authenticated delivery envelope. */
  agentEventBindingId?: string;
  agentEventExpectedAction?: import('~/agents/triggers/types').AgentTriggerExpectedAction;
  /** Versioned pointer to the canonical signed Conversation suspension. */
  agentEventSuspension?: import('~/agents/triggers/types').AgentEventSuspensionProjection;
  /** Exact durable legacy-turn fence carried across a HITL pause/resume. */
  agentEventLegacyTurnToken?: string;

  /**
   * Set when status is `requires_action`. Describes the human review the
   * run is waiting on. Cleared by the resume path before the job returns to `running`.
   */
  pendingAction?: Agents.PendingAction;

  /** Durable bridge between the resume claim and content reconstruction. An
   * abort can win while the resume controller is still rebuilding the client;
   * retaining the accepted answer here lets that terminal owner stamp it onto
   * the persisted partial response instead of losing it with the request. */
  resolvedAskUserQuestions?: ResolvedAskUserQuestion[];

  /**
   * Flat mirror of `pendingAction.actionId`, kept as a top-level field so an
   * atomic status transition can guard on it (a nested JSON field can't be
   * compared inside a Redis Lua CAS). Lets `resolve`/`expire` reject a stale
   * decision that targets a different action than the one currently pending.
   */
  pendingActionId?: string;

  /**
   * Liveness basis for the stale-running failsafe, refreshed when a paused job
   * is resumed. Without it, cleanup keys off `createdAt`, so an approval that
   * sat in `requires_action` past the running window would be reaped on the
   * next tick right after resuming. Falls back to `createdAt` when unset.
   */
  lastActiveAt?: number;

  /**
   * Flat flag set by the terminal close-and-drain (Redis: raw hash field the
   * enqueue Lua guards on; in-memory: a parallel set). Once set, new steers
   * are rejected until `createJob` reuses the stream id. Never written through
   * `updateJob` — listed here so cleanup paths can reference the key name.
   */
  steersClosed?: boolean;
}

/** Exact active hash replaced by one atomic job creation. Built-in stores keep
 * this as non-enumerable transaction metadata; Redis also retains a private
 * receipt in the replacement hash so a committed create with a lost reply can
 * reconstruct it without exposing it through normal job serialization. */
export type ReplacedGeneration = Pick<
  SerializableJobData,
  | 'createdAt'
  | 'status'
  | 'conversationId'
  | 'providerAbortReady'
  | 'providerExecutionId'
  | 'providerDrained'
>;

/** Latest generation epoch checked by a conditional create. A retained epoch
 * can outlive its job hash, so inactive mismatches intentionally omit job-only
 * metadata while still telling the caller which generation won the race.
 * When all predecessor evidence has expired, `createdAt` safely echoes the
 * caller's finite expected epoch and `verified` is false; the create is still
 * rejected, but response consumers can preserve the queued turn without
 * mistaking that fallback for an observed generation. */
export type GenerationPredecessorState = Pick<SerializableJobData, 'createdAt'> &
  Partial<Pick<SerializableJobData, 'status' | 'conversationId'>> & {
    active: boolean;
    /** False only when neither the job nor its retained epoch was observable.
     * Missing values are compatible with pre-marker mismatch producers. */
    verified?: boolean;
  };

export interface CreatedJobData extends SerializableJobData {
  /** The predecessor observed inside the same transaction that installed this
   * job. Non-enumerable in the built-in stores to keep it out of serializers. */
  replacedJob?: ReplacedGeneration;
  /** Transitive transaction receipts inherited from replacements whose
   * managers may have lost their create replies. Ordered oldest to newest. */
  replacedJobs?: readonly ReplacedGeneration[];
  /** Opaque manager-minted proof for one create invocation. Non-enumerable in
   * built-in stores and used only to reconcile a commit whose reply was lost. */
  creationAttemptId?: string;
}

/** The store installed a generation, but another creator replaced it before
 * cross-slot membership reconciliation completed. The exact predecessor
 * metadata still has to reach the manager so its owner is stopped/notified. */
export class JobCreationSupersededError extends Error {
  constructor(readonly createdJob: CreatedJobData) {
    super('Generation job was replaced during creation');
    this.name = 'JobCreationSupersededError';
  }
}

/** A conditional create observed a different current generation than the
 * caller's last authoritative status read. The store rejects before replacing
 * that generation, so queued client work can be restored safely. */
export class JobPredecessorMismatchError extends Error {
  readonly code = 'GENERATION_PREDECESSOR_MISMATCH';

  constructor(readonly currentJob: GenerationPredecessorState) {
    super('Generation predecessor changed before creation');
    this.name = 'JobPredecessorMismatchError';
  }
}

export type JobMetadataPatch = Partial<
  Pick<
    SerializableJobData,
    | 'responseMessageId'
    | 'isRegenerate'
    | 'mcpRequestBody'
    | 'userSubmittedPaths'
    | 'userSubmittedMessageFieldPaths'
    | 'sender'
    | 'conversationId'
    | 'userMessage'
    | 'endpoint'
    | 'iconURL'
    | 'model'
    | 'agent_id'
    | 'isTemporary'
    | 'retentionExpiresAt'
    | 'agentEventDeliveryKey'
    | 'agentEventInvocationKey'
    | 'agentEventInvocationGenerationCreatedAt'
    | 'agentEventDetachedActionProducerRequired'
    | 'agentEventDetachedTerminalEvidence'
    | 'agentEventBindingId'
    | 'agentEventExpectedAction'
    | 'agentEventSuspension'
    | 'agentEventLegacyTurnToken'
    | 'scheduleId'
    | 'scheduledFor'
    | 'scheduleConfigRevision'
    | 'scheduleManual'
    | 'scheduleOutcome'
    | 'scheduleOutcomeError'
    | 'preserveForScheduleReconcile'
    | 'promptTokens'
    | 'discoveredTools'
    | 'activityPhaseSnapshot'
    | 'compactionSemanticIndex'
    | 'contextMeta'
    | 'preemptCapable'
    | 'steerQuotesCapable'
    | 'steerQuotesExecutionId'
    | 'providerExecutionId'
    | 'providerDrained'
    | 'generationProtocolVersion'
    | 'resolvedAskUserQuestions'
  >
>;

/**
 * Whether a job's pending review has passed its `expiresAt`. Shared by the
 * stores so an expired approval is kept out of active-job listings (the client
 * stops polling; cleanup/expiry finalizes it).
 */
export function isPendingActionExpired(job: Pick<SerializableJobData, 'pendingAction'>): boolean {
  const exp = job.pendingAction?.expiresAt;
  return exp != null && exp <= Date.now();
}

/**
 * Whether a `requires_action` job has no live, resolvable prompt — either the
 * pendingAction is missing/malformed (e.g. dropped on deserialize) or past its
 * `expiresAt`. Such a job can't be rendered or resolved, so it must be kept out
 * of active listings and finalized by cleanup rather than left stuck active.
 */
export function isPendingActionStale(job: Pick<SerializableJobData, 'pendingAction'>): boolean {
  return !job.pendingAction || isPendingActionExpired(job);
}

/**
 * A user steering message queued for mid-run injection. Enqueued by the steer
 * route on any instance; drained FIFO by the owning process's run-scoped
 * PostToolBatch hook at the next tool-batch boundary.
 */
export interface SteerQueueItem {
  steerId: string;
  /** Client-generated correlation id. It lets a terminal event that beats the
   *  202 ACK match the server item to its optimistic local chip. */
  clientSteerId?: string;
  text: string;
  userId: string;
  createdAt: number;
  /** Attachment refs steered with the message. Display metadata only — the
   *  drain re-fetches each file by id scoped to the run's user and encodes
   *  fresh, so nothing here is trusted beyond identifying the file. */
  files?: Partial<TFile>[];
  /** Quoted excerpts steered with the message, normalized at admission
   *  (`getReferencedQuotes`). Kept separate from `text` so the persisted
   *  steer part stays clean; merged into the model-bound turn at injection. */
  quotes?: string[];
  /** The steer asked to seal the live model stream at the next provider-safe
   *  boundary instead of waiting for a tool step. Durable so a parked,
   *  claimed, or replayed chip keeps its "interrupting" label. */
  preempt?: boolean;
  /** Monotonic per-steer arm revision. A capability downgrade increments it
   * so an older cross-replica arm cannot resurrect after the disarm, while a
   * later explicit arm with a newer revision remains valid. */
  preemptRevision?: number;
}

/** Durable acknowledgement keyed by `clientSteerId`. It outlives the queue
 * and live job for a bounded window so a lost 202 cannot make Retry inject
 * the same instruction twice after drain, terminal cleanup, or replacement. */
export interface SteerReceipt {
  clientSteerId: string;
  /** Quote-INDEPENDENT content hash (text/files/preempt) — the one shape every
   * replica version computes, so lost-ACK retries replay across a rolling
   * deploy in both directions. */
  fingerprint: string;
  /** Identity of the REQUESTED quotes (pre any owner-capability strip),
   * recorded beside the fingerprint so quote-aware readers enforce quote
   * identity without making the fingerprint unreadable to legacy admission.
   * Absent on receipts written by pre-quotes replicas or for quote-less
   * requests. */
  requestedQuotesFingerprint?: string;
  userId: string;
  tenantId?: string;
  agentId?: string;
  endpoint?: string;
  /** Generation epoch that accepted the item. Receipts intentionally survive
   * replacement, so queue absence is only "delivered" while this exact
   * generation remains active; a newer epoch means the predecessor dropped
   * an undrained item and the client must recover it as a leftover. */
  generationCreatedAt: number;
  item: SteerQueueItem;
  position: number;
  /** `claimed` is the crash-recoverable window between an atomic queue drain
   * and the durable applied-content record. It is not settled: a live client
   * keeps the chip pending, and a dead/replaced generation repairs it to a
   * leftover instead of silently dropping the instruction. */
  /** `recovered` means one recovery surface already claimed a leftover. A
   * later retry is settled without re-queuing the same follow-up. */
  state: 'queued' | 'claimed' | 'delivered' | 'leftover' | 'recovered' | 'cancelled';
}

export type SteerReceiptInput = Omit<SteerReceipt, 'item' | 'position' | 'state'>;
export type SteerEnqueueReceiptResult = SteerReceipt | SteerEnqueueResult | number;

/** Capability-normalized atomic enqueue result for callers without a stable
 * client receipt id (legacy/API compatibility path). */
export interface SteerEnqueueResult {
  item: SteerQueueItem;
  position: number;
}

export type TerminalSteerAdmissionResult =
  | { outcome: 'claimed'; items: SteerQueueItem[] }
  | { outcome: 'open' | 'sealed' | 'unavailable' };

export interface TerminalSteerAdmissionPolicy {
  allowClaim: boolean;
  keepOpenWhenEmpty: boolean;
}

export type SteerEnqueueVersionedResult = SteerEnqueueResult | number;

/**
 * Cross-replica preempt signal. Unlike abort this does NOT stop the run — it
 * asks the generating replica to seal its current model stream at the next
 * provider-safe boundary so the queued steer can inject there. Fenced by
 * `createdAt`: a stale publish must never arm a replacement job on the same
 * streamId.
 */
export interface PreemptMessage {
  op: 'arm' | 'clear';
  /** Generation identity (`SerializableJobData.createdAt`) this belongs to. */
  createdAt: number;
  steerIds: string[];
  /** Per-id arm revision. Omitted by legacy senders (treated as revision 0). */
  revisions?: Record<string, number>;
}

/** {@link IJobStoreV2.armSteer}: `armed` flipped the flag in place; `missing`
 *  covers every unavailable interleaving (paused, drained, cancelled, closed,
 *  replaced generation); `incapable` means the live owner cannot seal. */
export type SteerArmOutcome = 'armed' | 'missing' | 'incapable';

export interface SteerArmResult {
  outcome: SteerArmOutcome;
  /** Present only for an armed item. */
  revision?: number;
  item?: SteerQueueItem;
}

/** Maximum steers a single run can have queued at once. */
export const STEER_QUEUE_MAX_DEPTH = 10;

/** `enqueueSteer` rejection: the job is missing or not `running`. */
export const STEER_ENQUEUE_NOT_RUNNING = -1;

/** `enqueueSteer` rejection: the queue is at {@link STEER_QUEUE_MAX_DEPTH}. */
export const STEER_ENQUEUE_QUEUE_FULL = -2;

/** `enqueueSteerWithReceipt` rejection: the bounded, unexpired receipt
 * history is full. Existing ids still replay; only a new identity is refused
 * so idempotency evidence is never evicted inside its recovery window. */
export const STEER_ENQUEUE_RECEIPT_FULL = -3;

/** The store rejected a status CAS because its atomic deadline had elapsed. */
export class JobStatusTransitionDeadlineError extends Error {
  readonly notAfterMs: number;

  constructor(notAfterMs: number) {
    super('The status transition deadline elapsed before the transition could commit');
    this.name = 'JobStatusTransitionDeadlineError';
    this.notAfterMs = notAfterMs;
  }
}

/**
 * Arguments for an atomic {@link IJobStore.transitionStatus} compare-and-set.
 */
export interface JobStatusTransition {
  /** Only fire the transition if the job is currently in this status. */
  from: JobStatus;
  /** Status to move to when the `from` guard holds. */
  to: JobStatus;
  /** Fields written in the same atomic step as the status change. */
  patch?: Partial<SerializableJobData>;
  /** Field names removed in the same atomic step (e.g. `pendingAction`). */
  clear?: Array<keyof SerializableJobData & string>;
  /**
   * Additional guard: only fire if the job's `pendingActionId` equals this.
   * Checked atomically alongside the `from` status so a stale decision can't
   * resolve a job that has since paused for a different action.
   */
  expectActionId?: string;
  /**
   * Additional guard: only fire if the job's creation epoch equals this value.
   * Prevents a stale owner from transitioning a replacement job that reuses
   * the same stream ID.
   */
  expectCreatedAt?: number;
  /**
   * Additional guard: reject the transition when the store's clock has reached
   * this absolute deadline. The comparison is part of the same atomic operation
   * as the status change, so queueing or storage latency cannot publish stale state.
   */
  notAfterMs?: number;
  /** Extend all current steer receipts in the SAME atomic step as this
   * transition. Used by running→requires_action so no enqueue can land between
   * a pre-pause TTL pass and the status CAS. */
  steerReceiptTtlSeconds?: number;
}

/** Value stored under an idempotency claim: the stream a retried request should attach to. */
export interface IdempotencyClaimValue {
  streamId: string;
  conversationId: string;
  /** Wire/storage protocol selected by the request that first won this claim.
   * Missing values are legacy v1. Keeping the marker in both idempotency
   * tombstones lets a retry recover the original contract after its job hash
   * has already been cleaned up. */
  generationProtocolVersion?: GenerationProtocolVersion;
  /** Epoch ms the claim was written — lets a losing duplicate tell a winner that is still
   *  starting (recent, no job yet → retry) from one that already finished and was cleaned
   *  up (old, no job → attach and let the client refetch). */
  claimedAt?: number;
  /** Lease owner verified atomically by createJob; stale-request takeover
   * changes it so the abandoned winner can no longer create a generation. */
  claimToken?: string;
  /** Proof that a takeover token was derived by CAS from this predecessor.
   * If a connection drops after the primary CAS but before the legacy CAS,
   * the next replica can finish only that exact, same-coordinate split rather
   * than treating an arbitrary token mismatch as repairable. */
  previousClaimToken?: string;
  /** Written atomically with job creation. Once present, a missing job is an
   * already-started/cleaned generation and can never be taken over as an
   * abandoned pre-create lease. */
  startedAt?: number;
}

/** Result of an atomic {@link IJobStore.claimIdempotencyKey} attempt. */
export interface IdempotencyClaimResult {
  /** True when this caller won the claim and should create the job. */
  claimed: boolean;
  /** When `claimed` is false, the stream the original request is already driving. */
  existing?: IdempotencyClaimValue;
  /** The durable namespace that established the result. Manager-level claims
   * use `legacy` only for an old, tokenless claim that must remain
   * duplicate-only during a rolling upgrade. Store implementations may omit
   * this field because they operate on one physical key at a time. */
  source?: 'primary' | 'legacy';
}

/** Owner-authorized parked recovery payload plus the protocol that controls
 * its delivery semantics. V1 is destructive (legacy GETDEL); v2 is leased. */
export interface ParkedSteerClaim {
  payload: string;
  generationProtocolVersion: GenerationProtocolVersion;
}

/**
 * Usage metadata for token spending across different LLM providers.
 *
 * This interface supports two mutually exclusive cache token formats:
 *
 * **OpenAI format** (GPT-4, o1, etc.):
 * - Uses `input_token_details.cache_creation` and `input_token_details.cache_read`
 * - Cache tokens are nested under the `input_token_details` object
 *
 * **Anthropic format** (Claude models):
 * - Uses `cache_creation_input_tokens` and `cache_read_input_tokens`
 * - Cache tokens are top-level properties
 *
 * When processing usage data, check both formats:
 * ```typescript
 * const cacheCreation = usage.input_token_details?.cache_creation
 *   || usage.cache_creation_input_tokens || 0;
 * ```
 */
export interface UsageMetadata {
  /** Logical usage bucket for accounting/reporting. Defaults to model response usage. */
  usage_type?: 'message' | 'summarization' | 'subagent' | 'sequential';
  /** Total input tokens (prompt tokens) */
  input_tokens?: number;
  /** Total output tokens (completion tokens) */
  output_tokens?: number;
  /** Total billed tokens when provided by the model/runtime */
  total_tokens?: number;
  /** Model identifier that generated this usage */
  model?: string;
  /** Provider identifier that generated this usage */
  provider?: string;
  /** Agent that produced this usage (graph agent id / subagent agent id). Lets
   *  multi-endpoint graphs price each call with its own endpoint token config. */
  agentId?: string;
  /** Authoritative display cost attached by the host before durable child persistence. */
  cost?: number;
  /**
   * OpenAI-style cache token details.
   * Present for OpenAI models (GPT-4, o1, etc.)
   */
  input_token_details?: {
    /** Tokens written to cache */
    cache_creation?: number;
    /** Tokens read from cache */
    cache_read?: number;
    /** OpenAI GPT-5.6+ cache-write tokens (billed above the input rate) */
    cache_write_tokens?: number;
  };
  /**
   * Anthropic-style cache creation tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_creation_input_tokens?: number;
  /**
   * OpenAI GPT-5.6+ cache-write tokens, reported at the top level of
   * `prompt_tokens_details`/`input_tokens_details`. Distinct from cached
   * (read) tokens and billed at a premium over the input rate.
   */
  cache_write_tokens?: number;
  /**
   * Anthropic-style cache read tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_read_input_tokens?: number;
  /**
   * Breakdown of output token counts. Per the LangChain core contract,
   * `output_tokens` is the sum of all output token types — these fields
   * are subsets of `output_tokens`, *not* additional charges.
   */
  output_token_details?: {
    /** Reasoning/thinking tokens generated as chain-of-thought (o1, Gemini thinking, etc.) */
    reasoning?: number;
    /** Alternate provider/runtime alias for reasoning tokens. */
    reasoning_tokens?: number;
    audio?: number;
  };
}

/**
 * Result returned from aborting a job - contains all data needed
 * for token spending and message saving without storing callbacks
 */
export interface AbortResult {
  /** Whether the abort was successful */
  success: boolean;
  /** Why the abort did not land. EVERY `success: false` return carries one, so a
   * caller can separate a generation it must not settle (`generation_replaced`,
   * `job_not_found`) from one that is still live (`job_still_active`) and from one
   * that had already reached a terminal state (`already_settled` — the provider has
   * also drained when `awaitProviderDrain` was requested). The ABSENCE of this field
   * is not a stop confirmation; use `isStopConfirmed`. */
  failureReason?: 'generation_replaced' | 'job_still_active' | 'job_not_found' | 'already_settled';
  /** The generation was stopped, but the caller's required durable side
   * effects failed before normal FINAL publication. The manager emitted a
   * conservative reconciliation frame instead. */
  persistenceFailed?: boolean;
  /** The job data at time of abort */
  jobData: SerializableJobData | null;
  /** Aggregated content from the stream */
  content: Agents.MessageContentComplex[];
  /** Final event to send to client */
  finalEvent: unknown;
  /** Concatenated text from all content parts for token counting fallback */
  text: string;
  /** Collected usage metadata from all models for token spending */
  collectedUsage: UsageMetadata[];
  /** Steers drained at abort time (never injected); surfaced to the client for restore */
  pendingSteers?: TPendingSteer[];
}

/**
 * Canonical "did this generation actually stop?" predicate — one definition shared by
 * every caller that settles durable state on the answer (schedule outcomes, checkpoint
 * pruning, capacity release).
 *
 * A landed abort confirms the stop. So does `already_settled`: the generation reached a
 * terminal state on its own and, when the caller asked for `awaitProviderDrain`, its
 * provider segment has drained, so nothing can still write. Every OTHER failure leaves a
 * generation that is either still live (`job_still_active`), owned by someone else
 * (`generation_replaced`), or unobservable from here without a drain (`job_not_found`) —
 * none of which may be settled on.
 */
export function isStopConfirmed(result: AbortResult | null | undefined): boolean {
  return result != null && (result.success === true || result.failureReason === 'already_settled');
}

/**
 * Resume state for reconnecting clients
 */
export interface ResumeState {
  runSteps: Agents.RunStep[];
  aggregatedContent: Agents.MessageContentComplex[];
  userMessage?: SerializableJobData['userMessage'];
  responseMessageId?: string;
  conversationId?: string;
  sender?: string;
  iconURL?: string;
  model?: string;
  titleEvent?: {
    event: 'title';
    data?: {
      conversationId?: string;
      title?: string;
    };
  };
  replayEvents?: Array<{
    event: string;
    data?: unknown;
    [key: string]: unknown;
  }>;
  /** Pending MCP authorization prompts projected from durable stream state. */
  pendingOAuthPrompts?: Agents.PendingMCPOAuthPrompt[];
}

/**
 * Backward-compatible public job-store contract.
 *
 * This is the pre-v2 extension surface kept for third-party stores compiled
 * against earlier `@librechat/api` releases. The generation manager validates
 * the additional {@link IJobStoreV2} capabilities before accepting a custom
 * store at runtime.
 */
export interface IJobStore {
  readonly detachedAgentEventActionStoreMode?: DetachedAgentEventActionStoreMode;

  initialize(): Promise<void>;

  createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    initialMetadata?: JobMetadataPatch,
  ): Promise<SerializableJobData>;

  getJob(streamId: string): Promise<SerializableJobData | null>;
  updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedCreatedAt?: number,
  ): Promise<void>;
  transitionStatus(streamId: string, args: JobStatusTransition): Promise<boolean>;

  claimIdempotencyKey(
    key: string,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<IdempotencyClaimResult>;
  releaseIdempotencyKey(key: string): Promise<void>;

  /** Read-only existence probe used to identify a confirmed retry before
   * request-rate admission. Optional stores keep the conservative behavior
   * where every request remains subject to the limiter. */
  hasIdempotencyKey?(key: string): Promise<boolean>;

  /** Read-only claim receipt used by durable source reconcilers. Optional
   * stores fall back to inspecting the current generation only. */
  getIdempotencyClaim?(key: string): Promise<IdempotencyClaimValue | null>;

  deleteJob(streamId: string, expectedCreatedAt?: number): Promise<boolean>;
  hasJob(streamId: string): Promise<boolean>;
  getRunningJobs(): Promise<SerializableJobData[]>;
  /** Optional durable paused-job enumeration. Built-in stores implement it so
   * the manager can own approval expiry even after the original runtime died. */
  getRequiresActionJobs?(): Promise<SerializableJobData[]>;
  /** Optional durable enumeration of terminal jobs that still owe a host lifecycle
   * hook (see `terminalHostActionPending`). Built-in stores implement it so cleanup can
   * retry the host adapter after a restart / on another replica, even though the job is
   * no longer in the requires_action index. */
  getTerminalHostActionJobs?(): Promise<SerializableJobData[]>;
  /** Enumerates detached Event Actor completion generations from a versioned
   * retry lane known only to capable consumers. Redis keeps this lane separate
   * from `getTerminalHostActionJobs` so a rolling-deployment replica that only
   * understands the legacy job identity can never claim it. */
  getDetachedAgentEventTerminalHostActionJobs?(): Promise<SerializableJobData[]>;
  /** Clears the pending-host-action marker once the adapter acknowledges success.
   * Identity-fenced on `expectedCreatedAt` so a replacement generation at the same
   * streamId is never cleared through its predecessor. */
  clearTerminalHostAction?(streamId: string, expectedCreatedAt?: number): Promise<void>;
  cleanup(): Promise<number>;
  recordActivity?(streamId: string, expectedCreatedAt?: number): void;
  getJobCount(): Promise<number>;
  getJobCountByStatus(status: JobStatus): Promise<number>;
  destroy(): Promise<void>;
  getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]>;

  /** Complete owner cleanup query, including terminal host work and legacy-index recovery.
   * Managers retain the global-index fallback for older third-party stores. */
  getCleanupJobIdsByUser?(userId: string, tenantId?: string): Promise<string[]>;

  /** Enumerates every extant job in the owner's retained index, including a
   * stale paused generation that account deletion must erase before its worker
   * finalizes it. Optional custom stores fall back to cleanup-blocking jobs. */
  getRetainedJobIdsByUser?(userId: string, tenantId?: string): Promise<string[]>;
  setGraph(streamId: string, graph: StandardGraph, expectedCreatedAt?: number): void;
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): void;
  getContentParts(
    streamId: string,
    expectedCreatedAt?: number,
    options?: { durableOnly?: boolean },
  ): Promise<{
    content: Agents.MessageContentComplex[];
    reconstructedEventCount?: number;
    durableEventCount?: number;
  } | null>;

  getRunSteps(streamId: string, expectedCreatedAt?: number): Promise<Agents.RunStep[]>;

  /** Legacy stores returned `void`; v2 stores return whether the epoch-fenced
   * append committed. Accept both here so existing implementations remain
   * source-compatible. */
  appendChunk(
    streamId: string,
    event: unknown,
    expectedCreatedAt?: number,
  ): Promise<void | boolean>;

  /** Optional batching capability: persist any coalesced appends buffered for
   * this stream now. Stores without append coalescing simply omit it. */
  flushPendingAppends?(streamId: string): Promise<void>;

  clearContentState(streamId: string, expectedCreatedAt?: number): void;
  saveRunSteps?(
    streamId: string,
    runSteps: Agents.RunStep[],
    expectedCreatedAt?: number,
  ): Promise<void>;
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    expectedCreatedAt?: number,
  ): void;
  getCollectedUsage(streamId: string, expectedCreatedAt?: number): UsageMetadata[];

  enqueueSteer(streamId: string, item: SteerQueueItem, expectedCreatedAt?: number): Promise<number>;
  drainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;
  closeAndDrainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;
  peekSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;
  removeSteer(streamId: string, steerId: string): Promise<boolean>;
  parkSteers(streamId: string, payload: string, expectedCreatedAt?: number): Promise<void>;
  claimParkedSteers(streamId: string, ownerFragment: string): Promise<string | undefined>;
  clearSteers(streamId: string): Promise<void>;
}

/**
 * Full store contract required by the current generation runtime.
 *
 * Built-in stores implement this interface. Its overrides deliberately narrow
 * the legacy return types while its extra methods provide the atomicity needed
 * for terminal ownership, durable steering receipts, recovery, and idempotent
 * generation startup.
 */
export interface IJobStoreV2 extends IJobStore {
  /** Initialize the store (e.g., connect to Redis, start cleanup intervals) */
  initialize(): Promise<void>;

  /** Create a new job */
  createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    initialMetadata?: JobMetadataPatch,
    recoveredSteerId?: string,
    idempotencyClaimKey?: string,
    idempotencyClaimToken?: string,
    idempotencyClientRequestId?: string,
    recoveredSteerPayload?: RecoveredSteerPayload,
    creationAttemptId?: string,
    expectedPredecessorCreatedAt?: number,
    rejectActivePredecessor?: boolean,
  ): Promise<CreatedJobData>;

  /** Remove transaction-time predecessor receipts after their handoff was
   * delivered. The current creation attempt id fences a late acknowledgement
   * from clearing receipts inherited by a replacement. */
  acknowledgeReplacedJobs?(
    streamId: string,
    creationAttemptId: string,
    replacedCreatedAts: readonly number[],
  ): Promise<boolean>;

  /** Get a job by streamId (streamId === conversationId) */
  getJob(streamId: string): Promise<SerializableJobData | null>;

  /**
   * Update job data. When `expectedCreatedAt` is supplied, apply the write only
   * if the stream still belongs to that generation.
   */
  updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedCreatedAt?: number,
  ): Promise<void>;

  /** Atomically marks only the exact provider segment as fully unwound. */
  markProviderExecutionDrained(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean>;

  /** Activates the provider only while its exact generation is still running. */
  beginProviderExecution(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean>;

  /** Includes terminal jobs whose provider still owns user-data writes. */
  getCleanupBlockingJobIdsByUser(userId: string, tenantId?: string): Promise<string[]>;

  /** Atomically replaces an abort persistence-pending marker with the one
   * terminal payload that late subscribers may consume. Exactly one of the
   * owner, its failure path, or stale-owner recovery wins. */
  finalizeTerminalPersistence(
    streamId: string,
    expectedCreatedAt: number,
    finalEvent: string,
  ): Promise<boolean>;

  /**
   * Atomically transition a job's status, **only if** it is currently `from`.
   * Returns `true` when the transition fired, `false` when the job was missing
   * or no longer in `from` (lost a race / illegal transition).
   *
   * `patch` fields are written and `clear` fields removed in the same atomic
   * step, and the running / requires_action membership sets plus live-key TTLs
   * are reconciled to match `to`. This is the race-safe primitive behind the
   * approval lifecycle — it prevents two concurrent resumes from both driving a
   * paused run (a double-drive would re-execute tools / double-bill).
   *
   * Distinct from {@link updateJob}, which writes status unconditionally for
   * callers that don't know the prior state. Reach for `transitionStatus`
   * whenever the legal prior state is known.
   *
   * Atomicity: fully atomic on in-memory and single-node / sentinel Redis
   * (Lua). On Redis Cluster the status guard is best-effort — the membership
   * sets live on a different hash slot from the job hash — matching the store's
   * existing cluster posture for status writes.
   */
  transitionStatus(streamId: string, args: JobStatusTransition): Promise<boolean>;

  /**
   * Terminal variant of {@link transitionStatus} that atomically captures and
   * parks every queued/claimed steer owned by the winning generation. `null`
   * means the status CAS lost; an array (including an empty one) means it won.
   *
   * Abort uses this primitive so it can include exact leftovers in its final
   * event without destructively draining a run before terminal ownership is
   * established.
   */
  transitionStatusAndDrainSteers(
    streamId: string,
    args: JobStatusTransition,
  ): Promise<SteerQueueItem[] | null>;

  /**
   * Atomically claim an idempotency key so a retried start-generation request
   * attaches to the original stream instead of starting a second billed
   * generation. The first caller gets `{ claimed: true }` and should create the
   * job; a later caller for the same key gets `{ claimed: false, existing }`
   * carrying the stream the original request is already driving.
   *
   * Atomicity: single-key `SET NX` on Redis (one hash slot, cluster-safe) /
   * check-and-set on the single-threaded in-memory store.
   *
   * @param key - Caller-scoped key, e.g. `${userId}:${clientRequestId}`.
   * @param value - The stream a duplicate request should attach to.
   * @param ttlSeconds - Claim lifetime; outlive the generation so a late retry still dedups.
   */
  claimIdempotencyKey(
    key: string,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<IdempotencyClaimResult>;

  /** Compare-and-swap an abandoned pre-create claim. */
  takeoverIdempotencyKey(
    key: string,
    expected: IdempotencyClaimValue,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<boolean>;

  /** Mark a token-owned claim as having created its generation. Used by the
   * rolling-upgrade bridge to tombstone the legacy key after the same-slot
   * primary key was committed by createJob. */
  markIdempotencyKeyStarted(
    key: string,
    claimToken: string,
    startedAt: number,
    ttlSeconds: number,
  ): Promise<boolean>;

  /** Atomically attach a freshly reacquired claim to the still-live job that
   * was created by the same client request. The job and claim keys share a
   * Redis hash slot, so a replacement cannot cross this validation. */
  adoptIdempotencyKeyForJob(
    key: string,
    expected: IdempotencyClaimValue,
    streamId: string,
    userId: string,
    clientRequestId: string,
    tenantId: string | undefined,
    expectedCreatedAt: number,
    ttlSeconds: number,
    /** A pre-bridge job has no durable request id. This mode may tombstone a
     * freshly reacquired claim against that exact active owner/epoch, but must
     * still reject every different non-empty request id. */
    allowMissingClientRequestId?: boolean,
  ): Promise<boolean>;

  /**
   * Release a previously-claimed idempotency key so the submission can be retried
   * (e.g. the start failed before generation began). No-op if the key is absent.
   */
  releaseIdempotencyKey(key: string, expected?: IdempotencyClaimValue): Promise<void>;

  /**
   * Delete a job, optionally only when the stream still belongs to the expected
   * generation. Returns true only when a matching job was actually deleted.
   */
  deleteJob(streamId: string, expectedCreatedAt?: number): Promise<boolean>;

  /** Check if job exists */
  hasJob(streamId: string): Promise<boolean>;

  /** Get all running jobs (for cleanup) */
  getRunningJobs(): Promise<SerializableJobData[]>;

  /** Get durable paused jobs so approval expiry is not process-runtime-dependent. */
  getRequiresActionJobs?(): Promise<SerializableJobData[]>;

  /** Cleanup expired jobs */
  cleanup(): Promise<number>;

  /**
   * Record generation activity for a job (e.g. a chunk was emitted), refreshing
   * its "last active" timestamp so the stale-running-job failsafe does not reap a
   * stream that is still producing output.
   *
   * In-memory: updates an internal last-activity timestamp used by cleanup().
   * Redis: no-op — the running-job TTL is already refreshed on each appendChunk.
   *
   * @param streamId - The stream identifier
   * @param expectedCreatedAt - Optional generation identity. When supplied, replacement activity
   *   is not refreshed by a stale emitter.
   */
  recordActivity?(streamId: string, expectedCreatedAt?: number): void;

  /**
   * Persist any coalesced chunk appends still buffered for this stream.
   * Terminal transitions must flush first so the batch lands under the
   * generation's live status instead of fencing against its own completion.
   *
   * Presence of this method is how a store advertises append-coalescing
   * support; see the transport's flushPendingChunks for the pairing rule.
   */
  flushPendingAppends?(streamId: string): Promise<void>;

  /** Get total job count */
  getJobCount(): Promise<number>;

  /** Get job count by status */
  getJobCountByStatus(status: JobStatus): Promise<number>;

  /** Destroy the store and release resources */
  destroy(): Promise<void>;

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]>;

  // ===== Content State Methods =====
  // These methods manage volatile content state tied to each job.
  // In-memory: Uses WeakRef to graph for live access
  // Redis: Persists chunks and reconstructs on demand

  /**
   * Set the graph reference for a job (in-memory only).
   * The graph provides live access to contentParts and contentData (run steps).
   *
   * In-memory: Stores WeakRef to graph
   * Redis: No-op (graph not transferable, uses chunks instead)
   *
   * @param streamId - The stream identifier
   * @param graph - The StandardGraph instance
   */
  setGraph(streamId: string, graph: StandardGraph, expectedCreatedAt?: number): void;

  /**
   * Set content parts reference for a job.
   *
   * In-memory: Stores direct reference to content array
   * Redis: No-op (content built from chunks)
   *
   * @param streamId - The stream identifier
   * @param contentParts - The content parts array
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): void;

  /**
   * Get aggregated content for a job.
   *
   * In-memory: Returns live content from graph.contentParts or stored reference
   * Redis: Reconstructs from stored chunks
   *
   * @param streamId - The stream identifier
   * @returns Content parts or null if not available
   */
  getContentParts(
    streamId: string,
    expectedCreatedAt?: number,
    options?: { durableOnly?: boolean },
  ): Promise<{
    content: Agents.MessageContentComplex[];
    reconstructedEventCount?: number;
    durableEventCount?: number;
  } | null>;

  /** Atomically records the only recovery outcome for one overflow identity. */
  settleEarlyBufferRecovery(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    settlement: Pick<
      EarlyBufferOverflowState,
      'recoveryMethod' | 'recoveryOutcome' | 'recoveryCompletedAt' | 'recoveryFailureReason'
    >,
  ): Promise<boolean>;

  /** Atomically replaces an unresolved pending overflow marker with its
   * finalized durable frontier. A concurrent recovery settlement wins over
   * this owner-side finalization. */
  finalizeEarlyBufferOverflow(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    overflow: EarlyBufferOverflowState,
  ): Promise<boolean>;

  /** Whether this generation has admitted any subscriber on any replica. */
  hasSubscriberAttached(streamId: string, expectedCreatedAt: number): Promise<boolean>;

  /** Atomically claims the first subscriber for one generation epoch. */
  claimFirstSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    attachedAt: number,
    subscriberId: string,
    leaseExpiresAt: number,
  ): Promise<boolean>;

  detachSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    subscriberId: string,
  ): Promise<void>;

  hasActiveSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    observedAt: number,
  ): Promise<boolean>;

  /**
   * Get run steps for a job (for resume state).
   *
   * In-memory: Returns live run steps from graph.contentData
   * Redis: Fetches from persistent storage
   *
   * @param streamId - The stream identifier
   * @returns Run steps or empty array
   */
  getRunSteps(streamId: string, expectedCreatedAt?: number): Promise<Agents.RunStep[]>;

  /**
   * Append a streaming chunk for later reconstruction.
   *
   * In-memory: No-op (content available via graph reference)
   * Redis: Uses XADD for append-only log efficiency
   *
   * @param streamId - The stream identifier
   * @param event - The SSE event to append
   * @param expectedCreatedAt - Optional generation identity. When supplied, the append is
   *   refused if the stream ID now belongs to a replacement generation.
   */
  appendChunk(
    streamId: string,
    event: unknown,
    expectedCreatedAt?: number,
    /** When present, the same durable write records this drained steer as
     * delivered. Redis performs both mutations in one same-slot Lua step. */
    deliveredSteer?: SteerQueueItem,
    /** Hot-path hint: `coalesce` marks a plain streaming delta whose durable
     * append may batch with its window peers. Stores without batching (and any
     * append carrying a steer receipt) ignore it and stay per-event. */
    options?: { coalesce?: boolean },
  ): Promise<boolean>;

  /**
   * Clear all content state for a job.
   * Called on job completion/cleanup.
   *
   * @param streamId - The stream identifier
   * @param expectedCreatedAt - Optional generation identity. When supplied, replacement content
   *   is not cleared by a stale terminal cleanup.
   */
  clearContentState(streamId: string, expectedCreatedAt?: number): void;

  /**
   * Save run steps to persistent storage.
   * In-memory: No-op (run steps accessed via graph reference)
   * Redis: Persists for resume across instances
   *
   * @param streamId - The stream identifier
   * @param runSteps - Run steps to save
   * @param expectedCreatedAt - Optional generation identity. When supplied, the save is refused
   *   if the stream ID now belongs to a replacement generation.
   */
  saveRunSteps?(
    streamId: string,
    runSteps: Agents.RunStep[],
    expectedCreatedAt?: number,
  ): Promise<void>;

  /**
   * Set collected usage reference for a job.
   * This array accumulates token usage from all models during generation.
   *
   * @param streamId - The stream identifier
   * @param collectedUsage - Array of usage metadata from all models
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    expectedCreatedAt?: number,
  ): void;

  /**
   * Get collected usage for a job.
   *
   * @param streamId - The stream identifier
   * @returns Array of usage metadata or empty array
   */
  getCollectedUsage(streamId: string, expectedCreatedAt?: number): UsageMetadata[];

  // ===== Steering Queue Methods =====
  // FIFO queue of mid-run user messages, keyed by streamId. Writable from any
  // instance (the steer route), drained only by the run's owning process.

  /**
   * Atomically append a steer, guarded on the job being `running` AND the
   * queue not being closed by a terminal drain. Returns the new queue depth,
   * {@link STEER_ENQUEUE_NOT_RUNNING} when the job is missing, not running,
   * or closed, or {@link STEER_ENQUEUE_QUEUE_FULL} at max depth.
   */
  enqueueSteer(streamId: string, item: SteerQueueItem, expectedCreatedAt?: number): Promise<number>;

  /** Atomic capability-normalized enqueue. Unlike enqueue→arm, no fallible
   * mutation occurs after the item becomes durable and before its ACK. */
  enqueueSteerVersioned(
    streamId: string,
    item: SteerQueueItem,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueVersionedResult>;

  /** Atomic receipt lookup + capability-normalized enqueue. An existing
   * receipt wins even if the live queue is now full, paused, drained, or the
   * generation has ended/replaced. Numeric results are enqueue rejection
   * codes (including {@link STEER_ENQUEUE_RECEIPT_FULL}); a receipt reports
   * either the existing or newly inserted item. */
  enqueueSteerWithReceipt(
    streamId: string,
    item: SteerQueueItem,
    receipt: SteerReceiptInput,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueReceiptResult>;

  /** Read a bounded receipt without requiring the live job/queue. */
  getSteerReceipt(streamId: string, clientSteerId: string): Promise<SteerReceipt | null>;

  /**
   * Atomically take ALL queued steers, FIFO. Empty array when none. With
   * `expectedCreatedAt`, the drain is refused (atomically, inside the store)
   * when the live job's `createdAt` differs — a stale run's drain must never
   * consume a replacement job's queue.
   */
  drainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;

  /** Put a failed claimed batch back at the FIFO front, preserving its order
   * and receipt state. This is the rollback for a durable applied-part write
   * that failed after the atomic drain. */
  restoreClaimedSteers(
    streamId: string,
    items: SteerQueueItem[],
    expectedCreatedAt?: number,
  ): Promise<boolean>;

  /**
   * Terminal admission fence. When `allowClaim` and queued work are both
   * present, atomically claim the FIFO batch while leaving admission open for
   * the continued run. Otherwise atomically close admission so a racing steer
   * is rejected and remains an ordinary follow-up, unless
   * `keepOpenWhenEmpty` proves another folded Stop hook already planned a
   * continuation. V1 generations always seal because they lack
   * crash-recoverable claimed-steer receipts.
   */
  admitTerminalSteers(
    streamId: string,
    policy: TerminalSteerAdmissionPolicy,
    expectedCreatedAt?: number,
  ): Promise<TerminalSteerAdmissionResult>;

  /**
   * Atomically CLOSE the queue to new steers, then take all queued items
   * FIFO. Used by the terminal paths (final event, abort) so a steer POST
   * racing finalization can never be 202-ACKed after the last drain and then
   * silently cleared — once closed, `enqueueSteer` rejects until the next
   * `createJob` reopens the stream id. `expectedCreatedAt` guards exactly
   * like {@link drainSteers}: a stale run's finalization can neither close
   * nor steal a replacement job's queue.
   */
  closeAndDrainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;

  /**
   * Non-destructive FIFO read of the queued steers (status/resume surfaces).
   * With `expectedCreatedAt`, returns an empty snapshot if the stream belongs
   * to another generation.
   */
  peekSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;

  /** Drained but not yet durably applied items. Kept separate from the live
   * FIFO so a reconnect can render them without a second owner injecting them. */
  peekClaimedSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]>;

  /** Remove ONE queued steer by id (user-cancelled before injection).
   *  False when it was no longer queued — already drained or run ended — or
   *  when `expectedCreatedAt` belongs to a replaced generation. */
  removeSteer(streamId: string, steerId: string, expectedCreatedAt?: number): Promise<boolean>;

  /**
   * Atomically set `preempt: true` on ONE queued steer IN PLACE, preserving
   * its FIFO position (the user escalated a waiting steer to an interrupt;
   * the whole queue drains at the seal, so its order must not change).
   * Guarded like {@link enqueueSteer}: `missing` when the job is not running,
   * the steer is no longer queued, the queue is closed, or (with
   * `expectedCreatedAt`) the stream belongs to another generation. The owner's
   * LIVE `preemptCapable` is part of the same atomic predicate — a HITL resume
   * on a rolling deploy can rewrite it for the SAME generation, so a value
   * read before the call is not trustworthy — and an incapable owner answers
   * `incapable` with the item left unflagged.
   */
  armSteer(streamId: string, steerId: string, expectedCreatedAt?: number): Promise<SteerArmOutcome>;

  /** Versioned form used by the HTTP arm route so its publication carries
   * the revision atomically assigned with the durable flag. */
  armSteerVersioned(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmResult>;

  /** Atomically remove `preempt` from every queued steer only when the
   * generation's current owner is incapable. Returns the changed steer ids
   * (used to tombstone late arm publications), or `null` when the generation
   * is missing/replaced or currently capable. */
  downgradeSteerPreempts(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[] | null>;

  /**
   * Persist terminally-drained steers under their OWN bounded-TTL key so a
   * client with no live subscriber can recover them via the status route.
   * Deliberately independent of the job record — the default `completeJob`
   * path deletes the job immediately, and recovery must survive that.
   * Merges with any prior payload. `createJob` leases the selected recovery
   * item while that generation is active; the item is removed only after its
   * ordinary user message is durably persisted.
   * When `expectedCreatedAt` is supplied, the write is conditional on that
   * generation still owning the stream ID.
   */
  parkSteers(streamId: string, payload: string, expectedCreatedAt?: number): Promise<void>;

  /** Owner-gated recovery read. A source leased to a matching active recovery
   * generation is hidden but retained; it becomes visible again if startup
   * fails, and is removed only after durable user-message persistence. */
  claimParkedSteers(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
  ): Promise<string | undefined>;

  /** Protocol-aware form of {@link claimParkedSteers}. Existing callers may
   * keep using the payload-only method. */
  claimParkedSteersDetailed(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    requestedProtocolVersion?: GenerationProtocolVersion,
  ): Promise<ParkedSteerClaim | undefined>;

  /** Commit a recovery handoff after its ordinary user message is durable.
   * Guarded by generation identity and owner, and idempotent for retries. */
  consumeParkedSteer(
    streamId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId: string | undefined,
    expectedCreatedAt: number,
  ): Promise<boolean>;

  /** Owner-gated terminal reclaim. Atomically removes one leftover from the
   * parked payload and marks its receipt cancelled, making edit/queue/dismiss
   * retries idempotent without reviving an already-started recovery. */
  discardSteerLeftover(
    streamId: string,
    clientSteerId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    expectedGenerationCreatedAt?: number,
  ): Promise<boolean>;

  /** Drop any queued steers (terminal cleanup backstop). */
  clearSteers(streamId: string): Promise<void>;
}

export type GenerationTerminalEventType = 'done' | 'error';

/** A terminal publication lost the generation fence to a replacement. This is
 * an expected safety outcome: the successor owns all further stream output. */
export class GenerationPublicationFencedError extends Error {
  readonly code = 'GENERATION_PUBLICATION_FENCED';

  constructor(
    readonly eventType: GenerationTerminalEventType,
    readonly streamId: string,
    readonly generationId?: number,
  ) {
    super(
      eventType === 'done'
        ? 'Generation DONE publication was fenced by a replacement'
        : 'Generation error publication was fenced by a replacement',
    );
    this.name = 'GenerationPublicationFencedError';
  }
}

/**
 * Interface for pub/sub event transport.
 * Implementations can use EventEmitter, Redis Pub/Sub, etc.
 */
export interface IEventTransport {
  /**
   * Subscribe to events for a stream. `ready` resolves once the transport can receive messages.
   *
   * Redis callers can defer sequenced delivery until `syncReorderBuffer()` establishes the
   * replay frontier. This prevents pub/sub copies of locally buffered events from racing ahead
   * of, and then being duplicated by, first-subscriber replay.
   */
  subscribe(
    streamId: string,
    handlers: {
      /** `generationId` identifies the immutable generation that emitted the chunk. */
      onChunk: (event: unknown, generationId?: number) => void;
      /** `generationId` identifies the immutable generation that emitted the done event. */
      onDone?: (event: unknown, generationId?: number) => void;
      /** `generationId` identifies the immutable generation that emitted the error. */
      onError?: (error: string, generationId?: number) => void;
    },
    options?: {
      /** Hold sequenced events until syncReorderBuffer establishes the replay frontier. */
      deferSequenceDelivery?: boolean;
      /** After opening a fresh Pub/Sub channel, atomically capture its sequence frontier
       * and fence delivery so synchronization cannot lose an attachment-time frame. */
      captureSequenceFrontier?: boolean;
    },
  ): {
    unsubscribe: () => void;
    ready?: Promise<void>;
    /** Synchronize only the transport state captured by this concrete subscription. */
    syncReorderBuffer?: () => void | Promise<void>;
  };

  /**
   * Publish a chunk event.
   * Redis returns the assigned absolute sequence so locally replayed events can
   * advance a subscriber to the exact ordering frontier.
   */
  emitChunk(streamId: string, event: unknown, generationId?: number): void | Promise<void | number>;

  /**
   * Publish a done event - returns Promise in Redis mode for ordered delivery.
   * `generationId` is optional for compatibility with legacy, untagged publishers.
   */
  emitDone(streamId: string, event: unknown, generationId?: number): void | Promise<void>;

  /**
   * Publish an error event - returns Promise in Redis mode for ordered delivery.
   * `generationId` is optional for compatibility with legacy, untagged publishers.
   */
  emitError(streamId: string, error: string, generationId?: number): void | Promise<void>;

  /** Optional live-view demand marker used by observational streams that do not replay. */
  renewDemand?(streamId: string, ttlMs: number): void | Promise<void>;

  /** Returns whether at least one live viewer recently renewed demand for this stream. */
  hasDemand?(streamId: string): boolean | Promise<boolean>;

  /**
   * Publish an abort signal to all replicas (Redis mode).
   * Enables cross-replica abort: user aborts on Replica B,
   * generating Replica A receives signal and stops.
   * Optional - only implemented in Redis transport.
   */
  emitAbort?(streamId: string, generationId?: number): void;

  /** Awaitable, generation-correlated abort handoff. Resolves true only after
   * the replica owning that generation processes the abort. */
  emitAbortConfirmed?(streamId: string, generationId: number): Promise<boolean>;

  /** Persist proof that this process synchronously stopped the exact generation.
   * A delayed replacement can use the proof after the owner's listeners retire. */
  recordAbortAcknowledgement?(streamId: string, generationId: number): Promise<boolean>;

  /** Persist/read exact proof that a provider segment can no longer mutate user data. */
  recordProviderDrain?(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean>;
  hasProviderDrain?(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean>;

  /** Publish a predecessor DONE only while the current job's opaque creation
   * attempt still carries that predecessor in its durable receipt chain. */
  emitReplacedDoneConfirmed?(
    streamId: string,
    event: unknown,
    replacedGenerationId: number,
    creationAttemptId: string,
  ): Promise<void>;

  /**
   * Register callback for abort signals from any replica (Redis mode).
   * Called when abort is triggered from any replica.
   * An async implementation resolves only after it can receive abort messages.
   * The returned function removes only this registration, allowing a terminal
   * generation to release its channel without affecting a same-stream replacement.
   * Optional - only implemented in Redis transport.
   */
  onAbort?(
    streamId: string,
    /** Return true only when this replica owns and stopped the tagged generation. */
    callback: (generationId?: number) => void | boolean,
  ): void | (() => void) | Promise<void | (() => void)>;

  /**
   * Publish a preempt arm/clear to all replicas (Redis mode). Unlike abort
   * this does NOT stop the run — it asks the generating replica to seal its
   * current model stream at the next provider-safe boundary. Fenced by
   * {@link PreemptMessage.createdAt} against replacement jobs.
   * Optional - only implemented in Redis transport.
   */
  emitPreempt?(streamId: string, msg: PreemptMessage): void | Promise<number>;

  /**
   * Register callback for preempt signals from any replica (Redis mode).
   * An async implementation resolves only after it can receive messages.
   * The returned function removes only this registration, allowing a terminal
   * generation to release its channel without affecting a same-stream replacement.
   * Optional - only implemented in Redis transport.
   */
  onPreempt?(
    streamId: string,
    callback: (msg: PreemptMessage) => void,
  ): void | (() => void) | Promise<void | (() => void)>;

  /** Get subscriber count for a stream */
  getSubscriberCount(streamId: string): number;

  /** Check if this is the first subscriber (for ready signaling) */
  isFirstSubscriber(streamId: string): boolean;

  /** Listen for all subscribers leaving */
  onAllSubscribersLeft(streamId: string, callback: () => void): void;

  /**
   * Advance subscriber reorder buffer to match publisher sequence (cross-replica safe).
   * @param replayedNextSeq - Absolute Redis sequence immediately after the last event replayed
   *   from the local early-event buffer. Pending entries below it are duplicates; entries at
   *   or above it are live. Undefined means no local replay, so the Redis counter is trusted.
   */
  syncReorderBuffer?(streamId: string, replayedNextSeq?: number): void | Promise<void>;

  /**
   * Notify and detach subscribers attached to this process without broadcasting a terminal event.
   * Must trigger all-subscribers-left cleanup so graceful shutdown can drain partial persistence.
   */
  closeLocalSubscribers?(streamId: string, error: string): void;

  /**
   * Publish any coalesced chunk publications still buffered for this stream.
   * Callers about to transition a generation's status must flush first, or the
   * batch would land behind the transition and fence itself.
   *
   * Presence of this method is how a transport advertises delta-coalescing
   * support: the generation manager only sends `coalesce` hints (and only
   * stops awaiting per-delta receipts) when both the transport and the job
   * store expose their flush capability.
   */
  flushPendingChunks?(streamId: string): Promise<void>;

  /** Cleanup transport resources for a specific stream */
  cleanup(streamId: string): void;

  /** Get all tracked stream IDs (for orphan cleanup) */
  getTrackedStreamIds(): string[];

  /** Destroy all transport resources */
  destroy(): void;
}
