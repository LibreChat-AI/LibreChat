import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { IScheduleRun, IScheduleRunDocument } from '~/types/schedule';
import type { RecordedRunRef, TriggerRunRef } from '~/types/triggerRun';
import type { TriggerRuns } from './triggerRun';
import { createTriggerRuns } from './triggerRun';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;

let mongoServer: MongoMemoryServer;
let ScheduleRun: Model<IScheduleRunDocument>;
let runs: TriggerRuns;

type Query = { method: string; args: unknown[] };
let queries: Query[] = [];

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
  queries = [];
  // Built for each test, so the test that reads through it also covers how it is put together.
  runs = createTriggerRuns(mongoose);
});

function record(): void {
  queries = [];
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    if (collection === ScheduleRun.collection.name) queries.push({ method, args });
  });
}

const owner = new mongoose.Types.ObjectId();
const at = new Date('2026-11-23T08:00:00.000Z');
const fired = new Date('2026-11-23T08:00:01.000Z');

/** The delivery of a subscription: found by its key, with the time of the event it carried. */
function ref(key: string, id = 'sub_a', occurredAt = at): RecordedRunRef {
  return {
    subject: { kind: 'subscription', id },
    delivery: { key, event: { occurredAt: occurredAt.getTime() } },
  };
}

/** What a caller hands a starting run: nothing that names the row. */
function fresh(overrides: Partial<IScheduleRun> = {}): Partial<IScheduleRun> {
  return { user: owner, firedAt: fired, conversationId: 'conversation-a', ...overrides };
}

/** The row of a schedule, as the schedule methods store one. */
function schedule(overrides: Partial<IScheduleRun> = {}): Partial<IScheduleRun> {
  return {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: at,
    firedAt: fired,
    status: 'started',
    conversationId: 'conversation-s',
    ...overrides,
  };
}

const stored = (filter: Record<string, unknown> = {}): Promise<IScheduleRun[]> =>
  ScheduleRun.find(filter).sort({ _id: 1 }).select('-_id -__v -createdAt -updatedAt').lean();

const skipped: ScheduleMCPOutcome = {
  server: 'Graph',
  status: 'mcp_reauth_required',
  recovery: 'authorize',
  skipped: true,
};

describe('the indexes a run row is held by', () => {
  it('builds one row per delivery beside the three schedule rules, which stand as they were', async () => {
    const indexes = await ScheduleRun.collection.indexes();
    const named = (name: string) => {
      const { key, unique, partialFilterExpression } = indexes.find((i) => i.name === name) ?? {};
      return { key, unique, partialFilterExpression };
    };

    expect(named('deliveryKey_1')).toEqual({
      key: { deliveryKey: 1 },
      unique: true,
      partialFilterExpression: { kind: 'subscription' },
    });
    expect(named('scheduleId_1_scheduledFor_1')).toEqual({
      key: { scheduleId: 1, scheduledFor: 1 },
      unique: true,
      partialFilterExpression: undefined,
    });
    expect(named('scheduleId_1')).toEqual({
      key: { scheduleId: 1 },
      unique: true,
      partialFilterExpression: { status: 'started' },
    });
    expect(named('capacitySlot_1')).toEqual({
      key: { capacitySlot: 1 },
      unique: true,
      partialFilterExpression: { status: 'started', capacitySlot: { $exists: true } },
    });
  });

  it('holds subscription rows only: schedule rows that share a delivery key stay out', async () => {
    await ScheduleRun.collection.insertMany([
      schedule({ deliveryKey: 'trigger_shared' }),
      schedule({ scheduleId: 'sched_b', deliveryKey: 'trigger_shared' }),
      schedule({ scheduleId: 'sched_c', status: 'success' }),
    ]);
    expect(await runs.reserve(ref('trigger_shared'), fresh())).toHaveProperty('run');

    const held = await ScheduleRun.collection
      .find({ kind: 'subscription' })
      .hint('deliveryKey_1')
      .toArray();
    expect(held.map((row) => row.subject)).toEqual(['sub_a']);
    expect(await ScheduleRun.countDocuments({})).toBe(4);
  });

  it('answers the lookup of a delivery from that index', async () => {
    await runs.reserve(ref('trigger_a'), fresh());
    record();
    await runs.get(ref('trigger_a'), ['status']);
    mongoose.set('debug', false);

    expect(queries).toEqual([
      {
        method: 'findOne',
        args: [
          { kind: 'subscription', subject: 'sub_a', deliveryKey: 'trigger_a' },
          { projection: { status: 1 } },
        ],
      },
    ]);
    const [filter] = queries[0].args as [Record<string, unknown>];
    const { winningPlan } = (
      await ScheduleRun.collection.find(filter).limit(1).explain('queryPlanner')
    ).queryPlanner;
    expect(JSON.stringify(winningPlan)).toContain('"indexName":"deliveryKey_1"');
  });
});

