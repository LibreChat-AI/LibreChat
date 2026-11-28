import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { WatchDraft, Watches } from './watch';
import type { WatchRecord } from '~/models/watch';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createSubscriptions } from './subscription';
import { createModels } from '~/models';
import { createMethods } from './index';
import { createWatches } from './watch';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const DAY = 24 * 60 * 60 * 1000;
const owner = new mongoose.Types.ObjectId().toString();
const other = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-11-25T12:00:00.000Z');

let server: MongoMemoryServer;
let Rows: Model<WatchRecord>;
let watches: Watches;

const as = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const stored = (): Promise<WatchRecord[]> =>
  runAsSystem(async () => Rows.find({}).lean<WatchRecord[]>());

const draft = (overrides: Partial<WatchDraft> = {}): WatchDraft => ({
  conversationId: 'convo_1',
  agentId: 'agent_1',
  subscription: 'sub_1',
  connection: 'conn_1',
  item: 'github:pr:101#7',
  label: 'acme/widgets#7',
  url: 'https://github.com/acme/widgets/pull/7',
  ...overrides,
});

const bounds = (overrides: { max?: number; ttlMs?: number; now?: Date } = {}) => ({
  max: 5,
  ttlMs: 14 * DAY,
  now: NOW,
  ...overrides,
});

const added = (overrides: Partial<WatchDraft> = {}, user = owner, tenantId = TENANT_A) =>
  as(tenantId, async () => watches.add(user, draft(overrides), bounds()));

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  for (const name of ['AgentEventWatch', 'AgentEventSubscription']) {
    if (mongoose.models[name]) mongoose.deleteModel(name);
  }
  watches = createWatches(mongoose);
  Rows = mongoose.models.AgentEventWatch as Model<WatchRecord>;
  await runAsSystem(async () => Rows.deleteMany({}));
});

describe('add', () => {
  it("stores the owner's watch in the calling tenant, ending after its lifetime", async () => {
    const result = await added();
    expect(result).toStrictEqual({
      ok: true,
      created: true,
      value: {
        id: expect.stringMatching(/^watch_[0-9a-f-]{36}$/),
        user: owner,
        tenantId: TENANT_A,
        conversationId: 'convo_1',
        agentId: 'agent_1',
        subscription: 'sub_1',
        connection: 'conn_1',
        item: 'github:pr:101#7',
        label: 'acme/widgets#7',
        url: 'https://github.com/acme/widgets/pull/7',
        createdAt: expect.any(String),
        expiresAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
      },
    });
    expect(await stored()).toHaveLength(1);
  });

  it('renews the watch a conversation already holds on an item instead of adding another', async () => {
    const first = await added();
    const later = new Date(NOW.getTime() + DAY);
    const again = await as(TENANT_A, async () =>
      watches.add(owner, draft(), bounds({ now: later })),
    );
    expect(again).toMatchObject({ ok: true, created: false });
    if (!first.ok || !again.ok) throw new Error('expected both to succeed');
    expect(again.value.id).toBe(first.value.id);
    expect(again.value.expiresAt).toBe(new Date(later.getTime() + 14 * DAY).toISOString());
    expect(await stored()).toHaveLength(1);
  });

  it('refuses another item once the conversation holds as many as it may', async () => {
    await as(TENANT_A, async () => watches.add(owner, draft(), bounds({ max: 1 })));
    const refused = await as(TENANT_A, async () =>
      watches.add(owner, draft({ item: 'github:pr:101#8' }), bounds({ max: 1 })),
    );
    expect(refused).toStrictEqual({ ok: false, error: { code: 'limit' } });
    expect(await stored()).toHaveLength(1);
  });

  it('does not count a watch that has ended against the limit', async () => {
    await as(TENANT_A, async () => watches.add(owner, draft(), bounds({ max: 1, ttlMs: DAY })));
    const later = new Date(NOW.getTime() + 2 * DAY);
    const result = await as(TENANT_A, async () =>
      watches.add(owner, draft({ item: 'github:pr:101#8' }), bounds({ max: 1, now: later })),
    );
    expect(result).toMatchObject({ ok: true, created: true });
  });

  it('replaces an ended watch on the same item with a new one', async () => {
    const first = await as(TENANT_A, async () =>
      watches.add(owner, draft(), bounds({ ttlMs: DAY })),
    );
    const later = new Date(NOW.getTime() + 2 * DAY);
    const again = await as(TENANT_A, async () =>
      watches.add(owner, draft(), bounds({ now: later })),
    );
    if (!first.ok || !again.ok) throw new Error('expected both to succeed');
    expect(again.created).toBe(true);
    expect(again.value.id).not.toBe(first.value.id);
    expect(await stored()).toHaveLength(1);
  });

  it('keeps one watch when two calls add the same one at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        as(TENANT_A, async () => watches.add(owner, draft(), bounds())),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
  });
});

