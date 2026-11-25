import mongoose from 'mongoose';
import { PassThrough } from 'node:stream';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  logger,
  runAsSystem,
  createModels,
  createMethods,
  tenantStorage,
  createConnections,
  createSubscriptions,
} from '@librechat/data-schemas';
import type { Connections, Subscriptions } from '@librechat/data-schemas';
import type { Connection, Subscription } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { AgentTriggerEnvelope } from '~/agents/triggers/envelope';
import type { EventsConfigSource, EventSettings } from './settings';
import type { ReceiveDeps, Received } from './receive';
import type { PullRequestFetch } from '~/pulls/shared';
import type { Payload } from './fixtures.helper';
import { INSTALLATION_ID, reviewSubmitted, checkSuiteCompleted, set } from './fixtures.helper';
import { prepareAgentTriggerDelivery } from '~/agents/triggers/delivery';
import { createIngressHandler, createReceive } from './receive';
import { MAX_BODY_BYTES } from './settings';

const DB_SETUP_TIMEOUT_MS = 60_000;
const OWNER = new mongoose.Types.ObjectId().toString();
const AGENT = 'agent_root';
const SECRET = 'whsec-test-only-not-real';
const REVIEW = 'github.pull_request_review.submitted';
const SUITE = 'github.check_suite.completed';
const MARKER = 'SECRET-MARKER-9f2c';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

let server: MongoMemoryServer;
let subscriptions: Subscriptions;
let connections: Connections;
let methods: ReturnType<typeof createMethods>;
let fetchCalls: string[];