describe('the row of a subscription run that is starting', () => {
  it('stores whose run it is, its delivery, and the key under the columns every row holds', async () => {
    const reserved = await runs.reserve(ref('trigger_a'), fresh({ capacitySlot: 0 }));

    expect(reserved).toHaveProperty('run');
    expect(await stored()).toEqual([
      {
        kind: 'subscription',
        subject: 'sub_a',
        deliveryKey: 'trigger_a',
        scheduleId: 'trigger_a',
        scheduledFor: at,
        user: owner,
        firedAt: fired,
        conversationId: 'conversation-a',
        capacitySlot: 0,
        status: 'started',
      },
    ]);
  });

  it('takes its place from the ref, whatever the row given names', async () => {
    await runs.reserve(
      ref('trigger_a'),
      fresh({
        scheduleId: 'sched_a',
        scheduledFor: fired,
        deliveryKey: 'trigger_other',
        subject: 'sub_other',
      }),
    );

    expect(await stored()).toEqual([
      expect.objectContaining({
        subject: 'sub_a',
        deliveryKey: 'trigger_a',
        scheduleId: 'trigger_a',
        scheduledFor: at,
      }),
    ]);
  });

  it('starts two deliveries of one subscription that carry the same millisecond', async () => {
    const both = await Promise.all([
      runs.reserve(ref('trigger_a'), fresh({ capacitySlot: 0 })),
      runs.reserve(ref('trigger_b'), fresh({ capacitySlot: 1 })),
    ]);

    expect(both.every((outcome) => 'run' in outcome)).toBe(true);
    expect((await stored()).map((row) => [row.deliveryKey, row.status, row.scheduledFor])).toEqual(
      expect.arrayContaining([
        ['trigger_a', 'started', at],
        ['trigger_b', 'started', at],
      ]),
    );
  });

  it('starts one run for a delivery sent twice at once', async () => {
    const both = await Promise.all([
      runs.reserve(ref('trigger_a'), fresh()),
      runs.reserve(ref('trigger_a'), fresh()),
    ]);

    expect(both.filter((outcome) => 'run' in outcome)).toHaveLength(1);
    expect(both.filter((outcome) => 'conflict' in outcome)).toEqual([
      { conflict: 'duplicate', existingStatus: 'started' },
    ]);
    expect(await stored()).toHaveLength(1);
  });

  it('refuses a delivery whose run is finished, with what it ended as', async () => {
    await runs.reserve(ref('trigger_a'), fresh());
    await runs.finish(ref('trigger_a'), { status: 'success' });

    expect(await runs.reserve(ref('trigger_a'), fresh())).toEqual({
      conflict: 'duplicate',
      existingStatus: 'success',
    });
    expect(await stored()).toHaveLength(1);
  });

  it('refuses the same delivery under another event time, which only its key can tell', async () => {
    await runs.reserve(ref('trigger_a'), fresh());
    await runs.finish(ref('trigger_a'), { status: 'success' });

    expect(await runs.reserve(ref('trigger_a', 'sub_a', fired), fresh())).toEqual({
      conflict: 'duplicate',
      existingStatus: 'success',
    });
    expect(await stored()).toHaveLength(1);
  });

  it.each([
    ['the delivery index', 'deliveryKey_1', { deliveryKey: 1 }],
    ['the active-run index', 'scheduleId_1', { scheduleId: 1 }],
    ['the occurrence index', 'scheduleId_1_scheduledFor_1', { scheduleId: 1, scheduledFor: 1 }],
  ])(
    'reads a second insert refused by %s as the same delivery',
    async (_name, index, keyPattern) => {
      await runs.reserve(ref('trigger_a'), fresh());
      const refusals = [
        { code: 11000, keyPattern },
        { code: 11000, errmsg: 'E11000 duplicate key error collection: runs index: ' + index },
      ];
      for (const error of refusals) {
        const create = jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce(error as never);
        try {
          expect(await runs.reserve(ref('trigger_a'), fresh())).toEqual({
            conflict: 'duplicate',
            existingStatus: 'started',
          });
        } finally {
          create.mockRestore();
        }
      }
    },
  );

  it('shares the capacity slots with schedules, in both directions', async () => {
    await ScheduleRun.create(schedule({ capacitySlot: 0 }));

    expect(await runs.reserve(ref('trigger_a'), fresh({ capacitySlot: 0 }))).toEqual({
      conflict: 'slot-taken',
    });
    expect(await runs.reserve(ref('trigger_a'), fresh({ capacitySlot: 1 }))).toHaveProperty('run');
    await expect(
      ScheduleRun.create(schedule({ scheduleId: 'sched_b', capacitySlot: 1 })),
    ).rejects.toMatchObject({ code: 11000, keyPattern: { capacitySlot: 1 } });
  });

  it('passes on an error that is not a refusal by an index', async () => {
    const failure = new Error('connection lost');
    const create = jest.spyOn(ScheduleRun, 'create').mockRejectedValueOnce(failure as never);
    try {
      await expect(runs.reserve(ref('trigger_a'), fresh())).rejects.toBe(failure);
    } finally {
      create.mockRestore();
    }
  });

  it.each([undefined, ''])('keeps no row for a delivery whose key is %p', async (key) => {
    const keyless: TriggerRunRef = {
      subject: { kind: 'subscription', id: 'sub_a' },
      delivery: { key, event: { occurredAt: at.getTime() } },
    };
    record();

    expect(await runs.reserve(keyless, fresh())).toEqual({ conflict: 'unrecorded' });
    expect(await runs.get(keyless, ['status'])).toBeNull();
    expect(await runs.finish(keyless, { status: 'success' })).toBeNull();
    expect(queries).toEqual([]);
  });
});

