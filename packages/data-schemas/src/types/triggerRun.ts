import type { ScheduleMCPOutcome, ScheduleRunStatus } from 'librechat-data-provider';
import type { IScheduleRun } from './schedule';

/**
 * What one run is found by: who it acts for and the delivery that started it. A run's own
 * subject and delivery fit as they are.
 */
export type TriggerRunRef = {
  readonly subject: { readonly kind: string; readonly id: string };
  readonly delivery: {
    /** The delivery's key in the trigger queue. A subscription's run is found by it. */
    readonly key?: string;
    readonly event: { readonly occurredAt: number };
  };
};

/** The kinds of subject whose runs are on record. */
export type RecordedKind = 'schedule' | 'subscription';

/**
 * The record of one run a trigger delivery started, as plain data: a schedule's, or an event
 * subscription's.
 */
export type TriggerRun = {
  subject: { kind: RecordedKind; id: string };
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
  /** The subject's revision the run started under, on a row that holds one. */
  revision?: number;
  abortRequestedAt?: Date;
  abortSource?: 'stop' | 'deletion';
  abortPersistedAt?: Date;
};

/**
 * A ref that always names a row: a schedule's, by its id and the time of the event, or a
 * subscription's with the key of its delivery.
 */
export type RecordedRunRef = TriggerRunRef &
  (
    | { readonly subject: { readonly kind: 'schedule' } }
    | {
        readonly subject: { readonly kind: 'subscription' };
        readonly delivery: { readonly key: string };
      }
  );

/**
 * The stored columns a run's row starts with, written as given. Which row it is comes from
 * the ref, so the two columns that name it are taken from there.
 */
export type TriggerRunRow = Partial<IScheduleRun>;

/**
 * Outcome of recording that a delivery's run started. Each conflict is decided by a unique
 * index in the same insert: this delivery already has a row (`duplicate`), another run of the
 * same schedule is active (`overlap`), or the capacity slot asked for is held (`slot-taken`).
 * A subscription's runs may overlap one another, so its insert never answers `overlap`.
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

/**
 * No row is kept under this ref, so nothing was written: a kind of subject whose runs are not
 * on record, or a subscription's delivery that names no key.
 */
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

/** A status a run ends in. */
export type TriggerRunEnd = Extract<
  ScheduleRunStatus,
  'success' | 'error' | 'interrupted' | 'skipped_balance' | 'skipped_overlap'
>;

/**
 * The cutoff a recovery replay passes when it acts on a snapshot that may be stale: the write
 * applies only while no resume claimed the run at or after it. A claim older than the cutoff
 * is taken as abandoned, so its run can still be recovered.
 */
type Replay = { resumeClaimStaleBefore?: Date };

/** What a run ended as, as it is written onto the row of a run still active. */
export type TriggerRunOutcome = Replay & {
  status: TriggerRunEnd;
  error?: string;
  mcp?: ScheduleMCPOutcome[];
  conversationId?: string;
  /** Erases the conversation the row reserved, in the same write: it was never created. */
  clearConversationId?: boolean;
  durationMs?: number;
};

/** What the row of a run takes when the run pauses for its owner. */
export type TriggerRunPause = Replay & {
  conversationId?: string;
  checkpointNamespace?: string;
};

/** The row of a run that never starts: its columns as given, with the skip it is recorded as. */
export type TriggerRunSkip = TriggerRunRow & {
  status: Extract<ScheduleRunStatus, 'skipped_overlap' | 'skipped_balance'>;
};

/**
 * What a row write hands the run's subject for the subject's own step: when the run fired,
 * or the time of the write for a row that holds none, and the revision it started under.
 */
export type TriggerRunOrigin = {
  firedAt: Date;
  revision?: number;
};

/**
 * A run's outcome as its row now holds it. The status and error are the ones written, which
 * differ from the ones asked for when a receipt on the row refuses the run; `mcp` is every
 * receipt on the row after the write.
 */
export type TriggerRunSettlement = TriggerRunOrigin & {
  status: TriggerRunEnd;
  error?: string;
  mcp?: ScheduleMCPOutcome[];
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
