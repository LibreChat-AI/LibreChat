import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { SubscriptionDraft, Subscriptions } from './subscription';
import type { SubscriptionRecord } from '~/models/subscription';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createSubscriptions } from './subscription';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const TENANT = 'tenant-a';
const owner = new mongoose.Types.ObjectId().toString();
const other = new mongoose.Types.ObjectId().toString();
const hour = new Date('2026-11-24T10:00:00.000Z');
const later = (minutes: number) => new Date(hour.getTime() + minutes * 60_000);

let server: MongoMemoryServer;
let Rows: Model<SubscriptionRecord>;
let subscriptions: Subscriptions;

const as = <T>(fn: () => Promise<T>): Promise<T> => tenantStorage.run({ tenantId: TENANT }, fn);

const draft = (overrides: Partial<SubscriptionDraft> = {}): SubscriptionDraft => ({
  connection: 'conn_1',
  agentId: 'agent_1',
  events: ['github.pull_request_review.submitted'],
  target: 'new',
  prompt: 'Read the review.',
  actors: 'write',
  bots: false,
  enabled: true,
  ...overrides,
});

const made = (overrides: Partial<SubscriptionDraft> = {}) =>
  as(() => subscriptions.create(owner, draft(overrides)));

const row = (id: string): Promise<SubscriptionRecord | null> =>
  runAsSystem(async () => Rows.findOne({ id }).lean<SubscriptionRecord>());

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  _resetStrictCache();
  subscriptions = createSubscriptions(mongoose);
  Rows = mongoose.models.AgentEventSubscription as Model<SubscriptionRecord>;
  await runAsSystem(async () => Rows.deleteMany({}));
});

describe('take: the runs of one clock hour', () => {
  it('takes runs until the hour holds as many as allowed, then refuses', async () => {
    const { id } = await made();
    const taken = [];
    for (let i = 0; i < 4; i++)
      taken.push(await as(() => subscriptions.take(id, owner, 3, later(i))));
    expect(taken).toEqual([true, true, true, false]);
    expect((await row(id))?.usage).toEqual({ hour, runs: 3 });
  });

  it('starts the count again in the next hour', async () => {
    const { id } = await made();
    await as(() => subscriptions.take(id, owner, 1, later(5)));
    expect(await as(() => subscriptions.take(id, owner, 1, later(59)))).toBe(false);
    expect(await as(() => subscriptions.take(id, owner, 1, later(60)))).toBe(true);
    expect((await row(id))?.usage).toEqual({ hour: later(60), runs: 1 });
  });

  it('lets no more than the hour allows through a burst of concurrent runs', async () => {
    const { id } = await made();
    const burst = await as(() =>
      Promise.all(Array.from({ length: 12 }, () => subscriptions.take(id, owner, 5, later(1)))),
    );
    expect(burst.filter(Boolean)).toHaveLength(5);
    expect((await row(id))?.usage?.runs).toBe(5);
  });

  it('holds a burst that opens a new hour to the same count', async () => {
    const { id } = await made();
    await as(() => subscriptions.take(id, owner, 4, later(-30)));
    const burst = await as(() =>
      Promise.all(Array.from({ length: 10 }, () => subscriptions.take(id, owner, 4, later(2)))),
    );
    expect(burst.filter(Boolean)).toHaveLength(4);
    expect((await row(id))?.usage).toEqual({ hour, runs: 4 });
  });

  it('counts a run admitted before the hour turned against the hour it is counted in', async () => {
    const { id } = await made();
    await as(() => subscriptions.take(id, owner, 2, later(61)));
    // Admitted at 10:59, counted after 11:01 was: the count stays in the 11:00 hour.
    expect(await as(() => subscriptions.take(id, owner, 2, later(59)))).toBe(true);
    expect((await row(id))?.usage).toEqual({ hour: later(60), runs: 2 });
    expect(await as(() => subscriptions.take(id, owner, 2, later(59)))).toBe(false);
  });

  it("takes nothing from another owner's subscription, a missing one, or an hour of none", async () => {
    const { id } = await made();
    expect(await as(() => subscriptions.take(id, other, 3, later(1)))).toBe(false);
    expect(await as(() => subscriptions.take('sub_none', owner, 3, later(1)))).toBe(false);
    expect(await as(() => subscriptions.take(id, owner, 0, later(1)))).toBe(false);
    expect((await row(id))?.usage).toBeUndefined();
  });

  it('never returns the count with the subscription', async () => {
    const { id } = await made();
    await as(() => subscriptions.take(id, owner, 3, later(1)));
    expect(await as(() => subscriptions.get(id, owner))).not.toHaveProperty('usage');
  });
});

