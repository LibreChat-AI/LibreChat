import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runGrantFailureReasonSchema } from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  TriggerRunRef,
  TriggerRunSkip,
  TriggerRunPause,
  TriggerRunOutcome,
} from '~/types/triggerRun';
import type {
  ISchedule,
  IScheduleRun,
  IScheduleDocument,
  IScheduleRunDocument,
} from '~/types/schedule';
import type { ScheduleMethods } from './schedule';
import type { TriggerRuns } from './triggerRun';
import { createScheduleMethods } from './schedule';
import { createTriggerRuns } from './triggerRun';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const { BSON } = mongoose.mongo;

let mongoServer: MongoMemoryServer;
let Schedule: Model<IScheduleDocument>;
let ScheduleRun: Model<IScheduleRunDocument>;
let schedules: ScheduleMethods;
let runs: TriggerRuns;

type Command = { method: string; args: unknown[] };
let sent: Array<Command & { collection: string }> = [];

/** The clock every test runs under, so a stamp a writer takes from it is a known value. */
const now = new Date('2026-11-21T12:00:00.000Z');
const minutes = (count: number): Date => new Date(now.getTime() - count * 60_000);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Schedule = mongoose.models.Schedule as Model<IScheduleDocument>;
  ScheduleRun = mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;
  await Schedule.init();
  await ScheduleRun.init();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  mongoose.set('debug', false);
  await mongoose.disconnect();
  await mongoServer?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  mongoose.set('debug', false);
  await Schedule.deleteMany({});
  await ScheduleRun.deleteMany({});
  sent = [];
  // Only the date is held still: the driver keeps its real timers.
  jest.useFakeTimers({
    now,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  // Built for each test, not once for the file, so a test that writes through them is also
  // the test that covers how they are put together.
  schedules = createScheduleMethods(mongoose);
  runs = createTriggerRuns(mongoose);
});

afterEach(() => {
  mongoose.set('debug', false);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** A value as the driver encodes it: plain data, in the key order it goes out in. */
const wire = <T>(value: T): T => BSON.deserialize(BSON.serialize({ value })).value as T;

/** Text that differs whenever a key, a value, a type or the order of keys does. */
const text = (value: unknown): string => BSON.EJSON.stringify(wire(value), undefined, 1);

/** Records every command sent to the run collection and to the schedule collection. */
function record(): void {
  sent = [];
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    if (method === 'createIndex') return;
    if (collection === ScheduleRun.collection.name || collection === Schedule.collection.name) {
      sent.push({ collection, ...wire({ method, args }) });
    }
  });
}

/** What was sent to the run collection, with the id an insert generates left out. */
function commands(): Command[] {
  mongoose.set('debug', false);
  return sent
    .filter(({ collection }) => collection === ScheduleRun.collection.name)
    .map(({ method, args }) => {
      if (method !== 'insertOne') return { method, args };
      const [doc, ...rest] = args as [Record<string, unknown>, ...unknown[]];
      const { _id, ...columns } = doc;
      expect(_id).toBeInstanceOf(mongoose.Types.ObjectId);
      return { method, args: [columns, ...rest] };
    });
}

/** Which collection each command went to, in the order they were sent. */
function order(): string[] {
  mongoose.set('debug', false);
  return sent.map(({ collection, method }) =>
    collection === ScheduleRun.collection.name ? `run ${method}` : `schedule ${method}`,
  );
}

const owner = new mongoose.Types.ObjectId();
const at = new Date('2026-11-21T08:00:00.000Z');
const fired = new Date('2026-11-21T08:00:01.000Z');
const before = new Date('2026-11-20T08:00:00.000Z');
const ready: ScheduleMCPOutcome = { server: 'Mail', status: 'ready' };
/** A tool that found no authorization it could use with nobody there. */
const unattended: ScheduleMCPOutcome = {
  server: 'Graph',
  status: 'mcp_configuration_missing',
  detail: 'unattended_auth_required',
};
/** A grant failure that is not replayed, with keys in the order the model stores them. */
const revoked: ScheduleMCPOutcome = {
  server: 'Graph',
  agentId: 'child',
  reason: runGrantFailureReasonSchema.enum.consent_revoked,
  recovery: 'authorize',
  automaticReplay: false,
  status: 'mcp_reauth_required',
};
const refusal = 'MCP unattended authorization unavailable';

/** What mongoose adds to every update of this collection: a column no read returns. */
const hidden = { projection: { checkpointNamespace: 0 } };
const after = { ...hidden, returnDocument: 'after', returnOriginal: false };
const prior = { ...hidden, returnDocument: 'before', returnOriginal: true };
const key = { scheduleId: 'sched_a', scheduledFor: at };
const live = { ...key, status: { $in: ['started', 'requires_action'] } };
const refusals = [
  { 'mcp.detail': 'unattended_auth_required' },
  {
    mcp: {
      $elemMatch: {
        reason: { $in: runGrantFailureReasonSchema.options },
        status: { $ne: 'ready' },
        automaticReplay: false,
      },
    },
  },
];
const unclaimed = (cutoff: Date) => ({
  $or: [{ resumeClaimedAt: { $exists: false } }, { resumeClaimedAt: { $lt: cutoff } }],
});
/** The update that marks a run as settled with its subject. */
const mark: Command = {
  method: 'updateOne',
  args: [
    key,
    { $setOnInsert: { createdAt: now }, $set: { bookkept: true, updatedAt: now } },
    hidden,
  ],
};
/** The update that ends a run, with its operators in the order mongoose sends them. */
const ending = (
  set: Record<string, unknown>,
  extra: { unset?: Record<string, 1>; add?: ScheduleMCPOutcome[] } = {},
): Record<string, unknown> => ({
  $setOnInsert: { createdAt: now },
  $unset: { capacitySlot: 1, admissionOnly: 1, ...extra.unset },
  ...(extra.add && { $addToSet: { mcp: { $each: extra.add } } }),
  $set: { ...set, updatedAt: now },
});
const pausing = (set: Record<string, unknown> = {}): Record<string, unknown> => ({
  $setOnInsert: { createdAt: now },
  $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
  $set: { status: 'requires_action', ...set, updatedAt: now },
});

