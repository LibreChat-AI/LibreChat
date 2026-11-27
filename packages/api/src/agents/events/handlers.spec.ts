import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  tenantStorage,
  createConnections,
  createSubscriptions,
  createSubscriptionGrantStorage,
} from '@librechat/data-schemas';
import type { RunGrantStorage, Subscriptions, Connections, IUser } from '@librechat/data-schemas';
import type { RunGrantView, Subscription, SubscriptionIdentity } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { RunGrantService } from '~/agents/authority/service';
import type { AgentAccess } from '~/schedules/access';
import { createSubscriptionHandlers } from './handlers';

const DB_SETUP_TIMEOUT_MS = 60_000;
const OWNER = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const AGENT = 'agent_root';

let server: MongoMemoryServer;
let subscriptions: Subscriptions;
let connections: Connections;
let storage: RunGrantStorage<SubscriptionIdentity>;
let access: jest.Mock<Promise<AgentAccess>, [string, IUser]>;
let view: jest.Mock<Promise<RunGrantView>, [SubscriptionIdentity]>;
let app: express.Express;

/** Each request acts as the user its headers name, in that user's tenant as the app scopes it. */
function build(): express.Express {
  const handlers = createSubscriptionHandlers({
    subscriptions,
    connections,
    access,
    grants: () => ({ view }) as unknown as RunGrantService<SubscriptionIdentity>,
  });
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.header('x-tenant') || undefined;
    if (!req.header('x-anonymous'))
      (req as Request & { user: Partial<IUser> }).user = {
        id: req.header('x-user') ?? OWNER,
        role: 'USER',
        ...(tenantId && { tenantId }),
      };
    // `x-unscoped`: the user has a tenant but none is in scope, so the store does not narrow.
    if (tenantId && !req.header('x-unscoped')) tenantStorage.run({ tenantId }, next);
    else next();
  });
  const as = (handler: unknown) => handler as express.RequestHandler;
  server.get('/connections', as(handlers.connections));
  server.get('/subscriptions', as(handlers.list));
  server.post('/subscriptions', as(handlers.create));
  server.patch('/subscriptions/:id', as(handlers.update));
  server.delete('/subscriptions/:id', as(handlers.remove));
  server.get('/subscriptions/:id/grant', as(handlers.grant.get));
  server.post('/subscriptions/:id/grant', as(handlers.grant.confirm));
  server.delete('/subscriptions/:id/grant', as(handlers.grant.revoke));
  return server;
}

const bind = async (tenantId?: string, installation = '4242') => {
  const write = () =>
    connections.bind({
      provider: 'github',
      installation,
      account: { id: '99', name: 'acme' },
      createdBy: OWNER,
    });
  const bound = tenantId ? await tenantStorage.run({ tenantId }, write) : await write();
  if (!bound.ok) throw new Error('connection was not bound');
  return bound.value.id;
};

const body = (connection: string, overrides: Record<string, unknown> = {}) => ({
  connection,
  agentId: AGENT,
  events: ['github.pull_request_review.submitted'],
  prompt: 'Review the feedback and push a fix.',
  ...overrides,
});

const create = (connection: string, overrides: Record<string, unknown> = {}, user = OWNER) =>
  request(app).post('/subscriptions').set('x-user', user).send(body(connection, overrides));

const stored = () => mongoose.models.AgentEventSubscription.countDocuments({});

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  subscriptions = createSubscriptions(mongoose);
  connections = createConnections(mongoose);
  storage = createSubscriptionGrantStorage(mongoose);
  await mongoose.models.AgentEventSubscription.deleteMany({});
  await mongoose.models.AgentEventConnection.deleteMany({});
  access = jest.fn<Promise<AgentAccess>, [string, IUser]>(async () => 'ok');
  view = jest.fn<Promise<RunGrantView>, [SubscriptionIdentity]>(
    async () => ({ state: 'missing' }) as RunGrantView,
  );
  app = build();
});

