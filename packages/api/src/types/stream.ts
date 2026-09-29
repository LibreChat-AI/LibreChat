import type {
  IAgentEventActorContextMeta,
  ICompactionSemanticIndexProjection,
} from '@librechat/data-schemas';
import type { Agents, UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type { EventEmitter } from 'events';
import type {
  AgentEventDetachedTerminalEvidence,
  AgentEventSuspensionProjection,
  AgentTriggerExpectedAction,
} from '../agents/triggers/types';
import type { ActivityPhaseSnapshot } from '~/agents/activityPhases/runtime';
import type { EarlyBufferOverflowState } from './earlyBufferRecovery';
import type { ResolvedAskUserQuestion } from '../agents/hitl/resume';
import type { MCPRuntimeRequestBody } from '../mcp/types';
import type { ServerSentEvent } from './events';

export interface GenerationJobMetadata {
  userId: string;
  tenantId?: string;
  conversationId?: string;
  /** Immutable per-generation saver scope. LangGraph's root `checkpoint_ns`
   * remains empty; the checkpointer adapter maps this scope into storage. */
  checkpointNamespace?: string;
  /** Immutable generation protocol. Missing on legacy records means v1. */
  generationProtocolVersion?: 1 | 2;
  earlyBufferOverflow?: EarlyBufferOverflowState;
  /** User message data for rebuilding submission on reconnect */
  userMessage?: Agents.UserMessageMeta;
  /** Response message ID for tracking */
  responseMessageId?: string;
  /** Whether this generation replaces an existing assistant branch. */
  isRegenerate?: boolean;
  /** Exact normalized MCP placeholder identity for this turn. Persisted so HITL
   * resume does not reconstruct a different parent or overridden conversation. */
  mcpRequestBody?: MCPRuntimeRequestBody;
  /** Exact assistant-message fields authored by the user during this running job. */
  userSubmittedPaths?: string[];
  /** Exact HITL message-filter fields embedded at those assistant-message paths. */
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];
  /** Sender label for the response (e.g., "GPT-4.1", "Claude") */
  sender?: string;
  /** Endpoint identifier for abort handling */
  endpoint?: string;
  /** Icon URL for UI display */
  iconURL?: string;
  /** Model name for token tracking */
  model?: string;
  /** Prompt token count for abort token spending */
  promptTokens?: number;
  /** Agent that initiated the run; a HITL resume verifies it rebuilds the same agent. */
  agent_id?: string;
  /** Whether the originating turn was a temporary chat; a HITL resume keeps it so. */
  isTemporary?: boolean;
  /** Original server-authenticated retention deadline, serialized across replicas. */
  retentionExpiresAt?: string;
  /** Exact durable delivery whose accepted continuation created this generation. */
  agentEventDeliveryKey?: string;
  /** Original actor invocation when the current mailbox delivery is an internal completion. */
  agentEventInvocationKey?: string;
  /** Original actor invocation generation retained across completion HITL resumes. */
  agentEventInvocationGenerationCreatedAt?: number;
  /** This generation must resume on a durable detached-action producer. */
  agentEventDetachedActionProducerRequired?: boolean;
  /** Durable retry payload captured before detached terminal evidence reaches Mongo. */
  agentEventDetachedTerminalEvidence?: AgentEventDetachedTerminalEvidence;
  /** Trusted actor binding copied from the authenticated delivery envelope. */
  agentEventBindingId?: string;
  /** Optional action evidence contract declared by the authenticated event source. */
  agentEventExpectedAction?: AgentTriggerExpectedAction;
  /** Versioned pointer to the canonical signed suspension stored on the Conversation. */
  agentEventSuspension?: AgentEventSuspensionProjection;
  /** Exact durable legacy-turn fence carried across a HITL pause/resume. */
  agentEventLegacyTurnToken?: string;
  /** Trusted scheduled-occurrence identity. These fields are accepted only from a
   * verified agent-trigger request and let pause/resume/reconciliation keep the
   * occurrence attached to the exact generation that owns it. */
  scheduleId?: string;
  scheduledFor?: string;
  scheduleConfigRevision?: number;
  scheduleManual?: boolean;
  /** Intended terminal classification retained when Mongo outcome persistence
   * fails. The scheduler reconciler consumes this evidence before clearing the job. */
  scheduleOutcome?: 'success' | 'error' | 'interrupted' | 'skipped_balance';
  scheduleOutcomeError?: string;
  /** Prevent normal terminal cleanup until schedule reconciliation has consumed
   * the retained outcome evidence. */
  preserveForScheduleReconcile?: boolean;
  /**
   * Deferred-tool names discovered (via `tool_search`) before a HITL pause. A resume
   * replays these into `createRun` because the rebuilt graph uses `messages: []`, so
   * without them the rebuilt model would lose the discovered tool schemas.
   */
  discoveredTools?: string[];
  /** Bounded collector state for continuing a phase across HITL resume. */
  activityPhaseSnapshot?: ActivityPhaseSnapshot;
  /** Exact bounded compaction guidance captured atomically with a HITL pause. */
  compactionSemanticIndex?: ICompactionSemanticIndexProjection;
  /** Calibration and fading state captured atomically with a HITL pause, so a resume seeds its rebuilt pruner from the same tier. */
  contextMeta?: IAgentEventActorContextMeta;
  /** See `SerializableJobData.preemptCapable`. */
  preemptCapable?: boolean;
  /** See `SerializableJobData.steerQuotesCapable`. */
  steerQuotesCapable?: boolean;
  /** See `SerializableJobData.steerQuotesExecutionId`. */
  steerQuotesExecutionId?: string;
  /** Exact provider segment whose completion gates destructive user cleanup. */
  providerExecutionId?: string;
  /** Exact provider owner that crossed its start fence. */
  providerExecutionStartedId?: string;
  /** False only while that exact provider segment can still mutate user data. */
  providerDrained?: boolean;
  /** Terminal close has atomically stopped new steer acceptance, even if the
   * final status CAS has not yet run. */
  steersClosed?: boolean;
  /** Stable start-submission identity. Duplicate POSTs compare this with their
   * claim before attaching to a conversation-scoped stream. */
  idempotencyClientRequestId?: string;
  /** Normal FINAL publication is waiting on required durable abort work. */
  terminalPersistencePending?: boolean;
  terminalHostActionPending?: boolean;
  terminalPersistenceStartedAt?: number;
  /** Set when the job is paused for human review (status === 'requires_action') */
  pendingAction?: Agents.PendingAction;
  /** Accepted ask-user answer retained until this generation terminalizes. */
  resolvedAskUserQuestions?: ResolvedAskUserQuestion[];
}