function ref(id: string, when: Date, kind = 'schedule'): TriggerRunRef {
  return { subject: { kind, id }, delivery: { event: { occurredAt: when.getTime() } } };
}
const here = ref('sched_a', at);

function row(overrides: Partial<IScheduleRun> = {}): Partial<IScheduleRun> {
  return {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: at,
    firedAt: fired,
    status: 'started',
    conversationId: 'conversation-a',
    capacitySlot: 2,
    configRevision: 7,
    createdAt: before,
    updatedAt: before,
    ...overrides,
  };
}

/** A row with the named columns left off it, as a row written before they existed is. */
function without(
  columns: Array<keyof IScheduleRun>,
  overrides: Partial<IScheduleRun> = {},
): Partial<IScheduleRun> {
  const data = row(overrides);
  for (const column of columns) delete data[column];
  return data;
}

/** Puts a row in the collection as it is given, past the model and its timestamps. */
async function seed(...rows: Array<Partial<IScheduleRun>>): Promise<void> {
  await ScheduleRun.collection.insertMany(rows.map((data) => ({ ...data })));
}

/** Every row on record, without the ids the database gave them. */
async function stored(): Promise<Array<Partial<IScheduleRun>>> {
  const rows = await ScheduleRun.collection
    .find({}, { projection: { _id: 0 } })
    .sort({ scheduleId: 1, scheduledFor: 1 })
    .toArray();
  return rows as Array<Partial<IScheduleRun>>;
}

