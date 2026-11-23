import type { Model } from 'mongoose';
import type { TriggerRun, TriggerRunRef, TriggerRunScope } from '~/types/triggerRun';
import type { IScheduleRun, IScheduleRunDocument } from '~/types/schedule';

type Field = keyof TriggerRun;
/** A row as one field's reader sees it: the read selected that field's columns. */
type Row = IScheduleRun;

/** The stored columns each field of a run is read from. */
const columns: Record<Field, string> = {
  subject: 'scheduleId',
  delivery: 'scheduledFor deliveryKey',
  owner: 'user',
  tenantId: 'tenantId',
  status: 'status',
  conversationId: 'conversationId',
  chatProjectId: 'chatProjectId',
  mcp: 'mcp',
  error: 'error',
  firedAt: 'firedAt',
  settledAt: 'settledAt',
  abortRequestedAt: 'abortRequestedAt',
  abortSource: 'abortSource',
  abortPersistedAt: 'abortPersistedAt',
};

const read: { [K in Field]: (row: Row) => TriggerRun[K] | undefined } = {
  subject: (row) => ({ kind: 'schedule', id: row.scheduleId }),
  delivery: (row) => ({
    at: row.scheduledFor,
    ...(row.deliveryKey != null && { key: row.deliveryKey }),
  }),
  owner: (row) => String(row.user),
  tenantId: (row) => row.tenantId,
  status: (row) => row.status,
  conversationId: (row) => row.conversationId,
  chatProjectId: (row) => row.chatProjectId,
  mcp: (row) => row.mcp,
  error: (row) => row.error,
  firedAt: (row) => row.firedAt,
  settledAt: (row) => row.settledAt,
  abortRequestedAt: (row) => row.abortRequestedAt,
  abortSource: (row) => row.abortSource,
  abortPersistedAt: (row) => row.abortPersistedAt,
};

function set<K extends Field>(run: Partial<TriggerRun>, field: K, row: Row): void {
  const value = read[field](row);
  if (value !== undefined) run[field] = value;
}

/** A stored `null` is kept and a missing column is left out, so the two stay distinct. */
function view<K extends Field>(row: Row, fields: readonly K[]): Pick<TriggerRun, K> {
  const run: Partial<TriggerRun> = {};
  for (const field of fields) set(run, field, row);
  // The projection named exactly these fields, and a row always holds the required ones.
  return run as Pick<TriggerRun, K>;
}

const project = (fields: readonly Field[]): string =>
  fields.map((field) => columns[field]).join(' ');

/**
 * Reads of the record a triggered run leaves, found by who the run acts for. Each takes the
 * fields to return and reads no other column.
 *
 * The record lives in the schedule run collection, where a row holds its subject's id as
 * `scheduleId` and the time of its delivery's event as `scheduledFor`. A schedule's delivery
 * carries both, so the pair names one row and the unique index on it answers the read. Only
 * schedules record runs: for a subject of any other kind there is no row to find.
 */
export type TriggerRuns = {
  /** The run a delivery started; `null` when none is on record. */
  get: <K extends Field>(
    ref: TriggerRunRef,
    fields: readonly K[],
  ) => Promise<Pick<TriggerRun, K> | null>;
  /**
   * The run that started a conversation, among one owner's runs of one subject; `null` when
   * none is on record. Should a conversation hold more than one, the latest fired stands.
   */
  byConversation: <K extends Field>(
    scope: TriggerRunScope,
    conversationId: string,
    fields: readonly K[],
  ) => Promise<Pick<TriggerRun, K> | null>;
};

export function createTriggerRuns(mongoose: typeof import('mongoose')): TriggerRuns {
  const Run = () => mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;

  async function get<K extends Field>(
    ref: TriggerRunRef,
    fields: readonly K[],
  ): Promise<Pick<TriggerRun, K> | null> {
    if (ref.subject.kind !== 'schedule') return null;
    const row = await Run()
      .findOne({
        scheduleId: ref.subject.id,
        scheduledFor: new Date(ref.delivery.event.occurredAt),
      })
      .select(project(fields))
      .lean<Row | null>();
    return row == null ? null : view(row, fields);
  }

  async function byConversation<K extends Field>(
    scope: TriggerRunScope,
    conversationId: string,
    fields: readonly K[],
  ): Promise<Pick<TriggerRun, K> | null> {
    if (scope.subject.kind !== 'schedule') return null;
    const row = await Run()
      .findOne({
        user: scope.owner,
        tenantId: scope.tenantId,
        conversationId,
        scheduleId: scope.subject.id,
      })
      .sort({ firedAt: -1 })
      .select(project(fields))
      .lean<Row | null>();
    return row == null ? null : view(row, fields);
  }

  return { get, byConversation };
}