describe('a delivery that names a key for a subject of another kind', () => {
  it('is not a subscription run: nothing is read or written for it', async () => {
    await runs.reserve(ref('trigger_a'), fresh());
    const other: TriggerRunRef = {
      subject: { kind: 'key', id: 'sub_a' },
      delivery: { key: 'trigger_a', event: { occurredAt: at.getTime() } },
    };
    record();

    expect(await runs.get(other, ['status'])).toBeNull();
    expect(await runs.reserve(other, fresh())).toEqual({ conflict: 'unrecorded' });
    expect(await runs.finish(other, { status: 'success' })).toBeNull();
    expect(await runs.remove(other)).toBeUndefined();
    expect(queries).toEqual([]);
    mongoose.set('debug', false);
    expect((await stored()).map((row) => row.status)).toEqual(['started']);
  });
});

describe('reading a subscription run', () => {
  beforeEach(async () => {
    await ScheduleRun.create(schedule());
    await runs.reserve(ref('trigger_a'), fresh({ tenantId: 'tenant-a', configRevision: 4 }));
  });

  it('reads the subject from the row and not from the key that stands as its schedule', async () => {
    record();
    const run = await runs.get(ref('trigger_a'), ['subject', 'delivery', 'owner', 'revision']);
    mongoose.set('debug', false);

    expect(run).toEqual({
      subject: { kind: 'subscription', id: 'sub_a' },
      delivery: { at, key: 'trigger_a' },
      owner: owner.toString(),
      revision: 4,
    });
    expect(queries).toEqual([
      {
        method: 'findOne',
        args: [
          { kind: 'subscription', subject: 'sub_a', deliveryKey: 'trigger_a' },
          {
            projection: {
              subject: 1,
              scheduledFor: 1,
              deliveryKey: 1,
              user: 1,
              configRevision: 1,
            },
          },
        ],
      },
    ]);
  });

  it('never answers for a key filed under another subscription, or for the row of a schedule', async () => {
    expect(await runs.get(ref('trigger_a', 'sub_b'), ['status'])).toBeNull();
    expect(await runs.get(ref('trigger_missing'), ['status'])).toBeNull();
    expect(
      await runs.get(
        {
          subject: { kind: 'schedule', id: 'sched_a' },
          delivery: { event: { occurredAt: at.getTime() } },
        },
        ['subject'],
      ),
    ).toEqual({ subject: { kind: 'schedule', id: 'sched_a' } });
  });

  it('finds the run that started a conversation, among one owner and one subscription', async () => {
    const scope = (id: string, tenantId?: string, user = owner) => ({
      subject: { kind: 'subscription', id },
      owner: user.toString(),
      tenantId,
    });
    const found = (who: ReturnType<typeof scope>, conversationId = 'conversation-a') =>
      runs.byConversation(who, conversationId, ['subject', 'status']);

    expect(await found(scope('sub_a', 'tenant-a'))).toEqual({
      subject: { kind: 'subscription', id: 'sub_a' },
      status: 'started',
    });
    expect(await found(scope('sub_b', 'tenant-a'))).toBeNull();
    expect(await found(scope('sub_a', 'tenant-b'))).toBeNull();
    expect(await found(scope('sub_a'))).toBeNull();
    expect(await found(scope('sub_a', 'tenant-a', new mongoose.Types.ObjectId()))).toBeNull();
    // The row of a schedule in the same conversation is not a subscription run.
    expect(await found(scope('sub_a', 'tenant-a'), 'conversation-s')).toBeNull();
  });

  it('answers with the latest fired, should a conversation hold two of its runs', async () => {
    await runs.reserve(
      ref('trigger_b'),
      fresh({ tenantId: 'tenant-a', firedAt: new Date(fired.getTime() + 1000) }),
    );

    expect(
      await runs.byConversation(
        {
          subject: { kind: 'subscription', id: 'sub_a' },
          owner: owner.toString(),
          tenantId: 'tenant-a',
        },
        'conversation-a',
        ['delivery'],
      ),
    ).toEqual({ delivery: { at, key: 'trigger_b' } });
  });
});

