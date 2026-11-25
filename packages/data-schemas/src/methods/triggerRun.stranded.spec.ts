import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { RecordedRunRef, TriggerRunRef } from '~/types/triggerRun';
import type { IScheduleRunDocument } from '~/types/schedule';
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

const owner = new mongoose.Types.ObjectId();
const at = new Date('2026-11-24T08:00:00.000Z');
const minutes = (n: number) => new Date(at.getTime() + n * 60_000);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  ScheduleRun = mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;
  await ScheduleRun.init();
  // As the release that drops the two legacy indexes leaves the collection, so a
  // subscription's rows can be written.
  for (const name of ['scheduleId_1_scheduledFor_1', 'scheduleId_1']) {
    const names = new Set((await ScheduleRun.collection.indexes()).map((index) => index.name));
    if (names.has(name)) await ScheduleRun.collection.dropIndex(name);
  }
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  mongoose.set('debug', false);
  await mongoose.disconnect();
  await mongoServer?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  mongoose.set('debug', false);
  await ScheduleRun.deleteMany({});
  runs = createTriggerRuns(mongoose);
});

afterEach(() => {
  mongoose.set('debug', false);
});

function ref(key: string, id = 'sub_a'): RecordedRunRef {
  return {
    subject: { kind: 'subscription', id },
    delivery: { key, event: { occurredAt: at.getTime() } },
  };
}

async function started(key: string, firedAt: Date, id = 'sub_a'): Promise<void> {
  const result = await runs.reserve(ref(key, id), {
    user: owner,
    firedAt,
    configRevision: 2,
    conversationId: `c-${key}`,
  });
  expect(result).toHaveProperty('run');
}

const keys = (found: Awaited<ReturnType<TriggerRuns['stranded']>>) =>
  found.map(({ ref: { delivery } }) => delivery.key);

describe("stranded: a subscription's runs someone has to finish", () => {
  it('finds runs still active that fired before the cutoff, oldest first', async () => {
    await started('late', minutes(3));
    await started('early', minutes(1));
    await started('fresh', minutes(20));
    const found = await runs.stranded('subscription', minutes(10), 10);
    expect(keys(found)).toEqual(['early', 'late']);
    expect(found[0]).toEqual({
      ref: ref('early'),
      run: {
        status: 'started',
        owner: owner.toString(),
        firedAt: minutes(1),
        revision: 2,
        conversationId: 'c-early',
      },
    });
  });

  it('finds a paused run as well as a started one', async () => {
    await started('paused', minutes(1));
    await runs.pause(ref('paused'), {});
    const found = await runs.stranded('subscription', minutes(10), 10);
    expect(found.map(({ run }) => run.status)).toEqual(['requires_action']);
  });

  it('finds an ended run whose subscription step never landed, and not one that did', async () => {
    await started('crashed', minutes(1));
    await started('done', minutes(1));
    await runs.finish(ref('crashed'), { status: 'error', error: 'failed' });
    await runs.finish(ref('done'), { status: 'success' });
    await runs.settled(ref('done'));
    const found = await runs.stranded('subscription', new Date(Date.now() + 60_000), 10);
    expect(keys(found)).toEqual(['crashed']);
    expect(found[0].run.status).toBe('error');
  });

  it('leaves out an ended run that has not waited past the cutoff', async () => {
    await started('recent', minutes(1));
    await runs.finish(ref('recent'), { status: 'success' });
    expect(await runs.stranded('subscription', new Date(Date.now() - 60_000), 10)).toEqual([]);
  });

  it("never returns a schedule's row", async () => {
    await ScheduleRun.create({
      scheduleId: 'sched_a',
      user: owner,
      scheduledFor: at,
      firedAt: minutes(1),
      status: 'started',
    });
    await ScheduleRun.create({
      scheduleId: 'sched_b',
      user: owner,
      scheduledFor: at,
      firedAt: minutes(1),
      settledAt: minutes(2),
      status: 'error',
      bookkept: false,
    });
    expect(await runs.stranded('subscription', new Date(Date.now() + 60_000), 10)).toEqual([]);
  });

  it('is not crowded out of its limit by older schedule rows', async () => {
    for (const id of ['sched_a', 'sched_b', 'sched_c']) {
      await ScheduleRun.create({
        scheduleId: id,
        user: owner,
        scheduledFor: at,
        firedAt: minutes(0),
        status: 'started',
      });
    }
    await started('mine', minutes(1));
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['mine']);
  });

  it('moves the rows it returned to the back of the next window', async () => {
    for (const [key, at] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const)
      await started(key, minutes(at));
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['a', 'b']);
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['c', 'a']);
    const stamped = await ScheduleRun.find({ kind: 'subscription' }).lean();
    expect(stamped.every((row) => row.reconciledAt instanceof Date)).toBe(true);
  });

  it('lets one caller count a run, once, however many ask at once', async () => {
    await started('a', minutes(1));
    const answers = await Promise.all(Array.from({ length: 5 }, () => runs.count(ref('a'))));
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await runs.count(ref('a'))).toBe(false);
    expect(await runs.count(ref('none'))).toBe(false);
  });

  it('reads at most the limit of each kind', async () => {
    for (const key of ['a', 'b', 'c']) await started(key, minutes(1));
    for (const key of ['d', 'e', 'f']) {
      await started(key, minutes(1));
      await runs.finish(ref(key), { status: 'error' });
    }
    const found = await runs.stranded('subscription', new Date(Date.now() + 60_000), 2);
    expect(found.filter(({ run }) => run.status === 'started')).toHaveLength(2);
    expect(found.filter(({ run }) => run.status === 'error')).toHaveLength(2);
  });
});

