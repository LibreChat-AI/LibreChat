const mongoose = require('mongoose');
const {
  ResourceType,
  SystemRoles,
  PrincipalType,
  PrincipalModel,
} = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { canAccessAgentFromBody } = require('./canAccessAgentFromBody');
const { User, Role, AclEntry } = require('~/db/models');
const { createAgent } = require('~/models');

describe('canAccessAgentFromBody middleware', () => {
  let mongoServer;
  let req, res, next;
  let testUser, otherUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();

    await Role.create({
      name: 'test-role',
      permissions: {
        AGENTS: { USE: true, CREATE: true, SHARE: true },
        MULTI_CONVO: { USE: true },
      },
    });

    await Role.create({
      name: 'no-multi-convo',
      permissions: {
        AGENTS: { USE: true, CREATE: true, SHARE: true },
        MULTI_CONVO: { USE: false },
      },
    });

    await Role.create({
      name: SystemRoles.ADMIN,
      permissions: {
        AGENTS: { USE: true, CREATE: true, SHARE: true },
        MULTI_CONVO: { USE: true },
      },
    });

    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'test-role',
    });

    otherUser = await User.create({
      email: 'other@example.com',
      name: 'Other User',
      username: 'otheruser',
      role: 'test-role',
    });

    req = {
      user: { id: testUser._id, role: testUser.role },
      params: {},
      body: {
        endpoint: 'agents',
        agent_id: 'ephemeral_primary',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();

    jest.clearAllMocks();
  });

  describe('middleware factory', () => {
    test('throws if requiredPermission is missing', () => {
      expect(() => canAccessAgentFromBody({})).toThrow(
        'canAccessAgentFromBody: requiredPermission is required and must be a number',
      );
    });

    test('throws if requiredPermission is not a number', () => {
      expect(() => canAccessAgentFromBody({ requiredPermission: '1' })).toThrow(
        'canAccessAgentFromBody: requiredPermission is required and must be a number',
      );
    });

    test('returns a middleware function', () => {
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('primary agent checks', () => {
    test('returns 400 when agent_id is missing on agents endpoint', async () => {
      req.body.agent_id = undefined;
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('proceeds for ephemeral primary agent without addedConvo', async () => {
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('proceeds for non-agents endpoint (ephemeral fallback)', async () => {
      req.body.endpoint = 'openAI';
      req.body.agent_id = undefined;
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test.each([
      {
        label: 'inferred agents endpoint',
        preset: { agent_id: 'agent_restricted' },
      },
      {
        label: 'explicit agents endpoint',
        preset: { endpoint: 'agents', agent_id: 'agent_restricted' },
      },
    ])('checks the enforced model spec agent for an $label', async ({ preset }) => {
      const restrictedAgent = await createAgent({
        id: preset.agent_id,
        name: 'Restricted Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: restrictedAgent._id,
        permBits: 15,
        grantedBy: otherUser._id,
      });

      req.body.spec = 'restricted-agent';
      req.config = {
        modelSpecs: {
          enforce: true,
          list: [{ name: 'restricted-agent', preset }],
        },
      };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('permits an enforced model spec agent when the requester has access', async () => {
      const restrictedAgent = await createAgent({
        id: 'agent_shared',
        name: 'Shared Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: restrictedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.spec = 'shared-agent';
      req.config = {
        modelSpecs: {
          enforce: true,
          list: [{ name: 'shared-agent', preset: { agent_id: restrictedAgent.id } }],
        },
      };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('addedConvo — absent or invalid shape', () => {
    test('calls next when addedConvo is absent', async () => {
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('calls next when addedConvo is a string', async () => {
      req.body.addedConvo = 'not-an-object';
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('calls next when addedConvo is an array', async () => {
      req.body.addedConvo = [{ agent_id: 'agent_something' }];
      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('addedConvo — MULTI_CONVO permission gate', () => {
    test('returns 403 when user lacks MULTI_CONVO:USE', async () => {
      req.user.role = 'no-multi-convo';
      req.body.addedConvo = { agent_id: 'agent_x', endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Multi-conversation feature is not enabled' }),
      );
    });

    test('returns 403 when user.role is missing', async () => {
      req.user = { id: testUser._id };
      req.body.addedConvo = { agent_id: 'agent_x', endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('ADMIN bypasses MULTI_CONVO check', async () => {
      req.user.role = SystemRoles.ADMIN;
      req.body.addedConvo = { agent_id: 'ephemeral_x', endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('addedConvo — agent_id shape validation', () => {
    test('calls next when agent_id is ephemeral', async () => {
      req.body.addedConvo = { agent_id: 'ephemeral_xyz', endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('calls next when agent_id is absent', async () => {
      req.body.addedConvo = { endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('calls next when agent_id is not a string (object injection)', async () => {
      req.body.addedConvo = { agent_id: { $gt: '' }, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('addedConvo — agent resource ACL (IDOR prevention)', () => {
    let addedAgent;

    beforeEach(async () => {
      addedAgent = await createAgent({
        id: `agent_added_${Date.now()}`,
        name: 'Private Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 15,
        grantedBy: otherUser._id,
      });
    });

    test('returns 403 when requester has no ACL for the added agent', async () => {
      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Insufficient permissions to access this agent',
        }),
      );
    });

    test('returns 404 when added agent does not exist', async () => {
      req.body.addedConvo = {
        agent_id: 'agent_nonexistent_999',
        endpoint: 'agents',
        model: 'gpt-4',
      };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('proceeds when requester has ACL for the added agent', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('denies when ACL permission bits are insufficient', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 2 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('caches resolved agent on req.resolvedAddedAgent', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.resolvedAddedAgent).toBeDefined();
      expect(req.resolvedAddedAgent._id.toString()).toBe(addedAgent._id.toString());
    });

    test('ADMIN bypasses agent resource ACL for addedConvo', async () => {
      req.user.role = SystemRoles.ADMIN;
      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.resolvedAddedAgent).toBeUndefined();
    });
  });

  describe('end-to-end: primary real agent + addedConvo real agent', () => {
    let primaryAgent, addedAgent;

    beforeEach(async () => {
      primaryAgent = await createAgent({
        id: `agent_primary_${Date.now()}`,
        name: 'Primary Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: primaryAgent._id,
        permBits: 15,
        grantedBy: testUser._id,
      });

      addedAgent = await createAgent({
        id: `agent_added_${Date.now()}`,
        name: 'Added Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 15,
        grantedBy: otherUser._id,
      });

      req.body.agent_id = primaryAgent.id;
    });

    test('both checks pass when user has ACL for both agents', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.resolvedAddedAgent).toBeDefined();
    });

    test('primary passes but addedConvo denied → 403', async () => {
      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('primary denied → 403 without reaching addedConvo check', async () => {
      const foreignAgent = await createAgent({
        id: `agent_foreign_${Date.now()}`,
        name: 'Foreign Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: foreignAgent._id,
        permBits: 15,
        grantedBy: otherUser._id,
      });

      req.body.agent_id = foreignAgent.id;
      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('ephemeral primary + real addedConvo agent', () => {
    let addedAgent;

    beforeEach(async () => {
      addedAgent = await createAgent({
        id: `agent_added_${Date.now()}`,
        name: 'Added Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherUser._id,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 15,
        grantedBy: otherUser._id,
      });
    });

    test('runs full addedConvo ACL check even when primary is ephemeral', async () => {
      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('proceeds when user has ACL for added agent (ephemeral primary)', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: addedAgent._id,
        permBits: 1,
        grantedBy: otherUser._id,
      });

      req.body.addedConvo = { agent_id: addedAgent.id, endpoint: 'agents', model: 'gpt-4' };

      const middleware = canAccessAgentFromBody({ requiredPermission: 1 });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
