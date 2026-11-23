import { scheduledMCPIdentitySchema } from 'librechat-data-provider';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMethods } from '@librechat/data-schemas';
import type { IJobStore } from '~/stream/interfaces/IJobStore';
import { RunGrantPolicyError } from '~/agents/authority/policy';

export type ScheduleMCPCompletionLookup = ScheduleMethods['getScheduleMCPCompletionState'];

/**
 * Who a background task's completion turn acts for: the schedule that started the task, while
 * it still exists and still runs the same agent. The turn is another run of that agent, and
 * runs under whatever the schedule's owner allows when it starts: the grant the schedule
 * holds then, checked live like any run's, or none. From the run that started the task it
 * inherits one thing, which the run host puts back: the MCP servers that run's occurrence
 * went without.
 */
export async function resolveScheduleMCPCompletion(
  scope: { ownerId: string; tenantId: string | null; scheduleMCPIdentity?: unknown },
  lookup?: ScheduleMCPCompletionLookup,
): Promise<ScheduledMCPIdentity | undefined> {
  if (scope.scheduleMCPIdentity == null) return;
  const identity = parseScheduleMCPCompletion(scope.scheduleMCPIdentity);
  if (identity.ownerId !== scope.ownerId || identity.tenantId !== scope.tenantId)
    throw new RunGrantPolicyError('binding_mismatch', '', identity.agentId);
  if (!lookup) throw new RunGrantPolicyError('dependency_unavailable', '', identity.agentId);
  if (!(await lookup(identity)))
    throw new RunGrantPolicyError('binding_mismatch', '', identity.agentId);
  return identity;
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
    throw new RunGrantPolicyError('binding_mismatch', '');
  }
}

/** Complete the epoch-fenced write before tools or a checkpoint can execute. */
export async function retainScheduleMCPCompletion(
  identity: ScheduledMCPIdentity,
  scope: { streamId?: string; createdAt?: number },
  store: Pick<IJobStore, 'getJob' | 'updateJob'>,
): Promise<void> {
  if (!scope.streamId || scope.createdAt == null)
    throw new RunGrantPolicyError('binding_mismatch', '');
  const lineage = parseScheduleMCPCompletion(identity);
  const matches = (job: Awaited<ReturnType<IJobStore['getJob']>>) =>
    job != null &&
    job.createdAt === scope.createdAt &&
    job.userId === lineage.ownerId &&
    (job.tenantId ?? null) === lineage.tenantId;
  const job = await store.getJob(scope.streamId);
  if (!matches(job)) throw new RunGrantPolicyError('binding_mismatch', '');
  await store.updateJob(scope.streamId, { scheduleMCPCompletion: lineage }, scope.createdAt);
  const retained = await store.getJob(scope.streamId);
  if (
    !matches(retained) ||
    JSON.stringify(retained?.scheduleMCPCompletion) !== JSON.stringify(lineage)
  )
    throw new RunGrantPolicyError('dependency_unavailable', '');
}
