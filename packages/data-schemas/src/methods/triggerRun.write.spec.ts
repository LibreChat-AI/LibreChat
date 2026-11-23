import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { IScheduleRun, IScheduleRunDocument } from '~/types/schedule';
import type { TriggerRunRef } from '~/types/triggerRun';
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
let ScheduleRun: Model<IScheduleRunDocument>;
let schedules: ScheduleMethods;
let runs: TriggerRuns;

type Command = { method: string; args: unknown[] };
let sent: Command[] = [];

/** The clock every test runs under, so a stamp a writer takes from it is a known value. */
const now = new Date('2026-11-21T12:00:00.000Z');
const minutes = (count: number): Date => new Date(now.getTime() - count * 60_000);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  ScheduleRun = mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;
  await ScheduleRun.init();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  mongoose.set('debug', false);
  await mongoose.disconnect();
  await mongoServer?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  mongoose.set('debug', false);
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
  jest.useRealTimers();
});

/** A value as the driver encodes it: plain data, in the key order it goes out in. */
const wire = <T>(value: T): T => BSON.deserialize(BSON.serialize({ value })).value as T;

/** Text that differs whenever a key, a value, a type or the order of keys does. */
const text = (value: unknown): string => BSON.EJSON.stringify(wire(value), undefined, 1);

/**
 * Records every command sent to the run collection, as mongoose hands it to the driver. The
 * other models registered beside it build their indexes in the background and are left out.
 */
function record(): void {
  sent = [];
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    if (collection === ScheduleRun.collection.name) sent.push(wire({ method, args }));
  });
}

/** What was recorded, with the id an insert generates left out. */
function commands(): Command[] {
  mongoose.set('debug', false);
  return sent.map(({ method, args }) => {
    if (method !== 'insertOne') return { method, args };
    const [doc, ...rest] = args as [Record<string, unknown>, ...unknown[]];
    const { _id, ...columns } = doc;
    expect(_id).toBeInstanceOf(mongoose.Types.ObjectId);
    return { method, args: [columns, ...rest] };
  });
}

const owner = new mongoose.Types.ObjectId();
const at = new Date('2026-11-21T08:00:00.000Z');
const later = new Date('2026-11-21T09:00:00.000Z');
const before = new Date('2026-11-20T08:00:00.000Z');
/** Keys in the order the model stores them, so a seeded outcome equals one a writer adds. */
const denied: ScheduleMCPOutcome = {
  server: 'Graph',
  recovery: 'authorize',
  skipped: true,
  status: 'mcp_reauth_required',
};
const ready: ScheduleMCPOutcome = { server: 'Mail', status: 'ready' };

/** What mongoose adds to every update of this collection: a column no read returns. */
const hidden = { projection: { checkpointNamespace: 0 } };
const active = { $in: ['started', 'requires_action'] };
const settled = { $in: ['success', 'error', 'interrupted', 'skipped_balance', 'skipped_overlap'] };

function ref(id: string, when: Date, kind = 'schedule'): TriggerRunRef {
  return { subject: { kind, id }, delivery: { event: { occurredAt: when.getTime() } } };
}

