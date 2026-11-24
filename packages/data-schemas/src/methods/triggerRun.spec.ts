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

let mongoServer: MongoMemoryServer;
let ScheduleRun: Model<IScheduleRunDocument>;
let schedules: ScheduleMethods;
let runs: TriggerRuns;

type Query = { collection: string; method: string; args: unknown[] };
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
  // Built for each test, not once for the file, so a test that reads through them is also
  // the test that covers how they are put together.
  schedules = createScheduleMethods(mongoose);
  runs = createTriggerRuns(mongoose);
});

/**
 * Records every command sent to the run collection, as mongoose hands it to the driver. The
 * other models registered beside it build their indexes in the background and are left out.
 */
function record(): void {
  queries = [];
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    if (collection === ScheduleRun.collection.name) queries.push({ collection, method, args });
  });
}

const owner = new mongoose.Types.ObjectId();
const denied: ScheduleMCPOutcome = {
  server: 'Graph',
  status: 'mcp_reauth_required',
  recovery: 'authorize',
  skipped: true,
};

function ref(scheduleId: string, at: Date, kind = 'schedule'): TriggerRunRef {
  return { subject: { kind, id: scheduleId }, delivery: { event: { occurredAt: at.getTime() } } };
}

function row(overrides: Partial<IScheduleRun>): Partial<IScheduleRun> {
  return {
    scheduleId: 'sched_a',
    user: owner,
    scheduledFor: new Date('2026-11-21T08:00:00.000Z'),
    firedAt: new Date('2026-11-21T08:00:01.000Z'),
    status: 'started',
    ...overrides,
  };
}

/** One run in each state a reader meets: just reserved, started by hand, paused, settled. */
const states: Array<[string, Partial<IScheduleRun>]> = [
  [
    'fresh',
    row({
      conversationId: 'conversation-fresh',
      deliveryKey: 'agent-trigger:fresh',
      chatProjectId: 'project-1',
      capacitySlot: 0,
      mcp: [denied],
    }),
  ],
  [
    'manual',
    row({
      scheduledFor: new Date('2026-11-21T09:13:27.412Z'),
      conversationId: 'conversation-manual',
      deliveryKey: 'agent-trigger:manual',
      chatProjectId: null,
    }),
  ],
  [
    'paused',
    row({
      scheduledFor: new Date('2026-11-21T10:00:00.000Z'),
      status: 'requires_action',
      conversationId: 'conversation-paused',
      deliveryKey: 'agent-trigger:paused',
      chatProjectId: 'project-2',
      abortRequestedAt: new Date('2026-11-21T10:05:00.000Z'),
      abortSource: 'stop',
      mcp: [denied, { server: 'Mail', status: 'ready' }],
    }),
  ],
  [
    'settled',
    row({
      scheduledFor: new Date('2026-11-21T11:00:00.000Z'),
      status: 'error',
      error: 'provider unavailable',
      conversationId: 'conversation-settled',
      settledAt: new Date('2026-11-21T11:02:00.000Z'),
      abortRequestedAt: new Date('2026-11-21T11:01:00.000Z'),
      abortSource: 'stop',
      abortPersistedAt: new Date('2026-11-21T11:01:30.000Z'),
    }),
  ],
];

/**
 * The same runs as one schedule can hold them at once: it has a single started run, so the
 * one started by hand has since been interrupted.
 */
const together: Array<[string, Partial<IScheduleRun>]> = states.map(([name, data]) => [
  name,
  name === 'manual' ? { ...data, status: 'interrupted' } : data,
]);