describe('binding and the limit', () => {
  it('renews under the subscription, connection and agent that allow it now', async () => {
    const first = await added();
    const again = await added({ subscription: 'sub_2', connection: 'conn_2', agentId: 'agent_2' });
    if (!first.ok || !again.ok) throw new Error('expected both to succeed');
    expect(again.created).toBe(false);
    expect(again.value).toMatchObject({
      id: first.value.id,
      subscription: 'sub_2',
      connection: 'conn_2',
      agentId: 'agent_2',
    });
    const [row] = await stored();
    expect(row).toMatchObject({ subscription: 'sub_2', connection: 'conn_2', agentId: 'agent_2' });
  });

  it('never lets concurrent adds of different items pass the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        as(TENANT_A, async () =>
          watches.add(owner, draft({ item: `github:pr:101#${n}` }), bounds({ max: 2 })),
        ),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok)).toHaveLength(4);
    expect(await stored()).toHaveLength(2);
  });

  it('gives a removed watch its place back', async () => {
    const first = await as(TENANT_A, async () => watches.add(owner, draft(), bounds({ max: 1 })));
    if (!first.ok) throw new Error('expected the add to succeed');
    await as(TENANT_A, async () => watches.remove(first.value.id, owner));
    const next = await as(TENANT_A, async () =>
      watches.add(owner, draft({ item: 'github:pr:101#8' }), bounds({ max: 1 })),
    );
    expect(next).toMatchObject({ ok: true, created: true });
  });
});

describe('reads and removal', () => {
  it("lists only the owner's watches on that conversation that have not ended, oldest first", async () => {
    await added();
    await added({ item: 'github:pr:101#8', label: 'acme/widgets#8' });
    await added({ conversationId: 'convo_2' });
    await added({}, other);
    const listed = await as(TENANT_A, async () => watches.list(owner, 'convo_1', NOW));
    expect(listed.map((watch) => watch.label)).toEqual(['acme/widgets#7', 'acme/widgets#8']);
    const after = new Date(NOW.getTime() + 15 * DAY);
    expect(await as(TENANT_A, async () => watches.list(owner, 'convo_1', after))).toEqual([]);
  });

  it("gets, removes and drops only the owner's watch", async () => {
    const result = await added();
    if (!result.ok) throw new Error('expected the add to succeed');
    const { id } = result.value;
    expect(await as(TENANT_A, async () => watches.get(id, other, NOW))).toBeNull();
    expect(await as(TENANT_A, async () => watches.remove(id, other))).toBe(false);
    expect(await as(TENANT_A, async () => watches.get(id, owner, NOW))).not.toBeNull();
    expect(await as(TENANT_A, async () => watches.remove(id, owner))).toBe(true);
    expect(await stored()).toEqual([]);
    await added();
    expect(await as(TENANT_A, async () => watches.drop(other, 'convo_1', 'github:pr:101#7'))).toBe(
      false,
    );
    expect(await as(TENANT_A, async () => watches.drop(owner, 'convo_1', 'github:pr:101#7'))).toBe(
      true,
    );
  });

  it("never reads another tenant's watch", async () => {
    const result = await added({}, owner, TENANT_B);
    if (!result.ok) throw new Error('expected the add to succeed');
    expect(await as(TENANT_A, async () => watches.get(result.value.id, owner, NOW))).toBeNull();
    expect(await as(TENANT_A, async () => watches.list(owner, 'convo_1', NOW))).toEqual([]);
  });
});

