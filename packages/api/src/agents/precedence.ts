import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { AgentQueuedTurnMethods } from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';

/** Optional so partial method bundles and older data layers keep the previous behavior. */
export type QueuedTurnPrecedenceMethods = Partial<
  Pick<AgentQueuedTurnMethods, 'hasPendingAgentQueuedTurn'>
>;

/**
 * Whether a completion wake-up must let the user's queued turn take the
 * conversation first. Read under the delivery's own principal and tenant; a
 * failed read answers false so a wake-up never waits on an unknown state.
 */
export async function yieldsToQueuedTurn(
  methods: QueuedTurnPrecedenceMethods,
  envelope: AgentContinueTriggerEnvelope,
  now: number,
): Promise<boolean> {
  const hasPending = methods.hasPendingAgentQueuedTurn;
  const userId = envelope.principal.userId;
  if (hasPending == null || !Types.ObjectId.isValid(userId)) {
    return false;
  }
  try {
    return await hasPending({
      user: new Types.ObjectId(userId),
      ...(envelope.principal.tenantId != null && { tenantId: envelope.principal.tenantId }),
      conversationId: envelope.target.conversationId,
      now: new Date(now),
    });
  } catch (error) {
    logger.warn('[agent-triggers] Queued turn precedence is unavailable; not deferring', {
      conversationId: envelope.target.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Defers the wake-up without consuming an attempt. The queued turn's own
 * generation then holds the conversation, so the wake-up resumes after it. */
export function queuedTurnPrecedenceError(): AgentTriggerExecutionError {
  return new AgentTriggerExecutionError('A queued user turn is admitted before this wake-up.', {
    mode: 'continue',
    certainty: 'definite',
    code: 'QUEUED_TURN_PENDING',
    retryable: true,
    status: 409,
    retryAfter: '1',
    deferWithoutAttempt: true,
  });
}