describe('a run found by its subject and delivery', () => {
  it.each(states)('reads a %s run as its schedule readers do', async (_name, data) => {
    await ScheduleRun.collection.insertOne({ ...data });
    const at = data.scheduledFor as Date;
    const found = ref('sched_a', at);

    const project = await runs.get(found, ['chatProjectId']);
    const recorded = Object.prototype.hasOwnProperty.call(project, 'chatProjectId');
    expect(recorded).toBe(Object.prototype.hasOwnProperty.call(data, 'chatProjectId'));
    expect(await schedules.getScheduleRunProject('sched_a', at)).toEqual(
      recorded && project?.chatProjectId != null
        ? { recorded, chatProjectId: project.chatProjectId }
        : { recorded },
    );

    expect((await runs.get(found, ['mcp']))?.mcp ?? []).toEqual(data.mcp ?? []);
    expect(await schedules.getScheduleRunMCP('sched_a', at)).toEqual(data.mcp ?? []);

    const abort = await runs.get(found, [
      'status',
      'abortRequestedAt',
      'abortSource',
      'abortPersistedAt',
      'mcp',
    ]);
    expect(abort).toEqual(await schedules.getScheduleRunAbortState('sched_a', at));
    expect(abort?.status).toBe(data.status);
    expect(abort?.abortSource).toBe(data.abortSource);
    expect(abort?.abortPersistedAt).toEqual(data.abortPersistedAt);
  });

  it.each(states)('names a %s run by who it acts for and what started it', async (_name, data) => {
    await ScheduleRun.collection.insertOne({ ...data });
    const at = data.scheduledFor as Date;

    expect(
      await runs.get(ref('sched_a', at), [
        'subject',
        'delivery',
        'owner',
        'status',
        'conversationId',
        'error',
        'firedAt',
        'settledAt',
      ]),
    ).toEqual({
      subject: { kind: 'schedule', id: 'sched_a' },
      delivery: { at, key: data.deliveryKey },
      owner: owner.toString(),
      status: data.status,
      conversationId: data.conversationId,
      firedAt: data.firedAt,
      ...(data.error != null && { error: data.error }),
      ...(data.settledAt != null && { settledAt: data.settledAt }),
    });
  });

  it('leaves out the delivery key of a run recorded without one', async () => {
    const at = new Date('2026-11-21T12:00:00.000Z');
    await ScheduleRun.collection.insertOne(row({ scheduledFor: at, status: 'skipped_balance' }));

    expect(await runs.get(ref('sched_a', at), ['delivery', 'status'])).toStrictEqual({
      delivery: { at },
      status: 'skipped_balance',
    });
  });

  it('returns only the fields it was asked for', async () => {
    const [, data] = states[2];
    await ScheduleRun.collection.insertOne({ ...data });
    const found = ref('sched_a', data.scheduledFor as Date);

    expect(await runs.get(found, ['status'])).toStrictEqual({ status: 'requires_action' });
    // A field the run does not hold is left out, not returned empty.
    expect(await runs.get(found, ['error', 'settledAt', 'tenantId'])).toStrictEqual({});
  });

  it('returns every field a run holds', async () => {
    const at = new Date('2026-11-21T16:00:00.000Z');
    const data = row({
      scheduledFor: at,
      tenantId: 'tenant-a',
      status: 'interrupted',
      error: 'stopped',
      conversationId: 'conversation-full',
      deliveryKey: 'agent-trigger:full',
      chatProjectId: 'project-3',
      mcp: [denied],
      settledAt: new Date('2026-11-21T16:03:00.000Z'),
      abortRequestedAt: new Date('2026-11-21T16:01:00.000Z'),
      abortSource: 'deletion',
      abortPersistedAt: new Date('2026-11-21T16:02:00.000Z'),
    });
    await ScheduleRun.collection.insertOne({ ...data });

    expect(
      await runs.get(ref('sched_a', at), [
        'subject',
        'delivery',
        'owner',
        'tenantId',
        'status',
        'conversationId',
        'chatProjectId',
        'mcp',
        'error',
        'firedAt',
        'settledAt',
        'abortRequestedAt',
        'abortSource',
        'abortPersistedAt',
      ]),
    ).toStrictEqual({
      subject: { kind: 'schedule', id: 'sched_a' },
      delivery: { at, key: 'agent-trigger:full' },
      owner: owner.toString(),
      tenantId: 'tenant-a',
      status: 'interrupted',
      conversationId: 'conversation-full',
      chatProjectId: 'project-3',
      mcp: [denied],
      error: 'stopped',
      firedAt: data.firedAt,
      settledAt: data.settledAt,
      abortRequestedAt: data.abortRequestedAt,
      abortSource: 'deletion',
      abortPersistedAt: data.abortPersistedAt,
    });
  });

  it('keeps a run filed under no project apart from one recorded before projects were', async () => {
    const unscoped = new Date('2026-11-21T13:00:00.000Z');
    const legacy = new Date('2026-11-21T14:00:00.000Z');
    await ScheduleRun.collection.insertMany([
      row({ scheduledFor: unscoped, chatProjectId: null }),
      row({ scheduledFor: legacy, status: 'success' }),
    ]);

    expect(await runs.get(ref('sched_a', unscoped), ['chatProjectId'])).toEqual({
      chatProjectId: null,
    });
    expect(await runs.get(ref('sched_a', legacy), ['chatProjectId'])).toStrictEqual({});
  });

  it('finds nothing, without failing, for a delivery that started no run', async () => {
    const at = new Date('2026-11-21T08:00:00.000Z');
    await ScheduleRun.collection.insertOne(row({ scheduledFor: at }));

    expect(await runs.get(ref('sched_a', new Date(at.getTime() + 1)), ['status'])).toBeNull();
    expect(await runs.get(ref('sched_b', at), ['status'])).toBeNull();
    expect(await schedules.getScheduleRunAbortState('sched_b', at)).toBeNull();
    expect(await schedules.getScheduleRunProject('sched_b', at)).toBeNull();
    expect(await schedules.getScheduleRunMCP('sched_b', at)).toEqual([]);
  });

  it.each(['key', 'subscription'])(
    'finds nothing for a %s whose delivery names no key, and asks the database nothing',
    async (kind) => {
      const at = new Date('2026-11-21T08:00:00.000Z');
      await ScheduleRun.collection.insertOne(row({ scheduledFor: at, conversationId: 'c' }));
      record();

      expect(await runs.get(ref('sched_a', at, kind), ['status'])).toBeNull();
      expect(queries).toEqual([]);
    },
  );

  it('finds no run of a conversation for a key, which records none, and asks nothing', async () => {
    const at = new Date('2026-11-21T08:00:00.000Z');
    await ScheduleRun.collection.insertOne(row({ scheduledFor: at, conversationId: 'c' }));
    record();

    expect(
      await runs.byConversation(
        { subject: { kind: 'key', id: 'sched_a' }, owner: owner.toString() },
        'c',
        ['status'],
      ),
    ).toBeNull();
    expect(queries).toEqual([]);
  });

  it('surfaces a failed read as an error, not as an absent run', async () => {
    const failure = new Error('connection lost');
    const findOne = jest.spyOn(ScheduleRun, 'findOne').mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(runs.get(ref('sched_a', new Date()), ['status'])).rejects.toBe(failure);
      await expect(schedules.getScheduleRunMCP('sched_a', new Date())).rejects.toBe(failure);
    } finally {
      findOne.mockRestore();
    }
  });
});

