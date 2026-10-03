import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMethods } from '@librechat/data-schemas';
import { ScheduledMCPPolicyError } from './policy';

export type ScheduleMCPCompletionLookup = ScheduleMethods['getScheduleMCPCompletionState'];

/** Completion turns cannot adopt consent granted after their parent task was admitted. */
export async function resolveScheduleMCPCompletion(
  scope: Parameters<ScheduleMCPCompletionLookup>[0],
  lookup: ScheduleMCPCompletionLookup,
): Promise<ScheduledMCPIdentity | undefined> {
  const state = await lookup(scope);
  if (!state) return;
  if (state.enrolled)
    throw new ScheduledMCPPolicyError('binding_mismatch', '', state.identity.agentId);
  return state.identity;
}

/** Include pre-upgrade unbound continuations whose host supplied no completion marker. */
export function isScheduledMCPCompletionRequest(req: {
  _isAgentTrigger?: boolean;
  body?: Record<string, unknown>;
}): boolean {
  return (
    req._isAgentTrigger === true &&
    typeof req.body?.conversationId === 'string' &&
    req.body.agentTrigger == null &&
    req.body.agentEventDelivery == null
  );
}
