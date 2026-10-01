import type {
  CodeApprovalMode,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
  TSubagentThreadLineage,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';
import type { ICompactionSemanticIndexProjection } from './compaction';

export const MAX_AGENT_EVENT_ACTOR_SKILLS = 64;
export const MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS = 128;
export const MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH = 512;
export const MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH = 1_000_000;
export const MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH = 128;
/**
 * Provenance of a stored event-actor summary. States written before this
 * version kept only `{ text, tokenCount }`, so a round that failed or never
 * finished is indistinguishable from a checkpoint once persisted. A restore
 * requires the current version, which is what lets a warm continuation trust
 * the summary instead of rebuilding from durable history.
 */
export const AGENT_EVENT_ACTOR_SUMMARY_VERSION = 1;

export interface ISubagentThreadLease {
  token: string;
  taskId: string;
  expiresAt: Date;
}

/** Server-private route from one authenticated event source to a child actor thread. */
export interface IAgentEventBinding {
  bindingId: string;
  sourceKeyId: string;
  actorId: string;
}

export interface IAgentEventActorCheckpoint {
  threadId: string;
  checkpointId: string;
  checkpointNs: string;
}

export interface IAgentEventActorContextFingerprint {
  algorithm: 'sha256';
  version: number;
  digest: string;
}

export interface IAgentEventActorSkillIdentity {
  id: string;
  name: string;
  version: number;
  contentDigest?: string;
}

export interface IAgentEventActorSummary {
  text: string;
  tokenCount: number;
  /** {@link AGENT_EVENT_ACTOR_SUMMARY_VERSION}; absent on pre-version states. */
  version?: number;
}

/**
 * Latched context-fading tier from `@librechat/agents`. Every cap the SDK
 * applies to its provider-only projection of historical tool results derives
 * from it alone, so persisting it keeps that projection byte-stable across runs
 * for prefix-based provider prompt caches. Graph messages stay canonical.
 */
export interface IAgentFadingTier {
  /** Version 1 is readable but must not seed a version 2 SDK run. */
  v: 1 | 2;
  /** Token budget the caps derive from; never grows within a conversation. */
  budgetTokens: number;
  /** Whether observation masking has activated. */
  masked: boolean;
}

/** One agent's latched tier inside the persisted per-agent map. */
export interface IAgentFadingTierEntry extends IAgentFadingTier {
  agentId: string;
}

/**
 * Compact context state a run hands to its successor: calibration and the
 * latched fading tiers. Messages themselves are never part of it; the SDK keeps
 * graph history canonical and derives a provider-only projection per run.
 */
export interface IAgentEventActorContextMeta {
  calibrationRatio: number;
  encoding?: string;
  /** Default agent's tier, kept for single-agent seeding. */
  fading?: IAgentFadingTier;
  /** Tiers keyed by agent ID, stored as entries so agent IDs never become field names. */
  fadingTiers?: IAgentFadingTierEntry[];
}

/** Private committed checkpoint state for one event-bound child actor. */
export interface IAgentEventActorState {
  generation: number;
  checkpoint: IAgentEventActorCheckpoint;
  contextFingerprint?: IAgentEventActorContextFingerprint;
  /** Bounded semantic Skill set needed to validate a warm continuation without history. */
  skillManifest?: IAgentEventActorSkillIdentity[];
  /** Bounded run-evolved tool-search state needed to rebuild the next model binding. */
  discoveredToolNames?: string[];
  /** Active compaction summary, which the SDK keeps outside checkpointed graph messages. */
  summary?: IAgentEventActorSummary;
  /** Pruner calibration carried by ordinary turns on the parent response message. */
  contextMeta?: IAgentEventActorContextMeta;
  /** Bounded advisory guidance replayed without reading durable message history. */
  compactionSemanticIndex?: ICompactionSemanticIndexProjection;
  previousCheckpoint?: IAgentEventActorCheckpoint;
  /** Forces the next qualifying event to rebuild from durable message history. */
  requiresColdStart?: boolean;
}

export interface IAgentEventActorReconciliation {
  invocationId: string;
  /** New-protocol executions acquire the delivery-owned action admission CAS
   * before the external action may run. Absent only on mixed-version rows. */
  actionAdmitted?: boolean;
  status:
    | 'invocation_pending'
    | 'persistence_pending'
    | 'history_persisted'
    | 'commit_conflict'
    | 'commit_indeterminate'
    | 'persistence_failed'
    | 'settled';
  checkpoint: Omit<IAgentEventActorCheckpoint, 'checkpointId'> & { checkpointId?: string };
  action: { toolName: string; toolCallId?: string };
  error?: string;
  /** How a retained receipt reached `settled`. Absent on active lifecycle rows. */
  resolution?: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  observedAt: Date;
}

/**
 * Durable fence covering one legacy-path turn from before its execution until
 * its history is persisted. While present, no fork may execute or commit — the
 * turn's messages are not yet durable, so any rebuild would be incomplete. A
 * crash leaves the token in place (fail-closed) until it is reclaimed.
 */
export interface IAgentEventActorLegacyTurn {
  token: string;
  startedAt: Date;
}

/** JSON-safe value retained inside SDK-issued event-actor evidence. */
export type TAgentEventActorEvent =
  | null
  | boolean
  | number
  | string
  | TAgentEventActorEvent[]
  | { [key: string]: TAgentEventActorEvent };

export interface IAgentEventActorInvocationReference {
  actorThreadId: string;
  invocationId: string;
  depth: number;
  continuation: 'warm' | 'cold';
  base: {
    actorThreadId: string;
    generation: number;
    checkpoint?: Omit<IAgentEventActorCheckpoint, 'checkpointId'> & { checkpointId?: string };
  };
  fork: Omit<IAgentEventActorCheckpoint, 'checkpointId'> & {
    checkpointId?: string;
    invocationId: string;
  };
}

/** Exact, signed SDK evidence for a paused invocation fork. */
export interface IAgentEventActorSuspensionEvidence {
  version: 1;
  suspensionId: string;
  attempt: number;
  issuedAt: number;
  expiresAt: number;
  invocation: IAgentEventActorInvocationReference;
  checkpoint: IAgentEventActorInvocationReference['fork'];
  interrupt: {
    id: string;
    payload: TAgentEventActorEvent;
  };
  suspensionDigest: string;
}

/**
 * Host-owned current suspension fence. SDK evidence authenticates the fork;
 * the mirrored action/job identity binds it to LibreChat's approval CAS.
 */
export interface IAgentEventActorSuspension {
  suspension: IAgentEventActorSuspensionEvidence;
  /** Host-side reason for suspension. Missing legacy values are human decisions. */
  kind?: 'human_decision' | 'internal_completion';
  /** Expected-action evidence already applied before a later re-pause. */
  appliedAction?: {
    toolName: string;
    toolCallId?: string;
  };
  /** Original delivery-handling generation retained across resumed generations. */
  handlingGenerationCreatedAt?: number;
  actionId: string;
  jobCreatedAt: number;
  /** Owned states fence legacy replicas; snapshot readers expose pending/claimed. */
  status: 'pending' | 'claimed' | 'pending_owned' | 'claimed_owned' | 'closed';
  resumeAttemptId?: string;
  outcome?: 'committed' | 'stale' | 'settled' | 'cancelled';
  closedAt?: Date;
  observedAt: Date;
}

export interface IAgentEventActorSnapshot {
  state: IAgentEventActorState | null;
  reconciliations: IAgentEventActorReconciliation[];
  legacyTurn: IAgentEventActorLegacyTurn | null;
  suspension: IAgentEventActorSuspension | null;
  /** Durable invalidation epoch. Every legacy-path event bumps it — including
   * for headless or already cold-marked actors, where the marker alone leaves
   * no CAS-visible trace — and the commit CAS requires the epoch observed at
   * preparation, so a stale fork can never commit state built from history
   * read before an intervening legacy turn. */
  epoch: number;
}

export interface IAgentEventBindingRecord {
  conversationId: string;
  agentId: string;
  tenantId?: string;
  isTemporary?: boolean;
  expiredAt?: Date;
  binding: IAgentEventBinding;
  lineage: TSubagentThreadLineage;
}

export interface IActiveSubagentThreadLease {
  conversationId: string;
  parentConversationId: string;
  taskId: string;
}

export interface ISubagentThreadReservation {
  conversation: IConversation;
  created: boolean;
}

// @ts-ignore
export interface IConversation extends Document {
  conversationId: string;
  title?: string;
  user?: string;
  messages?: Types.ObjectId[];
  isTemporary?: boolean;
  // Fields provided by conversationPreset (adjust types as needed)
  endpoint?: string;
  endpointType?: string;
  model?: string;
  region?: string;
  chatGptLabel?: string;
  examples?: unknown[];
  modelLabel?: string;
  promptPrefix?: string;
  temperature?: number;
  top_p?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  file_ids?: string[];
  resendImages?: boolean;
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  thinking?: boolean;
  thinkingBudget?: number;
  effort?: string;
  system?: string;
  resendFiles?: boolean;
  imageDetail?: string;
  agent_id?: string;
  codeApprovalMode?: CodeApprovalMode;
  /** Private fence advanced when an admitted generation reads its decision. */
  codeEnvironmentRevision?: number;
  codeEnvironmentMode?: CodeEnvironmentMode;
  codeWorkspaces?: CodeWorkspaceSelection[];
  /** Immutable primary persisted-agent attribution for Insights. */
  initial_agent_id?: string | null;
  subagentThread?: TSubagentThreadLineage;
  /** Internal execution fence. Excluded from ordinary conversation reads. */
  subagentThreadLease?: ISubagentThreadLease;
  /** Internal event-source identity. Excluded from ordinary conversation reads. */
  agentEventBinding?: IAgentEventBinding;
  /** Internal event-actor checkpoint head. Excluded from ordinary conversation reads. */
  agentEventActor?: IAgentEventActorState;
  /** Prune work persisted atomically before the actor rotates its predecessor. */
  agentEventActorCleanup?: IAgentEventActorCheckpoint[];
  /** Private invocation proof: active lifecycle fences plus settled same-ID receipts. */
  agentEventActorReconciliations?: IAgentEventActorReconciliation[];
  /** Private invalidation epoch; see {@link IAgentEventActorSnapshot.epoch}. */
  agentEventActorEpoch?: number;
  /** Private in-flight legacy-turn fence; see {@link IAgentEventActorLegacyTurn}. */
  agentEventActorLegacyTurn?: IAgentEventActorLegacyTurn;
  /** Private current suspended invocation; see {@link IAgentEventActorSuspension}. */
  agentEventActorSuspension?: IAgentEventActorSuspension;
  assistant_id?: string;
  instructions?: string;
  stop?: string[];
  isArchived?: boolean;
  /** Set when archived, cleared on unarchive; absent on chats archived before it existed. */
  archivedAt?: Date | null;
  pinned?: boolean;
  /** Derived per request from the shared-links collection; never persisted on the conversation. */
  isShared?: boolean;
  iconURL?: string;
  greeting?: string;
  spec?: string;
  tags?: string[];
  chatProjectId?: string | null;
  tools?: string[];
  maxContextTokens?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  reasoning_summary?: string;
  reasoning_mode?: string;
  reasoning_context?: string;
  verbosity?: string;
  useResponsesApi?: boolean;
  web_search?: boolean;
  url_context?: boolean;
  disableStreaming?: boolean;
  fileTokenLimit?: number;
  // Additional fields
  files?: string[];
  expiredAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  /** Set only when an assistant message is persisted, never by title generation or metadata edits. */
  lastResponseAt?: Date;
  /** Durable messageId of the assistant reply named by `lastResponseAt`. */
  lastResponseMessageId?: string;
  /** True only while `lastResponseAt` is the synthetic marker from "mark unread". */
  lastResponseIsManual?: boolean;
  /** Set when the user has the newest message on screen; compared against `lastResponseAt`. */
  lastSeenAt?: Date;
}