describe('a run found by the conversation it started', () => {
  const scope = { subject: { kind: 'schedule', id: 'sched_a' }, owner: owner.toString() };

  beforeEach(async () => {
    await ScheduleRun.collection.insertMany(together.map(([, data]) => ({ ...data })));
  });

  it.each(together)('reads a %s run as its schedule reader does', async (_name, data) => {
    const conversationId = data.conversationId as string;
    const run = await runs.byConversation(scope, conversationId, ['mcp', 'status', 'delivery']);

    expect(run?.status).toBe(data.status);
    expect(run?.delivery.at).toEqual(data.scheduledFor);
    expect(run?.mcp ?? []).toEqual(data.mcp ?? []);
    expect(
      await schedules.getScheduleConversationMCP(
        { scheduleId: 'sched_a', ownerId: owner.toString(), tenantId: null },
        conversationId,
      ),
    ).toEqual(data.mcp ?? []);
  });

  it('finds nothing for another owner, tenant, subject or conversation', async () => {
    const other = new mongoose.Types.ObjectId().toString();

    expect(
      await runs.byConversation({ ...scope, owner: other }, 'conversation-fresh', ['status']),
    ).toBeNull();
    expect(
      await runs.byConversation({ ...scope, tenantId: 'tenant-b' }, 'conversation-fresh', [
        'status',
      ]),
    ).toBeNull();
    expect(
      await runs.byConversation(
        { ...scope, subject: { kind: 'schedule', id: 'sched_b' } },
        'conversation-fresh',
        ['status'],
      ),
    ).toBeNull();
    expect(await runs.byConversation(scope, 'conversation-unknown', ['status'])).toBeNull();
  });

  it('takes the latest fired when a conversation holds more than one run', async () => {
    await ScheduleRun.collection.insertOne(
      row({
        scheduledFor: new Date('2026-11-21T15:00:00.000Z'),
        firedAt: new Date('2026-11-21T15:00:01.000Z'),
        status: 'success',
        conversationId: 'conversation-fresh',
      }),
    );

    expect(await runs.byConversation(scope, 'conversation-fresh', ['status'])).toEqual({
      status: 'success',
    });
  });
});

