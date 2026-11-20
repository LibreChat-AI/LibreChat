const mongoose = require('mongoose');
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { canAccessMCPServerResource } = require('./canAccessMCPServerResource');
const { User, Role, AclEntry, SystemGrant } = require('~/db/models');
const { createMCPServer } = require('~/models');

describe('canAccessMCPServerResource middleware', () => {
  let mongoServer;
  let req, res, next;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await Role.create({
      name: 'test-role',
      permissions: {
        MCP_SERVERS: {
          USE: true,
          CREATE: true,
          SHARE: true,
        },
      },
    });

    // Create a test user
    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'test-role',
    });

    req = {
      user: { id: testUser._id, role: testUser.role },
      params: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();

    jest.clearAllMocks();
  });

  describe('middleware factory', () => {
    test('should throw error if requiredPermission is not provided', () => {
      expect(() => canAccessMCPServerResource({})).toThrow(
        'canAccessMCPServerResource: requiredPermission is required and must be a number',
      );
    });

    test('should throw error if requiredPermission is not a number', () => {
      expect(() => canAccessMCPServerResource({ requiredPermission: '1' })).toThrow(
        'canAccessMCPServerResource: requiredPermission is required and must be a number',
      );
    });

    test('should throw error if requiredPermission is null', () => {
      expect(() => canAccessMCPServerResource({ requiredPermission: null })).toThrow(
        'canAccessMCPServerResource: requiredPermission is required and must be a number',
      );
    });

    test('should create middleware with default resourceIdParam (serverName)', () => {
      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3); // Express middleware signature
    });

    test('should create middleware with custom resourceIdParam', () => {
      const middleware = canAccessMCPServerResource({
        requiredPermission: 2,
        resourceIdParam: 'mcpId',
      });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('permission checking with real MCP servers', () => {
    test('should allow access when user is the MCP server author', async () => {
      // Create an MCP server owned by the test user
      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Test MCP Server',
        },
        author: testUser._id,
      });

      // Create ACL entry for the author (owner permissions)
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions (1+2+4+8)
        grantedBy: testUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should deny access when user is not the author and has no ACL entry', async () => {
      // Create an MCP server owned by a different user
      const otherUser = await User.create({
        email: 'other@example.com',
        name: 'Other User',
        username: 'otheruser',
        role: 'test-role',
      });

      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Other User MCP Server',
        },
        author: otherUser._id,
      });

      // Create ACL entry for the other user (owner)
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions
        grantedBy: otherUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'Insufficient permissions to access this mcpServer',
      });
    });

    test('should allow access when user has ACL entry with sufficient permissions', async () => {
      // Create an MCP server owned by a different user
      const otherUser = await User.create({
        email: 'other2@example.com',
        name: 'Other User 2',
        username: 'otheruser2',
        role: 'test-role',
      });

      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Shared MCP Server',
        },
        author: otherUser._id,
      });

      // Create ACL entry granting view permission to test user
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 1, // VIEW permission
        grantedBy: otherUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should deny access when ACL permissions are insufficient', async () => {
      // Create an MCP server owned by a different user
      const otherUser = await User.create({
        email: 'other3@example.com',
        name: 'Other User 3',
        username: 'otheruser3',
        role: 'test-role',
      });

      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Limited Access MCP Server',
        },
        author: otherUser._id,
      });

      // Create ACL entry granting only view permission
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 1, // VIEW permission only
        grantedBy: otherUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 2 }); // EDIT permission required
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'Insufficient permissions to access this mcpServer',
      });
    });

    test('should handle non-existent MCP server', async () => {
      req.params.serverName = 'non-existent-mcp-server';

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Not Found',
        message: 'mcpServer not found',
      });
    });

    test('should use custom resourceIdParam', async () => {
      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Custom Param MCP Server',
        },
        author: testUser._id,
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions
        grantedBy: testUser._id,
      });

      req.params.mcpId = mcpServer.serverName; // Using custom param name

      const middleware = canAccessMCPServerResource({
        requiredPermission: 1,
        resourceIdParam: 'mcpId',
      });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('permission levels', () => {
    let mcpServer;

    beforeEach(async () => {
      mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Permission Test MCP Server',
        },
        author: testUser._id,
      });

      // Create ACL entry with all permissions for the owner
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions (1+2+4+8)
        grantedBy: testUser._id,
      });

      req.params.serverName = mcpServer.serverName;
    });

    test('should support view permission (1)', async () => {
      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support edit permission (2)', async () => {
      const middleware = canAccessMCPServerResource({ requiredPermission: 2 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support delete permission (4)', async () => {
      const middleware = canAccessMCPServerResource({ requiredPermission: 4 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support share permission (8)', async () => {
      const middleware = canAccessMCPServerResource({ requiredPermission: 8 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support combined permissions', async () => {
      const viewAndEdit = 1 | 2; // 3
      const middleware = canAccessMCPServerResource({ requiredPermission: viewAndEdit });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('integration with resolveMCPServerId', () => {
    test('should resolve serverName to MongoDB ObjectId correctly', async () => {
      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Integration Test MCP Server',
        },
        author: testUser._id,
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions
        grantedBy: testUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      // Verify that req.resourceAccess was set correctly
      expect(req.resourceAccess).toBeDefined();
      expect(req.resourceAccess.resourceType).toBe(ResourceType.MCPSERVER);
      expect(req.resourceAccess.resourceId.toString()).toBe(mcpServer._id.toString());
      expect(req.resourceAccess.customResourceId).toBe(mcpServer.serverName);
    });

    test('should work with MCP server CRUD operations', async () => {
      // Create MCP server
      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'CRUD Test MCP Server',
          description: 'Testing integration',
        },
        author: testUser._id,
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15, // All permissions
        grantedBy: testUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      // Test view access
      const viewMiddleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await viewMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      jest.clearAllMocks();

      // Update the MCP server
      const { updateMCPServer } = require('~/models');
      await updateMCPServer(mcpServer.serverName, {
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'CRUD Test MCP Server',
          description: 'Updated description',
        },
      });

      // Test edit access
      const editMiddleware = canAccessMCPServerResource({ requiredPermission: 2 });
      await editMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should handle stdio type MCP server', async () => {
      const mcpServer = await createMCPServer({
        config: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          title: 'Stdio MCP Server',
        },
        author: testUser._id,
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer._id,
        permBits: 15,
        grantedBy: testUser._id,
      });

      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.resourceAccess.resourceInfo.config.type).toBe('stdio');
    });
  });

  describe('authentication and authorization edge cases', () => {
    test('should return 400 when serverName parameter is missing', async () => {
      // Don't set req.params.serverName

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Bad Request',
        message: 'serverName is required',
      });
    });

    test('should return 401 when user is not authenticated', async () => {
      req.user = null;
      req.params.serverName = 'some-server';

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    });

    test('should return 401 when user id is missing', async () => {
      req.user = { role: 'test-role' }; // No id
      req.params.serverName = 'some-server';

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    });

    test('should allow users with MANAGE_MCP_SERVERS capability to bypass permission checks', async () => {
      const { SystemRoles } = require('librechat-data-provider');

      // Create an MCP server owned by another user
      const otherUser = await User.create({
        email: 'owner@example.com',
        name: 'Owner User',
        username: 'owneruser',
        role: 'test-role',
      });

      const mcpServer = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Admin Test MCP Server',
        },
        author: otherUser._id,
      });

      // Seed MANAGE_MCP_SERVERS capability for the ADMIN role
      await SystemGrant.create({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
        capability: SystemCapabilities.MANAGE_MCP_SERVERS,
        grantedAt: new Date(),
      });

      // Set user as admin
      req.user = { id: testUser._id, role: SystemRoles.ADMIN };
      req.params.serverName = mcpServer.serverName;

      const middleware = canAccessMCPServerResource({ requiredPermission: 4 }); // DELETE permission
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    test('should handle server returning null gracefully (treated as not found)', async () => {
      // When an MCP server is not found, findMCPServerByServerName returns null
      // which the middleware correctly handles as a 404
      req.params.serverName = 'definitely-non-existent-server';

      const middleware = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Not Found',
        message: 'mcpServer not found',
      });
    });
  });

  describe('multiple servers with same title', () => {
    test('should handle MCP servers with auto-generated suffixes', async () => {
      // Create multiple servers with the same title (will have different serverNames)
      const mcpServer1 = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp1',
          title: 'Duplicate Title',
        },
        author: testUser._id,
      });

      const mcpServer2 = await createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp2',
          title: 'Duplicate Title',
        },
        author: testUser._id,
      });

      // Create ACL entries for both
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer1._id,
        permBits: 15,
        grantedBy: testUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: mcpServer2._id,
        permBits: 15,
        grantedBy: testUser._id,
      });

      // Verify they have different serverNames
      expect(mcpServer1.serverName).toBe('duplicate-title');
      expect(mcpServer2.serverName).toBe('duplicate-title-2');

      // Test access to first server
      req.params.serverName = mcpServer1.serverName;
      const middleware1 = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware1(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.resourceAccess.resourceId.toString()).toBe(mcpServer1._id.toString());

      jest.clearAllMocks();

      // Test access to second server
      req.params.serverName = mcpServer2.serverName;
      const middleware2 = canAccessMCPServerResource({ requiredPermission: 1 });
      await middleware2(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.resourceAccess.resourceId.toString()).toBe(mcpServer2._id.toString());
    });
  });
});
