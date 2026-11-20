/** Root actor for an owner-authorized schedule, preserved across subagents and handoffs. */
export interface ScheduledTokenContext {
  readonly scheduleId: string;
  readonly ownerId: string;
  readonly tenantId?: string;
  readonly agentId: string;
  readonly invocationMode: 'delegated';
}
