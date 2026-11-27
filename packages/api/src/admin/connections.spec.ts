import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, tenantStorage, createConnections } from '@librechat/data-schemas';
import type { RecordAuditEntryInput, Connections, IUser } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { AdminConnectionDeps, EventsConfigSource } from './connections';
import type { PullRequestFetch } from '~/pulls/shared';
import { createAdminConnectionHandlers, INGRESS_PATH } from './connections';

const DB_SETUP_TIMEOUT_MS = 60_000;
const ADMIN = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const TENANT = 'tenant-a';
const STRANGER = 'tenant-b';
const INSTALLATION = 4400;
const START = Date.UTC(2026, 10, 24, 12, 0, 0);
const SECRET = 'state-secret-91d2';
const WEBHOOK = 'webhook-secret-3a7f';
const CLIENT_SECRET = 'client-secret-6b0e';
const USER_TOKEN = 'ghu_usertoken77c4';
const CODE = 'code1f2e3d';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const KEY_BODY = KEY.split('\n')[1];

const ENV = {
  JWT_SECRET: SECRET,
  DOMAIN_SERVER: 'https://chat.example.com/',
  EVENTS_APP_ID: 'Iv1.example',
  EVENTS_APP_KEY: KEY,
  EVENTS_WEBHOOK_SECRET: WEBHOOK,
  EVENTS_CLIENT_ID: 'Iv23.client',
  EVENTS_CLIENT_SECRET: CLIENT_SECRET,
};
const CONFIG: EventsConfigSource = {
  endpoints: {
    agents: {
      events: {
        enabled: true,
        github: {
          appId: '${EVENTS_APP_ID}',
          privateKey: '${EVENTS_APP_KEY}',
          webhookSecret: '${EVENTS_WEBHOOK_SECRET}',
          clientId: '${EVENTS_CLIENT_ID}',
          clientSecret: '${EVENTS_CLIENT_SECRET}',
        },
      },
    },
  },
};

let server: MongoMemoryServer;
let connections: Connections;
let time: number;
let audit: jest.Mock<Promise<unknown>, [RecordAuditEntryInput, unknown?]>;
let github: jest.Mock<globalThis.Response | Promise<globalThis.Response>, [string]>;
let calls: string[];

function json(body: unknown, status = 200): globalThis.Response {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GitHub as the app sees it: its page, the installations it holds, the token endpoint that
 * redeems the admin's code, and the installations that admin can access (`mine`), a hundred to
 * a page.
 */
function gitHub(installations: Record<number, unknown> = {}, mine: number[] = [INSTALLATION]) {
  return (url: string): globalThis.Response => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/app') return json({ html_url: 'https://github.com/apps/example-events' });
    if (path === '/login/oauth/access_token') {
      return json({ access_token: USER_TOKEN, token_type: 'bearer' });
    }
    if (path === '/user/installations') {
      const page = Number(parsed.searchParams.get('page'));
      const ids = mine.slice((page - 1) * 100, page * 100);
      return json({ total_count: mine.length, installations: ids.map((id) => ({ id })) });
    }
    const found = /^\/app\/installations\/(\d+)$/.exec(path);
    const installation = found ? installations[Number(found[1])] : undefined;
    return installation ? json(installation) : json({ message: 'Not Found' }, 404);
  };
}

const installed = (login = 'example-org', suspended = false) => ({
  id: INSTALLATION,
  account: { id: 9001, login },
  suspended_at: suspended ? '2026-11-20T00:00:00Z' : null,
});