describe('creating a subscription', () => {
  it("stores it for the caller, with the deployment's actor rule when none is chosen", async () => {
    const connection = await bind();
    const res = await create(connection);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      user: OWNER,
      connection,
      agentId: AGENT,
      actors: 'write',
      bots: false,
      target: 'new',
      enabled: true,
      revision: 0,
    });
    expect(access).toHaveBeenCalledWith(AGENT, expect.objectContaining({ id: OWNER }));
    const listed = await request(app).get('/subscriptions').query({ agentId: AGENT });
    expect(listed.body.subscriptions.map((s: Subscription) => s.id)).toEqual([res.body.id]);
  });

  it('keeps an actor rule the owner chose', async () => {
    const res = await create(await bind(), { actors: 'linked', bots: true });
    expect(res.body).toMatchObject({ actors: 'linked', bots: true });
  });

  it.each([
    ['an event the catalog does not list', { events: ['github.push'] }],
    ['no events', { events: [] }],
    ['an empty prompt', { prompt: '  ' }],
    ['a target that is not a new conversation', { target: 'item' }],
    ['a field it does not know', { owner: OTHER }],
  ])('refuses %s and stores nothing', async (_case, overrides) => {
    const res = await create(await bind(), overrides);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'subscription_invalid' });
    expect(await stored()).toBe(0);
  });

  it.each<AgentAccess>(['forbidden', 'missing'])(
    'refuses an agent the caller may not run (%s)',
    async (answer) => {
      access.mockResolvedValue(answer);
      const res = await create(await bind());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ code: 'agent_unavailable' });
      expect(await stored()).toBe(0);
    },
  );

  it('refuses a connection that does not exist', async () => {
    const res = await create('conn_missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'connection_not_found' });
    expect(await stored()).toBe(0);
  });

  it("refuses another tenant's connection", async () => {
    const theirs = await bind('tenant-a');
    const res = await request(app)
      .post('/subscriptions')
      .set('x-tenant', 'tenant-b')
      .send(body(theirs));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'connection_not_found' });
    expect(await stored()).toBe(0);
  });

  it('answers an unexpected failure with a code and nothing it was sent', async () => {
    const connection = await bind();
    access.mockRejectedValue(new Error('acl store down: Review the feedback'));
    const res = await create(connection);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'subscription_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('Review the feedback');
  });
});

describe("another owner's subscription", () => {
  it('is not listed, edited, deleted or its grant read, and is left as it was', async () => {
    const connection = await bind();
    const theirs = (await create(connection, {}, OTHER)).body as Subscription;
    const listed = await request(app).get('/subscriptions');
    expect(listed.body.subscriptions).toEqual([]);
    const edited = await request(app)
      .patch(`/subscriptions/${theirs.id}`)
      .send({ prompt: 'Something else.' });
    expect(edited.status).toBe(404);
    expect(edited.body).toEqual({ code: 'subscription_not_found' });
    const deleted = await request(app).delete(`/subscriptions/${theirs.id}`);
    expect(deleted.status).toBe(404);
    const grant = await request(app).get(`/subscriptions/${theirs.id}/grant`);
    expect(grant.status).toBe(404);
    expect(grant.body).toEqual({ code: 'consent_not_found' });
    const confirmed = await request(app)
      .post(`/subscriptions/${theirs.id}/grant`)
      .send({ expectedRevision: null, allow: {} });
    expect(confirmed.status).toBe(404);
    const revoked = await request(app)
      .delete(`/subscriptions/${theirs.id}/grant`)
      .send({ expectedRevision: 'grant-1' });
    expect(revoked.status).toBe(404);
    expect(view).not.toHaveBeenCalled();
    expect(await subscriptions.get(theirs.id, OTHER)).toMatchObject({
      prompt: theirs.prompt,
      revision: 0,
    });
  });

  it("is not reached from another tenant, even by its owner's id", async () => {
    const connection = await bind('tenant-a');
    const res = await request(app)
      .post('/subscriptions')
      .set('x-tenant', 'tenant-a')
      .send(body(connection));
    const id = (res.body as Subscription).id;
    const as = (call: request.Test) => call.set('x-tenant', 'tenant-b');
    expect((await as(request(app).get('/subscriptions'))).body.subscriptions).toEqual([]);
    expect(
      (await as(request(app).patch(`/subscriptions/${id}`).send({ enabled: false }))).status,
    ).toBe(404);
    expect((await as(request(app).delete(`/subscriptions/${id}`))).status).toBe(404);
    expect((await as(request(app).get(`/subscriptions/${id}/grant`))).status).toBe(404);
    const left = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      subscriptions.get(id, OWNER),
    );
    expect(left).toMatchObject({ enabled: true, revision: 0 });
  });
});

describe('where no tenant is in scope and the store hands everything over', () => {
  it("still keeps another tenant's subscriptions and connections from the caller", async () => {
    const connection = await bind('tenant-a', '1');
    const made = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      subscriptions.create(OWNER, {
        connection,
        agentId: AGENT,
        events: ['github.pull_request_review.submitted'],
        target: 'new',
        prompt: 'Review the feedback.',
        actors: 'write',
        bots: false,
        enabled: true,
      }),
    );
    const as = (call: request.Test) => call.set('x-tenant', 'tenant-b').set('x-unscoped', '1');
    expect((await subscriptions.list(OWNER)).map((s) => s.id)).toEqual([made.id]);
    expect((await as(request(app).get('/subscriptions'))).body.subscriptions).toEqual([]);
    expect((await as(request(app).get('/connections'))).body.connections).toEqual([]);
    const edited = await as(
      request(app).patch(`/subscriptions/${made.id}`).send({ enabled: false }),
    );
    expect(edited.status).toBe(404);
    expect((await as(request(app).delete(`/subscriptions/${made.id}`))).status).toBe(404);
    expect((await as(request(app).get(`/subscriptions/${made.id}/grant`))).status).toBe(404);
    expect(await subscriptions.get(made.id)).toMatchObject({ enabled: true, revision: 0 });
  });
});