function row(overrides: Partial<IScheduleRun> = {}): Partial<IScheduleRun> {
  return {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: at,
    firedAt: new Date('2026-11-21T08:00:01.000Z'),
    status: 'started',
    conversationId: 'conversation-a',
    createdAt: before,
    updatedAt: before,
    ...overrides,
  };
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

/** One run in each state a writer meets: just reserved, started by hand, paused, settled. */
const states: Array<[string, Partial<IScheduleRun>]> = [
  ['fresh', row({ capacitySlot: 0, deliveryKey: 'agent-trigger:fresh', chatProjectId: 'p1' })],
  [
    'manual',
    row({
      scheduledFor: new Date('2026-11-21T09:13:27.412Z'),
      capacitySlot: 1,
      deliveryKey: 'agent-trigger:manual',
      chatProjectId: null,
    }),
  ],
  ['paused', row({ status: 'requires_action', mcp: [denied] })],
  [
    'settled',
    row({ status: 'error', error: 'provider unavailable', settledAt: minutes(5), mcp: [denied] }),
  ],
];
const isActive = (data: Partial<IScheduleRun>): boolean =>
  data.status === 'started' || data.status === 'requires_action';

/** The eight writers, each addressed the same way whichever object carries it out. */
type Writers = {
  reserve: (data: Partial<IScheduleRun>) => ReturnType<ScheduleMethods['reserveStartedRun']>;
  detail: ScheduleMethods['setRunFireDetails'];
  abort: ScheduleMethods['requestRunAbort'];
  abortSaved: ScheduleMethods['markRunAbortPersisted'];
  claim: ScheduleMethods['markRunResumeClaimed'];
  release: ScheduleMethods['releaseRunResumeClaim'];
  receipt: (
    id: string,
    when: Date,
    binding: { conversationId: string; tenantId?: string },
    receipts: ScheduleMCPOutcome[],
  ) => Promise<boolean>;
  remove: ScheduleMethods['deleteScheduleRun'];
};

const paths: Array<[string, () => Writers]> = [
  [
    'the schedule methods',
    () => ({
      reserve: (data) => schedules.reserveStartedRun(data),
      detail: (id, when, details) => schedules.setRunFireDetails(id, when, details),
      abort: (id, when, source) => schedules.requestRunAbort(id, when, source),
      abortSaved: (id, when) => schedules.markRunAbortPersisted(id, when),
      claim: (id, when, slot) => schedules.markRunResumeClaimed(id, when, slot),
      release: (id, when, slot) => schedules.releaseRunResumeClaim(id, when, slot),
      receipt: (id, when, binding, receipts) =>
        schedules.recordMCPToolAuthFailure({
          scheduleId: id,
          scheduledFor: when,
          ...binding,
          server: 'unused',
          outcomes: receipts,
        }),
      remove: (id, when, status, conversationId) =>
        schedules.deleteScheduleRun(id, when, status, conversationId),
    }),
  ],
  [
    'the run record',
    () => ({
      reserve: (data) =>
        runs.reserve(
          {
            subject: { kind: 'schedule', id: data.scheduleId as string },
            delivery: { event: { occurredAt: (data.scheduledFor as Date).getTime() } },
          },
          data,
        ),
      detail: (id, when, details) => runs.detail(ref(id, when), details),
      abort: (id, when, source) => runs.abort(ref(id, when), source),
      abortSaved: (id, when) => runs.abortSaved(ref(id, when)),
      claim: (id, when, slot) => runs.claim(ref(id, when), slot),
      release: (id, when, slot) => runs.release(ref(id, when), slot),
      receipt: (id, when, binding, receipts) => runs.receipt(ref(id, when), binding, receipts),
      remove: (id, when, status, conversationId) =>
        runs.remove(ref(id, when), { status, conversationId }),
    }),
  ],
];

describe.each(paths)('the commands sent by %s', (_name, build) => {
  let write: Writers;
  beforeEach(() => {
    write = build();
  });

  const started = {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: at,
    firedAt: new Date('2026-11-21T08:00:01.000Z'),
    conversationId: 'conversation-a',
    deliveryKey: 'agent-trigger:a',
    chatProjectId: null,
    status: 'started',
    capacitySlot: 2,
    configRevision: 7,
    createdAt: now,
    updatedAt: now,
    __v: 0,
  };

  it('inserts a starting run in one command, with the status forced to started', async () => {
    record();
    const reserved = await write.reserve({
      scheduleId: 'sched_a',
      user: owner,
      scheduledFor: at,
      conversationId: 'conversation-a',
      firedAt: new Date('2026-11-21T08:00:01.000Z'),
      capacitySlot: 2,
      deliveryKey: 'agent-trigger:a',
      chatProjectId: null,
      configRevision: 7,
      status: 'success',
    });

    expect(text(commands())).toBe(text([{ method: 'insertOne', args: [started, {}] }]));
    expect('run' in reserved && reserved.run).toMatchObject({ ...started, user: owner });
    expect(await only()).toEqual(started);
  });

  it('inserts an admission-only run with its failure and outcomes', async () => {
    record();
    await write.reserve({
      scheduleId: 'sched_a',
      user: owner,
      tenantId: 'tenant-1',
      scheduledFor: at,
      admissionOnly: true,
      error: 'MCP preflight unavailable',
      mcp: [denied],
    });

    expect(text(commands())).toBe(
      text([
        {
          method: 'insertOne',
          args: [
            {
              scheduleId: 'sched_a',
              user: owner,
              tenantId: 'tenant-1',
              scheduledFor: at,
              status: 'started',
              error: 'MCP preflight unavailable',
              mcp: [denied],
              admissionOnly: true,
              createdAt: now,
              updatedAt: now,
              __v: 0,
            },
            {},
          ],
        },
      ]),
    );
  });

  it('reads the status of the row in the way only after the insert is refused', async () => {
    await seed(row({ status: 'success' }));
    record();
    const reserved = await write.reserve(row({ conversationId: 'conversation-b' }));

    expect(reserved).toEqual({ conflict: 'duplicate', existingStatus: 'success' });
    const [insert, read, ...rest] = commands();
    expect(insert.method).toBe('insertOne');
    expect(text(read)).toBe(
      text({
        method: 'findOne',
        args: [{ scheduleId: 'sched_a', scheduledFor: at }, { projection: { status: 1 } }],
      }),
    );
    expect(rest).toEqual([]);
  });

  it('reads nothing when another run of the subject or the slot is in the way', async () => {
    await seed(row({ capacitySlot: 0 }));
    record();
    expect(await write.reserve(row({ scheduledFor: later, capacitySlot: 1 }))).toEqual({
      conflict: 'overlap',
    });
    expect(
      await write.reserve(row({ scheduleId: 'sched_b', scheduledFor: later, capacitySlot: 0 })),
    ).toEqual({ conflict: 'slot-taken' });
    expect(commands().map(({ method }) => method)).toEqual(['insertOne', 'insertOne']);
  });

  it('adds what a fire learned to the row holding its conversation', async () => {
    await seed(row());
    record();
    await write.detail('sched_a', at, {
      conversationId: 'conversation-a',
      droppedFileIds: ['file-1'],
      mcp: [ready],
    });

    expect(text(commands())).toBe(
      text([
        {
          method: 'updateOne',
          args: [
            { scheduleId: 'sched_a', scheduledFor: at, conversationId: 'conversation-a' },
            {
              $setOnInsert: { createdAt: now },
              $addToSet: { mcp: { $each: [{ server: 'Mail', status: 'ready' }] } },
              $set: {
                conversationId: 'conversation-a',
                droppedFileIds: ['file-1'],
                updatedAt: now,
              },
            },
            hidden,
          ],
        },
      ]),
    );
  });

  it('sets only the conversation when a fire dropped no file and checked no server', async () => {
    await seed(row());
    record();
    await write.detail('sched_a', at, { conversationId: 'conversation-a' });
    await write.detail('sched_a', at, {
      conversationId: 'conversation-a',
      droppedFileIds: [],
      mcp: [],
    });

    const bare = {
      method: 'updateOne',
      args: [
        { scheduleId: 'sched_a', scheduledFor: at, conversationId: 'conversation-a' },
        {
          $setOnInsert: { createdAt: now },
          $set: { conversationId: 'conversation-a', updatedAt: now },
        },
        hidden,
      ],
    };
    expect(text(commands())).toBe(text([bare, bare]));
  });

  it('stamps a stop in one fenced update, and reads only when it lost', async () => {
    await seed(row());
    record();
    expect(await write.abort('sched_a', at, 'stop')).toBe(true);
    expect(await write.abort('sched_a', at, 'stop')).toBe('in_progress');

    const stamp = {
      method: 'updateOne',
      args: [
        {
          scheduleId: 'sched_a',
          scheduledFor: at,
          status: active,
          $nor: [
            {
              abortSource: 'stop',
              abortPersistedAt: { $exists: false },
              abortRequestedAt: { $gt: minutes(30) },
            },
          ],
        },
        {
          $setOnInsert: { createdAt: now },
          $unset: { abortPersistedAt: 1 },
          $set: { abortRequestedAt: now, abortSource: 'stop', updatedAt: now },
        },
        hidden,
      ],
    };
    expect(text(commands())).toBe(
      text([
        stamp,
        stamp,
        {
          method: 'findOne',
          args: [
            { scheduleId: 'sched_a', scheduledFor: at, status: active },
            { projection: { _id: 1 } },
          ],
        },
      ]),
    );
  });

  it.each([
    ['deletion', { abortRequestedAt: now, abortSource: 'deletion', updatedAt: now }],
    [undefined, { abortRequestedAt: now, updatedAt: now }],
  ] as const)('stamps an abort from %s in one fenced update', async (source, set) => {
    await seed(row());
    record();
    expect(await write.abort('sched_a', at, source)).toBe(true);

    expect(text(commands())).toBe(
      text([
        {
          method: 'updateOne',
          args: [
            {
              $or: [{ abortSource: { $ne: 'stop' } }, { abortPersistedAt: { $exists: true } }],
              scheduleId: 'sched_a',
              scheduledFor: at,
              status: active,
            },
            { $setOnInsert: { createdAt: now }, $set: set },
            hidden,
          ],
        },
      ]),
    );
  });

  it('only renews the stamp when an unresolved stop holds the source', async () => {
    await seed(row({ abortSource: 'stop', abortRequestedAt: minutes(1) }));
    record();
    expect(await write.abort('sched_a', at, 'deletion')).toBe(true);

    const [claim, renew, ...rest] = commands();
    expect(claim.method).toBe('updateOne');
    expect(text(renew)).toBe(
      text({
        method: 'updateOne',
        args: [
          { scheduleId: 'sched_a', scheduledFor: at, status: active },
          {
            $setOnInsert: { createdAt: now },
            $set: { abortRequestedAt: now, updatedAt: now },
          },
          hidden,
        ],
      }),
    );
    expect(rest).toEqual([]);
  });

  it('records that a stop has saved everything, without touching when the row changed', async () => {
    await seed(row());
    record();
    await write.abortSaved('sched_a', at);

    expect(text(commands())).toBe(
      text([
        {
          method: 'updateOne',
          args: [
            { scheduleId: 'sched_a', scheduledFor: at },
            { $set: { abortPersistedAt: now } },
            hidden,
          ],
        },
      ]),
    );
  });

  it('claims a paused run in one fenced update that returns the new row', async () => {
    await seed(row({ status: 'requires_action' }));
    record();
    expect(await write.claim('sched_a', at, 3)).toEqual({ capacitySlot: 3 });

    expect(text(commands())).toBe(
      text([
        {
          method: 'findOneAndUpdate',
          args: [
            { scheduleId: 'sched_a', scheduledFor: at, status: 'requires_action' },
            { $set: { status: 'started', capacitySlot: 3, resumeClaimedAt: now } },
            { ...hidden, returnDocument: 'after', returnOriginal: false },
          ],
        },
      ]),
    );
  });

  it('releases a claim in one update fenced on the slot it claimed', async () => {
    await seed(row({ capacitySlot: 3, resumeClaimedAt: minutes(1) }));
    record();
    expect(await write.release('sched_a', at, 3)).toBe(true);

    expect(text(commands())).toBe(
      text([
        {
          method: 'updateOne',
          args: [
            { scheduleId: 'sched_a', scheduledFor: at, status: 'started', capacitySlot: 3 },
            {
              $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
              $set: { status: 'requires_action' },
            },
            hidden,
          ],
        },
      ]),
    );
  });

  it.each([
    ['a tenant', { tenantId: 'tenant-1' }, 'tenant-1'],
    ['no tenant', {}, { $exists: false }],
  ] as const)('adds receipts to a live run bound to %s', async (_tenant, tenant, match) => {
    await seed(row(tenant));
    record();
    expect(
      await write.receipt('sched_a', at, { conversationId: 'conversation-a', ...tenant }, [denied]),
    ).toBe(true);

    expect(text(commands())).toBe(
      text([
        {
          method: 'updateOne',
          args: [
            {
              scheduleId: 'sched_a',
              scheduledFor: at,
              conversationId: 'conversation-a',
              tenantId: match,
              status: active,
            },
            {
              $addToSet: { mcp: { $each: [denied] } },
            },
            hidden,
          ],
        },
      ]),
    );
  });

  it('reads a settled run only after no live one took the receipts', async () => {
    await seed(row({ status: 'success', mcp: [denied] }));
    record();
    expect(await write.receipt('sched_a', at, { conversationId: 'conversation-a' }, [denied])).toBe(
      true,
    );

    const [update, read, ...rest] = commands();
    expect(update.method).toBe('updateOne');
    expect(text(read)).toBe(
      text({
        method: 'findOne',
        args: [
          {
            scheduleId: 'sched_a',
            scheduledFor: at,
            conversationId: 'conversation-a',
            tenantId: { $exists: false },
            status: settled,
          },
          { projection: { mcp: 1 } },
        ],
      }),
    );
    expect(rest).toEqual([]);
  });

  it.each([
    ['nothing more', undefined, undefined, {}],
    ['a status', 'started', undefined, { status: 'started' }],
    ['a conversation', undefined, 'conversation-a', { conversationId: 'conversation-a' }],
    ['both', 'started', 'conversation-a', { status: 'started', conversationId: 'conversation-a' }],
  ] as const)('deletes a row fenced on %s', async (_fence, status, conversationId, fence) => {
    await seed(row());
    record();
    await write.remove('sched_a', at, status, conversationId);

    expect(text(commands())).toBe(
      text([
        {
          method: 'deleteOne',
          args: [{ scheduleId: 'sched_a', scheduledFor: at, ...fence }, hidden],
        },
      ]),
    );
  });
});

describe.each(paths)('a run written through %s', (_name, build) => {
  let write: Writers;
  beforeEach(() => {
    write = build();
  });

  describe('reserving', () => {
    it('refuses a second reservation of one delivery and reports who holds it', async () => {
      const first = await write.reserve(row({ capacitySlot: 0 }));
      expect('run' in first).toBe(true);
      for (const status of ['started', 'requires_action', 'success', 'error'] as const) {
        await ScheduleRun.collection.updateOne({}, { $set: { status } });
        expect(await write.reserve(row({ capacitySlot: 1, conversationId: 'other' }))).toEqual({
          conflict: 'duplicate',
          existingStatus: status,
        });
      }
      expect((await only()).conversationId).toBe('conversation-a');
    });

    it('lets exactly one of many reservations of one delivery through', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_unused, slot) =>
          write.reserve(row({ capacitySlot: slot, conversationId: `conversation-${slot}` })),
        ),
      );

      const won = attempts.filter((attempt) => 'run' in attempt);
      expect(won).toHaveLength(1);
      expect(attempts.filter((attempt) => !('run' in attempt))).toEqual(
        Array.from({ length: 7 }, () => ({ conflict: 'duplicate', existingStatus: 'started' })),
      );
      const kept = await only();
      expect('run' in won[0] && won[0].run.conversationId).toBe(kept.conversationId);
    });

    it('lets one run of a subject be active, whichever of two deliveries asks first', async () => {
      const attempts = await Promise.all([
        write.reserve(row({ capacitySlot: 0 })),
        write.reserve(row({ scheduledFor: later, capacitySlot: 1 })),
      ]);

      expect(attempts.filter((attempt) => 'run' in attempt)).toHaveLength(1);
      expect(attempts.filter((attempt) => !('run' in attempt))).toEqual([{ conflict: 'overlap' }]);
      expect(await stored()).toHaveLength(1);
    });

    it('gives one capacity slot to one of two subjects asking at once', async () => {
      const attempts = await Promise.all([
        write.reserve(row({ capacitySlot: 0 })),
        write.reserve(row({ scheduleId: 'sched_b', capacitySlot: 0 })),
      ]);

      expect(attempts.filter((attempt) => 'run' in attempt)).toHaveLength(1);
      expect(attempts.filter((attempt) => !('run' in attempt))).toEqual([
        { conflict: 'slot-taken' },
      ]);
      expect(await stored()).toHaveLength(1);
    });

    it('reserves beside a paused or settled run of the same subject', async () => {
      await seed(
        row({ scheduledFor: before, status: 'requires_action' }),
        row({ scheduledFor: minutes(600), status: 'success', capacitySlot: 0 }),
      );
      expect('run' in (await write.reserve(row({ capacitySlot: 0 })))).toBe(true);
      expect(await stored()).toHaveLength(3);
    });

    it('fails, and reports no conflict, for a row the collection cannot hold', async () => {
      await expect(write.reserve({ scheduleId: 'sched_a', scheduledFor: at })).rejects.toThrow(
        /user/,
      );
      expect(await stored()).toEqual([]);
    });
  });

  describe('adding what a fire learned', () => {
    it.each(states)('writes onto a %s run that holds the conversation', async (_state, data) => {
      await seed(data);
      await write.detail('sched_a', data.scheduledFor as Date, {
        conversationId: 'conversation-a',
        droppedFileIds: ['file-1', 'file-2'],
        mcp: [denied, ready],
      });

      expect(await only()).toEqual({
        ...data,
        droppedFileIds: ['file-1', 'file-2'],
        mcp: [denied, ready],
        updatedAt: now,
      });
    });

    it('leaves a row reserved under another conversation alone', async () => {
      await seed(row());
      await write.detail('sched_a', at, {
        conversationId: 'conversation-b',
        droppedFileIds: ['file-1'],
        mcp: [ready],
      });
      await write.detail('sched_b', at, { conversationId: 'conversation-a' });
      await write.detail('sched_a', later, { conversationId: 'conversation-a' });

      expect(await only()).toEqual(row());
    });

    it('writes neither an empty file list nor an empty outcome list', async () => {
      await seed(row());
      await write.detail('sched_a', at, {
        conversationId: 'conversation-a',
        droppedFileIds: [],
        mcp: [],
      });

      expect(await only()).toEqual(row({ updatedAt: now }));
    });
  });

  describe('requesting an abort', () => {
    it.each(states)('answers for a %s run by whether it is still active', async (_state, data) => {
      await seed(data);
      const when = data.scheduledFor as Date;

      expect(await write.abort('sched_a', when, 'deletion')).toBe(isActive(data));
      expect(await only()).toEqual(
        isActive(data)
          ? { ...data, abortRequestedAt: now, abortSource: 'deletion', updatedAt: now }
          : data,
      );
    });

    it.each(states)('stops a %s run only while it is still active', async (_state, data) => {
      await seed(data);
      const when = data.scheduledFor as Date;

      expect(await write.abort('sched_a', when, 'stop')).toBe(isActive(data));
      expect(await only()).toEqual(
        isActive(data)
          ? { ...data, abortRequestedAt: now, abortSource: 'stop', updatedAt: now }
          : data,
      );
    });

    it('finds no run to abort where none is on record', async () => {
      await seed(row());
      expect(await write.abort('sched_a', later, 'stop')).toBe(false);
      expect(await write.abort('sched_b', at, 'deletion')).toBe(false);
      expect(await write.abort('sched_b', at)).toBe(false);
      expect(await only()).toEqual(row());
    });

    it('lets one of two stops asked at once take the run', async () => {
      await seed(row());
      const answers = await Promise.all([
        write.abort('sched_a', at, 'stop'),
        write.abort('sched_a', at, 'stop'),
      ]);
      expect(answers.sort()).toEqual(['in_progress', true]);
    });

    it('holds a second stop off until the first has saved or gone stale', async () => {
      await seed(row({ abortSource: 'stop', abortRequestedAt: minutes(29) }));
      expect(await write.abort('sched_a', at, 'stop')).toBe('in_progress');
      expect(await only()).toEqual(row({ abortSource: 'stop', abortRequestedAt: minutes(29) }));

      await ScheduleRun.collection.updateOne({}, { $set: { abortRequestedAt: minutes(30) } });
      expect(await write.abort('sched_a', at, 'stop')).toBe(true);
      expect((await only()).abortRequestedAt).toEqual(now);
    });

    it('reopens what a stop must save when a new stop takes a resolved one', async () => {
      await seed(
        row({ abortSource: 'stop', abortRequestedAt: minutes(1), abortPersistedAt: minutes(1) }),
      );
      expect(await write.abort('sched_a', at, 'stop')).toBe(true);
      expect(await only()).toEqual(
        row({ abortSource: 'stop', abortRequestedAt: now, updatedAt: now }),
      );
    });

    it('takes a stop over a deletion, and gives a deletion a resolved stop', async () => {
      await seed(row({ abortSource: 'deletion', abortRequestedAt: minutes(1) }));
      expect(await write.abort('sched_a', at, 'stop')).toBe(true);
      expect((await only()).abortSource).toBe('stop');

      await ScheduleRun.collection.updateOne({}, { $set: { abortPersistedAt: minutes(1) } });
      expect(await write.abort('sched_a', at, 'deletion')).toBe(true);
      expect(await only()).toEqual(
        row({
          abortSource: 'deletion',
          abortRequestedAt: now,
          abortPersistedAt: minutes(1),
          updatedAt: now,
        }),
      );
    });

    it('renews the stamp but keeps the source of a stop that has not saved', async () => {
      await seed(row({ abortSource: 'stop', abortRequestedAt: minutes(1) }));
      expect(await write.abort('sched_a', at, 'deletion')).toBe(true);
      expect(await only()).toEqual(
        row({ abortSource: 'stop', abortRequestedAt: now, updatedAt: now }),
      );

      await ScheduleRun.collection.updateOne({}, { $set: { abortRequestedAt: minutes(1) } });
      expect(await write.abort('sched_a', at)).toBe(true);
      expect(await only()).toEqual(
        row({ abortSource: 'stop', abortRequestedAt: now, updatedAt: now }),
      );
    });

    it('stamps without a source when none is given', async () => {
      await seed(row());
      expect(await write.abort('sched_a', at)).toBe(true);
      expect(await only()).toEqual(row({ abortRequestedAt: now, updatedAt: now }));
    });

    it('never stamps a run that settled first, whichever of the two writes lands first', async () => {
      const occurrences = Array.from({ length: 12 }, (_unused, index) => minutes(60 * index));
      // Paused, since a subject holds one started run at a time and a paused run is as active.
      await seed(
        ...occurrences.map((scheduledFor) => row({ scheduledFor, status: 'requires_action' })),
      );

      const answers = await Promise.all(
        occurrences.map(async (scheduledFor, index) => {
          const settle = () =>
            ScheduleRun.collection.updateOne(
              { scheduleId: 'sched_a', scheduledFor, status: active },
              { $set: { status: 'success', settledAt: now } },
            );
          const stop = () => write.abort('sched_a', scheduledFor, 'stop');
          const [answer] =
            index % 2 === 0
              ? await Promise.all([stop(), settle()])
              : (await Promise.all([settle(), stop()])).reverse();
          return answer;
        }),
      );

      const rows = await ScheduleRun.collection.find({}).sort({ scheduledFor: -1 }).toArray();
      expect(rows.map(({ status }) => status)).toEqual(occurrences.map(() => 'success'));
      rows.forEach((stamped, index) => {
        expect(answers[index]).toBe(stamped.abortRequestedAt != null);
        expect(stamped.abortSource).toBe(answers[index] === true ? 'stop' : undefined);
      });
    });
  });

  describe('recording that a stop has saved', () => {
    it.each(states)('stamps a %s run and nothing else on it', async (_state, data) => {
      await seed(data);
      await write.abortSaved('sched_a', data.scheduledFor as Date);
      expect(await only()).toEqual({ ...data, abortPersistedAt: now });
    });

    it('writes no row where none is on record', async () => {
      await write.abortSaved('sched_a', at);
      expect(await stored()).toEqual([]);
    });
  });

  describe('claiming a paused run', () => {
    it.each(states)('claims a %s run only when it is paused', async (_state, data) => {
      await seed(data);
      const paused = data.status === 'requires_action';

      expect(await write.claim('sched_a', data.scheduledFor as Date, 5)).toEqual(
        paused ? { capacitySlot: 5 } : { conflict: 'not-paused' },
      );
      expect(await only()).toEqual(
        paused ? { ...data, status: 'started', capacitySlot: 5, resumeClaimedAt: now } : data,
      );
    });

    it('finds no paused run where none is on record', async () => {
      expect(await write.claim('sched_a', at, 0)).toEqual({ conflict: 'not-paused' });
      expect(await stored()).toEqual([]);
    });

    it('lets one of two claims asked at once resume the run', async () => {
      await seed(row({ status: 'requires_action' }));
      const claims = await Promise.all([
        write.claim('sched_a', at, 0),
        write.claim('sched_a', at, 1),
      ]);

      const won = claims.filter((claim) => 'capacitySlot' in claim);
      expect(won).toHaveLength(1);
      expect(claims.filter((claim) => 'conflict' in claim)).toEqual([{ conflict: 'not-paused' }]);
      expect(await only()).toEqual(row({ ...won[0], status: 'started', resumeClaimedAt: now }));
    });

    it('leaves the run paused when another subject holds the slot asked for', async () => {
      const paused = row({ status: 'requires_action' });
      await seed(paused, row({ scheduleId: 'sched_b', capacitySlot: 0 }));

      expect(await write.claim('sched_a', at, 0)).toEqual({ conflict: 'slot-taken' });
      expect((await stored())[0]).toEqual(paused);
      expect(await write.claim('sched_a', at, 1)).toEqual({ capacitySlot: 1 });
    });

    it('leaves the run paused while its subject has another run going', async () => {
      const paused = row({ status: 'requires_action' });
      await seed(paused, row({ scheduledFor: later, capacitySlot: 1 }));

      expect(await write.claim('sched_a', at, 2)).toEqual({ conflict: 'overlap' });
      expect((await stored())[0]).toEqual(paused);
    });
  });

  describe('releasing a claim', () => {
    it('puts a claimed run back as paused, holding no slot', async () => {
      await seed(row({ capacitySlot: 4, resumeClaimedAt: minutes(1) }));
      expect(await write.release('sched_a', at, 4)).toBe(true);
      expect(await only()).toEqual(row({ status: 'requires_action' }));
    });

    it.each(states)(
      'releases a %s run only while it holds the slot named',
      async (_state, data) => {
        await seed(data);
        const when = data.scheduledFor as Date;
        const holds = data.status === 'started';

        expect(await write.release('sched_a', when, 9)).toBe(false);
        expect(await only()).toEqual(data);
        expect(await write.release('sched_a', when, data.capacitySlot ?? 0)).toBe(holds);
        expect((await only()).status).toBe(holds ? 'requires_action' : data.status);
      },
    );

    it('releases once when asked twice at the same moment', async () => {
      await seed(row({ capacitySlot: 4 }));
      const released = await Promise.all([
        write.release('sched_a', at, 4),
        write.release('sched_a', at, 4),
      ]);
      expect(released.sort()).toEqual([false, true]);
    });
  });

  describe('adding receipts', () => {
    const bound = { conversationId: 'conversation-a' };

    it.each(states)('adds to a %s run only while it is live', async (_state, data) => {
      await seed(data);
      const when = data.scheduledFor as Date;

      expect(await write.receipt('sched_a', when, bound, [ready])).toBe(isActive(data));
      expect(await only()).toEqual(
        isActive(data) ? { ...data, mcp: [...(data.mcp ?? []), ready] } : data,
      );
    });

    it('adds a receipt once however often it is sent', async () => {
      await seed(row());
      expect(await write.receipt('sched_a', at, bound, [denied, ready])).toBe(true);
      expect(await write.receipt('sched_a', at, bound, [ready, denied])).toBe(true);
      expect(await only()).toEqual(row({ mcp: [denied, ready] }));
    });

    it('answers for a settled run by whether it already holds every receipt', async () => {
      await seed(row({ status: 'interrupted', mcp: [denied] }));

      expect(await write.receipt('sched_a', at, bound, [denied])).toBe(true);
      expect(await write.receipt('sched_a', at, bound, [denied, ready])).toBe(false);
      expect(await write.receipt('sched_a', at, bound, [])).toBe(false);
      expect(await only()).toEqual(row({ status: 'interrupted', mcp: [denied] }));
    });

    it('holds no receipt for a settled run that recorded none', async () => {
      await seed(row({ status: 'success' }));
      expect(await write.receipt('sched_a', at, bound, [ready])).toBe(false);
      expect(await only()).toEqual(row({ status: 'success' }));
    });

    it('takes an empty list as delivered to a live run and to no other', async () => {
      await seed(row());
      expect(await write.receipt('sched_a', at, bound, [])).toBe(true);
      expect(await write.receipt('sched_a', later, bound, [])).toBe(false);
      expect(await only()).toEqual(row({ mcp: [] }));
    });

    it('adds nothing to a run bound to another conversation or tenant', async () => {
      await seed(row(), row({ scheduleId: 'sched_t', tenantId: 'tenant-1' }));

      expect(
        await write.receipt('sched_a', at, { conversationId: 'conversation-b' }, [ready]),
      ).toBe(false);
      expect(await write.receipt('sched_a', at, { ...bound, tenantId: 'tenant-1' }, [ready])).toBe(
        false,
      );
      expect(await write.receipt('sched_t', at, bound, [ready])).toBe(false);
      expect(await write.receipt('sched_t', at, { ...bound, tenantId: 'tenant-2' }, [ready])).toBe(
        false,
      );
      expect(await stored()).toEqual([row(), row({ scheduleId: 'sched_t', tenantId: 'tenant-1' })]);

      expect(await write.receipt('sched_t', at, { ...bound, tenantId: 'tenant-1' }, [ready])).toBe(
        true,
      );
      expect((await stored())[1].mcp).toEqual([ready]);
    });
  });

  describe('deleting a row', () => {
    it.each(states)(
      'deletes a %s run when nothing more is expected of it',
      async (_state, data) => {
        await seed(data, row({ scheduleId: 'sched_b', scheduledFor: later }));
        await write.remove('sched_a', data.scheduledFor as Date);
        expect((await only()).scheduleId).toBe('sched_b');
      },
    );

    it('keeps a row that moved on from the status or conversation expected', async () => {
      await seed(row({ status: 'success' }));

      await write.remove('sched_a', at, 'started');
      await write.remove('sched_a', at, 'started', 'conversation-a');
      await write.remove('sched_a', at, 'success', 'conversation-b');
      await write.remove('sched_a', at, undefined, 'conversation-b');
      await write.remove('sched_a', later);
      await write.remove('sched_b', at);
      expect(await only()).toEqual(row({ status: 'success' }));

      await write.remove('sched_a', at, 'success', 'conversation-a');
      expect(await stored()).toEqual([]);
    });
  });
});