function build(overrides: Partial<AdminConnectionDeps> = {}): express.Express {
  const fetch: PullRequestFetch = async (input) => {
    calls.push(input);
    return (await github(input)) as unknown as globalThis.Response;
  };
  const handlers = createAdminConnectionHandlers({
    connections,
    getAppConfig: async () => CONFIG,
    env: ENV,
    fetch,
    recordAuditEntry: audit,
    auditFailClosed: true,
    now: () => time,
    ...overrides,
  });
  const app = express();
  app.use(express.json());
  // Each request acts as the admin its headers name, in the tenant the app would scope it to.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const tenantId = req.header('x-tenant') ?? TENANT;
    (req as Request & { user: Partial<IUser> }).user = {
      id: req.header('x-user') ?? ADMIN,
      role: 'ADMIN',
      ...(tenantId && { tenantId }),
    };
    if (tenantId) tenantStorage.run({ tenantId }, next);
    else next();
  });
  const as = (handler: unknown) => handler as express.RequestHandler;
  app.get('/connections', as(handlers.list));
  app.post('/connections/install', as(handlers.install));
  app.post('/connections', as(handlers.bind));
  app.patch('/connections/:id', as(handlers.mark));
  app.delete('/connections/:id', as(handlers.remove));
  return app;
}

/** Starts an install as `user` and returns the state its link carries. */
async function start(app: express.Express, user = ADMIN, tenant = TENANT): Promise<string> {
  const res = await request(app)
    .post('/connections/install')
    .set('x-user', user)
    .set('x-tenant', tenant);
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get('state') ?? '';
}

const stored = () => mongoose.models.AgentEventConnection.find({}).lean();
const actions = () => audit.mock.calls.map(([entry]) => [entry.action, entry.outcome]);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  connections = createConnections(mongoose);
  await mongoose.models.AgentEventConnection?.deleteMany({});
  time = START;
  calls = [];
  audit = jest.fn<Promise<unknown>, [RecordAuditEntryInput, unknown?]>(async () => undefined);
  github = jest.fn(gitHub({ [INSTALLATION]: installed() }));
});

describe('starting an install', () => {
  it("links to the app's install page with a state for this admin and tenant", async () => {
    const res = await request(build()).post('/connections/install');
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/apps/example-events/installations/new',
    );
    const claims = jwt.verify(url.searchParams.get('state') ?? '', SECRET, {
      audience: 'agent-events-install',
      clockTimestamp: Math.floor(START / 1000),
    }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ sub: ADMIN, tenant: TENANT });
    expect(claims.exp! - claims.iat!).toBe(600);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<AdminConnectionDeps>]>([
    ['events are off', { getAppConfig: async () => ({}) }],
    ['the app does not resolve', { env: { ...ENV, EVENTS_APP_KEY: undefined } }],
    ['no secret signs states', { env: { ...ENV, JWT_SECRET: undefined } }],
  ])('answers not configured when %s, asking GitHub nothing', async (_label, overrides) => {
    const res = await request(build(overrides)).post('/connections/install');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Agent events are not configured',
      code: 'CONNECTION_NOT_CONFIGURED',
    });
    expect(calls).toHaveLength(0);
  });

  it('answers a refusal of the app as refused, and an outage as unavailable', async () => {
    github.mockImplementation(() => json({ message: 'Bad credentials' }, 401));
    let res = await request(build()).post('/connections/install');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CONNECTION_APP_REFUSED');
    github.mockImplementation(() => {
      throw new Error(`connect ECONNREFUSED ${KEY_BODY}`);
    });
    res = await request(build()).post('/connections/install');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'GitHub is not reachable',
      code: 'CONNECTION_GITHUB_UNAVAILABLE',
    });
  });
});

