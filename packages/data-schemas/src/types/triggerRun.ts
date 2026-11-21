import type { ScheduleMCPOutcome, ScheduleRunStatus } from 'librechat-data-provider';
import type { IScheduleRun } from './schedule';

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

/** A ref to a run of the one kind of subject whose runs are on record. */
export type RecordedRunRef = TriggerRunRef & {
  readonly subject: { readonly kind: 'schedule' };
};

/**
 * The stored columns a run's row starts with, written as given. Which row it is comes from
 * the ref, so the two columns that name it are taken from there.
 */
export type TriggerRunRow = Partial<IScheduleRun>;

/**
 * Outcome of recording that a delivery's run started. Each conflict is decided by a unique
 * index in the same insert: this delivery already has a row (`duplicate`), another run of the
 * same subject is active (`overlap`), or the capacity slot asked for is held (`slot-taken`).
 */
export type TriggerRunReservation =
  | { run: IScheduleRun }
  | {
      conflict: 'duplicate' | 'overlap' | 'slot-taken';
      /**
       * For a `duplicate`, the status of the row that already holds this delivery. A settled
       * status means the run is finished; an active one means another worker still has it.
       */
      existingStatus?: ScheduleRunStatus;
    };

/** No record is kept for this kind of subject, so nothing was written. */
export type TriggerRunUnrecorded = { conflict: 'unrecorded' };

/**
 * Outcome of moving a paused run back among the started ones. Both conflicts are decided by
 * the same unique indexes as a first reservation.
 */
export type TriggerRunClaim =
  | { capacitySlot: number }
  | { conflict: 'not-paused' | 'overlap' | 'slot-taken' };

/** What a fire learns once its request is accepted, written onto the row it reserved. */
export type TriggerRunDetails = {
  conversationId: string;
  droppedFileIds?: string[];
  mcp?: ScheduleMCPOutcome[];
};

/** The conversation, and tenant if any, a live run must hold for a receipt to be added. */
export type TriggerRunBinding = {
  conversationId: string;
  tenantId?: string;
};

/** What a row must still hold for a rollback to delete it. */
export type TriggerRunExpectation = {
  status?: ScheduleRunStatus;
  conversationId?: string;
};

/** The runs of one subject that belong to one owner. */
export type TriggerRunScope = {
  readonly subject: TriggerRunRef['subject'];
  readonly owner: string;
  /** Matched as given: `null` or no tenant finds the runs that hold none. */
  readonly tenantId?: string | null;
};
