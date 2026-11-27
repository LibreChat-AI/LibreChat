import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RunGrant, SubscriptionIdentity, Subscription } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { SubscriptionDraft, Subscriptions } from './subscription';
import type { SubscriptionRecord } from '~/models/subscription';
import type { RunGrantStorage } from './runGrant';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createSubscriptionGrantStorage } from './runGrant';
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
const NOW = 1_800_000_000_000;
const owner = new mongoose.Types.ObjectId().toString();
const other = new mongoose.Types.ObjectId().toString();

let server: MongoMemoryServer;
let Rows: Model<SubscriptionRecord>;
let subscriptions: Subscriptions;
let grants: RunGrantStorage<SubscriptionIdentity>;

const as = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

const draft = (overrides: Partial<SubscriptionDraft> = {}): SubscriptionDraft => ({
  connection: 'conn_1',
  agentId: 'agent_1',
  events: ['github.check_suite.completed'],
  target: 'new',
  prompt: 'Read the result.',
  actors: 'write',
  bots: false,
  enabled: true,
  ...overrides,
});

const made = (user = owner, overrides: Partial<SubscriptionDraft> = {}, tenantId = TENANT_A) =>
  as(tenantId, async () => subscriptions.create(user, draft(overrides)));

const identityOf = (
  subscription: Pick<Subscription, 'id' | 'agentId'>,
  overrides: Partial<SubscriptionIdentity> = {},
): SubscriptionIdentity => ({
  subscriptionId: subscription.id,
  ownerId: owner,
  tenantId: TENANT_A,
  agentId: subscription.agentId,
  invocationMode: 'delegated',
  ...overrides,
});

/** A grant of the whole agent, made for one revision of the subscription. */
const whole = (
  revision: number,
  overrides: Partial<RunGrant<SubscriptionIdentity>> = {},
): RunGrant<SubscriptionIdentity> => ({
  version: 1,
  scheduleRevision: revision,
  revision: 'grant-1',
  consents: [],
  everything: true,
  grantedAtMs: NOW - 1000,
  absoluteExpiresAtMs: NOW + 60_000,
  ...overrides,
});

const confirm = (
  identity: SubscriptionIdentity,
  enrollment: RunGrant<SubscriptionIdentity>,
  expectedRevision: string | null = null,
) =>
  as(identity.tenantId ?? TENANT_A, async () =>
    grants.confirmRunGrant({
      identity,
      expectedConfigRevision: enrollment.scheduleRevision,
      expectedRevision,
      enrollment,
    }),
  );

const snapshot = (identity: SubscriptionIdentity, tenantId = TENANT_A) =>
  as(tenantId, async () => grants.readRunGrant(identity));

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
  if (mongoose.models.AgentEventSubscription) mongoose.deleteModel('AgentEventSubscription');
  subscriptions = createSubscriptions(mongoose);
  grants = createSubscriptionGrantStorage(mongoose, { now: () => NOW });
  Rows = mongoose.models.AgentEventSubscription as Model<SubscriptionRecord>;
  await runAsSystem(async () => Rows.deleteMany({}));
});

describe('reading a subscription for its grant', () => {
  it('answers nothing when the owner has no subscription by that id', async () => {
    const subscription = await made();
    expect(await snapshot(identityOf({ id: 'sub_missing', agentId: 'agent_1' }))).toBeNull();
    expect(await snapshot(identityOf(subscription, { ownerId: other }))).toBeNull();
  });

  it('describes a subscription that holds no grant, which is not an unreadable one', async () => {
    const subscription = await made(owner, { enabled: false });
    expect(await snapshot(identityOf(subscription))).toEqual({
      agentId: 'agent_1',
      enabled: false,
      configRevision: 0,
      enrollment: null,
      compatible: true,
    });
  });

  it('never reads a subscription of another tenant', async () => {
    const subscription = await made();
    expect(await snapshot(identityOf(subscription, { tenantId: TENANT_B }), TENANT_B)).toBeNull();
    expect(await snapshot(identityOf(subscription), TENANT_B)).toBeNull();
    // Nor where no tenant is in scope to narrow the read: the identity names its own.
    expect(await grants.readRunGrant(identityOf(subscription, { tenantId: TENANT_B }))).toBeNull();
    expect(await grants.readRunGrant(identityOf(subscription))).not.toBeNull();
  });

  it('reads a stored value that is not a grant as incompatible, not as no grant', async () => {
    const subscription = await made();
    await runAsSystem(async () =>
      Rows.collection.updateOne({ id: subscription.id }, { $set: { grant: { version: 2 } } }),
    );
    expect(await snapshot(identityOf(subscription))).toMatchObject({
      enrollment: null,
      compatible: false,
    });
  });
});