describe('tally: the failure streak', () => {
  const failed = (key: string) => ({ key, failed: true });

  it('turns the subscription off once enough runs in a row fail, saying why', async () => {
    const { id, revision } = await made();
    expect(await as(() => subscriptions.tally(id, owner, failed('d1'), 3, later(1)))).toEqual({
      suspended: false,
    });
    await as(() => subscriptions.tally(id, owner, failed('d2'), 3, later(2)));
    expect(await as(() => subscriptions.tally(id, owner, failed('d3'), 3, later(3)))).toEqual({
      suspended: true,
    });
    const after = await as(() => subscriptions.get(id, owner));
    expect(after).toMatchObject({
      enabled: false,
      revision,
      suspended: { reason: 'failures', at: later(3).toISOString(), failures: 3 },
    });
  });

  it('starts the streak over on a run that succeeds', async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, failed('d1'), 2));
    await as(() => subscriptions.tally(id, owner, { key: 'd2', failed: false }, 2));
    expect(await as(() => subscriptions.tally(id, owner, failed('d3'), 2))).toEqual({
      suspended: false,
    });
    expect((await row(id))?.failures).toBe(1);
  });

  it('counts a run once, however often its count is replayed', async () => {
    const { id } = await made();
    for (let i = 0; i < 3; i++) await as(() => subscriptions.tally(id, owner, failed('d1'), 2));
    expect((await row(id))?.failures).toBe(1);
    expect((await row(id))?.enabled).toBe(true);
  });

  it('finishes a turning off that a crash left undone when the count is replayed', async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, failed('d1'), 2));
    // The second failure was counted, then the process stopped before turning it off.
    await runAsSystem(async () =>
      Rows.updateOne({ id }, { $set: { counted: ['d1', 'd2'], failures: 2 } }),
    );
    expect(await as(() => subscriptions.tally(id, owner, failed('d2'), 2, later(9)))).toEqual({
      suspended: true,
    });
    expect((await row(id))?.suspended?.failures).toBe(2);
  });

  it("counts an older run's replay neither into a newer streak nor against it", async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, failed('a'), 5));
    await as(() => subscriptions.tally(id, owner, failed('b'), 5));
    await as(() => subscriptions.tally(id, owner, failed('a'), 5));
    expect((await row(id))?.failures).toBe(2);
    await as(() => subscriptions.tally(id, owner, { key: 'c', failed: false }, 5));
    await as(() => subscriptions.tally(id, owner, failed('d'), 5));
    await as(() => subscriptions.tally(id, owner, { key: 'c', failed: false }, 5));
    expect((await row(id))?.failures).toBe(1);
  });

  it('remembers a bounded number of counted runs', async () => {
    const { id } = await made();
    for (let i = 0; i < 60; i++) {
      await as(() => subscriptions.tally(id, owner, { key: `k${i}`, failed: false }, 5));
    }
    const counted = (await row(id))?.counted ?? [];
    expect(counted).toHaveLength(50);
    expect(counted[counted.length - 1]).toBe('k59');
  });

  it('counts nothing for a run of a revision the owner has since moved past', async () => {
    const { id } = await made();
    await as(() => subscriptions.update(id, owner, { enabled: false }));
    await as(() => subscriptions.update(id, owner, { enabled: true }));
    expect(
      await as(() => subscriptions.tally(id, owner, { key: 'old', failed: true, revision: 0 }, 1)),
    ).toEqual({ suspended: false });
    expect(await row(id)).toMatchObject({ enabled: true });
    expect((await row(id))?.failures).toBeUndefined();
    expect(
      await as(() => subscriptions.tally(id, owner, { key: 'new', failed: true, revision: 2 }, 1)),
    ).toEqual({ suspended: true });
  });

  it('turns a subscription off once, not again on a later failure', async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, failed('d1'), 1, later(1)));
    expect(await as(() => subscriptions.tally(id, owner, failed('d2'), 1, later(2)))).toEqual({
      suspended: false,
    });
    expect((await row(id))?.suspended?.at).toEqual(later(1));
  });

  it('never turns it off with a threshold of 0', async () => {
    const { id } = await made();
    for (let i = 0; i < 5; i++) await as(() => subscriptions.tally(id, owner, failed(`d${i}`), 0));
    expect((await row(id))?.enabled).toBe(true);
    expect((await row(id))?.failures).toBe(5);
  });

  it("counts nothing on another owner's subscription", async () => {
    const { id } = await made();
    expect(await as(() => subscriptions.tally(id, other, failed('d1'), 1))).toEqual({
      suspended: false,
    });
    expect(await row(id)).toMatchObject({ enabled: true });
    expect((await row(id))?.failures).toBeUndefined();
  });

  it('keeps the grant a subscription holds when it turns it off', async () => {
    const { id } = await made();
    const grant = { scheduleRevision: 0 };
    await runAsSystem(async () => Rows.updateOne({ id }, { $set: { grant } }, { strict: false }));
    await as(() => subscriptions.tally(id, owner, failed('d1'), 1));
    expect((await row(id))?.grant).toEqual(grant);
    expect((await row(id))?.revision).toBe(0);
  });
});

describe('turning a suspended subscription back on', () => {
  it('clears the suspension and starts the streak over', async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, { key: 'd1', failed: true }, 1));
    const result = await as(() => subscriptions.update(id, owner, { enabled: true }));
    expect(result.ok && result.value).toMatchObject({ enabled: true, revision: 1 });
    expect(result.ok && result.value).not.toHaveProperty('suspended');
    const stored = await row(id);
    expect(stored?.suspended).toBeUndefined();
    expect(stored?.failures).toBeUndefined();
  });

  it('carries the grant along, as any turning on does', async () => {
    const { id } = await made();
    await runAsSystem(async () =>
      Rows.updateOne({ id }, { $set: { grant: { scheduleRevision: 0 } } }, { strict: false }),
    );
    await as(() => subscriptions.tally(id, owner, { key: 'd1', failed: true }, 1));
    await as(() => subscriptions.update(id, owner, { enabled: true }));
    expect((await row(id))?.grant).toEqual({ scheduleRevision: 1 });
  });

  it('leaves a suspension in place on any other edit', async () => {
    const { id } = await made();
    await as(() => subscriptions.tally(id, owner, { key: 'd1', failed: true }, 1));
    await as(() => subscriptions.update(id, owner, { prompt: 'Read it again.' }));
    expect((await row(id))?.suspended?.reason).toBe('failures');
  });
});
