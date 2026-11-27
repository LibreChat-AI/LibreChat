import mongoose from 'mongoose';
import { runInThisContext } from 'node:vm';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  runAsSystem,
  createModels,
  createMethods,
  tenantStorage,
  createConnections,
  createSubscriptions,
} from '@librechat/data-schemas';
import type { Connections, Subscriptions } from '@librechat/data-schemas';
import type { Connection, Subscription } from 'librechat-data-provider';
import type { AgentTriggerEnvelope } from '~/agents/triggers/envelope';
import type { Payload } from './fixtures.helper';
import type { Occurrence } from './catalog';
import type { AccessCheck } from './access';
import type { RouteDeps } from './route';
import {
  set,
  user,
  INSTALLATION_ID,
  REPOSITORY_ID,
  reviewSubmitted,
  suitePullRequest,
  pullRequestClosed,
  issueCommentCreated,
  checkSuiteCompleted,
} from './fixtures.helper';
import { getAgentTriggerIdempotencyKey } from '~/agents/triggers/envelope';
import { prepareAgentTriggerDelivery } from '~/agents/triggers/delivery';
import { SUBSCRIPTION_SOURCE } from '~/agents/authority/context';
import { createRoute, match } from './route';
import { normalize } from './catalog';
import { itemKey } from './item';

const DB_SETUP_TIMEOUT_MS = 60_000;
const OWNER = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const AGENT = 'agent_root';
const DIGEST = 'a'.repeat(64);
const REVIEW = 'github.pull_request_review.submitted';
const SUITE = 'github.check_suite.completed';
const COMMENT = 'github.issue_comment.created';
const CLOSED = 'github.pull_request.closed';

let server: MongoMemoryServer;
let subscriptions: Subscriptions;
let connections: Connections;
let methods: ReturnType<typeof createMethods>;
let access: jest.Mock<ReturnType<AccessCheck>, Parameters<AccessCheck>>;
let enqueue: jest.MockedFunction<RouteDeps['enqueue']>;

/** The trigger store's own enqueue: its duplicate and conflict rules are the real ones. */
const store: RouteDeps['enqueue'] = async (envelope, options) => {
  const prepared = prepareAgentTriggerDelivery(envelope, options);
  const { delivery, replayed } = await runAsSystem(() =>
    methods.enqueueAgentTriggerDelivery(prepared),
  );
  return {
    id: delivery.id,
    deliveryKey: delivery.deliveryKey,
    status: delivery.status === 'batched' ? 'pending' : delivery.status,
    availableAt: delivery.availableAt,
    replayed,
  };
};

const route = (overrides: Partial<RouteDeps> = {}) =>
  createRoute({ match: subscriptions.match, enqueue, access, now: () => 1_000, ...overrides });

/** Every envelope the store holds, oldest first. */
async function queued(): Promise<Array<{ tenantId?: string; envelope: AgentTriggerEnvelope }>> {
  return mongoose.models.AgentTriggerDelivery.find({})
    .sort({ _id: 1 })
    .lean<Array<{ tenantId?: string; envelope: AgentTriggerEnvelope }>>();
}

async function bind(tenantId?: string, installation = String(INSTALLATION_ID)) {
  const write = () =>
    connections.bind({
      provider: 'github',
      installation,
      account: { id: '99', name: 'example-org' },
      createdBy: OWNER,
    });
  const bound = tenantId ? await tenantStorage.run({ tenantId }, write) : await write();
  if (!bound.ok) throw new Error('connection was not bound');
  return bound.value;
}

async function subscribe(
  connection: Pick<Connection, 'id' | 'tenantId'>,
  overrides: Partial<Subscription> = {},
  owner = OWNER,
): Promise<Subscription> {
  const write = () =>
    subscriptions.create(owner, {
      connection: connection.id,
      agentId: AGENT,
      events: [REVIEW, SUITE, COMMENT, CLOSED],
      target: 'new',
      prompt: 'Read the event and act on it.',
      actors: 'any',
      bots: false,
      enabled: true,
      ...overrides,
    });
  return connection.tenantId
    ? tenantStorage.run({ tenantId: connection.tenantId }, write)
    : write();
}

