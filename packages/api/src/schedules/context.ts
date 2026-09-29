/** Root actor for an owner-authorized schedule, preserved across subagents and handoffs. */
export interface ScheduledTokenContext {
  readonly scheduleId: string;
  readonly ownerId: string;
  readonly tenantId?: string;
  readonly agentId: string;
  readonly invocationMode: 'delegated';
}

interface ScheduleJobIdentity {
  userId?: string;
  tenantId?: string;
  scheduleId?: string;
  agent_id?: string;
}

/** Called by the resume host after job ownership, tenant, agent, and schedule checks. */
export function restoreScheduledTokenContext(
  req: { user: { id: string; tenantId?: string } },
  metadata?: ScheduleJobIdentity,
): ScheduledTokenContext | undefined {
  if (!metadata?.scheduleId) return;
  if (
    metadata.userId !== req.user.id ||
    (metadata.tenantId != null && metadata.tenantId !== req.user.tenantId)
  ) {
    throw new Error('Scheduled job identity does not match the authenticated owner.');
  }
  /** Legacy jobs remain resumable, but cannot claim a complete minting context. */
  if (!metadata.agent_id || (req.user.tenantId && metadata.tenantId == null)) return;
  return Object.freeze({
    scheduleId: metadata.scheduleId,
    ownerId: metadata.userId,
    ...(metadata.tenantId ? { tenantId: metadata.tenantId } : {}),
    agentId: metadata.agent_id,
    invocationMode: 'delegated',
  });
}
