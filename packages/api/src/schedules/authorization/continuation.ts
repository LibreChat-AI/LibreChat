import { scheduledMCPIdentitySchema } from 'librechat-data-provider';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMethods } from '@librechat/data-schemas';
import type { IJobStore } from '~/stream/interfaces/IJobStore';
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

/** A malformed retained identity is never an ordinary, unrestricted job. */
export function parseScheduleMCPCompletion(
  value: unknown,
  serialized = false,
): ScheduledMCPIdentity {
  try {
    return scheduledMCPIdentitySchema.parse(
      serialized && typeof value === 'string' ? JSON.parse(value) : value,
    );
  } catch {
    throw new ScheduledMCPPolicyError('binding_mismatch', '');
  }
}

/** Complete the epoch-fenced write before tools or a checkpoint can execute. */
export async function retainScheduleMCPCompletion(
  identity: ScheduledMCPIdentity,
  scope: { streamId?: string; createdAt?: number },
  store: Pick<IJobStore, 'getJob' | 'updateJob'>,
): Promise<void> {
  if (!scope.streamId || scope.createdAt == null)
    throw new ScheduledMCPPolicyError('binding_mismatch', '');
  const lineage = parseScheduleMCPCompletion(identity);
  const matches = (job: Awaited<ReturnType<IJobStore['getJob']>>) =>
    job != null &&
    job.createdAt === scope.createdAt &&
    job.userId === lineage.ownerId &&
    (job.tenantId ?? null) === lineage.tenantId;
  const job = await store.getJob(scope.streamId);
  if (!matches(job)) throw new ScheduledMCPPolicyError('binding_mismatch', '');
  await store.updateJob(scope.streamId, { scheduleMCPCompletion: lineage }, scope.createdAt);
  const retained = await store.getJob(scope.streamId);
  if (
    !matches(retained) ||
    JSON.stringify(retained?.scheduleMCPCompletion) !== JSON.stringify(lineage)
  )
    throw new ScheduledMCPPolicyError('dependency_unavailable', '');
}
