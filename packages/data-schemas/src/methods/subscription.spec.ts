import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  SUBSCRIPTION_CAP_MAX,
  SUBSCRIPTION_EVENTS_MAX,
  SUBSCRIPTION_WINDOW_MAX_MS,
  SUBSCRIPTION_PROMPT_MAX_LENGTH,
} from 'librechat-data-provider';
import type { Subscription } from 'librechat-data-provider';
import type { FilterQuery, Model } from 'mongoose';
import type { SubscriptionDraft, SubscriptionPatch, Subscriptions } from './subscription';
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
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const owner = new mongoose.Types.ObjectId().toString();
const other = new mongoose.Types.ObjectId().toString();

let server: MongoMemoryServer;
let Rows: Model<SubscriptionRecord>;
let subscriptions: Subscriptions;

const as = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

/** Every stored row, whichever tenant holds it. */
const stored = (): Promise<SubscriptionRecord[]> =>
  runAsSystem(async () => Rows.find({}).lean<SubscriptionRecord[]>());

const draft = (overrides: Partial<SubscriptionDraft> = {}): SubscriptionDraft => ({
  connection: 'conn_1',
  agentId: 'agent_1',
  events: ['pull_request.review'],
  target: 'new',
  prompt: 'Read the review.',
  actors: 'write',
  bots: false,
  enabled: true,
  ...overrides,
});

const made = (user = owner, overrides: Partial<SubscriptionDraft> = {}, tenantId = TENANT_A) =>
  as(tenantId, async () => subscriptions.create(user, draft(overrides)));

const edit = (
  id: string,
  patch: SubscriptionPatch,
  expected?: number,
  user = owner,
  tenantId = TENANT_A,
) => as(tenantId, async () => subscriptions.update(id, user, patch, expected));

const read = (id: string, tenantId = TENANT_A) => as(tenantId, async () => subscriptions.get(id));

/** Names the index the winning plan scans, or `COLLSCAN` when it reads the whole collection. */
async function scan(filter: FilterQuery<SubscriptionRecord>): Promise<string> {
  const plan = (await runAsSystem(async () =>
    Rows.find(filter).explain('queryPlanner'),
  )) as unknown as { queryPlanner: { winningPlan: unknown } };
  const text = JSON.stringify(plan.queryPlanner.winningPlan);
  return /"stage":"IXSCAN".*?"indexName":"([^"]+)"/.exec(text)?.[1] ?? text;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  // Built for each test, model included, so a test that reads through the store also covers
  // how the store and the collection's schema are made.
  if (mongoose.models.AgentEventSubscription) mongoose.deleteModel('AgentEventSubscription');
  subscriptions = createSubscriptions(mongoose);
  Rows = mongoose.models.AgentEventSubscription as Model<SubscriptionRecord>;
  await runAsSystem(async () => Rows.deleteMany({}));
});

