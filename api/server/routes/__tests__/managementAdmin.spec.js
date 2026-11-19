/**
 * Management API clients on the admin group and resource share routes: the real routers,
 * capability checks, ACL services and models on mongodb-memory-server. Only the token
 * signature check and the browser session authenticator are replaced.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { tenantStorage, SystemCapabilities, SYSTEM_TENANT_ID } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ResourceType,
  PrincipalType,
  AccessRoleIds,
  ManagementAdminScopes,
} = require('librechat-data-provider');

/** checkBan assigns `req.ip`, which a bare Express 5 test app exposes as a getter only. */
process.env.BAN_VIOLATIONS = 'false';
process.env.TENANT_ISOLATION_STRICT = 'true';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const MACHINE_UA = 'lms-sync/1.0';

let mockAppConfig = {};

jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  getAppConfig: jest.fn(async () => mockAppConfig),
  invalidateConfigCaches: jest.fn(async () => undefined),
}));

jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = { config: {} };
  next();
});

/** Browser session stand-in: `x-test-session: <userId>` authenticates that user in its tenant. */
jest.mock('~/server/middleware/requireJwtAuth', () => {
  const sessionAuth = async (req, res, next) => {
    const userId = req.headers['x-test-session'];
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const mongooseLib = require('mongoose');
    const { tenantStorage: storage } = require('@librechat/data-schemas');
    const user = await storage.run(
      { tenantId: req.headers['x-test-tenant'] },
      async () => await mongooseLib.models.User.findById(userId).lean(),
    );
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.user = { ...user, id: String(user._id) };
    req.authStrategy = 'jwt';
    storage.run({ tenantId: user.tenantId }, () => next());
  };
  const passThrough = (_req, _res, next) => next();
  sessionAuth.requireRumProxyAuth = passThrough;
  sessionAuth.requireTermsAcceptance = passThrough;
  sessionAuth.requireTermsAcceptanceOnRead = passThrough;
  return sessionAuth;
});

/** Token `m2m:<clientId>` verifies as that client's client-credentials token; anything else fails. */
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  const verifyAccessToken = async (token) => {
    if (!token.startsWith('m2m:')) {
      throw new Error('invalid signature');
    }
    const clientId = token.slice(4);
    return { azp: clientId, sub: `${clientId}@clients`, exp: Math.floor(Date.now() / 1000) + 60 };
  };
  return {
    ...actual,
    createManagementAdminAuth: (deps) =>
      actual.createManagementAdminAuth({ ...deps, verifyAccessToken }),
  };
});

const db = require('~/models');

let mongoServer;
let app;
let svcA;
let weakA;
let memberA;
let adminB;
let groupB;
let agentA;
let agentB;

/** Runs `fn` and awaits its result inside the tenant context, so a returned query executes there. */
const inTenant = (tenantId, fn) => tenantStorage.run({ tenantId }, async () => await fn());

function setManagementConfig() {
  const binding = (clientId, user, adminScopes) => ({
    clientId,
    userId: String(user._id),
    tenantId: user.tenantId,
    enabled: true,
    ...(adminScopes ? { adminScopes } : {}),
  });
  mockAppConfig = {
    endpoints: {
      agents: {
        managementApi: {
          auth: {
            oidc: {
              enabled: true,
              issuer: 'https://issuer.example.com',
              audience: 'https://librechat.example.com',
            },
            clients: [
              binding('lms-a', svcA, [ManagementAdminScopes.GROUPS, ManagementAdminScopes.SHARES]),
              binding('lms-a-agents-only', svcA),
              binding('lms-a-weak', weakA, [ManagementAdminScopes.GROUPS]),
              binding('lms-a-access', svcA, [
                ManagementAdminScopes.ROLES,
                ManagementAdminScopes.GRANTS,
              ]),
            ],
          },
        },
      },
    },
  };
}

const machine = (method, url, clientId = 'lms-a') =>
  request(app)
    [method](url)
    .set('Authorization', `Bearer m2m:${clientId}`)
    .set('User-Agent', MACHINE_UA);

async function createUser(tenantId, name, role) {
  return inTenant(tenantId, () =>
    mongoose.models.User.create({
      name,
      email: `${name}@${tenantId}.example.com`,
      username: name,
      provider: 'local',
      role,
      tenantId,
    }),
  );
}

