const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
} = require('librechat-data-provider');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTransactionSupport: jest.fn().mockResolvedValue(false),
}));

jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: jest.fn().mockReturnValue(false),
  getUserOwnedEntraGroups: jest.fn().mockResolvedValue([]),
  getUserEntraGroups: jest.fn().mockResolvedValue([]),
  getEntraGroupDetailsBatch: jest.fn().mockResolvedValue([]),
  getGroupMembers: jest.fn().mockResolvedValue([]),
  getGroupOwners: jest.fn().mockResolvedValue([]),
}));

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  inspectServerUpdate: jest.fn(),
  commitServerUpdate: jest.fn(),
  updateServer: jest.fn(),
  removeServer: jest.fn(),
  resolveAllowlists: jest.fn(),
};
const mockMcpManager = { disconnectUserConnection: jest.fn() };

jest.mock('~/config', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  getMCPManager: jest.fn(() => mockMcpManager),
  getMCPServersRegistry: jest.fn(() => mockRegistryInstance),
}));

const mockResolveAllMcpConfigs = jest.fn();
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
  resolveMcpConfigNames: jest.fn().mockResolvedValue([]),
  resolveAllMcpConfigs: (...args) => mockResolveAllMcpConfigs(...args),
}));

jest.mock('~/server/services/Config', () => ({
  cacheMCPServerTools: jest.fn(),
  getMCPToolsCacheGeneration: jest.fn().mockResolvedValue('test-generation'),
  getMCPServerTools: jest.fn(),
  invalidateCachedTools: jest.fn(),
}));

const mockMaybeUninstallOAuthMCP = jest.fn();
const {
  getMCPServersList,
  getMCPServerById,
  updateMCPServerController,
  deleteMCPServerController,
} = require('~/server/controllers/mcp');
const { grantPermission } = require('~/server/services/PermissionService');
const { seedDefaultRoles } = require('~/models');

let mongoServer;
let SystemGrant;
let AclEntry;
let User;

const yamlConfig = {
  type: 'streamable-http',
  url: 'https://internal.example.com/mcp',
  title: 'YAML Server',
  source: 'yaml',
  oauth: {
    client_id: 'client-id',
    authorization_url: 'https://internal.example.com/auth',
    token_url: 'https://internal.example.com/token',
  },
};

const createRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const createDbConfig = (dbId) => ({
  type: 'streamable-http',
  url: 'https://user.example.com/mcp',
  title: 'DB Server',
  source: 'user',
  dbId: String(dbId),
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const { createModels } = jest.requireActual('@librechat/data-schemas');
  createModels(mongoose);
  const dbModels = require('~/db/models');
  Object.assign(mongoose.models, dbModels);
  SystemGrant = dbModels.SystemGrant;
  AclEntry = dbModels.AclEntry;
  User = dbModels.User;

  await seedDefaultRoles();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

let existsSpy;

beforeEach(async () => {
  await SystemGrant.deleteMany({});
  await AclEntry.deleteMany({});
  await User.deleteMany({});
  mockResolveAllMcpConfigs.mockReset();
  mockRegistryInstance.getServerConfig.mockReset();
  mockRegistryInstance.inspectServerUpdate.mockReset();
  mockRegistryInstance.commitServerUpdate.mockReset();
  mockRegistryInstance.updateServer.mockReset();
  mockRegistryInstance.removeServer.mockReset();
  mockRegistryInstance.resolveAllowlists.mockReset().mockResolvedValue({
    allowedDomains: ['https://oauth.example.com'],
    allowedAddresses: null,
  });
  mockMcpManager.disconnectUserConnection.mockReset().mockResolvedValue(undefined);
  mockMaybeUninstallOAuthMCP.mockReset().mockResolvedValue(undefined);
  const cacheService = require('~/server/services/Config');
  cacheService.invalidateCachedTools.mockReset().mockResolvedValue(undefined);
  cacheService.getMCPServerTools.mockReset().mockResolvedValue({ retained: {} });
  cacheService.getMCPToolsCacheGeneration.mockReset().mockResolvedValue('restored-generation');
  cacheService.cacheMCPServerTools.mockReset().mockResolvedValue(undefined);
  existsSpy = jest.spyOn(SystemGrant, 'exists');
});

afterEach(() => {
  existsSpy.mockRestore();
});

const seedManageMcpGrant = async (role = SystemRoles.ADMIN) => {
  await SystemGrant.create({
    principalType: PrincipalType.ROLE,
    principalId: role,
    capability: SystemCapabilities.MANAGE_MCP_SERVERS,
    grantedAt: new Date(),
  });
};

const createUser = async (role = SystemRoles.USER) => {
  const user = await User.create({
    name: 'Test User',
    email: `user-${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'local',
    role,
  });
  return { id: user._id.toString(), role, idOnTheSource: null };
};

describe('getMCPServersList', () => {
  it('skips the capability probe when no server is DB-backed', async () => {
    await seedManageMcpGrant();
    const reqUser = await createUser(SystemRoles.ADMIN);
    mockResolveAllMcpConfigs.mockResolvedValue({ yamlServer: { ...yamlConfig } });

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    expect(existsSpy).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.yamlServer.title).toBe('YAML Server');
    expect(payload.yamlServer.url).toBeUndefined();
    expect(payload.yamlServer.oauth.authorization_url).toBeUndefined();
  });

  it('skips the probe entirely for an empty server map', async () => {
    const reqUser = await createUser();
    mockResolveAllMcpConfigs.mockResolvedValue({});

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    expect(existsSpy).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({});
  });

  it('exposes safe request-scoped metadata while redacting placeholder-bearing fields', async () => {
    const reqUser = await createUser();
    mockResolveAllMcpConfigs.mockResolvedValue({
      runtimeServer: {
        ...yamlConfig,
        headers: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      },
    });

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.runtimeServer.requestScoped).toBe(true);
    expect(payload.runtimeServer.url).toBeUndefined();
    expect(payload.runtimeServer.headers).toBeUndefined();
  });

  it('applies the capability bypass to all servers when a DB-backed server is present', async () => {
    await seedManageMcpGrant();
    const reqUser = await createUser(SystemRoles.ADMIN);
    const dbId = new mongoose.Types.ObjectId();
    mockResolveAllMcpConfigs.mockResolvedValue({
      dbServer: createDbConfig(dbId),
      yamlServer: { ...yamlConfig },
    });

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    expect(existsSpy).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.dbServer.url).toBe('https://user.example.com/mcp');
    expect(payload.yamlServer.url).toBe('https://internal.example.com/mcp');
  });

  it('falls back to ACL EDIT for DB-backed servers without the capability', async () => {
    const reqUser = await createUser();
    const dbId = new mongoose.Types.ObjectId();
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: reqUser.id,
      resourceType: ResourceType.MCPSERVER,
      resourceId: dbId,
      accessRoleId: AccessRoleIds.MCPSERVER_EDITOR,
      grantedBy: reqUser.id,
    });
    mockResolveAllMcpConfigs.mockResolvedValue({
      dbServer: createDbConfig(dbId),
      yamlServer: { ...yamlConfig },
    });

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    expect(existsSpy).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.dbServer.url).toBe('https://user.example.com/mcp');
    expect(payload.yamlServer.url).toBeUndefined();
  });

  it('leaves DB-backed servers redacted for viewer-only ACL', async () => {
    const reqUser = await createUser();
    const dbId = new mongoose.Types.ObjectId();
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: reqUser.id,
      resourceType: ResourceType.MCPSERVER,
      resourceId: dbId,
      accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      grantedBy: reqUser.id,
    });
    mockResolveAllMcpConfigs.mockResolvedValue({ dbServer: createDbConfig(dbId) });

    const res = createRes();
    await getMCPServersList({ user: reqUser }, res);

    expect(existsSpy).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.dbServer.title).toBe('DB Server');
    expect(payload.dbServer.url).toBeUndefined();
  });
});

describe('getMCPServerById', () => {
  it('still runs the capability probe for YAML servers on the detail route', async () => {
    await seedManageMcpGrant();
    const reqUser = await createUser(SystemRoles.ADMIN);
    mockRegistryInstance.getServerConfig.mockResolvedValue({ ...yamlConfig });

    const res = createRes();
    await getMCPServerById({ user: reqUser, params: { serverName: 'yamlServer' } }, res);

    expect(existsSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.url).toBe('https://internal.example.com/mcp');
    expect(payload.oauth.authorization_url).toBe('https://internal.example.com/auth');
  });

  it('redacts YAML server details for users without the capability', async () => {
    const reqUser = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue({ ...yamlConfig });

    const res = createRes();
    await getMCPServerById({ user: reqUser, params: { serverName: 'yamlServer' } }, res);

    expect(existsSpy).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.url).toBeUndefined();
    expect(payload.oauth.authorization_url).toBeUndefined();
  });
});

describe('DB-backed server mutation fencing', () => {
  const updatedConfig = {
    type: 'streamable-http',
    url: 'https://updated.example.com/mcp',
    source: 'user',
  };

  it('inspects, fences, commits, fences cross-replica creations, and disconnects', async () => {
    const user = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockRegistryInstance.inspectServerUpdate.mockResolvedValue(updatedConfig);
    mockRegistryInstance.commitServerUpdate.mockResolvedValue(updatedConfig);
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    const { invalidateCachedTools } = require('~/server/services/Config');
    expect(invalidateCachedTools).toHaveBeenCalledWith({ userId: user.id, serverName: 'github' });
    expect(invalidateCachedTools).toHaveBeenCalledTimes(2);
    expect(mockMcpManager.disconnectUserConnection).toHaveBeenCalledWith(user.id, 'github');
    expect(mockRegistryInstance.inspectServerUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateCachedTools.mock.invocationCallOrder[0],
    );
    expect(invalidateCachedTools.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegistryInstance.commitServerUpdate.mock.invocationCallOrder[0],
    );
    expect(mockRegistryInstance.commitServerUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateCachedTools.mock.invocationCallOrder[1],
    );
    expect(invalidateCachedTools.mock.invocationCallOrder[1]).toBeLessThan(
      mockMcpManager.disconnectUserConnection.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not fence the valid catalog when update inspection or persistence fails', async () => {
    const user = await createUser();
    const updateError = new Error('inspection failed');
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockRegistryInstance.inspectServerUpdate.mockRejectedValue(updateError);
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    expect(require('~/server/services/Config').invalidateCachedTools).not.toHaveBeenCalled();
    expect(mockRegistryInstance.commitServerUpdate).not.toHaveBeenCalled();
    expect(mockMcpManager.disconnectUserConnection).not.toHaveBeenCalled();
    expect(mockMaybeUninstallOAuthMCP).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not commit an inspected update when the distributed fence fails', async () => {
    const user = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockRegistryInstance.inspectServerUpdate.mockResolvedValue(updatedConfig);
    require('~/server/services/Config').invalidateCachedTools.mockRejectedValue(
      new Error('Redis unavailable'),
    );
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    expect(mockMcpManager.disconnectUserConnection).not.toHaveBeenCalled();
    expect(mockMaybeUninstallOAuthMCP).not.toHaveBeenCalled();
    expect(mockRegistryInstance.commitServerUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('restores the retained catalog when update persistence fails after fencing', async () => {
    const user = await createUser();
    const existingConfig = createDbConfig(new mongoose.Types.ObjectId());
    const retainedTools = { retained: { function: { name: 'retained' } } };
    mockRegistryInstance.getServerConfig.mockResolvedValue(existingConfig);
    mockRegistryInstance.inspectServerUpdate.mockResolvedValue(updatedConfig);
    mockRegistryInstance.commitServerUpdate.mockRejectedValue(new Error('database unavailable'));
    require('~/server/services/Config').getMCPServerTools.mockResolvedValue(retainedTools);
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    expect(require('~/server/services/Config').cacheMCPServerTools).toHaveBeenCalledWith({
      userId: user.id,
      serverName: 'github',
      serverConfig: existingConfig,
      serverTools: retainedTools,
      publicationGeneration: 'restored-generation',
    });
    expect(mockMcpManager.disconnectUserConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('continues an update when only local disconnect cleanup fails', async () => {
    const user = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockMcpManager.disconnectUserConnection.mockRejectedValue(new Error('dispose failed'));
    mockRegistryInstance.inspectServerUpdate.mockResolvedValue(updatedConfig);
    mockRegistryInstance.commitServerUpdate.mockResolvedValue(updatedConfig);
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    expect(mockRegistryInstance.commitServerUpdate).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('retries a transient post-commit fence failure before returning success', async () => {
    const user = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockRegistryInstance.inspectServerUpdate.mockResolvedValue(updatedConfig);
    mockRegistryInstance.commitServerUpdate.mockResolvedValue(updatedConfig);
    require('~/server/services/Config')
      .invalidateCachedTools.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis MOVED'))
      .mockResolvedValueOnce(undefined);
    const res = createRes();

    await updateMCPServerController(
      { user, params: { serverName: 'github' }, body: { config: updatedConfig } },
      res,
    );

    expect(require('~/server/services/Config').invalidateCachedTools).toHaveBeenCalledTimes(3);
    expect(mockMcpManager.disconnectUserConnection).toHaveBeenCalledWith(user.id, 'github');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fences before deletion and fences cross-replica creations before disconnecting', async () => {
    const user = await createUser();
    mockRegistryInstance.getServerConfig.mockResolvedValue(
      createDbConfig(new mongoose.Types.ObjectId()),
    );
    mockRegistryInstance.removeServer.mockResolvedValue(undefined);
    const res = createRes();

    await deleteMCPServerController(
      { user, params: { serverName: 'github' } },
      res,
      mockMaybeUninstallOAuthMCP,
    );

    const { invalidateCachedTools } = require('~/server/services/Config');
    expect(invalidateCachedTools).toHaveBeenCalledWith({ userId: user.id, serverName: 'github' });
    expect(invalidateCachedTools).toHaveBeenCalledTimes(2);
    expect(mockMcpManager.disconnectUserConnection).toHaveBeenCalledWith(user.id, 'github');
    expect(mockMaybeUninstallOAuthMCP).toHaveBeenCalledWith(
      user.id,
      'mcp_github',
      {
        mcpSettings: {
          allowedDomains: ['https://oauth.example.com'],
          allowedAddresses: null,
        },
      },
      expect.objectContaining({ source: 'user' }),
    );
    expect(invalidateCachedTools.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegistryInstance.removeServer.mock.invocationCallOrder[0],
    );
    expect(mockRegistryInstance.removeServer.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateCachedTools.mock.invocationCallOrder[1],
    );
    expect(invalidateCachedTools.mock.invocationCallOrder[1]).toBeLessThan(
      mockMcpManager.disconnectUserConnection.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('cleans credentials created by an authorized shared user during server deletion', async () => {
    const owner = await createUser();
    const sharedUser = await createUser();
    const dbId = new mongoose.Types.ObjectId();
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: sharedUser.id,
      resourceType: ResourceType.MCPSERVER,
      resourceId: dbId,
      accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      grantedBy: owner.id,
    });
    mockRegistryInstance.getServerConfig.mockResolvedValue(createDbConfig(dbId));
    mockRegistryInstance.removeServer.mockResolvedValue(undefined);
    const tokenSnapshot = jest
      .spyOn(mongoose.models.Token, 'distinct')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([new mongoose.Types.ObjectId(sharedUser.id)]);

    try {
      await deleteMCPServerController(
        { user: owner, params: { serverName: 'github' } },
        createRes(),
        mockMaybeUninstallOAuthMCP,
      );

      expect(tokenSnapshot).toHaveBeenCalledTimes(2);
      expect(mockMaybeUninstallOAuthMCP).toHaveBeenCalledWith(
        sharedUser.id,
        'mcp_github',
        expect.any(Object),
        expect.objectContaining({ dbId: dbId.toString() }),
      );
      expect(require('~/server/services/Config').invalidateCachedTools).toHaveBeenCalledWith({
        userId: sharedUser.id,
        serverName: 'github',
      });
      expect(mockMcpManager.disconnectUserConnection).toHaveBeenCalledWith(sharedUser.id, 'github');
    } finally {
      tokenSnapshot.mockRestore();
    }
  });

  it('does not delete the registry entry when the distributed fence fails', async () => {
    const user = await createUser();
    require('~/server/services/Config').invalidateCachedTools.mockRejectedValue(
      new Error('Redis unavailable'),
    );
    const res = createRes();

    await deleteMCPServerController({ user, params: { serverName: 'github' } }, res);

    expect(mockMcpManager.disconnectUserConnection).not.toHaveBeenCalled();
    expect(mockRegistryInstance.removeServer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('restores the retained catalog when deletion persistence fails after fencing', async () => {
    const user = await createUser();
    const existingConfig = createDbConfig(new mongoose.Types.ObjectId());
    const retainedTools = { retained: { function: { name: 'retained' } } };
    mockRegistryInstance.getServerConfig.mockResolvedValue(existingConfig);
    mockRegistryInstance.removeServer.mockRejectedValue(new Error('Deletion failed'));
    require('~/server/services/Config').getMCPServerTools.mockResolvedValue(retainedTools);
    const res = createRes();

    await deleteMCPServerController({ user, params: { serverName: 'github' } }, res);

    expect(require('~/server/services/Config').cacheMCPServerTools).toHaveBeenCalledWith({
      userId: user.id,
      serverName: 'github',
      serverConfig: existingConfig,
      serverTools: retainedTools,
      publicationGeneration: 'restored-generation',
    });
    expect(mockMcpManager.disconnectUserConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