/** The indexes the server can answer a recorded query from, and the one it picks. */
async function plan(query: Query): Promise<{ picked?: string; usable: string[] }> {
  const [filter, options] = query.args as [
    Record<string, unknown>,
    { sort?: Record<string, 1 | -1> } | undefined,
  ];
  const cursor = ScheduleRun.collection.find(filter, { sort: options?.sort }).limit(1);
  const { winningPlan, rejectedPlans } = (await cursor.explain('queryPlanner')).queryPlanner;
  const names = (value: unknown) =>
    [...JSON.stringify(value).matchAll(/"indexName":"([^"]+)"/g)].map((match) => match[1]);
  const [picked] = names(winningPlan);
  return { picked, usable: [...names(winningPlan), ...names(rejectedPlans)] };
}

describe('what a schedule reader asks the database', () => {
  const at = new Date('2026-11-21T08:00:00.000Z');
  const occurrence = { scheduleId: 'sched_a', scheduledFor: at };

  beforeEach(async () => {
    await ScheduleRun.collection.insertMany(together.map(([, data]) => ({ ...data })));
    record();
  });

  it('reads an occurrence in one lookup on the unique occurrence index', async () => {
    await schedules.getScheduleRunProject('sched_a', at.toISOString());
    await schedules.getScheduleRunMCP('sched_a', at);
    await schedules.getScheduleRunAbortState('sched_a', at);
    mongoose.set('debug', false);

    expect(queries).toEqual([
      {
        collection: 'scheduleruns',
        method: 'findOne',
        args: [occurrence, { projection: { chatProjectId: 1 } }],
      },
      {
        collection: 'scheduleruns',
        method: 'findOne',
        args: [occurrence, { projection: { mcp: 1 } }],
      },
      {
        collection: 'scheduleruns',
        method: 'findOne',
        args: [
          occurrence,
          {
            projection: {
              status: 1,
              abortRequestedAt: 1,
              abortSource: 1,
              abortPersistedAt: 1,
              mcp: 1,
            },
          },
        ],
      },
    ]);
    for (const query of queries) {
      expect((await plan(query)).picked).toBe('scheduleId_1_scheduledFor_1');
    }
  });

  it("reads a conversation's run in one lookup the owner and conversation index serves", async () => {
    mongoose.set('debug', false);
    // A schedule that has since run many times: the run sought is far from its latest.
    await ScheduleRun.collection.insertMany(
      Array.from({ length: 300 }, (_, minute) =>
        row({
          scheduledFor: new Date(Date.UTC(2026, 10, 22, 0, minute)),
          firedAt: new Date(Date.UTC(2026, 10, 22, 0, minute, 1)),
          status: 'success',
          conversationId: `conversation-later-${minute}`,
        }),
      ),
    );
    record();
    await schedules.getScheduleConversationMCP(
      { scheduleId: 'sched_a', ownerId: owner.toString(), tenantId: null },
      'conversation-paused',
    );
    mongoose.set('debug', false);

    expect(queries).toEqual([
      {
        collection: 'scheduleruns',
        method: 'findOne',
        args: [
          {
            user: owner,
            tenantId: null,
            conversationId: 'conversation-paused',
            scheduleId: 'sched_a',
          },
          { sort: { firedAt: -1 }, projection: { mcp: 1 } },
        ],
      },
    ]);
    // Two indexes can answer it and the server weighs them itself, so its pick is not pinned
    // here: only that it reads from an index, and that the owner's conversations are one.
    const { picked, usable } = await plan(queries[0]);
    expect(picked).toBeDefined();
    expect(usable).toContain('user_1_tenantId_1_conversationId_1');
  });
});