async function createAgent(tenantId, author, name) {
  return inTenant(tenantId, async () => {
    const agent = await db.createAgent({
      id: `agent_${new mongoose.Types.ObjectId().toString()}`,
      name,
      provider: 'openai',
      model: 'gpt-4o',
      author: author._id,
      tenantId,
    });
    return agent;
  });
}

function groupAcl(groupId, agent) {
  return inTenant(TENANT_A, () =>
    mongoose.models.AclEntry.find({
      principalType: PrincipalType.GROUP,
      principalId: new mongoose.Types.ObjectId(groupId),
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
    }).lean(),
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  require('~/db/models');
  await inTenant(SYSTEM_TENANT_ID, async () => {
    await db.seedDefaultRoles();
    await db.seedSystemGrants();
  });

  svcA = await createUser(TENANT_A, 'lms-service-a', SystemRoles.ADMIN);
  weakA = await createUser(TENANT_A, 'lms-reader-a', SystemRoles.USER);
  memberA = await createUser(TENANT_A, 'learner-a', SystemRoles.USER);
  adminB = await createUser(TENANT_B, 'admin-b', SystemRoles.ADMIN);
  await inTenant(TENANT_A, async () => {
    for (const capability of [SystemCapabilities.ACCESS_ADMIN, SystemCapabilities.READ_GROUPS]) {
      await db.grantCapability({
        principalType: PrincipalType.USER,
        principalId: weakA._id,
        capability,
        tenantId: TENANT_A,
      });
    }
  });
  groupB = await inTenant(TENANT_B, () =>
    db.createGroup({ name: 'Course B', source: 'local', memberIds: [] }),
  );
  agentA = await createAgent(TENANT_A, svcA, 'Pack agent A');
  agentB = await createAgent(TENANT_B, adminB, 'Pack agent B');
  setManagementConfig();

  app = express();
  app.use(express.json());
  app.use('/api/admin/groups', require('~/server/routes/admin/groups'));
  app.use('/api/admin/roles', require('~/server/routes/admin/roles'));
  app.use('/api/admin/grants', require('~/server/routes/admin/grants'));
  app.use('/api/permissions', require('~/server/routes/accessPermissions'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('management clients on /api/admin/groups', () => {
  it('creates a group, adds and removes a member idempotently, in the bound tenant', async () => {
    const created = await machine('post', '/api/admin/groups').send({ name: 'Course A' });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id ?? created.body.group._id;
    const stored = await inTenant(TENANT_A, () => mongoose.models.Group.findById(groupId).lean());
    expect(stored.tenantId).toBe(TENANT_A);

    for (let i = 0; i < 2; i++) {
      const added = await machine('post', `/api/admin/groups/${groupId}/members`).send({
        userId: String(memberA._id),
      });
      expect(added.status).toBe(200);
    }
    let group = await inTenant(TENANT_A, () => mongoose.models.Group.findById(groupId).lean());
    expect(group.memberIds.map(String)).toEqual([String(memberA.idOnTheSource ?? memberA._id)]);

    for (let i = 0; i < 2; i++) {
      const removed = await machine(
        'delete',
        `/api/admin/groups/${groupId}/members/${String(memberA._id)}`,
      );
      expect(removed.status).toBe(200);
    }
    group = await inTenant(TENANT_A, () => mongoose.models.Group.findById(groupId).lean());
    expect(group.memberIds).toHaveLength(0);
  });

  it('records machine writes in the audit log as a service actor', async () => {
    await machine('post', '/api/admin/groups').send({ name: 'Audited course' });
    const entry = await inTenant(TENANT_A, () =>
      mongoose.models.AuditLog.findOne({ action: 'group.created' }).sort({ seq: -1 }).lean(),
    );
    expect(entry.actor).toMatchObject({
      type: 'service',
      id: String(svcA._id),
      name: 'oauth-client:lms-a',
    });
    expect(entry.tenantId).toBe(TENANT_A);
  });

  it('returns 404 for a group of another tenant', async () => {
    const read = await machine('get', `/api/admin/groups/${groupB._id}`);
    expect(read.status).toBe(404);
    const add = await machine('post', `/api/admin/groups/${groupB._id}/members`).send({
      userId: String(memberA._id),
    });
    expect(add.status).toBe(404);
  });

  it('refuses a bound client without the groups scope with 403', async () => {
    const res = await machine('get', '/api/admin/groups', 'lms-a-agents-only');
    expect(res.status).toBe(403);
  });

  it('runs the capability checks against the bound user', async () => {
    const list = await machine('get', '/api/admin/groups', 'lms-a-weak');
    expect(list.status).toBe(200);
    const create = await machine('post', '/api/admin/groups', 'lms-a-weak').send({
      name: 'Not allowed',
    });
    expect(create.status).toBe(403);
  });

  it('keeps browser sessions on the session authenticator', async () => {
    const session = await request(app)
      .get('/api/admin/groups')
      .set('Authorization', 'Bearer browser-jwt')
      .set('x-test-session', String(svcA._id))
      .set('x-test-tenant', TENANT_A);
    expect(session.status).toBe(200);

    const anonymous = await request(app)
      .get('/api/admin/groups')
      .set('Authorization', 'Bearer browser-jwt');
    expect(anonymous.status).toBe(401);
  });
});

describe('management clients on /api/admin/roles and /api/admin/grants', () => {
  it('admits a client holding the roles and grants scopes', async () => {
    const roles = await machine('get', '/api/admin/roles', 'lms-a-access');
    expect(roles.status).toBe(200);
    const grants = await machine('get', '/api/admin/grants', 'lms-a-access');
    expect(grants.status).toBe(200);
  });

  it('refuses a client without the roles or grants scope with 403', async () => {
    const roles = await machine('get', '/api/admin/roles', 'lms-a');
    expect(roles.status).toBe(403);
    const grants = await machine('get', '/api/admin/grants', 'lms-a');
    expect(grants.status).toBe(403);
  });
});

describe('management clients on /api/permissions', () => {
  let courseGroupId;

  beforeAll(async () => {
    const created = await machine('post', '/api/admin/groups').send({ name: 'Course share' });
    courseGroupId = String(created.body.group.id ?? created.body.group._id);
  });

  const share = (agent, body, clientId) =>
    machine('put', `/api/permissions/${ResourceType.AGENT}/${agent._id}`, clientId).send(body);

  it('grants and revokes an agent share to a group idempotently', async () => {
    const grant = {
      updated: [
        { type: PrincipalType.GROUP, id: courseGroupId, accessRoleId: AccessRoleIds.AGENT_VIEWER },
      ],
      removed: [],
      public: false,
    };
    for (let i = 0; i < 2; i++) {
      const res = await share(agentA, grant);
      expect(res.status).toBe(200);
    }
    const granted = await groupAcl(courseGroupId, agentA);
    expect(granted).toHaveLength(1);
    expect(granted[0].tenantId).toBe(TENANT_A);

    const revoke = {
      updated: [],
      removed: [{ type: PrincipalType.GROUP, id: courseGroupId }],
      public: false,
    };
    for (let i = 0; i < 2; i++) {
      const res = await share(agentA, revoke);
      expect(res.status).toBe(200);
    }
    expect(await groupAcl(courseGroupId, agentA)).toHaveLength(0);
  });

  it('cannot share an agent of another tenant', async () => {
    const res = await share(agentB, {
      updated: [
        { type: PrincipalType.GROUP, id: courseGroupId, accessRoleId: AccessRoleIds.AGENT_VIEWER },
      ],
      removed: [],
      public: false,
    });
    expect(res.status).toBe(404);
  });

  it('cannot share to a group of another tenant', async () => {
    const res = await share(agentA, {
      updated: [
        {
          type: PrincipalType.GROUP,
          id: String(groupB._id),
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        },
      ],
      removed: [],
      public: false,
    });
    /** As for a session, the share service resolves principals in the request tenant only, so
     * the foreign group is dropped and nothing is written for it in any tenant. */
    expect(res.status).toBe(200);
    expect(res.body.results.principals).toEqual([]);
    const anyTenant = await inTenant(SYSTEM_TENANT_ID, () =>
      mongoose.models.AclEntry.find({ principalId: groupB._id }).lean(),
    );
    expect(anyTenant).toHaveLength(0);
  });

  it('refuses a bound client without the shares scope with 403', async () => {
    const res = await share(agentA, { updated: [], removed: [], public: false }, 'lms-a-weak');
    expect(res.status).toBe(403);
  });

  it('refuses principal search and effective-permission reads to management clients', async () => {
    const search = await machine('get', '/api/permissions/search-principals?q=learner');
    expect(search.status).toBe(403);
    const effective = await machine('get', `/api/permissions/${ResourceType.AGENT}/effective/all`);
    expect(effective.status).toBe(403);
  });
});