describe('binding an installation', () => {
  it("binds the app's installation to the caller's tenant and audits it", async () => {
    const app = build();
    const state = await start(app);
    const res = await request(app)
      .post('/connections')
      .send({ installation: String(INSTALLATION), state, code: CODE });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^conn_/),
      provider: 'github',
      installation: String(INSTALLATION),
      account: { id: '9001', name: 'example-org' },
      status: 'active',
      createdBy: ADMIN,
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, installation: String(INSTALLATION) });
    expect(calls[calls.length - 1]).toBe(
      `https://api.github.com/app/installations/${INSTALLATION}`,
    );
    expect(actions()).toEqual([
      ['event_connection.bound', 'pending'],
      ['event_connection.bound', 'success'],
    ]);
    expect(audit.mock.calls[0][0]).toMatchObject({
      target: { type: 'event_connection', id: String(INSTALLATION), name: 'example-org' },
      tenantId: TENANT,
    });
  });

  it('accepts the id as a number, as a Setup URL query read by a client may give it', async () => {
    const app = build();
    const state = await start(app);
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state, code: CODE });
    expect(res.status).toBe(201);
  });

  it('records a suspended installation as suspended', async () => {
    github.mockImplementation(gitHub({ [INSTALLATION]: installed('example-org', true) }));
    const app = build();
    const state = await start(app);
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state, code: CODE });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('suspended');
    expect((await stored())[0].status).toBe('suspended');
  });

  it('binds the same installation again as a refresh, keeping its id', async () => {
    const app = build();
    const first = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });
    github.mockImplementation(gitHub({ [INSTALLATION]: installed('renamed-org') }));
    const again = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.account.name).toBe('renamed-org');
    expect(await stored()).toHaveLength(1);
  });

  it('never rebinds an installation another tenant holds', async () => {
    const app = build();
    await request(app)
      .post('/connections')
      .set('x-tenant', STRANGER)
      .send({ installation: INSTALLATION, state: await start(app, ADMIN, STRANGER), code: CODE })
      .expect(201);
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Installation is bound elsewhere',
      code: 'CONNECTION_TAKEN',
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(STRANGER);
    expect(actions().slice(-2)).toEqual([
      ['event_connection.bound', 'pending'],
      ['event_connection.bound', 'failure'],
    ]);
  });

  it("refuses an installation GitHub does not report as this app's", async () => {
    // The account can reach installation 77, but it is not one of this app's.
    github.mockImplementation(gitHub({ [INSTALLATION]: installed() }, [77]));
    const app = build();
    const state = await start(app);
    const res = await request(app)
      .post('/connections')
      .send({ installation: 77, state, code: CODE });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONNECTION_INSTALLATION_NOT_FOUND');
    expect(await stored()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  describe('refuses a state the caller did not start', () => {
    const refused = async (
      app: express.Express,
      state: string,
      headers: Record<string, string> = {},
    ) => {
      const res = await request(app)
        .post('/connections')
        .set(headers)
        .send({ installation: INSTALLATION, state, code: CODE });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'Install state is not valid for this admin',
        code: 'CONNECTION_STATE_INVALID',
      });
      expect(await stored()).toHaveLength(0);
      expect(calls.filter((url) => url.includes('/installations/'))).toHaveLength(0);
    };

    it("another admin's", async () => {
      expect.hasAssertions();
      const app = build();
      await refused(app, await start(app, OTHER));
    });

    it("another tenant's", async () => {
      expect.hasAssertions();
      const app = build();
      await refused(app, await start(app, ADMIN, STRANGER));
    });

    it('an expired one', async () => {
      expect.hasAssertions();
      const app = build();
      const state = await start(app);
      time += 601_000;
      await refused(app, state);
    });

    it('one signed with another secret, or for another purpose', async () => {
      expect.hasAssertions();
      const app = build();
      const claims = { sub: ADMIN, tenant: TENANT, nonce: 'n' };
      const iat = Math.floor(START / 1000);
      await refused(
        app,
        jwt.sign({ ...claims, iat }, 'other', { audience: 'agent-events-install', expiresIn: 600 }),
      );
      await refused(
        app,
        jwt.sign({ ...claims, iat }, SECRET, { audience: 'pull-request-oauth', expiresIn: 600 }),
      );
      await refused(app, jwt.sign({ ...claims, iat }, SECRET, { expiresIn: 600 }));
    });

    it('one whose signature was altered', async () => {
      expect.hasAssertions();
      const app = build();
      const [head, body] = (await start(app)).split('.');
      await refused(app, `${head}.${body}.${'A'.repeat(43)}`);
    });
  });

  it.each([
    [{ installation: 'abc', state: 'x.y.z' }],
    [{ installation: '0', state: 'x.y.z' }],
    [{ installation: '1e3', state: 'x.y.z' }],
    [{ installation: String(INSTALLATION) }],
    [{ installation: String(INSTALLATION), state: 'x.y.z' }],
    [{}],
  ])('refuses a request that does not read: %j', async (body) => {
    const res = await request(build()).post('/connections').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONNECTION_INVALID');
  });

  it('binds nothing when the audit entry cannot be written and auditing fails closed', async () => {
    const app = build();
    const state = await start(app);
    audit.mockRejectedValueOnce(new Error('audit store down'));
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state, code: CODE });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CONNECTION_AUDIT_UNAVAILABLE');
    expect(await stored()).toHaveLength(0);
  });
});