async function only(): Promise<Partial<IScheduleRun>> {
  const rows = await stored();
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The schedule the runs above belong to, at the revision they started under. */
async function plan(overrides: Record<string, unknown> = {}): Promise<void> {
  await Schedule.collection.insertOne({
    id: 'sched_a',
    user: owner,
    name: 'Digest',
    prompt: 'Summarize',
    agent_id: 'agent_test',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'UTC',
    target: 'new',
    enabled: true,
    runCount: 3,
    failureCount: 1,
    balanceSkipCount: 1,
    configRevision: 7,
    createdAt: before,
    updatedAt: before,
    ...overrides,
  });
}

async function card(): Promise<ISchedule> {
  const doc = await Schedule.collection.findOne({ id: 'sched_a' }, { projection: { _id: 0 } });
  return doc as unknown as ISchedule;
}

type Outcome = Parameters<ScheduleMethods['recordRunOutcome']>[0];
const occurrence = { scheduleId: 'sched_a', scheduledFor: at, autoDisableAfterFailures: 5 };

/** The three ways a run's row is settled, addressed the same way whichever object does it. */
type Settlers = {
  finish: (outcome: TriggerRunOutcome) => Promise<void>;
  pause: (hold?: TriggerRunPause) => Promise<void>;
  skip: (data: TriggerRunSkip & { scheduleId: string; scheduledFor: Date }) => Promise<void>;
};

const paths: Array<[string, () => Settlers]> = [
  [
    'the schedule methods',
    () => ({
      finish: (outcome) => schedules.recordRunOutcome({ ...occurrence, ...outcome }),
      pause: (hold = {}) =>
        schedules.recordRunOutcome({ ...occurrence, status: 'requires_action', ...hold }),
      skip: (data) => schedules.recordSkippedRun(data),
    }),
  ],
  [
    'the run record',
    () => ({
      finish: async (outcome) => {
        if ((await runs.finish(here, outcome)) != null) await runs.settled(here);
      },
      pause: async (hold = {}) => {
        await runs.pause(here, hold);
      },
      skip: async (data) => {
        const where = ref(data.scheduleId, data.scheduledFor);
        if ((await runs.skip(where, data)) != null) await runs.settled(where);
      },
    }),
  ],
];

describe.each(paths)('the commands sent to the run collection by %s', (_name, build) => {
  let settle: Settlers;
  beforeEach(() => {
    settle = build();
  });

  it('ends a run in one update that merges its receipts and frees its slot, then marks it', async () => {
    await seed(row({ admissionOnly: true, mcp: [ready] }));
    record();
    await settle.finish({
      status: 'success',
      conversationId: 'conversation-b',
      durationMs: 1200,
      mcp: [ready, { server: 'Files', status: 'ready' }],
    });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            { ...live, $nor: refusals },
            ending(
              {
                status: 'success',
                bookkept: false,
                settledAt: now,
                conversationId: 'conversation-b',
                durationMs: 1200,
              },
              { add: [ready, { server: 'Files', status: 'ready' }] },
            ),
            after,
          ],
        },
        mark,
      ]),
    );
    expect(await only()).toEqual({
      ...without(['capacitySlot']),
      status: 'success',
      conversationId: 'conversation-b',
      mcp: [ready, { server: 'Files', status: 'ready' }],
      durationMs: 1200,
      settledAt: now,
      bookkept: true,
      updatedAt: now,
    });
  });

  it('sets nothing a run did not report', async () => {
    await seed(row());
    record();
    await settle.finish({ status: 'interrupted', conversationId: '', error: '', mcp: [] });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            { ...live, $nor: refusals },
            ending({ status: 'interrupted', bookkept: false, settledAt: now }),
            after,
          ],
        },
        mark,
      ]),
    );
  });

  it('writes an error and a duration of zero', async () => {
    await seed(row());
    record();
    await settle.finish({ status: 'error', error: 'provider unavailable', durationMs: 0 });

    expect(text(commands()[0])).toBe(
      text({
        method: 'findOneAndUpdate',
        args: [
          { ...live, $nor: refusals },
          ending({
            status: 'error',
            bookkept: false,
            settledAt: now,
            error: 'provider unavailable',
            durationMs: 0,
          }),
          after,
        ],
      }),
    );
    expect(await only()).toMatchObject({ status: 'error', error: 'provider unavailable' });
  });

  it('erases the conversation a run reserved instead of setting the one it names', async () => {
    await seed(row());
    record();
    await settle.finish({
      status: 'interrupted',
      conversationId: 'conversation-a',
      clearConversationId: true,
    });

    expect(text(commands()[0])).toBe(
      text({
        method: 'findOneAndUpdate',
        args: [
          { ...live, $nor: refusals },
          ending(
            { status: 'interrupted', bookkept: false, settledAt: now },
            { unset: { conversationId: 1 } },
          ),
          after,
        ],
      }),
    );
    expect(await only()).not.toHaveProperty('conversationId');
  });

  it.each([
    ['a tool that found no authorization', unattended],
    ['a grant failure that is not replayed', revoked],
  ])('ends a run as an error in a second update when %s is on its row', async (_case, receipt) => {
    await seed(row({ mcp: [receipt] }));
    record();
    await settle.finish({ status: 'success', conversationId: 'conversation-a' });

    const set = {
      bookkept: false,
      settledAt: now,
      conversationId: 'conversation-a',
    };
    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [{ ...live, $nor: refusals }, ending({ status: 'success', ...set }), after],
        },
        {
          method: 'findOneAndUpdate',
          args: [
            { $and: [live, { $or: refusals }] },
            ending({
              status: 'error',
              bookkept: false,
              settledAt: now,
              conversationId: 'conversation-a',
              error: refusal,
            }),
            after,
          ],
        },
        mark,
      ]),
    );
    expect(await only()).toMatchObject({ status: 'error', error: refusal, bookkept: true });
  });

  it('sends a failed run through the same two updates, keeping the error it reported', async () => {
    await seed(row({ mcp: [revoked] }));
    record();
    await settle.finish({ status: 'error', error: 'provider unavailable' });

    const failed = ending({
      status: 'error',
      bookkept: false,
      settledAt: now,
      error: 'provider unavailable',
    });
    expect(text(commands())).toBe(
      text([
        { method: 'findOneAndUpdate', args: [{ ...live, $nor: refusals }, failed, after] },
        { method: 'findOneAndUpdate', args: [{ $and: [live, { $or: refusals }] }, failed, after] },
        mark,
      ]),
    );
    expect(await only()).toMatchObject({ status: 'error', error: 'provider unavailable' });
  });

  it.each(['interrupted', 'skipped_balance'] as const)(
    'ends a run asked to settle as %s as an error when a receipt on its row refuses it',
    async (status) => {
      await seed(row({ mcp: [unattended] }));
      await settle.finish({ status, error: 'not an error status' });

      expect(await only()).toMatchObject({ status: 'error', error: refusal });
    },
  );

  it('settles an overlap skip in one update whatever receipts its row holds', async () => {
    await seed(row({ mcp: [revoked] }));
    record();
    await settle.finish({ status: 'skipped_overlap' });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            live,
            ending({ status: 'skipped_overlap', bookkept: false, settledAt: now }),
            after,
          ],
        },
        mark,
      ]),
    );
    expect(await only()).toMatchObject({ status: 'skipped_overlap', bookkept: true });
  });

  it('sends one update and no mark for an overlap skip with no active run', async () => {
    await seed(row({ status: 'success', bookkept: true }));
    record();
    await settle.finish({ status: 'skipped_overlap' });

    expect(commands()).toHaveLength(1);
    expect(await only()).toEqual(row({ status: 'success', bookkept: true }));
  });

  it.each([
    ['no run is on record', []],
    ['the run has settled', [row({ status: 'success', settledAt: before, bookkept: true })]],
    ['the run was skipped', [row({ status: 'skipped_balance', bookkept: false })]],
  ])('changes nothing and marks nothing when %s', async (_case, rows) => {
    if (rows.length) await seed(...rows);
    record();
    await settle.finish({ status: 'error', error: 'late' });

    expect(commands().map(({ method }) => method)).toEqual([
      'findOneAndUpdate',
      'findOneAndUpdate',
    ]);
    expect(await stored()).toEqual(rows);
  });

  it('holds a replay off a run a resume claimed after its cutoff', async () => {
    const claimed = row({ resumeClaimedAt: minutes(1), mcp: [unattended] });
    await seed(claimed);
    record();
    await settle.finish({ status: 'success', resumeClaimStaleBefore: minutes(5) });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            { ...unclaimed(minutes(5)), ...live, $nor: refusals },
            ending({ status: 'success', bookkept: false, settledAt: now }),
            after,
          ],
        },
        {
          method: 'findOneAndUpdate',
          args: [
            { $and: [{ ...live, ...unclaimed(minutes(5)) }, { $or: refusals }] },
            ending({ status: 'error', bookkept: false, settledAt: now, error: refusal }),
            after,
          ],
        },
      ]),
    );
    expect(await only()).toEqual(claimed);
  });

  it.each([
    ['a claim older than its cutoff', { resumeClaimedAt: minutes(10) }],
    ['no claim', {}],
  ])('lets a replay end a run that holds %s', async (_case, claim) => {
    await seed(row(claim));
    await settle.finish({
      status: 'error',
      error: 'abandoned',
      resumeClaimStaleBefore: minutes(5),
    });

    expect(await only()).toMatchObject({ status: 'error', error: 'abandoned', bookkept: true });
  });

  it('ends a paused run', async () => {
    await seed(without(['capacitySlot'], { status: 'requires_action' }));
    await settle.finish({ status: 'success' });

    expect(await only()).toMatchObject({ status: 'success', settledAt: now, bookkept: true });
  });

  it('pauses a run in one update that frees its slot and clears its claim', async () => {
    await seed(row({ resumeClaimedAt: minutes(1) }));
    record();
    await settle.pause({ conversationId: 'conversation-b', checkpointNamespace: 'ns-1' });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            { ...live, $nor: refusals },
            pausing({ conversationId: 'conversation-b', checkpointNamespace: 'ns-1' }),
            prior,
          ],
        },
      ]),
    );
    expect(await only()).toEqual({
      ...without(['capacitySlot']),
      status: 'requires_action',
      conversationId: 'conversation-b',
      checkpointNamespace: 'ns-1',
      updatedAt: now,
    });
  });

  it('pauses a run that named no conversation, keeping an empty checkpoint namespace', async () => {
    await seed(row());
    record();
    await settle.pause({ conversationId: '', checkpointNamespace: '' });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [{ ...live, $nor: refusals }, pausing({ checkpointNamespace: '' }), prior],
        },
      ]),
    );
  });

  it('pauses with nothing but the status when a run reports nothing else', async () => {
    await seed(row());
    record();
    await settle.pause();

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [{ ...live, $nor: refusals }, pausing(), prior],
        },
      ]),
    );
    expect(await only()).toMatchObject({
      status: 'requires_action',
      conversationId: 'conversation-a',
    });
  });

  it('leaves out a checkpoint namespace and a duration that are null', async () => {
    // What a caller outside the types hands over where a value is optional.
    const nothing = null as unknown as undefined;
    await seed(row());
    record();
    await settle.pause({ checkpointNamespace: nothing });
    await settle.finish({ status: 'success', durationMs: nothing });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [{ ...live, $nor: refusals }, pausing(), prior],
        },
        {
          method: 'findOneAndUpdate',
          args: [
            { ...live, $nor: refusals },
            ending({ status: 'success', bookkept: false, settledAt: now }),
            after,
          ],
        },
        mark,
      ]),
    );
  });

  it('answers a pause again for a run that is already paused', async () => {
    await seed(without(['capacitySlot'], { status: 'requires_action', updatedAt: before }));
    await settle.pause();

    expect(await only()).toMatchObject({ status: 'requires_action', updatedAt: now });
  });

  it.each([
    ['a tool that found no authorization', unattended],
    ['a grant failure that is not replayed', revoked],
  ])('does not pause a run with %s on its row', async (_case, receipt) => {
    const refused = row({ mcp: [receipt] });
    await seed(refused);
    record();
    await settle.pause();

    expect(commands()).toHaveLength(1);
    expect(await only()).toEqual(refused);
  });

  it('pauses a run whose receipts refuse nothing', async () => {
    await seed(
      row({
        mcp: [
          ready,
          { ...revoked, status: 'ready' },
          { server: 'Graph', status: 'mcp_reauth_required', reason: 'consent_revoked' },
          { server: 'Graph', status: 'mcp_reauth_required', automaticReplay: false },
        ],
      }),
    );
    await settle.pause();

    expect(await only()).toMatchObject({ status: 'requires_action' });
  });

  it('does not pause a run that has settled', async () => {
    const done = row({ status: 'success', settledAt: before, bookkept: true });
    await seed(done);
    await settle.pause();

    expect(await only()).toEqual(done);
  });

  it('holds a replayed pause off a run a resume claimed after its cutoff', async () => {
    const claimed = row({ resumeClaimedAt: minutes(1) });
    await seed(claimed);
    record();
    await settle.pause({ resumeClaimStaleBefore: minutes(5) });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [{ ...unclaimed(minutes(5)), ...live, $nor: refusals }, pausing(), prior],
        },
      ]),
    );
    expect(await only()).toEqual(claimed);
  });

  it.each([
    ['a claim older than its cutoff', { resumeClaimedAt: minutes(10) }],
    ['no claim', {}],
  ])('lets a replayed pause take a run that holds %s', async (_case, claim) => {
    await seed(row(claim));
    await settle.pause({ resumeClaimStaleBefore: minutes(5) });

    const paused = await only();
    expect(paused).toMatchObject({ status: 'requires_action' });
    expect(paused).not.toHaveProperty('resumeClaimedAt');
    expect(paused).not.toHaveProperty('capacitySlot');
  });

  const skipped = {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: at,
    firedAt: now,
    status: 'skipped_balance',
    bookkept: false,
    settledAt: now,
    configRevision: 7,
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };

  it('inserts the row of a skipped run with its fire and settle times, then marks it', async () => {
    record();
    await settle.skip({
      scheduleId: 'sched_a',
      user: owner,
      scheduledFor: at,
      status: 'skipped_balance',
      configRevision: 7,
      firedAt: before,
      settledAt: before,
      bookkept: true,
    });

    expect(text(commands())).toBe(text([{ method: 'insertOne', args: [skipped, {}] }, mark]));
    expect(await only()).toEqual({ ...skipped, bookkept: true });
  });

  it('reads the row in the way only after the insert is refused, and marks the same skip', async () => {
    await seed(row({ status: 'skipped_balance', bookkept: false }));
    record();
    await settle.skip({
      scheduleId: 'sched_a',
      user: owner,
      scheduledFor: at,
      status: 'skipped_balance',
      configRevision: 7,
    });

    expect(text(commands())).toBe(
      text([
        { method: 'insertOne', args: [skipped, {}] },
        {
          method: 'findOne',
          args: [key, { projection: { status: 1, configRevision: 1, firedAt: 1 } }],
        },
        mark,
      ]),
    );
    expect(await only()).toMatchObject({
      status: 'skipped_balance',
      firedAt: fired,
      bookkept: true,
    });
  });

  it.each([
    ['a run that started', row()],
    ['a run that settled', row({ status: 'success', bookkept: true })],
    ['the other skip', row({ status: 'skipped_overlap', bookkept: false })],
  ])('marks nothing when the row in the way is %s', async (_case, existing) => {
    await seed(existing);
    record();
    await settle.skip({
      scheduleId: 'sched_a',
      user: owner,
      scheduledFor: at,
      status: 'skipped_balance',
    });

    expect(commands().map(({ method }) => method)).toEqual(['insertOne', 'findOne']);
    expect(await only()).toEqual(existing);
  });

  it('lets a failure of the insert that is not a duplicate through', async () => {
    jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      settle.skip({
        scheduleId: 'sched_a',
        user: owner,
        scheduledFor: at,
        status: 'skipped_overlap',
      }),
    ).rejects.toThrow('connection reset');
    expect(await stored()).toEqual([]);
  });
});

