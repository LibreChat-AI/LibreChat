import type { ScheduleMCPOutcome, ScheduleRunStatus } from 'librechat-data-provider';

/**
 * What one run is found by: who it acts for and the delivery that started it. A run's own
 * subject and delivery fit as they are.
 */
export type TriggerRunRef = {
  readonly subject: { readonly kind: string; readonly id: string };
  readonly delivery: { readonly event: { readonly occurredAt: number } };
};

/**
 * The record of one run a trigger delivery started, as plain data. Every run on record
 * today is a schedule's.
 */
export type TriggerRun = {
  subject: { kind: 'schedule'; id: string };
  /** When the delivery's event occurred, and the delivery's key in the trigger queue. */
  delivery: { at: Date; key?: string };
  owner: string;
  tenantId?: string;
  status: ScheduleRunStatus;
  conversationId?: string;
  /** Absent on a run recorded before the field was; `null` for a run filed under no project. */
  chatProjectId?: string | null;
  mcp?: ScheduleMCPOutcome[];
  error?: string;
  firedAt?: Date;
  settledAt?: Date;
  abortRequestedAt?: Date;
  abortSource?: 'stop' | 'deletion';
  abortPersistedAt?: Date;
};

/** The runs of one subject that belong to one owner. */
export type TriggerRunScope = {
  readonly subject: TriggerRunRef['subject'];
  readonly owner: string;
  /** Matched as given: `null` or no tenant finds the runs that hold none. */
  readonly tenantId?: string | null;
};
