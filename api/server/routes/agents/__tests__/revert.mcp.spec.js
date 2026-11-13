/** Short registry memo so a test can observe access after it would have expired. */
process.env.MCP_REGISTRY_CACHE_TTL = '50';
const waitForRegistryCache = () => new Promise((resolve) => setTimeout(resolve, 100));

/** The shared jest setup stubs `~/config`; the route must reach the real MCP registry. */
jest.mock('~/config', () => jest.requireActual('~/config'));
jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  getAppConfig: jest.fn().mockResolvedValue({}),
  getCachedTools: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MCPServersRegistry } = require('@librechat/api');
const { createModels, createMethods } = require('@librechat/data-schemas');
const {
  Constants,
  SystemRoles,
  ResourceType,
  PrincipalType,
  AccessRoleIds,
} = require('librechat-data-provider');

describe('POST /agents/:id/revert - MCP server authorization', () => {
  let app;
  let mongoServer;
  let methods;
  let registry;
  let grantPermission;
  let alice;
  let bob;
  let currentUser;

  const asUser = (user) => ({ id: user._id.toString(), role: SystemRoles.USER });
  const mcpTool = (serverName) => `search${Constants.mcp_delimiter}${serverName}`;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Object.assign(mongoose.models, createModels(mongoose));
    methods = createMethods(mongoose);
    await methods.seedDefaultRoles();
    registry = MCPServersRegistry.createInstance(mongoose, null, null);
    ({ grantPermission } = require('~/server/services/PermissionService'));

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = currentUser;
      next();
    });
    app.use('/agents', require('~/server/routes/agents/v1').v1);
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    const { User, Agent, AclEntry, MCPServer } = mongoose.models;
    await Promise.all([
      User.deleteMany({}),
      Agent.deleteMany({}),
      AclEntry.deleteMany({}),
      MCPServer.deleteMany({}),
    ]);
    alice = await User.create({ username: 'alice', email: 'alice@test.com' });
    bob = await User.create({ username: 'bob', email: 'bob@test.com' });
  });

  /** Alice owns a private DB MCP server; Bob has no grant on it. */
  async function createPrivateServer() {
    const server = await methods.createMCPServer({
      config: { title: 'Secret DB', type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      author: alice._id,
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: alice._id,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: alice._id,
    });
    return server.serverName;
  }

  /** Alice owns the agent and shares EDIT with Bob. */
  async function shareAgent(agent) {
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: alice._id,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: alice._id,
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: bob._id,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_EDITOR,
      grantedBy: alice._id,
    });
  }

  const bobsServers = async () =>
    Object.keys(
      await registry.getAllServerConfigs(bob._id.toString(), undefined, SystemRoles.USER),
    );

  it('control: Bob cannot attach the private server through the update route', async () => {
    const serverName = await createPrivateServer();
    const agent = await methods.createAgent({
      id: 'agent_update_control',
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [],
    });
    await shareAgent(agent);

    currentUser = asUser(bob);
    const res = await request(app)
      .patch(`/agents/${agent.id}`)
      .send({ tools: [mcpTool(serverName)] });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([]);
    expect(stored.mcpServerNames ?? []).not.toContain(serverName);
    expect(await bobsServers()).not.toContain(serverName);
  });

  it('revert does not let an editor re-attach a server the agent no longer uses', async () => {
    const serverName = await createPrivateServer();
    const agent = await methods.createAgent({
      id: 'agent_revert_reattach',
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [mcpTool(serverName)],
      mcpServerNames: [serverName],
    });
    await methods.updateAgent(
      { id: agent.id },
      { tools: [] },
      { updatingUserId: alice._id.toString() },
    );
    await shareAgent(agent);

    expect(await bobsServers()).not.toContain(serverName);

    await waitForRegistryCache();
    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).not.toContain(mcpTool(serverName));
    expect(stored.mcpServerNames ?? []).not.toContain(serverName);
    expect(await bobsServers()).not.toContain(serverName);
  });

  it('revert to a version without MCP tools drops the server from the agent index', async () => {
    const serverName = await createPrivateServer();
    const agent = await methods.createAgent({
      id: 'agent_revert_stale',
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [],
    });
    await methods.updateAgent(
      { id: agent.id },
      { tools: [mcpTool(serverName)], mcpServerNames: [serverName] },
      { updatingUserId: alice._id.toString() },
    );
    await shareAgent(agent);

    currentUser = asUser(alice);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([]);
    expect(stored.mcpServerNames ?? []).not.toContain(serverName);
    await waitForRegistryCache();
    expect(await bobsServers()).not.toContain(serverName);
  });
  /** Alice's agent used the server in version 0 and dropped it in version 1. */
  async function createDetachedAgent(id, serverName) {
    const agent = await methods.createAgent({
      id,
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [mcpTool(serverName)],
      mcpServerNames: [serverName],
    });
    await methods.updateAgent(
      { id: agent.id },
      { tools: [] },
      { updatingUserId: alice._id.toString() },
    );
    await shareAgent(agent);
    return agent;
  }

  it('a stale index on the target agent does not authorize the restore', async () => {
    const serverName = await createPrivateServer();
    const agent = await createDetachedAgent('agent_revert_stale_index', serverName);
    /** The state an earlier revert left behind: no tool uses the server, the index still names it. */
    await mongoose.models.Agent.updateOne(
      { id: agent.id },
      { $set: { mcpServerNames: [serverName] } },
    );
    await waitForRegistryCache();

    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([]);
    expect(stored.mcpServerNames).toEqual([]);
    await waitForRegistryCache();
    expect(await bobsServers()).not.toContain(serverName);
  });

  it('access cached from before the owner detached the server does not authorize the restore', async () => {
    const serverName = await createPrivateServer();
    const agent = await methods.createAgent({
      id: 'agent_revert_cached',
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [mcpTool(serverName)],
      mcpServerNames: [serverName],
    });
    await shareAgent(agent);
    expect(await bobsServers()).toContain(serverName);
    await methods.updateAgent(
      { id: agent.id },
      { tools: [] },
      { updatingUserId: alice._id.toString() },
    );

    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([]);
    expect(stored.mcpServerNames).toEqual([]);
  });

  it('an editor who reaches the server through another agent can restore it', async () => {
    const serverName = await createPrivateServer();
    const agent = await createDetachedAgent('agent_revert_other_grant', serverName);
    const other = await methods.createAgent({
      id: 'agent_other_grant',
      name: 'Other',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [mcpTool(serverName)],
      mcpServerNames: [serverName],
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: bob._id,
      resourceType: ResourceType.AGENT,
      resourceId: other._id,
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      grantedBy: alice._id,
    });
    await waitForRegistryCache();

    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([mcpTool(serverName)]);
    expect(stored.mcpServerNames).toEqual([serverName]);
  });

  it('a direct grant revoked while the registry still caches it does not authorize the restore', async () => {
    const serverName = await createPrivateServer();
    const server = await methods.findMCPServerByServerName(serverName);
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: bob._id,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      grantedBy: alice._id,
    });
    const agent = await createDetachedAgent('agent_revert_revoked', serverName);
    expect(await bobsServers()).toContain(serverName);
    await mongoose.models.AclEntry.deleteMany({
      principalId: bob._id,
      resourceType: ResourceType.MCPSERVER,
    });

    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([]);
    expect(stored.mcpServerNames).toEqual([]);
  });

  it('an editor can restore another tool from a server the agent still uses', async () => {
    const serverName = await createPrivateServer();
    const kept = mcpTool(serverName);
    const restored = `fetch${Constants.mcp_delimiter}${serverName}`;
    const agent = await methods.createAgent({
      id: 'agent_revert_still_used',
      name: 'Shared',
      provider: 'openai',
      model: 'gpt-4o',
      author: alice._id,
      tools: [kept, restored],
      mcpServerNames: [serverName],
    });
    await methods.updateAgent(
      { id: agent.id },
      { tools: [kept] },
      { updatingUserId: alice._id.toString() },
    );
    await shareAgent(agent);
    await waitForRegistryCache();

    currentUser = asUser(bob);
    const res = await request(app).post(`/agents/${agent.id}/revert`).send({ version_index: 0 });

    expect(res.status).toBe(200);
    const stored = await methods.getAgent({ id: agent.id });
    expect(stored.tools).toEqual([kept, restored]);
    expect(stored.mcpServerNames).toEqual([serverName]);
  });
});