describe('what the run record answers', () => {
  it('answers a pause with the fire time and revision the row held', async () => {
    await seed(row());
    expect(await runs.pause(here, {})).toStrictEqual({ firedAt: fired, revision: 7 });
  });

  it('answers a pause with the time of the write for a row that holds neither', async () => {
    await seed(without(['firedAt', 'configRevision']));
    expect(await runs.pause(here, {})).toStrictEqual({ firedAt: now, revision: undefined });
  });

  it.each([
    ['no run is on record', []],
    ['the run has settled', [row({ status: 'error' })]],
    ['a receipt refuses the run', [row({ mcp: [unattended] })]],
  ])('answers a pause with nothing when %s', async (_case, rows) => {
    if (rows.length) await seed(...rows);
    expect(await runs.pause(here, {})).toBeNull();
  });

  it('answers with the outcome as written and every receipt now on the row', async () => {
    await seed(row({ mcp: [ready] }));
    const files: ScheduleMCPOutcome = { server: 'Files', status: 'ready' };

    expect(await runs.finish(here, { status: 'success', mcp: [files] })).toStrictEqual({
      status: 'success',
      error: undefined,
      mcp: [ready, files],
      firedAt: fired,
      revision: 7,
    });
    expect(await only()).toMatchObject({ status: 'success', bookkept: false });
  });

  it('answers with the time of the write for a row that holds no fire time or revision', async () => {
    await seed(without(['firedAt', 'configRevision']));

    expect(
      await runs.finish(here, { status: 'error', error: 'provider unavailable' }),
    ).toStrictEqual({
      status: 'error',
      error: 'provider unavailable',
      mcp: undefined,
      firedAt: now,
      revision: undefined,
    });
  });

  it('ends a run as an error when the outcome brings a receipt that refuses it', async () => {
    await seed(row());

    expect(
      await runs.finish(here, { status: 'success', error: 'not an error status', mcp: [revoked] }),
    ).toMatchObject({ status: 'error', error: refusal, mcp: [revoked] });
    expect(await only()).toMatchObject({ status: 'error', error: refusal });
  });

  it('keeps the error of a failed run whose outcome brings a refusing receipt', async () => {
    await seed(row());

    expect(
      await runs.finish(here, {
        status: 'error',
        error: 'provider unavailable',
        mcp: [unattended],
      }),
    ).toMatchObject({ status: 'error', error: 'provider unavailable' });
  });

  it('gives a failed run that reported no error the refusal as its error', async () => {
    await seed(row());

    expect(await runs.finish(here, { status: 'error', mcp: [unattended] })).toMatchObject({
      status: 'error',
      error: refusal,
    });
    expect(await only()).toMatchObject({ status: 'error', error: refusal });
  });

  it('does not read a receipt the run was started without as a refusal', async () => {
    await seed(row());
    const left: ScheduleMCPOutcome = { ...unattended, skipped: true };

    expect(await runs.finish(here, { status: 'success', mcp: [left] })).toMatchObject({
      status: 'success',
      error: undefined,
    });
  });

  it('lets an overlap skip stand whatever receipts its outcome brings', async () => {
    await seed(row());

    expect(await runs.finish(here, { status: 'skipped_overlap', mcp: [revoked] })).toMatchObject({
      status: 'skipped_overlap',
      error: undefined,
    });
  });

  it('answers with the error it wrote and the receipts on the row when the row refuses the run', async () => {
    await seed(row({ mcp: [revoked] }));

    expect(await runs.finish(here, { status: 'success' })).toStrictEqual({
      status: 'error',
      error: refusal,
      mcp: [revoked],
      firedAt: fired,
      revision: 7,
    });
  });

  it.each([
    ['no run is on record', []],
    ['the run has settled', [row({ status: 'success' })]],
  ])('answers an ending with nothing when %s', async (_case, rows) => {
    if (rows.length) await seed(...rows);
    expect(await runs.finish(here, { status: 'success' })).toBeNull();
    expect(await runs.finish(here, { status: 'skipped_overlap' })).toBeNull();
  });

  it('answers a skip it inserted with the time of the write and the revision given', async () => {
    expect(
      await runs.skip(here, { user: owner, status: 'skipped_overlap', configRevision: 9 }),
    ).toStrictEqual({ firedAt: now, revision: 9 });
    expect(await only()).toMatchObject({ ...key, status: 'skipped_overlap', bookkept: false });
  });

  it('names the row of a skip from what it is found by, not from the columns given', async () => {
    await runs.skip(here, {
      scheduleId: 'sched_b',
      scheduledFor: before,
      user: owner,
      status: 'skipped_overlap',
    });
    expect(await only()).toMatchObject(key);
  });

  it('answers a repeated skip from the row already there, not from the retry', async () => {
    await seed(row({ status: 'skipped_balance', bookkept: false }));

    expect(
      await runs.skip(here, { user: owner, status: 'skipped_balance', configRevision: 9 }),
    ).toStrictEqual({ firedAt: fired, revision: 7 });
  });

  it('answers a repeated skip with the time of the retry for a row that holds no fire time', async () => {
    await seed(without(['firedAt', 'configRevision'], { status: 'skipped_balance' }));

    expect(await runs.skip(here, { user: owner, status: 'skipped_balance' })).toStrictEqual({
      firedAt: now,
      revision: undefined,
    });
  });

  it('answers a skip with nothing when the row in the way is not the same skip', async () => {
    await seed(row({ status: 'skipped_overlap' }));
    expect(await runs.skip(here, { user: owner, status: 'skipped_balance' })).toBeNull();
  });

  it('answers a skip with nothing when the row in the way is gone before it is read', async () => {
    jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce({ code: 11000 });
    expect(await runs.skip(here, { user: owner, status: 'skipped_balance' })).toBeNull();
  });

  it.each([
    ['nothing at all', null],
    ['an error with another code', { code: 121 }],
  ])('lets a refused insert of a skip through when it is %s', async (_case, error) => {
    jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce(error);
    await expect(runs.skip(here, { user: owner, status: 'skipped_balance' })).rejects.toBe(error);
  });

  it('marks only the run it is given', async () => {
    const other = new Date('2026-11-21T09:00:00.000Z');
    await seed(
      row({ status: 'success', bookkept: false }),
      row({ scheduledFor: other, status: 'success', bookkept: false, capacitySlot: 3 }),
    );
    await runs.settled(here);

    expect(await stored()).toMatchObject([{ bookkept: true }, { bookkept: false }]);
  });

  it('reads the revision a run started under', async () => {
    await seed(row());
    record();
    expect(await runs.get(here, ['revision', 'firedAt'])).toStrictEqual({
      revision: 7,
      firedAt: fired,
    });
    expect(text(commands())).toBe(
      text([{ method: 'findOne', args: [key, { projection: { configRevision: 1, firedAt: 1 } }] }]),
    );
  });
});