describe('editing a subscription', () => {
  it('moves its revision, and refuses an edit made from an older one', async () => {
    const made = (await create(await bind())).body as Subscription;
    const first = await request(app)
      .patch(`/subscriptions/${made.id}`)
      .send({ prompt: 'Only reply when asked.', expectedRevision: 0 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ prompt: 'Only reply when asked.', revision: 1 });
    const stale = await request(app)
      .patch(`/subscriptions/${made.id}`)
      .send({ prompt: 'Something else.', expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ code: 'subscription_conflict' });
  });

  it('refuses events outside the catalog and an edit that changes nothing', async () => {
    const made = (await create(await bind())).body as Subscription;
    for (const edit of [{ events: ['github.push'] }, { expectedRevision: 0 }, {}]) {
      const res = await request(app).patch(`/subscriptions/${made.id}`).send(edit);
      expect(res.status).toBe(400);
    }
    expect((await subscriptions.get(made.id, OWNER))?.revision).toBe(0);
  });

  it('lets an owner who lost the agent turn it off, and nothing else', async () => {
    const made = (await create(await bind())).body as Subscription;
    access.mockResolvedValue('forbidden');
    const prompt = await request(app)
      .patch(`/subscriptions/${made.id}`)
      .send({ prompt: 'Something else.' });
    expect(prompt.status).toBe(403);
    const off = await request(app).patch(`/subscriptions/${made.id}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
  });

  it('leaves the grant behind on a content edit, and carries it on turning it off', async () => {
    const made = (await create(await bind())).body as Subscription;
    const identity: SubscriptionIdentity = {
      subscriptionId: made.id,
      ownerId: OWNER,
      tenantId: null,
      agentId: AGENT,
      invocationMode: 'delegated',
    };
    const committed = await storage.confirmRunGrant({
      identity,
      expectedConfigRevision: 0,
      expectedRevision: null,
      enrollment: {
        version: 1,
        scheduleRevision: 0,
        revision: 'grant-1',
        consents: [],
        everything: true,
        grantedAtMs: Date.now(),
        absoluteExpiresAtMs: Date.now() + 3_600_000,
      },
    });
    expect(committed).toBeTruthy();
    /** What the grant service reads to call a grant `changed`: it was made for another revision. */
    const behind = async () => {
      const snapshot = await storage.readRunGrant(identity);
      return snapshot?.enrollment?.scheduleRevision !== snapshot?.configRevision;
    };
    await request(app).patch(`/subscriptions/${made.id}`).send({ enabled: false });
    expect(await behind()).toBe(false);
    await request(app).patch(`/subscriptions/${made.id}`).send({ prompt: 'Something else.' });
    expect(await behind()).toBe(true);
  });
});

describe('the grant', () => {
  it("reads the caller's subscription's grant as that subscription", async () => {
    const made = (await create(await bind())).body as Subscription;
    const res = await request(app).get(`/subscriptions/${made.id}/grant`);
    expect(res.status).toBe(200);
    expect(view).toHaveBeenCalledWith({
      subscriptionId: made.id,
      ownerId: OWNER,
      tenantId: null,
      agentId: AGENT,
      invocationMode: 'delegated',
    });
  });
});

describe('deleting a subscription', () => {
  it("deletes the caller's own", async () => {
    const made = (await create(await bind())).body as Subscription;
    expect((await request(app).delete(`/subscriptions/${made.id}`)).status).toBe(204);
    expect(await stored()).toBe(0);
    expect((await request(app).delete(`/subscriptions/${made.id}`)).status).toBe(404);
  });
});

describe('a request with no user', () => {
  it('reads nothing and answers as if there were nothing', async () => {
    const res = await request(app).get('/subscriptions').set('x-anonymous', '1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'subscription_not_found' });
  });

  it('refuses a list filter that is not one agent id', async () => {
    for (const query of ['agentId=', 'agentId=a&agentId=b']) {
      const res = await request(app).get(`/subscriptions?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'subscription_invalid' });
    }
  });
});

describe('the connections an owner can pick', () => {
  it("lists the caller's tenant's, with nothing of the install beyond its account", async () => {
    const mine = await bind('tenant-a', '1');
    await bind('tenant-b', '2');
    const res = await request(app).get('/connections').set('x-tenant', 'tenant-a');
    expect(res.body).toEqual({
      connections: [{ id: mine, provider: 'github', account: 'acme', status: 'active' }],
    });
  });
});