/** The trigger store's own enqueue: its duplicate rule is the real one. */
const store: ReceiveDeps['enqueue'] = async (envelope, options) => {
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

/** GitHub as the app sees it: a token, then a write answer for every account. */
/** What the fake provider reports for the install when asked: its state now. */
let install: 'active' | 'suspended' | 'missing' | 'outage' | 'forbidden' | 'rejected';

/** The provider as the app sees it: a token, a write answer, and the install's current state. */
const github: PullRequestFetch = async (input, init) => {
  const path = new URL(input).pathname;
  fetchCalls.push(`${init?.method ?? 'GET'} ${path}`);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (path.endsWith('/access_tokens')) {
    return json(
      { token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      201,
    );
  }
  if (/^\/app\/installations\/\d+$/.test(path)) {
    if (install === 'outage') throw new TypeError('fetch failed');
    if (install === 'missing') return json({ message: 'Not Found' }, 404);
    if (install === 'forbidden') return json({ message: 'Forbidden' }, 403);
    if (install === 'rejected') return json({ message: 'Bad credentials' }, 401);
    return json({
      id: INSTALLATION_ID,
      account: { login: 'example-org', id: 9001, type: 'Organization' },
      suspended_at: install === 'suspended' ? '2026-11-25T10:00:00Z' : null,
    });
  }
  return json({ permission: 'write' });
};

const settings = (overrides: Partial<EventSettings> = {}): EventSettings => ({
  limits: { excerpt: 2000, fanout: 10 },
  maxBodyBytes: MAX_BODY_BYTES,
  github: {
    app: { id: '12345', key: KEY, host: 'github.com', timeoutMs: 10_000 },
    secret: SECRET,
    accessTtlMs: 300_000,
  },
  ...overrides,
});

const deps = (overrides: Partial<ReceiveDeps> = {}): ReceiveDeps => ({
  connections,
  match: subscriptions.match,
  enqueue: store,
  fetch: github,
  ...overrides,
});

function signed(
  event: string,
  body: Payload | string,
  options: { secret?: string; delivery?: string } = {},
) {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(raw)
    .digest('hex');
  return {
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': options.delivery ?? 'a1b2c3d4-0000-1111-2222-333344445555',
      'x-hub-signature-256': `sha256=${signature}`,
    },
  };
}

/** `X-GitHub-Event: installation`, with the whole installation object GitHub sends with it. */
function installationEvent(action: string, id = INSTALLATION_ID): Payload {
  return {
    action,
    installation: {
      id,
      app_id: 12345,
      app_slug: 'example-agent-events',
      target_type: 'Organization',
      account: { login: 'example-org', id: 9001, type: 'Organization' },
      suspended_at: action === 'suspend' ? '2026-11-25T10:00:00Z' : null,
    },
    sender: { login: 'example-admin', id: 5009, type: 'User' },
  };
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
): Promise<Subscription> {
  const write = () =>
    subscriptions.create(OWNER, {
      connection: connection.id,
      agentId: AGENT,
      events: [REVIEW, SUITE],
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

async function queued(): Promise<Array<{ tenantId?: string; envelope: AgentTriggerEnvelope }>> {
  return mongoose.models.AgentTriggerDelivery.find({})
    .sort({ _id: 1 })
    .lean<Array<{ tenantId?: string; envelope: AgentTriggerEnvelope }>>();
}

async function stored(id: string): Promise<Connection | null> {
  return mongoose.models.AgentEventConnection.findOne({ id }).lean<Connection>();
}

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
  fetchCalls = [];
  install = 'active';
  await Promise.all([
    mongoose.models.AgentEventSubscription.deleteMany({}),
    mongoose.models.AgentEventConnection.deleteMany({}),
    mongoose.models.AgentTriggerDelivery.deleteMany({}),
  ]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('receive', () => {
  it('answers as if there were no route while events are off', async () => {
    const receive = createReceive(deps());
    const result = await receive(null, 'github', signed('pull_request_review', reviewSubmitted()));
    expect(result).toEqual({ status: 404, body: { code: 'not_found' } });
    expect(await queued()).toHaveLength(0);
  });

  it('answers as if there were no route for a provider it does not know', async () => {
    const receive = createReceive(deps());
    for (const name of ['gitlab', 'constructor', '__proto__', 'toString']) {
      const result = await receive(
        settings(),
        name,
        signed('pull_request_review', reviewSubmitted()),
      );
      expect(result.status).toBe(404);
    }
  });

  it('refuses a body over the limit before reading it', async () => {
    const receive = createReceive(deps());
    const inbound = signed('pull_request_review', reviewSubmitted());
    const result = await receive(
      settings({ maxBodyBytes: inbound.body.byteLength - 1 }),
      'github',
      inbound,
    );
    expect(result).toEqual({ status: 413, body: { code: 'too_large' } });
  });

  it('says the app is not configured when its settings do not resolve', async () => {
    const receive = createReceive(deps());
    const result = await receive(
      settings({ github: null }),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result).toEqual({ status: 503, body: { code: 'unconfigured' } });
  });

  it.each([
    [
      'missing',
      (inbound: ReturnType<typeof signed>) => {
        const { ['x-hub-signature-256']: _, ...headers } = inbound.headers;
        return { ...inbound, headers };
      },
    ],
    [
      'signed with another secret',
      () => signed('pull_request_review', reviewSubmitted(), { secret: 'another-secret' }),
    ],
    [
      'over another body',
      (inbound: ReturnType<typeof signed>) => ({
        ...inbound,
        body: Buffer.from(JSON.stringify(set(reviewSubmitted(), 'review.body', 'changed'))),
      }),
    ],
  ])('refuses a delivery whose signature is %s, and enqueues nothing', async (_name, change) => {
    const connection = await bind();
    await subscribe(connection);
    const receive = createReceive(deps());
    const result = await receive(
      settings(),
      'github',
      change(signed('pull_request_review', reviewSubmitted())),
    );
    expect(result).toEqual({ status: 401, body: { code: 'signature' } });
    expect(await queued()).toHaveLength(0);
  });

  it('acknowledges an event nothing listens for without looking anything up', async () => {
    const resolve = jest.fn(connections.resolve);
    const receive = createReceive(deps({ connections: { ...connections, resolve } }));
    const result = await receive(settings(), 'github', signed('star', { action: 'created' }));
    expect(result).toEqual({ status: 202, body: { code: 'ignored', reason: 'event' } });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a body that does not read as the event it claims to be', async () => {
    const receive = createReceive(deps());
    const result = await receive(settings(), 'github', signed('pull_request_review', '{"action":'));
    expect(result).toEqual({ status: 400, body: { code: 'malformed', field: 'body' } });
  });

  it('acknowledges and drops a delivery for an install no tenant has bound', async () => {
    const receive = createReceive(deps());
    const result = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result).toEqual({ status: 202, body: { code: 'unbound' } });
    expect(await queued()).toHaveLength(0);
  });

  it('acknowledges and drops a delivery for a suspended connection', async () => {
    const connection = await bind();
    await subscribe(connection);
    await connections.mark(connection.id, 'suspended');
    const receive = createReceive(deps());
    const result = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result).toEqual({ status: 202, body: { code: 'suspended' } });
    expect(await queued()).toHaveLength(0);
  });

  it("queues a run for the subscription, under the connection's tenant", async () => {
    const connection = await bind('tenant-a');
    const subscription = await subscribe(connection);
    const receive = createReceive(deps());
    const result = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result).toEqual({
      status: 202,
      body: { code: 'routed', enqueued: 1, duplicates: 0, skipped: {} },
    });
    const [row] = await queued();
    expect(row.tenantId).toBe('tenant-a');
    expect(row.envelope.principal).toEqual({ userId: OWNER, tenantId: 'tenant-a' });
    expect(row.envelope.event.source).toEqual({ type: 'subscription', id: subscription.id });
  });

  it("never queues into another tenant's subscription", async () => {
    const mine = await bind('tenant-a');
    const theirs = await bind('tenant-b', '9999');
    await subscribe(mine);
    await subscribe(theirs);
    const receive = createReceive(deps());
    await receive(settings(), 'github', signed('pull_request_review', reviewSubmitted()));
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.tenantId)).toEqual(['tenant-a']);
  });

  it('queues a body once, however often and under whatever delivery id it is posted', async () => {
    const connection = await bind();
    await subscribe(connection);
    const receive = createReceive(deps());
    const first = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    const again = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted(), {
        delivery: 'ffffffff-9999-8888-7777-666655554444',
      }),
    );
    expect(first.body.enqueued).toBe(1);
    expect(again.body).toMatchObject({ code: 'routed', enqueued: 0, duplicates: 1 });
    expect(await queued()).toHaveLength(1);
  });

  it('builds the app once per configuration, so its token is reused', async () => {
    const connection = await bind();
    await subscribe(connection, { actors: 'write' });
    const receive = createReceive(deps());
    await receive(settings(), 'github', signed('pull_request_review', reviewSubmitted()));
    await receive(
      settings(),
      'github',
      signed('pull_request_review', set(reviewSubmitted(), 'review.id', 3101)),
    );
    expect(fetchCalls.filter((call) => call.endsWith('/access_tokens'))).toHaveLength(1);
    expect(await queued()).toHaveLength(2);
  });

  it('answers 503 so the provider marks the delivery failed when the queue fails', async () => {
    const connection = await bind();
    await subscribe(connection);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const receive = createReceive(
      deps({
        enqueue: async () => {
          throw new Error(`queue down ${MARKER}`);
        },
      }),
    );
    const result = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result).toEqual({ status: 503, body: { code: 'unavailable' } });
    expect(JSON.stringify(error.mock.calls)).not.toContain(MARKER);
  });

  it('answers 503 when the connection store fails', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const receive = createReceive(
      deps({
        connections: {
          ...connections,
          resolve: async () => {
            throw new Error('store down');
          },
        },
      }),
    );
    const result = await receive(
      settings(),
      'github',
      signed('pull_request_review', reviewSubmitted()),
    );
    expect(result.status).toBe(503);
  });

  it('never puts the signature, the secret or the body in a response or a log', async () => {
    const connection = await bind();
    await subscribe(connection);
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => logger),
    );
    const receive = createReceive(deps());
    const body = set(reviewSubmitted(), 'review.body', MARKER);
    const inbound = signed('pull_request_review', body);
    const results: Received[] = [];
    results.push(await receive(settings(), 'github', inbound));
    results.push(
      await receive(settings(), 'github', signed('pull_request_review', body, { secret: 'x' })),
    );
    results.push(await receive(settings(), 'github', signed('pull_request_review', `${MARKER}{`)));
    const seen = JSON.stringify([results, spies.map((spy) => spy.mock.calls)]);
    expect(seen).not.toContain(MARKER);
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(inbound.headers['x-hub-signature-256'].slice(7));
  });

  describe("the provider's own installation events", () => {
    const post = (receive: ReturnType<typeof createReceive>, action: string) =>
      receive(settings(), 'github', signed('installation', installationEvent(action)));
    const status = async (id: string) => (await stored(id))?.status;

    it("applies the install's state the provider reports, in the connection's own tenant", async () => {
      const connection = await bind('tenant-a');
      const receive = createReceive(deps());
      install = 'suspended';
      expect((await post(receive, 'suspend')).body).toEqual({
        code: 'installation',
        state: 'suspended',
      });
      expect(await status(connection.id)).toBe('suspended');
      install = 'active';
      expect((await post(receive, 'unsuspend')).body).toEqual({
        code: 'installation',
        state: 'active',
      });
      expect(await status(connection.id)).toBe('active');
    });

    it('keeps the newer state when an older suspend arrives after the unsuspend', async () => {
      const connection = await bind();
      const receive = createReceive(deps());
      install = 'active';
      await post(receive, 'unsuspend');
      const late = await post(receive, 'suspend');
      expect(late.body).toEqual({ code: 'installation', state: 'active' });
      expect(await status(connection.id)).toBe('active');
    });

    it('keeps the newer state when an older unsuspend arrives after the suspend', async () => {
      const connection = await bind();
      const receive = createReceive(deps());
      install = 'suspended';
      await post(receive, 'suspend');
      await post(receive, 'unsuspend');
      expect(await status(connection.id)).toBe('suspended');
    });

    it('does not remove a connection the provider still lists, whatever the action', async () => {
      const connection = await bind();
      const receive = createReceive(deps());
      install = 'active';
      const result = await post(receive, 'deleted');
      expect(result.body).toEqual({ code: 'installation', state: 'active' });
      expect(await status(connection.id)).toBe('active');
    });

    it('removes the connection once the provider has no such install', async () => {
      const connection = await bind('tenant-a');
      const receive = createReceive(deps());
      install = 'missing';
      const result = await post(receive, 'deleted');
      expect(result.body).toEqual({ code: 'installation', state: 'removed' });
      expect(await stored(connection.id)).toBeNull();
    });

    it('answers 503 and changes nothing when the provider cannot be asked', async () => {
      jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const connection = await bind();
      const receive = createReceive(deps());
      install = 'outage';
      const result = await post(receive, 'deleted');
      expect(result).toEqual({ status: 503, body: { code: 'unavailable' } });
      expect(await status(connection.id)).toBe('active');
    });

    it.each(['forbidden', 'rejected'] as const)(
      'answers 503 and keeps the connection when the provider refuses the lookup (%s)',
      async (refusal) => {
        jest.spyOn(logger, 'error').mockImplementation(() => logger);
        const connection = await bind();
        const receive = createReceive(deps());
        install = refusal;
        const result = await post(receive, 'deleted');
        expect(result).toEqual({ status: 503, body: { code: 'unavailable' } });
        expect(await status(connection.id)).toBe('active');
      },
    );

    it('asks the provider every time, never from a cache', async () => {
      const connection = await bind();
      const receive = createReceive(deps());
      install = 'suspended';
      await post(receive, 'suspend');
      install = 'active';
      await post(receive, 'suspend');
      expect(await status(connection.id)).toBe('active');
      expect(fetchCalls.filter((call) => /\/app\/installations\/\d+$/.test(call))).toHaveLength(2);
    });

    it('changes only the connection that holds the install', async () => {
      const mine = await bind('tenant-a');
      const theirs = await bind('tenant-b', '9999');
      const receive = createReceive(deps());
      install = 'missing';
      await post(receive, 'deleted');
      expect(await stored(mine.id)).toBeNull();
      expect(await status(theirs.id)).toBe('active');
    });

    it('acknowledges an event for an install no tenant has bound, without asking', async () => {
      const receive = createReceive(deps());
      const result = await post(receive, 'deleted');
      expect(result).toEqual({ status: 202, body: { code: 'unbound' } });
      expect(fetchCalls).toHaveLength(0);
    });

    it('does not act on an unsigned installation event', async () => {
      const connection = await bind();
      const receive = createReceive(deps());
      const result = await receive(
        settings(),
        'github',
        signed('installation', installationEvent('deleted'), { secret: 'another-secret' }),
      );
      expect(result.status).toBe(401);
      expect(await stored(connection.id)).not.toBeNull();
    });

    it.each([
      [
        'another deleted event that names the install',
        () =>
          ({
            action: 'deleted',
            comment: { id: 1 },
            installation: { id: INSTALLATION_ID },
          }) as Payload,
      ],
      [
        'a body naming a repository',
        () => ({ ...installationEvent('deleted'), repository: { id: 1 } }) as Payload,
      ],
      ['a catalog event', () => set(checkSuiteCompleted(), 'action', 'deleted')],
    ])('does not read %s, relabelled as an installation event', async (_name, body) => {
      const connection = await bind();
      const receive = createReceive(deps());
      const result = await receive(settings(), 'github', signed('installation', body()));
      expect(result.status).not.toBe(200);
      expect(await stored(connection.id)).not.toBeNull();
    });
  });
});