function read(event: string, body: Payload): Occurrence[] {
  const outcome = normalize('github', event, body);
  if (!outcome.ok) throw new Error(`fixture did not read: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

const review = (body = reviewSubmitted()) => read('pull_request_review', body);
const suite = (body = checkSuiteCompleted()) => read('check_suite', body);
const comment = () => read('issue_comment', issueCommentCreated());

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
  await methods.ensureAgentTriggerDeliveryIndexes();
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  subscriptions = createSubscriptions(mongoose);
  connections = createConnections(mongoose);
  await Promise.all([
    mongoose.models.AgentEventSubscription.deleteMany({}),
    mongoose.models.AgentEventConnection.deleteMany({}),
    mongoose.models.AgentTriggerDelivery.deleteMany({}),
  ]);
  access = jest.fn<ReturnType<AccessCheck>, Parameters<AccessCheck>>(async () => 'write');
  enqueue = jest.fn(store);
});

describe('createRoute', () => {
  it("starts a run for the subscription's agent, as its owner, with the event attached", async () => {
    const connection = await bind();
    const subscription = await subscribe(connection);
    const routed = await route()({
      verified: { digest: DIGEST },
      occurrences: review(),
      connection,
    });
    expect(routed).toEqual({ enqueued: 1, duplicates: 0, skipped: {} });
    const [stored] = await queued();
    const envelope = stored.envelope;
    expect(envelope).toMatchObject({
      mode: 'fire',
      principal: { userId: OWNER },
      target: { agentId: AGENT },
      input: 'Read the event and act on it.',
      run: { metadata: { revision: subscription.revision } },
      event: {
        type: REVIEW,
        source: { type: SUBSCRIPTION_SOURCE, id: subscription.id },
        payload: {
          provider: 'github',
          type: REVIEW,
          item: {
            provider: 'github',
            kind: 'pr',
            repo: REPOSITORY_ID,
            number: 42,
            key: `github:pr:${REPOSITORY_ID}#42`,
          },
          actor: { login: 'example-reviewer', bot: false },
          repo: { id: REPOSITORY_ID, name: 'example-org/widgets' },
          title: 'Add a retry to the widget loader',
          state: 'changes_requested',
          text: 'The retry count should come from config.',
          branch: 'main',
          labels: ['needs-agent', 'backend'],
        },
      },
    });
    expect(envelope.principal.tenantId).toBeUndefined();
    expect(envelope.deliveryId).toBe(envelope.event.id);
    expect(envelope.event.id).toMatch(/^github_[0-9a-f]{64}$/);
  });

  it('names nothing of the delivery but the event the catalog read', async () => {
    const connection = await bind();
    await subscribe(connection);
    await route()({ verified: { digest: DIGEST }, occurrences: review(), connection });
    const [{ envelope }] = await queued();
    const payload = envelope.event.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        'provider',
        'type',
        'item',
        'actor',
        'repo',
        'occurredAt',
        'title',
        'state',
        'url',
        'text',
        'sha',
        'branch',
        'labels',
      ].sort(),
    );
    expect(JSON.stringify(envelope)).not.toContain(String(INSTALLATION_ID));
  });

  describe('a delivery seen again', () => {
    it('queues nothing new for the same body, however often it arrives', async () => {
      const connection = await bind();
      await subscribe(connection);
      const run = route();
      const delivery = { verified: { digest: DIGEST }, occurrences: review(), connection };
      expect(await run(delivery)).toMatchObject({ enqueued: 1, duplicates: 0 });
      expect(await run(delivery)).toMatchObject({ enqueued: 0, duplicates: 1 });
      // A capture posted again comes with a fresh receipt time and request id; still one run.
      expect(await route({ now: () => 9_000 })(delivery)).toMatchObject({ duplicates: 1 });
      expect(await queued()).toHaveLength(1);
    });

    it('queues another body as another run', async () => {
      const connection = await bind();
      await subscribe(connection);
      const run = route();
      await run({ verified: { digest: DIGEST }, occurrences: review(), connection });
      const other = { verified: { digest: 'b'.repeat(64) }, occurrences: review(), connection };
      expect(await run(other)).toMatchObject({ enqueued: 1 });
      expect(await queued()).toHaveLength(2);
    });

    it('counts a delivery queued before the subscription was edited as a duplicate', async () => {
      const connection = await bind();
      const subscription = await subscribe(connection);
      const delivery = { verified: { digest: DIGEST }, occurrences: review(), connection };
      await route()(delivery);
      const edited = await subscriptions.update(subscription.id, OWNER, { prompt: 'Changed.' });
      expect(edited.ok).toBe(true);
      expect(await route()(delivery)).toEqual({ enqueued: 0, duplicates: 1, skipped: {} });
      expect(await queued()).toHaveLength(1);
    });
  });

  describe('fan-out', () => {
    it('starts one run for each pull request a check suite reports on', async () => {
      const connection = await bind();
      await subscribe(connection);
      const body = set(checkSuiteCompleted(), 'check_suite.pull_requests', [
        suitePullRequest(42),
        suitePullRequest(43),
      ]);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: suite(body),
        connection,
      });
      expect(routed.enqueued).toBe(2);
      const keys = (await queued()).map(
        ({ envelope }) => (envelope.event.payload as { item: { key: string } }).item.key,
      );
      expect(keys.sort()).toEqual([
        `github:pr:${REPOSITORY_ID}#42`,
        `github:pr:${REPOSITORY_ID}#43`,
      ]);
      const ids = (await queued()).map(({ envelope }) => getAgentTriggerIdempotencyKey(envelope));
      expect(new Set(ids).size).toBe(2);
    });

    it('starts one run for each subscription that listens, each as its own owner', async () => {
      const connection = await bind();
      const mine = await subscribe(connection);
      const theirs = await subscribe(connection, { agentId: 'agent_other' }, OTHER);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.enqueued).toBe(2);
      const runs = (await queued()).map(({ envelope }) => [
        envelope.event.source.id,
        envelope.principal.userId,
        envelope.target.agentId,
      ]);
      expect(runs).toEqual(
        expect.arrayContaining([
          [mine.id, OWNER, AGENT],
          [theirs.id, OTHER, 'agent_other'],
        ]),
      );
    });

    it('keeps runs about one pull request in one lane per subscription', async () => {
      const connection = await bind();
      await subscribe(connection);
      const run = route();
      await run({ verified: { digest: DIGEST }, occurrences: review(), connection });
      await run({ verified: { digest: 'c'.repeat(64) }, occurrences: comment(), connection });
      const lanes = enqueue.mock.calls.map(([, options]) => options.orderingKey);
      expect(lanes[0]).toMatch(/^event_[0-9a-f]{64}$/);
      expect(lanes[1]).toBe(lanes[0]);
      const other = set(reviewSubmitted(), 'pull_request.number', 7);
      await run({ verified: { digest: 'd'.repeat(64) }, occurrences: review(other), connection });
      expect(enqueue.mock.calls[2][1].orderingKey).not.toBe(lanes[0]);
    });
  });

  describe('tenants and connections', () => {
    it("queues each run in its subscription's tenant", async () => {
      const connection = await bind('tenant-a');
      await subscribe(connection);
      await route()({ verified: { digest: DIGEST }, occurrences: review(), connection });
      const [stored] = await queued();
      expect(stored.tenantId).toBe('tenant-a');
      expect(stored.envelope.principal.tenantId).toBe('tenant-a');
    });

    it('never matches a subscription on another connection', async () => {
      const connection = await bind();
      const elsewhere = await bind(undefined, '9999');
      await subscribe(elsewhere);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed).toEqual({ enqueued: 0, duplicates: 0, skipped: {} });
    });

    it('never matches a subscription of another tenant naming the same connection', async () => {
      const connection = await bind('tenant-a');
      await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        subscriptions.create(OWNER, {
          connection: connection.id,
          agentId: AGENT,
          events: [REVIEW],
          target: 'new',
          prompt: 'Read the event.',
          actors: 'any',
          bots: false,
          enabled: true,
        }),
      );
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.enqueued).toBe(0);
      expect(await queued()).toHaveLength(0);
    });

    it('refuses a subscription the lookup hands over for another connection or tenant', async () => {
      const connection = await bind('tenant-a');
      const own = await subscribe(connection);
      const strangers: Subscription[] = [
        { ...own, connection: 'conn_other' },
        { ...own, tenantId: 'tenant-b' },
        { ...own, tenantId: undefined },
      ];
      const routed = await route({ match: async () => strangers })({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed).toEqual({ enqueued: 0, duplicates: 0, skipped: { connection: 3 } });
    });

    it('refuses an event from another installation than the connection', async () => {
      const connection = await bind();
      await subscribe(connection);
      const body = set(reviewSubmitted(), 'installation', { id: INSTALLATION_ID + 1 });
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(body),
        connection,
      });
      expect(routed).toEqual({ enqueued: 0, duplicates: 0, skipped: { installation: 1 } });
    });

    it('refuses everything on a connection whose installation id does not read', async () => {
      const connection = await bind(undefined, 'not-a-number');
      await subscribe(connection);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.skipped).toEqual({ installation: 1 });
      expect(access).not.toHaveBeenCalled();
    });

    it('refuses an event that names no installation on a connection whose id does not read', async () => {
      const connection = await bind(undefined, 'not-a-number');
      await subscribe(connection, { actors: 'write' });
      const body = set(reviewSubmitted(), 'installation', undefined);
      const occurrences = review(body);
      expect(occurrences[0].installation).toBeUndefined();
      const routed = await route()({ verified: { digest: DIGEST }, occurrences, connection });
      expect(routed).toEqual({ enqueued: 0, duplicates: 0, skipped: { installation: 1 } });
      expect(access).not.toHaveBeenCalled();
    });
  });

  describe('who may start a run', () => {
    const bot = () => set(reviewSubmitted(), 'review.user', user('helper[bot]', 7000, 'Bot'));

    it('lets in an actor GitHub confirms may push, asking about that actor', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'write' });
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.enqueued).toBe(1);
      expect(access).toHaveBeenCalledWith(
        INSTALLATION_ID,
        'example-org/widgets',
        'example-reviewer',
      );
    });

    it.each([
      ['none', 'actor'],
      ['unknown', 'unknown'],
    ] as const)('refuses an actor GitHub answers %s about', async (answer, reason) => {
      const connection = await bind();
      await subscribe(connection, { actors: 'write' });
      access.mockResolvedValue(answer);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed).toEqual({ enqueued: 0, duplicates: 0, skipped: { [reason]: 1 } });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('refuses everyone a write rule asks about when no GitHub App is configured', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'write' });
      const routed = await route({ access: null })({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.skipped).toEqual({ unknown: 1 });
    });

    it('lets anyone in under the open rule without asking GitHub', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'any' });
      expect(
        (await route()({ verified: { digest: DIGEST }, occurrences: review(), connection }))
          .enqueued,
      ).toBe(1);
      expect(access).not.toHaveBeenCalled();
    });

    it('refuses everyone under the linked rule, since no account links are recorded', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'linked' });
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(),
        connection,
      });
      expect(routed.skipped).toEqual({ linked: 1 });
      expect(access).not.toHaveBeenCalled();
    });

    it('refuses a bot unless the subscription lets bots in, and never asks about one', async () => {
      const connection = await bind();
      const closed = await subscribe(connection, { actors: 'write' });
      const open = await subscribe(connection, { actors: 'write', bots: true }, OTHER);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: review(bot()),
        connection,
      });
      expect(routed).toEqual({ enqueued: 1, duplicates: 0, skipped: { bot: 1 } });
      expect((await queued())[0].envelope.event.source.id).toBe(open.id);
      expect((await queued()).map(({ envelope }) => envelope.event.source.id)).not.toContain(
        closed.id,
      );
      expect(access).not.toHaveBeenCalled();
    });

    it('holds no actor rule against a finished check suite, whoever pushed', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'linked' });
      await subscribe(connection, { actors: 'write' }, OTHER);
      const body = set(checkSuiteCompleted(), 'sender', user('helper[bot]', 7000, 'Bot'));
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: suite(body),
        connection,
      });
      expect(routed.enqueued).toBe(2);
      expect(access).not.toHaveBeenCalled();
    });

    it('holds the actor rule against a closed pull request', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'linked' });
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: read('pull_request', pullRequestClosed()),
        connection,
      });
      expect(routed.skipped).toEqual({ linked: 1 });
    });
  });

  describe('filters', () => {
    it('starts nothing for a subscription whose filter the event fails, and runs the rest', async () => {
      const connection = await bind();
      const narrow = await subscribe(connection, { filters: { branches: ['main'] } });
      const wide = await subscribe(connection, {}, OTHER);
      const routed = await route()({
        verified: { digest: DIGEST },
        occurrences: comment(),
        connection,
      });
      expect(routed).toEqual({ enqueued: 1, duplicates: 0, skipped: { branch: 1 } });
      const sources = (await queued()).map(({ envelope }) => envelope.event.source.id);
      expect(sources).toEqual([wide.id]);
      expect(sources).not.toContain(narrow.id);
    });
  });

  describe('a failed enqueue', () => {
    it('leaves no rejection unhandled while another subscription still waits on GitHub', async () => {
      const connection = await bind();
      await subscribe(connection, { actors: 'any' });
      await subscribe(connection, { actors: 'write', agentId: 'agent_other' }, OTHER);
      // A spec's own `process` is Jest's copy; rejections are reported on the real one.
      const real = runInThisContext('process') as NodeJS.Process;
      const unhandled = jest.fn();
      real.on('unhandledRejection', unhandled);
      try {
        // The open subscription's enqueue fails at once; the other's answer arrives later.
        access.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve('write'), 50)),
        );
        const outage = new Error('queue down');
        enqueue.mockRejectedValueOnce(outage);
        await expect(
          route()({ verified: { digest: DIGEST }, occurrences: review(), connection }),
        ).rejects.toBe(outage);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
        expect(await queued()).toHaveLength(1);
      } finally {
        real.off('unhandledRejection', unhandled);
      }
    });

    it('queues the other runs, then throws the failure', async () => {
      const connection = await bind();
      await subscribe(connection);
      await subscribe(connection, { agentId: 'agent_other' }, OTHER);
      const outage = new Error('queue down');
      enqueue.mockRejectedValueOnce(outage);
      await expect(
        route()({ verified: { digest: DIGEST }, occurrences: review(), connection }),
      ).rejects.toBe(outage);
      expect(await queued()).toHaveLength(1);
      // The provider delivers again: the run already queued is a duplicate, the other is queued.
      expect(
        await route()({ verified: { digest: DIGEST }, occurrences: review(), connection }),
      ).toEqual({ enqueued: 1, duplicates: 1, skipped: {} });
    });
  });
});

