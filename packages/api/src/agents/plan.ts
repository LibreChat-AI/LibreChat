import type { TCheckpointerType } from 'librechat-data-provider';
import type { AgentTriggerExpectedAction } from './triggers/types';

export type AgentTurnOrigin = 'user' | 'subagent' | 'completion' | 'schedule' | 'event' | 'resume';

export type AgentTurnContinuationStrategy = 'checkpoint' | 'history' | 'fresh';

export interface AgentTurnBinding {
  bindingId: string;
  parentConversationId: string;
}

export interface AgentTurnExecutionPlan {
  origin: AgentTurnOrigin;
  strategy: AgentTurnContinuationStrategy;
  conversationId: string;
  parentMessageId?: string;
  canPause: boolean;
  expectedAction?: AgentTriggerExpectedAction;
  binding?: AgentTurnBinding;
}

export interface ResolveAgentTurnExecutionPlanInput {
  conversationId: string;
  parentMessageId?: string;
  isNewConversation: boolean;
  isResume?: boolean;
  isSchedule?: boolean;
  isSubagent?: boolean;
  isEvent?: boolean;
  event?: {
    type: string;
    binding?: AgentTurnBinding;
    expectedAction?: AgentTriggerExpectedAction;
  };
  canPause: boolean;
  /** Immutable request capability used only during mixed-version drain. This
   * is negotiated automatically and is never an operator-selected runtime. */
  durableEventActorSuspensions: boolean;
  checkpointerType?: TCheckpointerType;
}

const COMPLETION_EVENT_TYPE = 'subagent.completion';

function resolveOrigin(input: ResolveAgentTurnExecutionPlanInput): AgentTurnOrigin {
  if (input.isResume === true) {
    return 'resume';
  }
  if (input.isSchedule === true) {
    return 'schedule';
  }
  if (input.event?.type === COMPLETION_EVENT_TYPE) {
    return 'completion';
  }
  if (input.isSubagent === true) {
    return 'subagent';
  }
  if (input.isEvent === true || input.event != null) {
    return 'event';
  }
  return 'user';
}

/** Compiles already-loaded turn facts into one immutable state-loading decision. */
export function resolveAgentTurnExecutionPlan(
  input: ResolveAgentTurnExecutionPlanInput,
): AgentTurnExecutionPlan {
  const origin = resolveOrigin(input);
  const binding = input.event?.binding;
  const expectedAction = input.event?.expectedAction;
  const canAttemptCheckpoint =
    binding != null &&
    expectedAction != null &&
    input.checkpointerType !== 'memory' &&
    (!input.canPause || input.durableEventActorSuspensions);
  let strategy: AgentTurnContinuationStrategy = 'history';
  if (input.isNewConversation) {
    strategy = 'fresh';
  } else if (canAttemptCheckpoint) {
    strategy = 'checkpoint';
  }

  return Object.freeze({
    origin,
    strategy,
    conversationId: input.conversationId,
    ...(input.parentMessageId == null ? {} : { parentMessageId: input.parentMessageId }),
    canPause: input.canPause,
    ...(expectedAction == null ? {} : { expectedAction }),
    ...(binding == null ? {} : { binding }),
  });
}