describe.each(paths)('a refusal from the database, met through %s', (_name, build) => {
  let write: Writers;
  beforeEach(() => {
    write = build();
  });

  /** The driver's answer is replaced; the model and everything after it stay real. */
  const refuse = (error: unknown): void => {
    jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce(error);
    jest.spyOn(ScheduleRun, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw error;
    });
  };

  it('reports a duplicate with no status when the row in the way is gone before it is read', async () => {
    refuse({ code: 11000, keyPattern: { scheduleId: 1, scheduledFor: 1 } });
    expect(await write.reserve(row())).toStrictEqual({
      conflict: 'duplicate',
      existingStatus: undefined,
    });
    expect(await stored()).toEqual([]);
  });

  it.each([
    ['overlap', 'scheduleId_1'],
    ['slot-taken', 'capacitySlot_1'],
  ] as const)('reads %s from an index named after any run of spaces', async (conflict, index) => {
    const error = {
      code: 11000,
      errmsg: `E11000 duplicate key error collection: test.scheduleruns index:  \t${index} dup key`,
    };
    refuse(error);
    expect(await write.reserve(row())).toEqual({ conflict });
    refuse(error);
    expect(await write.claim('sched_a', at, 0)).toEqual({ conflict });
  });

  it.each([
    ['nothing at all', null],
    ['a duplicate that names no index', { code: 11000, message: 'E11000 duplicate key error' }],
    [
      'a message that is not text',
      { code: 11000, message: { toString: (): string => 'E11000 index: scheduleId_1 dup key' } },
    ],
  ])('passes on, as it came, an error that holds %s', async (_held, error) => {
    refuse(error);
    await expect(write.reserve(row())).rejects.toBe(error);
    refuse(error);
    await expect(write.claim('sched_a', at, 0)).rejects.toBe(error);
  });
});

