const mockGetMCPManager = jest.fn();
const mockInvalidateCachedTools = jest.fn();

jest.mock('~/config', () => ({
  getMCPManager: (...args) => mockGetMCPManager(...args),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(),
}));

jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: (...args) => mockInvalidateCachedTools(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
  getMCPServerTools: jest.fn(),
}));

const mongoose = require('mongoose');
const { mcpServerSchema } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} = require('librechat-data-provider');
const permissionService = require('~/server/services/PermissionService');
const { deleteUserMcpServers } = require('~/server/controllers/UserController');
const { AclEntry, AccessRole } = require('~/db/models');

let MCPServer;

describe('deleteUserMcpServers', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    MCPServer = mongoose.models.MCPServer || mongoose.model('MCPServer', mcpServerSchema);
    await mongoose.connect(mongoUri);

    await AccessRole.create({
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      name: 'MCP Server Owner',
      resourceType: ResourceType.MCPSERVER,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
    });

    await AccessRole.create({
      accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      name: 'MCP Server Viewer',
      resourceType: ResourceType.MCPSERVER,
      permBits: PermissionBits.VIEW,
    });
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await MCPServer.deleteMany({});
    await AclEntry.deleteMany({});
    jest.clearAllMocks();
  });

  test('should delete solely-owned MCP servers and their ACL entries', async () => {
    const userId = new mongoose.Types.ObjectId();

    const server = await MCPServer.create({
      serverName: 'sole-owned-server',
      config: { title: 'Test Server' },
      author: userId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: userId,
    });

    mockGetMCPManager.mockReturnValue({
      disconnectUserConnection: jest.fn().mockResolvedValue(undefined),
    });

    await deleteUserMcpServers(userId.toString());

    expect(await MCPServer.findById(server._id)).toBeNull();

    const aclEntries = await AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
    });
    expect(aclEntries).toHaveLength(0);
  });

  test('should disconnect MCP sessions and invalidate tool cache before deletion', async () => {
    const userId = new mongoose.Types.ObjectId();
    const mockDisconnect = jest.fn().mockResolvedValue(undefined);

    const server = await MCPServer.create({
      serverName: 'session-server',
      config: { title: 'Session Server' },
      author: userId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: userId,
    });

    mockGetMCPManager.mockReturnValue({ disconnectUserConnection: mockDisconnect });

    await deleteUserMcpServers(userId.toString());

    expect(mockDisconnect).toHaveBeenCalledWith(userId.toString(), 'session-server');
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: userId.toString(),
      serverName: 'session-server',
    });
  });

  test('should delete owned servers when cache invalidation fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    const server = await MCPServer.create({
      serverName: 'cache-failure-server',
      config: { title: 'Cache Failure Server' },
      author: userId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: userId,
    });

    const disconnectUserConnection = jest.fn().mockResolvedValue(undefined);
    mockGetMCPManager.mockReturnValue({ disconnectUserConnection });
    mockInvalidateCachedTools.mockRejectedValueOnce(new Error('Redis unavailable'));

    await deleteUserMcpServers(userId.toString());

    expect(disconnectUserConnection).toHaveBeenCalledWith(
      userId.toString(),
      'cache-failure-server',
    );
    expect(await MCPServer.findById(server._id)).toBeNull();
    await expect(
      AclEntry.countDocuments({
        resourceType: ResourceType.MCPSERVER,
        resourceId: server._id,
      }),
    ).resolves.toBe(0);
  });

  test('should preserve multi-owned MCP servers', async () => {
    const deletingUserId = new mongoose.Types.ObjectId();
    const otherOwnerId = new mongoose.Types.ObjectId();

    const soleServer = await MCPServer.create({
      serverName: 'sole-server',
      config: { title: 'Sole Server' },
      author: deletingUserId,
    });

    const multiServer = await MCPServer.create({
      serverName: 'multi-server',
      config: { title: 'Multi Server' },
      author: deletingUserId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: deletingUserId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: soleServer._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: deletingUserId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: deletingUserId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: multiServer._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: deletingUserId,
    });
    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherOwnerId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: multiServer._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: otherOwnerId,
    });

    mockGetMCPManager.mockReturnValue({
      disconnectUserConnection: jest.fn().mockResolvedValue(undefined),
    });

    await deleteUserMcpServers(deletingUserId.toString());

    expect(await MCPServer.findById(soleServer._id)).toBeNull();
    expect(await MCPServer.findById(multiServer._id)).not.toBeNull();

    const soleAcl = await AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: soleServer._id,
    });
    expect(soleAcl).toHaveLength(0);

    const multiAclOther = await AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: multiServer._id,
      principalId: otherOwnerId,
    });
    expect(multiAclOther).toHaveLength(1);
    expect(multiAclOther[0].permBits & PermissionBits.DELETE).toBeTruthy();

    const multiAclDeleting = await AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: multiServer._id,
      principalId: deletingUserId,
    });
    expect(multiAclDeleting).toHaveLength(1);
  });

  test('should be a no-op when user has no owned MCP servers', async () => {
    const userId = new mongoose.Types.ObjectId();

    const otherUserId = new mongoose.Types.ObjectId();
    const server = await MCPServer.create({
      serverName: 'other-server',
      config: { title: 'Other Server' },
      author: otherUserId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: otherUserId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: otherUserId,
    });

    await deleteUserMcpServers(userId.toString());

    expect(await MCPServer.findById(server._id)).not.toBeNull();
    expect(mockGetMCPManager).not.toHaveBeenCalled();
  });

  test('should handle gracefully when MCPServer model is not registered', async () => {
    const originalModel = mongoose.models.MCPServer;
    delete mongoose.models.MCPServer;

    try {
      const userId = new mongoose.Types.ObjectId();
      await expect(deleteUserMcpServers(userId.toString())).resolves.toBeUndefined();
    } finally {
      mongoose.models.MCPServer = originalModel;
    }
  });

  test('should handle gracefully when MCPManager is not available', async () => {
    const userId = new mongoose.Types.ObjectId();

    const server = await MCPServer.create({
      serverName: 'no-manager-server',
      config: { title: 'No Manager Server' },
      author: userId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: server._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: userId,
    });

    mockGetMCPManager.mockReturnValue(null);

    await deleteUserMcpServers(userId.toString());

    expect(await MCPServer.findById(server._id)).toBeNull();
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: userId.toString(),
      serverName: 'no-manager-server',
    });
  });

  test('should delete legacy MCP servers that have author but no ACL entries', async () => {
    const legacyUserId = new mongoose.Types.ObjectId();

    const legacyServer = await MCPServer.create({
      serverName: 'legacy-server',
      config: { title: 'Legacy Server' },
      author: legacyUserId,
    });

    mockGetMCPManager.mockReturnValue({
      disconnectUserConnection: jest.fn().mockResolvedValue(undefined),
    });

    await deleteUserMcpServers(legacyUserId.toString());

    expect(await MCPServer.findById(legacyServer._id)).toBeNull();
  });

  test('should delete both ACL-owned and legacy servers in one call', async () => {
    const userId = new mongoose.Types.ObjectId();

    const aclServer = await MCPServer.create({
      serverName: 'acl-server',
      config: { title: 'ACL Server' },
      author: userId,
    });

    await permissionService.grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.MCPSERVER,
      resourceId: aclServer._id,
      accessRoleId: AccessRoleIds.MCPSERVER_OWNER,
      grantedBy: userId,
    });

    const legacyServer = await MCPServer.create({
      serverName: 'legacy-mixed-server',
      config: { title: 'Legacy Mixed' },
      author: userId,
    });

    mockGetMCPManager.mockReturnValue({
      disconnectUserConnection: jest.fn().mockResolvedValue(undefined),
    });

    await deleteUserMcpServers(userId.toString());

    expect(await MCPServer.findById(aclServer._id)).toBeNull();
    expect(await MCPServer.findById(legacyServer._id)).toBeNull();
  });
});