describe('storing a grant', () => {
  it('stores it on the subscription, for the revision it was made for', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    expect(await confirm(identity, whole(0))).toBe(true);
    expect(await snapshot(identity)).toMatchObject({
      configRevision: 0,
      enrollment: { revision: 'grant-1', scheduleRevision: 0, everything: true },
      compatible: true,
    });
    expect((await row(subscription.id))?.grant).toMatchObject({ revision: 'grant-1' });
  });

  it('refuses one made for a revision the subscription has left', async () => {
    const subscription = await made();
    await as(TENANT_A, async () =>
      subscriptions.update(subscription.id, owner, { prompt: 'Changed.' }),
    );
    expect(await confirm(identityOf(subscription), whole(0))).toBe(false);
    expect((await row(subscription.id))?.grant).toBeUndefined();
  });

  it('refuses one for another owner, tenant or agent', async () => {
    const subscription = await made();
    expect(await confirm(identityOf(subscription, { ownerId: other }), whole(0))).toBe(false);
    expect(await confirm(identityOf(subscription, { tenantId: TENANT_B }), whole(0))).toBe(false);
    expect(await confirm(identityOf(subscription, { agentId: 'agent_2' }), whole(0))).toBe(false);
    expect((await row(subscription.id))?.grant).toBeUndefined();
  });

  it('replaces a grant only when told which one it replaces', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    expect(await confirm(identity, whole(0, { revision: 'grant-2' }))).toBe(false);
    expect(await confirm(identity, whole(0, { revision: 'grant-2' }), 'grant-1')).toBe(true);
    expect((await snapshot(identity))?.enrollment?.revision).toBe('grant-2');
  });

  it('refuses a write that is not a grant, whatever path it takes', async () => {
    const subscription = await made();
    await expect(
      runAsSystem(async () =>
        Rows.updateOne(
          { id: subscription.id },
          { $set: { grant: { version: 1 } } },
          { runValidators: true },
        ),
      ),
    ).rejects.toThrow(/grant/);
  });

  describe('with a consent for a server', () => {
    const consented = (identity: SubscriptionIdentity, of: Partial<SubscriptionIdentity> = {}) =>
      whole(0, {
        everything: undefined,
        consents: [
          {
            id: 'consent-1',
            revision: 'grant-1',
            identity: { ...identity, ...of },
            resource: {
              serverName: 'warehouse',
              url: 'https://warehouse.example/mcp',
              configurationRevision: 'config-1',
              credentialMode: 'static',
              issuer: null,
              audience: null,
              scopes: [],
            },
            permittedTools: [{ agentId: identity.agentId, tools: ['query'] }],
            policyRevision: 'policy-1',
            grantedAtMs: NOW - 1000,
            absoluteExpiresAtMs: NOW + 60_000,
            revokedAtMs: null,
          },
        ],
      });
    const admit = (identity: SubscriptionIdentity, requireEnabled?: boolean) =>
      as(TENANT_A, async () =>
        grants.admitRunGrant({
          identity,
          expectedConfigRevision: 0,
          revision: 'grant-1',
          consentId: 'consent-1',
          ...(requireEnabled !== undefined && { requireEnabled }),
        }),
      );

    it.each([
      ['subscription', { subscriptionId: 'sub_other' }],
      ['owner', { ownerId: other }],
      ['tenant', { tenantId: TENANT_B }],
      ['agent', { agentId: 'agent_2' }],
    ] as const)('refuses a consent made out to another %s', async (_field, of) => {
      const subscription = await made();
      const identity = identityOf(subscription);
      await expect(confirm(identity, consented(identity, of))).rejects.toThrow(
        'Invalid scheduled MCP enrollment binding',
      );
      expect(await confirm(identity, consented(identity))).toBe(true);
    });

    it('admits a call only while the subscription is turned on, unless told otherwise', async () => {
      const subscription = await made();
      const identity = identityOf(subscription);
      await confirm(identity, consented(identity));
      expect(await admit(identity)).toBe(true);
      await runAsSystem(async () =>
        Rows.updateOne({ id: subscription.id }, { $set: { enabled: false } }),
      );
      expect(await admit(identity)).toBe(false);
      expect(await admit(identity, false)).toBe(true);
    });
  });

  it('revokes the grant it is told about and no other', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    expect(await as(TENANT_A, async () => grants.revokeRunGrant(identity, 'grant-0'))).toBe(false);
    expect(await as(TENANT_A, async () => grants.revokeRunGrant(identity, 'grant-1'))).toBe(true);
    expect((await snapshot(identity))?.enrollment?.revokedAtMs).toBe(NOW);
  });
});