/** A request as Express hands it to the handler: a readable body and its headers. */
function request(
  body: Buffer,
  headers: Record<string, string>,
  provider = 'github',
): Request & { destroyed?: boolean } {
  const stream = new PassThrough();
  const req = Object.assign(stream, { headers, params: { provider } });
  setImmediate(() => stream.end(body));
  return req as unknown as Request;
}

function response() {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const listeners: Array<() => void> = [];
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      listeners.forEach((listener) => listener());
      return res;
    },
    set(name: string, value: string) {
      sent.headers[name] = value;
      return res;
    },
    once(_event: string, listener: () => void) {
      listeners.push(listener);
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

describe('createIngressHandler', () => {
  const config = (events: Record<string, unknown>): EventsConfigSource => ({
    endpoints: { agents: { events } },
  });
  const env = {
    GH_APP_ID: '12345',
    GH_APP_KEY: KEY,
    GH_WEBHOOK_SECRET: SECRET,
  };
  const enabled = config({
    enabled: true,
    github: {
      appId: '${GH_APP_ID}',
      privateKey: '${GH_APP_KEY}',
      webhookSecret: '${GH_WEBHOOK_SECRET}',
    },
  });

  it('answers 404 while events are off, without reading the body', async () => {
    const handler = createIngressHandler({ ...deps(), getAppConfig: async () => config({}), env });
    const inbound = signed('pull_request_review', reviewSubmitted());
    const req = request(inbound.body, inbound.headers);
    const read = jest.spyOn(req, 'on');
    const { res, sent } = response();
    await handler(req, res);
    expect(sent).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect(read).not.toHaveBeenCalledWith('data', expect.anything());
  });

  it('reads the config from the base layer only', async () => {
    const getAppConfig = jest.fn(async () => config({}));
    const handler = createIngressHandler({ ...deps(), getAppConfig, env });
    const inbound = signed('pull_request_review', reviewSubmitted());
    await handler(request(inbound.body, inbound.headers), response().res);
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('queues a signed delivery end to end', async () => {
    const connection = await bind();
    await subscribe(connection);
    const handler = createIngressHandler({ ...deps(), getAppConfig: async () => enabled, env });
    const inbound = signed('pull_request_review', reviewSubmitted());
    const { res, sent } = response();
    await handler(request(inbound.body, inbound.headers), res);
    expect(sent).toMatchObject({ status: 202, body: { code: 'routed', enqueued: 1 } });
  });

  it('refuses a body that declares more than the limit, without reading it', async () => {
    const handler = createIngressHandler({
      ...deps(),
      getAppConfig: async () =>
        config({ ...enabled.endpoints!.agents!.events, maxBodyBytes: 65_536 }),
      env,
    });
    const inbound = signed('pull_request_review', reviewSubmitted());
    const req = request(inbound.body, { ...inbound.headers, 'content-length': '70000' });
    const read = jest.spyOn(req, 'on');
    const { res, sent } = response();
    await handler(req, res);
    expect(sent).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(sent.headers.Connection).toBe('close');
    expect(read).not.toHaveBeenCalledWith('data', expect.anything());
  });

  it('stops reading a body that grows past the limit', async () => {
    const handler = createIngressHandler({
      ...deps(),
      getAppConfig: async () =>
        config({ ...enabled.endpoints!.agents!.events, maxBodyBytes: 65_536 }),
      env,
    });
    // A body that never ends: only stopping at the limit can answer it.
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      headers: { 'content-type': 'application/json' },
      params: { provider: 'github' },
    }) as unknown as Request;
    const feed = setInterval(() => stream.write(Buffer.alloc(16_384, 'a')), 1);
    try {
      const { res, sent } = response();
      await handler(req, res);
      expect(sent).toMatchObject({ status: 413, body: { code: 'too_large' } });
    } finally {
      clearInterval(feed);
    }
  }, 5_000);

  it('answers 503 when the config cannot be read', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const handler = createIngressHandler({
      ...deps(),
      getAppConfig: async () => {
        throw new Error('config store down');
      },
      env,
    });
    const inbound = signed('pull_request_review', reviewSubmitted());
    const { res, sent } = response();
    await handler(request(inbound.body, inbound.headers), res);
    expect(sent).toMatchObject({ status: 503, body: { code: 'unavailable' } });
  });
});
