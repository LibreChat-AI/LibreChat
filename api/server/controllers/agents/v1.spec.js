const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { nanoid } = require('nanoid');
const { v4: uuidv4 } = require('uuid');
const { createModels, tenantStorage, SystemCapabilities } = require('@librechat/data-schemas');
const {
  Tools,
  SkillsScope,
  FileSources,
  Permissions,
  PermissionBits,
  PermissionTypes,
  PrincipalModel,
  PrincipalType,
  ResourceType,
  actionDelimiter,
} = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Only mock the dependencies that are not database-related
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({
    web_search: true,
    execute_code: true,
    file_search: true,
  }),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({}),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)),
  })),
);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  mergeDeploymentSkillIds: jest.fn((ids) => ids),
  refreshS3Url: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  findPubliclyAccessibleResources: jest.fn().mockResolvedValue([]),
  getResourcePermissionsMap: jest.fn().mockResolvedValue(new Map()),
  grantPermission: jest.fn(),
  hasPublicPermission: jest.fn().mockResolvedValue(false),
}));

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  const methods = createMethods(mongoose, {
    removeAllPermissions: jest.fn().mockResolvedValue(undefined),
  });
  return {
    ...methods,
    getCategoriesWithCounts: jest.fn(),
    deleteFileByFilter: jest.fn(),
  };
});

// Mock cache for S3 avatar refresh tests
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
};
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => mockCache),
}));

const {
  createAgent: createAgentHandler,
  getAgent: getAgentHandler,
  getAgentVersions: getAgentVersionsHandler,
  duplicateAgent: duplicateAgentHandler,
  revertAgentVersion: revertAgentVersionHandler,
  updateAgent: updateAgentHandler,
  getListAgents: getListAgentsHandler,
} = require('./v1');

const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
  getResourcePermissionsMap,
} = require('~/server/services/PermissionService');

const {
  CONTENT_TRAVERSAL_MAX_DEPTH,
  createAgentManagementAuth,
  createAgentManagementCreateHandler,
  createAgentManagementDeleteHandler,
  createAgentManagementReadHandlers,
  createAgentManagementUpdateHandler,
  mergeDeploymentSkillIds,
  refreshS3Url,
} = require('@librechat/api');
const { grantPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const db = require('~/models');

/**
 * @type {import('mongoose').Model<import('@librechat/data-schemas').IAgent>}
 */
let Agent;
let AclEntry;
let User;

const OWNER_PERMISSION_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

const createOwner = (overrides = {}) =>
  User.create({
    name: 'Agent Owner',
    email: `owner-${nanoid(8)}@example.com`,
    provider: 'local',
    emailVerified: true,
    ...overrides,
  });

const createOverflowingActionValue = () => {
  const root = { visible: 'safe visible value' };
  let current = root;
  for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
    current.nested = {};
    current = current.nested;
  }
  current.nested = { hidden: 'BLOCK-HIDDEN' };
  return root;
};

const grantAgentOwner = ({ agent, owner, grantedAt = new Date() }) =>
  AclEntry.create({
    principalType: PrincipalType.USER,
    principalModel: PrincipalModel.USER,
    principalId: owner._id,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    permBits: OWNER_PERMISSION_BITS,
    grantedBy: owner._id,
    grantedAt,
  });