describe('match', () => {
  const base: Subscription = {
    id: 'sub_1',
    user: OWNER,
    connection: 'conn_1',
    agentId: AGENT,
    events: [REVIEW, COMMENT, SUITE],
    target: 'new',
    prompt: 'Act.',
    actors: 'any',
    bots: false,
    enabled: true,
    revision: 0,
  };
  const [event] = review();
  const [talk] = comment();
  const [check] = suite();
  const filtered = (filters: Subscription['filters']): Subscription => ({ ...base, filters });

  it('passes an event a subscription with no filters listens for', () => {
    expect(match(base, event)).toBeNull();
  });

  it('refuses a subscription that is off, or does not listen for the event', () => {
    expect(match({ ...base, enabled: false }, event)).toBe('off');
    expect(match({ ...base, events: [SUITE] }, event)).toBe('event');
  });

  it('refuses a subscription that targets anything but a new conversation', () => {
    const watching = { ...base, target: 'item' } as unknown as Subscription;
    expect(match(watching, event)).toBe('target');
  });

  it('matches a repository by name without case, or by its id', () => {
    expect(match(filtered({ repositories: ['Example-Org/Widgets'] }), event)).toBeNull();
    expect(match(filtered({ repositories: [String(REPOSITORY_ID)] }), event)).toBeNull();
    expect(match(filtered({ repositories: ['example-org/gadgets', '1'] }), event)).toBe(
      'repository',
    );
  });

  it('matches a branch exactly', () => {
    expect(match(filtered({ branches: ['release', 'main'] }), event)).toBeNull();
    expect(match(filtered({ branches: ['Main'] }), event)).toBe('branch');
    expect(match(filtered({ branches: ['main'] }), check)).toBeNull();
  });

  it('refuses a branch filter for an event that names no branch', () => {
    expect(talk.branch).toBeUndefined();
    expect(match(filtered({ branches: ['main'] }), talk)).toBe('branch');
  });

  it('matches a label without case, and refuses an event that lists none', () => {
    expect(match(filtered({ labels: ['NEEDS-AGENT'] }), event)).toBeNull();
    expect(match(filtered({ labels: ['needs-agent'] }), talk)).toBeNull();
    expect(match(filtered({ labels: ['frontend'] }), event)).toBe('label');
    expect(match(filtered({ labels: ['needs-agent'] }), check)).toBe('label');
  });

  it('needs every filter it sets to hold', () => {
    const all = filtered({
      repositories: ['example-org/widgets'],
      branches: ['main'],
      labels: ['backend'],
    });
    expect(match(all, event)).toBeNull();
    expect(match({ ...all, filters: { ...all.filters, branches: ['dev'] } }, event)).toBe('branch');
  });

  it('builds the item key every run of one pull request shares', () => {
    expect(itemKey(event.item)).toBe(itemKey(check.item));
  });
});