describe('writing a subscription run, beside a schedule run that shares its event time', () => {
  const beside = schedule({ capacitySlot: 7 });
  const run = ref('trigger_a');

  beforeEach(async () => {
    await ScheduleRun.create(beside);
    await runs.reserve(run, fresh({ capacitySlot: 0, configRevision: 4 }));
  });

  const mine = async (): Promise<IScheduleRun> => (await stored({ kind: 'subscription' }))[0];

  it('adds what an accepted fire learned, with the server the run went without', async () => {
    await runs.detail(run, {
      conversationId: 'conversation-a',
      droppedFileIds: ['file-1'],
      mcp: [skipped],
    });

    expect(await mine()).toMatchObject({ droppedFileIds: ['file-1'], mcp: [skipped] });
    expect(await runs.get(run, ['mcp'])).toEqual({ mcp: [skipped] });
  });

  it('adds a receipt to the live run bound to its conversation, and to no other', async () => {
    expect(await runs.receipt(run, { conversationId: 'conversation-other' }, [skipped])).toBe(
      false,
    );
    expect(await runs.receipt(run, { conversationId: 'conversation-a' }, [skipped])).toBe(true);
    expect((await mine()).mcp).toEqual([skipped]);
  });

  it('records a stop, holds a second one off, and lets the run settle once it is saved', async () => {
    expect(await runs.abort(run, 'stop')).toBe(true);
    expect(await runs.abort(run, 'stop')).toBe('in_progress');
    expect(await mine()).toMatchObject({ abortSource: 'stop', capacitySlot: 0, status: 'started' });

    await runs.abortSaved(run);
    expect((await mine()).abortPersistedAt).toBeInstanceOf(Date);
    expect(await runs.abort(run, 'deletion')).toBe(true);
    expect(await runs.abort(ref('trigger_missing'), 'stop')).toBe(false);
    expect(await runs.abort(ref('trigger_missing'), 'deletion')).toBe(false);
  });

  it('pauses, which frees the slot, then claims a slot again and gives it back', async () => {
    expect(await runs.pause(run, { checkpointNamespace: 'ns' })).toEqual({
      firedAt: fired,
      revision: 4,
    });
    expect(await mine()).toMatchObject({ status: 'requires_action' });
    expect(await mine()).not.toHaveProperty('capacitySlot');

    expect(await runs.claim(run, 7)).toEqual({ conflict: 'slot-taken' });
    expect(await runs.claim(run, 3)).toEqual({ capacitySlot: 3 });
    expect(await runs.claim(run, 4)).toEqual({ conflict: 'not-paused' });
    expect(await mine()).toMatchObject({ status: 'started', capacitySlot: 3 });

    expect(await runs.release(run, 4)).toBe(false);
    expect(await runs.release(run, 3)).toBe(true);
    expect(await mine()).toMatchObject({ status: 'requires_action' });
  });

  it('ends the run, frees its slot, and leaves it unsettled until its subject marks it', async () => {
    expect(await runs.finish(run, { status: 'error', error: 'boom', durationMs: 12 })).toEqual({
      status: 'error',
      error: 'boom',
      mcp: undefined,
      firedAt: fired,
      revision: 4,
    });
    const ended = await mine();
    expect(ended).toMatchObject({
      status: 'error',
      error: 'boom',
      durationMs: 12,
      bookkept: false,
    });
    expect(ended.settledAt).toBeInstanceOf(Date);
    expect(ended).not.toHaveProperty('capacitySlot');
    // A crash here leaves the mark unset, which is what a replay of the subject step reads.
    expect(await runs.finish(run, { status: 'success' })).toBeNull();

    await runs.settled(run);
    expect((await mine()).bookkept).toBe(true);
  });

  it('ends a run as an error when a receipt on its row refuses it', async () => {
    const refused: ScheduleMCPOutcome = {
      server: 'Graph',
      status: 'mcp_reauth_required',
      detail: 'unattended_auth_required',
    };
    await runs.receipt(run, { conversationId: 'conversation-a' }, [refused]);

    expect(await runs.pause(run, {})).toBeNull();
    expect(await runs.finish(run, { status: 'success' })).toMatchObject({
      status: 'error',
      error: 'MCP unattended authorization unavailable',
    });
  });

  it('reaches no row of the schedule through any writer', async () => {
    await runs.detail(run, { conversationId: 'conversation-a', mcp: [skipped] });
    await runs.receipt(run, { conversationId: 'conversation-a' }, [skipped]);
    await runs.abort(run, 'stop');
    await runs.abortSaved(run);
    await runs.pause(run, { conversationId: 'conversation-a' });
    await runs.claim(run, 3);
    await runs.release(run, 3);
    await runs.finish(run, { status: 'interrupted' });
    await runs.settled(run);
    expect(await stored({ scheduleId: 'sched_a' })).toEqual([beside]);

    await runs.remove(run);
    expect(await stored()).toEqual([beside]);
  });

  it('deletes the row only while it holds what is expected of it', async () => {
    await runs.remove(run, { status: 'success' });
    await runs.remove(run, { status: 'started', conversationId: 'conversation-other' });
    expect(await stored({ kind: 'subscription' })).toHaveLength(1);

    await runs.remove(run, { status: 'started', conversationId: 'conversation-a' });
    expect(await stored({ kind: 'subscription' })).toEqual([]);
  });
});

