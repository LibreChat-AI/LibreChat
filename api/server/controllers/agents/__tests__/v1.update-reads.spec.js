const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { toUpdatableAgent, createAgentManagementUpdateHandler } = require('@librechat/api');
const {
  PermissionBits,
  PrincipalType,
  PrincipalModel,
  ResourceType,
} = require('librechat-data-provider');

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createModels, createMethods } = require('@librechat/data-schemas');
  createModels(mongoose);
  const methods = createMethods(mongoose);
  /** Wrapped so the count includes callers that destructured the method at load time. */
  return {
    ...methods,
    getAgent: jest.fn((...args) => methods.getAgent(...args)),
    getAgentWithVersionCount: jest.fn((...args) => methods.getAgentWithVersionCount(...args)),
  };
});

jest.mock('~/server/services/PermissionService', () => {
  const mongoose = require('mongoose');
  const { AccessControlService } = require('@librechat/api');
  const acl = new AccessControlService(mongoose);
  return {
    checkPermission: (args) => acl.checkPermission(args),
    findAccessibleResources: (args) => acl.findAccessibleResources(args),
    getResourcePermissionsMap: (args) => acl.getResourcePermissionsMap(args),
    findPubliclyAccessibleResources: jest.fn().mockResolvedValue([]),
    hasPublicPermission: jest.fn().mockResolvedValue(false),
    grantPermission: jest.fn(),
  };
});

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({ web_search: true }),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Files/images/avatar', () => ({ resizeAvatar: jest.fn() }));
jest.mock('~/server/services/Files/process', () => ({ filterFile: jest.fn() }));
jest.mock('~/config', () => ({ getMCPServersRegistry: jest.fn() }));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({ get: jest.fn(), set: jest.fn(), delete: jest.fn() })),
}));
jest.mock('~/server/services/Agents/instructionsPrompt', () => ({
  instructionsPromptAccess: {
    validateLinkWrite: async () => ({ ok: true }),
    presentForEditor: async ({ agent }) => agent,
  },
}));

const db = require('~/models');
const v1 = require('~/server/controllers/agents/v1');
const { checkPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const {
  canAccessAgentResource,
} = require('~/server/middleware/accessResources/canAccessAgentResource');

const tenantId = 'tenant-a';
let mongoServer;
let ownerId;
let agent;

/** Mirrors the PATCH /api/agents/:id chain in `routes/agents/v1.js`. */
function createPanelApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: ownerId, role: 'USER' };
    req.config = {};
    next();
  });
  app.patch(
    '/api/agents/:id',
    canAccessAgentResource({
      requiredPermission: PermissionBits.EDIT,
      resourceIdParam: 'id',
      includeVersions: true,
    }),
    v1.updateAgent,
  );
  return app;
}

/** Mirrors the update handler wiring in `routes/agents/management.js`. */
function createManagementApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: ownerId, role: 'USER', tenantId };
    req.config = {};
    next();
  });
  app.patch(
    '/api/agents/v1/agents/:id',
    createAgentManagementUpdateHandler({
      getRoleByName: db.getRoleByName,
      getAgentWithVersionCount: (search) =>
        db.getAgentWithVersionCount(search).then(toUpdatableAgent),
      checkPermission,
      hasCapability,
      updateAgent: v1.updateAgentForRequest,
    }),
  );
  return app;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await db.seedDefaultRoles();
  await db.initializeRoles();
  await mongoose.models.Role.updateOne(
    { name: 'USER' },
    { $set: { 'permissions.AGENTS.USE': true, 'permissions.AGENTS.CREATE': true } },
  );
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.models.Agent.deleteMany({});
  await mongoose.models.AclEntry.deleteMany({});
  ownerId = new mongoose.Types.ObjectId().toString();
  agent = (
    await mongoose.models.Agent.create({
      id: `agent_${new mongoose.Types.ObjectId()}`,
      name: 'Saved Agent',
      author: ownerId,
      provider: 'openAI',
      model: 'gpt-5',
      tenantId,
      tools: [],
      versions: [{ name: 'Saved Agent', provider: 'openAI', model: 'gpt-5' }],
    })
  ).toObject();
  await mongoose.models.AclEntry.create({
    principalType: PrincipalType.USER,
    principalModel: PrincipalModel.USER,
    principalId: new mongoose.Types.ObjectId(ownerId),
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    permBits: PermissionBits.VIEW | PermissionBits.EDIT,
  });
  db.getAgent.mockClear();
  db.getAgentWithVersionCount.mockClear();
});

describe('agent update reads', () => {
  it('reads the agent once on the side-panel route', async () => {
    const response = await request(createPanelApp())
      .patch(`/api/agents/${agent.id}`)
      .send({ name: 'Renamed' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: agent.id, name: 'Renamed', version: 2 });
    expect(response.body.versions).toHaveLength(2);
    expect(db.getAgent).toHaveBeenCalledTimes(1);
    expect(db.getAgentWithVersionCount).not.toHaveBeenCalled();
  });

  it('returns the full saved agent from the same read for an empty side-panel update', async () => {
    const response = await request(createPanelApp()).patch(`/api/agents/${agent.id}`).send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: agent.id, name: 'Saved Agent', version: 1 });
    expect(response.body.versions).toHaveLength(1);
    expect(db.getAgent).toHaveBeenCalledTimes(1);
  });

  it('reads the agent once on the Agent Management route', async () => {
    const response = await request(createManagementApp())
      .patch(`/api/agents/v1/agents/${agent.id}`)
      .send({ name: 'Managed Rename' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: agent.id, name: 'Managed Rename', version: 2 });
    expect(db.getAgentWithVersionCount).toHaveBeenCalledTimes(1);
    expect(db.getAgent).not.toHaveBeenCalled();
    expect((await mongoose.models.Agent.findOne({ id: agent.id }).lean()).name).toBe(
      'Managed Rename',
    );
  });
});