describe('listing, suspending and removing', () => {
  async function bound(tenant = TENANT): Promise<string> {
    const app = build();
    const res = await request(app)
      .post('/connections')
      .set('x-tenant', tenant)
      .send({ installation: INSTALLATION, state: await start(app, ADMIN, tenant), code: CODE });
    expect(res.status).toBe(201);
    audit.mockClear();
    return res.body.id as string;
  }

  it("lists the caller's tenant's connections with the webhook URL to register", async () => {
    await bound(STRANGER);
    let res = await request(build()).get('/connections');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connections: [],
      ingress: `https://chat.example.com${INGRESS_PATH}`,
      configured: true,
    });
    res = await request(build()).get('/connections').set('x-tenant', STRANGER);
    expect(res.body.connections).toEqual([
      expect.objectContaining({ installation: String(INSTALLATION), status: 'active' }),
    ]);
    expect(res.body.connections[0]).not.toHaveProperty('tenantId');
  });

  it('says when an install cannot start', async () => {
    const res = await request(build({ env: { ...ENV, JWT_SECRET: undefined } })).get(
      '/connections',
    );
    expect(res.body.configured).toBe(false);
    expect(res.body.ingress).toBe(`https://chat.example.com${INGRESS_PATH}`);
  });

  it('suspends and resumes a connection, auditing each change but not a no-op', async () => {
    const id = await bound();
    const app = build();
    let res = await request(app).patch(`/connections/${id}`).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
    res = await request(app).patch(`/connections/${id}`).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    res = await request(app).patch(`/connections/${id}`).send({ status: 'active' });
    expect(res.body.status).toBe('active');
    expect(actions()).toEqual([
      ['event_connection.suspended', 'pending'],
      ['event_connection.suspended', 'success'],
      ['event_connection.resumed', 'pending'],
      ['event_connection.resumed', 'success'],
    ]);
  });

  it('removes a connection', async () => {
    const id = await bound();
    const res = await request(build()).delete(`/connections/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, removed: true });
    expect(await stored()).toHaveLength(0);
    expect(actions()).toEqual([
      ['event_connection.removed', 'pending'],
      ['event_connection.removed', 'success'],
    ]);
  });

  it("answers another tenant's connection as missing and changes nothing", async () => {
    const id = await bound(STRANGER);
    const app = build();
    let res = await request(app).patch(`/connections/${id}`).send({ status: 'suspended' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONNECTION_NOT_FOUND');
    res = await request(app).delete(`/connections/${id}`);
    expect(res.status).toBe(404);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses an id or a status that does not read', async () => {
    const id = await bound();
    const app = build();
    let res = await request(app).patch('/connections/not-an-id').send({ status: 'suspended' });
    expect(res.status).toBe(400);
    res = await request(app).patch(`/connections/${id}`).send({ status: 'paused' });
    expect(res.status).toBe(400);
    res = await request(app).delete('/connections/conn_x');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONNECTION_INVALID');
  });
});

describe("GitHub's proof that the admin can access the installation", () => {
  const bindWith = async (app: express.Express) =>
    request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });

  it('refuses an installation of the app the authorizing account cannot access, binding nothing', async () => {
    github.mockImplementation(gitHub({ [INSTALLATION]: installed() }, [77, 78]));
    const res = await bindWith(build());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Installation is not accessible to this GitHub account',
      code: 'CONNECTION_NOT_ACCESSIBLE',
    });
    expect(await stored()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(calls).not.toContain(`https://api.github.com/app/installations/${INSTALLATION}`);
  });

  it('redeems the code on the app host and asks as that account, page by page', async () => {
    const mine = Array.from({ length: 150 }, (_, index) => 10_000 + index);
    mine[120] = INSTALLATION;
    github.mockImplementation(gitHub({ [INSTALLATION]: installed() }, mine));
    const res = await bindWith(build());
    expect(res.status).toBe(201);
    expect(calls).toEqual(
      expect.arrayContaining([
        'https://github.com/login/oauth/access_token',
        'https://api.github.com/user/installations?per_page=100&page=1',
        'https://api.github.com/user/installations?per_page=100&page=2',
      ]),
    );
  });

  it('stops after the last page without finding it', async () => {
    const mine = Array.from({ length: 230 }, (_, index) => 10_000 + index);
    github.mockImplementation(gitHub({ [INSTALLATION]: installed() }, mine));
    const res = await bindWith(build());
    expect(res.status).toBe(403);
    expect(calls.filter((url) => url.includes('/user/installations'))).toHaveLength(3);
  });

  it('answers a code GitHub will not redeem as invalid', async () => {
    github.mockImplementation((url: string) =>
      url.endsWith('/login/oauth/access_token')
        ? json({ error: 'bad_verification_code', error_description: USER_TOKEN })
        : gitHub({ [INSTALLATION]: installed() })(url),
    );
    const res = await bindWith(build());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Authorization code is not valid',
      code: 'CONNECTION_CODE_INVALID',
    });
    expect(await stored()).toHaveLength(0);
  });

  it('answers an outage of the code exchange as unavailable', async () => {
    github.mockImplementation((url: string) => {
      if (url.endsWith('/login/oauth/access_token')) throw new Error(`reset ${CLIENT_SECRET}`);
      return gitHub({ [INSTALLATION]: installed() })(url);
    });
    const res = await bindWith(build());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CONNECTION_GITHUB_UNAVAILABLE');
    expect(await stored()).toHaveLength(0);
  });

  it('is not configured without the OAuth client, so no install starts and nothing binds', async () => {
    const env = { ...ENV, EVENTS_CLIENT_SECRET: undefined };
    let res = await request(build({ env })).post('/connections/install');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECTION_NOT_CONFIGURED');
    res = await request(build({ env }))
      .post('/connections')
      .send({ installation: INSTALLATION, state: 'x.y.z', code: CODE });
    expect(res.status).toBe(409);
    res = await request(build({ env })).get('/connections');
    expect(res.body.configured).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('offers a link that authorizes the app alone, with the same state', async () => {
    const res = await request(build()).post('/connections/install');
    const install = new URL(res.body.url);
    const authorize = new URL(res.body.authorize);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorize.searchParams.get('client_id')).toBe('Iv23.client');
    expect(authorize.searchParams.get('state')).toBe(install.searchParams.get('state'));
  });
});