describe('following', () => {
  it("finds the connection's watches on the items, in the connection's tenant only", async () => {
    await added();
    await added({ conversationId: 'convo_2' }, other);
    await added({ connection: 'conn_2', conversationId: 'convo_3' });
    // A user belongs to one tenant: another tenant's watch is another user's.
    await added({ conversationId: 'convo_4' }, new mongoose.Types.ObjectId().toString(), TENANT_B);
    const found = await watches.following(
      { id: 'conn_1', tenantId: TENANT_A },
      ['github:pr:101#7'],
      NOW,
    );
    expect(found.map((watch) => [watch.user, watch.conversationId]).sort()).toEqual(
      [
        [owner, 'convo_1'],
        [other, 'convo_2'],
      ].sort(),
    );
  });

  it('skips a watch that has ended and reads nothing for no items', async () => {
    await added();
    const after = new Date(NOW.getTime() + 15 * DAY);
    expect(
      await watches.following({ id: 'conn_1', tenantId: TENANT_A }, ['github:pr:101#7'], after),
    ).toEqual([]);
    expect(await watches.following({ id: 'conn_1', tenantId: TENANT_A }, [], NOW)).toEqual([]);
  });

  it('reads a tenantless connection as rows with no tenant, not every tenant', async () => {
    await added();
    expect(await watches.following({ id: 'conn_1' }, ['github:pr:101#7'], NOW)).toEqual([]);
  });
});

describe('cleanup with its subscription and conversation', () => {
  it("removes a subscription's watches with it, and an owner's with a purge", async () => {
    const subscriptions = createSubscriptions(mongoose);
    const subscription = await as(TENANT_A, async () =>
      subscriptions.create(owner, {
        connection: 'conn_1',
        agentId: 'agent_1',
        events: ['github.pull_request_review.submitted'],
        target: 'new',
        prompt: 'Read it.',
        actors: 'write',
        bots: false,
        enabled: true,
        watch: true,
      }),
    );
    await added({ subscription: subscription.id });
    await added({ subscription: 'sub_other', conversationId: 'convo_2' });
    await added({ subscription: subscription.id }, other);
    expect(await as(TENANT_A, async () => subscriptions.remove(subscription.id, owner))).toBe(true);
    expect((await stored()).map((row) => [String(row.user), row.subscription]).sort()).toEqual(
      [
        [owner, 'sub_other'],
        [other, subscription.id],
      ].sort(),
    );
    await as(TENANT_A, async () => subscriptions.purge(owner));
    expect((await stored()).map((row) => String(row.user))).toEqual([other]);
  });

  it("ends a conversation's watches when the conversation is deleted, and no other's", async () => {
    const models = createModels(mongoose);
    const methods = createMethods(mongoose);
    await runAsSystem(async () =>
      models.Conversation.create([
        { conversationId: 'convo_1', user: owner, endpoint: 'agents' },
        { conversationId: 'convo_2', user: owner, endpoint: 'agents' },
      ]),
    );
    await added({}, owner, TENANT_A);
    await added({ conversationId: 'convo_2' }, owner, TENANT_A);
    await runAsSystem(async () => methods.deleteConvos(owner, { conversationId: 'convo_1' }));
    expect((await stored()).map((row) => row.conversationId)).toEqual(['convo_2']);
  });

  it('declares the indexes routing, listing, uniqueness and expiry need', async () => {
    await Rows.syncIndexes();
    const indexes = await Rows.collection.indexes();
    const byName = Object.fromEntries(indexes.map((index) => [index.name, index]));
    expect(byName['connection_1_item_1']?.key).toEqual({ connection: 1, item: 1 });
    expect(byName['user_1_conversationId_1_item_1']).toMatchObject({
      key: { user: 1, conversationId: 1, item: 1 },
      unique: true,
    });
    expect(byName['user_1_conversationId_1_slot_1']).toMatchObject({ unique: true });
    expect(byName['expiresAt_1']).toMatchObject({ expireAfterSeconds: 0 });
    expect(Rows.collection.collectionName).toBe('agenteventwatches');
  });
});