describe('the receipts a schedule adds for a tool that was refused', () => {
  const input = { scheduleId: 'sched_a', scheduledFor: at, conversationId: 'conversation-a' };
  const missing: ScheduleMCPOutcome = {
    server: 'Graph',
    detail: 'unattended_auth_required',
    status: 'mcp_configuration_missing',
  };

  type Given = { outcome?: ScheduleMCPOutcome; outcomes?: ScheduleMCPOutcome[] };
  const cases: Array<[string, Given, ScheduleMCPOutcome[]]> = [
    ['the server alone', {}, [missing]],
    ['one outcome', { outcome: denied }, [denied]],
    ['a list of outcomes', { outcomes: [ready, denied] }, [ready, denied]],
    ['a list and one outcome', { outcomes: [ready], outcome: denied }, [ready]],
    ['an empty list', { outcomes: [], outcome: denied }, []],
  ];

  it.each(cases)('adds what it is given as %s', async (_given, given, receipts) => {
    await seed(row());
    record();
    expect(await schedules.recordMCPToolAuthFailure({ ...input, server: 'Graph', ...given })).toBe(
      true,
    );

    const [update, ...rest] = commands();
    expect(text(update.args[1])).toBe(text({ $addToSet: { mcp: { $each: receipts } } }));
    expect(rest).toEqual([]);
    expect(await only()).toEqual(row({ mcp: receipts }));
  });
});