describe('create', () => {
  it("stores the owner's subscription at revision 0 in the calling tenant", async () => {
    const subscription = await made();

    // Strict: a field the subscription left out is absent, not present and undefined.
    expect(subscription).toStrictEqual({
      id: expect.stringMatching(/^sub_[0-9a-f-]{36}$/),
      user: owner,
      tenantId: TENANT_A,
      connection: 'conn_1',
      agentId: 'agent_1',
      events: ['pull_request.review'],
      target: 'new',
      prompt: 'Read the review.',
      actors: 'write',
      bots: false,
      enabled: true,
      revision: 0,
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(rows[0].user)).toBe(owner);
    expect(rows[0]).toMatchObject({ id: subscription.id, tenantId: TENANT_A, revision: 0 });
  });

  it('keeps the fields a subscription may leave out when they are given', async () => {
    const given = {
      filters: { repositories: ['octo/site'], branches: ['main'], labels: ['bug'] },
      cap: { perHour: 5 },
      window: { ms: 60_000 },
      actors: 'linked' as const,
      bots: true,
      enabled: false,
    };

    const subscription = await made(owner, given);

    expect(subscription).toMatchObject(given);
    expect(await read(subscription.id)).toEqual(subscription);
  });

  it('gives each subscription its own id', async () => {
    const first = await made();
    const second = await made();

    expect(second.id).not.toBe(first.id);
  });

  it('assigns the id, owner, tenant and revision itself', async () => {
    const smuggled = {
      ...draft(),
      id: 'sub_chosen',
      user: other,
      tenantId: TENANT_B,
      revision: 9,
    } as SubscriptionDraft;

    const subscription = await as(TENANT_A, async () => subscriptions.create(owner, smuggled));

    expect(subscription.id).not.toBe('sub_chosen');
    expect(subscription).toMatchObject({ user: owner, tenantId: TENANT_A, revision: 0 });
  });

  it('stores a subscription without a tenant where there is none', async () => {
    const subscription = await subscriptions.create(owner, draft());

    expect('tenantId' in subscription).toBe(false);
    expect((await stored())[0].tenantId).toBeUndefined();
  });

  it.each<[string, Partial<Record<keyof SubscriptionDraft, unknown>>, RegExp]>([
    ['no events', { events: [] }, /events/],
    ['no event list', { events: undefined }, /events/],
    ['no target', { target: undefined }, /target/],
    [
      'more events than a row may hold',
      { events: Array.from({ length: SUBSCRIPTION_EVENTS_MAX + 1 }, (_, index) => `e.${index}`) },
      /events/,
    ],
    ['a filter dimension there is not', { filters: { teams: ['core'] } }, /filters/],
    ['an empty filter dimension', { filters: { labels: [] } }, /filters/],
    ['a run cap below one', { cap: { perHour: 0 } }, /cap/],
    ['a run cap above the bound', { cap: { perHour: SUBSCRIPTION_CAP_MAX + 1 } }, /cap/],
    ['a negative window', { window: { ms: -1 } }, /window/],
    ['a window above the bound', { window: { ms: SUBSCRIPTION_WINDOW_MAX_MS + 1 } }, /window/],
    [
      'a prompt past its bound',
      { prompt: 'p'.repeat(SUBSCRIPTION_PROMPT_MAX_LENGTH + 1) },
      /prompt/,
    ],
    ['no prompt', { prompt: '' }, /prompt/],
    ['a target there is not', { target: 'item' }, /target/],
    ['an actor rule there is not', { actors: 'everyone' }, /actors/],
    ['no actor rule', { actors: undefined }, /actors/],
    ['no connection', { connection: '' }, /connection/],
    ['no agent', { agentId: '' }, /agentId/],
    ['no word on bots', { bots: undefined }, /bots/],
    ['no word on whether it is on', { enabled: undefined }, /enabled/],
  ])('refuses %s', async (_name, overrides, path) => {
    await expect(made(owner, overrides as Partial<SubscriptionDraft>)).rejects.toThrow(path);
    expect(await stored()).toHaveLength(0);
  });

  it('builds its indexes where automatic indexing is off', async () => {
    const manual = new mongoose.Mongoose();
    manual.set('autoIndex', false);
    await manual.connect(server.getUri(), { dbName: 'manual-indexes' });
    try {
      await tenantStorage.run({ tenantId: TENANT_A }, async () =>
        createSubscriptions(manual).create(owner, draft()),
      );

      const names = (await manual.models.AgentEventSubscription.listIndexes()).map(
        (index) => index.name,
      );
      expect(names).toEqual(expect.arrayContaining(['id_1', 'connection_1_enabled_1_events_1']));
    } finally {
      await manual.connection.dropDatabase();
      await manual.disconnect();
    }
  });
});

describe('the collection', () => {
  const row = {
    id: 'sub_1',
    user: owner,
    ...draft(),
    revision: 0,
  };

  it('accepts a whole row', async () => {
    await expect(new Rows(row).validate()).resolves.toBeUndefined();
  });

  // The store always supplies these, so only a write that goes around it can leave one out.
  it.each(['id', 'user', 'revision'] as const)('refuses a row with no %s', async (field) => {
    await expect(new Rows({ ...row, [field]: undefined }).validate()).rejects.toThrow(
      new RegExp(`\\b${field}\\b`),
    );
  });
});

describe('indexes', () => {
  it('are the three the reads rely on', async () => {
    await Rows.createIndexes();
    const indexes = await Rows.listIndexes();

    expect(
      indexes
        .filter((index) => index.name !== '_id_')
        .map(({ key, unique }) => ({ key, unique: unique === true })),
    ).toEqual([
      { key: { id: 1 }, unique: true },
      { key: { connection: 1, enabled: 1, events: 1 }, unique: false },
      { key: { user: 1, agentId: 1 }, unique: false },
    ]);
  });

  it('serve routing, an owner’s list and an owner’s list for one agent', async () => {
    await Rows.createIndexes();
    // Enough rows on other connections and owners that a scan is never the cheaper plan.
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        made(new mongoose.Types.ObjectId().toString(), { connection: `conn_x${index}` }),
      ),
    );
    await made();

    // Each plan is asked for the filter the store itself sent.
    const find = jest.spyOn(Rows, 'find');
    await as(TENANT_A, async () => {
      await subscriptions.match({ id: 'conn_1', tenantId: TENANT_A }, 'pull_request.review');
      await subscriptions.list(owner);
      await subscriptions.list(owner, 'agent_1');
    });
    // `find` is overloaded, so the spy's argument tuple is typed as its zero-argument form.
    const [routing, mine, forAgent] = (find.mock.calls as unknown[][]).map(
      ([filter]) => filter as FilterQuery<SubscriptionRecord>,
    );
    find.mockRestore();

    expect(await scan(routing)).toBe('connection_1_enabled_1_events_1');
    expect(await scan(mine)).toBe('user_1_agentId_1');
    expect(await scan(forAgent)).toBe('user_1_agentId_1');
  });
});