describe('failures', () => {
  async function bound(): Promise<string> {
    const app = build();
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });
    expect(res.status).toBe(201);
    audit.mockClear();
    return res.body.id as string;
  }

  it('answers GitHub rate limiting as unavailable, with the wait it asked for', async () => {
    github.mockImplementation(
      () => new globalThis.Response('{}', { status: 429, headers: { 'retry-after': '42' } }),
    );
    const res = await request(build()).post('/connections/install');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CONNECTION_GITHUB_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('42');
  });

  it('refuses a state that is not a token, and binds while unconfigured never', async () => {
    let res = await request(build())
      .post('/connections')
      .send({ installation: INSTALLATION, state: 'not-a-token', code: CODE });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONNECTION_STATE_INVALID');
    res = await request(build({ getAppConfig: async () => ({}) }))
      .post('/connections')
      .send({ installation: INSTALLATION, state: 'x.y.z', code: CODE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECTION_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('answers a request with no user as unauthenticated', async () => {
    const handlers = createAdminConnectionHandlers({
      connections,
      getAppConfig: async () => CONFIG,
      env: ENV,
      fetch: async () => {
        throw new Error('not asked');
      },
    });
    const app = express();
    app.get('/connections', handlers.list as unknown as express.RequestHandler);
    const res = await request(app).get('/connections');
    expect(res.status).toBe(401);
  });

  it("records a failed write's outcome and answers without the store's words", async () => {
    const app = build({
      connections: {
        ...connections,
        bind: async () => {
          throw new Error(`write failed ${KEY_BODY}`);
        },
      },
    });
    const res = await request(app)
      .post('/connections')
      .send({ installation: INSTALLATION, state: await start(app), code: CODE });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to bind the installation' });
    expect(actions()).toEqual([
      ['event_connection.bound', 'pending'],
      ['event_connection.bound', 'failure'],
    ]);
  });

  it('suspends and removes nothing when the audit entry cannot be written', async () => {
    const id = await bound();
    const app = build();
    audit.mockRejectedValueOnce(new Error('audit store down'));
    let res = await request(app).patch(`/connections/${id}`).send({ status: 'suspended' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CONNECTION_AUDIT_UNAVAILABLE');
    audit.mockRejectedValueOnce(new Error('audit store down'));
    res = await request(app).delete(`/connections/${id}`);
    expect(res.status).toBe(500);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('answers a connection removed between the read and the write as missing', async () => {
    const id = await bound();
    const app = build({
      connections: { ...connections, remove: async () => false, mark: async () => null },
    });
    let res = await request(app).delete(`/connections/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONNECTION_NOT_FOUND');
    res = await request(app).patch(`/connections/${id}`).send({ status: 'suspended' });
    expect(res.status).toBe(404);
    expect(actions()).toEqual([
      ['event_connection.removed', 'pending'],
      ['event_connection.removed', 'failure'],
      ['event_connection.suspended', 'pending'],
      ['event_connection.suspended', 'failure'],
    ]);
  });
});

describe('disclosure', () => {
  it("never answers with the app's key, its token, the webhook secret or GitHub's words", async () => {
    const app = build();
    const bodies: string[] = [];
    const record = (res: request.Response) =>
      bodies.push(JSON.stringify(res.body), JSON.stringify(res.headers));
    record(await request(app).get('/connections'));
    const install = await request(app).post('/connections/install');
    record(install);
    const state = new URL(install.body.url).searchParams.get('state') ?? '';
    record(
      await request(app)
        .post('/connections')
        .send({ installation: INSTALLATION, state, code: CODE }),
    );
    github.mockImplementation(() => json({ message: `Bad credentials ${KEY_BODY}` }, 401));
    record(await request(app).post('/connections/install'));
    github.mockImplementation(() => json({ message: KEY_BODY }, 500));
    record(await request(app).post('/connections/install'));
    const text = bodies.join('\n');
    for (const secret of [
      KEY_BODY,
      WEBHOOK,
      SECRET,
      CLIENT_SECRET,
      USER_TOKEN,
      'Bad credentials',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{100,}/);
  });

  it("never logs the user's token, the client secret or the app's key", async () => {
    const spies = (['error', 'warn', 'info', 'debug'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => logger),
    );
    try {
      const app = build();
      await request(app)
        .post('/connections')
        .send({ installation: INSTALLATION, state: await start(app), code: CODE })
        .expect(201);
      github.mockImplementation((url: string) => {
        if (url.endsWith('/login/oauth/access_token')) {
          throw new Error(`reset ${CLIENT_SECRET} ${USER_TOKEN} ${KEY_BODY}`);
        }
        return gitHub({ [INSTALLATION]: installed() })(url);
      });
      await request(app)
        .post('/connections')
        .send({ installation: INSTALLATION, state: await start(app), code: CODE })
        .expect(503);
      const store = build({
        connections: {
          ...connections,
          bind: async () => {
            throw new Error(`write failed ${USER_TOKEN} ${CLIENT_SECRET}`);
          },
        },
      });
      github.mockImplementation(gitHub({ [INSTALLATION]: installed() }));
      await request(store)
        .post('/connections')
        .send({ installation: INSTALLATION, state: await start(store), code: CODE })
        .expect(500);
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toBe('[]');
      for (const secret of [USER_TOKEN, CLIENT_SECRET, KEY_BODY, SECRET, CODE]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