describe('a subject whose runs are not on record', () => {
  it.each(['key', 'subscription'])(
    'settles nothing for a %s with no delivery key',
    async (kind) => {
      const started = row();
      await seed(started);
      const other = ref('sched_a', at, kind);
      record();

      expect(await runs.pause(other, { conversationId: 'conversation-b' })).toBeNull();
      expect(await runs.finish(other, { status: 'success' })).toBeNull();
      expect(
        await runs.skip(ref('sched_a', before, kind), { user: owner, status: 'skipped_overlap' }),
      ).toBeNull();
      expect(await runs.settled(other)).toBeUndefined();

      expect(commands()).toEqual([]);
      expect(await only()).toEqual(started);
    },
  );
});

describe("a schedule's own step, between the row write and the mark", () => {
  const settle = (outcome: Partial<Outcome>): Promise<void> =>
    schedules.recordRunOutcome({ ...occurrence, status: 'success', ...outcome });
  const replay = (outcome: Partial<Outcome>): Promise<void> =>
    schedules.finalizeBookkeeping({ ...occurrence, status: 'success', ...outcome });

  it('writes the row, then the schedule, then the mark', async () => {
    await plan();
    await seed(row());
    record();
    await settle({ conversationId: 'conversation-a' });

    expect(order()).toEqual([
      'run findOneAndUpdate',
      'schedule updateOne',
      'schedule updateOne',
      'schedule updateOne',
      'run updateOne',
    ]);
    expect(await card()).toMatchObject({
      runCount: 4,
      failureCount: 0,
      lastRun: { status: 'success', conversationId: 'conversation-a', firedAt: fired },
    });
  });

  it('leaves a run unmarked when the schedule step fails, and a replay finishes it', async () => {
    await plan();
    await seed(row());
    jest.spyOn(Schedule, 'updateOne').mockImplementationOnce(() => {
      throw new Error('connection reset');
    });

    await expect(settle({ status: 'error', error: 'provider unavailable' })).rejects.toThrow(
      'connection reset',
    );
    expect(await only()).toMatchObject({ status: 'error', bookkept: false });
    expect(await card()).toMatchObject({ failureCount: 1 });

    record();
    await replay({ status: 'error', error: 'provider unavailable' });

    expect(order()[0]).toBe('run findOne');
    expect(order().pop()).toBe('run updateOne');
    expect(await only()).toMatchObject({ status: 'error', bookkept: true });
    expect(await card()).toMatchObject({
      failureCount: 2,
      lastRun: { status: 'error', error: 'provider unavailable', firedAt: fired },
    });
  });

  it('sends the schedule nothing when no run took the outcome', async () => {
    await plan();
    await seed(row({ status: 'success', bookkept: true }));
    record();
    await settle({ status: 'error', error: 'late' });

    expect(order()).toEqual(['run findOneAndUpdate', 'run findOneAndUpdate']);
    expect(await card()).toMatchObject({ failureCount: 1 });
  });

  it('settles the schedule on the status and receipts the row holds, not the ones asked for', async () => {
    await plan();
    await seed(row({ mcp: [revoked] }));
    await settle({ status: 'skipped_balance', balanceSkipDisableThreshold: 2 });

    const schedule = await card();
    expect(schedule).toMatchObject({
      failureCount: 2,
      balanceSkipCount: 0,
      enabled: false,
      disabledReason: 'mcp_reauth_required',
      lastRun: { status: 'error', error: refusal, mcp: [revoked], firedAt: fired },
    });
  });

  it('walks the balance streak for a run that settles as a balance skip', async () => {
    await plan();
    await seed(row());
    await settle({
      status: 'skipped_balance',
      conversationId: 'conversation-a',
      balanceSkipDisableThreshold: 2,
    });

    expect(await card()).toMatchObject({
      failureCount: 1,
      balanceSkipCount: 2,
      enabled: false,
      disabledReason: 'insufficient_balance',
      lastRun: { status: 'skipped_balance', conversationId: 'conversation-a', firedAt: fired },
    });
    expect(await only()).toMatchObject({ status: 'skipped_balance', bookkept: true });
  });

  it.each([
    ['a terminal outcome', { status: 'error', error: 'provider unavailable' } as const],
    ['a balance skip', { status: 'skipped_balance', balanceSkipDisableThreshold: 5 } as const],
  ])('holds %s off a schedule edited since the run started', async (_case, outcome) => {
    await plan({ configRevision: 8 });
    await seed(row());
    await settle(outcome);

    const schedule = await card();
    expect(schedule).toMatchObject({ failureCount: 1, balanceSkipCount: 1 });
    expect(schedule.lastRun).toBeUndefined();
    expect(await only()).toMatchObject({ bookkept: true });
  });

  it('settles under any revision a run whose row holds none, at the time of the write', async () => {
    await plan({ configRevision: 8 });
    await seed(without(['firedAt', 'configRevision']));
    await settle({ status: 'error', error: 'provider unavailable' });

    expect(await card()).toMatchObject({
      failureCount: 2,
      lastRun: { status: 'error', firedAt: now },
    });
  });

  it('projects a pause from the row it won, at the row fire time', async () => {
    await plan();
    await seed(row());
    record();
    await settle({ status: 'requires_action', conversationId: 'conversation-b' });

    expect(order()).toEqual(['run findOneAndUpdate', 'schedule updateOne']);
    expect(await card()).toMatchObject({
      runCount: 3,
      lastRun: {
        status: 'requires_action',
        conversationId: 'conversation-b',
        firedAt: fired,
        scheduledFor: at,
      },
    });
  });

  it('projects a pause at the time of the write for a row with no fire time or revision', async () => {
    await plan({ configRevision: 8 });
    await seed(without(['firedAt', 'configRevision']));
    await settle({ status: 'requires_action' });

    expect(await card()).toMatchObject({ lastRun: { status: 'requires_action', firedAt: now } });
  });

  it('holds a pause off a schedule edited since the run started', async () => {
    await plan({ configRevision: 8 });
    await seed(row());
    await settle({ status: 'requires_action' });

    expect((await card()).lastRun).toBeUndefined();
    expect(await only()).toMatchObject({ status: 'requires_action' });
  });

  it('projects nothing for a pause the row refused', async () => {
    await plan();
    await seed(row({ mcp: [unattended] }));
    record();
    await settle({ status: 'requires_action' });

    expect(order()).toEqual(['run findOneAndUpdate']);
    expect((await card()).lastRun).toBeUndefined();
  });

  it('ends a run asked to pause when its outcome brings a receipt that refuses it', async () => {
    await plan();
    await seed(row());
    await settle({ status: 'requires_action', mcp: [unattended] });

    expect(await only()).toMatchObject({ status: 'error', mcp: [unattended], bookkept: true });
    expect(await card()).toMatchObject({
      enabled: false,
      disabledReason: 'mcp_configuration_missing',
      lastRun: { status: 'error' },
    });
  });

  const skip = (
    status: 'skipped_balance' | 'skipped_overlap',
    data: Partial<IScheduleRun> = {},
    threshold?: number,
  ): Promise<void> =>
    schedules.recordSkippedRun(
      { scheduleId: 'sched_a', user: owner, scheduledFor: at, configRevision: 7, ...data, status },
      threshold,
    );

  it('inserts a skip, then settles the schedule, then marks it', async () => {
    await plan();
    record();
    await skip('skipped_balance', { conversationId: 'conversation-a' }, 2);

    expect(order()).toEqual([
      'run insertOne',
      'schedule updateOne',
      'schedule findOneAndUpdate',
      'schedule updateOne',
      'run updateOne',
    ]);
    const schedule = await card();
    expect(schedule).toMatchObject({
      balanceSkipCount: 2,
      enabled: false,
      disabledReason: 'insufficient_balance',
      lastRun: { status: 'skipped_balance', firedAt: now },
    });
    expect(schedule.lastRun).not.toHaveProperty('conversationId');
    expect(await only()).toMatchObject({ status: 'skipped_balance', bookkept: true });
  });

  it('breaks the balance streak for an overlap skip', async () => {
    await plan();
    await skip('skipped_overlap');

    expect(await card()).toMatchObject({
      balanceSkipCount: 0,
      countersAsOf: at,
      lastRun: { status: 'skipped_overlap', firedAt: now },
    });
    expect(await only()).toMatchObject({ status: 'skipped_overlap', bookkept: true });
  });

  it('settles a repeated skip from the row already there: its fire time and its revision', async () => {
    await plan({ configRevision: 8 });
    await seed(row({ status: 'skipped_balance', bookkept: false, configRevision: 8 }));
    await skip('skipped_balance', { configRevision: 7 }, 5);

    expect(await card()).toMatchObject({
      balanceSkipCount: 2,
      lastRun: { status: 'skipped_balance', firedAt: fired },
    });
    expect(await only()).toMatchObject({ bookkept: true });
  });

  it('holds a skip decided under an older revision off the schedule', async () => {
    await plan({ configRevision: 8 });
    await skip('skipped_overlap');

    const schedule = await card();
    expect(schedule).toMatchObject({ balanceSkipCount: 1 });
    expect(schedule.lastRun).toBeUndefined();
  });

  it('sends the schedule nothing for a skip of an occurrence that started', async () => {
    await plan();
    await seed(row());
    record();
    await skip('skipped_overlap');

    expect(order()).toEqual(['run insertOne', 'run findOne']);
    expect(await only()).toEqual(row());
  });

  it.each([
    [
      'a balance skip',
      {
        status: 'skipped_balance',
        conversationId: 'conversation-a',
        balanceSkipDisableThreshold: 5,
      },
      {
        balanceSkipCount: 2,
        lastRun: { status: 'skipped_balance', conversationId: 'conversation-a', firedAt: fired },
      },
    ],
    [
      'an overlap skip',
      { status: 'skipped_overlap' },
      { balanceSkipCount: 0, lastRun: { status: 'skipped_overlap', firedAt: fired } },
    ],
    [
      'a success',
      { status: 'success', conversationId: 'conversation-a' },
      {
        runCount: 4,
        lastRun: { status: 'success', conversationId: 'conversation-a', firedAt: fired },
      },
    ],
  ] as const)('replays %s from the row and marks it', async (_case, outcome, expected) => {
    await plan();
    await seed(row({ status: outcome.status, settledAt: before, bookkept: false }));
    record();
    await replay(outcome);

    expect(text(commands()[0])).toBe(
      text({ method: 'findOne', args: [key, { projection: { configRevision: 1, firedAt: 1 } }] }),
    );
    expect(text(commands().pop())).toBe(text(mark));
    expect(await card()).toMatchObject(expected);
    expect(await only()).toMatchObject({ status: outcome.status, bookkept: true });
  });

  it.each([
    ['a balance skip', { status: 'skipped_balance', balanceSkipDisableThreshold: 5 }],
    ['an overlap skip', { status: 'skipped_overlap' }],
    ['a failure', { status: 'error', error: 'provider unavailable' }],
  ] as const)(
    'holds a replay of %s off a schedule edited since the run started',
    async (_case, outcome) => {
      await plan({ configRevision: 8 });
      await seed(row({ status: outcome.status, bookkept: false }));
      await replay(outcome);

      const schedule = await card();
      expect(schedule).toMatchObject({ failureCount: 1, balanceSkipCount: 1 });
      expect(schedule.lastRun).toBeUndefined();
      expect(await only()).toMatchObject({ bookkept: true });
    },
  );

  it.each([
    [
      'a failure',
      { status: 'error', error: 'gone' },
      { failureCount: 2, lastRun: { status: 'error', firedAt: now } },
    ],
    [
      'a balance skip',
      { status: 'skipped_balance', balanceSkipDisableThreshold: 5 },
      { balanceSkipCount: 2, lastRun: { status: 'skipped_balance', firedAt: now } },
    ],
    [
      'an overlap skip',
      { status: 'skipped_overlap' },
      { balanceSkipCount: 0, lastRun: { status: 'skipped_overlap', firedAt: now } },
    ],
  ] as const)(
    'replays %s at the time of the replay, under any revision, when no row is on record',
    async (_case, outcome, expected) => {
      await plan({ configRevision: 8 });
      await replay(outcome);

      expect(await card()).toMatchObject(expected);
      expect(await stored()).toEqual([]);
    },
  );
});