/** A time before every write a test makes, so a write that stamps `updatedAt` moves it. */
const old = new Date('2026-01-01T00:00:00.000Z');

/** Writes columns straight to the stored row, past the model's timestamps. */
async function store(key: string, set: Record<string, unknown>): Promise<void> {
  await ScheduleRun.collection.updateOne(
    { deliveryKey: key },
    { $set: { updatedAt: old, ...set } },
  );
}

async function row(key: string) {
  return ScheduleRun.findOne({ deliveryKey: key }).lean();
}

/** A run that ended at `settledAt` without its subscription's step landing. */
async function ended(key: string, settledAt: Date, reconciledAt?: Date): Promise<void> {
  await started(key, minutes(0));
  await runs.finish(ref(key), { status: 'error', error: 'failed' });
  await store(key, { settledAt, ...(reconciledAt != null ? { reconciledAt } : {}) });
}

/** Records the name of every command sent to the run collection from here on. */
function record(): string[] {
  const sent: string[] = [];
  mongoose.set('debug', (collection: string, method: string) => {
    if (collection === ScheduleRun.collection.name && method !== 'createIndex') sent.push(method);
  });
  return sent;
}

describe('stranded: ended runs still owing their subscription step', () => {
  beforeEach(async () => {
    // Stored in neither the order they are owed nor the order they settled in.
    await ended('p', minutes(1), minutes(2));
    await ended('q', minutes(5));
    await ended('r', minutes(3));
    await ended('s', minutes(2), minutes(1));
  });

  it('returns the least recently examined first, then the earliest settled', async () => {
    expect(keys(await runs.stranded('subscription', minutes(10), 3))).toEqual(['r', 'q', 's']);
  });

  it('stamps every row it returns as examined, and no other', async () => {
    const before = new Date();
    await runs.stranded('subscription', minutes(10), 3);
    for (const key of ['r', 'q', 's']) {
      expect((await row(key))?.reconciledAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    }
    expect((await row('p'))?.reconciledAt).toEqual(minutes(2));
  });

  it('returns the rows the last window left out first on the next call', async () => {
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['r', 'q']);
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['s', 'p']);
    expect(keys(await runs.stranded('subscription', minutes(10), 2))).toEqual(['r', 'q']);
  });

  it('leaves the time a row was last updated alone', async () => {
    await runs.stranded('subscription', minutes(10), 4);
    for (const key of ['p', 'q', 'r', 's']) expect((await row(key))?.updatedAt).toEqual(old);
  });

  it('sends no write when it finds nothing', async () => {
    const sent = record();
    expect(await runs.stranded('subscription', minutes(0), 4)).toEqual([]);
    expect(sent).toEqual(['find', 'find']);
  });
});

describe('count: the claim to count a run once', () => {
  beforeEach(async () => {
    await started('a', minutes(1));
    await started('b', minutes(1));
    await store('a', {});
    await store('b', {});
  });

  it('marks the row counted for the first caller, and answers no to the next', async () => {
    expect(await runs.count(ref('a'))).toBe(true);
    expect((await row('a'))?.counted).toBe(true);
    expect(await runs.count(ref('a'))).toBe(false);
    expect((await row('a'))?.counted).toBe(true);
  });

  it('counts only the run it is given', async () => {
    expect(await runs.count(ref('a'))).toBe(true);
    expect((await row('b'))?.counted).toBeUndefined();
    expect(await runs.count(ref('b'))).toBe(true);
    expect((await row('b'))?.counted).toBe(true);
  });

  it('counts a run whose row is stored as not counted', async () => {
    await store('a', { counted: false });
    expect(await runs.count(ref('a'))).toBe(true);
    expect((await row('a'))?.counted).toBe(true);
  });

  it('answers no for a ref that names no row, and writes nothing', async () => {
    const keyless: TriggerRunRef = {
      subject: { kind: 'subscription', id: 'sub_a' },
      delivery: { event: { occurredAt: at.getTime() } },
    };
    expect(await runs.count(keyless)).toBe(false);
    expect(await runs.count(ref('none'))).toBe(false);
    expect((await row('a'))?.counted).toBeUndefined();
    expect((await row('b'))?.counted).toBeUndefined();
  });

  it('leaves the time the row was last updated alone', async () => {
    await runs.count(ref('a'));
    expect((await row('a'))?.updatedAt).toEqual(old);
  });
});