describe('get', () => {
  it('reads by id alone, or only for the owner named', async () => {
    const mine = await made();

    expect(await read(mine.id)).toEqual(mine);
    expect(await as(TENANT_A, async () => subscriptions.get(mine.id, owner))).toEqual(mine);
    expect(await as(TENANT_A, async () => subscriptions.get(mine.id, other))).toBeNull();
  });

  it("does not read another tenant's subscription", async () => {
    const mine = await made();

    expect(await read(mine.id, TENANT_B)).toBeNull();
    expect(await as(TENANT_B, async () => subscriptions.get(mine.id, owner))).toBeNull();
  });

  it('answers null for an id nothing has', async () => {
    await made();

    expect(await read('sub_none')).toBeNull();
  });
});

describe('list', () => {
  it("lists the owner's subscriptions, most recently edited first", async () => {
    const first = await made();
    const second = await made(owner, { agentId: 'agent_2' });
    await made(other);
    await Rows.collection.updateOne(
      { id: second.id },
      { $set: { updatedAt: new Date('2026-01-01T00:00:00Z') } },
    );

    expect(await as(TENANT_A, async () => subscriptions.list(owner))).toEqual([first, second]);

    const edited = await edit(second.id, { bots: true });
    expect(await as(TENANT_A, async () => subscriptions.list(owner))).toEqual([
      edited.ok && edited.value,
      first,
    ]);
  });

  it('narrows to one agent when asked', async () => {
    await made();
    const second = await made(owner, { agentId: 'agent_2' });

    expect(await as(TENANT_A, async () => subscriptions.list(owner, 'agent_2'))).toEqual([second]);
    expect(await as(TENANT_A, async () => subscriptions.list(owner, 'agent_3'))).toEqual([]);
  });

  it("does not list another tenant's subscriptions", async () => {
    await made();

    expect(await as(TENANT_B, async () => subscriptions.list(owner))).toEqual([]);
  });
});

