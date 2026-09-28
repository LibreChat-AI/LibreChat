import type {
  TFeedbackRating,
  TFeedbackTag,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type { Document } from 'mongoose';
import type { IAgentEventActorContextMeta } from './convo';

export type SubagentTaskControlAction =
  | 'steer'
  | 'queue'
  | 'interrupt'
  | 'cancel'
  | 'cancel_message';

export type SubagentTaskControlReceiptStatus =
  | 'reserved'
  | 'accepted'
  | 'applied'
  | 'rejected'
  | 'failed';

export type SubagentTriggerProjection = {
  version: 1;
  eventType: string;
  sourceType: string;
  occurredAt: Date;
  expectedActionToolName?: string;
};

/** Server-private durable receipt for one parent-to-child control invocation. */
export interface ISubagentTaskControlReceipt {
  invocationId: string;
  fingerprint: string;
  controlId?: string;
  action: SubagentTaskControlAction;
  status: SubagentTaskControlReceiptStatus;
  createdAt: Date;
  updatedAt: Date;
  boundary?: 'preempt' | 'tool' | 'turn';
  reason?: string;
  message?: string;
  messageTruncated?: boolean;
}

// @ts-ignore
export interface IMessage extends Document {
  messageId: string;
  conversationId: string;
  user: string;
  model?: string;
  endpoint?: string;
  conversationSignature?: string;
  clientId?: string;
  invocationId?: number;
  parentMessageId?: string | null;
  tokenCount?: number;
  summaryTokenCount?: number;
  sender?: string;
  text?: string;
  summary?: string;
  isCreatedByUser: boolean;
  /** True when the complete stored row came from outside the model. */
  isUserSubmitted?: boolean;
  /** JSON pointers to caller-authored fields in an otherwise mixed model response. */
  userSubmittedPaths?: string[];
  /** Exact HITL message fields stored at caller-authored paths in a mixed response. */
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];
  isTemporary?: boolean;
  unfinished?: boolean;
  error?: boolean;
  finish_reason?: string;
  feedback?: {
    rating: TFeedbackRating;
    tag: TFeedbackTag | undefined;
    text?: string;
  };
  langfuseSampled?: boolean;
  langfuseDestinationIds?: string[];
  /** The run whose trace this response reports, when that run's id is not the message's own (a failed turn's error row). */
  langfuseRunId?: string;
  _meiliIndex?: boolean;
  files?: unknown[];
  plugin?: {
    latest?: string;
    inputs?: unknown[];
    outputs?: string;
  };
  plugins?: unknown[];
  content?: unknown[];
  thread_id?: string;
  iconURL?: string;
  addedConvo?: boolean;
  metadata?: Record<string, unknown>;
  /** Server-private canonical message delta for durable subagent-thread continuation. */
  subagentTranscript?: {
    taskId: string;
    mode: 'append' | 'replace';
    messagesJson: string;
  };
  /** Server-private bounded rendering projection derived once at child settlement. */
  subagentActivityProjection?: {
    taskId: string;
    version: 1;
    activityJson: string;
    truncated: boolean;
  };
  /** Server-private durable idempotency marker for one detached subagent turn. */
  subagentTask?: {
    attemptKey: string;
    /** Parent response that initiated this exact child task. */
    parentRunId?: string;
    requestFingerprint?: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    resultClaim?: {
      kind: 'manual' | 'wakeup';
      claimId: string;
      claimedAt: Date;
      /** Response generation that owns a manual delivery claim. */
      generationId?: string;
    };
    controlReceipts?: ISubagentTaskControlReceipt[];
  };
  subagentTriggerProjection?: SubagentTriggerProjection;
  contextMeta?: Partial<IAgentEventActorContextMeta>;
  attachments?: unknown[];
  /** Skills the user invoked manually via the `$` popover on this turn. UI-only metadata for `SkillPills`. */
  manualSkills?: string[];
  /**
   * Skills auto-primed on this turn via `always-apply` frontmatter. Persisted
   * at turn time so pinned badges survive later flips of the skill's
   * `alwaysApply` flag — the audit trail follows what actually ran, not what
   * the current catalog says.
   */
  alwaysAppliedSkills?: string[];
  /** Verbatim excerpts the user quoted to reference on this turn. UI-only metadata for `MessageQuotes`. */
  quotes?: string[];
  expiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
