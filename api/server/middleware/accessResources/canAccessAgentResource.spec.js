const mongoose = require('mongoose');
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { canAccessAgentResource } = require('./canAccessAgentResource');
const { User, Role, AclEntry } = require('~/db/models');
const { createAgent } = require('~/models');

describe('canAccessAgentResource middleware', () => {
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
        AGENTS: {
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
      expect(() => canAccessAgentResource({})).toThrow(
        'canAccessAgentResource: requiredPermission is required and must be a number',
      );
    });

    test('should throw error if requiredPermission is not a number', () => {
      expect(() => canAccessAgentResource({ requiredPermission: '1' })).toThrow(
        'canAccessAgentResource: requiredPermission is required and must be a number',
      );
    });

    test('should create middleware with default resourceIdParam', () => {
      const middleware = canAccessAgentResource({ requiredPermission: 1 });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3); // Express middleware signature
    });

    test('should create middleware with custom resourceIdParam', () => {
      const middleware = canAccessAgentResource({
        requiredPermission: 2,
        resourceIdParam: 'agent_id',
      });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('permission checking with real agents', () => {
    test('should allow access when user is the agent author', async () => {
      // Create an agent owned by the test user
      const agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
      });

      // Create ACL entry for the author (owner permissions)
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 15, // All permissions (1+2+4+8)
        grantedBy: testUser._id,
      });

      req.params.id = agent.id;

      const middleware = canAccessAgentResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should deny access when user is not the author and has no ACL entry', async () => {
      // Create an agent owned by a different user
      const otherUser = await User.create({
        email: 'other@example.com',
        name: 'Other User',
        username: 'otheruser',
        role: 'test-role',
      });

      const agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Other User Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      // Create ACL entry for the other user (owner)
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 15, // All permissions
        grantedBy: otherUser._id,
      });

      req.params.id = agent.id;

      const middleware = canAccessAgentResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'Insufficient permissions to access this agent',
      });
    });

    test('should allow access when user has ACL entry with sufficient permissions', async () => {
      // Create an agent owned by a different user
      const otherUser = await User.create({
        email: 'other2@example.com',
        name: 'Other User 2',
        username: 'otheruser2',
        role: 'test-role',
      });

      const agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Shared Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      // Create ACL entry granting view permission to test user
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 1, // VIEW permission
        grantedBy: otherUser._id,
      });

      req.params.id = agent.id;

      const middleware = canAccessAgentResource({ requiredPermission: 1 }); // VIEW permission
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should deny access when ACL permissions are insufficient', async () => {
      // Create an agent owned by a different user
      const otherUser = await User.create({
        email: 'other3@example.com',
        name: 'Other User 3',
        username: 'otheruser3',
        role: 'test-role',
      });

      const agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Limited Access Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      // Create ACL entry granting only view permission
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 1, // VIEW permission only
        grantedBy: otherUser._id,
      });

      req.params.id = agent.id;

      const middleware = canAccessAgentResource({ requiredPermission: 2 }); // EDIT permission required
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'Insufficient permissions to access this agent',
      });
    });

    test('should handle non-existent agent', async () => {
      req.params.id = 'agent_nonexistent';

      const middleware = canAccessAgentResource({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Not Found',
        message: 'agent not found',
      });
    });

    test('should use custom resourceIdParam', async () => {
      const agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Custom Param Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 15, // All permissions
        grantedBy: testUser._id,
      });

      req.params.agent_id = agent.id; // Using custom param name

      const middleware = canAccessAgentResource({
        requiredPermission: 1,
        resourceIdParam: 'agent_id',
      });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('permission levels', () => {
    let agent;

    beforeEach(async () => {
      agent = await createAgent({
        id: `agent_${Date.now()}`,
        name: 'Permission Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
      });

      // Create ACL entry with all permissions for the owner
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 15, // All permissions (1+2+4+8)
        grantedBy: testUser._id,
      });

      req.params.id = agent.id;
    });

    test('should support view permission (1)', async () => {
      const middleware = canAccessAgentResource({ requiredPermission: 1 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support edit permission (2)', async () => {
      const middleware = canAccessAgentResource({ requiredPermission: 2 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support delete permission (4)', async () => {
      const middleware = canAccessAgentResource({ requiredPermission: 4 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support share permission (8)', async () => {
      const middleware = canAccessAgentResource({ requiredPermission: 8 });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('should support combined permissions', async () => {
      const viewAndEdit = 1 | 2; // 3
      const middleware = canAccessAgentResource({ requiredPermission: viewAndEdit });
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('integration with agent operations', () => {
    test('should work with agent CRUD operations', async () => {
      const agentId = `agent_${Date.now()}`;

      // Create agent
      const agent = await createAgent({
        id: agentId,
        name: 'Integration Test Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
        description: 'Testing integration',
      });

      // Create ACL entry for the author
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: 15, // All permissions
        grantedBy: testUser._id,
      });

      req.params.id = agentId;

      // Test view access
      const viewMiddleware = canAccessAgentResource({ requiredPermission: 1 });
      await viewMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      jest.clearAllMocks();

      // Update the agent
      const { updateAgent } = require('~/models');
      await updateAgent({ id: agentId }, { description: 'Updated description' });

      // Test edit access
      const editMiddleware = canAccessAgentResource({ requiredPermission: 2 });
      await editMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