describe('Agent Controllers - Mass Assignment Protection', () => {
  let mongoServer;
  let mockReq;
  let mockRes;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    createModels(mongoose);
    Agent = mongoose.models.Agent;
    AclEntry = mongoose.models.AclEntry;
    User = mongoose.models.User;
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    await AclEntry.deleteMany({});
    await User.deleteMany({});
    await mongoose.models.File.deleteMany({});

    // Reset all mocks
    jest.clearAllMocks();
    mergeDeploymentSkillIds.mockImplementation((ids) => ids);

    // Setup mock request and response objects
    mockReq = {
      user: {
        id: new mongoose.Types.ObjectId().toString(),
        role: 'USER',
      },
      body: {},
      params: {},
      query: {},
      app: {
        locals: {
          fileStrategy: 'local',
        },
      },
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('createAgentHandler', () => {
    test('removes programmatic tool options when Code Interpreter capability is disabled', async () => {
      mockReq.body = {
        name: 'Invalid Programmatic Agent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [Tools.execute_code, 'search_mcp_example'],
        tool_options: {
          search_mcp_example: { allowed_callers: ['code_execution'] },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('rejects a stateful environment excluded by deployment policy', async () => {
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { allowedEnvironments: ['user'] },
          },
        },
      };
      mockReq.body = {
        name: 'Disallowed Stateful Agent',
        provider: 'openai',
        model: 'gpt-4',
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('rejects an unconfigured code environment id', async () => {
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'configured-vm',
                  name: 'Configured VM',
                  type: 'attached',
                  baseURL: 'https://code.example.com/v1',
                  default: true,
                },
              ],
            },
          },
        },
      };
      mockReq.body = {
        name: 'Invalid Environment Agent',
        provider: 'openai',
        model: 'gpt-4',
        stateful_code_sessions: true,
        code_environment_id: 'missing-vm',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('rejects a pairing-only control plane as a code environment id', async () => {
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'personal-workers',
                  name: 'Personal workers',
                  type: 'attached',
                  baseURL: 'https://code.example.com/v1',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      };
      mockReq.body = {
        name: 'Invalid Control Plane Agent',
        provider: 'openai',
        model: 'gpt-4',
        stateful_code_sessions: true,
        code_environment_id: 'personal-workers',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('rejects a workspace default without an explicit attached environment', async () => {
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'default-vm',
                  name: 'Default VM',
                  type: 'attached',
                  baseURL: 'https://code.example.com/v1',
                  default: true,
                },
              ],
            },
          },
        },
      };
      mockReq.body = {
        name: 'Unbound Workspace Agent',
        provider: 'openai',
        model: 'gpt-4',
        code_workspace_id: 'project-a',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Code workspace defaults require an explicit attached code environment',
      });
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('rejects a workspace default for a managed environment', async () => {
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'managed-runtime',
                  name: 'Managed Runtime',
                  type: 'managed',
                  baseURL: 'https://code.example.com/v1',
                },
              ],
            },
          },
        },
      };
      mockReq.body = {
        name: 'Managed Workspace Agent',
        provider: 'openai',
        model: 'gpt-4',
        code_environment_id: 'managed-runtime',
        code_workspace_id: 'project-a',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Code workspace defaults require an explicit attached code environment',
      });
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('should block configured agent instruction content before persistence', async () => {
      mockReq.config = {
        filters: {
          agentInstructions: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockReq.body = {
        name: 'Filtered Agent',
        provider: 'openai',
        model: 'gpt-4',
        instructions: 'Use sk-private-token for requests',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'instructions',
        }),
      );
      await expect(Agent.countDocuments()).resolves.toBe(0);
    });

    test('should create agent with allowed fields only', async () => {
      const validData = {
        name: 'Test Agent',
        description: 'A test agent',
        instructions: 'Be helpful',
        provider: 'openai',
        model: 'gpt-4',
        tools: ['web_search'],
        model_parameters: { temperature: 0.7 },
        tool_resources: {
          file_search: { file_ids: ['file1', 'file2'] },
        },
      };

      mockReq.body = validData;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalled();

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.name).toBe('Test Agent');
      expect(createdAgent.description).toBe('A test agent');
      expect(createdAgent.provider).toBe('openai');
      expect(createdAgent.model).toBe('gpt-4');
      expect(createdAgent.author.toString()).toBe(mockReq.user.id);
      expect(createdAgent.tools).toContain('web_search');

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb).toBeDefined();
      expect(agentInDb.name).toBe('Test Agent');
      expect(agentInDb.author.toString()).toBe(mockReq.user.id);
    });

    test('management creation can be updated and read through the authenticated management API', async () => {
      const tenantId = `tenant-${nanoid(8)}`;
      const clientId = `client-${nanoid(8)}`;
      const principal = await tenantStorage.run({ tenantId }, () => createOwner());
      const userId = principal._id.toString();
      const getRoleByName = jest.fn().mockResolvedValue({
        permissions: {
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
          },
        },
      });
      grantPermission.mockImplementation(
        async ({ principalType, principalId, resourceType, resourceId, grantedBy }) =>
          AclEntry.create({
            principalType,
            principalModel: PrincipalModel.USER,
            principalId,
            resourceType,
            resourceId,
            permBits: OWNER_PERMISSION_BITS,
            grantedBy,
            grantedAt: new Date(),
          }),
      );
      const auth = createAgentManagementAuth({
        findUser: db.findUser,
        isPrincipalActive: jest.fn().mockResolvedValue(true),
        getAppConfig: jest.fn().mockResolvedValue({
          endpoints: {
            agents: {
              managementApi: {
                auth: {
                  oidc: {
                    enabled: true,
                    audience: 'agent-management',
                    issuer: 'https://issuer.example.com/',
                  },
                  clients: [{ clientId, tenantId, userId }],
                },
              },
            },
          },
        }),
        verifyAccessToken: jest.fn().mockResolvedValue({
          azp: clientId,
          sub: `${clientId}@clients`,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      });
      const create = createAgentManagementCreateHandler({
        getRoleByName,
        createAgent: createAgentHandler,
      });
      const checkAgentPermission = async ({
        userId: accessibleUserId,
        resourceType,
        resourceId,
        requiredPermission,
      }) =>
        (await AclEntry.exists({
          principalId: accessibleUserId,
          resourceType,
          resourceId,
          permBits: { $bitsAllSet: requiredPermission },
        })) != null;
      const hasCapability = jest.fn().mockResolvedValue(false);
      const reads = createAgentManagementReadHandlers({
        getRoleByName,
        getAgentWithVersionCount: db.getAgentWithVersionCount,
        getAgentManagementListByAccess: db.getAgentManagementListByAccess,
        findAccessibleResources: async ({ userId: accessibleUserId, resourceType }) =>
          AclEntry.distinct('resourceId', {
            principalId: accessibleUserId,
            resourceType,
            permBits: { $bitsAllSet: PermissionBits.EDIT },
          }),
        checkPermission: checkAgentPermission,
        hasCapability,
      });
      const update = createAgentManagementUpdateHandler({
        getRoleByName,
        getAgentWithVersionCount: db.getAgentWithVersionCount,
        checkPermission: checkAgentPermission,
        hasCapability,
        updateAgent: updateAgentHandler,
      });
      const remove = createAgentManagementDeleteHandler({
        getRoleByName,
        getAgentWithVersionCount: db.getAgentWithVersionCount,
        checkPermission: checkAgentPermission,
        hasCapability,
        deleteAgent: db.deleteAgent,
      });
      const app = express();
      app.use(express.json());
      app.use('/api/agents/v1/agents', auth);
      app.post('/api/agents/v1/agents', (req, res) => {
        req.config = {};
        return create(req, res);
      });
      app.get('/api/agents/v1/agents', reads.list);
      app.get('/api/agents/v1/agents/:id', reads.get);
      app.patch('/api/agents/v1/agents/:id', (req, res) => {
        req.config = {};
        return update(req, res);
      });
      app.delete('/api/agents/v1/agents/:id', remove);

      const createdResponse = await request(app)
        .post('/api/agents/v1/agents')
        .set('Authorization', 'Bearer valid-token')
        .send({
          name: 'Managed Agent',
          description: 'Description that remains unchanged',
          provider: 'openai',
          model: 'gpt-4',
          avatar: { filepath: 'avatars/managed.png', source: 'local' },
          conversation_starters: ['Help me get started'],
        });

      expect(createdResponse.status).toBe(201);
      expect(createdResponse.body).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^agent_/),
          name: 'Managed Agent',
          provider: 'openai',
          model: 'gpt-4',
          version: 1,
        }),
      );
      expect(createdResponse.body).not.toHaveProperty('_id');
      expect(createdResponse.body).not.toHaveProperty('author');
      expect(createdResponse.body).not.toHaveProperty('tenantId');

      const [retrievedResponse, listedResponse] = await Promise.all([
        request(app)
          .get(`/api/agents/v1/agents/${createdResponse.body.id}`)
          .set('Authorization', 'Bearer valid-token'),
        request(app).get('/api/agents/v1/agents').set('Authorization', 'Bearer valid-token'),
      ]);

      expect(retrievedResponse.status).toBe(200);
      expect(retrievedResponse.body).toEqual(createdResponse.body);
      expect(listedResponse.status).toBe(200);
      expect(listedResponse.body.data).toEqual([createdResponse.body]);

      const otherTenantId = `tenant-${nanoid(8)}`;
      const currentTenantGraphId = `agent_${nanoid()}`;
      const otherTenantGraphId = `agent_${nanoid()}`;
      await tenantStorage.run({ tenantId }, async () => {
        await Agent.create({
          id: currentTenantGraphId,
          name: 'Current tenant graph',
          provider: 'openai',
          model: 'gpt-4',
          author: principal._id,
          edges: [{ from: '', to: createdResponse.body.id, edgeType: 'handoff' }],
        });
        await User.updateOne(
          { _id: principal._id },
          { $set: { favorites: [{ agentId: createdResponse.body.id }] } },
        );
      });
      const otherTenantPrincipal = await tenantStorage.run(
        { tenantId: otherTenantId },
        async () => {
          const owner = await createOwner();
          await Agent.create({
            id: createdResponse.body.id,
            name: 'Other tenant Agent',
            provider: 'openai',
            model: 'gpt-4',
            author: owner._id,
          });
          await Agent.create({
            id: otherTenantGraphId,
            name: 'Other tenant graph',
            provider: 'openai',
            model: 'gpt-4',
            author: owner._id,
            edges: [{ from: '', to: createdResponse.body.id, edgeType: 'handoff' }],
          });
          await User.updateOne(
            { _id: owner._id },
            { $set: { favorites: [{ agentId: createdResponse.body.id }] } },
          );
          return owner;
        },
      );

      const updatedResponse = await request(app)
        .patch(`/api/agents/v1/agents/${createdResponse.body.id}`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          name: 'Updated Managed Agent',
          avatar: null,
          conversation_starters: [],
        });

      expect(updatedResponse.status).toBe(200);
      expect(updatedResponse.body).toEqual(
        expect.objectContaining({
          id: createdResponse.body.id,
          name: 'Updated Managed Agent',
          description: 'Description that remains unchanged',
          avatar: null,
          conversation_starters: [],
          version: 2,
        }),
      );
      expect(updatedResponse.body).not.toHaveProperty('_id');
      expect(updatedResponse.body).not.toHaveProperty('author');
      expect(updatedResponse.body).not.toHaveProperty('tenantId');

      const retrievedAfterUpdate = await request(app)
        .get(`/api/agents/v1/agents/${createdResponse.body.id}`)
        .set('Authorization', 'Bearer valid-token');
      expect(retrievedAfterUpdate.status).toBe(200);
      expect(retrievedAfterUpdate.body).toEqual(updatedResponse.body);

      const created = await Agent.collection.findOne({
        id: createdResponse.body.id,
        tenantId,
      });
      const otherTenantAgent = await Agent.collection.findOne({
        id: createdResponse.body.id,
        tenantId: otherTenantId,
      });
      expect(created.tenantId).toBe(tenantId);
      expect(created.author.toString()).toBe(userId);
      expect(created.name).toBe('Updated Managed Agent');
      expect(created.description).toBe('Description that remains unchanged');
      expect(created.avatar).toBeNull();
      expect(created.conversation_starters).toEqual([]);
      expect(created.versions).toHaveLength(2);
      expect(otherTenantAgent.name).toBe('Other tenant Agent');
      expect(grantPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
        }),
      );

      const deletedResponse = await request(app)
        .delete(`/api/agents/v1/agents/${createdResponse.body.id}`)
        .set('Authorization', 'Bearer valid-token');
      expect(deletedResponse.status).toBe(200);
      expect(deletedResponse.body).toEqual({ id: createdResponse.body.id, deleted: true });

      const [retrievedAfterDelete, repeatedDelete] = await Promise.all([
        request(app)
          .get(`/api/agents/v1/agents/${createdResponse.body.id}`)
          .set('Authorization', 'Bearer valid-token'),
        request(app)
          .delete(`/api/agents/v1/agents/${createdResponse.body.id}`)
          .set('Authorization', 'Bearer valid-token'),
      ]);
      expect(retrievedAfterDelete.status).toBe(404);
      expect(repeatedDelete.status).toBe(404);
      await expect(Agent.exists({ id: createdResponse.body.id, tenantId })).resolves.toBeNull();
      await expect(
        Agent.exists({ id: createdResponse.body.id, tenantId: otherTenantId }),
      ).resolves.not.toBeNull();
      await expect(
        Agent.exists({
          id: currentTenantGraphId,
          tenantId,
          'edges.to': createdResponse.body.id,
        }),
      ).resolves.toBeNull();
      await expect(
        Agent.exists({
          id: otherTenantGraphId,
          tenantId: otherTenantId,
          'edges.to': createdResponse.body.id,
        }),
      ).resolves.not.toBeNull();
      await expect(
        User.exists({
          _id: principal._id,
          tenantId,
          'favorites.agentId': createdResponse.body.id,
        }),
      ).resolves.toBeNull();
      await expect(
        User.exists({
          _id: otherTenantPrincipal._id,
          tenantId: otherTenantId,
          'favorites.agentId': createdResponse.body.id,
        }),
      ).resolves.not.toBeNull();
    });

    test('management creation rejects caller-controlled ownership', async () => {
      const handler = createAgentManagementCreateHandler({
        getRoleByName: jest.fn().mockResolvedValue({
          permissions: {
            [PermissionTypes.AGENTS]: {
              [Permissions.USE]: true,
              [Permissions.CREATE]: true,
            },
          },
        }),
        createAgent: createAgentHandler,
      });
      mockReq.user.tenantId = 'tenant-a';
      mockReq.body = {
        name: 'Managed Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId().toString(),
      };

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(await Agent.countDocuments()).toBe(0);
    });

    test('should reject creation with unauthorized fields (mass assignment protection)', async () => {
      const maliciousData = {
        // Required fields
        provider: 'openai',
        model: 'gpt-4',
        name: 'Malicious Agent',

        // Unauthorized fields that should be stripped
        author: new mongoose.Types.ObjectId().toString(), // Should not be able to set author
        authorName: 'Hacker', // Should be stripped
        versions: [], // Should be stripped
        _id: new mongoose.Types.ObjectId(), // Should be stripped
        id: 'custom_agent_id', // Should be overridden
        createdAt: new Date('2020-01-01'), // Should be stripped
        updatedAt: new Date('2020-01-01'), // Should be stripped
      };

      mockReq.body = maliciousData;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];

      // Verify unauthorized fields were not set
      expect(createdAgent.author.toString()).toBe(mockReq.user.id); // Should be the request user, not the malicious value
      expect(createdAgent.authorName).toBeUndefined();
      expect(createdAgent.versions).toHaveLength(1); // Should have exactly 1 version from creation
      expect(createdAgent.id).not.toBe('custom_agent_id'); // Should have generated ID
      expect(createdAgent.id).toMatch(/^agent_/); // Should have proper prefix

      // Verify timestamps are recent (not the malicious dates)
      const createdTime = new Date(createdAgent.createdAt).getTime();
      const now = Date.now();
      expect(now - createdTime).toBeLessThan(5000); // Created within last 5 seconds

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.author.toString()).toBe(mockReq.user.id);
      expect(agentInDb.authorName).toBeUndefined();
    });

    test('should validate required fields', async () => {
      const invalidData = {
        name: 'Missing Required Fields',
        // Missing provider and model
      };

      mockReq.body = invalidData;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request data',
          details: expect.any(Array),
        }),
      );

      // Verify nothing was created in database
      const count = await Agent.countDocuments();
      expect(count).toBe(0);
    });

    test('should handle tool_resources validation', async () => {
      const dataWithInvalidToolResources = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Tool Resources',
        tool_resources: {
          // Valid resources
          file_search: {
            file_ids: ['file1', 'file2'],
            vector_store_ids: ['vs1'],
          },
          execute_code: {
            file_ids: ['file3'],
          },
          // Invalid resource (should be stripped by schema)
          invalid_resource: {
            file_ids: ['file4'],
          },
        },
      };

      mockReq.body = dataWithInvalidToolResources;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.tool_resources).toBeDefined();
      expect(createdAgent.tool_resources.file_search).toBeDefined();
      expect(createdAgent.tool_resources.execute_code).toBeDefined();
      expect(createdAgent.tool_resources.invalid_resource).toBeUndefined(); // Should be stripped

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.tool_resources.invalid_resource).toBeUndefined();
    });

    test('should strip runtime file records before persisting an agent', async () => {
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with forged runtime file',
        tool_resources: {
          execute_code: {
            files: [
              {
                file_id: 'forged-file',
                filepath: '/etc/passwd',
                source: FileSources.local,
              },
            ],
          },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.tool_resources?.execute_code?.files).toBeUndefined();

      const agentInDb = await Agent.findOne({ id: createdAgent.id }).lean();
      expect(agentInDb.tool_resources?.execute_code?.files).toBeUndefined();
      expect(agentInDb.versions[0].tool_resources?.execute_code?.files).toBeUndefined();
    });

    test('should strip file_ids not owned by the creator from tool_resources', async () => {
      const File = mongoose.models.File;

      const ownedFileId = `file_${uuidv4()}`;
      const otherFileId = `file_${uuidv4()}`;
      await File.create({
        file_id: ownedFileId,
        user: mockReq.user.id,
        filename: `${ownedFileId}.txt`,
        filepath: `/tmp/${ownedFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      await File.create({
        file_id: otherFileId,
        user: new mongoose.Types.ObjectId(),
        filename: `${otherFileId}.txt`,
        filepath: `/tmp/${otherFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });

      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Files',
        tool_resources: {
          file_search: { file_ids: [ownedFileId, otherFileId] },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.tool_resources.file_search.file_ids).toEqual([ownedFileId]);
    });

    test('hydrates owned file_ids before fail-close agent resource inspection', async () => {
      const File = mongoose.models.File;
      const ownedFileId = `file_${uuidv4()}`;
      await File.create({
        file_id: ownedFileId,
        user: mockReq.user.id,
        filename: `${ownedFileId}.txt`,
        filepath: `/tmp/${ownedFileId}`,
        text: 'safe extracted text',
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      mockReq.config = {
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      };
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with inspected files',
        tool_resources: {
          file_search: { file_ids: [ownedFileId] },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json.mock.calls[0][0].tool_resources.file_search.file_ids).toEqual([
        ownedFileId,
      ]);
    });

    test('blocks agent creation when hydrated resource text matches file policy', async () => {
      const File = mongoose.models.File;
      const ownedFileId = `file_${uuidv4()}`;
      await File.create({
        file_id: ownedFileId,
        user: mockReq.user.id,
        filename: `${ownedFileId}.txt`,
        filepath: `/tmp/${ownedFileId}`,
        text: 'PRIVATE-CANONICAL-CONTEXT',
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      mockReq.config = {
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-canonical-context',
                  label: 'private canonical context',
                  regex: 'PRIVATE-CANONICAL-CONTEXT',
                },
              ],
              uninspectable: 'block',
            },
          },
        },
      };
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with blocked files',
        tool_resources: {
          file_search: { file_ids: [ownedFileId] },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'file',
          field: 'extracted_text',
        }),
      );
      await expect(Agent.countDocuments()).resolves.toBe(0);
    });

    test('canonicalizes hydrated tool resource files before create persistence', async () => {
      const File = mongoose.models.File;
      const ownedFileId = `file_${uuidv4()}`;
      const otherFileId = `file_${uuidv4()}`;
      await File.create({
        file_id: ownedFileId,
        user: mockReq.user.id,
        filename: `${ownedFileId}.txt`,
        filepath: `/tmp/${ownedFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      await File.create({
        file_id: otherFileId,
        user: new mongoose.Types.ObjectId(),
        filename: `${otherFileId}.txt`,
        filepath: `/tmp/${otherFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Hydrated Files',
        tool_resources: {
          execute_code: {
            files: [
              { file_id: ownedFileId, filename: 'PRIVATE-SENTINEL' },
              { file_id: otherFileId, metadata: { codeEnvRef: { file_id: 'untrusted' } } },
            ],
          },
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.tool_resources.execute_code.file_ids).toEqual([ownedFileId]);
      expect(createdAgent.tool_resources.execute_code.files).toBeUndefined();
      expect(JSON.stringify(createdAgent)).not.toContain('PRIVATE-SENTINEL');
      expect(JSON.stringify(createdAgent)).not.toContain('untrusted');
    });

    test('should handle support_contact with empty strings', async () => {
      const dataWithEmptyContact = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Empty Contact',
        support_contact: {
          name: '',
          email: '',
        },
      };

      mockReq.body = dataWithEmptyContact;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.name).toBe('Agent with Empty Contact');
      expect(createdAgent.support_contact).toBeDefined();
      expect(createdAgent.support_contact.name).toBe('');
      expect(createdAgent.support_contact.email).toBe('');
    });

    test('should handle support_contact with valid email', async () => {
      const dataWithValidContact = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Valid Contact',
        support_contact: {
          name: 'Support Team',
          email: 'support@example.com',
        },
      };

      mockReq.body = dataWithValidContact;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.support_contact).toBeDefined();
      expect(createdAgent.support_contact.name).toBe('Support Team');
      expect(createdAgent.support_contact.email).toBe('support@example.com');
    });

    test('should reject support_contact with invalid email', async () => {
      const dataWithInvalidEmail = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Invalid Email',
        support_contact: {
          name: 'Support',
          email: 'not-an-email',
        },
      };

      mockReq.body = dataWithInvalidEmail;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request data',
          details: expect.arrayContaining([
            expect.objectContaining({
              path: ['support_contact', 'email'],
            }),
          ]),
        }),
      );
    });

    test('should handle avatar validation', async () => {
      const dataWithAvatar = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Avatar',
        avatar: {
          filepath: 'https://example.com/avatar.png',
          source: 's3',
        },
      };

      mockReq.body = dataWithAvatar;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.avatar).toEqual({
        filepath: 'https://example.com/avatar.png',
        source: 's3',
      });
    });

    test('should remove empty strings from model_parameters (Issue Fix)', async () => {
      // This tests the fix for empty strings being sent to API instead of being omitted
      // When a user clears a numeric field (like max_tokens), it should be removed, not sent as ""
      const dataWithEmptyModelParams = {
        provider: 'azureOpenAI',
        model: 'gpt-4',
        name: 'Agent with Empty Model Params',
        model_parameters: {
          temperature: 0.7, // Valid number - should be preserved
          max_tokens: '', // Empty string - should be removed
          maxContextTokens: '', // Empty string - should be removed
          topP: 0, // Zero value - should be preserved (not treated as empty)
          frequency_penalty: '', // Empty string - should be removed
        },
      };

      mockReq.body = dataWithEmptyModelParams;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.model_parameters).toBeDefined();
      // Valid numbers should be preserved
      expect(createdAgent.model_parameters.temperature).toBe(0.7);
      expect(createdAgent.model_parameters.topP).toBe(0);
      // Empty strings should be removed
      expect(createdAgent.model_parameters.max_tokens).toBeUndefined();
      expect(createdAgent.model_parameters.maxContextTokens).toBeUndefined();
      expect(createdAgent.model_parameters.frequency_penalty).toBeUndefined();

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.model_parameters.temperature).toBe(0.7);
      expect(agentInDb.model_parameters.topP).toBe(0);
      expect(agentInDb.model_parameters.max_tokens).toBeUndefined();
      expect(agentInDb.model_parameters.maxContextTokens).toBeUndefined();
    });

    test('should drop non-numeric strings and coerce numeric strings in model_parameters', async () => {
      // Regression test for #12920: a stray placeholder string ("System") persisted
      // into max_tokens was forwarded to the provider, causing a 400
      const dataWithCorruptModelParams = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Corrupt Model Params',
        model_parameters: {
          max_tokens: 'System',
          maxContextTokens: '256000',
          fileTokenLimit: 256000,
          useResponsesApi: true,
        },
      };

      mockReq.body = dataWithCorruptModelParams;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.model_parameters.max_tokens).toBeUndefined();
      expect(createdAgent.model_parameters.maxContextTokens).toBe(256000);
      expect(createdAgent.model_parameters.fileTokenLimit).toBe(256000);
      expect(createdAgent.model_parameters.useResponsesApi).toBe(true);

      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.model_parameters.max_tokens).toBeUndefined();
      expect(agentInDb.model_parameters.maxContextTokens).toBe(256000);
    });

    test('should handle invalid avatar format', async () => {
      const dataWithInvalidAvatar = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Agent with Invalid Avatar',
        avatar: 'just-a-string', // Invalid format
      };

      mockReq.body = dataWithInvalidAvatar;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request data',
        }),
      );
    });
  });

  describe('getAgentHandler', () => {
    test('should return the safe Responses API flag in the basic VIEW response', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Azure Agent',
        description: 'Uses Responses API',
        provider: 'azureOpenAI',
        model: 'gpt-5.5',
        author: mockReq.user.id,
        model_parameters: {
          useResponsesApi: true,
          temperature: 0.7,
          apiKey: 'secret-value',
        },
      });

      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.model_parameters).toEqual({ useResponsesApi: true });
      expect(response.model_parameters.temperature).toBeUndefined();
      expect(response.model_parameters.apiKey).toBeUndefined();
    });

    test('should return owner_contact from the first ACL owner when support_contact is missing', async () => {
      const owner = await createOwner({
        name: 'Primary Owner',
        email: 'primary.owner@example.com',
      });
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Owner Contact Agent',
        description: 'Uses owner fallback',
        provider: 'openai',
        model: 'gpt-4',
        author: owner._id,
      });
      await grantAgentOwner({ agent, owner });

      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.owner_contact).toEqual({ name: 'Primary Owner' });
      expect(response.owner_contact).not.toHaveProperty('email');
    });

    test('should omit owner_contact when the owner name and username are the account email', async () => {
      const email = 'sso.owner@example.com';
      const owner = await createOwner({ name: email, username: email, email });
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'SSO Owner Agent',
        description: 'Owner has email-shaped name from SSO fallback',
        provider: 'openai',
        model: 'gpt-4',
        author: owner._id,
      });
      await grantAgentOwner({ agent, owner });

      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.owner_contact).toBeUndefined();
    });

    test('should not return owner_contact when support_contact is present', async () => {
      const owner = await createOwner({
        name: 'Primary Owner',
        email: 'primary.owner@example.com',
      });
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Support Contact Agent',
        description: 'Uses support contact',
        provider: 'openai',
        model: 'gpt-4',
        author: owner._id,
        support_contact: { name: 'Support Team', email: 'support@example.com' },
      });
      await grantAgentOwner({ agent, owner });

      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.support_contact).toEqual({
        name: 'Support Team',
        email: 'support@example.com',
      });
      expect(response.owner_contact).toBeUndefined();
    });

    test('should include conversation_starters in the basic VIEW response', async () => {
      const starters = ['Summarize this page', 'What can you do?'];
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Starter Agent',
        description: 'Exposes conversation starters',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        conversation_starters: starters,
      });

      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.conversation_starters).toEqual(starters);
    });
  });

  describe('getAgentVersionsHandler', () => {
    test('returns the version history and excludes it from the basic VIEW response', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Versioned Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        versions: [
          { name: 'V1', provider: 'openai', model: 'gpt-4', updatedAt: new Date() },
          { name: 'V2', provider: 'openai', model: 'gpt-4', updatedAt: new Date() },
        ],
      });
      mockReq.params = { id: agent.id };

      await getAgentHandler(mockReq, mockRes);
      const basicResponse = mockRes.json.mock.calls[0][0];
      expect(basicResponse.versions).toBeUndefined();
      expect(basicResponse.version).toBe(2);

      mockRes.json.mockClear();
      await getAgentVersionsHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const versions = mockRes.json.mock.calls[0][0];
      expect(Array.isArray(versions)).toBe(true);
      expect(versions).toHaveLength(2);
      expect(versions.map((v) => v.name)).toEqual(['V1', 'V2']);
    });

    test('returns 404 when the agent does not exist', async () => {
      mockReq.params = { id: `agent_${uuidv4()}` };

      await getAgentVersionsHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  describe('updateAgentHandler', () => {
    let existingAgentId;
    let existingAgentAuthorId;

    beforeEach(async () => {
      // Create an existing agent for update tests
      existingAgentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Original Agent',
        provider: 'openai',
        model: 'gpt-3.5-turbo',
        author: existingAgentAuthorId,
        description: 'Original description',
        versions: [
          {
            name: 'Original Agent',
            provider: 'openai',
            model: 'gpt-3.5-turbo',
            description: 'Original description',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
      existingAgentId = agent.id;
    });

    test('should update agent with allowed fields only', async () => {
      mockReq.user.id = existingAgentAuthorId.toString(); // Set as author
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Updated Agent',
        description: 'Updated description',
        model: 'gpt-4',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.status).not.toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.name).toBe('Updated Agent');
      expect(updatedAgent.description).toBe('Updated description');
      expect(updatedAgent.model).toBe('gpt-4');
      expect(updatedAgent.author).toBe(existingAgentAuthorId.toString());

      // Verify in database
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.name).toBe('Updated Agent');
    });

    test('removes newly added programmatic options when Code Interpreter capability is disabled', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        { tools: [Tools.execute_code, 'search_mcp_example'] },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_options: {
          search_mcp_example: { allowed_callers: ['code_execution'] },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('removes programmatic callers when Code Interpreter is disabled', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: [Tools.execute_code, 'search_mcp_example'],
          tool_options: {
            search_mcp_example: {
              allowed_callers: ['code_execution'],
              defer_loading: true,
            },
          },
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { tools: ['search_mcp_example'] };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({
        search_mcp_example: { defer_loading: true },
      });
    });

    test('allows unrelated edits to a legacy inconsistent agent', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: ['search_mcp_example'],
          tool_options: {
            search_mcp_example: { allowed_callers: ['code_execution'] },
          },
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { description: 'Still saveable' };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].description).toBe('Still saveable');
    });

    test('allows detaching a programmatic tool from a legacy inconsistent agent', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: ['search_mcp_example'],
          tool_options: {
            search_mcp_example: { allowed_callers: ['code_execution'] },
          },
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { tools: [] };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].tools).toEqual([]);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('allows clearing programmatic options from a legacy inconsistent agent', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: ['search_mcp_example'],
          tool_options: {
            search_mcp_example: { allowed_callers: ['code_execution'] },
          },
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { tool_options: {} };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('removes all newly submitted programmatic options from a legacy agent', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: ['search_mcp_example', 'lookup_mcp_example'],
          tool_options: {
            search_mcp_example: { allowed_callers: ['code_execution'] },
          },
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_options: {
          search_mcp_example: { allowed_callers: ['code_execution'] },
          lookup_mcp_example: { allowed_callers: ['code_execution'] },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('rejects selecting a stateful environment excluded by deployment policy', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { allowedEnvironments: ['user'] },
          },
        },
      };
      mockReq.body = {
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.stateful_code_sessions).not.toBe(true);
    });

    test('rejects updating an agent to an unconfigured code environment id', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [],
            },
          },
        },
      };
      mockReq.body = { code_environment_id: 'missing-vm' };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.code_environment_id).toBeUndefined();
    });

    test('allows a workspace-only update for an existing attached environment', async () => {
      await Agent.updateOne({ id: existingAgentId }, { code_environment_id: 'attached-vm' });
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'attached-vm',
                  name: 'Attached VM',
                  type: 'attached',
                  baseURL: 'https://bridge.example.com/v1',
                },
              ],
            },
          },
        },
      };
      mockReq.body = { code_workspace_id: 'project-a' };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.code_environment_id).toBe('attached-vm');
      expect(agentInDb.code_workspace_id).toBe('project-a');
    });

    test('rejects a workspace-only update without an attached environment', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'default-vm',
                  name: 'Default VM',
                  type: 'attached',
                  baseURL: 'https://bridge.example.com/v1',
                  default: true,
                },
              ],
            },
          },
        },
      };
      mockReq.body = { code_workspace_id: 'project-a' };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.code_workspace_id).toBeUndefined();
    });

    test('allows disabling stateful sessions after the configured environment is removed', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          stateful_code_sessions: true,
          code_environment_id: 'removed-vm',
          code_workspace_id: 'project-a',
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [],
            },
          },
        },
      };
      mockReq.body = {
        stateful_code_sessions: false,
        code_environment_id: 'removed-vm',
        code_workspace_id: 'project-a',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.stateful_code_sessions).toBe(false);
      expect(agentInDb.code_environment_id).toBe('removed-vm');
      expect(agentInDb.code_workspace_id).toBe('project-a');
    });

    test('restores the deployment-default code environment', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          stateful_code_sessions: true,
          code_environment_id: 'attached-vm',
          code_workspace_id: 'project-a',
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'attached-vm',
                  name: 'Attached VM',
                  type: 'attached',
                  baseURL: 'https://bridge.example.com/v1',
                  default: true,
                },
              ],
            },
          },
        },
      };
      mockReq.body = { code_environment_id: null };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.code_environment_id).toBeUndefined();
      expect(agentInDb.code_workspace_id).toBe('');
    });

    test('clears a configured Git identity', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        { git_identity: { name: 'Coding Agent', email: 'agent@example.com' } },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { git_identity: null };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.git_identity).toBeUndefined();
    });

    test('allows unrelated edits to an existing scope after policy is tightened', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        { stateful_code_sessions: true, stateful_code_environment: 'conversation' },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { allowedEnvironments: ['user'] },
          },
        },
      };
      mockReq.body = {
        name: 'Still editable',
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(403);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.name).toBe('Still editable');
      expect(agentInDb.stateful_code_environment).toBe('conversation');
    });

    test('rejects reactivating code execution with a retained disallowed scope', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: [],
          stateful_code_sessions: true,
          stateful_code_environment: 'conversation',
        },
      );
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { allowedEnvironments: ['user'] },
          },
        },
      };
      mockReq.body = { tools: [Tools.execute_code] };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.tools).not.toContain(Tools.execute_code);
    });

    test('rejects graph topology that becomes invalid after self-placeholder rewrite', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.config = {
        endpoints: { agents: { capabilities: ['subagents'] } },
      };
      mockReq.body = {
        subagents: {
          enabled: true,
          allowSelf: false,
          graphs: [
            {
              type: 'collapsed_team',
              name: 'Collapsed team',
              description: 'Becomes invalid after placeholder replacement',
              agent_ids: ['', existingAgentId],
              edges: [{ from: '', to: existingAgentId, edgeType: 'direct' }],
              entry_agent_id: '',
              result_agent_id: existingAgentId,
            },
          ],
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid request data' }),
      );
    });

    test('should sanitize corrupt numeric model_parameters on update', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Healed Agent',
        model_parameters: {
          max_tokens: 'System',
          maxContextTokens: 256000,
          temperature: '0.7',
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.model_parameters.max_tokens).toBeUndefined();
      expect(updatedAgent.model_parameters.maxContextTokens).toBe(256000);
      expect(updatedAgent.model_parameters.temperature).toBe(0.7);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.model_parameters.max_tokens).toBeUndefined();
      expect(agentInDb.model_parameters.maxContextTokens).toBe(256000);
    });

    test('should reject update with unauthorized fields (mass assignment protection)', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Updated Name',

        // Unauthorized fields that should be stripped
        author: new mongoose.Types.ObjectId().toString(), // Should not be able to change author
        authorName: 'Hacker', // Should be stripped
        id: 'different_agent_id', // Should be stripped
        _id: new mongoose.Types.ObjectId(), // Should be stripped
        versions: [], // Should be stripped
        createdAt: new Date('2020-01-01'), // Should be stripped
        updatedAt: new Date('2020-01-01'), // Should be stripped
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];

      // Verify unauthorized fields were not changed
      expect(updatedAgent.author).toBe(existingAgentAuthorId.toString()); // Should not have changed
      expect(updatedAgent.authorName).toBeUndefined();
      expect(updatedAgent.id).toBe(existingAgentId); // Should not have changed
      expect(updatedAgent.name).toBe('Updated Name'); // Only this should have changed

      // Verify in database
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.author.toString()).toBe(existingAgentAuthorId.toString());
      expect(agentInDb.id).toBe(existingAgentId);
    });

    test('should allow admin to update any agent', async () => {
      const adminUserId = new mongoose.Types.ObjectId().toString();
      mockReq.user.id = adminUserId;
      mockReq.user.role = 'ADMIN'; // Set as admin
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Admin Update',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.name).toBe('Admin Update');
    });

    test('should allow an editor to add their own file but not another user file', async () => {
      const File = mongoose.models.File;
      const adminUserId = new mongoose.Types.ObjectId().toString();
      const authorFileId = `file_${uuidv4()}`;
      const adminFileId = `file_${uuidv4()}`;

      await File.create({
        file_id: authorFileId,
        user: existingAgentAuthorId,
        filename: `${authorFileId}.txt`,
        filepath: `/tmp/${authorFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      await File.create({
        file_id: adminFileId,
        user: adminUserId,
        filename: `${adminFileId}.txt`,
        filepath: `/tmp/${adminFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });

      mockReq.user.id = adminUserId;
      mockReq.user.role = 'ADMIN';
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_resources: {
          file_search: { file_ids: [authorFileId, adminFileId] },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
      expect(agentInDb.tool_resources.file_search.file_ids).toEqual([adminFileId]);
    });

    test('should validate tool_resources in updates', async () => {
      // Back these ids with real File docs so the orphan-pruning added for
      // issue #12776 does not strip them — this test is about OCR conversion
      // and schema filtering, not file existence.
      const File = mongoose.models.File;
      for (const id of ['ocr1', 'ocr2', 'img1']) {
        await File.create({
          file_id: id,
          user: existingAgentAuthorId,
          filename: `${id}.txt`,
          filepath: `/tmp/${id}`,
          object: 'file',
          type: 'text/plain',
          bytes: 1,
          source: FileSources.local,
        });
      }

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_resources: {
          /** Legacy conversion from `ocr` to `context` */
          ocr: {
            file_ids: ['ocr1', 'ocr2'],
          },
          execute_code: {
            file_ids: ['img1'],
          },
          // Invalid tool resource
          invalid_tool: {
            file_ids: ['invalid'],
          },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tool_resources).toBeDefined();
      expect(updatedAgent.tool_resources.ocr).toBeUndefined();
      expect(updatedAgent.tool_resources.context).toBeDefined();
      expect(updatedAgent.tool_resources.execute_code).toBeDefined();
      expect(updatedAgent.tool_resources.invalid_tool).toBeUndefined();
    });

    test('canonicalizes hydrated tool resource files before update persistence', async () => {
      const File = mongoose.models.File;
      const ownedFileId = `file_${uuidv4()}`;
      const otherFileId = `file_${uuidv4()}`;
      await File.create({
        file_id: ownedFileId,
        user: existingAgentAuthorId,
        filename: `${ownedFileId}.txt`,
        filepath: `/tmp/${ownedFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      await File.create({
        file_id: otherFileId,
        user: new mongoose.Types.ObjectId(),
        filename: `${otherFileId}.txt`,
        filepath: `/tmp/${otherFileId}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_resources: {
          execute_code: {
            files: [
              { file_id: ownedFileId, filename: 'PRIVATE-SENTINEL' },
              { file_id: otherFileId, metadata: { codeEnvRef: { file_id: 'untrusted' } } },
            ],
          },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
      expect(agentInDb.tool_resources.execute_code.file_ids).toEqual([ownedFileId]);
      expect(agentInDb.tool_resources.execute_code.files).toBeUndefined();
      expect(JSON.stringify(agentInDb)).not.toContain('PRIVATE-SENTINEL');
      expect(JSON.stringify(agentInDb)).not.toContain('untrusted');
    });

    test('should strip runtime file records before persisting an update', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tool_resources: {
          execute_code: {
            files: [
              {
                file_id: 'forged-file',
                filepath: '/etc/passwd',
                source: FileSources.local,
              },
            ],
          },
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
      expect(agentInDb.tool_resources.execute_code.files).toBeUndefined();
      const latestVersion = agentInDb.versions[agentInDb.versions.length - 1];
      expect(latestVersion.tool_resources.execute_code.files).toBeUndefined();
    });

    test('should remove empty strings from model_parameters during update (Issue Fix)', async () => {
      // First create an agent with valid model_parameters
      await Agent.updateOne(
        { id: existingAgentId },
        {
          model_parameters: {
            temperature: 0.5,
            max_tokens: 1000,
            maxContextTokens: 2000,
          },
        },
      );

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      // Simulate user clearing the fields (sends empty strings)
      mockReq.body = {
        model_parameters: {
          temperature: 0.7, // Change to new value
          max_tokens: '', // Clear this field (should be removed, not sent as "")
          maxContextTokens: '', // Clear this field (should be removed, not sent as "")
        },
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.model_parameters).toBeDefined();
      // Valid number should be updated
      expect(updatedAgent.model_parameters.temperature).toBe(0.7);
      // Empty strings should be removed, not sent as ""
      expect(updatedAgent.model_parameters.max_tokens).toBeUndefined();
      expect(updatedAgent.model_parameters.maxContextTokens).toBeUndefined();

      // Verify in database
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.model_parameters.temperature).toBe(0.7);
      expect(agentInDb.model_parameters.max_tokens).toBeUndefined();
      expect(agentInDb.model_parameters.maxContextTokens).toBeUndefined();
    });

    test('should return 404 for non-existent agent', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = `agent_${uuidv4()}`; // Non-existent ID
      mockReq.body = {
        name: 'Update Non-existent',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Agent not found' });
    });

    test('should include version field in update response', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Updated with Version Check',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];

      // Verify version field is included and is a number
      expect(updatedAgent).toHaveProperty('version');
      expect(typeof updatedAgent.version).toBe('number');
      expect(updatedAgent.version).toBeGreaterThanOrEqual(1);

      // Verify in database
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(updatedAgent.version).toBe(agentInDb.versions.length);
    });

    test('should allow resetting avatar when value is explicitly null', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          avatar: {
            filepath: 'https://example.com/avatar.png',
            source: 's3',
          },
        },
      );

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        avatar: null,
      };

      await updateAgentHandler(mockReq, mockRes);

      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.avatar).toBeNull();

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.avatar).toBeNull();
    });

    test('should ignore avatar field when value is undefined', async () => {
      const originalAvatar = {
        filepath: 'https://example.com/original.png',
        source: 's3',
      };
      await Agent.updateOne({ id: existingAgentId }, { avatar: originalAvatar });

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        avatar: undefined,
      };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.avatar.filepath).toBe(originalAvatar.filepath);
      expect(agentInDb.avatar.source).toBe(originalAvatar.source);
    });

    test('should not bump version when no mutable fields change', async () => {
      const existingAgent = await Agent.findOne({ id: existingAgentId });
      const originalVersionCount = existingAgent.versions.length;

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        avatar: undefined,
      };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.versions.length).toBe(originalVersionCount);
    });

    test('should handle validation errors properly', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        model_parameters: 'invalid-not-an-object', // Should be an object
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Invalid request data',
          details: expect.any(Array),
        }),
      );
    });

    describe('orphan file_id pruning (issue #12776)', () => {
      const File = () => mongoose.models.File;

      const createFileDoc = async (file_id, userId) =>
        File().create({
          file_id,
          user: userId,
          filename: `${file_id}.txt`,
          filepath: `/tmp/${file_id}`,
          object: 'file',
          type: 'text/plain',
          bytes: 1,
          source: FileSources.local,
        });

      beforeEach(async () => {
        await File().deleteMany({});
      });

      test('strips orphan file_ids from incoming tool_resources before persisting', async () => {
        const keeper = `file_${uuidv4()}`;
        const orphan = `file_${uuidv4()}`;
        await createFileDoc(keeper, existingAgentAuthorId);

        mockReq.user.id = existingAgentAuthorId.toString();
        mockReq.params.id = existingAgentId;
        mockReq.body = {
          tool_resources: {
            file_search: { file_ids: [keeper, orphan] },
          },
        };

        await updateAgentHandler(mockReq, mockRes);

        const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
        expect(agentInDb.tool_resources.file_search.file_ids).toEqual([keeper]);
      });

      test('leaves tool_resources alone when the update omits it', async () => {
        const orphan = `file_${uuidv4()}`;
        await Agent.updateOne(
          { id: existingAgentId },
          { $set: { tool_resources: { file_search: { file_ids: [orphan] } } } },
        );

        mockReq.user.id = existingAgentAuthorId.toString();
        mockReq.params.id = existingAgentId;
        mockReq.body = { name: 'Unrelated Rename' };

        await updateAgentHandler(mockReq, mockRes);

        const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
        expect(agentInDb.name).toBe('Unrelated Rename');
        // Save-time pruning is intentionally scoped to tool_resources updates.
        // The delete-time fix and migration script cover the untouched case.
        expect(agentInDb.tool_resources.file_search.file_ids).toEqual([orphan]);
      });

      test('prunes incoming file_ids when the file ownership check fails', async () => {
        const db = require('~/models');
        jest.spyOn(db, 'getFiles').mockRejectedValueOnce(new Error('transient DB error'));

        const orphan = `file_${uuidv4()}`;
        mockReq.user.id = existingAgentAuthorId.toString();
        mockReq.params.id = existingAgentId;
        mockReq.body = {
          name: 'Save Succeeds',
          tool_resources: { file_search: { file_ids: [orphan] } },
        };

        await updateAgentHandler(mockReq, mockRes);

        expect(mockRes.status).not.toHaveBeenCalledWith(500);
        expect(mockRes.json).toHaveBeenCalled();
        const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
        expect(agentInDb.name).toBe('Save Succeeds');
        expect(agentInDb.tool_resources.file_search.file_ids).toEqual([]);
      });

      test('strips file_ids owned by another user from incoming tool_resources', async () => {
        const keeper = `file_${uuidv4()}`;
        const otherUsersFile = `file_${uuidv4()}`;
        await createFileDoc(keeper, existingAgentAuthorId);
        await createFileDoc(otherUsersFile, new mongoose.Types.ObjectId());

        mockReq.user.id = existingAgentAuthorId.toString();
        mockReq.params.id = existingAgentId;
        mockReq.body = {
          tool_resources: {
            file_search: { file_ids: [keeper, otherUsersFile] },
          },
        };

        await updateAgentHandler(mockReq, mockRes);

        const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
        expect(agentInDb.tool_resources.file_search.file_ids).toEqual([keeper]);
      });

      test('preserves existing attached file_ids owned by another user', async () => {
        const authorFile = `file_${uuidv4()}`;
        const editorFile = `file_${uuidv4()}`;
        const editorId = new mongoose.Types.ObjectId();
        await createFileDoc(authorFile, existingAgentAuthorId);
        await createFileDoc(editorFile, editorId);
        await Agent.updateOne(
          { id: existingAgentId },
          { $set: { tool_resources: { file_search: { file_ids: [editorFile] } } } },
        );

        mockReq.user.id = existingAgentAuthorId.toString();
        mockReq.params.id = existingAgentId;
        mockReq.body = {
          tool_resources: {
            file_search: { file_ids: [authorFile, editorFile] },
          },
        };

        await updateAgentHandler(mockReq, mockRes);

        const agentInDb = await Agent.findOne({ id: existingAgentId }).lean();
        expect(agentInDb.tool_resources.file_search.file_ids).toEqual([authorFile, editorFile]);
      });
    });
  });

  describe('tool_resources ownership pruning in alternate write paths', () => {
    const createFileDoc = (file_id, userId) =>
      mongoose.models.File.create({
        file_id,
        user: userId,
        filename: `${file_id}.txt`,
        filepath: `/tmp/${file_id}`,
        object: 'file',
        type: 'text/plain',
        bytes: 1,
        source: FileSources.local,
      });
    const createActionSpec = (operationId) =>
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Filtered Action', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/lookup': {
            get: {
              operationId,
              description: 'Look up a record',
              responses: {
                200: { description: 'Success' },
              },
            },
          },
        },
      });

    test('duplicateAgentHandler should block cloned content before action or agent writes', async () => {
      const sourceAuthorId = new mongoose.Types.ObjectId();
      const cloneAuthorId = new mongoose.Types.ObjectId();
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAuthorId,
        instructions: 'Use sk-private-token for requests',
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          metadata: { domain: 'api.example.com' },
        },
      ]);
      const updateActionSpy = jest.spyOn(db, 'updateAction');
      const createAgentSpy = jest.spyOn(db, 'createAgent');

      mockReq.config = {
        filters: {
          agentInstructions: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockReq.user.id = cloneAuthorId.toString();
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'instructions',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('sk-private-token');
      expect(updateActionSpy).not.toHaveBeenCalled();
      expect(createAgentSpy).not.toHaveBeenCalled();
      await expect(Agent.countDocuments()).resolves.toBe(1);
    });

    test('duplicateAgentHandler should block sanitized action metadata before any writes', async () => {
      const sourceAuthorId = new mongoose.Types.ObjectId();
      const cloneAuthorId = new mongoose.Types.ObjectId();
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAuthorId,
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          metadata: {
            domain: 'api.example.com',
            api_key: 'REMOVED-BEFORE-INSPECTION',
            auth: {
              authorization_url: 'https://auth.example.test/BLOCK-AUTH',
            },
          },
        },
      ]);
      const updateActionSpy = jest.spyOn(db, 'updateAction');
      const createAgentSpy = jest.spyOn(db, 'createAgent');

      mockReq.config = {
        filters: {
          actionMetadata: {
            pii: {
              fields: ['authorization_url'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
      };
      mockReq.user.id = cloneAuthorId.toString();
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'action_metadata',
          field: 'authorization_url',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('BLOCK-AUTH');
      expect(JSON.stringify(response)).not.toContain('REMOVED-BEFORE-INSPECTION');
      expect(updateActionSpy).not.toHaveBeenCalled();
      expect(createAgentSpy).not.toHaveBeenCalled();
      await expect(Agent.countDocuments()).resolves.toBe(1);
    });

    test('duplicateAgentHandler should fail closed on oversized protected action metadata', async () => {
      const sourceAuthorId = new mongoose.Types.ObjectId();
      const cloneAuthorId = new mongoose.Types.ObjectId();
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAuthorId,
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          metadata: {
            domain: 'api.example.com',
            raw_spec: createOverflowingActionValue(),
          },
        },
      ]);
      const updateActionSpy = jest.spyOn(db, 'updateAction');
      const createAgentSpy = jest.spyOn(db, 'createAgent');

      mockReq.config = {
        filters: {
          actionMetadata: {
            pii: {
              fields: ['raw_spec'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'protected-content',
                  label: 'protected content',
                  regex: 'BLOCK-NOT-PRESENT',
                },
              ],
            },
          },
        },
      };
      mockReq.user.id = cloneAuthorId.toString();
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
        }),
      );
      expect(updateActionSpy).not.toHaveBeenCalled();
      expect(createAgentSpy).not.toHaveBeenCalled();
      await expect(Agent.countDocuments()).resolves.toBe(1);
    });

    test('duplicateAgentHandler should inspect stored action function definitions before writes', async () => {
      const sourceAuthorId = new mongoose.Types.ObjectId();
      const cloneAuthorId = new mongoose.Types.ObjectId();
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAuthorId,
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          metadata: {
            domain: 'api.example.com',
            raw_spec: createActionSpec('BLOCK-TOOL'),
          },
        },
      ]);
      const updateActionSpy = jest.spyOn(db, 'updateAction');
      const createAgentSpy = jest.spyOn(db, 'createAgent');

      mockReq.config = {
        filters: {
          agentInstructions: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
      };
      mockReq.user.id = cloneAuthorId.toString();
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'name',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('BLOCK-TOOL');
      expect(updateActionSpy).not.toHaveBeenCalled();
      expect(createAgentSpy).not.toHaveBeenCalled();
    });

    test('duplicateAgentHandler should prune file_ids not owned by the clone author', async () => {
      const sourceAuthorId = new mongoose.Types.ObjectId();
      const cloneAuthorId = new mongoose.Types.ObjectId();
      const sourceFileId = `file_${uuidv4()}`;
      const cloneAuthorFileId = `file_${uuidv4()}`;

      await createFileDoc(sourceFileId, sourceAuthorId);
      await createFileDoc(cloneAuthorFileId, cloneAuthorId);
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAuthorId,
        tool_resources: {
          context: {
            files: [
              { file_id: sourceFileId, filename: 'source.txt' },
              { file_id: cloneAuthorFileId, filename: 'clone.txt' },
            ],
          },
        },
      });

      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([]);

      mockReq.user.id = cloneAuthorId.toString();
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const { agent } = mockRes.json.mock.calls[0][0];
      expect(agent.author.toString()).toBe(cloneAuthorId.toString());
      expect(agent.tool_resources.context.file_ids).toEqual([cloneAuthorFileId]);
      expect(agent.tool_resources.context.files).toBeUndefined();
    });

    test('revertAgentVersionHandler should block selected content before persistence', async () => {
      const agentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: agentAuthorId,
        instructions: 'Current allowed instructions',
        versions: [
          {
            name: 'Historical Agent',
            provider: 'openai',
            model: 'gpt-4',
            instructions: 'Use sk-private-token for requests',
          },
        ],
      });
      const db = require('~/models');
      const updateAgentSpy = jest.spyOn(db, 'updateAgent');

      mockReq.config = {
        filters: {
          agentInstructions: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };
      mockReq.user.id = agentAuthorId.toString();
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'instructions',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('sk-private-token');
      expect(updateAgentSpy).not.toHaveBeenCalled();
      const agentInDb = await Agent.findOne({ id: agent.id }).lean();
      expect(agentInDb.name).toBe('Current Agent');
      expect(agentInDb.instructions).toBe('Current allowed instructions');
    });

    test('revertAgentVersionHandler should block reactivated action metadata before persistence', async () => {
      const agentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: agentAuthorId,
        versions: [
          {
            name: 'Historical Agent',
            provider: 'openai',
            model: 'gpt-4',
            actions: [`api.example.com${actionDelimiter}source-action`],
          },
        ],
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          agent_id: agent.id,
          metadata: {
            domain: 'api.example.com',
            auth: {
              authorization_url: 'https://auth.example.test/BLOCK-AUTH',
            },
          },
        },
      ]);
      const updateAgentSpy = jest.spyOn(db, 'updateAgent');

      mockReq.config = {
        filters: {
          actionMetadata: {
            pii: {
              fields: ['authorization_url'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
      };
      mockReq.user.id = agentAuthorId.toString();
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'action_metadata',
          field: 'authorization_url',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('BLOCK-AUTH');
      expect(updateAgentSpy).not.toHaveBeenCalled();
      const agentInDb = await Agent.findOne({ id: agent.id }).lean();
      expect(agentInDb.name).toBe('Current Agent');
      expect(agentInDb.actions).toBeUndefined();
    });

    test('revertAgentVersionHandler should inspect reactivated action function definitions', async () => {
      const agentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: agentAuthorId,
        versions: [
          {
            name: 'Historical Agent',
            provider: 'openai',
            model: 'gpt-4',
            actions: [`api.example.com${actionDelimiter}source-action`],
          },
        ],
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([
        {
          action_id: 'source-action',
          agent_id: agent.id,
          metadata: {
            domain: 'api.example.com',
            raw_spec: createActionSpec('BLOCK-TOOL'),
          },
        },
      ]);
      const updateAgentSpy = jest.spyOn(db, 'updateAgent');

      mockReq.config = {
        filters: {
          agentInstructions: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
      };
      mockReq.user.id = agentAuthorId.toString();
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const response = mockRes.json.mock.calls[0][0];
      expect(response).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'agent_instruction',
          field: 'name',
        }),
      );
      expect(JSON.stringify(response)).not.toContain('BLOCK-TOOL');
      expect(updateAgentSpy).not.toHaveBeenCalled();
      const agentInDb = await Agent.findOne({ id: agent.id }).lean();
      expect(agentInDb.name).toBe('Current Agent');
      expect(agentInDb.actions).toBeUndefined();
    });

    test('revertAgentVersionHandler should canonicalize and prune target-only file_ids', async () => {
      const agentAuthorId = new mongoose.Types.ObjectId();
      const otherUserId = new mongoose.Types.ObjectId();
      const ownedFileId = `file_${uuidv4()}`;
      const currentSharedFileId = `file_${uuidv4()}`;
      const targetOnlyFileId = `file_${uuidv4()}`;
      const orphanFileId = `file_${uuidv4()}`;

      await createFileDoc(ownedFileId, agentAuthorId);
      await createFileDoc(currentSharedFileId, otherUserId);
      await createFileDoc(targetOnlyFileId, otherUserId);
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: agentAuthorId,
        tool_resources: {
          file_search: { file_ids: [currentSharedFileId] },
        },
        versions: [
          {
            name: 'Historical Agent',
            provider: 'openai',
            model: 'gpt-4',
            tool_resources: {
              file_search: {
                files: [
                  { file_id: ownedFileId, filename: 'owned.txt' },
                  { file_id: currentSharedFileId, filename: 'already-attached.txt' },
                  { file_id: targetOnlyFileId, filename: 'target-only.txt' },
                  { file_id: orphanFileId, filename: 'missing.txt' },
                ],
              },
            },
          },
        ],
      });

      mockReq.user.id = agentAuthorId.toString();
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const agentInDb = await Agent.findOne({ id: agent.id }).lean();
      expect(agentInDb.tool_resources.file_search.file_ids).toEqual([
        ownedFileId,
        currentSharedFileId,
      ]);
      expect(agentInDb.tool_resources.file_search.files).toBeUndefined();
    });

    test('duplicateAgentHandler removes programmatic options without Code Interpreter', async () => {
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Legacy Programmatic Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        tools: ['search_mcp_example'],
        tool_options: {
          search_mcp_example: { allowed_callers: ['code_execution'] },
        },
      });
      const db = require('~/models');
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([]);
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json.mock.calls[0][0].agent.tool_options).toEqual({});
    });

    test('duplicateAgentHandler preserves a disabled stale workspace binding', async () => {
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Disabled BYOM Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        stateful_code_sessions: false,
        code_environment_id: 'removed-vm',
        code_workspace_id: 'project-a',
      });
      jest.spyOn(db, 'getActions').mockResolvedValueOnce([]);
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { environments: [] },
          },
        },
      };
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json.mock.calls[0][0].agent).toEqual(
        expect.objectContaining({
          stateful_code_sessions: false,
          code_environment_id: 'removed-vm',
          code_workspace_id: 'project-a',
        }),
      );
    });

    test('duplicateAgentHandler rejects an active stale workspace binding', async () => {
      const sourceAgent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Active BYOM Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        stateful_code_sessions: true,
        code_environment_id: 'removed-vm',
        code_workspace_id: 'project-a',
      });
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { environments: [] },
          },
        },
      };
      mockReq.params.id = sourceAgent.id;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Code workspace defaults require an explicit attached code environment',
      });
    });

    test('revertAgentVersionHandler removes restored programmatic options without Code Interpreter', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        versions: [
          {
            name: 'Legacy Programmatic Agent',
            provider: 'openai',
            model: 'gpt-4',
            tools: ['search_mcp_example'],
            tool_options: {
              search_mcp_example: { allowed_callers: ['code_execution'] },
            },
          },
        ],
      });
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      expect(mockRes.json.mock.calls[0][0].tool_options).toEqual({});
    });

    test('revertAgentVersionHandler restores a disabled stale workspace binding', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        versions: [
          {
            name: 'Disabled Historical BYOM Agent',
            provider: 'openai',
            model: 'gpt-4',
            stateful_code_sessions: false,
            code_environment_id: 'removed-vm',
            code_workspace_id: 'project-a',
          },
        ],
      });
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { environments: [] },
          },
        },
      };
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      const persisted = await Agent.findOne({ id: agent.id }).lean();
      expect(persisted).toEqual(
        expect.objectContaining({
          stateful_code_sessions: false,
          code_environment_id: 'removed-vm',
          code_workspace_id: 'project-a',
        }),
      );
    });

    test('revertAgentVersionHandler rejects a stale binding that inherits active sessions', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        stateful_code_sessions: true,
        versions: [
          {
            name: 'Historical BYOM Agent',
            provider: 'openai',
            model: 'gpt-4',
            code_environment_id: 'removed-vm',
            code_workspace_id: 'project-a',
          },
        ],
      });
      mockReq.config = {
        endpoints: {
          agents: {
            statefulCodeSessions: { environments: [] },
          },
        },
      };
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Code workspace defaults require an explicit attached code environment',
      });
    });

    test('revertAgentVersionHandler does not update unchanged tool options', async () => {
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Current Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mockReq.user.id,
        versions: [
          {
            name: 'Historical Agent',
            provider: 'openai',
            model: 'gpt-4',
            tool_options: {},
          },
        ],
      });
      const db = require('~/models');
      const updateAgentSpy = jest.spyOn(db, 'updateAgent');
      mockReq.params.id = agent.id;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      expect(updateAgentSpy).not.toHaveBeenCalled();
    });
  });

  describe('Mass Assignment Attack Scenarios', () => {
    test('should prevent setting system fields during creation', async () => {
      const systemFields = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'System Fields Test',

        // System fields that should never be settable by users
        __v: 99,
        _id: new mongoose.Types.ObjectId(),
        versions: [
          {
            name: 'Fake Version',
            provider: 'fake',
            model: 'fake-model',
          },
        ],
      };

      mockReq.body = systemFields;

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];

      // Verify system fields were not affected
      expect(createdAgent.__v).not.toBe(99);
      expect(createdAgent.versions).toHaveLength(1); // Should only have the auto-created version
      expect(createdAgent.versions[0].name).toBe('System Fields Test'); // From actual creation
      expect(createdAgent.versions[0].provider).toBe('openai'); // From actual creation

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.__v).not.toBe(99);
    });

    test('should prevent author hijacking', async () => {
      const originalAuthorId = new mongoose.Types.ObjectId();
      const attackerId = new mongoose.Types.ObjectId();

      // Admin creates an agent
      mockReq.user.id = originalAuthorId.toString();
      mockReq.user.role = 'ADMIN';
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Admin Agent',
        author: attackerId.toString(), // Trying to set different author
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];

      // Author should be the actual user, not the attempted value
      expect(createdAgent.author.toString()).toBe(originalAuthorId.toString());
      expect(createdAgent.author.toString()).not.toBe(attackerId.toString());

      // Verify in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id });
      expect(agentInDb.author.toString()).toBe(originalAuthorId.toString());
    });

    test('should strip unknown fields to prevent future vulnerabilities', async () => {
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'Future Proof Test',

        // Unknown fields that might be added in future
        superAdminAccess: true,
        bypassAllChecks: true,
        internalFlag: 'secret',
        futureFeature: 'exploit',
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);

      const createdAgent = mockRes.json.mock.calls[0][0];

      // Verify unknown fields were stripped
      expect(createdAgent.superAdminAccess).toBeUndefined();
      expect(createdAgent.bypassAllChecks).toBeUndefined();
      expect(createdAgent.internalFlag).toBeUndefined();
      expect(createdAgent.futureFeature).toBeUndefined();

      // Also check in database
      const agentInDb = await Agent.findOne({ id: createdAgent.id }).lean();
      expect(agentInDb.superAdminAccess).toBeUndefined();
      expect(agentInDb.bypassAllChecks).toBeUndefined();
      expect(agentInDb.internalFlag).toBeUndefined();
      expect(agentInDb.futureFeature).toBeUndefined();
    });
  });

  describe('getListAgentsHandler - Security Tests', () => {
    let userA, userB;
    let agentA1, agentA2, agentA3, agentB1;

    beforeEach(async () => {
      await Agent.deleteMany({});
      jest.clearAllMocks();

      // Create two test users
      userA = new mongoose.Types.ObjectId();
      userB = new mongoose.Types.ObjectId();

      // Create agents for User A
      agentA1 = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent A1',
        description: 'User A agent 1',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        versions: [
          {
            name: 'Agent A1',
            description: 'User A agent 1',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      agentA2 = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent A2',
        description: 'User A agent 2',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        versions: [
          {
            name: 'Agent A2',
            description: 'User A agent 2',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      agentA3 = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent A3',
        description: 'User A agent 3',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        category: 'productivity',
        versions: [
          {
            name: 'Agent A3',
            description: 'User A agent 3',
            provider: 'openai',
            model: 'gpt-4',
            category: 'productivity',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      // Create an agent for User B
      agentB1 = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent B1',
        description: 'User B agent 1',
        provider: 'openai',
        model: 'gpt-4',
        author: userB,
        versions: [
          {
            name: 'Agent B1',
            description: 'User B agent 1',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
    });

    test('lets a manage:agents role discover unshared agents by search', async () => {
      await db.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'LIST_MANAGER_TEST',
        capability: SystemCapabilities.MANAGE_AGENTS,
      });
      mockReq.user = {
        id: userB.toString(),
        role: 'LIST_MANAGER_TEST',
        idOnTheSource: null,
      };
      mockReq.query.search = 'A2';
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      expect(await hasCapability(mockReq.user, SystemCapabilities.MANAGE_AGENTS)).toBe(true);
      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data.map((agent) => agent.id)).toEqual([agentA2.id]);
      expect(response.data[0].isEditable).toBe(true);
      expect(findAccessibleResources).toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: ResourceType.AGENT }),
      );
    });

    test('restricts a manager to the authenticated tenant even without ambient tenant context', async () => {
      const tenantA = `tenant-a-${uuidv4()}`;
      const tenantB = `tenant-b-${uuidv4()}`;
      const name = 'Tenant-Scoped Discovery';
      const agentInA = await tenantStorage.run({ tenantId: tenantA }, () =>
        Agent.create({
          id: `agent_${nanoid(12)}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        }),
      );
      await tenantStorage.run({ tenantId: tenantB }, () =>
        Agent.create({
          id: `agent_${nanoid(12)}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userB,
        }),
      );
      await db.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'LIST_TENANT_MANAGER',
        capability: SystemCapabilities.MANAGE_AGENTS,
      });
      mockReq.user = {
        id: userB.toString(),
        role: 'LIST_TENANT_MANAGER',
        idOnTheSource: null,
        tenantId: tenantA,
      };
      mockReq.query.search = name;
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);
      expect(mockCache.get).toHaveBeenCalledWith(
        `${userB.toString()}:${tenantA}:agents_avatar_refresh`,
      );
      expect(mockRes.json.mock.calls[0][0].data.map((agent) => agent.id)).toEqual([agentInA.id]);

      mockRes.json.mockClear();
      mockReq.user.tenantId = undefined;
      await getListAgentsHandler(mockReq, mockRes);
      expect(mockRes.json.mock.calls[0][0].data).toHaveLength(0);
    });

    test('should return empty list when user has no accessible agents', async () => {
      // User B has no permissions and no owned agents
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      expect(findAccessibleResources).toHaveBeenCalledWith({
        userId: userB.toString(),
        role: 'USER',
        resourceType: 'agent',
        requiredPermissions: 1, // VIEW permission
      });

      expect(mockRes.json).toHaveBeenCalledWith({
        object: 'list',
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
        after: null,
      });
    });

    test('should not return other users agents when accessibleIds is empty', async () => {
      // User B trying to see agents with no permissions
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(0);

      // Verify User A's agents are not included
      const agentIds = response.data.map((a) => a.id);
      expect(agentIds).not.toContain(agentA1.id);
      expect(agentIds).not.toContain(agentA2.id);
      expect(agentIds).not.toContain(agentA3.id);
    });

    test('should only return agents user has access to', async () => {
      // User B has access to one of User A's agents
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe(agentA1.id);
      expect(response.data[0].name).toBe('Agent A1');
    });

    test('should return owner_contact for list agents missing support_contact', async () => {
      const owner = await createOwner({
        _id: userA,
        name: 'List Owner',
        email: 'list.owner@example.com',
      });
      await grantAgentOwner({ agent: agentA1, owner });

      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data[0].owner_contact).toEqual({ name: 'List Owner' });
      expect(response.data[0].owner_contact).not.toHaveProperty('email');
    });

    test('should use the first ACL owner when an agent has multiple owners', async () => {
      const firstOwner = await createOwner({
        name: 'First Owner',
        email: 'first.owner@example.com',
      });
      const secondOwner = await createOwner({
        name: 'Second Owner',
        email: 'second.owner@example.com',
      });
      await grantAgentOwner({
        agent: agentA1,
        owner: secondOwner,
        grantedAt: new Date('2024-02-01T00:00:00.000Z'),
      });
      await grantAgentOwner({
        agent: agentA1,
        owner: firstOwner,
        grantedAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data[0].owner_contact).toEqual({ name: 'First Owner' });
    });

    test('should omit owner_contact when no owner user can be resolved', async () => {
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data[0].owner_contact).toBeUndefined();
    });

    test('should mark isEditable per agent on a VIEW-scoped list', async () => {
      mockReq.user.id = userA.toString();
      mockReq.query = { requiredPermission: String(PermissionBits.VIEW) };
      /** VIEW reaches all three; the EDIT lookup only reaches agentA1. */
      findAccessibleResources.mockImplementation(({ resourceType, requiredPermissions }) => {
        if (resourceType === 'agent' && requiredPermissions === PermissionBits.EDIT) {
          return Promise.resolve([agentA1._id]);
        }
        if (resourceType === 'agent') {
          return Promise.resolve([agentA1._id, agentA2._id, agentA3._id]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const byId = Object.fromEntries(
        mockRes.json.mock.calls[0][0].data.map((a) => [a.id, a.isEditable]),
      );
      expect(byId[agentA1.id]).toBe(true);
      expect(byId[agentA2.id]).toBe(false);
      expect(byId[agentA3.id]).toBe(false);
    });

    test('should forward idOnTheSource to every ACL lookup', async () => {
      /** Without it `getUserPrincipals` reads the user document once per lookup, so the
       *  handler pays an extra `User.findById` for each permission it resolves. */
      mockReq.user.id = userA.toString();
      mockReq.user.idOnTheSource = 'external-oid-1';
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      expect(findAccessibleResources.mock.calls.length).toBeGreaterThan(1);
      for (const [args] of findAccessibleResources.mock.calls) {
        expect(args.idOnTheSource).toBe('external-oid-1');
      }
    });

    test('should mark every agent editable when the request is already EDIT-scoped', async () => {
      mockReq.user.id = userA.toString();
      mockReq.query = { requiredPermission: String(PermissionBits.EDIT) };
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA2._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data.every((a) => a.isEditable === true)).toBe(true);
      /** No extra EDIT lookup: an EDIT-scoped match is editable by definition. */
      const editCalls = findAccessibleResources.mock.calls.filter(
        ([args]) =>
          args.resourceType === 'agent' && args.requiredPermissions === PermissionBits.EDIT,
      );
      expect(editCalls).toHaveLength(1);
    });

    test('should return only expected safe list fields for VIEW callers', async () => {
      const hiddenSkillId = new mongoose.Types.ObjectId();
      await Agent.findByIdAndUpdate(agentA1._id, {
        avatar: { filepath: '/avatars/a1.png', source: FileSources.local },
        category: 'general',
        support_contact: { name: 'Support', email: 'support@example.com' },
        is_promoted: true,
        instructions: 'private system instructions',
        tools: ['execute_code'],
        actions: ['example.com::action'],
        model_parameters: { temperature: 0.7 },
        tool_resources: { file_search: { file_ids: ['file-1'] } },
        tool_options: { execute_code: { defer_loading: true } },
        subagents: { enabled: true, agent_ids: [agentA2.id] },
        edges: [{ from: agentA1.id, to: agentA2.id }],
        skills_enabled: true,
        skills: [hiddenSkillId.toString()],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        if (resourceType === ResourceType.SKILL) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      const agent = response.data[0];
      expect(Object.keys(agent).sort()).toEqual(
        [
          '_id',
          'agent_ids',
          'author',
          'avatar',
          'category',
          'conversation_starters',
          'description',
          'edges',
          'id',
          'isEditable',
          'is_promoted',
          'name',
          'subagents',
          'support_contact',
          'tools',
          'updatedAt',
        ].sort(),
      );
      expect(agent).toEqual(
        expect.objectContaining({
          id: agentA1.id,
          name: 'Agent A1',
          description: 'User A agent 1',
          author: userA.toString(),
          category: 'general',
          is_promoted: true,
          tools: ['execute_code'],
          edges: [{ from: agentA1.id, to: agentA2.id }],
          subagents: { enabled: true, agent_ids: [agentA2.id] },
        }),
      );
    });

    test('should return multiple accessible agents', async () => {
      // User B has access to multiple agents
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA3._id, agentB1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(3);

      const agentIds = response.data.map((a) => a.id);
      expect(agentIds).toContain(agentA1.id);
      expect(agentIds).toContain(agentA3.id);
      expect(agentIds).toContain(agentB1.id);
      expect(agentIds).not.toContain(agentA2.id);
    });

    test('should apply category filter correctly with ACL', async () => {
      // User has access to all agents but filters by category
      mockReq.user.id = userB.toString();
      mockReq.query.category = 'productivity';
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA2._id, agentA3._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe(agentA3.id);
      expect(response.data[0].category).toBe('productivity');
    });

    test('should apply search filter correctly with ACL', async () => {
      // User has access to multiple agents but searches for specific one
      mockReq.user.id = userB.toString();
      mockReq.query.search = 'A2';
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA2._id, agentA3._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe(agentA2.id);
    });

    test('should handle pagination with ACL filtering', async () => {
      // Create more agents for pagination testing
      const moreAgents = [];
      for (let i = 4; i <= 10; i++) {
        const agent = await Agent.create({
          id: `agent_${nanoid(12)}`,
          name: `Agent A${i}`,
          description: `User A agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
          versions: [
            {
              name: `Agent A${i}`,
              description: `User A agent ${i}`,
              provider: 'openai',
              model: 'gpt-4',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        });
        moreAgents.push(agent);
      }

      // User has access to all agents
      const allAgentIds = [agentA1, agentA2, agentA3, ...moreAgents].map((a) => a._id);
      mockReq.user.id = userB.toString();
      mockReq.query.limit = '5';
      findAccessibleResources.mockResolvedValue(allAgentIds);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(5);
      expect(response.has_more).toBe(true);
      expect(response.after).toBeTruthy();
    });

    test('should mark publicly accessible agents', async () => {
      // User has access to agents, some are public
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA2._id]);
      findPubliclyAccessibleResources.mockResolvedValue([agentA2._id]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(2);

      const publicAgent = response.data.find((a) => a.id === agentA2.id);
      const privateAgent = response.data.find((a) => a.id === agentA1.id);

      expect(publicAgent.isPublic).toBe(true);
      expect(privateAgent.isPublic).toBeUndefined();
    });

    test('should handle requiredPermission parameter', async () => {
      // Test with different permission levels
      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = '15'; // FULL_ACCESS
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      expect(findAccessibleResources).toHaveBeenCalledWith({
        userId: userB.toString(),
        role: 'USER',
        resourceType: 'agent',
        requiredPermissions: 15,
      });

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
    });

    test('should return only viewer-accessible skill scope for VIEW list callers', async () => {
      const visibleSkillId = new mongoose.Types.ObjectId();
      const hiddenSkillId = new mongoose.Types.ObjectId();
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: true,
        skills: [visibleSkillId.toString(), hiddenSkillId.toString()],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        if (resourceType === ResourceType.SKILL) {
          return Promise.resolve([visibleSkillId]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills_enabled).toBe(true);
      expect(response.data[0].skills).toEqual([visibleSkillId.toString()]);
      expect(response.data[0].skills).not.toContain(hiddenSkillId.toString());
    });

    test('should omit skill scope for VIEW list callers with no accessible configured skills', async () => {
      const hiddenSkillId = new mongoose.Types.ObjectId();
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: true,
        skills: [hiddenSkillId.toString()],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        if (resourceType === ResourceType.SKILL) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills).toBeUndefined();
      expect(response.data[0].skills_enabled).toBeUndefined();
    });

    test('should preserve deployment skill scope for VIEW list callers', async () => {
      const deploymentSkillId = new mongoose.Types.ObjectId();
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: true,
        skills: [deploymentSkillId.toString()],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);
      mergeDeploymentSkillIds.mockImplementation((ids) => [...ids, deploymentSkillId]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills_enabled).toBe(true);
      expect(response.data[0].skills).toEqual([deploymentSkillId.toString()]);
    });

    test('should preserve enabled skill scope for VIEW list callers with an empty allowlist', async () => {
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: true,
        skills: [],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        if (resourceType === ResourceType.SKILL) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills).toBeUndefined();
      expect(response.data[0].skills_enabled).toBe(true);
    });

    test('should preserve an enabled empty catalog for VIEW list callers', async () => {
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: false,
        skill_authoring_enabled: true,
        skills_scope: SkillsScope.none,
        skills: [],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.VIEW);
      findAccessibleResources.mockImplementation(({ resourceType }) => {
        if (resourceType === ResourceType.AGENT) {
          return Promise.resolve([agentA1._id]);
        }
        return Promise.resolve([]);
      });
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills).toBeUndefined();
      expect(response.data[0].skills_enabled).toBeUndefined();
      expect(response.data[0].skill_authoring_enabled).toBe(true);
      expect(response.data[0].skills_scope).toBeUndefined();
    });

    test('should return raw skill configuration for EDIT list callers', async () => {
      const visibleSkillId = new mongoose.Types.ObjectId();
      const hiddenSkillId = new mongoose.Types.ObjectId();
      await Agent.findByIdAndUpdate(agentA1._id, {
        skills_enabled: true,
        skills: [visibleSkillId.toString(), hiddenSkillId.toString()],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.requiredPermission = String(PermissionBits.EDIT);
      findAccessibleResources.mockResolvedValue([agentA1._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].skills_enabled).toBe(true);
      expect(response.data[0].skills).toEqual([
        visibleSkillId.toString(),
        hiddenSkillId.toString(),
      ]);
      expect(findAccessibleResources).not.toHaveBeenCalledWith(
        expect.objectContaining({ resourceType: ResourceType.SKILL }),
      );
    });

    test('should handle promoted filter with ACL', async () => {
      // Create a promoted agent
      const promotedAgent = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Promoted Agent',
        description: 'A promoted agent',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        is_promoted: true,
        versions: [
          {
            name: 'Promoted Agent',
            description: 'A promoted agent',
            provider: 'openai',
            model: 'gpt-4',
            is_promoted: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.promoted = '1';
      findAccessibleResources.mockResolvedValue([agentA1._id, agentA2._id, promotedAgent._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe(promotedAgent.id);
      expect(response.data[0].is_promoted).toBe(true);
    });

    test('should handle errors gracefully', async () => {
      mockReq.user.id = userB.toString();
      findAccessibleResources.mockRejectedValue(new Error('Permission service error'));

      await getListAgentsHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Permission service error',
      });
    });

    test('should respect combined filters with ACL', async () => {
      // Create agents with specific attributes
      const productivityPromoted = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Productivity Pro',
        description: 'A promoted productivity agent',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        category: 'productivity',
        is_promoted: true,
        versions: [
          {
            name: 'Productivity Pro',
            description: 'A promoted productivity agent',
            provider: 'openai',
            model: 'gpt-4',
            category: 'productivity',
            is_promoted: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      mockReq.user.id = userB.toString();
      mockReq.query.category = 'productivity';
      mockReq.query.promoted = '1';
      findAccessibleResources.mockResolvedValue([
        agentA1._id,
        agentA2._id,
        agentA3._id,
        productivityPromoted._id,
      ]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      await getListAgentsHandler(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.data).toHaveLength(1);
      expect(response.data[0].id).toBe(productivityPromoted.id);
      expect(response.data[0].category).toBe('productivity');
      expect(response.data[0].is_promoted).toBe(true);
    });
  });

  describe('S3 Avatar Refresh', () => {
    let userA, userB;
    let agentWithS3Avatar, agentWithLocalAvatar, agentOwnedByOther;

    beforeEach(async () => {
      await Agent.deleteMany({});
      jest.clearAllMocks();

      // Reset cache mock
      mockCache.get.mockResolvedValue(false);
      mockCache.set.mockResolvedValue(undefined);

      userA = new mongoose.Types.ObjectId();
      userB = new mongoose.Types.ObjectId();

      // Create agent with S3 avatar owned by userA
      agentWithS3Avatar = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent with S3 Avatar',
        description: 'Has S3 avatar',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        avatar: {
          source: FileSources.s3,
          filepath: 'old-s3-path.jpg',
        },
        versions: [
          {
            name: 'Agent with S3 Avatar',
            description: 'Has S3 avatar',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      // Create agent with local avatar owned by userA
      agentWithLocalAvatar = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent with Local Avatar',
        description: 'Has local avatar',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        avatar: {
          source: 'local',
          filepath: 'local-path.jpg',
        },
        versions: [
          {
            name: 'Agent with Local Avatar',
            description: 'Has local avatar',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      // Create agent with S3 avatar owned by userB
      agentOwnedByOther = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent Owned By Other',
        description: 'Owned by userB',
        provider: 'openai',
        model: 'gpt-4',
        author: userB,
        avatar: {
          source: FileSources.s3,
          filepath: 'other-s3-path.jpg',
        },
        versions: [
          {
            name: 'Agent Owned By Other',
            description: 'Owned by userB',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
    });

    test('refreshes only manager search results without writing or losing later cursor pages', async () => {
      const db = require('~/models');
      const name = 'Paged Manager Avatar';
      const firstAgent = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name,
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        avatar: { source: FileSources.s3, filepath: 'first.jpg' },
      });
      const secondAgent = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name,
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        avatar: { source: FileSources.s3, filepath: 'second.jpg' },
      });
      await db.grantCapability({
        principalType: PrincipalType.ROLE,
        principalId: 'LIST_AVATAR_MANAGER',
        capability: SystemCapabilities.MANAGE_AGENTS,
      });
      const mockReq = {
        user: { id: userB.toString(), role: 'LIST_AVATAR_MANAGER', idOnTheSource: null },
        query: { search: name, limit: '1' },
      };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const listSpy = jest.spyOn(db, 'getListAgentsByAccess');
      const updateSpy = jest.spyOn(db, 'updateAgent');
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockImplementation(async ({ filepath }) => `signed:${filepath}`);

      try {
        await getListAgentsHandler(mockReq, mockRes);
        const pageOne = mockRes.json.mock.calls[0][0];
        expect(pageOne.data).toHaveLength(1);
        expect(pageOne.after).toBeTruthy();
        expect(pageOne.data[0].avatar.filepath).toMatch(/^signed:/);
        expect(listSpy).toHaveBeenCalledTimes(1);
        expect(refreshS3Url).toHaveBeenCalledTimes(1);
        expect(updateSpy).not.toHaveBeenCalled();

        mockRes.json.mockClear();
        mockReq.query.cursor = pageOne.after;
        await getListAgentsHandler(mockReq, mockRes);
        const pageTwo = mockRes.json.mock.calls[0][0];
        expect(pageTwo.data).toHaveLength(1);
        expect([pageOne.data[0].id, pageTwo.data[0].id].sort()).toEqual(
          [firstAgent.id, secondAgent.id].sort(),
        );
        expect(pageTwo.data[0].avatar.filepath).toMatch(/^signed:/);
        expect(refreshS3Url).toHaveBeenCalledTimes(2);
        expect(updateSpy).not.toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
        updateSpy.mockRestore();
      }
    });

    test('should skip avatar refresh if cache hit', async () => {
      mockCache.get.mockResolvedValue({ urlCache: {} });
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Should not call refreshS3Url when cache hit
      expect(refreshS3Url).not.toHaveBeenCalled();
    });

    test('does not treat a manager page cache as an ACL-wide refresh after role downgrade', async () => {
      mockCache.get.mockResolvedValue({ urlCache: {}, scope: 'page' });
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('refreshed-after-downgrade.jpg');
      const mockReq = { user: { id: userA.toString(), role: 'USER' }, query: {} };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

      await getListAgentsHandler(mockReq, mockRes);

      expect(refreshS3Url).toHaveBeenCalledTimes(1);
      expect(mockRes.json.mock.calls[0][0].data[0].avatar.filepath).toBe(
        'refreshed-after-downgrade.jpg',
      );
    });

    test('should refresh and persist S3 avatars on cache miss', async () => {
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-s3-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Verify S3 URL was refreshed
      expect(refreshS3Url).toHaveBeenCalled();

      // Verify cache was set with urlCache map, not a plain boolean
      expect(mockCache.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ urlCache: expect.any(Object) }),
        expect.any(Number),
      );

      // Verify response was returned
      expect(mockRes.json).toHaveBeenCalled();
    });

    test('should finish avatar writes before snapshotting the paginated list query', async () => {
      /** `updateAgent` bumps `updatedAt`, which is the field `getListAgentsByAccess`
       *  sorts and cursors on. If the list query snapshots before a refresh write
       *  lands, that agent jumps ahead of the returned cursor and vanishes from every
       *  later page. Assert the ordering rather than the symptom, which only shows up
       *  on multi-page S3 accounts under a specific interleaving. */
      const db = require('~/models');
      const order = [];
      /** Yield a macrotask so a parallelized refresh would lose the race, the way a real
       *  S3 presign round trip does. */
      refreshS3Url.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('avatar-write');
        return 'new-s3-path.jpg';
      });
      const realList = db.getListAgentsByAccess;
      const listSpy = jest.spyOn(db, 'getListAgentsByAccess').mockImplementation(async (params) => {
        if (params.includeSkillConfig) {
          order.push('list-query');
          return { object: 'list', data: [], has_more: false, after: null };
        }
        return realList(params);
      });
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = { user: { id: userA.toString(), role: 'USER' }, query: {} };
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

      try {
        await getListAgentsHandler(mockReq, mockRes);
        expect(order).toContain('avatar-write');
        expect(order.indexOf('avatar-write')).toBeLessThan(order.indexOf('list-query'));
      } finally {
        listSpy.mockRestore();
        refreshS3Url.mockReset();
      }
    });

    test('should serve the refreshed filepath in the same response on cache miss', async () => {
      const agentId = agentWithS3Avatar.id;
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-s3-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      const agent = responseData.data.find((a) => a.id === agentId);
      /** The refresh runs alongside the list query, so the refreshed path must reach the
       *  response through `urlCache` rather than through what the list query read. */
      expect(agent.avatar.filepath).toBe('new-s3-path.jpg');
    });

    test('should scope the refresh query to S3 avatars without filtering the list query', async () => {
      const db = require('~/models');
      const listSpy = jest.spyOn(db, 'getListAgentsByAccess');
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithLocalAvatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      try {
        await getListAgentsHandler(mockReq, mockRes);

        /** The refresh pass must query only S3-avatar agents — `refreshListAvatars`
         *  skips non-S3 entries anyway, so without this assertion the filter could
         *  regress to `{}` (reloading the whole accessible set) unnoticed. */
        expect(listSpy).toHaveBeenCalledWith(
          expect.objectContaining({ otherParams: { 'avatar.source': FileSources.s3 } }),
        );
        /** The user-facing list query keeps the request filter, not the refresh scope. */
        expect(listSpy).toHaveBeenCalledWith(
          expect.objectContaining({ includeSkillConfig: true, otherParams: {} }),
        );

        expect(refreshS3Url).not.toHaveBeenCalled();
        const responseData = mockRes.json.mock.calls[0][0];
        const agent = responseData.data.find((a) => a.id === agentWithLocalAvatar.id);
        expect(agent.avatar.filepath).toBe('local-path.jpg');
      } finally {
        listSpy.mockRestore();
      }
    });

    test('should refresh avatars for all accessible agents (VIEW permission)', async () => {
      mockCache.get.mockResolvedValue(false);
      // User A has access to both their own agent and userB's agent
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id, agentOwnedByOther._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Should be called for both agents - any user with VIEW access can refresh
      expect(refreshS3Url).toHaveBeenCalledTimes(2);
    });

    test('should skip non-S3 avatars', async () => {
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithLocalAvatar._id, agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Should only be called for S3 avatar agent
      expect(refreshS3Url).toHaveBeenCalledTimes(1);
    });

    test('should not update if S3 URL unchanged', async () => {
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      // Return the same path - no update needed
      refreshS3Url.mockResolvedValue('old-s3-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Verify refreshS3Url was called
      expect(refreshS3Url).toHaveBeenCalled();

      // Response should still be returned
      expect(mockRes.json).toHaveBeenCalled();
    });

    test('should handle S3 refresh errors gracefully', async () => {
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockRejectedValue(new Error('S3 error'));

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      // Should not throw - handles error gracefully
      await expect(getListAgentsHandler(mockReq, mockRes)).resolves.not.toThrow();

      // Response should still be returned
      expect(mockRes.json).toHaveBeenCalled();
    });

    test('should process agents in batches', async () => {
      mockCache.get.mockResolvedValue(false);

      // Create 25 agents (should be processed in batches of 20)
      const manyAgents = [];
      for (let i = 0; i < 25; i++) {
        const agent = await Agent.create({
          id: `agent_${nanoid(12)}`,
          name: `Agent ${i}`,
          description: `Agent ${i} description`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
          avatar: {
            source: FileSources.s3,
            filepath: `path${i}.jpg`,
          },
          versions: [
            {
              name: `Agent ${i}`,
              description: `Agent ${i} description`,
              provider: 'openai',
              model: 'gpt-4',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        });
        manyAgents.push(agent);
      }

      const allAgentIds = manyAgents.map((a) => a._id);
      findAccessibleResources.mockResolvedValue(allAgentIds);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockImplementation((avatar) =>
        Promise.resolve(avatar.filepath.replace('.jpg', '-new.jpg')),
      );

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // All 25 should be processed
      expect(refreshS3Url).toHaveBeenCalledTimes(25);
    });

    test('should skip agents without id or author', async () => {
      mockCache.get.mockResolvedValue(false);

      // Create agent without proper id field (edge case)
      const agentWithoutId = await Agent.create({
        id: `agent_${nanoid(12)}`,
        name: 'Agent without ID field',
        description: 'Testing',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        avatar: {
          source: FileSources.s3,
          filepath: 'test-path.jpg',
        },
        versions: [
          {
            name: 'Agent without ID field',
            description: 'Testing',
            provider: 'openai',
            model: 'gpt-4',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      findAccessibleResources.mockResolvedValue([agentWithoutId._id, agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Should still complete without errors
      expect(mockRes.json).toHaveBeenCalled();
    });

    test('should use MAX_AVATAR_REFRESH_AGENTS limit for full list query', async () => {
      mockCache.get.mockResolvedValue(false);
      findAccessibleResources.mockResolvedValue([]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Verify that the handler completed successfully
      expect(mockRes.json).toHaveBeenCalled();
    });

    test('should treat legacy boolean cache entry as a miss and run refresh', async () => {
      // Simulate a cache entry written by the pre-fix code
      mockCache.get.mockResolvedValue(true);
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);
      refreshS3Url.mockResolvedValue('new-s3-path.jpg');

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      // Boolean true fails the shape guard, so refresh must run
      expect(refreshS3Url).toHaveBeenCalled();
      // Cache is overwritten with the proper format
      expect(mockCache.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ urlCache: expect.any(Object) }),
        expect.any(Number),
      );
    });

    test('should apply cached urlCache filepath to paginated response on cache hit', async () => {
      const agentId = agentWithS3Avatar.id;
      const cachedUrl = 'cached-presigned-url.jpg';

      mockCache.get.mockResolvedValue({ urlCache: { [agentId]: cachedUrl } });
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      expect(refreshS3Url).not.toHaveBeenCalled();

      const responseData = mockRes.json.mock.calls[0][0];
      const agent = responseData.data.find((a) => a.id === agentId);
      // Cached URL is served, not the stale DB value 'old-s3-path.jpg'
      expect(agent.avatar.filepath).toBe(cachedUrl);
    });

    test('should preserve DB filepath for agents absent from urlCache on cache hit', async () => {
      mockCache.get.mockResolvedValue({ urlCache: {} });
      findAccessibleResources.mockResolvedValue([agentWithS3Avatar._id]);
      findPubliclyAccessibleResources.mockResolvedValue([]);

      const mockReq = {
        user: { id: userA.toString(), role: 'USER' },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      await getListAgentsHandler(mockReq, mockRes);

      expect(refreshS3Url).not.toHaveBeenCalled();

      const responseData = mockRes.json.mock.calls[0][0];
      const agent = responseData.data.find((a) => a.id === agentWithS3Avatar.id);
      expect(agent.avatar.filepath).toBe('old-s3-path.jpg');
    });
  });

  describe('Edge ACL validation', () => {
    let targetAgent;

    beforeEach(async () => {
      targetAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: new mongoose.Types.ObjectId().toString(),
        name: 'Target Agent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
      });
    });

    test('createAgentHandler should return 403 when user lacks VIEW on an edge-referenced agent', async () => {
      const permMap = new Map();
      getResourcePermissionsMap.mockResolvedValueOnce(permMap);

      mockReq.body = {
        name: 'Attacker Agent',
        provider: 'openai',
        model: 'gpt-4',
        edges: [{ from: '', to: targetAgent.id, edgeType: 'handoff' }],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.agent_ids).toContain(targetAgent.id);
    });

    test('createAgentHandler should reject a missing graph-subagent member', async () => {
      const missingMemberId = 'agent_missing_graph_member';
      mockReq.config = {
        endpoints: { agents: { capabilities: ['subagents'] } },
      };
      mockReq.body = {
        name: 'Graph Parent',
        provider: 'openai',
        model: 'gpt-4',
        subagents: {
          enabled: true,
          allowSelf: false,
          graphs: [
            {
              type: 'research_team',
              name: 'Research team',
              description: 'Researches before answering',
              agent_ids: [targetAgent.id, missingMemberId],
              edges: [{ from: targetAgent.id, to: missingMemberId, edgeType: 'direct' }],
              entry_agent_id: targetAgent.id,
              result_agent_id: missingMemberId,
            },
          ],
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'One or more agents referenced in subagents do not exist',
        agent_ids: [missingMemberId],
      });
    });

    test('createAgentHandler should rewrite a graph self placeholder to the generated ID', async () => {
      mockReq.config = {
        endpoints: { agents: { capabilities: ['subagents'] } },
      };
      mockReq.body = {
        name: 'Self Graph Parent',
        provider: 'openai',
        model: 'gpt-4',
        subagents: {
          enabled: true,
          graphs: [
            {
              type: 'self_review',
              name: 'Self review',
              description: 'Runs the new agent in an isolated context',
              agent_ids: [''],
              edges: [],
              entry_agent_id: '',
              result_agent_id: '',
            },
          ],
        },
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const createdAgent = mockRes.json.mock.calls[0][0];
      expect(createdAgent.subagents.graphs[0]).toMatchObject({
        agent_ids: [createdAgent.id],
        entry_agent_id: createdAgent.id,
        result_agent_id: createdAgent.id,
      });
    });

    test('createAgentHandler should succeed when user has VIEW on all edge-referenced agents', async () => {
      const permMap = new Map([[targetAgent._id.toString(), 1]]);
      getResourcePermissionsMap.mockResolvedValueOnce(permMap);

      mockReq.body = {
        name: 'Legit Agent',
        provider: 'openai',
        model: 'gpt-4',
        edges: [{ from: '', to: targetAgent.id, edgeType: 'handoff' }],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.edges).toEqual([
        { from: response.id, to: targetAgent.id, edgeType: 'handoff' },
      ]);
    });

    test('createAgentHandler should reject a non-existent handoff target', async () => {
      mockReq.body = {
        name: 'Dangling Edge Agent',
        provider: 'openai',
        model: 'gpt-4',
        edges: [{ from: '', to: 'agent_missing_target', edgeType: 'handoff' }],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: ['agent_missing_target'],
      });
    });

    test('updateAgentHandler should return 403 when user lacks VIEW on an edge-referenced agent', async () => {
      const ownedAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: mockReq.user.id,
        name: 'Owned Agent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
      });

      const permMap = new Map([[ownedAgent._id.toString(), PermissionBits.VIEW]]);
      getResourcePermissionsMap.mockResolvedValueOnce(permMap);

      mockReq.params = { id: ownedAgent.id };
      mockReq.body = {
        edges: [{ from: ownedAgent.id, to: targetAgent.id, edgeType: 'handoff' }],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.agent_ids).toContain(targetAgent.id);
      expect(response.agent_ids).not.toContain(ownedAgent.id);
    });

    test('updateAgentHandler should repair a legacy empty handoff source', async () => {
      const ownedAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: mockReq.user.id,
        name: 'Legacy Router',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [{ from: '', to: targetAgent.id, edgeType: 'handoff' }],
      });
      getResourcePermissionsMap.mockResolvedValueOnce(
        new Map([
          [ownedAgent._id.toString(), PermissionBits.VIEW],
          [targetAgent._id.toString(), PermissionBits.VIEW],
        ]),
      );

      mockReq.params = { id: ownedAgent.id };
      mockReq.body = {
        edges: [{ from: '', to: targetAgent.id, edgeType: 'handoff' }],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          edges: [{ from: ownedAgent.id, to: targetAgent.id, edgeType: 'handoff' }],
        }),
      );
      const persisted = await Agent.findOne({ id: ownedAgent.id }).lean();
      expect(persisted.edges).toEqual([
        { from: ownedAgent.id, to: targetAgent.id, edgeType: 'handoff' },
      ]);
    });

    test('updateAgentHandler should succeed when edges field is absent from payload', async () => {
      const ownedAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: mockReq.user.id,
        name: 'Owned Agent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
      });

      mockReq.params = { id: ownedAgent.id };
      mockReq.body = { name: 'Renamed Agent' };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(403);
      const response = mockRes.json.mock.calls[0][0];
      expect(response.name).toBe('Renamed Agent');
    });

    test('duplicateAgentHandler should move current and legacy handoff sources to the clone', async () => {
      const sourceAgentId = `agent_${nanoid()}`;
      const secondTarget = await Agent.create({
        id: `agent_${nanoid()}`,
        author: new mongoose.Types.ObjectId().toString(),
        name: 'Second Target Agent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
      });
      const sourceAgent = await Agent.create({
        id: sourceAgentId,
        author: mockReq.user.id,
        name: 'Legacy Clone Source',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [
          { from: sourceAgentId, to: targetAgent.id, edgeType: 'handoff' },
          { from: '', to: secondTarget.id, edgeType: 'handoff' },
        ],
      });
      getResourcePermissionsMap.mockResolvedValueOnce(
        new Map([
          [targetAgent._id.toString(), PermissionBits.VIEW],
          [secondTarget._id.toString(), PermissionBits.VIEW],
        ]),
      );
      jest.spyOn(require('~/models'), 'getActions').mockResolvedValueOnce([]);

      mockReq.params = { id: sourceAgent.id };

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const { agent } = mockRes.json.mock.calls[0][0];
      expect(agent.edges).toEqual([
        { from: agent.id, to: targetAgent.id, edgeType: 'handoff' },
        { from: agent.id, to: secondTarget.id, edgeType: 'handoff' },
      ]);
    });

    test('duplicateAgentHandler should rewrite and allow a graph-team self member', async () => {
      const sourceAgentId = `agent_${nanoid()}`;
      await Agent.create({
        id: sourceAgentId,
        author: mockReq.user.id,
        name: 'Self Graph Clone Source',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        subagents: {
          enabled: true,
          allowSelf: false,
          graphs: [
            {
              type: 'self_team',
              name: 'Self team',
              description: 'Contains the parent and a worker',
              agent_ids: [sourceAgentId, targetAgent.id],
              edges: [{ from: sourceAgentId, to: targetAgent.id, edgeType: 'direct' }],
              entry_agent_id: sourceAgentId,
              result_agent_id: targetAgent.id,
            },
          ],
        },
      });
      getResourcePermissionsMap.mockResolvedValueOnce(
        new Map([[targetAgent._id.toString(), PermissionBits.VIEW]]),
      );
      jest.spyOn(require('~/models'), 'getActions').mockResolvedValueOnce([]);
      mockReq.config = { endpoints: { agents: { capabilities: ['subagents'] } } };
      mockReq.params = { id: sourceAgentId };

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const { agent } = mockRes.json.mock.calls[0][0];
      expect(agent.subagents.graphs[0]).toMatchObject({
        agent_ids: [agent.id, targetAgent.id],
        edges: [{ from: agent.id, to: targetAgent.id, edgeType: 'direct' }],
        entry_agent_id: agent.id,
        result_agent_id: targetAgent.id,
      });
    });

    test('duplicateAgentHandler should return 400 for a missing handoff target', async () => {
      const missingTargetId = `agent_${nanoid()}`;
      const sourceAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: mockReq.user.id,
        name: 'Stale Clone Source',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [{ from: '', to: missingTargetId, edgeType: 'handoff' }],
      });

      mockReq.params = { id: sourceAgent.id };

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: [missingTargetId],
      });
      expect(await Agent.countDocuments()).toBe(2);
    });

    test('duplicateAgentHandler should return 403 without VIEW access to a handoff target', async () => {
      const sourceAgentId = `agent_${nanoid()}`;
      const sourceAgent = await Agent.create({
        id: sourceAgentId,
        author: mockReq.user.id,
        name: 'Restricted Clone Source',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [{ from: sourceAgentId, to: targetAgent.id, edgeType: 'handoff' }],
      });
      getResourcePermissionsMap.mockResolvedValueOnce(new Map());

      mockReq.params = { id: sourceAgent.id };

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'You do not have access to one or more agents referenced in edges',
        agent_ids: [targetAgent.id],
      });
      expect(await Agent.countDocuments()).toBe(2);
    });

    test('duplicateAgentHandler should return 403 without VIEW access to a graph-subagent member', async () => {
      const sourceAgent = await Agent.create({
        id: `agent_${nanoid()}`,
        author: mockReq.user.id,
        name: 'Restricted Graph Clone Source',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        subagents: {
          enabled: true,
          allowSelf: false,
          graphs: [
            {
              type: 'restricted_team',
              name: 'Restricted team',
              description: 'Contains a restricted member',
              agent_ids: [targetAgent.id],
              edges: [],
              entry_agent_id: targetAgent.id,
              result_agent_id: targetAgent.id,
            },
          ],
        },
      });
      getResourcePermissionsMap.mockResolvedValueOnce(new Map());
      mockReq.config = { endpoints: { agents: { capabilities: ['subagents'] } } };
      mockReq.params = { id: sourceAgent.id };

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'You do not have access to one or more agents referenced in subagents',
        agent_ids: [targetAgent.id],
      });
      expect(await Agent.countDocuments()).toBe(2);
    });

    test('revertAgentVersionHandler should clear handoffs when the historical version has none', async () => {
      const agentId = `agent_${nanoid()}`;
      await Agent.create({
        id: agentId,
        author: mockReq.user.id,
        name: 'Current Router',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [{ from: agentId, to: targetAgent.id, edgeType: 'handoff' }],
        versions: [
          {
            name: 'Historical Router',
            provider: 'openai',
            model: 'gpt-4',
            tools: [],
          },
        ],
      });

      mockReq.params = { id: agentId };
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      const persisted = await Agent.findOne({ id: agentId }).lean();
      expect(persisted.name).toBe('Historical Router');
      expect(persisted.edges).toEqual([]);
    });

    test('revertAgentVersionHandler should restore accessible historical handoffs', async () => {
      const agentId = `agent_${nanoid()}`;
      const sourceAgent = await Agent.create({
        id: agentId,
        author: mockReq.user.id,
        name: 'Current Router',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        edges: [],
        versions: [
          {
            name: 'Historical Router',
            provider: 'openai',
            model: 'gpt-4',
            tools: [],
            edges: [{ from: '', to: targetAgent.id, edgeType: 'handoff' }],
          },
        ],
      });
      getResourcePermissionsMap.mockResolvedValueOnce(
        new Map([
          [sourceAgent._id.toString(), PermissionBits.VIEW],
          [targetAgent._id.toString(), PermissionBits.VIEW],
        ]),
      );

      mockReq.params = { id: agentId };
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).not.toHaveBeenCalledWith(400);
      expect(mockRes.status).not.toHaveBeenCalledWith(403);
      const persisted = await Agent.findOne({ id: agentId }).lean();
      expect(persisted.name).toBe('Historical Router');
      expect(persisted.edges).toEqual([{ from: agentId, to: targetAgent.id, edgeType: 'handoff' }]);
    });

    test('revertAgentVersionHandler should return 400 before restoring a missing handoff target', async () => {
      const agentId = `agent_${nanoid()}`;
      const missingTargetId = `agent_${nanoid()}`;
      await Agent.create({
        id: agentId,
        author: mockReq.user.id,
        name: 'Current Router',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        versions: [
          {
            name: 'Stale Historical Router',
            provider: 'openai',
            model: 'gpt-4',
            tools: [],
            edges: [{ from: agentId, to: missingTargetId, edgeType: 'handoff' }],
          },
        ],
      });

      mockReq.params = { id: agentId };
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: [missingTargetId],
      });
      const persisted = await Agent.findOne({ id: agentId }).lean();
      expect(persisted.name).toBe('Current Router');
    });

    test('revertAgentVersionHandler should return 400 before restoring a missing graph-subagent member', async () => {
      const agentId = `agent_${nanoid()}`;
      const missingMemberId = `agent_${nanoid()}`;
      await Agent.create({
        id: agentId,
        author: mockReq.user.id,
        name: 'Current Graph Parent',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        versions: [
          {
            name: 'Historical Graph Parent',
            provider: 'openai',
            model: 'gpt-4',
            tools: [],
            subagents: {
              enabled: true,
              allowSelf: false,
              graphs: [
                {
                  type: 'missing_team',
                  name: 'Missing team',
                  description: 'Contains a deleted member',
                  agent_ids: [missingMemberId],
                  edges: [],
                  entry_agent_id: missingMemberId,
                  result_agent_id: missingMemberId,
                },
              ],
            },
          },
        ],
      });
      mockReq.config = { endpoints: { agents: { capabilities: ['subagents'] } } };
      mockReq.params = { id: agentId };
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'One or more agents referenced in subagents do not exist',
        agent_ids: [missingMemberId],
      });
      const persisted = await Agent.findOne({ id: agentId }).lean();
      expect(persisted.name).toBe('Current Graph Parent');
    });

    test('revertAgentVersionHandler should return 403 before restoring a restricted handoff target', async () => {
      const agentId = `agent_${nanoid()}`;
      const sourceAgent = await Agent.create({
        id: agentId,
        author: mockReq.user.id,
        name: 'Current Router',
        provider: 'openai',
        model: 'gpt-4',
        tools: [],
        versions: [
          {
            name: 'Restricted Historical Router',
            provider: 'openai',
            model: 'gpt-4',
            tools: [],
            edges: [{ from: agentId, to: targetAgent.id, edgeType: 'handoff' }],
          },
        ],
      });
      getResourcePermissionsMap.mockResolvedValueOnce(
        new Map([[sourceAgent._id.toString(), PermissionBits.VIEW]]),
      );

      mockReq.params = { id: agentId };
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'You do not have access to one or more agents referenced in edges',
        agent_ids: [targetAgent.id],
      });
      const persisted = await Agent.findOne({ id: agentId }).lean();
      expect(persisted.name).toBe('Current Router');
    });
  });
});
