import { logger } from '@librechat/data-schemas';
import type { AgentQueuedTurnMethods } from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';

/** Optional so partial method bundles keep the previous behavior. */
export type QueuedTurnPrecedenceMethods = Partial<
  Pick<AgentQueuedTurnMethods, 'hasPendingAgentQueuedTurn'>
>;

function deferral(code: string, message: string): AgentTriggerExecutionError {
  return new AgentTriggerExecutionError(message, {
    mode: 'continue',
    certainty: 'definite',
    code,
    retryable: true,
    status: 409,
    retryAfter: '1',
    deferWithoutAttempt: true,
  });
}

/**
 * The deferral a completion wake-up must take so the user's queued turn gets
 * the conversation first, or null when the wake-up may proceed. Read under the
 * delivery's own principal and tenant. A failed read is not proof of absence,
 * so it defers too; neither deferral consumes a delivery attempt. The queued
 * turn's own generation then holds the conversation, and the wake-up resumes
 * after it on that turn's response.
 */
export async function getQueuedTurnDeferral(
  methods: QueuedTurnPrecedenceMethods,
  envelope: AgentContinueTriggerEnvelope,
  now: number,
): Promise<AgentTriggerExecutionError | null> {
  const hasPending = methods.hasPendingAgentQueuedTurn;
  if (hasPending == null) {
    return null;
  }
  try {
    const pending = await hasPending({
      userId: envelope.principal.userId,
      ...(envelope.principal.tenantId != null && { tenantId: envelope.principal.tenantId }),
      conversationId: envelope.target.conversationId,
      now: new Date(now),
    });
    return pending
      ? deferral('QUEUED_TURN_PENDING', 'A queued user turn is admitted before this wake-up.')
      : null;
  } catch (error) {
    logger.warn('[agent-triggers] Queued turn precedence is unavailable; deferring wake-up', {
      conversationId: envelope.target.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return deferral(
      'QUEUED_TURN_STATE_UNAVAILABLE',
      'Queued user turn state is temporarily unavailable.',
    );
  }
}