describe('update', () => {
  it('applies an edit and moves the revision forward by one each time', async () => {
    const start = await made();

    const first = await edit(start.id, {
      events: ['check_suite.completed', 'pull_request.review'],
      filters: { repositories: ['octo/site'] },
      prompt: 'Read it again.',
      actors: 'any',
      bots: true,
      cap: { perHour: 3 },
      window: { ms: 5_000 },
      enabled: false,
    });

    const expected: Subscription = {
      ...start,
      events: ['check_suite.completed', 'pull_request.review'],
      filters: { repositories: ['octo/site'] },
      prompt: 'Read it again.',
      actors: 'any',
      bots: true,
      cap: { perHour: 3 },
      window: { ms: 5_000 },
      enabled: false,
      revision: 1,
    };
    expect(first).toEqual({ ok: true, value: expected });
    expect(await read(start.id)).toEqual(expected);

    const second = await edit(start.id, { enabled: true });
    expect(second).toEqual({ ok: true, value: { ...expected, enabled: true, revision: 2 } });
  });

  it('leaves a field the edit does not name as it was', async () => {
    const start = await made(owner, {
      filters: { labels: ['bug'] },
      cap: { perHour: 2 },
      window: { ms: 1_000 },
    });

    const write = jest.spyOn(Rows, 'findOneAndUpdate');

    const result = await edit(start.id, { prompt: 'Only this.', cap: undefined, filters: null });

    const { filters: _filters, ...rest } = start;
    expect(result).toEqual({ ok: true, value: { ...rest, prompt: 'Only this.', revision: 1 } });
    // The write names the edited fields and no others, so it does not lean on the driver
    // dropping the ones left undefined.
    expect(write.mock.calls[0][1]).toStrictEqual({
      $set: { prompt: 'Only this.' },
      $unset: { filters: 1 },
      $inc: { revision: 1 },
    });
  });

  it('clears a field that may be left out when the edit sends null', async () => {
    const start = await made(owner, {
      filters: { labels: ['bug'] },
      cap: { perHour: 2 },
      window: { ms: 1_000 },
    });

    const result = await edit(start.id, { filters: null, cap: null, window: null });

    const { filters: _filters, cap: _cap, window: _window, ...rest } = start;
    expect(result).toEqual({ ok: true, value: { ...rest, revision: 1 } });
    const [row] = await stored();
    expect(row).not.toHaveProperty('filters');
    expect(row).not.toHaveProperty('cap');
    expect(row).not.toHaveProperty('window');
  });

  it('changes only what an owner may edit', async () => {
    const start = await made();
    const smuggled = {
      prompt: 'Edited.',
      id: 'sub_chosen',
      user: other,
      tenantId: TENANT_B,
      connection: 'conn_2',
      agentId: 'agent_2',
      revision: 40,
    } as SubscriptionPatch;

    const result = await edit(start.id, smuggled);

    expect(result).toEqual({ ok: true, value: { ...start, prompt: 'Edited.', revision: 1 } });
  });

  it('applies an edit made from the stored revision', async () => {
    const start = await made();
    await edit(start.id, { bots: true });

    const result = await edit(start.id, { prompt: 'From one.' }, 1);

    expect(result).toEqual({
      ok: true,
      value: { ...start, bots: true, prompt: 'From one.', revision: 2 },
    });
  });

  it('refuses an edit made from an older revision and changes nothing', async () => {
    const start = await made();
    const moved = await edit(start.id, { bots: true });

    const result = await edit(start.id, { prompt: 'From zero.' }, 0);

    expect(result).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await read(start.id)).toEqual(moved.ok && moved.value);
  });

  it('applies an edit made from revision 0', async () => {
    const start = await made();

    const result = await edit(start.id, { bots: true }, 0);

    expect(result).toEqual({ ok: true, value: { ...start, bots: true, revision: 1 } });
  });

  it.each([
    ['with no revision named', undefined],
    ['with a revision named', 0],
  ])('answers missing for an id nothing has, %s', async (_name, expected) => {
    await made();

    expect(await edit('sub_none', { bots: true }, expected)).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
  });

  it.each([
    ['another owner', other, TENANT_A],
    ['another tenant', owner, TENANT_B],
  ])('answers missing to %s, whatever revision is named', async (_name, user, tenantId) => {
    const start = await made();

    expect(await edit(start.id, { bots: true }, undefined, user, tenantId)).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect(await edit(start.id, { bots: true }, 0, user, tenantId)).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect(await edit(start.id, { bots: true }, 7, user, tenantId)).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect(await read(start.id)).toEqual(start);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['no events', { events: [] }, /events/],
    ['a filter dimension there is not', { filters: { teams: ['core'] } }, /filters/],
    ['a run cap below one', { cap: { perHour: 0 } }, /cap/],
    ['a negative window', { window: { ms: -1 } }, /window/],
    [
      'a prompt past its bound',
      { prompt: 'p'.repeat(SUBSCRIPTION_PROMPT_MAX_LENGTH + 1) },
      /prompt/,
    ],
    ['a target there is not', { target: 'item' }, /target/],
    ['an actor rule there is not', { actors: 'everyone' }, /actors/],
  ])('refuses an edit to %s and keeps the revision', async (_name, patch, path) => {
    const start = await made();

    await expect(edit(start.id, patch as SubscriptionPatch)).rejects.toThrow(path);
    expect(await read(start.id)).toEqual(start);
  });
});

