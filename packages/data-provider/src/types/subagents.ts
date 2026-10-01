export type SubagentThreadStatus =
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type ParentSubagentTaskSummary = {
  taskId: string;
  status: SubagentThreadStatus;
  createdAt?: string;
};

/**
 * Bounded discovery projection for one child owned by a parent conversation.
 * Event-delivery identities stay private; `actorId` is the only event-binding
 * field intentionally exposed to the parent's UI.
 */
export type ParentSubagentSummary = {
  threadId: string;
  parentMessageId: string;
  /** Present only for ordinary tool-spawned children. */
  parentToolCallId?: string;
  subagentType: string;
  subagentKind: 'agent' | 'graph';
  agentId?: string;
  title: string;
  origin: 'tool' | 'event';
  actorId?: string;
  status: SubagentThreadStatus;
  updatedAt?: string;
  latestTaskId?: string;
  tasks: ParentSubagentTaskSummary[];
  tasksTruncated: boolean;
};

export type ParentSubagentIndex = {
  parentConversationId: string;
  children: ParentSubagentSummary[];
  childrenTruncated: boolean;
};

/**
 * A bounded, presentation-safe description of child work. This deliberately
 * models user-visible activity instead of the LangChain messages, SSE events,
 * or durable records that produced it.
 */
export type SubagentActivityItem =
  | {
      type: 'writing';
      text: string;
      textTruncated?: boolean;
    }
  | {
      type: 'reasoning';
      /** Bounded user-visible reasoning text; absent on projections persisted
       *  before reasoning retention (rendered as a marker). */
      text?: string;
      textTruncated?: boolean;
    }
  | {
      type: 'activity_label';
      label: string;
      labelType?: 'phase';
      toolCallIds?: string[];
      activityStartIndex?: number;
      activityEndIndex?: number;
      activityCount?: number;
      agentIds?: string[];
      status?: 'ok' | 'partial' | 'failed';
      pending?: boolean;
      labelTruncated?: boolean;
    }
  | {
      type: 'tool';
      toolCallId: string;
      name: string;
      input?: string;
      output?: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      toolPreparationStartedAt?: number;
      toolDispatchedAt?: number;
      toolPreparationDurationMs?: number;
      toolExecutionDurationMs?: number;
      inputValidationError?: true;
      inputTruncated?: boolean;
      outputTruncated?: boolean;
    };

export type SubagentControlAction = 'steer' | 'queue' | 'interrupt' | 'cancel' | 'cancel_message';

export type SubagentControlReceipt = {
  invocationId: string;
  controlId?: string;
  action: SubagentControlAction;
  status: 'accepted' | 'applied' | 'rejected' | 'failed';
  createdAt: string;
  updatedAt: string;
  boundary?: 'preempt' | 'tool' | 'turn';
  reason?: string;
  message?: string;
  messageTruncated?: boolean;
};

export type SubagentControlRequest = {
  taskId: string;
  invocationId: string;
  action: SubagentControlAction;
  message?: string;
  controlId?: string;
};

export type SubagentControlResponse = {
  receipt: SubagentControlReceipt;
};

export type SubagentThreadMessage = {
  messageId: string;
  parentMessageId: string | null;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
  error?: boolean;
  textTruncated?: boolean;
};

export type SubagentThreadTriggerKind =
  | 'parent_dispatch'
  | 'parent_continuation'
  | 'external_event';

export type SubagentExternalEventDetails = {
  eventType: string;
  sourceType: string;
  occurredAt: string;
  expectedActionToolName?: string;
};

/**
 * One chronological child execution boundary. The trigger is host-authored,
 * while activity and messages are bounded public projections of the child run.
 */
export type SubagentThreadTurn = {
  taskId: string;
  trigger: {
    kind: SubagentThreadTriggerKind;
    summary: string;
    createdAt?: string;
    summaryTruncated?: boolean;
    externalEvent?: SubagentExternalEventDetails;
  };
  status: SubagentThreadStatus;
  activity: SubagentActivityItem[];
  activityTruncated: boolean;
  controlReceipts?: SubagentControlReceipt[];
  controlReceiptsTruncated?: boolean;
  messages: SubagentThreadMessage[];
};

export type SubagentThreadView = {
  threadId: string;
  parentConversationId: string;
  parentMessageId: string;
  parentToolCallId: string;
  subagentType: string;
  subagentKind: 'agent' | 'graph';
  /** Product recursion level, currently bounded to one by the host runtime. */
  depth?: number;
  agentId?: string;
  title: string;
  status: SubagentThreadStatus;
  /** Activity for the exact task requested by the parent card, when retained. */
  activity: SubagentActivityItem[];
  activityTruncated: boolean;
  /** Bounded authoritative parent-to-child command receipts for this task. */
  controlReceipts?: SubagentControlReceipt[];
  /** True when older authoritative command receipts were omitted from this view. */
  controlReceiptsTruncated?: boolean;
  /** Chronological, branch-selected child history for conversation-native rendering. */
  turns?: SubagentThreadTurn[];
  messages: SubagentThreadMessage[];
  historyTruncated: boolean;
  /** True when some branch rows were omitted and cannot be recovered with `nextCursor`. */
  historyUnavailable?: boolean;
  /** Opaque task-message cursor for the next older bounded branch page. */
  nextCursor?: string;
  updatedAt?: string;
};
