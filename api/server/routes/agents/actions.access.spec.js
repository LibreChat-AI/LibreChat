const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const mongoSanitize = require('express-mongo-sanitize');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { encryptV2 } = require('@librechat/data-schemas');
const { AccessControlService, MCPServersRegistry } = require('@librechat/api');
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
  return createMethods(mongoose);
});

jest.mock('~/server/services/PermissionService', () => {
  const mongoose = require('mongoose');
  const { AccessControlService } = require('@librechat/api');
  const acl = new AccessControlService(mongoose);
  return {
    checkPermission: (args) => acl.checkPermission(args),
    findAccessibleResources: (args) => acl.findAccessibleResources(args),
    getResourcePermissionsMap: (args) => acl.getResourcePermissionsMap(args),
  };
});

jest.mock('~/server/middleware', () =>
  jest.requireActual('~/server/middleware/accessResources/canAccessAgentResource'),
);
jest.mock('~/config', () => ({ getActionFlowStateManager: jest.fn() }));
jest.mock('~/cache', () => {
  const values = new Map();
  return {
    getLogStores: () => ({
      get: async (key) => values.get(key),
      set: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    }),
  };
});
jest.mock('~/server/services/Agents/instructionsPrompt', () => ({
  instructionsPromptAccess: { presentForEditor: async ({ agent }) => agent },
}));

const db = require('~/models');
const router = require('./actions');
let mongoServer;
let acl;
let actorId;
let ownerId;
let agent;
let serverName;
let app;

async function grantAgent(agentId, userId) {
  await mongoose.models.AclEntry.create({
    principalType: PrincipalType.USER,
    principalModel: PrincipalModel.USER,
    principalId: new mongoose.Types.ObjectId(userId),
    resourceType: ResourceType.AGENT,
    resourceId: agentId,
    permBits: 15,
  });
}

const postAction = (domain, agentId = agent.id) =>
  request(app)
    .post(`/api/agents/actions/${agentId}`)
    .send({ functions: [{ function: { name: 'lookup' } }], metadata: { domain } });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await db.seedDefaultRoles();
  await db.initializeRoles();
  await mongoose.models.Role.updateOne(
    { name: 'USER' },
    { $set: { 'permissions.AGENTS.USE': true, 'permissions.AGENTS.CREATE': true } },
  );
  acl = new AccessControlService(mongoose);
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  for (const model of ['Agent', 'MCPServer', 'Action', 'AclEntry', 'User']) {
    await mongoose.models[model].deleteMany({});
  }
  actorId = new mongoose.Types.ObjectId().toString();
  ownerId = new mongoose.Types.ObjectId().toString();
  serverName = 'pay';
  await mongoose.models.User.create([
    { _id: actorId, email: `${actorId}@example.test`, role: 'USER', provider: 'local' },
    { _id: ownerId, email: `${ownerId}@example.test`, role: 'USER', provider: 'local' },
  ]);
  agent = await db.createAgent({
    id: `agent_${new mongoose.Types.ObjectId()}`,
    name: 'Actor agent',
    author: actorId,
    provider: 'test',
    model: 'test-model',
    tools: [],
  });
  await grantAgent(agent._id, actorId);
  await mongoose.models.MCPServer.create({
    serverName,
    author: ownerId,
    config: {
      type: 'sse',
      url: 'https://private.example.test/mcp',
      apiKey: {
        source: 'admin',
        authorization_type: 'bearer',
        key: await encryptV2('fixture-owner-secret'),
      },
    },
  });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', { value: req.query, writable: true });
    next();
  });
  app.use(mongoSanitize());
  /** Session identity is the fixture; the route's role and resource ACL checks are real. */
  app.use((req, _res, next) => {
    req.user = { id: actorId, role: 'USER' };
    req.config = { filters: {} };
    next();
  });
  app.use('/api/agents/actions', router);
});

describe('Action writes and agent-mediated MCP access', () => {
  it('does not grant an unrelated private MCP server through an Action key', async () => {
    const privateServer = await mongoose.models.MCPServer.findOne({ serverName });
    expect(
      await acl.checkPermission({
        userId: actorId,
        role: 'USER',
        resourceType: ResourceType.MCPSERVER,
        resourceId: privateServer._id,
        requiredPermission: PermissionBits.VIEW,
      }),
    ).toBe(false);

    const response = await postAction(`x_mcp_${serverName}`);
    expect(response.status).toBe(200);
    const stored = await db.getAgent({ id: agent.id });
    expect(stored.tools).toContain(`lookup_action_x_mcp_${serverName}`);
    const registry = new MCPServersRegistry(mongoose);
    expect(await registry.getAllServerConfigs(actorId, undefined, 'USER')).not.toHaveProperty(
      serverName,
    );
    expect(stored.mcpServerNames).toEqual([]);
  });

  it('preserves an existing MCP grant across Action creation and deletion', async () => {
    await db.updateAgent(
      { id: agent.id },
      { tools: [`get_action_version_mcp_${serverName}`], mcpServerNames: [serverName] },
    );
    const response = await postAction('https://api.example.test');
    expect(response.status).toBe(200);
    const registry = new MCPServersRegistry(mongoose);
    expect(
      (await registry.getAllServerConfigs(actorId, undefined, 'USER'))[serverName],
    ).toMatchObject({ consumeOnly: true });

    const action = await mongoose.models.Action.findOne({ agent_id: agent.id });
    const deleted = await request(app).delete(
      `/api/agents/actions/${agent.id}/${action.action_id}`,
    );
    expect(deleted.status).toBe(200);
    expect((await db.getAgent({ id: agent.id })).mcpServerNames).toEqual([serverName]);
  });

  it('encodes long Action domains instead of preserving a crafted MCP suffix', async () => {
    const response = await postAction('x_mcp_private-payments-server');
    expect(response.status).toBe(200);
    const stored = await db.getAgent({ id: agent.id });
    expect(stored.tools[0]).not.toContain('_mcp_');
    expect(stored.mcpServerNames).toEqual([]);
  });

  it('does not allow an actor to write an Action on an unshared agent', async () => {
    const other = await db.createAgent({
      id: `agent_${new mongoose.Types.ObjectId()}`,
      name: 'Other agent',
      author: ownerId,
      provider: 'test',
      model: 'test-model',
      tools: [],
    });
    await grantAgent(other._id, ownerId);
    const response = await postAction(`x_mcp_${serverName}`, other.id);
    expect(response.status).toBe(403);
    expect(await mongoose.models.Action.countDocuments({ agent_id: other.id })).toBe(0);
  });

  it('does not save an Action after a conflicting agent write', async () => {
    const write = jest.spyOn(db, 'updateAgent').mockRejectedValueOnce({ statusCode: 409 });
    try {
      const response = await postAction('https://api.example.test');
      expect(response.status).toBe(409);
      expect(await mongoose.models.Action.countDocuments({ agent_id: agent.id })).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('does not delete an Action after a conflicting agent write', async () => {
    expect((await postAction('https://api.example.test')).status).toBe(200);
    const action = await mongoose.models.Action.findOne({ agent_id: agent.id });
    const write = jest.spyOn(db, 'updateAgent').mockRejectedValueOnce({ statusCode: 409 });
    try {
      const response = await request(app).delete(
        `/api/agents/actions/${agent.id}/${action.action_id}`,
      );
      expect(response.status).toBe(409);
      expect(await mongoose.models.Action.countDocuments({ agent_id: agent.id })).toBe(1);
    } finally {
      write.mockRestore();
    }
  });
});
