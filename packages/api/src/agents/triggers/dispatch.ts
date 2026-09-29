import type {
  AgentContinueTriggerEnvelope,
  AgentFireTriggerEnvelope,
  AgentSteerTriggerEnvelope,
  AgentTriggerEnvelope,
} from './envelope';
import { getAgentTriggerIdempotencyKey, parseAgentTriggerEnvelope } from './envelope';

export interface AgentTriggerDispatchContext {
  idempotencyKey: string;
  /** Durable delivery attempt metadata, when dispatched by the queue engine. */
  attempt?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export class AgentTriggerDispatchError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTriggerDispatchError';
  }
}

/**
 * Host-owned execution adapters. Each handler must enforce current authorization,
 * limits, persistence, and the supplied idempotency identity before accepting work.
 */
export interface AgentTriggerDispatchHandlers<FireResult, ContinueResult, SteerResult> {
  fire: (
    envelope: AgentFireTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ) => Promise<FireResult>;
  continue: (
    envelope: AgentContinueTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ) => Promise<ContinueResult>;
  steer: (
    envelope: AgentSteerTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ) => Promise<SteerResult>;
}

/** Routes a normalized trigger without coupling its source to an execution transport. */
export function dispatchAgentTrigger<FireResult, ContinueResult, SteerResult>(
  envelope: unknown,
  handlers: AgentTriggerDispatchHandlers<FireResult, ContinueResult, SteerResult>,
  options?: { signal?: AbortSignal; attempt?: number; maxAttempts?: number },
): Promise<ContinueResult | FireResult | SteerResult> {
  let normalized: AgentTriggerEnvelope;
  try {
    normalized = parseAgentTriggerEnvelope(envelope);
  } catch (error) {
    throw new AgentTriggerDispatchError(error instanceof Error ? error.message : String(error));
  }
  const context: AgentTriggerDispatchContext = {
    idempotencyKey: getAgentTriggerIdempotencyKey(normalized),
    ...(options?.attempt != null && { attempt: options.attempt }),
    ...(options?.maxAttempts != null && { maxAttempts: options.maxAttempts }),
    ...(options?.signal != null && { signal: options.signal }),
  };
  if (normalized.mode === 'fire') {
    return handlers.fire(normalized, context);
  }
  if (normalized.mode === 'continue') {
    return handlers.continue(normalized, context);
  }
  return handlers.steer(normalized, context);
}