describe('the row of a subscription run that never starts', () => {
  it('stores the skip under its delivery, unsettled, and answers a retry from that row', async () => {
    const first = await runs.skip(ref('trigger_a'), {
      user: owner,
      status: 'skipped_balance',
      configRevision: 4,
    });

    expect(first).toEqual({ firedAt: expect.any(Date), revision: 4 });
    expect(await stored()).toEqual([
      {
        kind: 'subscription',
        subject: 'sub_a',
        deliveryKey: 'trigger_a',
        scheduleId: 'trigger_a',
        scheduledFor: at,
        user: owner,
        status: 'skipped_balance',
        configRevision: 4,
        firedAt: first?.firedAt,
        settledAt: first?.firedAt,
        bookkept: false,
      },
    ]);
    expect(await runs.skip(ref('trigger_a'), { user: owner, status: 'skipped_balance' })).toEqual(
      first,
    );
    expect(
      await runs.skip(ref('trigger_a'), { user: owner, status: 'skipped_overlap' }),
    ).toBeNull();
    expect(await stored()).toHaveLength(1);
  });

  it('never reads a run that started as a skip', async () => {
    await runs.reserve(ref('trigger_a'), fresh());

    expect(
      await runs.skip(ref('trigger_a'), { user: owner, status: 'skipped_balance' }),
    ).toBeNull();
    expect((await stored())[0].status).toBe('started');
  });
});