export type GenerationJobStatus = 'running' | 'complete' | 'error' | 'aborted' | 'requires_action';

export interface GenerationJob {
  streamId: string;
  emitter: EventEmitter;
  status: GenerationJobStatus;
  createdAt: number;
  completedAt?: number;
  abortController: AbortController;
  error?: string;
  metadata: GenerationJobMetadata;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  /** Final event when job completes */
  finalEvent?: ServerSentEvent;
  /** Flag to indicate if a sync event was already sent (prevent duplicate replays) */
  syncSent?: boolean;
}

export type ContentPart = Agents.ContentPart;
export type ResumeState = Agents.ResumeState;

export type ChunkHandler = (event: ServerSentEvent) => void;
export type DoneHandler = (event: ServerSentEvent) => void;
export type ErrorHandler = (error: string) => void;
export type UnsubscribeFn = () => void;

/** Active event-stream subscription. */
export interface StreamSubscription {
  unsubscribe: UnsubscribeFn;
}

/** Resume subscription whose live delivery starts after the caller writes its sync frame. */
export interface ResumeSubscription extends StreamSubscription {
  activate: () => void;
}

/** Options for subscribing to a job event stream */
export interface SubscribeOptions {
  /**
   * When true, skips replaying the earlyEventBuffer.
   * Use for resume connections after a sync event has been sent.
   */
  skipBufferReplay?: boolean;
  /** Cancels attachment work when the HTTP client disconnects. */
  signal?: AbortSignal;
  /** Exact generation epoch the caller intends to observe. Conversation ids
   * are reused by later turns, so a stale client must never attach to a
   * replacement job that now occupies the same stream id. */
  expectedCreatedAt?: number;
}

/** Result of an atomic subscribe-with-resume operation */
export interface SubscribeWithResumeResult {
  subscription: ResumeSubscription | null;
  resumeState: ResumeState | null;
  /**
   * Events that arrived between the resume snapshot and the subscribe call.
   * In-memory mode: drained from earlyEventBuffer (only place they exist).
   * Redis mode: empty — chunks are persisted to the store and appear in aggregatedContent on next resume.
   */
  pendingEvents: ServerSentEvent[];
}