describe('remove', () => {
  it("deletes the owner's subscription", async () => {
    const mine = await made();
    const kept = await made();

    expect(await as(TENANT_A, async () => subscriptions.remove(mine.id, owner))).toBe(true);
    expect(await read(mine.id)).toBeNull();
    expect(await read(kept.id)).toEqual(kept);
  });

  it.each([
    ['another owner', other, TENANT_A],
    ['another tenant', owner, TENANT_B],
  ])('does not delete it for %s', async (_name, user, tenantId) => {
    const mine = await made();

    expect(await as(tenantId, async () => subscriptions.remove(mine.id, user))).toBe(false);
    expect(await read(mine.id)).toEqual(mine);
  });

  it('answers false for an id nothing has', async () => {
    await made();

    expect(await as(TENANT_A, async () => subscriptions.remove('sub_none', owner))).toBe(false);
    expect(await stored()).toHaveLength(1);
  });
});

describe('purge', () => {
  it("deletes every subscription the owner has and nobody else's", async () => {
    await made();
    await made(owner, { agentId: 'agent_2' });
    const theirs = await made(other);

    expect(await as(TENANT_A, async () => subscriptions.purge(owner))).toBe(2);
    expect(await as(TENANT_A, async () => subscriptions.list(owner))).toEqual([]);
    expect(await as(TENANT_A, async () => subscriptions.list(other))).toEqual([theirs]);
  });

  it('answers zero for an owner with none', async () => {
    await made(other);

    expect(await as(TENANT_A, async () => subscriptions.purge(owner))).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it('stays inside the calling tenant', async () => {
    await made();

    expect(await as(TENANT_B, async () => subscriptions.purge(owner))).toBe(0);
    expect(await stored()).toHaveLength(1);
  });
});

describe('match', () => {
  const CONN_A = { id: 'conn_1', tenantId: TENANT_A };
  const matched = (event: string, connection: { id: string; tenantId?: string } = CONN_A) =>
    subscriptions.match(connection, event);

  it('finds every enabled subscription on the connection that listens for the event', async () => {
    const mine = await made(owner, { events: ['pull_request.review', 'check_suite.completed'] });
    const theirs = await made(other);
    await made(owner, { enabled: false });
    await made(owner, { connection: 'conn_2' });
    await made(owner, { events: ['issue.opened'] });

    const found = await matched('pull_request.review');

    expect(found).toHaveLength(2);
    expect(found).toEqual(expect.arrayContaining([mine, theirs]));
    expect(await matched('check_suite.completed')).toEqual([mine]);
  });

  it('matches an event type whole, not by its prefix', async () => {
    await made();

    expect(await matched('pull_request')).toEqual([]);
    expect(await matched('pull_request.review.submitted')).toEqual([]);
  });

  it('stops matching a subscription once it is turned off', async () => {
    const mine = await made();
    await edit(mine.id, { enabled: false });

    expect(await matched('pull_request.review')).toEqual([]);
  });

  it("reads the connection's tenant, whatever scope the caller is in", async () => {
    const mine = await made();
    // Another tenant's subscription that names this connection's id.
    await made(other, {}, TENANT_B);

    expect(await matched('pull_request.review')).toEqual([mine]);
    expect(await as(TENANT_B, async () => matched('pull_request.review'))).toEqual([mine]);
    expect(await runAsSystem(async () => matched('pull_request.review'))).toEqual([mine]);
  });

  it('matches only subscriptions with no tenant for a connection that has none', async () => {
    await made();
    const loose = await subscriptions.create(owner, draft());
    // A row from before tenancy can carry an empty tenant, which also means none.
    const blank = await subscriptions.create(other, draft());
    await Rows.collection.updateOne({ id: blank.id }, { $set: { tenantId: '' } });

    const found = await matched('pull_request.review', { id: 'conn_1' });

    expect(found.map((subscription) => subscription.id).sort()).toEqual(
      [loose.id, blank.id].sort(),
    );
    // Called from inside a tenant's scope, it still reads the connection's side.
    expect(
      await as(TENANT_A, async () => matched('pull_request.review', { id: 'conn_1' })),
    ).toHaveLength(2);
  });

  describe('where every read must name a tenant', () => {
    const original = process.env.TENANT_ISOLATION_STRICT;

    beforeEach(() => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetStrictCache();
    });

    afterEach(() => {
      if (original === undefined) delete process.env.TENANT_ISOLATION_STRICT;
      else process.env.TENANT_ISOLATION_STRICT = original;
      _resetStrictCache();
    });

    it('matches with no tenant in scope, where a scoped read is refused', async () => {
      const mine = await made();

      expect(await matched('pull_request.review')).toEqual([mine]);
      await expect(subscriptions.get(mine.id)).rejects.toThrow(/without tenant context/);
    });
  });
});