describe('a run reserved by what names it', () => {
  it('stores the subject and delivery time of the ref, whatever the row says', async () => {
    expect('run' in (await runs.reserve(ref('sched_a', at), { user: owner }))).toBe(true);
    expect(
      'run' in
        (await runs.reserve(
          ref('sched_b', later),
          row({ scheduleId: 'elsewhere', scheduledFor: before }),
        )),
    ).toBe(true);

    expect(
      (await stored()).map(({ scheduleId, scheduledFor, status }) => ({
        scheduleId,
        scheduledFor,
        status,
      })),
    ).toEqual([
      { scheduleId: 'sched_a', scheduledFor: at, status: 'started' },
      { scheduleId: 'sched_b', scheduledFor: later, status: 'started' },
    ]);
  });
});

describe('a subject whose runs are not on record', () => {
  it.each(['key', 'subscription'])('writes nothing for a %s', async (kind) => {
    const paused = row({ status: 'requires_action', capacitySlot: 0 });
    await seed(paused);
    const other = ref('sched_a', at, kind);
    record();

    expect(await runs.reserve(other, row({ scheduledFor: later }))).toEqual({
      conflict: 'unrecorded',
    });
    expect(
      await runs.detail(other, { conversationId: 'conversation-a', droppedFileIds: ['file-1'] }),
    ).toBeUndefined();
    expect(await runs.abort(other, 'stop')).toBe(false);
    expect(await runs.abort(other, 'deletion')).toBe(false);
    expect(await runs.abortSaved(other)).toBeUndefined();
    expect(await runs.claim(other, 1)).toEqual({ conflict: 'not-paused' });
    expect(await runs.release(other, 0)).toBe(false);
    expect(await runs.receipt(other, { conversationId: 'conversation-a' }, [ready])).toBe(false);
    expect(await runs.remove(other)).toBeUndefined();

    expect(commands()).toEqual([]);
    expect(await only()).toEqual(paused);
  });
});