describe('the subscription record', () => {
  it('never carries the grant', async () => {
    const subscription = await made();
    await confirm(identityOf(subscription), whole(0));
    const [read, [listed]] = await as(TENANT_A, async () =>
      Promise.all([subscriptions.get(subscription.id, owner), subscriptions.list(owner)]),
    );
    expect(read).toEqual(subscription);
    expect(listed).toEqual(subscription);
    expect(read).not.toHaveProperty('grant');
  });

  it('is deleted with its grant', async () => {
    const subscription = await made();
    await confirm(identityOf(subscription), whole(0));
    await as(TENANT_A, async () => subscriptions.remove(subscription.id, owner));
    expect(await snapshot(identityOf(subscription))).toBeNull();
  });
});

describe('an edit and the grant', () => {
  const edit = (id: string, patch: Parameters<Subscriptions['update']>[2], expected?: number) =>
    as(TENANT_A, async () => subscriptions.update(id, owner, patch, expected));

  it('takes the grant along when it only turns the subscription off or on', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    expect(await edit(subscription.id, { enabled: false })).toMatchObject({
      ok: true,
      value: { enabled: false, revision: 1 },
    });
    expect(await snapshot(identity)).toMatchObject({
      enabled: false,
      configRevision: 1,
      enrollment: { scheduleRevision: 1, revision: 'grant-1' },
    });
    await edit(subscription.id, { enabled: true });
    expect(await snapshot(identity)).toMatchObject({
      enabled: true,
      configRevision: 2,
      enrollment: { scheduleRevision: 2 },
    });
  });

  it('leaves the grant behind on any other edit', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    await edit(subscription.id, { prompt: 'Something else.' });
    expect(await snapshot(identity)).toMatchObject({
      configRevision: 1,
      enrollment: { scheduleRevision: 0 },
    });
  });

  it('leaves it behind when the edit turns it on and changes something else too', async () => {
    const subscription = await made(owner, { enabled: false });
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    await edit(subscription.id, { enabled: true, events: ['github.pull_request.closed'] });
    expect(await snapshot(identity)).toMatchObject({
      configRevision: 1,
      enrollment: { scheduleRevision: 0 },
    });
  });

  it('leaves it behind when the edit turns it off and clears a field', async () => {
    const subscription = await made(owner, { cap: { perHour: 5 } });
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    await edit(subscription.id, { enabled: false, cap: null });
    expect(await snapshot(identity)).toMatchObject({
      configRevision: 1,
      enrollment: { scheduleRevision: 0 },
    });
  });

  it('keeps a grant already left behind as far behind when turned off and on', async () => {
    const subscription = await made();
    const identity = identityOf(subscription);
    await confirm(identity, whole(0));
    await edit(subscription.id, { prompt: 'Something else.' });
    await edit(subscription.id, { enabled: false });
    expect(await snapshot(identity)).toMatchObject({
      configRevision: 2,
      enrollment: { scheduleRevision: 1 },
    });
  });

  it('turns a subscription with no grant off without inventing one', async () => {
    const subscription = await made();
    expect(await edit(subscription.id, { enabled: false })).toMatchObject({
      ok: true,
      value: { enabled: false, revision: 1 },
    });
    const stored = await row(subscription.id);
    expect(stored?.grant).toBeUndefined();
    expect(stored).not.toHaveProperty('grant');
  });

  it('still refuses an edit made from a revision that has moved', async () => {
    const subscription = await made();
    await confirm(identityOf(subscription), whole(0));
    await edit(subscription.id, { enabled: false });
    expect(await edit(subscription.id, { enabled: true }, 0)).toEqual({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(await edit('sub_missing', { enabled: true })).toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect(await snapshot(identityOf(subscription))).toMatchObject({
      enabled: false,
      configRevision: 1,
      enrollment: { scheduleRevision: 1 },
    });
  });
});
