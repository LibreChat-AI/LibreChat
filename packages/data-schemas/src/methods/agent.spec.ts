import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AccessRoleIds,
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
  EToolResources,
  SkillsScope,
  Constants,
  actionDelimiter,
} from 'librechat-data-provider';
import type {
  UpdateWithAggregationPipeline,
  RootFilterQuery,
  QueryOptions,
  UpdateQuery,
  Model,
} from 'mongoose';
import type { IAgent, IAclEntry, IUser, IAccessRole, CodeEnvironmentDocument } from '..';
import {
  createAgentMethods,
  AGENT_OWNER_CONTACT_RESOLVED_FIELD,
  EDGE_CLEANUP_BATCH,
  EDGE_CLEANUP_MAX_SWEEPS,
  type AgentMethods,
} from './agent';
import { withCodeEnvironmentReference } from './codeEnvironment';
import { tenantStorage } from '~/config/tenantContext';
import { createAclEntryMethods } from './aclEntry';
import { createModels } from '~/models';

/** Version snapshot stored in `IAgent.versions[]`. Extends the base omit with runtime-only fields. */
type VersionEntry = Omit<IAgent, 'versions'> & {
  __v?: number;
  versions?: unknown;
  version?: number;
  updatedBy?: mongoose.Types.ObjectId;
};

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Agent: mongoose.Model<IAgent>;
let AclEntry: mongoose.Model<IAclEntry>;
let User: mongoose.Model<IUser>;
let AccessRole: mongoose.Model<IAccessRole>;
let modelsToCleanup: string[] = [];
let methods: ReturnType<typeof createAgentMethods>;

let createAgent: AgentMethods['createAgent'];
let getAgent: AgentMethods['getAgent'];
let getAgentVersions: AgentMethods['getAgentVersions'];
let getAgentWithVersionCount: AgentMethods['getAgentWithVersionCount'];
let updateAgent: AgentMethods['updateAgent'];
let updateAgentAvatar: AgentMethods['updateAgentAvatar'];
let deleteAgent: AgentMethods['deleteAgent'];
let deleteUserAgents: AgentMethods['deleteUserAgents'];
let revertAgentVersion: AgentMethods['revertAgentVersion'];
let addAgentResourceFile: AgentMethods['addAgentResourceFile'];
let removeAgentResourceFiles: AgentMethods['removeAgentResourceFiles'];
let removeAgentResourceFilesFromAllAgents: AgentMethods['removeAgentResourceFilesFromAllAgents'];
let getSharedResourceFileIds: AgentMethods['getSharedResourceFileIds'];
let getListAgentsByAccess: AgentMethods['getListAgentsByAccess'];
let getAgentManagementListByAccess: AgentMethods['getAgentManagementListByAccess'];
let generateActionMetadataHash: AgentMethods['generateActionMetadataHash'];

const getActions = jest.fn().mockResolvedValue([]);
const externalSkillIds = new Set<string>();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Agent = mongoose.models.Agent as mongoose.Model<IAgent>;
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  User = mongoose.models.User as mongoose.Model<IUser>;
  AccessRole = mongoose.models.AccessRole as mongoose.Model<IAccessRole>;

  const removeAllPermissions = async ({
    resourceType,
    resourceId,
  }: {
    resourceType: string;
    resourceId: unknown;
  }) => {
    await AclEntry.deleteMany({ resourceType, resourceId });
  };

  const aclEntryMethods = createAclEntryMethods(mongoose);
  const { getSoleOwnedResourceIds, findAccessibleResources } = aclEntryMethods;

  methods = createAgentMethods(mongoose, {
    removeAllPermissions,
    getActions,
    getSoleOwnedResourceIds,
    getUserPrincipals: async ({ userId }) => [
      { principalType: 'user', principalId: new mongoose.Types.ObjectId(userId) },
    ],
    findAccessibleResources,
    isExternalSkillId: (id) => externalSkillIds.has(id),
  });
  createAgent = methods.createAgent;
  getAgent = methods.getAgent;
  getAgentVersions = methods.getAgentVersions;
  getAgentWithVersionCount = methods.getAgentWithVersionCount;
  updateAgent = methods.updateAgent;
  updateAgentAvatar = methods.updateAgentAvatar;
  deleteAgent = methods.deleteAgent;
  deleteUserAgents = methods.deleteUserAgents;
  revertAgentVersion = methods.revertAgentVersion;
  addAgentResourceFile = methods.addAgentResourceFile;
  removeAgentResourceFiles = methods.removeAgentResourceFiles;
  removeAgentResourceFilesFromAllAgents = methods.removeAgentResourceFilesFromAllAgents;
  getSharedResourceFileIds = methods.getSharedResourceFileIds;
  getListAgentsByAccess = methods.getListAgentsByAccess;
  getAgentManagementListByAccess = methods.getAgentManagementListByAccess;
  generateActionMetadataHash = methods.generateActionMetadataHash;

  await mongoose.connect(mongoUri);

  await AccessRole.create({
    accessRoleId: AccessRoleIds.AGENT_OWNER,
    name: 'Owner',
    description: 'Full control over agents',
    resourceType: ResourceType.AGENT,
    permBits: 15,
  });
}, 30000);

afterAll(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete (mongoose.models as Record<string, unknown>)[modelName];
    }
  }
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Agent Methods', () => {
  beforeEach(() => {
    externalSkillIds.clear();
  });

  describe('Agent Resource File Operations', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
      await User.deleteMany({});
    });

    test('should add tool_resource to tools if missing', async () => {
      const agent = await createBasicAgent();
      const fileId = uuidv4();
      const toolResource = 'file_search';

      const updatedAgent = await addAgentResourceFile({
        agent_id: agent.id,
        tool_resource: toolResource,
        file_id: fileId,
      });

      expect(updatedAgent!.tools).toContain(toolResource);
      expect(Array.isArray(updatedAgent!.tools)).toBe(true);
      // Should not duplicate
      const count = updatedAgent!.tools?.filter((t) => t === toolResource).length ?? 0;
      expect(count).toBe(1);
    });

    test('should not duplicate tool_resource in tools if already present', async () => {
      const agent = await createBasicAgent();
      const fileId1 = uuidv4();
      const fileId2 = uuidv4();
      const toolResource = 'file_search';

      // First add
      await addAgentResourceFile({
        agent_id: agent.id,
        tool_resource: toolResource,
        file_id: fileId1,
      });

      // Second add (should not duplicate)
      const updatedAgent = await addAgentResourceFile({
        agent_id: agent.id,
        tool_resource: toolResource,
        file_id: fileId2,
      });

      expect(updatedAgent!.tools).toContain(toolResource);
      expect(Array.isArray(updatedAgent!.tools)).toBe(true);
      const count = updatedAgent!.tools?.filter((t) => t === toolResource).length ?? 0;
      expect(count).toBe(1);
    });

    test('should handle concurrent file additions', async () => {
      const agent = await createBasicAgent();
      const fileIds = Array.from({ length: 10 }, () => uuidv4());

      // Concurrent additions
      const additionPromises = createFileOperations(agent.id, fileIds, 'add');

      await Promise.all(additionPromises);

      const updatedAgent = await Agent.findOne({ id: agent.id });
      expect(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).toBeDefined();
      expect(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).toHaveLength(
        10,
      );
      expect(
        new Set(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).size,
      ).toBe(10);
    });

    test('should handle concurrent additions and removals', async () => {
      const agent = await createBasicAgent();
      const initialFileIds = Array.from({ length: 5 }, () => uuidv4());

      await Promise.all(createFileOperations(agent.id, initialFileIds, 'add'));

      const newFileIds = Array.from({ length: 5 }, () => uuidv4());
      const operations: Promise<IAgent>[] = [
        ...newFileIds.map((fileId) =>
          addAgentResourceFile({
            agent_id: agent.id,
            tool_resource: EToolResources.execute_code,
            file_id: fileId,
          }),
        ),
        ...initialFileIds.map((fileId) =>
          removeAgentResourceFiles({
            agent_id: agent.id,
            files: [{ tool_resource: EToolResources.execute_code, file_id: fileId }],
          }),
        ),
      ];

      await Promise.all(operations);

      const updatedAgent = await Agent.findOne({ id: agent.id });
      expect(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).toBeDefined();
      expect(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).toHaveLength(5);
    });

    test('should initialize array when adding to non-existent tool resource', async () => {
      const agent = await createBasicAgent();
      const fileId = uuidv4();

      const updatedAgent = await addAgentResourceFile({
        agent_id: agent.id,
        tool_resource: EToolResources.context,
        file_id: fileId,
      });

      expect(updatedAgent?.tool_resources?.[EToolResources.context]?.file_ids).toBeDefined();
      expect(updatedAgent?.tool_resources?.[EToolResources.context]?.file_ids).toHaveLength(1);
      expect(updatedAgent?.tool_resources?.[EToolResources.context]?.file_ids?.[0]).toBe(fileId);
    });

    test('should handle rapid sequential modifications to same tool resource', async () => {
      const agent = await createBasicAgent();
      const fileId = uuidv4();

      for (let i = 0; i < 10; i++) {
        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.execute_code,
          file_id: `${fileId}_${i}`,
        });

        if (i % 2 === 0) {
          await removeAgentResourceFiles({
            agent_id: agent.id,
            files: [{ tool_resource: EToolResources.execute_code, file_id: `${fileId}_${i}` }],
          });
        }
      }

      const updatedAgent = await Agent.findOne({ id: agent.id });
      expect(updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids).toBeDefined();
      expect(
        Array.isArray(updatedAgent!.tool_resources![EToolResources.execute_code]!.file_ids),
      ).toBe(true);
    });

    test('should handle multiple tool resources concurrently', async () => {
      const agent = await createBasicAgent();
      const toolResources = [
        EToolResources.file_search,
        EToolResources.execute_code,
        EToolResources.image_edit,
      ] as const;
      const operations: Promise<IAgent>[] = [];

      toolResources.forEach((tool) => {
        const fileIds = Array.from({ length: 5 }, () => uuidv4());
        fileIds.forEach((fileId) => {
          operations.push(
            addAgentResourceFile({
              agent_id: agent.id,
              tool_resource: tool,
              file_id: fileId,
            }),
          );
        });
      });

      await Promise.all(operations);

      const updatedAgent = await Agent.findOne({ id: agent.id });
      toolResources.forEach((tool) => {
        expect(updatedAgent!.tool_resources![tool]!.file_ids).toBeDefined();
        expect(updatedAgent!.tool_resources![tool]!.file_ids).toHaveLength(5);
      });
    });

    test.each([
      {
        name: 'duplicate additions',
        operation: 'add',
        duplicateCount: 5,
        expectedLength: 1,
        expectedContains: true,
      },
      {
        name: 'duplicate removals',
        operation: 'remove',
        duplicateCount: 5,
        expectedLength: 0,
        expectedContains: false,
        setupFile: true,
      },
    ])(
      'should handle concurrent $name',
      async ({ operation, duplicateCount, expectedLength, expectedContains, setupFile }) => {
        const agent = await createBasicAgent();
        const fileId = uuidv4();

        if (setupFile) {
          await addAgentResourceFile({
            agent_id: agent.id,
            tool_resource: EToolResources.execute_code,
            file_id: fileId,
          });
        }

        const promises = Array.from({ length: duplicateCount }).map(() =>
          operation === 'add'
            ? addAgentResourceFile({
                agent_id: agent.id,
                tool_resource: EToolResources.execute_code,
                file_id: fileId,
              })
            : removeAgentResourceFiles({
                agent_id: agent.id,
                files: [{ tool_resource: EToolResources.execute_code, file_id: fileId }],
              }),
        );

        await Promise.all(promises);

        const updatedAgent = await Agent.findOne({ id: agent.id });
        const fileIds = updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids ?? [];

        expect(fileIds).toHaveLength(expectedLength);
        if (expectedContains) {
          expect(fileIds[0]).toBe(fileId);
        } else {
          expect(fileIds).not.toContain(fileId);
        }
      },
    );

    test('should handle concurrent add and remove of the same file', async () => {
      const agent = await createBasicAgent();
      const fileId = uuidv4();

      await addAgentResourceFile({
        agent_id: agent.id,
        tool_resource: EToolResources.execute_code,
        file_id: fileId,
      });

      const operations: Promise<IAgent>[] = [
        addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.execute_code,
          file_id: fileId,
        }),
        removeAgentResourceFiles({
          agent_id: agent.id,
          files: [{ tool_resource: EToolResources.execute_code, file_id: fileId }],
        }),
      ];

      await Promise.all(operations);

      const updatedAgent = await Agent.findOne({ id: agent.id });
      const finalFileIds = updatedAgent!.tool_resources![EToolResources.execute_code]!.file_ids!;
      const count = finalFileIds.filter((id: string) => id === fileId).length;

      expect(count).toBeLessThanOrEqual(1);
      if (count === 0) {
        expect(finalFileIds).toHaveLength(0);
      } else {
        expect(finalFileIds).toHaveLength(1);
        expect(finalFileIds[0]).toBe(fileId);
      }
    });

    test('should handle concurrent removals of different files', async () => {
      const agent = await createBasicAgent();
      const fileIds = Array.from({ length: 10 }, () => uuidv4());

      // Add all files first
      await Promise.all(
        fileIds.map((fileId) =>
          addAgentResourceFile({
            agent_id: agent.id,
            tool_resource: EToolResources.execute_code,
            file_id: fileId,
          }),
        ),
      );

      // Concurrently remove all files
      const removalPromises = fileIds.map((fileId) =>
        removeAgentResourceFiles({
          agent_id: agent.id,
          files: [{ tool_resource: EToolResources.execute_code, file_id: fileId }],
        }),
      );

      await Promise.all(removalPromises);

      const updatedAgent = await Agent.findOne({ id: agent.id });
      // Check if the array is empty or the tool resource itself is removed
      const finalFileIds =
        updatedAgent?.tool_resources?.[EToolResources.execute_code]?.file_ids ?? [];
      expect(finalFileIds).toHaveLength(0);
    });

    describe('Edge Cases', () => {
      describe.each([
        {
          operation: 'add',
          name: 'empty file_id',
          needsAgent: true,
          params: { tool_resource: 'file_search', file_id: '' },
          shouldResolve: true,
        },
        {
          operation: 'add',
          name: 'non-existent agent',
          needsAgent: false,
          params: { tool_resource: 'file_search', file_id: 'file123' },
          shouldResolve: false,
          error: 'Agent not found for adding resource file',
        },
      ])('addAgentResourceFile with $name', ({ needsAgent, params, shouldResolve, error }) => {
        test(`should ${shouldResolve ? 'resolve' : 'reject'}`, async () => {
          const agent = needsAgent ? await createBasicAgent() : null;
          const agent_id = needsAgent ? agent!.id : `agent_${uuidv4()}`;

          if (shouldResolve) {
            await expect(addAgentResourceFile({ agent_id, ...params })).resolves.toBeDefined();
          } else {
            await expect(addAgentResourceFile({ agent_id, ...params })).rejects.toThrow(error);
          }
        });
      });

      describe.each([
        {
          name: 'empty files array',
          files: [] as { tool_resource: string; file_id: string }[],
          needsAgent: true,
          shouldResolve: true,
        },
        {
          name: 'non-existent tool_resource',
          files: [{ tool_resource: 'non_existent_tool', file_id: 'file123' }],
          needsAgent: true,
          shouldResolve: true,
        },
        {
          name: 'non-existent agent',
          files: [{ tool_resource: 'file_search', file_id: 'file123' }],
          needsAgent: false,
          shouldResolve: false,
          error: 'Agent not found for removing resource files',
        },
      ])('removeAgentResourceFiles with $name', ({ files, needsAgent, shouldResolve, error }) => {
        test(`should ${shouldResolve ? 'resolve' : 'reject'}`, async () => {
          const agent = needsAgent ? await createBasicAgent() : null;
          const agent_id = needsAgent ? agent!.id : `agent_${uuidv4()}`;

          if (shouldResolve) {
            const result = await removeAgentResourceFiles({ agent_id, files });
            expect(result).toBeDefined();
            if (agent) {
              expect(result.id).toBe(agent.id);
            }
          } else {
            await expect(removeAgentResourceFiles({ agent_id, files })).rejects.toThrow(error);
          }
        });
      });
    });
  });

  describe('Agent CRUD Operations', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
      await User.deleteMany({});
      await AclEntry.deleteMany({});
    });

    test('should create and get an agent', async () => {
      const { agentId, authorId } = createTestIds();

      const newAgent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        description: 'Test description',
      });

      expect(newAgent).toBeDefined();
      expect(newAgent.id).toBe(agentId);
      expect(newAgent.name).toBe('Test Agent');

      const retrievedAgent = await getAgent({ id: agentId });
      expect(retrievedAgent).toBeDefined();
      expect(retrievedAgent!.id).toBe(agentId);
      expect(retrievedAgent!.name).toBe('Test Agent');
      expect(retrievedAgent!.description).toBe('Test description');
    });

    test('should derive mcpServerNames only from MCP tools on create', async () => {
      const { agentId, authorId } = createTestIds();
      const actionTool = `sync${Constants.mcp_delimiter}state${actionDelimiter}api---example---com`;
      const mcpTool = `search${Constants.mcp_delimiter}authorizedServer`;

      const newAgent = await createAgent({
        id: agentId,
        name: 'MCP Names Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [actionTool, mcpTool],
      });

      expect(newAgent.mcpServerNames).toEqual(['authorizedServer']);
    });

    test('loads ACL-visible graph nodes by logical ID without exposing storage IDs', async () => {
      const { agentId, authorId } = createTestIds();
      const visible = await createAgent({
        id: agentId,
        name: 'Visible graph agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [`search${Constants.mcp_delimiter}docs`],
      });
      const privateAgent = await createAgent({
        id: `private-${agentId}`,
        name: 'Private graph agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: visible._id,
        permBits: PermissionBits.VIEW,
        grantedBy: authorId,
      });

      const access = await methods.resolveAgentGraphAccess({
        userId: authorId.toString(),
      });
      const nodes = await methods.getAgentGraphNodes([visible.id, privateAgent.id], access);

      expect(nodes).toEqual([
        expect.objectContaining({ id: visible.id, mcpServerNames: ['docs'] }),
      ]);
      expect(nodes[0]).not.toHaveProperty('_id');
    });

    describe('MCP server name candidate lookups', () => {
      test('getAgentsWithMCPServerNames returns only agents with a non-empty list, projected', async () => {
        const { agentId, authorId } = createTestIds();
        await createAgent({
          id: agentId,
          name: 'MCP Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
          mcpServerNames: ['server-a', 'server-b'],
        });
        await createAgent({
          id: `no-mcp-${agentId}`,
          name: 'Plain Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
        });

        const candidates = await methods.getAgentsWithMCPServerNames();

        expect(candidates).toHaveLength(1);
        expect(candidates[0].mcpServerNames).toEqual(['server-a', 'server-b']);
        expect(Object.keys(candidates[0]).sort()).toEqual(['_id', 'mcpServerNames']);
      });

      test('getAgentsWithMCPServerNames returns empty when no agent references MCP servers', async () => {
        const { agentId, authorId } = createTestIds();
        await createAgent({
          id: agentId,
          name: 'Plain Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
        });

        expect(await methods.getAgentsWithMCPServerNames()).toEqual([]);
      });

      test('getAgentsWithMCPServerNames stays within the active tenant', async () => {
        const tenantA = `tenant-a-${uuidv4()}`;
        const tenantB = `tenant-b-${uuidv4()}`;
        const { agentId, authorId } = createTestIds();
        const agentA = await tenantStorage.run({ tenantId: tenantA }, async () =>
          createAgent({
            id: agentId,
            name: 'Tenant A MCP Agent',
            provider: 'test',
            model: 'test-model',
            author: authorId,
            mcpServerNames: ['server-a'],
          }),
        );
        const agentB = await tenantStorage.run({ tenantId: tenantB }, async () =>
          createAgent({
            id: agentId,
            name: 'Tenant B MCP Agent',
            provider: 'test',
            model: 'test-model',
            author: authorId,
            mcpServerNames: ['server-b'],
          }),
        );

        const inA = await tenantStorage.run({ tenantId: tenantA }, () =>
          methods.getAgentsWithMCPServerNames(),
        );
        const inB = await tenantStorage.run({ tenantId: tenantB }, () =>
          methods.getAgentsWithMCPServerNames(),
        );

        expect(inA.map((agent) => agent._id.toString())).toEqual([agentA._id.toString()]);
        expect(inB.map((agent) => agent._id.toString())).toEqual([agentB._id.toString()]);
      });

      test('getAgentIdsByMCPServerName returns ids of agents referencing the server', async () => {
        const { agentId, authorId } = createTestIds();
        const withServer = await createAgent({
          id: agentId,
          name: 'Gitlab Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
          mcpServerNames: ['gitlab', 'other'],
        });
        await createAgent({
          id: `second-${agentId}`,
          name: 'Second Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
          mcpServerNames: ['gitlab'],
        });
        await createAgent({
          id: `unrelated-${agentId}`,
          name: 'Unrelated Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
          mcpServerNames: ['not-gitlab'],
        });

        const ids = (await methods.getAgentIdsByMCPServerName('gitlab')).map((id) => id.toString());

        expect(ids).toHaveLength(2);
        expect(ids).toContain(withServer._id.toString());
      });

      test('getAgentIdsByMCPServerName returns empty when no agent references the server', async () => {
        const { agentId, authorId } = createTestIds();
        await createAgent({
          id: agentId,
          name: 'Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
          mcpServerNames: ['other-server'],
        });

        expect(await methods.getAgentIdsByMCPServerName('gitlab')).toEqual([]);
      });
    });

    test('should derive the server from a key whose raw tool name contains the delimiter', async () => {
      const { agentId, authorId } = createTestIds();
      /** DB server names are slugs and cannot contain the delimiter, so the trailing
       *  segment is the real server even when the raw tool name carries one. Shared-agent
       *  access is keyed off this field, so it must not be dropped. */
      const gatewayTool = `get${Constants.mcp_delimiter}server_version${Constants.mcp_delimiter}gitlab`;

      const newAgent = await createAgent({
        id: agentId,
        name: 'Gateway MCP Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [gatewayTool],
      });

      expect(newAgent.mcpServerNames).toEqual(['gitlab']);
    });

    test('should preserve a resolved server name across an update that omits it', async () => {
      const { agentId, authorId } = createTestIds();
      /** Any caller that writes `tools` without `mcpServerNames` — the Action edit
       *  path, for one — must not have a configured `Google_mcp_Workspace` reduced to
       *  `Workspace`, which ServerConfigsDB would resolve as an unrelated DB server. */
      const mcpTool = `search${Constants.mcp_delimiter}Google${Constants.mcp_delimiter}Workspace`;
      await createAgent({
        id: agentId,
        name: 'Provenance Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [mcpTool],
        mcpServerNames: [`Google${Constants.mcp_delimiter}Workspace`],
      });

      const updated = await updateAgent({ id: agentId }, { tools: [mcpTool, 'web_search'] });

      expect(updated!.mcpServerNames).toEqual([`Google${Constants.mcp_delimiter}Workspace`]);
      expect(updated!.mcpServerNames).not.toContain('Workspace');
    });

    test('should drop a resolved name once its last tool is gone', async () => {
      const { agentId, authorId } = createTestIds();
      const mcpTool = `search${Constants.mcp_delimiter}Google${Constants.mcp_delimiter}Workspace`;
      await createAgent({
        id: agentId,
        name: 'Provenance Agent 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [mcpTool],
        mcpServerNames: [`Google${Constants.mcp_delimiter}Workspace`],
      });

      const updated = await updateAgent({ id: agentId }, { tools: ['web_search'] });

      expect(updated!.mcpServerNames).toEqual([]);
    });

    test('should derive mcpServerNames only from MCP tools on update', async () => {
      const { agentId, authorId } = createTestIds();
      const actionTool = `sync${Constants.mcp_delimiter}state${actionDelimiter}api---example---com`;
      const mcpTool = `search${Constants.mcp_delimiter}authorizedServer`;

      await createAgent({
        id: agentId,
        name: 'MCP Names Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [],
      });

      const updatedAgent = await updateAgent({ id: agentId }, { tools: [actionTool, mcpTool] });

      expect(updatedAgent!.mcpServerNames).toEqual(['authorizedServer']);
    });

    test('should prune nonexistent skill ids from the allowlist on create', async () => {
      const { agentId, authorId } = createTestIds();
      const realSkill = await mongoose.models.Skill.create({
        name: 'create-prune-skill',
        description: 'Skill backing the create-time allowlist pruning test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const danglingId = new mongoose.Types.ObjectId().toString();

      const newAgent = await createAgent({
        id: agentId,
        name: 'Skill Prune Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [realSkill._id.toString(), danglingId],
        skills_enabled: true,
      });

      expect(newAgent.skills).toEqual([realSkill._id.toString()]);
    });
    test('should preserve skills enabled when pruning empties the allowlist on create with all scope', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      const newAgent = await createAgent({
        id: agentId,
        name: 'All Scope Create Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [danglingId],
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      });

      const reloadedAgent = await getAgent({ id: agentId });

      expect(newAgent.skills).toEqual([]);
      expect(newAgent.skills_enabled).toBe(true);
      expect(newAgent.skills_scope).toBe(SkillsScope.all);
      expect(reloadedAgent!.skills).toEqual([]);
      expect(reloadedAgent!.skills_enabled).toBe(true);
      expect(reloadedAgent!.skills_scope).toBe(SkillsScope.all);
    });

    test('should fail closed when pruning empties the allowlist on create', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      const newAgent = await createAgent({
        id: agentId,
        name: 'Legacy Create Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [danglingId],
        skills_enabled: true,
      });

      const reloadedAgent = await getAgent({ id: agentId });

      expect(newAgent.skills).toEqual([]);
      expect(newAgent.skills_enabled).toBe(false);
      expect(reloadedAgent!.skills).toEqual([]);
      expect(reloadedAgent!.skills_enabled).toBe(false);
    });

    test('should fail closed when pruning empties the allowlist on create with none scope', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      const newAgent = await createAgent({
        id: agentId,
        name: 'None Scope Create Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [danglingId],
        skills_enabled: true,
        skills_scope: SkillsScope.none,
      });

      const reloadedAgent = await getAgent({ id: agentId });

      expect(newAgent.skills).toEqual([]);
      expect(newAgent.skills_enabled).toBe(false);
      expect(reloadedAgent!.skills).toEqual([]);
      expect(reloadedAgent!.skills_enabled).toBe(false);
      expect(reloadedAgent!.skills_scope).toBe(SkillsScope.none);
    });

    test('should preserve external skill ids on create', async () => {
      const { agentId, authorId } = createTestIds();
      const realSkill = await mongoose.models.Skill.create({
        name: 'create-external-skill',
        description: 'Skill backing the external create-time allowlist test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const externalSkillId = new mongoose.Types.ObjectId().toString();
      const danglingId = new mongoose.Types.ObjectId().toString();
      externalSkillIds.add(externalSkillId);

      const newAgent = await createAgent({
        id: agentId,
        name: 'External Skill Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [externalSkillId, realSkill._id.toString(), danglingId, externalSkillId],
        skills_enabled: true,
      });

      expect(newAgent.skills).toEqual([externalSkillId, realSkill._id.toString()]);
      expect(newAgent.skills_enabled).toBe(true);
    });

    test('should prune nonexistent skill ids from the allowlist on update', async () => {
      const { agentId, authorId } = createTestIds();
      const realSkill = await mongoose.models.Skill.create({
        name: 'update-prune-skill',
        description: 'Skill backing the update-time allowlist pruning test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const danglingId = new mongoose.Types.ObjectId().toString();

      await createAgent({
        id: agentId,
        name: 'Skill Prune Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { skills: [danglingId, realSkill._id.toString()], skills_enabled: true },
      );

      expect(updatedAgent!.skills).toEqual([realSkill._id.toString()]);
      expect(updatedAgent!.skills_enabled).toBe(true);
    });

    test('should preserve external skill ids on update', async () => {
      const { agentId, authorId } = createTestIds();
      const externalSkillId = new mongoose.Types.ObjectId().toString();
      const danglingId = new mongoose.Types.ObjectId().toString();
      externalSkillIds.add(externalSkillId);

      await createAgent({
        id: agentId,
        name: 'External Skill Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { skills: [danglingId, externalSkillId], skills_enabled: true },
      );

      expect(updatedAgent!.skills).toEqual([externalSkillId]);
      expect(updatedAgent!.skills_enabled).toBe(true);
    });

    test('should fail closed when pruning empties the allowlist on update', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      await createAgent({
        id: agentId,
        name: 'Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { skills: [danglingId], skills_enabled: true },
      );

      expect(updatedAgent!.skills).toEqual([]);
      expect(updatedAgent!.skills_enabled).toBe(false);
    });

    test('should preserve skills when pruning empties the allowlist for an agent with all scope', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      await createAgent({
        id: agentId,
        name: 'All Scope Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      });

      const updatedAgent = await updateAgent({ id: agentId }, { skills: [danglingId] });

      expect(updatedAgent!.skills).toEqual([]);
      expect(updatedAgent!.skills_enabled).toBe(true);
      expect(updatedAgent!.skills_scope).toBe(SkillsScope.all);
    });

    test('should preserve skills when pruning empties the allowlist for an update-scoped legacy agent', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      await createAgent({
        id: agentId,
        name: 'Selected Scope Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills_enabled: true,
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { skills: [danglingId], skills_scope: SkillsScope.selected },
      );

      expect(updatedAgent!.skills).toEqual([]);
      expect(updatedAgent!.skills_enabled).toBe(true);
    });

    test('should fail closed when pruning empties the allowlist for a none-scoped agent', async () => {
      const { agentId, authorId } = createTestIds();
      const danglingId = new mongoose.Types.ObjectId().toString();

      /** An explicit `none` carrying a true master flag is contradictory: it
       *  renders as Off while `skillDeps` still exposes the authoring tools,
       *  so it must not opt out of the fail-closed branch. */
      await createAgent({
        id: agentId,
        name: 'None Scope Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills_enabled: true,
        skills_scope: SkillsScope.none,
      });

      const updatedAgent = await updateAgent({ id: agentId }, { skills: [danglingId] });

      expect(updatedAgent!.skills).toEqual([]);
      expect(updatedAgent!.skills_enabled).toBe(false);
      expect(updatedAgent!.skills_scope).toBe(SkillsScope.none);
    });

    test('should keep full-catalog semantics for an explicit empty allowlist on update', async () => {
      const { agentId, authorId } = createTestIds();

      await createAgent({
        id: agentId,
        name: 'Explicit Empty Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const updatedAgent = await updateAgent({ id: agentId }, { skills: [], skills_enabled: true });

      expect(updatedAgent!.skills).toEqual([]);
      expect(updatedAgent!.skills_enabled).toBe(true);
    });

    test('should delete an agent', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const agentBeforeDelete = await getAgent({ id: agentId });
      expect(agentBeforeDelete).toBeDefined();

      await deleteAgent({ id: agentId });

      const agentAfterDelete = await getAgent({ id: agentId });
      expect(agentAfterDelete).toBeNull();
    });

    test('should remove ACL entries when deleting an agent', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent
      const agent = await createAgent({
        id: agentId,
        name: 'Agent With Permissions',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Grant permissions (simulating sharing)
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: authorId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: authorId,
      });

      // Verify ACL entry exists
      const aclEntriesBefore = await AclEntry.find({
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
      });
      expect(aclEntriesBefore).toHaveLength(1);

      // Delete the agent
      await deleteAgent({ id: agentId });

      // Verify agent is deleted
      const agentAfterDelete = await getAgent({ id: agentId });
      expect(agentAfterDelete).toBeNull();

      // Verify ACL entries are removed
      const aclEntriesAfter = await AclEntry.find({
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
      });
      expect(aclEntriesAfter).toHaveLength(0);
    });

    test('should remove a deleted agent from scalar and array edge endpoints', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const deletedAgentId = `agent_${uuidv4()}`;
      const graphAgentId = `agent_${uuidv4()}`;
      const sourceAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;

      await createAgent({
        id: deletedAgentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: graphAgentId,
        name: 'Agent With Connected Edges',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        edges: [
          {
            from: deletedAgentId,
            to: targetAgentId,
            edgeType: 'handoff',
          },
          {
            from: sourceAgentId,
            to: deletedAgentId,
            edgeType: 'handoff',
          },
          {
            from: [deletedAgentId, sourceAgentId],
            to: targetAgentId,
            edgeType: 'direct',
          },
          {
            from: sourceAgentId,
            to: [deletedAgentId, targetAgentId],
            edgeType: 'handoff',
          },
          {
            from: [deletedAgentId],
            to: targetAgentId,
            edgeType: 'handoff',
          },
          {
            from: sourceAgentId,
            to: [deletedAgentId],
            edgeType: 'handoff',
          },
          {
            from: [deletedAgentId, sourceAgentId],
            to: [deletedAgentId, targetAgentId],
            edgeType: 'direct',
          },
          {
            from: sourceAgentId,
            to: targetAgentId,
            edgeType: 'handoff',
            description: 'Unrelated edge',
          },
        ],
      });

      await deleteAgent({ id: deletedAgentId });

      const graphAgent = await getAgent({ id: graphAgentId });
      expect(graphAgent!.edges).toEqual([
        {
          from: [sourceAgentId],
          to: targetAgentId,
          edgeType: 'direct',
        },
        {
          from: sourceAgentId,
          to: [targetAgentId],
          edgeType: 'handoff',
        },
        {
          from: [sourceAgentId],
          to: [targetAgentId],
          edgeType: 'direct',
        },
        {
          from: sourceAgentId,
          to: targetAgentId,
          edgeType: 'handoff',
          description: 'Unrelated edge',
        },
      ]);
    });

    test('should remove every bulk-deleted agent while preserving surviving edge members', async () => {
      const deletingAuthorId = new mongoose.Types.ObjectId();
      const graphAuthorId = new mongoose.Types.ObjectId();
      const firstDeletedId = `agent_${uuidv4()}`;
      const secondDeletedId = `agent_${uuidv4()}`;
      const graphAgentId = `agent_${uuidv4()}`;
      const sourceAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;

      await createAgent({
        id: firstDeletedId,
        name: 'First Bulk-Deleted Agent',
        provider: 'test',
        model: 'test-model',
        author: deletingAuthorId,
      });
      await createAgent({
        id: secondDeletedId,
        name: 'Second Bulk-Deleted Agent',
        provider: 'test',
        model: 'test-model',
        author: deletingAuthorId,
      });
      await createAgent({
        id: graphAgentId,
        name: 'Bulk Edge Graph',
        provider: 'test',
        model: 'test-model',
        author: graphAuthorId,
        edges: [
          {
            from: [firstDeletedId, sourceAgentId],
            to: [secondDeletedId, targetAgentId],
            edgeType: 'direct',
          },
          {
            from: firstDeletedId,
            to: targetAgentId,
            edgeType: 'handoff',
          },
          {
            from: sourceAgentId,
            to: [firstDeletedId, secondDeletedId],
            edgeType: 'handoff',
          },
          {
            from: sourceAgentId,
            to: targetAgentId,
            edgeType: 'handoff',
            description: 'Unrelated bulk edge',
          },
        ],
      });

      await deleteUserAgents(deletingAuthorId.toString());

      expect(await getAgent({ id: firstDeletedId })).toBeNull();
      expect(await getAgent({ id: secondDeletedId })).toBeNull();
      const graphAgent = await getAgent({ id: graphAgentId });
      expect(graphAgent!.edges).toEqual([
        {
          from: [sourceAgentId],
          to: [targetAgentId],
          edgeType: 'direct',
        },
        {
          from: sourceAgentId,
          to: targetAgentId,
          edgeType: 'handoff',
          description: 'Unrelated bulk edge',
        },
      ]);
    });

    test('keeps an edge added to the graph while the cleanup was running', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const deletedAgentId = `agent_${uuidv4()}`;
      const graphAgentId = `agent_${uuidv4()}`;
      const sourceAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;
      const addedAgentId = `agent_${uuidv4()}`;
      await createAgent({
        id: deletedAgentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await createAgent({
        id: graphAgentId,
        name: 'Agent Edited During Cleanup',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        edges: [
          { from: deletedAgentId, to: targetAgentId, edgeType: 'handoff' },
          { from: sourceAgentId, to: targetAgentId, edgeType: 'handoff' },
        ],
      });
      /** Lands a concurrent edit between the cleanup's read and its first write,
       * through the driver so the cleanup's own compare-and-set is what must
       * notice it. */
      const prototype = mongoose.mongo.Collection.prototype;
      const bulkWrite = prototype.bulkWrite;
      let edited = false;
      prototype.bulkWrite = async function (this: mongoose.mongo.Collection, operations, options) {
        if (!edited && this.collectionName === 'agents') {
          edited = true;
          await Agent.updateOne(
            { id: graphAgentId },
            { $push: { edges: { from: sourceAgentId, to: addedAgentId, edgeType: 'handoff' } } },
          );
        }
        return bulkWrite.call(this, operations, options);
      };

      try {
        await deleteAgent({ id: deletedAgentId });
      } finally {
        prototype.bulkWrite = bulkWrite;
      }

      expect(edited).toBe(true);
      const graphAgent = await getAgent({ id: graphAgentId });
      expect(graphAgent!.edges).toEqual([
        { from: sourceAgentId, to: targetAgentId, edgeType: 'handoff' },
        { from: sourceAgentId, to: addedAgentId, edgeType: 'handoff' },
      ]);
    });

    test('cleans every graph when the references span more than one page', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const deletedAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;
      const graphCount = EDGE_CLEANUP_BATCH + 1;
      await createAgent({
        id: deletedAgentId,
        name: 'Popular Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await Agent.insertMany(
        Array.from({ length: graphCount }, (_, index) => ({
          id: `agent_${uuidv4()}`,
          name: `Paged Graph ${index}`,
          provider: 'test',
          model: 'test-model',
          author: authorId,
          edges: [
            { from: deletedAgentId, to: targetAgentId, edgeType: 'handoff' },
            { from: targetAgentId, to: [deletedAgentId, targetAgentId], edgeType: 'direct' },
          ],
        })),
      );

      await deleteAgent({ id: deletedAgentId });

      const graphs = await Agent.find({ name: /^Paged Graph / })
        .select('edges')
        .lean<Pick<IAgent, 'edges'>[]>();
      expect(graphs).toHaveLength(graphCount);
      const expectedEdges = [{ from: targetAgentId, to: [targetAgentId], edgeType: 'direct' }];
      graphs.forEach((graph) => expect(graph.edges).toEqual(expectedEdges));
    });

    test('retries a compare-and-set miss the cursor has already passed', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const deletedAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;
      const addedAgentId = `agent_${uuidv4()}`;
      const graphCount = EDGE_CLEANUP_BATCH + 1;
      await createAgent({
        id: deletedAgentId,
        name: 'Popular Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      const graphIds = Array.from({ length: graphCount }, () => `agent_${uuidv4()}`);
      await Agent.insertMany(
        graphIds.map((id, index) => ({
          id,
          name: `Cursor Graph ${index}`,
          provider: 'test',
          model: 'test-model',
          author: authorId,
          edges: [
            { from: deletedAgentId, to: [deletedAgentId, targetAgentId], edgeType: 'direct' },
          ],
        })),
      );
      const [editedGraphId] = graphIds;
      /** Lands a concurrent edit on a first-page graph between the cleanup's read
       * and its first write, so that graph's compare-and-set misses while the
       * cursor moves on past it. */
      const prototype = mongoose.mongo.Collection.prototype;
      const bulkWrite = prototype.bulkWrite;
      let edited = false;
      prototype.bulkWrite = async function (this: mongoose.mongo.Collection, operations, options) {
        if (!edited && this.collectionName === 'agents') {
          edited = true;
          await Agent.updateOne(
            { id: editedGraphId },
            { $push: { edges: { from: targetAgentId, to: addedAgentId, edgeType: 'handoff' } } },
          );
        }
        return bulkWrite.call(this, operations, options);
      };

      try {
        await deleteAgent({ id: deletedAgentId });
      } finally {
        prototype.bulkWrite = bulkWrite;
      }

      expect(edited).toBe(true);
      expect(
        await Agent.countDocuments({
          $or: [{ 'edges.from': deletedAgentId }, { 'edges.to': deletedAgentId }],
        }),
      ).toBe(0);
      const editedGraph = await getAgent({ id: editedGraphId });
      expect(editedGraph!.edges).toEqual([
        { from: targetAgentId, to: addedAgentId, edgeType: 'handoff' },
      ]);
    });

    test('gives up after a bounded number of sweeps when references keep being added', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const deletedAgentId = `agent_${uuidv4()}`;
      const graphAgentId = `agent_${uuidv4()}`;
      const targetAgentId = `agent_${uuidv4()}`;
      await createAgent({
        id: deletedAgentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await createAgent({
        id: graphAgentId,
        name: 'Graph That Keeps Referencing',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        edges: [{ from: deletedAgentId, to: targetAgentId, edgeType: 'handoff' }],
      });
      /** Re-adds a reference AFTER every successful write, so every sweep makes
       * progress and the stall bound never trips; only the sweep bound ends it. */
      const prototype = mongoose.mongo.Collection.prototype;
      const bulkWrite = prototype.bulkWrite;
      let writes = 0;
      prototype.bulkWrite = async function (this: mongoose.mongo.Collection, operations, options) {
        const result = await bulkWrite.call(this, operations, options);
        if (this.collectionName === 'agents') {
          writes += 1;
          await Agent.updateOne(
            { id: graphAgentId },
            { $push: { edges: { from: deletedAgentId, to: targetAgentId, edgeType: 'handoff' } } },
          );
        }
        return result;
      };

      try {
        await deleteAgent({ id: deletedAgentId });
      } finally {
        prototype.bulkWrite = bulkWrite;
      }

      expect(await getAgent({ id: deletedAgentId })).toBeNull();
      expect(writes).toBeLessThanOrEqual(EDGE_CLEANUP_MAX_SWEEPS);
    });

    test('should remove agent from user favorites when agent is deleted', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      // Create agent
      await createAgent({
        id: agentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Create user with the agent in favorites
      await User.create({
        _id: userId,
        name: 'Test User',
        email: `test-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agentId }, { model: 'gpt-4', endpoint: 'openAI' }],
      });

      // Verify user has agent in favorites
      const userBefore = await User.findById(userId);
      expect(userBefore!.favorites).toHaveLength(2);
      expect(
        userBefore!.favorites!.some((f: Record<string, unknown>) => f.agentId === agentId),
      ).toBe(true);

      // Delete the agent
      await deleteAgent({ id: agentId });

      // Verify agent is deleted
      const agentAfterDelete = await getAgent({ id: agentId });
      expect(agentAfterDelete).toBeNull();

      // Verify agent is removed from user favorites
      const userAfter = await User.findById(userId);
      expect(userAfter!.favorites).toHaveLength(1);
      expect(
        userAfter!.favorites!.some((f: Record<string, unknown>) => f.agentId === agentId),
      ).toBe(false);
      expect(userAfter!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4')).toBe(
        true,
      );
    });

    test('should remove agent from multiple users favorites when agent is deleted', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const user1Id = new mongoose.Types.ObjectId();
      const user2Id = new mongoose.Types.ObjectId();

      // Create agent
      await createAgent({
        id: agentId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Create two users with the agent in favorites
      await User.create({
        _id: user1Id,
        name: 'Test User 1',
        email: `test1-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agentId }],
      });

      await User.create({
        _id: user2Id,
        name: 'Test User 2',
        email: `test2-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agentId }, { agentId: `agent_${uuidv4()}` }],
      });

      // Delete the agent
      await deleteAgent({ id: agentId });

      // Verify agent is removed from both users' favorites
      const user1After = await User.findById(user1Id);
      const user2After = await User.findById(user2Id);

      expect(user1After!.favorites).toHaveLength(0);
      expect(user2After!.favorites).toHaveLength(1);
      expect(
        user2After!.favorites!.some((f: Record<string, unknown>) => f.agentId === agentId),
      ).toBe(false);
    });

    test('should preserve other agents in database when one agent is deleted', async () => {
      const agentToDeleteId = `agent_${uuidv4()}`;
      const agentToKeep1Id = `agent_${uuidv4()}`;
      const agentToKeep2Id = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create multiple agents
      await createAgent({
        id: agentToDeleteId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: agentToKeep1Id,
        name: 'Agent To Keep 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: agentToKeep2Id,
        name: 'Agent To Keep 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Verify all agents exist
      expect(await getAgent({ id: agentToDeleteId })).not.toBeNull();
      expect(await getAgent({ id: agentToKeep1Id })).not.toBeNull();
      expect(await getAgent({ id: agentToKeep2Id })).not.toBeNull();

      // Delete one agent
      await deleteAgent({ id: agentToDeleteId });

      // Verify only the deleted agent is removed, others remain intact
      expect(await getAgent({ id: agentToDeleteId })).toBeNull();
      const keptAgent1 = await getAgent({ id: agentToKeep1Id });
      const keptAgent2 = await getAgent({ id: agentToKeep2Id });
      expect(keptAgent1).not.toBeNull();
      expect(keptAgent1!.name).toBe('Agent To Keep 1');
      expect(keptAgent2).not.toBeNull();
      expect(keptAgent2!.name).toBe('Agent To Keep 2');
    });

    test('should preserve other agents in user favorites when one agent is deleted', async () => {
      const agentToDeleteId = `agent_${uuidv4()}`;
      const agentToKeep1Id = `agent_${uuidv4()}`;
      const agentToKeep2Id = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      // Create multiple agents
      await createAgent({
        id: agentToDeleteId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: agentToKeep1Id,
        name: 'Agent To Keep 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: agentToKeep2Id,
        name: 'Agent To Keep 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Create user with all three agents in favorites
      await User.create({
        _id: userId,
        name: 'Test User',
        email: `test-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [
          { agentId: agentToDeleteId },
          { agentId: agentToKeep1Id },
          { agentId: agentToKeep2Id },
        ],
      });

      // Verify user has all three agents in favorites
      const userBefore = await User.findById(userId);
      expect(userBefore!.favorites).toHaveLength(3);

      // Delete one agent
      await deleteAgent({ id: agentToDeleteId });

      // Verify only the deleted agent is removed from favorites
      const userAfter = await User.findById(userId);
      expect(userAfter!.favorites).toHaveLength(2);
      expect(
        userAfter!.favorites?.some((f: Record<string, unknown>) => f.agentId === agentToDeleteId),
      ).toBe(false);
      expect(
        userAfter!.favorites?.some((f: Record<string, unknown>) => f.agentId === agentToKeep1Id),
      ).toBe(true);
      expect(
        userAfter!.favorites?.some((f: Record<string, unknown>) => f.agentId === agentToKeep2Id),
      ).toBe(true);
    });

    test('should not affect users who do not have deleted agent in favorites', async () => {
      const agentToDeleteId = `agent_${uuidv4()}`;
      const otherAgentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const userWithDeletedAgentId = new mongoose.Types.ObjectId();
      const userWithoutDeletedAgentId = new mongoose.Types.ObjectId();

      // Create agents
      await createAgent({
        id: agentToDeleteId,
        name: 'Agent To Delete',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: otherAgentId,
        name: 'Other Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Create user with the agent to be deleted
      await User.create({
        _id: userWithDeletedAgentId,
        name: 'User With Deleted Agent',
        email: `user1-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agentToDeleteId }, { model: 'gpt-4', endpoint: 'openAI' }],
      });

      // Create user without the agent to be deleted
      await User.create({
        _id: userWithoutDeletedAgentId,
        name: 'User Without Deleted Agent',
        email: `user2-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: otherAgentId }, { model: 'claude-3', endpoint: 'anthropic' }],
      });

      // Delete the agent
      await deleteAgent({ id: agentToDeleteId });

      // Verify user with deleted agent has it removed
      const userWithDeleted = await User.findById(userWithDeletedAgentId);
      expect(userWithDeleted!.favorites).toHaveLength(1);
      expect(
        userWithDeleted!.favorites!.some(
          (f: Record<string, unknown>) => f.agentId === agentToDeleteId,
        ),
      ).toBe(false);
      expect(
        userWithDeleted!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4'),
      ).toBe(true);

      // Verify user without deleted agent is completely unaffected
      const userWithoutDeleted = await User.findById(userWithoutDeletedAgentId);
      expect(userWithoutDeleted!.favorites).toHaveLength(2);
      expect(
        userWithoutDeleted!.favorites!.some(
          (f: Record<string, unknown>) => f.agentId === otherAgentId,
        ),
      ).toBe(true);
      expect(
        userWithoutDeleted!.favorites!.some((f: Record<string, unknown>) => f.model === 'claude-3'),
      ).toBe(true);
    });

    test('should remove all user agents from favorites when deleteUserAgents is called', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const otherAuthorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      const agent1Id = `agent_${uuidv4()}`;
      const agent2Id = `agent_${uuidv4()}`;
      const otherAuthorAgentId = `agent_${uuidv4()}`;

      const agent1 = await createAgent({
        id: agent1Id,
        name: 'Author Agent 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const agent2 = await createAgent({
        id: agent2Id,
        name: 'Author Agent 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: otherAuthorAgentId,
        name: 'Other Author Agent',
        provider: 'test',
        model: 'test-model',
        author: otherAuthorId,
      });

      const ownerBits =
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent1._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent2._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });

      await User.create({
        _id: userId,
        name: 'Test User',
        email: `test-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [
          { agentId: agent1Id },
          { agentId: agent2Id },
          { agentId: otherAuthorAgentId },
          { model: 'gpt-4', endpoint: 'openAI' },
        ],
      });

      const userBefore = await User.findById(userId);
      expect(userBefore!.favorites).toHaveLength(4);

      await deleteUserAgents(authorId.toString());

      expect(await getAgent({ id: agent1Id })).toBeNull();
      expect(await getAgent({ id: agent2Id })).toBeNull();

      expect(await getAgent({ id: otherAuthorAgentId })).not.toBeNull();

      const userAfter = await User.findById(userId);
      expect(userAfter!.favorites).toHaveLength(2);
      expect(
        userAfter!.favorites!.some((f: Record<string, unknown>) => f.agentId === agent1Id),
      ).toBe(false);
      expect(
        userAfter!.favorites!.some((f: Record<string, unknown>) => f.agentId === agent2Id),
      ).toBe(false);
      expect(
        userAfter!.favorites!.some(
          (f: Record<string, unknown>) => f.agentId === otherAuthorAgentId,
        ),
      ).toBe(true);
      expect(userAfter!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4')).toBe(
        true,
      );
    });

    test('should handle deleteUserAgents when agents are in multiple users favorites', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const user1Id = new mongoose.Types.ObjectId();
      const user2Id = new mongoose.Types.ObjectId();
      const user3Id = new mongoose.Types.ObjectId();

      const agent1Id = `agent_${uuidv4()}`;
      const agent2Id = `agent_${uuidv4()}`;
      const unrelatedAgentId = `agent_${uuidv4()}`;

      const agent1 = await createAgent({
        id: agent1Id,
        name: 'Author Agent 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const agent2 = await createAgent({
        id: agent2Id,
        name: 'Author Agent 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const ownerBits =
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent1._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent2._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });

      await User.create({
        _id: user1Id,
        name: 'User 1',
        email: `user1-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agent1Id }, { agentId: agent2Id }],
      });

      await User.create({
        _id: user2Id,
        name: 'User 2',
        email: `user2-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agent1Id }, { model: 'claude-3', endpoint: 'anthropic' }],
      });

      await User.create({
        _id: user3Id,
        name: 'User 3',
        email: `user3-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: unrelatedAgentId }, { model: 'gpt-4', endpoint: 'openAI' }],
      });

      await deleteUserAgents(authorId.toString());

      const user1After = await User.findById(user1Id);
      expect(user1After!.favorites).toHaveLength(0);

      const user2After = await User.findById(user2Id);
      expect(user2After!.favorites).toHaveLength(1);
      expect(
        user2After!.favorites!.some((f: Record<string, unknown>) => f.agentId === agent1Id),
      ).toBe(false);
      expect(
        user2After!.favorites!.some((f: Record<string, unknown>) => f.model === 'claude-3'),
      ).toBe(true);

      const user3After = await User.findById(user3Id);
      expect(user3After!.favorites).toHaveLength(2);
      expect(
        user3After!.favorites!.some((f: Record<string, unknown>) => f.agentId === unrelatedAgentId),
      ).toBe(true);
      expect(user3After!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4')).toBe(
        true,
      );
    });

    test('should handle deleteUserAgents when user has no agents', async () => {
      const authorWithNoAgentsId = new mongoose.Types.ObjectId();
      const otherAuthorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      const existingAgentId = `agent_${uuidv4()}`;

      const existingAgent = await createAgent({
        id: existingAgentId,
        name: 'Existing Agent',
        provider: 'test',
        model: 'test-model',
        author: otherAuthorId,
      });

      const ownerBits =
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherAuthorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: existingAgent._id,
        permBits: ownerBits,
        grantedBy: otherAuthorId,
        grantedAt: new Date(),
      });

      await User.create({
        _id: userId,
        name: 'Test User',
        email: `test-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: existingAgentId }, { model: 'gpt-4', endpoint: 'openAI' }],
      });

      await deleteUserAgents(authorWithNoAgentsId.toString());

      expect(await getAgent({ id: existingAgentId })).not.toBeNull();

      const userAfter = await User.findById(userId);
      expect(userAfter!.favorites).toHaveLength(2);
      expect(
        userAfter!.favorites!.some((f: Record<string, unknown>) => f.agentId === existingAgentId),
      ).toBe(true);
      expect(userAfter!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4')).toBe(
        true,
      );
    });

    test('should handle deleteUserAgents when agents are not in any favorites', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      const agent1Id = `agent_${uuidv4()}`;
      const agent2Id = `agent_${uuidv4()}`;

      const agent1 = await createAgent({
        id: agent1Id,
        name: 'Agent 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const agent2 = await createAgent({
        id: agent2Id,
        name: 'Agent 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const ownerBits =
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent1._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: authorId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent2._id,
        permBits: ownerBits,
        grantedBy: authorId,
        grantedAt: new Date(),
      });

      await User.create({
        _id: userId,
        name: 'Test User',
        email: `test-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ model: 'gpt-4', endpoint: 'openAI' }],
      });

      expect(await getAgent({ id: agent1Id })).not.toBeNull();
      expect(await getAgent({ id: agent2Id })).not.toBeNull();

      await deleteUserAgents(authorId.toString());

      expect(await getAgent({ id: agent1Id })).toBeNull();
      expect(await getAgent({ id: agent2Id })).toBeNull();

      const userAfter = await User.findById(userId);
      expect(userAfter!.favorites).toHaveLength(1);
      expect(userAfter!.favorites!.some((f: Record<string, unknown>) => f.model === 'gpt-4')).toBe(
        true,
      );
    });

    test('should preserve multi-owned agents when deleteUserAgents is called', async () => {
      const deletingUserId = new mongoose.Types.ObjectId();
      const otherOwnerId = new mongoose.Types.ObjectId();

      const soleOwnedId = `agent_${uuidv4()}`;
      const multiOwnedId = `agent_${uuidv4()}`;

      const soleAgent = await createAgent({
        id: soleOwnedId,
        name: 'Sole Owned Agent',
        provider: 'test',
        model: 'test-model',
        author: deletingUserId,
      });

      const multiAgent = await createAgent({
        id: multiOwnedId,
        name: 'Multi Owned Agent',
        provider: 'test',
        model: 'test-model',
        author: deletingUserId,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: deletingUserId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: (soleAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
        permBits: PermissionBits.DELETE | PermissionBits.VIEW | PermissionBits.EDIT,
      });

      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: deletingUserId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: (multiAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
        permBits: PermissionBits.DELETE | PermissionBits.VIEW | PermissionBits.EDIT,
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: otherOwnerId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: (multiAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
        permBits: PermissionBits.DELETE | PermissionBits.VIEW | PermissionBits.EDIT,
      });

      await deleteUserAgents(deletingUserId.toString());

      expect(await getAgent({ id: soleOwnedId })).toBeNull();
      expect(await getAgent({ id: multiOwnedId })).not.toBeNull();

      const soleAcl = await AclEntry.find({
        resourceType: ResourceType.AGENT,
        resourceId: (soleAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
      });
      expect(soleAcl).toHaveLength(0);

      const multiAcl = await AclEntry.find({
        resourceType: ResourceType.AGENT,
        resourceId: (multiAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
        principalId: otherOwnerId,
      });
      expect(multiAcl).toHaveLength(1);
      expect(multiAcl[0].permBits & PermissionBits.DELETE).toBeTruthy();

      const deletingUserMultiAcl = await AclEntry.find({
        resourceType: ResourceType.AGENT,
        resourceId: (multiAgent as unknown as { _id: mongoose.Types.ObjectId })._id,
        principalId: deletingUserId,
      });
      expect(deletingUserMultiAcl).toHaveLength(1);
    });

    test('should delete legacy agents that have author but no ACL entries', async () => {
      const legacyUserId = new mongoose.Types.ObjectId();
      const legacyAgentId = `agent_${uuidv4()}`;

      await createAgent({
        id: legacyAgentId,
        name: 'Legacy Agent (no ACL)',
        provider: 'test',
        model: 'test-model',
        author: legacyUserId,
      });

      await deleteUserAgents(legacyUserId.toString());

      expect(await getAgent({ id: legacyAgentId })).toBeNull();
    });

    describe('Edge Cases', () => {
      test.each([
        {
          name: 'getAgent with undefined search parameters',
          fn: () => getAgent(undefined as unknown as Parameters<typeof getAgent>[0]),
          expected: null,
        },
        {
          name: 'deleteAgent with non-existent agent',
          fn: () => deleteAgent({ id: 'non-existent' }),
          expected: null,
        },
      ])('$name should return null', async ({ fn, expected }) => {
        const result = await fn();
        expect(result).toBe(expected);
      });
    });
  });

  describe('Agent Version History', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
    });

    test('should create an agent with a single entry in versions array', async () => {
      const agent = await createBasicAgent();

      expect(agent!.versions).toBeDefined();
      expect(Array.isArray(agent.versions)).toBe(true);
      expect(agent!.versions).toHaveLength(1);
      expect(agent!.versions![0].name).toBe('Test Agent');
      expect(agent!.versions![0].provider).toBe('test');
      expect(agent!.versions![0].model).toBe('test-model');
    });

    test('getAgentVersions returns only the versions array', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        name: 'First Name',
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
      });
      await updateAgent({ id: agentId }, { name: 'Second Name' });

      const versions = await getAgentVersions({ id: agentId });

      expect(Array.isArray(versions)).toBe(true);
      expect(versions).toHaveLength(2);
      expect(versions![0].name).toBe('First Name');
      expect(versions![1].name).toBe('Second Name');
    });

    test('getAgentVersions returns null for a non-existent agent', async () => {
      const versions = await getAgentVersions({ id: `agent_${uuidv4()}` });
      expect(versions).toBeNull();
    });

    test('getAgentWithVersionCount returns the count without the versions array', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        name: 'First Name',
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
      });
      await updateAgent({ id: agentId }, { name: 'Second Name' });
      await updateAgent({ id: agentId }, { name: 'Third Name' });

      const agent = await getAgentWithVersionCount({ id: agentId });

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('Third Name');
      expect(agent!.version).toBe(3);
      expect(agent!.versions).toBeUndefined();
    });

    test('getAgentWithVersionCount returns null for a non-existent agent', async () => {
      const agent = await getAgentWithVersionCount({ id: `agent_${uuidv4()}` });
      expect(agent).toBeNull();
    });

    test('should accumulate version history across multiple updates', async () => {
      const agentId = `agent_${uuidv4()}`;
      const author = new mongoose.Types.ObjectId();
      await createAgent({
        id: agentId,
        name: 'First Name',
        provider: 'test',
        model: 'test-model',
        author,
        description: 'First description',
      });

      await updateAgent(
        { id: agentId },
        { name: 'Second Name', description: 'Second description' },
      );
      await updateAgent({ id: agentId }, { name: 'Third Name', model: 'new-model' });
      const finalAgent = await updateAgent({ id: agentId }, { description: 'Final description' });

      expect(finalAgent!.versions).toBeDefined();
      expect(Array.isArray(finalAgent!.versions)).toBe(true);
      expect(finalAgent!.versions).toHaveLength(4);

      expect(finalAgent!.versions![0].name).toBe('First Name');
      expect(finalAgent!.versions![0].description).toBe('First description');
      expect(finalAgent!.versions![0].model).toBe('test-model');

      expect(finalAgent!.versions![1].name).toBe('Second Name');
      expect(finalAgent!.versions![1].description).toBe('Second description');
      expect(finalAgent!.versions![1].model).toBe('test-model');

      expect(finalAgent!.versions![2].name).toBe('Third Name');
      expect(finalAgent!.versions![2].description).toBe('Second description');
      expect(finalAgent!.versions![2].model).toBe('new-model');

      expect(finalAgent!.versions![3].name).toBe('Third Name');
      expect(finalAgent!.versions![3].description).toBe('Final description');
      expect(finalAgent!.versions![3].model).toBe('new-model');

      expect(finalAgent!.name).toBe('Third Name');
      expect(finalAgent!.description).toBe('Final description');
      expect(finalAgent!.model).toBe('new-model');
    });

    test('should not include metadata fields in version history', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
      });

      const updatedAgent = await updateAgent({ id: agentId }, { description: 'New description' });

      expect(updatedAgent!.versions).toHaveLength(2);
      expect(updatedAgent!.versions![0]._id).toBeUndefined();
      expect((updatedAgent!.versions![0] as VersionEntry).__v).toBeUndefined();
      expect(updatedAgent!.versions![0].name).toBe('Test Agent');
      expect(updatedAgent!.versions![0].author).toBeUndefined();

      expect(updatedAgent!.versions![1]._id).toBeUndefined();
      expect((updatedAgent!.versions![1] as VersionEntry).__v).toBeUndefined();
    });

    test('should not recursively include previous versions', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
      });

      await updateAgent({ id: agentId }, { name: 'Updated Name 1' });
      await updateAgent({ id: agentId }, { name: 'Updated Name 2' });
      const finalAgent = await updateAgent({ id: agentId }, { name: 'Updated Name 3' });

      expect(finalAgent!.versions).toHaveLength(4);

      finalAgent!.versions!.forEach((version) => {
        expect((version as VersionEntry).versions).toBeUndefined();
      });
    });

    test('should handle MongoDB operators and field updates correctly', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'MongoDB Operator Test',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: ['tool1'],
      });

      await updateAgent(
        { id: agentId },
        {
          description: 'Updated description',
          $push: { tools: 'tool2' },
        },
      );

      const firstUpdate = await getAgent({ id: agentId }, {});
      expect(firstUpdate!.description).toBe('Updated description');
      expect(firstUpdate!.tools).toContain('tool1');
      expect(firstUpdate!.tools).toContain('tool2');
      expect(firstUpdate!.versions).toHaveLength(2);

      await updateAgent(
        { id: agentId },
        {
          tools: ['tool2', 'tool3'],
        },
      );

      const secondUpdate = await getAgent({ id: agentId }, {});
      expect(secondUpdate!.tools).toHaveLength(2);
      expect(secondUpdate!.tools).toContain('tool2');
      expect(secondUpdate!.tools).toContain('tool3');
      expect(secondUpdate!.tools).not.toContain('tool1');
      expect(secondUpdate!.versions).toHaveLength(3);

      await updateAgent(
        { id: agentId },
        {
          $push: { tools: 'tool3' },
        },
      );

      const thirdUpdate = await getAgent({ id: agentId }, {});
      const toolCount = thirdUpdate!.tools!.filter((t) => t === 'tool3').length;
      expect(toolCount).toBe(2);
      expect(thirdUpdate!.versions).toHaveLength(4);
    });

    test('should unset a field and omit it from the recorded version', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        code_environment_id: 'attached-vm',
      });

      const updated = await updateAgent({ id: agentId }, { $unset: { code_environment_id: 1 } });

      expect(updated!.code_environment_id).toBeUndefined();
      expect(updated!.versions).toHaveLength(2);
      expect(updated!.versions![1].code_environment_id).toBeUndefined();
    });

    test('persists and restores the workspace default without retaining a later preference', async () => {
      const agentId = `agent_${uuidv4()}`;
      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
      });
      await updateAgent({ id: agentId }, { code_workspace_id: 'project-a' });
      expect((await getAgent({ id: agentId }))?.code_workspace_id).toBe('project-a');
      await updateAgent({ id: agentId }, { code_workspace_id: '' });
      expect((await getAgent({ id: agentId }))?.code_workspace_id).toBe('');
      expect((await revertAgentVersion({ id: agentId }, 1))?.code_workspace_id).toBe('project-a');
      expect((await revertAgentVersion({ id: agentId }, 0))?.code_workspace_id).toBeUndefined();
    });

    test('should handle parameter objects correctly', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Parameters Test',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        model_parameters: { temperature: 0.7 },
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { model_parameters: { temperature: 0.8 } },
      );

      expect(updatedAgent!.versions).toHaveLength(2);
      expect(updatedAgent!.model_parameters?.temperature).toBe(0.8);

      await updateAgent(
        { id: agentId },
        {
          model_parameters: {
            temperature: 0.8,
            max_tokens: 1000,
          },
        },
      );

      const complexAgent = await getAgent({ id: agentId }, {});
      expect(complexAgent!.versions).toHaveLength(3);
      expect(complexAgent!.model_parameters?.temperature).toBe(0.8);
      expect(complexAgent!.model_parameters?.max_tokens).toBe(1000);

      await updateAgent({ id: agentId }, { model_parameters: {} });

      const emptyParamsAgent = await getAgent({ id: agentId }, {});
      expect(emptyParamsAgent!.versions).toHaveLength(4);
      expect(emptyParamsAgent!.model_parameters).toEqual({});
    });

    test('should not create new version for duplicate updates', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const testCases = generateVersionTestCases();

      for (const testCase of testCases) {
        const testAgentId = `agent_${uuidv4()}`;

        await createAgent({
          id: testAgentId,
          provider: 'test',
          model: 'test-model',
          author: authorId,
          ...testCase.initial,
        });

        const updatedAgent = await updateAgent({ id: testAgentId }, testCase.update);
        expect(updatedAgent!.versions).toHaveLength(2); // No new version created

        // Update with duplicate data should succeed but not create a new version
        const duplicateUpdate = await updateAgent({ id: testAgentId }, testCase.duplicate);

        expect(duplicateUpdate!.versions).toHaveLength(2); // No new version created

        const agent = await getAgent({ id: testAgentId }, {});
        expect(agent!.versions).toHaveLength(2);
      }
    });

    test('should persist an update matching the newest version when the document has diverged from it', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: [],
      });

      /** Atomic-operator updates snapshot the pre-update state as the new version, so the
       *  document and `versions[versions.length - 1]` legitimately diverge. This is the
       *  same shape `addAgentResourceFile` produces when it attaches a file. */
      await updateAgent({ id: agentId }, { $addToSet: { tools: 'file_search' } });

      const afterAdd = await getAgent({ id: agentId }, {});
      expect(afterAdd!.tools).toEqual(['file_search']);
      expect(afterAdd!.versions).toHaveLength(2);
      expect((afterAdd!.versions![1] as VersionEntry).tools).toEqual([]);

      /** Removing the tool lands the document back on the newest version's content. That
       *  adds no history, but the removal itself must still be written. */
      const removed = await updateAgent({ id: agentId }, { tools: [] });

      expect(removed!.tools).toEqual([]);
      expect(removed!.versions).toHaveLength(2);

      const reloaded = await getAgent({ id: agentId }, {});
      expect(reloaded!.tools).toEqual([]);
      expect(reloaded!.versions).toHaveLength(2);
    });

    test('should persist a resource file attached to an agent carrying actions', async () => {
      const agentId = `agent_${uuidv4()}`;
      const fileIdsOf = (agent: IAgent | null) =>
        (agent?.tool_resources as Record<string, { file_ids?: string[] }> | undefined)?.file_search
          ?.file_ids;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        actions: [`example.com${actionDelimiter}act_1`],
        tools: [],
      });

      /** `isDuplicateVersion` only skips operator-only updates while `actionsHash` is
       *  falsy, so an agent with actions reaches the comparison on every file attach. */
      await updateAgent({ id: agentId }, { name: 'With actions' });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });

      /** The re-attach snapshots the current state, so the document now equals the newest
       *  version and the next attach is judged a duplicate. */
      const settled = await getAgent({ id: agentId }, {});
      const newestVersion = settled!.versions![settled!.versions!.length - 1] as VersionEntry;
      expect(fileIdsOf(settled)).toEqual(['f1']);
      expect(newestVersion.tool_resources).toEqual(settled!.tool_resources);

      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f2',
      });

      expect(fileIdsOf(await getAgent({ id: agentId }))).toEqual(['f1', 'f2']);
    });

    test('should not record a version when an atomic operator changes nothing', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        actions: [`example.com${actionDelimiter}act_1`],
        tools: [],
      });

      await updateAgent({ id: agentId }, { name: 'With actions' });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });

      /** The document now equals its newest version, so the snapshot is a duplicate and
       *  only the operator can justify recording an entry. */
      const settled = await getAgent({ id: agentId }, {});
      const versionCount = settled!.versions!.length;

      /** Re-attaching an id the agent already holds makes `$addToSet` a Mongo no-op. An
       *  entry here would record a change the document never took. */
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });

      const after = await getAgent({ id: agentId }, {});
      expect(after!.versions).toHaveLength(versionCount);
      expect(
        (after?.tool_resources as Record<string, { file_ids?: string[] }> | undefined)?.file_search
          ?.file_ids,
      ).toEqual(['f1']);
    });

    test('should send no mutating operator once it has suppressed the version entry', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        actions: [`example.com${actionDelimiter}act_1`],
        tools: [],
      });

      await updateAgent({ id: agentId }, { name: 'With actions' });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });
      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });

      const settled = await getAgent({ id: agentId }, {});
      const versionCount = settled!.versions!.length;

      /** The no-op reading comes from a document fetched before the write, so a `$pull`
       *  landing in between would leave a surviving `$addToSet` re-adding the value with
       *  no version entry recording it. Suppressing means the operator is gone, not that
       *  it is expected to stay harmless. */
      const Agent = mongoose.models.Agent as Model<IAgent>;
      const spy = jest.spyOn(Agent, 'findOneAndUpdate');

      await addAgentResourceFile({
        agent_id: agentId,
        tool_resource: 'file_search',
        file_id: 'f1',
      });

      const suppressedUpdate = spy.mock.calls[spy.mock.calls.length - 1][1] as UpdateQuery<IAgent>;
      spy.mockRestore();

      expect(suppressedUpdate.$addToSet).toBeUndefined();
      expect(suppressedUpdate.$push).toBeUndefined();
      expect(suppressedUpdate.$pull).toBeUndefined();
      expect((await getAgent({ id: agentId }, {}))!.versions).toHaveLength(versionCount);
    });

    test('should record a version when a duplicate direct update carries an atomic operator', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        name: 'Operator agent',
        tools: [],
      });
      await updateAgent({ id: agentId }, { name: 'Renamed' });

      /** The direct half matches the newest version while the operator half really changes
       *  the document. Suppressing here would apply a change no version entry records, and
       *  the document would diverge from every entry in its own history. */
      const updated = await updateAgent(
        { id: agentId },
        { name: 'Renamed', $push: { tools: 'appended_tool' } },
      );

      expect(updated!.tools).toEqual(['appended_tool']);
      expect(updated!.versions).toHaveLength(3);

      const reloaded = await getAgent({ id: agentId }, {});
      expect(reloaded!.tools).toEqual(['appended_tool']);
      expect(reloaded!.versions).toHaveLength(3);
    });

    test('should persist an update that repairs drift left by a skipVersioning write', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        description: 'original',
      });
      await updateAgent({ id: agentId }, { name: 'Versioned' });

      /** `skipVersioning` writes snapshot nothing, so the document drifts from the newest
       *  version without any entry recording it. */
      await updateAgent({ id: agentId }, { description: 'drifted' }, { skipVersioning: true });
      expect((await getAgent({ id: agentId }))!.description).toBe('drifted');

      const repaired = await updateAgent({ id: agentId }, { description: 'original' });

      expect(repaired!.description).toBe('original');
      expect(repaired!.versions).toHaveLength(2);
      expect((await getAgent({ id: agentId }))!.description).toBe('original');
    });

    test('should clear an avatar the newest version never recorded without adding a version', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        name: 'Avatar agent',
      });
      await updateAgent({ id: agentId }, { name: 'Avatar agent' });

      /** Avatar writes go through `skipVersioning`, so the newest version can carry no
       *  avatar at all while the document has one. */
      await updateAgent(
        { id: agentId },
        { avatar: { filepath: '/images/a.png', source: 'local' } },
        { skipVersioning: true },
      );
      const withAvatar = await getAgent({ id: agentId }, {});
      expect(withAvatar!.avatar).toBeTruthy();
      expect((withAvatar!.versions![1] as VersionEntry).avatar).toBeUndefined();

      /** `isDuplicateVersion` skips a field when both sides are falsy, so clearing the
       *  avatar reads as a duplicate: the write lands and the count stays put. */
      const cleared = await updateAgent({ id: agentId }, { avatar: null });

      expect(cleared!.avatar).toBeNull();
      expect(cleared!.versions).toHaveLength(2);
      expect((await getAgent({ id: agentId }))!.avatar).toBeNull();
    });

    test('should leave the document untouched when a duplicate update changes nothing', async () => {
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: new mongoose.Types.ObjectId(),
        name: 'Idempotent',
        tools: ['a', 'b'],
      });
      await updateAgent({ id: agentId }, { name: 'Idempotent' });

      const before = await getAgent({ id: agentId }, {});
      const duplicate = await updateAgent({ id: agentId }, { name: 'Idempotent' });

      /** The suppressed path reports the unchanged version count as `version`. */
      expect((duplicate as IAgent & { version?: number }).version).toBe(before!.versions!.length);

      const after = await getAgent({ id: agentId }, {});
      expect(after!.name).toBe(before!.name);
      expect(after!.tools).toEqual(before!.tools);
      expect(after!.versions).toHaveLength(before!.versions!.length);
    });

    test('should track updatedBy when a different user updates an agent', async () => {
      const agentId = `agent_${uuidv4()}`;
      const originalAuthor = new mongoose.Types.ObjectId();
      const updatingUser = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Original Agent',
        provider: 'test',
        model: 'test-model',
        author: originalAuthor,
        description: 'Original description',
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { name: 'Updated Agent', description: 'Updated description' },
        { updatingUserId: updatingUser.toString() },
      );

      expect(updatedAgent!.versions).toHaveLength(2);
      expect((updatedAgent!.versions![1] as VersionEntry)?.updatedBy?.toString()).toBe(
        updatingUser.toString(),
      );
      expect(updatedAgent!.author.toString()).toBe(originalAuthor.toString());
    });

    test('should include updatedBy even when the original author updates the agent', async () => {
      const agentId = `agent_${uuidv4()}`;
      const originalAuthor = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Original Agent',
        provider: 'test',
        model: 'test-model',
        author: originalAuthor,
        description: 'Original description',
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { name: 'Updated Agent', description: 'Updated description' },
        { updatingUserId: originalAuthor.toString() },
      );

      expect(updatedAgent!.versions).toHaveLength(2);
      expect((updatedAgent!.versions![1] as VersionEntry)?.updatedBy?.toString()).toBe(
        originalAuthor.toString(),
      );
      expect(updatedAgent!.author.toString()).toBe(originalAuthor.toString());
    });

    test('should track multiple different users updating the same agent', async () => {
      const agentId = `agent_${uuidv4()}`;
      const originalAuthor = new mongoose.Types.ObjectId();
      const user1 = new mongoose.Types.ObjectId();
      const user2 = new mongoose.Types.ObjectId();
      const user3 = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Original Agent',
        provider: 'test',
        model: 'test-model',
        author: originalAuthor,
        description: 'Original description',
      });

      // User 1 makes an update
      await updateAgent(
        { id: agentId },
        { name: 'Updated by User 1', description: 'First update' },
        { updatingUserId: user1.toString() },
      );

      // Original author makes an update
      await updateAgent(
        { id: agentId },
        { description: 'Updated by original author' },
        { updatingUserId: originalAuthor.toString() },
      );

      // User 2 makes an update
      await updateAgent(
        { id: agentId },
        { name: 'Updated by User 2', model: 'new-model' },
        { updatingUserId: user2.toString() },
      );

      // User 3 makes an update
      const finalAgent = await updateAgent(
        { id: agentId },
        { description: 'Final update by User 3' },
        { updatingUserId: user3.toString() },
      );

      expect(finalAgent!.versions).toHaveLength(5);
      expect(finalAgent!.author.toString()).toBe(originalAuthor.toString());

      // Check that each version has the correct updatedBy
      const versions = finalAgent!.versions! as VersionEntry[];
      expect(versions[0]?.updatedBy).toBeUndefined(); // Initial creation has no updatedBy
      expect(versions[1]?.updatedBy?.toString()).toBe(user1.toString());
      expect(versions[2]?.updatedBy?.toString()).toBe(originalAuthor.toString());
      expect(versions[3]?.updatedBy?.toString()).toBe(user2.toString());
      expect(versions[4]?.updatedBy?.toString()).toBe(user3.toString());

      // Verify the final state
      expect(finalAgent!.name).toBe('Updated by User 2');
      expect(finalAgent!.description).toBe('Final update by User 3');
      expect(finalAgent!.model).toBe('new-model');
    });

    test('should preserve original author during agent restoration', async () => {
      const agentId = `agent_${uuidv4()}`;
      const originalAuthor = new mongoose.Types.ObjectId();
      const updatingUser = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Original Agent',
        provider: 'test',
        model: 'test-model',
        author: originalAuthor,
        description: 'Original description',
      });

      await updateAgent(
        { id: agentId },
        { name: 'Updated Agent', description: 'Updated description' },
        { updatingUserId: updatingUser.toString() },
      );

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.author.toString()).toBe(originalAuthor.toString());
      expect(revertedAgent.name).toBe('Original Agent');
      expect(revertedAgent.description).toBe('Original description');
    });

    test('should clear an explicit code environment when the restored version used the default', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Default Environment Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await updateAgent({ id: agentId }, { code_environment_id: 'replacement-environment' });

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.code_environment_id).toBeUndefined();
    });

    test('should clear a Git identity absent from the restored version', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Legacy Git Identity Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });
      await updateAgent(
        { id: agentId },
        { git_identity: { name: 'Coding Agent', email: 'agent@example.com' } },
      );

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.git_identity).toBeUndefined();
    });

    test('should clear skill fields absent from a restored legacy version', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Legacy Skill Scope Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [],
        skills_enabled: true,
      });
      await updateAgent(
        { id: agentId },
        {
          skills_enabled: false,
          skill_authoring_enabled: true,
          skills_scope: SkillsScope.none,
        },
      );

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.skills_enabled).toBe(true);
      expect(revertedAgent.skills).toEqual([]);
      expect(revertedAgent.skills_scope).toBeUndefined();
      expect(revertedAgent.skill_authoring_enabled).toBeUndefined();
    });

    test('renews a code environment reference until the guarded write settles', async () => {
      const environmentId = `environment_${uuidv4()}`;
      await mongoose.models.CodeEnvironment.create({
        environmentId,
        name: 'Slow writer environment',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: new mongoose.Types.ObjectId(),
      });
      let settleWrite: (() => void) | undefined;
      const guardedWrite = withCodeEnvironmentReference(
        mongoose,
        environmentId,
        async () =>
          await new Promise<void>((resolve) => {
            settleWrite = resolve;
          }),
        10,
      );
      let initial: CodeEnvironmentDocument | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        initial = await mongoose.models.CodeEnvironment.findOne({
          environmentId,
        }).lean<CodeEnvironmentDocument>();
        if (initial?.pendingAgentReferences?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const initialExpiry = initial?.pendingAgentReferences?.[0]?.expiresAt;

      await new Promise((resolve) => setTimeout(resolve, 30));

      const renewed = await mongoose.models.CodeEnvironment.findOne({
        environmentId,
      }).lean<CodeEnvironmentDocument>();
      expect(initialExpiry).toBeInstanceOf(Date);
      expect(renewed?.pendingAgentReferences?.[0]?.expiresAt.getTime()).toBeGreaterThan(
        initialExpiry?.getTime() ?? 0,
      );
      settleWrite?.();
      await guardedWrite;
      await expect(
        mongoose.models.CodeEnvironment.findOne({ environmentId }).lean(),
      ).resolves.toMatchObject({ pendingAgentReferences: [] });
    });

    test('rejects a guarded write when its code environment reference lease is lost', async () => {
      const environmentId = `environment_${uuidv4()}`;
      await mongoose.models.CodeEnvironment.create({
        environmentId,
        name: 'Lost lease environment',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: new mongoose.Types.ObjectId(),
      });
      let settleWrite: (() => void) | undefined;
      const compensate = jest.fn().mockResolvedValue(undefined);
      const guardedWrite = withCodeEnvironmentReference(
        mongoose,
        environmentId,
        async () =>
          await new Promise<void>((resolve) => {
            settleWrite = resolve;
          }),
        10,
        compensate,
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        const environment = await mongoose.models.CodeEnvironment.findOne({
          environmentId,
          pendingAgentReferences: { $exists: true },
        });
        if (environment != null) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await mongoose.models.CodeEnvironment.updateOne(
        { environmentId },
        { $set: { deletionStartedAt: new Date() } },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      settleWrite?.();

      await expect(guardedWrite).rejects.toMatchObject({
        name: 'CodeEnvironmentReferenceError',
      });
      expect(compensate).toHaveBeenCalledWith(undefined);
    });

    test('does not overwrite an intervening Agent update when acquiring an environment reference', async () => {
      const agentId = `agent_${uuidv4()}`;
      const environmentId = `environment_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      await createAgent({
        id: agentId,
        name: 'Original agent name',
        author: authorId,
        model: 'test-model',
        provider: 'test-provider',
      });
      await mongoose.models.CodeEnvironment.create({
        environmentId,
        name: 'Concurrent update environment',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: authorId,
      });
      const CodeEnvironment = mongoose.models.CodeEnvironment;
      const reserve = CodeEnvironment.findOneAndUpdate.bind(CodeEnvironment);
      let enteredReserve!: () => void;
      let releaseReserve!: () => void;
      const entered = new Promise<void>((resolve) => (enteredReserve = resolve));
      const release = new Promise<void>((resolve) => (releaseReserve = resolve));
      const reserveSpy = jest.spyOn(CodeEnvironment, 'findOneAndUpdate').mockImplementationOnce(
        (...args: Parameters<typeof CodeEnvironment.findOneAndUpdate>) =>
          ({
            lean: async () => {
              enteredReserve();
              await release;
              return await reserve(...args).lean();
            },
          }) as ReturnType<typeof CodeEnvironment.findOneAndUpdate>,
      );
      const guardedUpdate = updateAgent(
        { id: agentId },
        { name: 'Guarded update name', code_environment_id: environmentId },
      );
      await entered;
      await Agent.updateOne(
        { id: agentId },
        { $set: { description: 'Intervening update survived' } },
      );
      releaseReserve();

      await expect(guardedUpdate).resolves.toBeNull();
      await expect(Agent.findOne({ id: agentId }).lean()).resolves.toMatchObject({
        name: 'Original agent name',
        description: 'Intervening update survived',
      });
      await expect(Agent.findOne({ id: agentId }).lean()).resolves.not.toHaveProperty(
        'code_environment_id',
      );
      reserveSpy.mockRestore();
    });
    test('should preserve skills enabled when pruning deleted ids on an all-scoped revert', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const Skill = mongoose.models.Skill;
      const skill = await Skill.create({
        name: 'revert-all-scope-prune-skill',
        description: 'Skill backing the all-scoped revert pruning test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const skillId = skill._id.toString();

      await createAgent({
        id: agentId,
        name: 'All Scope Revert Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [skillId],
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      });

      await updateAgent({ id: agentId }, { skills: [], name: 'No Skills Anymore' });
      await Skill.deleteOne({ _id: skill._id });

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);
      const reloadedAgent = await getAgent({ id: agentId });

      expect(revertedAgent.skills).toEqual([]);
      expect(revertedAgent.skills_enabled).toBe(true);
      expect(revertedAgent.skills_scope).toBe(SkillsScope.all);
      expect(reloadedAgent!.skills).toEqual([]);
      expect(reloadedAgent!.skills_enabled).toBe(true);
      expect(reloadedAgent!.skills_scope).toBe(SkillsScope.all);
    });

    test('should fail closed when pruning deleted ids on a legacy revert', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const Skill = mongoose.models.Skill;
      const skill = await Skill.create({
        name: 'revert-legacy-prune-skill',
        description: 'Skill backing the legacy revert pruning test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const skillId = skill._id.toString();

      await createAgent({
        id: agentId,
        name: 'Legacy Revert Skill Heal Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [skillId],
        skills_enabled: true,
      });

      await updateAgent({ id: agentId }, { skills: [], name: 'No Skills Anymore' });
      await Skill.deleteOne({ _id: skill._id });

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);
      const reloadedAgent = await getAgent({ id: agentId });

      expect(revertedAgent.skills).toEqual([]);
      expect(revertedAgent.skills_enabled).toBe(false);
      expect(revertedAgent.skills_scope).toBeUndefined();
      expect(reloadedAgent!.skills).toEqual([]);
      expect(reloadedAgent!.skills_enabled).toBe(false);
      expect(reloadedAgent!.skills_scope).toBeUndefined();
    });

    test('should prune deleted skill ids when reverting to an older version', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const Skill = mongoose.models.Skill;
      const skill = await Skill.create({
        name: 'revert-prune-skill',
        description: 'Skill backing the revert pruning test.',
        author: authorId,
        authorName: 'Test Author',
      });
      const skillId = skill._id.toString();

      await createAgent({
        id: agentId,
        name: 'Revert Skill Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [skillId],
        skills_enabled: true,
      });

      await updateAgent({ id: agentId }, { skills: [], name: 'No Skills Anymore' });
      await Skill.deleteOne({ _id: skill._id });

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.name).toBe('Revert Skill Agent');
      expect(revertedAgent.skills).toEqual([]);
      expect(revertedAgent.skills_enabled).toBe(false);
    });

    test('should preserve external skill ids when reverting to an older version', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const externalSkillId = new mongoose.Types.ObjectId().toString();
      externalSkillIds.add(externalSkillId);

      await createAgent({
        id: agentId,
        name: 'Revert External Skill Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        skills: [externalSkillId],
        skills_enabled: true,
      });

      await updateAgent({ id: agentId }, { skills: [], name: 'No Skills Anymore' });
      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.name).toBe('Revert External Skill Agent');
      expect(revertedAgent.skills).toEqual([externalSkillId]);
      expect(revertedAgent.skills_enabled).toBe(true);
    });

    test('should detect action metadata changes and force version update', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();
      const actionId = 'testActionId123';

      // Create agent with actions
      await createAgent({
        id: agentId,
        name: 'Agent with Actions',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        actions: [`test.com_action_${actionId}`],
        tools: ['listEvents_action_test.com', 'createEvent_action_test.com'],
      });

      // First update with forceVersion should create a version
      const firstUpdate = await updateAgent(
        { id: agentId },
        { tools: ['listEvents_action_test.com', 'createEvent_action_test.com'] },
        { updatingUserId: authorId.toString(), forceVersion: true },
      );

      expect(firstUpdate!.versions).toHaveLength(2);

      // Second update with same data but forceVersion should still create a version
      const secondUpdate = await updateAgent(
        { id: agentId },
        { tools: ['listEvents_action_test.com', 'createEvent_action_test.com'] },
        { updatingUserId: authorId.toString(), forceVersion: true },
      );

      expect(secondUpdate!.versions).toHaveLength(3);

      // Update without forceVersion and no changes should not create a version
      const duplicateUpdate = await updateAgent(
        { id: agentId },
        { tools: ['listEvents_action_test.com', 'createEvent_action_test.com'] },
        { updatingUserId: authorId.toString(), forceVersion: false },
      );

      expect(duplicateUpdate!.versions).toHaveLength(3); // No new version created
    });

    test('should handle isDuplicateVersion with arrays containing null/undefined values', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: ['tool1', null, 'tool2', undefined],
      });

      // Update with same array but different null/undefined arrangement
      const updatedAgent = await updateAgent({ id: agentId }, { tools: ['tool1', 'tool2'] });

      expect(updatedAgent!.versions).toHaveLength(2);
      expect(updatedAgent!.tools).toEqual(['tool1', 'tool2']);
    });

    test('should handle isDuplicateVersion with empty objects in tool_kwargs', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tool_kwargs: [
          { tool: 'tool1', config: { setting: 'value' } },
          {},
          { tool: 'tool2', config: {} },
        ],
      });

      // Try to update with reordered but equivalent tool_kwargs
      const updatedAgent = await updateAgent(
        { id: agentId },
        {
          tool_kwargs: [
            { tool: 'tool2', config: {} },
            { tool: 'tool1', config: { setting: 'value' } },
            {},
          ],
        },
      );

      // Should create new version as order matters for arrays
      expect(updatedAgent!.versions).toHaveLength(2);
    });

    test('should handle isDuplicateVersion with mixed primitive and object arrays', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        mixed_array: [1, 'string', { key: 'value' }, true, null],
      });

      // Update with same values but different types
      const updatedAgent = await updateAgent(
        { id: agentId },
        { mixed_array: ['1', 'string', { key: 'value' }, 'true', null] },
      );

      // Should create new version as types differ
      expect(updatedAgent!.versions).toHaveLength(2);
    });

    test('should handle isDuplicateVersion with deeply nested objects', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      const deepObject = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
                array: [1, 2, { nested: true }],
              },
            },
          },
        },
      };

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        model_parameters: deepObject,
      });

      // First create a version with changes
      await updateAgent({ id: agentId }, { description: 'Updated' });

      // Then try to create duplicate of the original version
      await updateAgent(
        { id: agentId },
        {
          model_parameters: deepObject,
          description: undefined,
        },
      );

      // Since we're updating back to the same model_parameters but with a different description,
      // it should create a new version
      const agent = await getAgent({ id: agentId }, {});
      expect(agent!.versions).toHaveLength(3);
    });

    test('should handle version comparison with special field types', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        model_parameters: { temperature: 0.7 },
      });

      // Update with a real field change first
      const firstUpdate = await updateAgent({ id: agentId }, { description: 'New description' });

      expect(firstUpdate!.versions).toHaveLength(2);

      // Update with model parameters change
      const secondUpdate = await updateAgent(
        { id: agentId },
        { model_parameters: { temperature: 0.8 } },
      );

      expect(secondUpdate!.versions).toHaveLength(3);
    });

    test('should detect changes in support_contact fields', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent with initial support_contact
      await createAgent({
        id: agentId,
        name: 'Agent with Support Contact',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        support_contact: {
          name: 'Initial Support',
          email: 'initial@support.com',
        },
      });

      // Update support_contact name only
      const firstUpdate = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Updated Support',
            email: 'initial@support.com',
          },
        },
      );

      expect(firstUpdate!.versions).toHaveLength(2);
      expect(firstUpdate!.support_contact?.name).toBe('Updated Support');
      expect(firstUpdate!.support_contact?.email).toBe('initial@support.com');

      // Update support_contact email only
      const secondUpdate = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Updated Support',
            email: 'updated@support.com',
          },
        },
      );

      expect(secondUpdate!.versions).toHaveLength(3);
      expect(secondUpdate!.support_contact?.email).toBe('updated@support.com');

      // Try to update with same support_contact - should be detected as duplicate but return successfully
      const duplicateUpdate = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Updated Support',
            email: 'updated@support.com',
          },
        },
      );

      // Should not create a new version
      expect(duplicateUpdate?.versions).toHaveLength(3);
      expect((duplicateUpdate as IAgent & { version?: number })?.version).toBe(3);
      expect(duplicateUpdate?.support_contact?.email).toBe('updated@support.com');
    });

    test('should handle support_contact from empty to populated', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent without support_contact
      const agent = await createAgent({
        id: agentId,
        name: 'Agent without Support',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Verify support_contact is undefined since it wasn't provided
      expect(agent.support_contact).toBeUndefined();

      // Update to add support_contact
      const updated = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'New Support Team',
            email: 'support@example.com',
          },
        },
      );

      expect(updated?.versions).toHaveLength(2);
      expect(updated?.support_contact?.name).toBe('New Support Team');
      expect(updated?.support_contact?.email).toBe('support@example.com');
    });

    test('should handle support_contact edge cases in isDuplicateVersion', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent with support_contact
      await createAgent({
        id: agentId,
        name: 'Edge Case Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        support_contact: {
          name: 'Support',
          email: 'support@test.com',
        },
      });

      // Update to empty support_contact
      const emptyUpdate = await updateAgent(
        { id: agentId },
        {
          support_contact: {},
        },
      );

      expect(emptyUpdate?.versions).toHaveLength(2);
      expect(emptyUpdate?.support_contact).toEqual({});

      // Update back to populated support_contact
      const repopulated = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Support',
            email: 'support@test.com',
          },
        },
      );

      expect(repopulated?.versions).toHaveLength(3);

      // Verify all versions have correct support_contact
      const finalAgent = await getAgent({ id: agentId }, {});
      expect(finalAgent!.versions![0]?.support_contact).toEqual({
        name: 'Support',
        email: 'support@test.com',
      });
      expect(finalAgent!.versions![1]?.support_contact).toEqual({});
      expect(finalAgent!.versions![2]?.support_contact).toEqual({
        name: 'Support',
        email: 'support@test.com',
      });
    });

    test('should preserve support_contact in version history', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent
      await createAgent({
        id: agentId,
        name: 'Version History Test',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        support_contact: {
          name: 'Initial Contact',
          email: 'initial@test.com',
        },
      });

      // Multiple updates with different support_contact values
      await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Second Contact',
            email: 'second@test.com',
          },
        },
      );

      await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'Third Contact',
            email: 'third@test.com',
          },
        },
      );

      const finalAgent = await getAgent({ id: agentId }, {});

      // Verify version history
      expect(finalAgent!.versions).toHaveLength(3);
      expect(finalAgent!.versions![0]?.support_contact).toEqual({
        name: 'Initial Contact',
        email: 'initial@test.com',
      });
      expect(finalAgent!.versions![1]?.support_contact).toEqual({
        name: 'Second Contact',
        email: 'second@test.com',
      });
      expect(finalAgent!.versions![2]?.support_contact).toEqual({
        name: 'Third Contact',
        email: 'third@test.com',
      });

      // Current state should match last version
      expect(finalAgent!.support_contact).toEqual({
        name: 'Third Contact',
        email: 'third@test.com',
      });
    });

    test('should handle partial support_contact updates', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent with full support_contact
      await createAgent({
        id: agentId,
        name: 'Partial Update Test',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        support_contact: {
          name: 'Original Name',
          email: 'original@email.com',
        },
      });

      // MongoDB's findOneAndUpdate will replace the entire support_contact object
      // So we need to verify that partial updates still work correctly
      const updated = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'New Name',
            email: '', // Empty email
          },
        },
      );

      expect(updated?.versions).toHaveLength(2);
      expect(updated?.support_contact?.name).toBe('New Name');
      expect(updated?.support_contact?.email).toBe('');

      // Verify isDuplicateVersion works with partial changes - should return successfully without creating new version
      const duplicateUpdate = await updateAgent(
        { id: agentId },
        {
          support_contact: {
            name: 'New Name',
            email: '',
          },
        },
      );

      // Should not create a new version since content is the same
      expect(duplicateUpdate?.versions).toHaveLength(2);
      expect((duplicateUpdate as IAgent & { version?: number })?.version).toBe(2);
      expect(duplicateUpdate?.support_contact?.name).toBe('New Name');
      expect(duplicateUpdate?.support_contact?.email).toBe('');
    });

    // Edge Cases
    describe.each([
      {
        operation: 'add',
        name: 'empty file_id',
        needsAgent: true,
        params: { tool_resource: 'file_search', file_id: '' },
        shouldResolve: true,
      },
      {
        operation: 'add',
        name: 'non-existent agent',
        needsAgent: false,
        params: { tool_resource: 'file_search', file_id: 'file123' },
        shouldResolve: false,
        error: 'Agent not found for adding resource file',
      },
    ])('addAgentResourceFile with $name', ({ needsAgent, params, shouldResolve, error }) => {
      test(`should ${shouldResolve ? 'resolve' : 'reject'}`, async () => {
        const agent = needsAgent ? await createBasicAgent() : null;
        const agent_id = needsAgent ? agent!.id : `agent_${uuidv4()}`;

        if (shouldResolve) {
          await expect(addAgentResourceFile({ agent_id, ...params })).resolves.toBeDefined();
        } else {
          await expect(addAgentResourceFile({ agent_id, ...params })).rejects.toThrow(error);
        }
      });
    });

    describe.each([
      {
        name: 'empty files array',
        files: [],
        needsAgent: true,
        shouldResolve: true,
      },
      {
        name: 'non-existent tool_resource',
        files: [{ tool_resource: 'non_existent_tool', file_id: 'file123' }],
        needsAgent: true,
        shouldResolve: true,
      },
      {
        name: 'non-existent agent',
        files: [{ tool_resource: 'file_search', file_id: 'file123' }],
        needsAgent: false,
        shouldResolve: false,
        error: 'Agent not found for removing resource files',
      },
    ])('removeAgentResourceFiles with $name', ({ files, needsAgent, shouldResolve, error }) => {
      test(`should ${shouldResolve ? 'resolve' : 'reject'}`, async () => {
        const agent = needsAgent ? await createBasicAgent() : null;
        const agent_id = needsAgent ? agent!.id : `agent_${uuidv4()}`;

        if (shouldResolve) {
          const result = await removeAgentResourceFiles({ agent_id, files });
          expect(result).toBeDefined();
          if (agent) {
            expect(result.id).toBe(agent.id);
          }
        } else {
          await expect(removeAgentResourceFiles({ agent_id, files })).rejects.toThrow(error);
        }
      });
    });

    describe('Edge Cases', () => {
      test('should handle extremely large version history', async () => {
        const agentId = `agent_${uuidv4()}`;
        const authorId = new mongoose.Types.ObjectId();

        await createAgent({
          id: agentId,
          name: 'Version Test',
          provider: 'test',
          model: 'test-model',
          author: authorId,
        });

        for (let i = 0; i < 20; i++) {
          await updateAgent({ id: agentId }, { description: `Version ${i}` });
        }

        const agent = await getAgent({ id: agentId }, {});
        expect(agent!.versions).toHaveLength(21);
        expect(agent!.description).toBe('Version 19');
      });

      test('should handle revertAgentVersion with invalid version index', async () => {
        const agentId = `agent_${uuidv4()}`;
        const authorId = new mongoose.Types.ObjectId();

        await createAgent({
          id: agentId,
          name: 'Test Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
        });

        await expect(revertAgentVersion({ id: agentId }, 5)).rejects.toThrow('Version 5 not found');
      });

      test('should handle revertAgentVersion with non-existent agent', async () => {
        const nonExistentId = `agent_${uuidv4()}`;

        await expect(revertAgentVersion({ id: nonExistentId }, 0)).rejects.toThrow(
          'Agent not found',
        );
      });

      test('should handle updateAgent with empty update object', async () => {
        const agentId = `agent_${uuidv4()}`;
        const authorId = new mongoose.Types.ObjectId();

        await createAgent({
          id: agentId,
          name: 'Test Agent',
          provider: 'test',
          model: 'test-model',
          author: authorId,
        });

        const updatedAgent = await updateAgent({ id: agentId }, {});

        expect(updatedAgent).toBeDefined();
        expect(updatedAgent!.name).toBe('Test Agent');
        expect(updatedAgent!.versions).toHaveLength(1);
      });
    });
  });

  describe('Action Metadata and Hash Generation', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
    });

    test('should generate consistent hash for same action metadata', async () => {
      const actionIds = ['test.com_action_123', 'example.com_action_456'];
      const actions = [
        {
          action_id: '123',
          metadata: { version: '1.0', endpoints: ['GET /api/test'], schema: { type: 'object' } },
        },
        {
          action_id: '456',
          metadata: {
            version: '2.0',
            endpoints: ['POST /api/example'],
            schema: { type: 'string' },
          },
        },
      ];

      const hash1 = await generateActionMetadataHash(actionIds, actions);
      const hash2 = await generateActionMetadataHash(actionIds, actions);

      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBe(64); // SHA-256 produces 64 character hex string
    });

    test('should generate different hashes for different action metadata', async () => {
      const actionIds = ['test.com_action_123'];
      const actions1 = [
        { action_id: '123', metadata: { version: '1.0', endpoints: ['GET /api/test'] } },
      ];
      const actions2 = [
        { action_id: '123', metadata: { version: '2.0', endpoints: ['GET /api/test'] } },
      ];

      const hash1 = await generateActionMetadataHash(actionIds, actions1);
      const hash2 = await generateActionMetadataHash(actionIds, actions2);

      expect(hash1).not.toBe(hash2);
    });

    test('should handle empty action arrays', async () => {
      const hash = await generateActionMetadataHash([], []);
      expect(hash).toBe('');
    });

    test('should handle null or undefined action arrays', async () => {
      const hash1 = await generateActionMetadataHash(null, []);
      const hash2 = await generateActionMetadataHash(undefined, []);

      expect(hash1).toBe('');
      expect(hash2).toBe('');
    });

    test('should handle missing action metadata gracefully', async () => {
      const actionIds = ['test.com_action_123', 'missing.com_action_999'];
      const actions = [
        { action_id: '123', metadata: { version: '1.0' } },
        // missing action with id '999'
      ];

      const hash = await generateActionMetadataHash(actionIds, actions);
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    test('should sort action IDs for consistent hashing', async () => {
      const actionIds1 = ['b.com_action_2', 'a.com_action_1'];
      const actionIds2 = ['a.com_action_1', 'b.com_action_2'];
      const actions = [
        { action_id: '1', metadata: { version: '1.0' } },
        { action_id: '2', metadata: { version: '2.0' } },
      ];

      const hash1 = await generateActionMetadataHash(actionIds1, actions);
      const hash2 = await generateActionMetadataHash(actionIds2, actions);

      expect(hash1).toBe(hash2);
    });

    test('should handle complex nested metadata objects', async () => {
      const actionIds = ['complex.com_action_1'];
      const actions = [
        {
          action_id: '1',
          metadata: {
            version: '1.0',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                nested: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
            endpoints: [
              { path: '/api/test', method: 'GET', params: ['id'] },
              { path: '/api/create', method: 'POST', body: true },
            ],
          },
        },
      ];

      const hash = await generateActionMetadataHash(actionIds, actions);
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    describe('Edge Cases', () => {
      test('should handle generateActionMetadataHash with null metadata', async () => {
        const hash = await generateActionMetadataHash(
          ['test.com_action_1'],
          [{ action_id: '1', metadata: null }],
        );
        expect(typeof hash).toBe('string');
      });

      test('should handle generateActionMetadataHash with deeply nested metadata', async () => {
        const deepMetadata = {
          level1: {
            level2: {
              level3: {
                level4: {
                  level5: 'deep value',
                  array: [1, 2, { nested: true }],
                },
              },
            },
          },
        };

        const hash = await generateActionMetadataHash(
          ['test.com_action_1'],
          [{ action_id: '1', metadata: deepMetadata }],
        );

        expect(typeof hash).toBe('string');
        expect(hash.length).toBe(64);
      });

      test('should handle generateActionMetadataHash with special characters', async () => {
        const specialMetadata = {
          unicode: '🚀🎉👍',
          symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
          quotes: 'single\'s and "doubles"',
          newlines: 'line1\nline2\r\nline3',
        };

        const hash = await generateActionMetadataHash(
          ['test.com_action_1'],
          [{ action_id: '1', metadata: specialMetadata }],
        );

        expect(typeof hash).toBe('string');
        expect(hash.length).toBe(64);
      });
    });
  });

  /* Load Agent Functionality tests moved to api/models/Agent.spec.js */

  describe('Agent Edge Cases and Error Handling', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
    });

    test('should handle agent creation with minimal required fields', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      const agent = await createAgent({
        id: agentId,
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      expect(agent).toBeDefined();
      expect(agent.id).toBe(agentId);
      expect(agent.versions).toHaveLength(1);
      expect(agent.versions![0]?.provider).toBe('test');
      expect(agent.versions![0]?.model).toBe('test-model');
    });

    test('should handle agent creation with all optional fields', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      const agent = await createAgent({
        id: agentId,
        name: 'Complex Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        description: 'Complex description',
        instructions: 'Complex instructions',
        tools: ['tool1', 'tool2'],
        actions: ['action1', 'action2'],
        model_parameters: { temperature: 0.8, max_tokens: 1000 },
        avatar: 'https://example.com/avatar.png',
        tool_resources: {
          file_search: { file_ids: ['file1', 'file2'] },
        },
      });

      expect(agent).toBeDefined();
      expect(agent.name).toBe('Complex Agent');
      expect(agent.description).toBe('Complex description');
      expect(agent.instructions).toBe('Complex instructions');
      expect(agent.tools).toEqual(['tool1', 'tool2']);
      expect(agent.actions).toEqual(['action1', 'action2']);
      expect(agent.model_parameters?.temperature).toBe(0.8);
      expect(agent.model_parameters?.max_tokens).toBe(1000);
      expect(agent.avatar).toBe('https://example.com/avatar.png');
      expect(agent.tool_resources?.file_search?.file_ids).toEqual(['file1', 'file2']);
    });

    test('should handle updateAgent with empty update object', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      const updatedAgent = await updateAgent({ id: agentId }, {});

      expect(updatedAgent).toBeDefined();
      expect(updatedAgent!.name).toBe('Test Agent');
      expect(updatedAgent!.versions).toHaveLength(1); // No new version should be created
    });

    test('should handle concurrent updates to different agents', async () => {
      const agent1Id = `agent_${uuidv4()}`;
      const agent2Id = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agent1Id,
        name: 'Agent 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await createAgent({
        id: agent2Id,
        name: 'Agent 2',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Concurrent updates to different agents
      const [updated1, updated2] = await Promise.all([
        updateAgent({ id: agent1Id }, { description: 'Updated Agent 1' }),
        updateAgent({ id: agent2Id }, { description: 'Updated Agent 2' }),
      ]);

      expect(updated1?.description).toBe('Updated Agent 1');
      expect(updated2?.description).toBe('Updated Agent 2');
      expect(updated1?.versions).toHaveLength(2);
      expect(updated2?.versions).toHaveLength(2);
    });

    test('should handle agent deletion with non-existent ID', async () => {
      const nonExistentId = `agent_${uuidv4()}`;
      const result = await deleteAgent({ id: nonExistentId });

      expect(result).toBeNull();
    });

    test('should handle updateAgent with MongoDB operators mixed with direct updates', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: ['tool1'],
      });

      // Test with $push and direct field update
      const updatedAgent = await updateAgent(
        { id: agentId },
        {
          name: 'Updated Name',
          $push: { tools: 'tool2' },
        },
      );

      expect(updatedAgent!.name).toBe('Updated Name');
      expect(updatedAgent!.tools).toContain('tool1');
      expect(updatedAgent!.tools).toContain('tool2');
      expect(updatedAgent!.versions).toHaveLength(2);
    });

    test('should handle revertAgentVersion with invalid version index', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Try to revert to non-existent version
      await expect(revertAgentVersion({ id: agentId }, 5)).rejects.toThrow('Version 5 not found');
    });

    test('should handle revertAgentVersion with non-existent agent', async () => {
      const nonExistentId = `agent_${uuidv4()}`;

      await expect(revertAgentVersion({ id: nonExistentId }, 0)).rejects.toThrow('Agent not found');
    });

    test('should handle addAgentResourceFile with non-existent agent', async () => {
      const nonExistentId = `agent_${uuidv4()}`;

      await expect(
        addAgentResourceFile({
          agent_id: nonExistentId,
          tool_resource: 'file_search',
          file_id: 'file123',
        }),
      ).rejects.toThrow('Agent not found for adding resource file');
    });

    test('should handle removeAgentResourceFiles with non-existent agent', async () => {
      const nonExistentId = `agent_${uuidv4()}`;

      await expect(
        removeAgentResourceFiles({
          agent_id: nonExistentId,
          files: [{ tool_resource: 'file_search', file_id: 'file123' }],
        }),
      ).rejects.toThrow('Agent not found for removing resource files');
    });

    describe('getSharedResourceFileIds', () => {
      beforeEach(async () => {
        await Agent.deleteMany({});
      });

      test('reports a file another agent still references, across tool resources', async () => {
        const sharedFileId = `file_${uuidv4()}`;
        const soleFileId = `file_${uuidv4()}`;

        const agent = await createBasicAgent();
        const duplicate = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: sharedFileId,
        });
        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: soleFileId,
        });
        await addAgentResourceFile({
          agent_id: duplicate.id,
          tool_resource: EToolResources.context,
          file_id: sharedFileId,
        });

        const shared = await getSharedResourceFileIds({
          file_ids: [sharedFileId, soleFileId],
          excludeAgentObjectId: String(agent._id),
        });

        expect(shared).toEqual([sharedFileId]);
      });

      test('does not count the excluded agent’s own reference', async () => {
        const fileId = `file_${uuidv4()}`;
        const agent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: fileId,
        });

        expect(
          await getSharedResourceFileIds({
            file_ids: [fileId],
            excludeAgentObjectId: String(agent._id),
          }),
        ).toEqual([]);
        expect(await getSharedResourceFileIds({ file_ids: [fileId] })).toEqual([fileId]);
      });

      test('reports a file the same agent still holds under another tool resource', async () => {
        const fileId = `file_${uuidv4()}`;
        const agent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: fileId,
        });
        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.context,
          file_id: fileId,
        });

        expect(
          await getSharedResourceFileIds({
            file_ids: [fileId],
            excludeAgentObjectId: String(agent._id),
            excludeToolResource: EToolResources.file_search,
          }),
        ).toEqual([fileId]);
      });

      test('does not count the pair being removed', async () => {
        const fileId = `file_${uuidv4()}`;
        const agent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: fileId,
        });

        expect(
          await getSharedResourceFileIds({
            file_ids: [fileId],
            excludeAgentObjectId: String(agent._id),
            excludeToolResource: EToolResources.file_search,
          }),
        ).toEqual([]);
      });

      test('does not skip another tenant’s agent that shares the logical id', async () => {
        const sharedId = `agent_${uuidv4()}`;
        const fileId = `file_${uuidv4()}`;
        const tenantA = `tenant-${uuidv4()}`;
        const tenantB = `tenant-${uuidv4()}`;

        /* `id` is unique only with `tenantId`, so two tenants can hold the same logical agent id.
           Excluding by `id` would call the file unreferenced and destroy tenant B's bytes. */
        const agentA = await tenantStorage.run({ tenantId: tenantA }, () =>
          createBasicAgent({ id: sharedId }),
        );
        await tenantStorage.run({ tenantId: tenantB }, () => createBasicAgent({ id: sharedId }));

        await tenantStorage.run({ tenantId: tenantA }, () =>
          addAgentResourceFile({
            agent_id: sharedId,
            tool_resource: EToolResources.file_search,
            file_id: fileId,
          }),
        );
        await tenantStorage.run({ tenantId: tenantB }, () =>
          addAgentResourceFile({
            agent_id: sharedId,
            tool_resource: EToolResources.file_search,
            file_id: fileId,
          }),
        );

        expect(
          await getSharedResourceFileIds({
            file_ids: [fileId],
            excludeAgentObjectId: String(agentA._id),
            excludeToolResource: EToolResources.file_search,
          }),
        ).toEqual([fileId]);
      });

      test('answers without querying when given no file_ids', async () => {
        expect(await getSharedResourceFileIds({ file_ids: [] })).toEqual([]);
      });
    });

    describe('removeAgentResourceFilesFromAllAgents', () => {
      beforeEach(async () => {
        await Agent.deleteMany({});
      });

      test('should strip deleted file_ids from every agent that references them', async () => {
        const sharedFileId = `file_${uuidv4()}`;
        const keeperFileId = `file_${uuidv4()}`;

        const agentA = await createBasicAgent();
        const agentB = await createBasicAgent();
        const untouchedAgent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agentA.id,
          tool_resource: EToolResources.file_search,
          file_id: sharedFileId,
        });
        await addAgentResourceFile({
          agent_id: agentA.id,
          tool_resource: EToolResources.file_search,
          file_id: keeperFileId,
        });
        await addAgentResourceFile({
          agent_id: agentB.id,
          tool_resource: EToolResources.execute_code,
          file_id: sharedFileId,
        });
        await addAgentResourceFile({
          agent_id: untouchedAgent.id,
          tool_resource: EToolResources.context,
          file_id: keeperFileId,
        });

        const result = await removeAgentResourceFilesFromAllAgents({
          file_ids: [sharedFileId],
        });

        expect(result.matchedCount).toBe(2);
        expect(result.modifiedCount).toBe(2);

        const updatedA = await getAgent({ id: agentA.id });
        const updatedB = await getAgent({ id: agentB.id });
        const updatedUntouched = await getAgent({ id: untouchedAgent.id });

        const aFileIds = (updatedA!.tool_resources as Record<string, { file_ids: string[] }>)
          .file_search.file_ids;
        const bFileIds = (updatedB!.tool_resources as Record<string, { file_ids: string[] }>)
          .execute_code.file_ids;
        const untouchedFileIds = (
          updatedUntouched!.tool_resources as Record<string, { file_ids: string[] }>
        ).context.file_ids;

        expect(aFileIds).not.toContain(sharedFileId);
        expect(aFileIds).toContain(keeperFileId);
        expect(bFileIds).not.toContain(sharedFileId);
        expect(untouchedFileIds).toEqual([keeperFileId]);
      });

      test('should remove file_ids across multiple tool_resource types on the same agent', async () => {
        const fileId = `file_${uuidv4()}`;
        const agent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: fileId,
        });
        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.ocr,
          file_id: fileId,
        });

        await removeAgentResourceFilesFromAllAgents({ file_ids: [fileId] });

        const updated = await getAgent({ id: agent.id });
        const resources = updated!.tool_resources as Record<string, { file_ids: string[] }>;
        expect(resources.file_search.file_ids).not.toContain(fileId);
        expect(resources.ocr.file_ids).not.toContain(fileId);
      });

      test('should no-op and not throw when file_ids is empty', async () => {
        const result = await removeAgentResourceFilesFromAllAgents({ file_ids: [] });
        expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
      });

      test('should no-op when no agent references the given file_ids', async () => {
        const fileId = `file_${uuidv4()}`;
        const agent = await createBasicAgent();

        await addAgentResourceFile({
          agent_id: agent.id,
          tool_resource: EToolResources.file_search,
          file_id: `different_${uuidv4()}`,
        });

        const result = await removeAgentResourceFilesFromAllAgents({ file_ids: [fileId] });
        expect(result.matchedCount).toBe(0);
        expect(result.modifiedCount).toBe(0);
      });
    });

    test('should handle updateAgent with complex nested updates', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        model_parameters: { temperature: 0.5 },
        tools: ['tool1'],
      });

      // First update with $push operation
      const firstUpdate = await updateAgent(
        { id: agentId },
        {
          $push: { tools: 'tool2' },
        },
      );

      expect(firstUpdate!.tools).toContain('tool1');
      expect(firstUpdate!.tools).toContain('tool2');

      // Second update with direct field update and $addToSet
      const secondUpdate = await updateAgent(
        { id: agentId },
        {
          name: 'Updated Agent',
          model_parameters: { temperature: 0.8, max_tokens: 500 },
          $addToSet: { tools: 'tool3' },
        },
      );

      expect(secondUpdate!.name).toBe('Updated Agent');
      expect(secondUpdate!.model_parameters?.temperature).toBe(0.8);
      expect(secondUpdate!.model_parameters?.max_tokens).toBe(500);
      expect(secondUpdate!.tools).toContain('tool1');
      expect(secondUpdate!.tools).toContain('tool2');
      expect(secondUpdate!.tools).toContain('tool3');
      expect(secondUpdate!.versions).toHaveLength(3);
    });

    test('should preserve version order in versions array', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Version 1',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      await updateAgent({ id: agentId }, { name: 'Version 2' });
      await updateAgent({ id: agentId }, { name: 'Version 3' });
      const finalAgent = await updateAgent({ id: agentId }, { name: 'Version 4' });

      expect(finalAgent!.versions).toHaveLength(4);
      expect(finalAgent!.versions![0]?.name).toBe('Version 1');
      expect(finalAgent!.versions![1]?.name).toBe('Version 2');
      expect(finalAgent!.versions![2]?.name).toBe('Version 3');
      expect(finalAgent!.versions![3]?.name).toBe('Version 4');
      expect(finalAgent!.name).toBe('Version 4');
    });

    test('should handle revertAgentVersion properly', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Original Name',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        description: 'Original description',
      });

      await updateAgent(
        { id: agentId },
        { name: 'Updated Name', description: 'Updated description' },
      );

      const revertedAgent = await revertAgentVersion({ id: agentId }, 0);

      expect(revertedAgent.name).toBe('Original Name');
      expect(revertedAgent.description).toBe('Original description');
      expect(revertedAgent.author.toString()).toBe(authorId.toString());
    });

    test('should handle action-related updates with getActions error', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      // Create agent with actions that might cause getActions to fail
      await createAgent({
        id: agentId,
        name: 'Agent with Actions',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        actions: ['test.com_action_invalid_id'],
      });

      // Update should still work even if getActions fails
      const updatedAgent = await updateAgent(
        { id: agentId },
        { description: 'Updated description' },
      );

      expect(updatedAgent).toBeDefined();
      expect(updatedAgent!.description).toBe('Updated description');
      expect(updatedAgent!.versions).toHaveLength(2);
    });

    test('should handle updateAgent with combined MongoDB operators', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tools: ['tool1'],
      });

      // Use multiple operators in single update - but avoid conflicting operations on same field
      const updatedAgent = await updateAgent(
        { id: agentId },
        {
          name: 'Updated Name',
          $push: { tools: 'tool2' },
        },
      );

      expect(updatedAgent).toBeDefined();
      expect(updatedAgent!.name).toBe('Updated Name');
      expect(updatedAgent!.tools).toContain('tool1');
      expect(updatedAgent!.tools).toContain('tool2');
      expect(updatedAgent!.versions).toHaveLength(2);
    });

    test('should handle updateAgent when agent does not exist', async () => {
      const nonExistentId = `agent_${uuidv4()}`;

      const result = await updateAgent({ id: nonExistentId }, { name: 'New Name' });

      expect(result).toBeNull();
    });

    test('should handle concurrent updates with database errors', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Mock findOneAndUpdate to simulate database error
      const cleanup = mockFindOneAndUpdateError(2);

      // Concurrent updates where one fails
      const promises = [
        updateAgent({ id: agentId }, { name: 'Update 1' }),
        updateAgent({ id: agentId }, { name: 'Update 2' }),
        updateAgent({ id: agentId }, { name: 'Update 3' }),
      ];

      const results = await Promise.allSettled(promises);

      cleanup();

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      expect(succeeded).toBe(2);
      expect(failed).toBe(1);
    });

    test('should handle removeAgentResourceFiles when agent is deleted during operation', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        tool_resources: {
          file_search: {
            file_ids: ['file1', 'file2', 'file3'],
          },
        },
      });

      // Mock findOneAndUpdate to return null (simulating deletion)
      const originalFindOneAndUpdate = Agent.findOneAndUpdate;
      Agent.findOneAndUpdate = jest.fn().mockImplementation(() => ({
        lean: jest.fn().mockResolvedValue(null),
      }));

      // Try to remove files from deleted agent
      await expect(
        removeAgentResourceFiles({
          agent_id: agentId,
          files: [
            { tool_resource: 'file_search', file_id: 'file1' },
            { tool_resource: 'file_search', file_id: 'file2' },
          ],
        }),
      ).rejects.toThrow('Failed to update agent during file removal (pull step)');

      Agent.findOneAndUpdate = originalFindOneAndUpdate;
    });

    test('should handle addAgentResourceFile when array initialization fails', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      // Mock the updateOne operation to fail but let updateAgent succeed
      const originalUpdateOne = Agent.updateOne;
      let updateOneCalled = false;
      Agent.updateOne = jest.fn().mockImplementation((...args) => {
        if (!updateOneCalled) {
          updateOneCalled = true;
          return Promise.reject(new Error('Database error'));
        }
        return originalUpdateOne.apply(
          Agent,
          args as [update: UpdateQuery<IAgent> | UpdateWithAggregationPipeline],
        );
      });

      try {
        const result = await addAgentResourceFile({
          agent_id: agentId,
          tool_resource: 'new_tool',
          file_id: 'file123',
        });

        expect(result).toBeDefined();
        expect(result.tools).toContain('new_tool');
      } catch (error: unknown) {
        expect((error as Error).message).toBe('Database error');
      }

      Agent.updateOne = originalUpdateOne;
    });
  });

  describe('Agent IDs Field in Version Detection', () => {
    beforeEach(async () => {
      await Agent.deleteMany({});
    });

    test('should now create new version when agent_ids field changes', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      const agent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        agent_ids: ['agent1', 'agent2'],
      });

      expect(agent).toBeDefined();
      expect(agent.versions).toHaveLength(1);

      const updated = await updateAgent(
        { id: agentId },
        { agent_ids: ['agent1', 'agent2', 'agent3'] },
      );

      // Since agent_ids is no longer excluded, this should create a new version
      expect(updated?.versions).toHaveLength(2);
      expect(updated?.agent_ids).toEqual(['agent1', 'agent2', 'agent3']);
    });

    test('should detect duplicate version if agent_ids is updated to same value', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        agent_ids: ['agent1', 'agent2'],
      });

      const updatedAgent = await updateAgent(
        { id: agentId },
        { agent_ids: ['agent1', 'agent2', 'agent3'] },
      );
      expect(updatedAgent!.versions).toHaveLength(2);

      // Update with same agent_ids should succeed but not create a new version
      const duplicateUpdate = await updateAgent(
        { id: agentId },
        { agent_ids: ['agent1', 'agent2', 'agent3'] },
      );
      expect(duplicateUpdate?.versions).toHaveLength(2); // No new version created
    });

    test('should handle agent_ids field alongside other fields', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        description: 'Initial description',
        agent_ids: ['agent1'],
      });

      const updated = await updateAgent(
        { id: agentId },
        {
          agent_ids: ['agent1', 'agent2'],
          description: 'Updated description',
        },
      );

      expect(updated?.versions).toHaveLength(2);
      expect(updated?.agent_ids).toEqual(['agent1', 'agent2']);
      expect(updated?.description).toBe('Updated description');

      const updated2 = await updateAgent({ id: agentId }, { description: 'Another description' });

      expect(updated2?.versions).toHaveLength(3);
      expect(updated2?.agent_ids).toEqual(['agent1', 'agent2']);
      expect(updated2?.description).toBe('Another description');
    });

    test('should preserve agent_ids in version history', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        agent_ids: ['agent1'],
      });

      await updateAgent({ id: agentId }, { agent_ids: ['agent1', 'agent2'] });

      await updateAgent({ id: agentId }, { agent_ids: ['agent3'] });

      const finalAgent = await getAgent({ id: agentId }, {});

      expect(finalAgent!.versions).toHaveLength(3);
      expect(finalAgent!.versions![0]?.agent_ids).toEqual(['agent1']);
      expect(finalAgent!.versions![1]?.agent_ids).toEqual(['agent1', 'agent2']);
      expect(finalAgent!.versions![2]?.agent_ids).toEqual(['agent3']);
      expect(finalAgent!.agent_ids).toEqual(['agent3']);
    });

    test('should handle empty agent_ids arrays', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
        agent_ids: ['agent1', 'agent2'],
      });

      const updated = await updateAgent({ id: agentId }, { agent_ids: [] });

      expect(updated?.versions).toHaveLength(2);
      expect(updated?.agent_ids).toEqual([]);

      // Update with same empty agent_ids should succeed but not create a new version
      const duplicateUpdate = await updateAgent({ id: agentId }, { agent_ids: [] });
      expect(duplicateUpdate?.versions).toHaveLength(2); // No new version created
      expect(duplicateUpdate?.agent_ids).toEqual([]);
    });

    test('should handle agent without agent_ids field', async () => {
      const agentId = `agent_${uuidv4()}`;
      const authorId = new mongoose.Types.ObjectId();

      const agent = await createAgent({
        id: agentId,
        name: 'Test Agent',
        provider: 'test',
        model: 'test-model',
        author: authorId,
      });

      expect(agent.agent_ids).toEqual([]);

      const updated = await updateAgent({ id: agentId }, { agent_ids: ['agent1'] });

      expect(updated?.versions).toHaveLength(2);
      expect(updated?.agent_ids).toEqual(['agent1']);
    });
  });
});

describe('Support Contact Field', () => {
  beforeEach(async () => {
    await Agent.deleteMany({});
  });

  it('should not create subdocument with ObjectId for support_contact', async () => {
    const userId = new mongoose.Types.ObjectId();
    const agentData = {
      id: 'agent_test_support',
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: userId,
      support_contact: {
        name: 'Support Team',
        email: 'support@example.com',
      },
    };

    // Create agent
    const agent = await createAgent(agentData);

    // Verify support_contact is stored correctly
    expect(agent.support_contact).toBeDefined();
    expect(agent.support_contact?.name).toBe('Support Team');
    expect(agent.support_contact?.email).toBe('support@example.com');

    // Verify no _id field is created in support_contact
    expect((agent.support_contact as Record<string, unknown>)?._id).toBeUndefined();

    // Fetch from database to double-check
    const dbAgent = await Agent.findOne({ id: agentData.id });
    expect(dbAgent?.support_contact).toBeDefined();
    expect(dbAgent?.support_contact?.name).toBe('Support Team');
    expect(dbAgent?.support_contact?.email).toBe('support@example.com');
    expect((dbAgent?.support_contact as Record<string, unknown>)?._id).toBeUndefined();
  });

  it('should handle empty support_contact correctly', async () => {
    const userId = new mongoose.Types.ObjectId();
    const agentData = {
      id: 'agent_test_empty_support',
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: userId,
      support_contact: {},
    };

    const agent = await createAgent(agentData);

    // Verify empty support_contact is stored as empty object
    expect(agent.support_contact).toEqual({});
    expect((agent.support_contact as Record<string, unknown>)?._id).toBeUndefined();
  });

  it('should handle missing support_contact correctly', async () => {
    const userId = new mongoose.Types.ObjectId();
    const agentData = {
      id: 'agent_test_no_support',
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: userId,
    };

    const agent = await createAgent(agentData);

    // Verify support_contact is undefined when not provided
    expect(agent.support_contact).toBeUndefined();
  });

  describe('getListAgentsByAccess - Security Tests', () => {
    let userA: mongoose.Types.ObjectId, userB: mongoose.Types.ObjectId;
    let agentA1: Awaited<ReturnType<AgentMethods['createAgent']>>,
      agentA2: Awaited<ReturnType<AgentMethods['createAgent']>>,
      agentA3: Awaited<ReturnType<AgentMethods['createAgent']>>;

    beforeEach(async () => {
      await Agent.deleteMany({});
      await AclEntry.deleteMany({});

      // Create two users
      userA = new mongoose.Types.ObjectId();
      userB = new mongoose.Types.ObjectId();

      // Create agents for user A
      agentA1 = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent A1',
        description: 'User A agent 1',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
      });

      agentA2 = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent A2',
        description: 'User A agent 2',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
      });

      agentA3 = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent A3',
        description: 'User A agent 3',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
      });
    });

    test('unrestricted listing still applies filters and paginates without overlap', async () => {
      const first = await getListAgentsByAccess({
        accessibleIds: null,
        otherParams: { name: /^Agent A/ },
        limit: 1,
      });
      expect(first.data).toHaveLength(1);
      expect(first.has_more).toBe(true);
      expect(first.after).toBeTruthy();

      const second = await getListAgentsByAccess({
        accessibleIds: null,
        otherParams: { name: /^Agent A/ },
        limit: 1,
        after: first.after,
      });
      expect(second.data).toHaveLength(1);
      expect(second.has_more).toBe(true);

      const third = await getListAgentsByAccess({
        accessibleIds: null,
        otherParams: { name: /^Agent A/ },
        limit: 1,
        after: second.after,
      });
      expect(third.has_more).toBe(false);
      expect(
        [first, second, third].flatMap((page) => page.data.map((agent) => agent.id)).sort(),
      ).toEqual([agentA1.id, agentA2.id, agentA3.id].sort());
    });

    test('should return empty list when user has no accessible agents (empty accessibleIds)', async () => {
      // User B has no agents and no shared agents
      const result = await getListAgentsByAccess({
        accessibleIds: [],
        otherParams: {},
      });

      expect(result.data).toHaveLength(0);
      expect(result.has_more).toBe(false);
      expect(result.first_id).toBeNull();
      expect(result.last_id).toBeNull();
    });

    test('unrestricted listing cannot cross tenant boundaries', async () => {
      const tenantA = `tenant-a-${uuidv4()}`;
      const tenantB = `tenant-b-${uuidv4()}`;
      const name = 'Shared Name';
      const agentInA = await tenantStorage.run({ tenantId: tenantA }, () =>
        createAgent({
          id: `agent_${uuidv4()}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        }),
      );
      await tenantStorage.run({ tenantId: tenantB }, () =>
        createAgent({
          id: `agent_${uuidv4()}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userB,
        }),
      );

      const result = await tenantStorage.run({ tenantId: tenantA }, () =>
        getListAgentsByAccess({ accessibleIds: null, tenantId: tenantA, otherParams: { name } }),
      );
      expect(result.data.map((agent) => agent.id)).toEqual([agentInA.id]);
      const denied = await tenantStorage.run({ tenantId: tenantA }, () =>
        getListAgentsByAccess({ accessibleIds: [], otherParams: { name } }),
      );
      expect(denied.data).toHaveLength(0);
    });

    test('unrestricted list uses the supplied tenant even without request context', async () => {
      const tenantA = `tenant-a-${uuidv4()}`;
      const tenantB = `tenant-b-${uuidv4()}`;
      const name = 'Same Agent Name';
      const legacy = await createAgent({
        id: `agent_${uuidv4()}`,
        name,
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
      });
      const agentInA = await tenantStorage.run({ tenantId: tenantA }, () =>
        createAgent({
          id: `agent_${uuidv4()}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        }),
      );
      await tenantStorage.run({ tenantId: tenantB }, () =>
        createAgent({
          id: `agent_${uuidv4()}`,
          name,
          provider: 'openai',
          model: 'gpt-4',
          author: userB,
        }),
      );

      const scoped = await getListAgentsByAccess({
        accessibleIds: null,
        tenantId: tenantA,
        otherParams: { name },
      });
      expect(scoped.data.map((agent) => agent.id)).toEqual([agentInA.id]);
      const legacyOnly = await getListAgentsByAccess({
        accessibleIds: null,
        tenantId: null,
        otherParams: { name },
      });
      expect(legacyOnly.data.map((agent) => agent.id)).toEqual([legacy.id]);
      const omitted = await getListAgentsByAccess({ accessibleIds: null, otherParams: { name } });
      expect(omitted.data.map((agent) => agent.id)).toEqual([legacy.id]);
    });

    test('accepts plain string IDs from the API resolver without weakening ACL filtering', async () => {
      const result = await getListAgentsByAccess({ accessibleIds: [agentA2._id.toString()] });
      expect(result.data.map((agent) => agent.id)).toEqual([agentA2.id]);
    });

    test('should not return other users agents when accessibleIds is empty', async () => {
      // User B trying to list agents with empty accessibleIds should not see User A's agents
      const result = await getListAgentsByAccess({
        accessibleIds: [],
        otherParams: { author: userB },
      });

      expect(result.data).toHaveLength(0);
      expect(result.has_more).toBe(false);
    });

    test('should only return agents in accessibleIds list', async () => {
      // Give User B access to only one of User A's agents
      const accessibleIds = [agentA1._id] as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(agentA1.id);
      expect(result.data[0].name).toBe('Agent A1');
    });

    test('should omit skill configuration from the default list projection', async () => {
      const skillDocs = await mongoose.models.Skill.create([
        {
          name: 'projection-skill-a',
          description: 'Skill backing projection test.',
          author: userA,
          authorName: 'Test Author',
        },
        {
          name: 'projection-skill-b',
          description: 'Skill backing projection test.',
          author: userA,
          authorName: 'Test Author',
        },
      ]);
      const targetSkillIds = skillDocs.map((doc) => doc._id.toString());
      const scopedAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Scoped Agent',
        description: 'Agent with configured skill scope',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        skills: targetSkillIds,
        skills_enabled: true,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [scopedAgent._id] as mongoose.Types.ObjectId[],
        otherParams: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].skills).toBeUndefined();
      expect(result.data[0].skills_enabled).toBeUndefined();
    });

    test('should include skill configuration only when explicitly requested', async () => {
      const skillDocs = await mongoose.models.Skill.create([
        {
          name: 'scoped-skill-a',
          description: 'Skill backing inclusion test.',
          author: userA,
          authorName: 'Test Author',
        },
        {
          name: 'scoped-skill-b',
          description: 'Skill backing inclusion test.',
          author: userA,
          authorName: 'Test Author',
        },
      ]);
      const targetSkillIds = skillDocs.map((doc) => doc._id.toString());
      const scopedAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Scoped Agent',
        description: 'Agent with configured skill scope',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        skills: targetSkillIds,
        skills_enabled: true,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [scopedAgent._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        includeSkillConfig: true,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].skills).toEqual(targetSkillIds);
      expect(result.data[0].skills_enabled).toBe(true);
    });

    test('should include conversation_starters in the default list projection', async () => {
      const starters = ['Summarize this page', 'What can you do?'];
      const scopedAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent With Starters',
        description: 'Agent exposing conversation starters',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        conversation_starters: starters,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [scopedAgent._id] as mongoose.Types.ObjectId[],
        otherParams: {},
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].conversation_starters).toEqual(starters);
    });

    test('should include workspace execution metadata only when explicitly requested', async () => {
      const scopedAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Workspace Agent',
        description: 'Agent with attached workspace defaults',
        provider: 'openai',
        model: 'gpt-4',
        author: userA,
        tools: [EToolResources.execute_code, 'private_mcp_tool'],
        stateful_code_sessions: true,
        code_environment_id: 'machine-a',
        code_workspace_id: 'project-a',
        agent_ids: [agentA1.id],
        edges: [{ from: 'source', to: agentA1.id, prompt: 'Private routing prompt' }],
        subagents: {
          enabled: true,
          agent_ids: [agentA1.id],
          graphs: [
            {
              type: 'collapsed_team',
              name: 'Private graph name',
              agent_ids: [agentA1.id],
              edges: [],
              entry_agent_id: agentA1.id,
              result_agent_id: agentA1.id,
            },
          ],
        },
      });

      const defaultResult = await getListAgentsByAccess({
        accessibleIds: [scopedAgent._id] as mongoose.Types.ObjectId[],
        otherParams: {},
      });
      expect(defaultResult.data[0].tools).toBeUndefined();
      expect(defaultResult.data[0].code_workspace_id).toBeUndefined();
      expect(defaultResult.data[0].edges).toBeUndefined();

      const result = await getListAgentsByAccess({
        accessibleIds: [scopedAgent._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        includeExecutionConfig: true,
      });

      expect(result.data[0]).toMatchObject({
        tools: [EToolResources.execute_code],
        stateful_code_sessions: true,
        code_environment_id: 'machine-a',
        code_workspace_id: 'project-a',
        agent_ids: [agentA1.id],
        edges: [{ from: 'source', to: agentA1.id }],
        subagents: {
          enabled: true,
          agent_ids: [agentA1.id],
          graphs: [{ agent_ids: [agentA1.id] }],
        },
      });
      expect(result.data[0].tools).not.toContain('private_mcp_tool');
      expect(result.data[0].edges).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ prompt: expect.anything() })]),
      );
    });

    test('should return multiple accessible agents when provided', async () => {
      // Give User B access to two of User A's agents
      const accessibleIds = [agentA1._id, agentA3._id] as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
      });

      expect(result.data).toHaveLength(2);
      const returnedIds = result.data.map((agent) => agent.id);
      expect(returnedIds).toContain(agentA1.id);
      expect(returnedIds).toContain(agentA3.id);
      expect(returnedIds).not.toContain(agentA2.id);
    });

    test('should respect other query parameters while enforcing accessibleIds', async () => {
      // Give access to all agents but filter by name
      const accessibleIds = [agentA1._id, agentA2._id, agentA3._id] as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: { name: 'Agent A2' },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(agentA2.id);
    });

    test('should handle pagination correctly with accessibleIds filter', async () => {
      // Create more agents
      const moreAgents = [];
      for (let i = 4; i <= 10; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Agent A${i}`,
          description: `User A agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        });
        moreAgents.push(agent);
      }

      // Give access to all agents
      const allAgentIds = [agentA1, agentA2, agentA3, ...moreAgents].map(
        (a) => a._id,
      ) as mongoose.Types.ObjectId[];

      // First page
      const page1 = await getListAgentsByAccess({
        accessibleIds: allAgentIds,
        otherParams: {},
        limit: 5,
      });

      expect(page1.data).toHaveLength(5);
      expect(page1.has_more).toBe(true);
      expect(page1.after).toBeTruthy();

      // Second page
      const page2 = await getListAgentsByAccess({
        accessibleIds: allAgentIds,
        otherParams: {},
        limit: 5,
        after: page1.after,
      });

      expect(page2.data).toHaveLength(5);
      expect(page2.has_more).toBe(false);

      // Verify no overlap between pages
      const page1Ids = page1.data.map((a) => a.id);
      const page2Ids = page2.data.map((a) => a.id);
      const intersection = page1Ids.filter((id) => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });

    test('should return empty list when accessibleIds contains non-existent IDs', async () => {
      // Try with non-existent agent IDs
      const fakeIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];

      const result = await getListAgentsByAccess({
        accessibleIds: fakeIds,
        otherParams: {},
      });

      expect(result.data).toHaveLength(0);
      expect(result.has_more).toBe(false);
    });

    test('should handle undefined accessibleIds as empty array', async () => {
      // When accessibleIds is undefined, it should be treated as empty array
      const result = await getListAgentsByAccess({
        accessibleIds: undefined,
        otherParams: {},
      });

      expect(result.data).toHaveLength(0);
      expect(result.has_more).toBe(false);
    });

    test('should combine accessibleIds with author filter correctly', async () => {
      // Create an agent for User B
      const agentB1 = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent B1',
        description: 'User B agent 1',
        provider: 'openai',
        model: 'gpt-4',
        author: userB,
      });

      // Give User B access to one of User A's agents
      const accessibleIds = [agentA1._id, agentB1._id] as mongoose.Types.ObjectId[];

      // Filter by author should further restrict the results
      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: { author: userB },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(agentB1.id);
      expect(result.data[0].author).toBe(userB.toString());
    });

    test('should cap results at the default page size when limit is omitted', async () => {
      const extraAgents = [];
      for (let i = 0; i < 102; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Bulk Agent ${i}`,
          description: `Bulk agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        });
        extraAgents.push(agent);
      }

      const accessibleIds = extraAgents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
      });

      expect(result.data).toHaveLength(100);
      expect(result.has_more).toBe(true);
      expect(result.after).toBeTruthy();
    });

    test('should return all agents when limit is explicitly null', async () => {
      const extraAgents = [];
      for (let i = 0; i < 102; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Bulk Agent ${i}`,
          description: `Bulk agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        });
        extraAgents.push(agent);
      }

      const accessibleIds = extraAgents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        limit: null,
      });

      expect(result.data).toHaveLength(102);
      expect(result.has_more).toBe(false);
      expect(result.after).toBeNull();
    });

    test('should honor explicit limits above the legacy 100 cap', async () => {
      const extraAgents = [];
      for (let i = 0; i < 105; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Bulk Agent ${i}`,
          description: `Bulk agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author: userA,
        });
        extraAgents.push(agent);
      }

      const accessibleIds = extraAgents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const result = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        limit: 500,
      });

      expect(result.data).toHaveLength(105);
      expect(result.has_more).toBe(false);
    });
  });
});

describe('getListAgentsByAccess - Sort Modes and Mine Filter', () => {
  /** Forces a specific `updatedAt` via the raw driver so timestamps middleware doesn't overwrite it. */
  async function setUpdatedAt(agentId: mongoose.Types.ObjectId, date: Date) {
    await Agent.collection.updateOne({ _id: agentId }, { $set: { updatedAt: date } });
  }

  /** Forces a specific `createdAt` via the raw driver so timestamps middleware doesn't overwrite it. */
  async function setCreatedAt(agentId: mongoose.Types.ObjectId, date: Date) {
    await Agent.collection.updateOne({ _id: agentId }, { $set: { createdAt: date } });
  }

  beforeEach(async () => {
    await Agent.deleteMany({});
    await User.deleteMany({});
    await AclEntry.deleteMany({});
  });

  test('updates an avatar without advancing updatedAt', async () => {
    const agent = await createAgent({
      id: `agent_${uuidv4().slice(0, 12)}`,
      name: 'Avatar maintenance',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      avatar: { filepath: 'old-path.jpg', source: 's3' },
    });
    const originalUpdatedAt = new Date('2024-01-01T00:00:00Z');
    await setUpdatedAt(agent._id, originalUpdatedAt);

    await expect(
      updateAgentAvatar({
        id: agent.id,
        avatar: { filepath: 'new-path.jpg', source: 's3' },
      }),
    ).resolves.toBe(true);

    const refreshed = (await Agent.findById(agent._id).lean()) as {
      avatar?: { filepath: string; source: string };
      updatedAt?: Date;
    } | null;
    expect(refreshed?.avatar).toEqual({ filepath: 'new-path.jpg', source: 's3' });
    expect(refreshed?.updatedAt).toEqual(originalUpdatedAt);
  });
  test('skips a conditional avatar write when the stored avatar changed', async () => {
    const agent = await createAgent({
      id: `agent_${uuidv4().slice(0, 12)}`,
      name: 'Conditional avatar maintenance',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      avatar: { filepath: 'old-path.jpg', source: 's3' },
    });
    const previousAvatar = { filepath: 'old-path.jpg', source: 's3' };
    await Agent.updateOne(
      { _id: agent._id },
      { $set: { avatar: { filepath: 'owner-path.jpg', source: 's3' } } },
    );

    await expect(
      updateAgentAvatar({
        id: agent.id,
        avatar: { filepath: 'stale-path.jpg', source: 's3' },
        previousAvatar,
      }),
    ).resolves.toBe(false);

    const refreshed = await Agent.findById(agent._id).select({ avatar: 1 }).lean();
    expect(refreshed?.avatar).toEqual({ filepath: 'owner-path.jpg', source: 's3' });
  });

  test('lands a conditional avatar write when the stored avatar is unchanged', async () => {
    const agent = await createAgent({
      id: `agent_${uuidv4().slice(0, 12)}`,
      name: 'Matching conditional avatar maintenance',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      avatar: { filepath: 'old-path.jpg', source: 's3' },
    });
    const previousAvatar = { filepath: 'old-path.jpg', source: 's3' };

    await expect(
      updateAgentAvatar({
        id: agent.id,
        avatar: { filepath: 'new-path.jpg', source: 's3' },
        previousAvatar,
      }),
    ).resolves.toBe(true);

    const refreshed = await Agent.findById(agent._id).select({ avatar: 1 }).lean();
    expect(refreshed?.avatar).toEqual({ filepath: 'new-path.jpg', source: 's3' });
  });

  describe('newest / oldest', () => {
    test('newest (default) orders by createdAt desc', async () => {
      const author = new mongoose.Types.ObjectId();
      const oldest = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Oldest',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const middle = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Middle',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const newest = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Newest',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      await setCreatedAt(oldest._id, new Date('2024-01-01T00:00:00Z'));
      await setCreatedAt(middle._id, new Date('2024-06-01T00:00:00Z'));
      await setCreatedAt(newest._id, new Date('2024-12-01T00:00:00Z'));
      // Bump `updatedAt` out of creation order to prove the sort ignores it —
      // this is exactly the avatar-refresh side effect the fix guards against.
      await setUpdatedAt(oldest._id, new Date('2025-01-01T00:00:00Z'));

      const result = await getListAgentsByAccess({
        accessibleIds: [oldest._id, middle._id, newest._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'newest',
      });

      expect(result.data.map((a) => a.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    test('oldest reverses the order to createdAt asc', async () => {
      const author = new mongoose.Types.ObjectId();
      const oldest = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Oldest',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const middle = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Middle',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const newest = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Newest',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      await setCreatedAt(oldest._id, new Date('2024-01-01T00:00:00Z'));
      await setCreatedAt(middle._id, new Date('2024-06-01T00:00:00Z'));
      await setCreatedAt(newest._id, new Date('2024-12-01T00:00:00Z'));

      const result = await getListAgentsByAccess({
        accessibleIds: [oldest._id, middle._id, newest._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'oldest',
      });

      expect(result.data.map((a) => a.id)).toEqual([oldest.id, middle.id, newest.id]);
    });

    test('oldest uses descending _id ties so the existing descending index can scan backwards', async () => {
      const author = new mongoose.Types.ObjectId();
      const first = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Same Date First',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const second = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Same Date Second',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const date = new Date('2024-03-01T00:00:00Z');
      await setCreatedAt(first._id, date);
      await setCreatedAt(second._id, date);

      const result = await getListAgentsByAccess({
        accessibleIds: [first._id, second._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'oldest',
      });

      expect(result.data.map((agent) => agent.id)).toEqual([second.id, first.id]);
    });

    test('oldest paginates across multiple pages without duplicates or gaps', async () => {
      const author = new mongoose.Types.ObjectId();
      const agents = [];
      for (let i = 0; i < 5; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author,
        });
        await setCreatedAt(agent._id, new Date(2024, 0, i + 1));
        agents.push(agent);
      }
      const accessibleIds = agents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const seen: string[] = [];
      let after: string | null = null;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard < 10) {
        const page = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'oldest',
          limit: 2,
          after,
        });
        seen.push(...page.data.map((a) => a.id as string));
        hasMore = page.has_more;
        after = page.after;
        guard += 1;
      }

      expect(seen).toEqual(agents.map((a) => a.id));
      expect(new Set(seen).size).toBe(agents.length);
    });
  });

  describe('popular', () => {
    async function createUserWithFavorites(favoriteAgentIds: string[]) {
      return User.create({
        _id: new mongoose.Types.ObjectId(),
        name: `Fan ${uuidv4().slice(0, 8)}`,
        email: `fan-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: favoriteAgentIds.map((agentId) => ({ agentId })),
      });
    }

    test('orders by favorite count desc', async () => {
      const author = new mongoose.Types.ObjectId();
      const popular = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Popular Agent',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const mid = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Mid Agent',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const unfavorited = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Unfavorited Agent',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });

      await createUserWithFavorites([popular.id, mid.id]);
      await createUserWithFavorites([popular.id]);
      // unfavorited: never favorite=0

      const result = await getListAgentsByAccess({
        accessibleIds: [popular._id, mid._id, unfavorited._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'popular',
      });

      expect(result.data.map((a) => a.id)).toEqual([popular.id, mid.id, unfavorited.id]);
    });

    test('counts unique users per tenant when agent ids collide across tenants', async () => {
      const sharedId = `agent_shared_${uuidv4().slice(0, 8)}`;
      const tenantA = `tenant-a-${uuidv4().slice(0, 8)}`;
      const tenantB = `tenant-b-${uuidv4().slice(0, 8)}`;
      const agentA = await createAgent({
        id: sharedId,
        name: 'Tenant A Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        tenantId: tenantA,
      });
      const agentB = await createAgent({
        id: sharedId,
        name: 'Tenant B Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        tenantId: tenantB,
      });

      await User.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'Tenant A Fan',
        email: `tenant-a-fan-${uuidv4()}@example.com`,
        provider: 'local',
        tenantId: tenantA,
        favorites: [{ agentId: sharedId }, { agentId: sharedId }],
      });
      for (const tenantBFan of ['one', 'two']) {
        await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: `Tenant B Fan ${tenantBFan}`,
          email: `tenant-b-fan-${tenantBFan}-${uuidv4()}@example.com`,
          provider: 'local',
          tenantId: tenantB,
          favorites: [{ agentId: sharedId }],
        });
      }

      const result = await getListAgentsByAccess({
        accessibleIds: [agentA._id, agentB._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'popular',
      });

      expect(result.data.map((agent) => agent.name)).toEqual(['Tenant B Agent', 'Tenant A Agent']);
      const scoped = await tenantStorage.run({ tenantId: tenantA }, () =>
        getListAgentsByAccess({
          accessibleIds: [agentA._id, agentB._id],
          sort: 'popular',
        }),
      );
      expect(scoped.data.map((agent) => agent.name)).toEqual(['Tenant A Agent']);
    });

    test('reapplies category filtering while sorting by popularity', async () => {
      const categoryAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Category Match',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        category: 'featured',
      });
      const otherCategoryAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Other Category',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        category: 'general',
      });
      await createUserWithFavorites([otherCategoryAgent.id]);

      const result = await getListAgentsByAccess({
        accessibleIds: [categoryAgent._id, otherCategoryAgent._id] as mongoose.Types.ObjectId[],
        otherParams: { category: 'featured' },
        sort: 'popular',
      });

      expect(result.data.map((agent) => agent.id)).toEqual([categoryAgent.id]);
    });

    test('agent never favorited by anyone gets favoriteCount=0 and ties are broken by _id asc', async () => {
      const author = new mongoose.Types.ObjectId();
      const first = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Never Favorited First',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const second = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Never Favorited Second',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      // Bump `updatedAt` out of `_id` order to prove the tie-break ignores it —
      // `updatedAt` moves on side effects unrelated to favorite count (e.g. an
      // avatar refresh), so it must not influence pagination stability here.
      await setUpdatedAt(second._id, new Date('2025-01-01T00:00:00Z'));

      const result = await getListAgentsByAccess({
        accessibleIds: [first._id, second._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'popular',
      });

      expect(result.data).toHaveLength(2);
      // Both have favoriteCount=0, so the _id-asc tie-break applies (creation order).
      expect(result.data.map((a) => a.id)).toEqual([first.id, second.id]);
    });

    test('paginates across multiple pages without duplicates or gaps', async () => {
      const author = new mongoose.Types.ObjectId();
      const agents = [];
      for (let i = 0; i < 5; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author,
        });
        await setUpdatedAt(agent._id, new Date(2024, 0, i + 1));
        agents.push(agent);
      }
      // Give each agent a distinct number of favorites (0..4) so the order is deterministic.
      for (let i = 0; i < agents.length; i++) {
        for (let f = 0; f < i; f++) {
          await createUserWithFavorites([agents[i].id]);
        }
      }
      const accessibleIds = agents.map((a) => a._id) as mongoose.Types.ObjectId[];
      const expectedOrder = [...agents].reverse().map((a) => a.id); // highest favoriteCount first

      const seen: string[] = [];
      let after: string | null = null;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard < 10) {
        const page = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'popular',
          limit: 2,
          after,
        });
        seen.push(...page.data.map((a) => a.id as string));
        hasMore = page.has_more;
        after = page.after;
        guard += 1;
      }

      expect(seen).toEqual(expectedOrder);
      expect(new Set(seen).size).toBe(agents.length);
    });

    test('compares hexadecimal cursor ids independently of case', async () => {
      const author = new mongoose.Types.ObjectId();
      const agents = await Promise.all(
        ['First', 'Second'].map((name) =>
          createAgent({
            _id: new mongoose.Types.ObjectId(),
            id: `agent_${uuidv4().slice(0, 12)}`,
            name,
            author,
            provider: 'openai',
            model: 'gpt-4',
          }),
        ),
      );
      const accessibleIds = agents.map((agent) => agent._id);
      const firstPage = await getListAgentsByAccess({
        accessibleIds,
        sort: 'popular',
        limit: 1,
      });
      const cursor = JSON.parse(Buffer.from(firstPage.after as string, 'base64').toString());
      const after = Buffer.from(
        JSON.stringify({ ...cursor, secondary: cursor.secondary.toUpperCase() }),
      ).toString('base64');
      const secondPage = await getListAgentsByAccess({
        accessibleIds,
        sort: 'popular',
        limit: 1,
        after,
      });
      expect([...firstPage.data, ...secondPage.data].map((agent) => agent.name)).toEqual([
        'First',
        'Second',
      ]);
    });
  });

  describe('author', () => {
    test('orders by support_contact.name ascending, falling back to support_contact.email then a constant when both are absent', async () => {
      const agentAlice = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Alice',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Alice', email: '' },
      });
      const agentBob = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Bob',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: '', email: 'bob@example.com' },
      });
      const agentOrphan = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Orphan',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(), // no support_contact at all
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [agentAlice._id, agentBob._id, agentOrphan._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
      });

      // 'Alice' < 'bob@example.com' < the U+10FFFF sentinel (no support_contact at all).
      expect(result.data.map((a) => a.id)).toEqual([agentAlice.id, agentBob.id, agentOrphan.id]);
      expect(result.data).toHaveLength(3);
    });
    test('tolerates non-string support contact values while sorting and paging', async () => {
      const owner = await User.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'Alpha Owner',
        email: `alpha-owner-${uuidv4()}@example.com`,
        provider: 'local',
      });
      const malformed = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Malformed Contact',
        provider: 'openai',
        model: 'gpt-4',
        author: owner._id,
        support_contact: { name: 42, email: { imported: true } },
      });
      const supported = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Supported Contact',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Zulu Support', email: '' },
      });

      const page1 = await getListAgentsByAccess({
        accessibleIds: [malformed._id, supported._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
        limit: 1,
      });
      const page2 = await getListAgentsByAccess({
        accessibleIds: [malformed._id, supported._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
        limit: 1,
        after: page1.after,
      });

      expect(page1.data.map((agent) => agent.id)).toEqual([malformed.id]);
      expect(page2.data.map((agent) => agent.id)).toEqual([supported.id]);
    });

    test('does not resolve an owner user from another tenant during author sorting', async () => {
      const tenantA = `tenant-a-${uuidv4().slice(0, 8)}`;
      const tenantB = `tenant-b-${uuidv4().slice(0, 8)}`;
      const crossTenantOwnerId = new mongoose.Types.ObjectId();
      const crossTenantOwner = await tenantStorage.run({ tenantId: tenantB }, () =>
        User.create({
          _id: crossTenantOwnerId,
          name: 'Aaa Cross Tenant Owner',
          email: `cross-tenant-${uuidv4()}@example.com`,
          provider: 'local',
        }),
      );
      const agent = await tenantStorage.run({ tenantId: tenantA }, () =>
        createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Cross Tenant Owner Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: crossTenantOwner._id,
        }),
      );
      await tenantStorage.run({ tenantId: tenantA }, () =>
        AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: crossTenantOwner._id,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits:
            PermissionBits.VIEW |
            PermissionBits.EDIT |
            PermissionBits.DELETE |
            PermissionBits.SHARE,
          grantedBy: crossTenantOwner._id,
        }),
      );
      const anchor = await tenantStorage.run({ tenantId: tenantA }, () =>
        createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Tenant Anchor Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Mmm Tenant Anchor', email: '' },
        }),
      );

      const result = await tenantStorage.run({ tenantId: tenantA }, () =>
        getListAgentsByAccess({
          accessibleIds: [agent._id, anchor._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        }),
      );

      expect(result.data.map((row) => row.id)).toEqual([anchor.id, agent.id]);
      expect(result.data[1]).not.toHaveProperty('owner_contact');
    });

    test('trims support contact values before author sorting', async () => {
      const padded = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Padded Contact',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: '  Zulu  ', email: '' },
      });
      const beta = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Beta Contact',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Beta', email: '' },
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [beta._id, padded._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
      });

      expect(result.data.map((a) => a.id)).toEqual([beta.id, padded.id]);
    });

    test('ties on the same support_contact.name are broken by _id asc, stable across pagination', async () => {
      const agentOne = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent One',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Shared Name', email: '' },
      });
      const agentTwo = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Two',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Shared Name', email: '' },
      });

      const expectedOrder = [agentOne, agentTwo]
        .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
        .map((a) => a.id);

      const page1 = await getListAgentsByAccess({
        accessibleIds: [agentOne._id, agentTwo._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
        limit: 1,
      });
      expect(page1.data.map((a) => a.id)).toEqual([expectedOrder[0]]);
      expect(page1.has_more).toBe(true);

      const page2 = await getListAgentsByAccess({
        accessibleIds: [agentOne._id, agentTwo._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        sort: 'author',
        limit: 1,
        after: page1.after,
      });
      expect(page2.data.map((a) => a.id)).toEqual([expectedOrder[1]]);
      expect(page2.has_more).toBe(false);
    });

    test('normalizes creator names for sorting and cursor pagination', async () => {
      const names = ['alice', 'Zoe', 'mike'];
      const users = await Promise.all(
        names.map((name) =>
          User.create({
            _id: new mongoose.Types.ObjectId(),
            name,
            email: `${name}-${uuidv4()}@example.com`,
            provider: 'local',
          }),
        ),
      );
      const agents = await Promise.all(
        users.map((user, index) =>
          createAgent({
            id: `agent_${uuidv4().slice(0, 12)}`,
            name: `Agent ${index}`,
            provider: 'openai',
            model: 'gpt-4',
            author: user._id,
          }),
        ),
      );
      const accessibleIds = agents.map((agent) => agent._id) as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 2,
      });
      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 2,
        after: page1.after,
      });

      expect(page1.data.map((agent) => agent.author)).toEqual([
        users[0]._id.toString(),
        users[2]._id.toString(),
      ]);
      expect(page2.data.map((agent) => agent.author)).toEqual([users[1]._id.toString()]);
      expect(new Set([...page1.data, ...page2.data].map((agent) => agent.id)).size).toBe(3);
      const cursor = JSON.parse(Buffer.from(page1.after as string, 'base64').toString('utf8'));
      /* A pre-versioning reader reads `primary`/`secondary` and ignores fields it does not
         know, so a bumped ordering has to keep its boundary somewhere that reader cannot
         find — otherwise it resumes the walk under the comparison this version replaced. */
      expect(cursor).toMatchObject({
        sort: 'author',
        version: 2,
        boundary: { primary: 'mike' },
      });
      expect(cursor.primary).toBeUndefined();
      expect(cursor.secondary).toBeUndefined();
      expect(cursor.updatedAt).toBeUndefined();
    });

    test('resumes from the comparison key the database computed for a non-ASCII name', async () => {
      /* `$toLower` is only defined over ASCII: it leaves `É` (U+00C9) and `Ü` (U+00DC)
         as they are, so those stay uppercase in the key `$sort` compares. Lowercasing
         the boundary again in JavaScript moved it from `Émile` to `émile` (U+00E9),
         past every key in between, and the next page's `$match` skipped `Üwe`. */
      const emile = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Emile',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Émile', email: '' },
      });
      const uwe = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Agent Uwe',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        support_contact: { name: 'Üwe', email: '' },
      });
      const accessibleIds = [emile._id, uwe._id] as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 1,
      });
      expect(page1.data.map((a) => a.id)).toEqual([emile.id]);
      expect(page1.has_more).toBe(true);

      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 1,
        after: page1.after,
      });
      expect(page2.data.map((a) => a.id)).toEqual([uwe.id]);

      const cursor = JSON.parse(Buffer.from(page1.after as string, 'base64').toString('utf8'));
      expect(cursor.boundary.primary).toBe('Émile');
    });

    test('paginates across multiple pages without duplicates or gaps', async () => {
      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
      const agents = [];
      for (const name of names) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Agent ${name}`,
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name, email: '' },
        });
        agents.push(agent);
      }
      const accessibleIds = agents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const seen: string[] = [];
      let after: string | null = null;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard < 10) {
        const page = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'author',
          limit: 2,
          after,
        });
        seen.push(...page.data.map((a) => a.id as string));
        hasMore = page.has_more;
        after = page.after;
        guard += 1;
      }

      expect(seen).toEqual(agents.map((a) => a.id)); // already alphabetical: Alpha..Echo
      expect(new Set(seen).size).toBe(agents.length);
    });

    describe('owner fallback (matches attachOwnerContacts, packages/api/src/agents/contact.ts)', () => {
      const OWNER_ACL_BITS =
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

      test('sorts by the ACL-granted owner name, not the account behind `author`, when they differ', async () => {
        // The creator's own account name sorts last ('Zzz...') if the code wrongly used
        // `author` instead of the ACL-resolved owner; the real ACL owner's name sorts
        // first ('Aaa...') if it correctly does. `agentAnchor`'s support_contact fixes a
        // stable middle point so the two orderings are distinguishable from one agent alone.
        const authorAccount = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Zzz Author Account',
          email: `zzz-author-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const aclOwner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Aaa Acl Owner',
          email: `aaa-owner-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentTransferred = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Transferred Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: authorAccount._id,
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: aclOwner._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentTransferred._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: authorAccount._id,
        });
        const agentAnchor = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Anchor Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Mmm Middle', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentTransferred._id, agentAnchor._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        // 'Aaa Acl Owner' < 'Mmm Middle': correct only if the ACL owner's name was used.
        expect(result.data.map((a) => a.id)).toEqual([agentTransferred.id, agentAnchor.id]);
      });

      test('sorts by the ACL owner name ahead of an agent whose owner ACL entry resolves to a lexicographically later name', async () => {
        const ownerEarly = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Aaron Owner',
          email: `aaron-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const ownerLate = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Zoe Owner',
          email: `zoe-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentEarly = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Agent Early Owner',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
        });
        const agentLate = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Agent Late Owner',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: ownerEarly._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentEarly._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: ownerEarly._id,
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: ownerLate._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentLate._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: ownerLate._id,
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentEarly._id, agentLate._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        expect(result.data.map((a) => a.id)).toEqual([agentEarly.id, agentLate.id]);
      });

      test("falls back to `author`'s own account name when no OWNER ACL entry exists", async () => {
        const author = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Mmm Plain Creator',
          email: `plain-creator-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'No ACL Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: author._id,
        });
        const anchor = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Support Anchor',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Zzz Support Anchor', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agent._id, anchor._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        expect(result.data.map((a) => a.id)).toEqual([agent.id, anchor.id]);
      });

      test('rejects email-shaped account names and private email as author-sort fallbacks', async () => {
        const owner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'owner@example.com',
          username: 'also@example.com',
          email: `0-owner-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const emailNamedOwnerAgent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Email Named Owner Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: owner._id,
          resourceType: ResourceType.AGENT,
          resourceId: emailNamedOwnerAgent._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: owner._id,
        });
        const realNameAgent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Real Name Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'zzzz real name', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [emailNamedOwnerAgent._id, realNameAgent._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        // Email-shaped account values and the account email must never become the fallback.
        expect(result.data.map((a) => a.id)).toEqual([realNameAgent.id, emailNamedOwnerAgent.id]);
      });

      test('hands the joined owner contact to the caller instead of leaving it to be looked up again', async () => {
        const owner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Ada Owner',
          email: `ada-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentOwned = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Owned Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: owner._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentOwned._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: owner._id,
        });
        const agentSupported = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Supported Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Support Desk', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentOwned._id, agentSupported._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        const rowsById = new Map(result.data.map((row) => [row.id as string, row]));
        expect(rowsById.get(agentOwned.id)?.owner_contact).toEqual({ name: 'Ada Owner' });
        // The support contact is what a viewer sees instead, so there is no owner contact.
        expect(rowsById.get(agentSupported.id)).not.toHaveProperty('owner_contact');
        // Both rows report the contact as resolved, so the page is not looked up twice.
        for (const row of result.data) {
          expect(row[AGENT_OWNER_CONTACT_RESOLVED_FIELD]).toBe(true);
        }
      });

      test('ignores a stale REMOTE_AGENT owner entry left on the same agent id', async () => {
        // Ownership transfer revokes the AGENT entry and grants a new one, but the
        // separately stored REMOTE_AGENT entry for the previous owner can survive and is
        // the older of the two. `attachOwnerContacts` only counts AGENT entries, so the
        // author sort must ignore it or the row disagrees with the same agent's card.
        const formerOwner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Aaa Former Owner',
          email: `former-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const currentOwner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Nnn Current Owner',
          email: `current-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentTransferred = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Remote Transferred Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: formerOwner._id,
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId: agentTransferred._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: formerOwner._id,
          grantedAt: new Date('2020-01-01T00:00:00.000Z'),
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: currentOwner._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentTransferred._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: currentOwner._id,
          grantedAt: new Date('2024-01-01T00:00:00.000Z'),
        });
        const anchor = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Remote Anchor Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Mmm Middle Anchor', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentTransferred._id, anchor._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        const rowsById = new Map(result.data.map((row) => [row.id as string, row]));
        expect(rowsById.get(agentTransferred.id)?.owner_contact).toEqual({
          name: 'Nnn Current Owner',
        });
        // 'Mmm Middle Anchor' < 'Nnn Current Owner' < 'Aaa Former Owner' would invert the
        // order if the revoked remote entry still decided the sort key.
        expect(result.data.map((row) => row.id)).toEqual([anchor.id, agentTransferred.id]);
      });

      test('breaks a grantedAt tie the way the resolver does when an entry omits it', async () => {
        // getFirstOwnerIdsByResource sorts { grantedAt: 1, createdAt: 1, _id: 1 }, where a
        // missing field reads as null. A missing field path in a comparison expression is
        // undefined instead, which BSON orders below null, so an imported entry that omits
        // grantedAt would win the first comparison outright and name a different owner here
        // than every other list order names.
        const nullGranted = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Aaa Null Granted',
          email: `null-granted-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const missingGranted = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Zzz Missing Granted',
          email: `missing-granted-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentImported = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Imported Acl Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: nullGranted._id,
        });
        // Created first, so it also wins the createdAt and _id tie-breaks the resolver falls
        // through to once the grantedAt comparison is a genuine tie.
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: nullGranted._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentImported._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: nullGranted._id,
          grantedAt: null,
        });
        const imported = await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: missingGranted._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentImported._id,
          permBits: OWNER_ACL_BITS,
          grantedBy: missingGranted._id,
        });
        await AclEntry.collection.updateOne({ _id: imported._id }, { $unset: { grantedAt: '' } });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentImported._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        expect(result.data[0]?.owner_contact).toEqual({ name: 'Aaa Null Granted' });
      });

      test('reads an owner whose entry also carries the insights bit', async () => {
        // Granting Agent Insights ORs VIEW_INSIGHTS into the owner's role bits, so an
        // owner entry is not always exactly the owner mask. Missing it would fall back to
        // `author`, which on a transferred agent still names the original creator.
        const currentOwner = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Aaa Insights Owner',
          email: `insights-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const originalCreator = await User.create({
          _id: new mongoose.Types.ObjectId(),
          name: 'Zzz Original Creator',
          email: `creator-${uuidv4()}@example.com`,
          provider: 'local',
        });
        const agentTransferred = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Insights Transferred Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: originalCreator._id,
        });
        await AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: currentOwner._id,
          resourceType: ResourceType.AGENT,
          resourceId: agentTransferred._id,
          permBits: OWNER_ACL_BITS | PermissionBits.VIEW_INSIGHTS,
          grantedBy: currentOwner._id,
        });
        const anchor = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Insights Anchor Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(),
          support_contact: { name: 'Mmm Middle Anchor', email: '' },
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentTransferred._id, anchor._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        const rowsById = new Map(result.data.map((row) => [row.id as string, row]));
        expect(rowsById.get(agentTransferred.id)?.owner_contact).toEqual({
          name: 'Aaa Insights Owner',
        });
        // 'Aaa Insights Owner' < 'Mmm Middle Anchor' < 'Zzz Original Creator': falling back
        // to `author` would put the transferred agent last instead of first.
        expect(result.data.map((row) => row.id)).toEqual([agentTransferred.id, anchor.id]);
      });

      test('reports no owner contact when the owner account is gone, even with a denormalized authorName', async () => {
        const missingOwner = new mongoose.Types.ObjectId();
        const agentOrphaned = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: 'Orphaned Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: missingOwner,
          authorName: 'Denormalized Author',
        });

        const result = await getListAgentsByAccess({
          accessibleIds: [agentOrphaned._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort: 'author',
        });

        // `resolveAgentOwnerContact` returns nothing without an owner account, so a
        // stored `authorName` must not become a contact here either.
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).not.toHaveProperty('owner_contact');
      });
    });
  });

  describe('mine + popular/author (author string -> ObjectId cast)', () => {
    test('mine + popular does not silently return empty when otherParams.author is a string (mimics controller req.user.id)', async () => {
      const authorObjectId = new mongoose.Types.ObjectId();
      const agent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Mine Popular Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorObjectId,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [agent._id] as mongoose.Types.ObjectId[],
        // The controller sets `filter.author = req.user.id`, which is a string, not an ObjectId.
        otherParams: { author: authorObjectId.toString() },
        sort: 'popular',
      });

      expect(result.data).toHaveLength(1);

      expect(result.data[0].id).toBe(agent.id);
    });

    test('mine + author sort does not silently return empty when otherParams.author is a string', async () => {
      const authorObjectId = new mongoose.Types.ObjectId();
      const agent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Mine Author-Sort Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorObjectId,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [agent._id] as mongoose.Types.ObjectId[],
        otherParams: { author: authorObjectId.toString() },
        sort: 'author',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(agent.id);
    });

    test('mine filter combined with a sort mode still excludes agents authored by someone else', async () => {
      const mineAuthor = new mongoose.Types.ObjectId();
      const otherAuthor = new mongoose.Types.ObjectId();
      const mineAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Mine Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: mineAuthor,
      });
      const otherAgent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Other Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: otherAuthor,
      });

      const result = await getListAgentsByAccess({
        accessibleIds: [mineAgent._id, otherAgent._id] as mongoose.Types.ObjectId[],
        otherParams: { author: mineAuthor.toString() },
        sort: 'popular',
      });

      expect(result.data.map((a) => a.id)).toEqual([mineAgent.id]);
    });
  });

  /**
   * `GET /api/agents` is not only the marketplace: the agent selector, the mention menu
   * and the schedule pickers ask for no mode and have always been answered most recently
   * edited first. A request that names no mode must not drift into creation order.
   */
  describe('no requested sort mode', () => {
    /** Creation order and edit order are deliberately opposed, so the two cannot pass for each other. */
    async function seedOpposedOrders() {
      const author = new mongoose.Types.ObjectId();
      const createdFirst = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Created first, edited last',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const createdLast = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Created last, edited first',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      await setCreatedAt(createdFirst._id, new Date('2024-01-01T00:00:00Z'));
      await setCreatedAt(createdLast._id, new Date('2024-06-01T00:00:00Z'));
      await setUpdatedAt(createdFirst._id, new Date('2025-06-01T00:00:00Z'));
      await setUpdatedAt(createdLast._id, new Date('2025-01-01T00:00:00Z'));
      return { createdFirst, createdLast };
    }

    test('answers a sortless request most recently edited first', async () => {
      const { createdFirst, createdLast } = await seedOpposedOrders();

      const result = await getListAgentsByAccess({
        accessibleIds: [createdFirst._id, createdLast._id] as mongoose.Types.ObjectId[],
        otherParams: {},
      });

      expect(result.data.map((a) => a.id)).toEqual([createdFirst.id, createdLast.id]);
    });

    test('an unrecognized sort string falls back to that same order, not to newest', async () => {
      const { createdFirst, createdLast } = await seedOpposedOrders();

      const result = await getListAgentsByAccess({
        accessibleIds: [createdFirst._id, createdLast._id] as mongoose.Types.ObjectId[],
        otherParams: {},
        // @ts-expect-error intentionally invalid at the type level to exercise the runtime fallback
        sort: 'not-a-real-sort-mode',
      });

      expect(result.data.map((a) => a.id)).toEqual([createdFirst.id, createdLast.id]);
    });

    test('pages a sortless request without duplicating or skipping a row', async () => {
      const { createdFirst, createdLast } = await seedOpposedOrders();
      const accessibleIds = [createdFirst._id, createdLast._id] as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({ accessibleIds, otherParams: {}, limit: 1 });
      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        limit: 1,
        after: page1.after,
      });

      expect([...page1.data, ...page2.data].map((a) => a.id)).toEqual([
        createdFirst.id,
        createdLast.id,
      ]);
      expect(page2.has_more).toBe(false);
    });
  });

  /**
   * Legacy rows can have missing or explicit null `createdAt` values. Both
   * occupy the null sort tier and must remain reachable across cursor pages.
   */
  describe('cursor pagination over agents with null or missing createdAt', () => {
    /** Removes `createdAt` entirely, as a raw-driver insert would leave it. */
    async function unsetCreatedAt(agentId: mongoose.Types.ObjectId) {
      await Agent.collection.updateOne({ _id: agentId }, { $unset: { createdAt: '' } });
    }
    /** Writes an explicit null, which sorts with missing `createdAt`. */
    async function nullCreatedAt(agentId: mongoose.Types.ObjectId) {
      await Agent.collection.updateOne({ _id: agentId }, { $set: { createdAt: null } });
    }

    async function seedMixedCreatedAt() {
      const author = new mongoose.Types.ObjectId();
      const dated = [];
      for (let i = 0; i < 3; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Dated ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author,
        });
        await setCreatedAt(agent._id, new Date(2024, 0, i + 1));
        dated.push(agent);
      }

      const undated = [];
      for (let i = 0; i < 2; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Undated ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author,
        });
        await (i === 0 ? nullCreatedAt(agent._id) : unsetCreatedAt(agent._id));
        undated.push(agent);
      }

      return { dated, undated };
    }

    /** Walks every page of a sort mode and returns the ids in the order they arrived. */
    async function walkAllPages(
      accessibleIds: mongoose.Types.ObjectId[],
      sort: 'newest' | 'oldest',
      limit: number,
    ) {
      const seen: string[] = [];
      let after: string | null = null;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard < 10) {
        const page = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort,
          limit,
          after,
        });
        seen.push(...page.data.map((a) => a.id as string));
        hasMore = page.has_more;
        after = page.after;
        guard += 1;
      }
      return seen;
    }

    test('oldest reaches every agent exactly once, undated ones first', async () => {
      const { dated, undated } = await seedMixedCreatedAt();
      const accessibleIds = [...dated, ...undated].map((a) => a._id) as mongoose.Types.ObjectId[];

      const seen = await walkAllPages(accessibleIds, 'oldest', 2);

      expect(new Set(seen).size).toBe(5);
      expect(seen).toHaveLength(5);
      const expectedNullOrder = [...undated]
        .sort((a, b) => b._id.toString().localeCompare(a._id.toString()))
        .map((a) => a.id);
      expect(seen.slice(0, 2)).toEqual(expectedNullOrder);
      expect(seen.slice(2)).toEqual(dated.map((a) => a.id));
    });

    test('newest reaches every agent exactly once, undated ones last', async () => {
      const { dated, undated } = await seedMixedCreatedAt();
      const accessibleIds = [...dated, ...undated].map((a) => a._id) as mongoose.Types.ObjectId[];

      const seen = await walkAllPages(accessibleIds, 'newest', 2);

      expect(new Set(seen).size).toBe(5);
      expect(seen).toHaveLength(5);
      expect(seen.slice(0, 3)).toEqual([...dated].reverse().map((a) => a.id));
      const expectedNullOrder = [...undated]
        .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
        .map((a) => a.id);
      expect(seen.slice(3)).toEqual(expectedNullOrder);
    });

    test('newest crosses from the last dated row into the undated group', async () => {
      // Page size chosen so page one ends exactly on the last agent that HAS a date:
      // the cursor then carries a real date, and a plain `$lt` would match nothing.
      const { dated, undated } = await seedMixedCreatedAt();
      const accessibleIds = [...dated, ...undated].map((a) => a._id) as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'newest',
        limit: dated.length,
      });
      expect(page1.has_more).toBe(true);

      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'newest',
        limit: dated.length,
        after: page1.after,
      });

      expect(new Set(page2.data.map((a) => a.id))).toEqual(new Set(undated.map((a) => a.id)));
    });

    test('encodes a usable cursor when the last row of a page has no createdAt', async () => {
      const { undated } = await seedMixedCreatedAt();
      const accessibleIds = undated.map((a) => a._id) as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'oldest',
        limit: 1,
      });

      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'oldest',
        limit: 1,
        after: page1.after,
      });

      expect(page2.data.map((a) => a.id)).toEqual([
        undated.map((a) => a.id).find((id) => id !== page1.data[0].id),
      ]);
    });
  });

  describe('cursor validation', () => {
    async function seedTwoAgents() {
      const author = new mongoose.Types.ObjectId();
      const older = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Older',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      const newer = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Newer',
        provider: 'openai',
        model: 'gpt-4',
        author,
      });
      await setCreatedAt(older._id, new Date('2024-01-01T00:00:00Z'));
      await setCreatedAt(newer._id, new Date('2024-06-01T00:00:00Z'));
      return { older, newer, accessibleIds: [older._id, newer._id] as mongoose.Types.ObjectId[] };
    }

    const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64');

    const validObjectId = () => new mongoose.Types.ObjectId().toString();

    test.each([
      [
        'a null primary',
        () => encode({ sort: 'newest', primary: null, secondary: validObjectId() }),
      ],
      [
        'an unparseable date primary',
        () => encode({ sort: 'newest', primary: 'not-a-date', secondary: validObjectId() }),
      ],
      [
        'a secondary that is not an ObjectId',
        () => encode({ sort: 'newest', primary: '2024-01-01', secondary: 'nope' }),
      ],
      [
        'a pre-sort-modes cursor with no ordering identity',
        () => encode({ createdAt: '2024-01-01', _id: validObjectId() }),
      ],
      ['a payload that is not base64 JSON', () => 'definitely-not-a-cursor'],
    ])('rejects an unreadable cursor for %s', async (_label, buildCursor) => {
      const { accessibleIds } = await seedTwoAgents();

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'newest',
          after: buildCursor(),
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });
    });

    test('rejects a cursor from another sort mode instead of restarting from page one', async () => {
      const { accessibleIds } = await seedTwoAgents();
      const newestPage = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'newest',
        limit: 1,
      });

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'oldest',
          after: newestPage.after,
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'ordering-mismatch' });
    });
    test('rejects an author cursor from version 1 and accepts the current version 2 cursor', async () => {
      const { accessibleIds } = await seedTwoAgents();
      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 1,
      });
      const cursor = JSON.parse(
        Buffer.from(page1.after as string, 'base64').toString('utf8'),
      ) as Record<string, unknown>;

      expect(cursor).toMatchObject({ sort: 'author', version: 2 });
      const version1Cursor = { ...cursor, version: 1 };
      const versionlessCursor = { ...cursor };
      delete versionlessCursor.version;
      for (const incompatibleCursor of [version1Cursor, versionlessCursor]) {
        await expect(
          getListAgentsByAccess({
            accessibleIds,
            otherParams: {},
            sort: 'author',
            limit: 1,
            after: encode(incompatibleCursor),
          }),
        ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'ordering-mismatch' });
      }

      /* A boundary sitting where a pre-versioning reader looks for it did not come from this
         encoder, so it is not trusted even when it names the right version. */
      const flattenedCursor = {
        sort: cursor.sort,
        version: cursor.version,
        ...(cursor.boundary as Record<string, unknown>),
      };

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'author',
          limit: 1,
          after: encode(flattenedCursor),
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });

      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'author',
        limit: 1,
        after: page1.after,
      });
      expect(page2.data).toHaveLength(1);
    });

    test('rejects a legacy cursor for a sorted request instead of restarting from page one', async () => {
      const { accessibleIds } = await seedTwoAgents();
      const legacyCursor = encode({
        updatedAt: new Date('2025-06-01T00:00:00Z').toISOString(),
        _id: validObjectId(),
      });

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'newest',
          after: legacyCursor,
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'ordering-mismatch' });
    });

    test('rejects a non-numeric primary in a numeric sort mode', async () => {
      const { accessibleIds } = await seedTwoAgents();

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'popular',
          after: encode({ sort: 'popular', primary: 'not-a-number', secondary: validObjectId() }),
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });
    });
    test('rejects negative, fractional, and NaN-shaped favorite counts in popular cursors', async () => {
      const { accessibleIds } = await seedTwoAgents();

      for (const primary of ['-1', '1.5', 'NaN']) {
        await expect(
          getListAgentsByAccess({
            accessibleIds,
            otherParams: {},
            sort: 'popular',
            after: encode({ sort: 'popular', primary, secondary: validObjectId() }),
          }),
        ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });
      }
    });

    test('accepts zero and positive integer favorite counts in popular cursors', async () => {
      const { accessibleIds } = await seedTwoAgents();

      for (const primary of ['0', '2']) {
        const result = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort: 'popular',
          after: encode({ sort: 'popular', primary, secondary: validObjectId() }),
        });

        expect(result).toHaveProperty('data');
      }
    });

    test('rejects an author boundary whose primary is not a string', async () => {
      const { accessibleIds } = await seedTwoAgents();

      /* Coerced, these become the ordinary author keys `'undefined'`, `'null'` and
         `'[object Object]'`, and the walk would resume partway through the alphabet
         instead of answering that it cannot honour the cursor. */
      for (const primary of [undefined, null, 42, { key: 'mike' }]) {
        await expect(
          getListAgentsByAccess({
            accessibleIds,
            otherParams: {},
            sort: 'author',
            limit: 1,
            after: encode({
              sort: 'author',
              version: 2,
              boundary: { primary, secondary: validObjectId() },
            }),
          }),
        ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'unreadable' });
      }
    });

    test('accepts the empty primary reserved for the missing-createdAt tier', async () => {
      const { accessibleIds } = await seedTwoAgents();

      const result = await getListAgentsByAccess({
        accessibleIds,
        sort: 'newest',
        after: encode({ sort: 'newest', primary: '', secondary: validObjectId() }),
      });

      // Both agents have a real date, so the "still inside the undated group" branch
      // legitimately matches nothing - the point is that it is not rejected as garbage.

      expect(result.data).toHaveLength(0);
    });

    test('accepts a legacy cursor for recent and rejects it for non-recent modes', async () => {
      const { older, newer, accessibleIds } = await seedTwoAgents();
      const newerUpdatedAt = new Date('2025-06-01T00:00:00Z');
      await setUpdatedAt(older._id, new Date('2025-01-01T00:00:00Z'));
      await setUpdatedAt(newer._id, newerUpdatedAt);
      const legacyCursor = encode({
        updatedAt: newerUpdatedAt.toISOString(),
        _id: newer._id.toString(),
      });

      const recent = await getListAgentsByAccess({
        accessibleIds,
        sort: 'recent',
        limit: null,
        after: legacyCursor,
      });
      expect(recent.data.map((agent) => agent.id)).toEqual([older.id]);

      await expect(
        getListAgentsByAccess({
          accessibleIds,
          sort: 'newest',
          limit: null,
          after: legacyCursor,
        }),
      ).rejects.toMatchObject({ name: 'AgentSortCursorError', failure: 'ordering-mismatch' });
    });

    /**
     * A rolling deployment can send the next page to an instance that predates sort
     * modes. The legacy `updatedAt`/`_id` pair is safe only when the current mode is
     * `recent`, because that is the only mode with the old instance's ordering.
     */
    test.each(['recent', 'newest', 'oldest', 'popular', 'author'] as const)(
      'emits a cursor shape compatible with the ordering it describes (%s)',
      async (sort) => {
        const { accessibleIds } = await seedTwoAgents();

        const result = await getListAgentsByAccess({
          accessibleIds,
          otherParams: {},
          sort,
          limit: 1,
        });

        expect(result.has_more).toBe(true);
        const cursor = JSON.parse(
          Buffer.from(result.after as string, 'base64').toString('utf8'),
        ) as Record<string, unknown>;

        expect(cursor.sort).toBe(sort);
        expect(cursor.version).toBe(sort === 'author' ? 2 : 1);
        if (sort === 'author') {
          /* Past version 1 the boundary is nested, out of reach of a reader that predates
             versioning and would otherwise resume under the comparison this version replaced. */
          const boundary = cursor.boundary as Record<string, unknown>;
          expect(typeof boundary.primary).toBe('string');
          expect(typeof boundary.secondary).toBe('string');
          expect(cursor).not.toHaveProperty('primary');
          expect(cursor).not.toHaveProperty('secondary');
        } else {
          expect(typeof cursor.primary).toBe('string');
          expect(typeof cursor.secondary).toBe('string');
          const versionlessCursor = { ...cursor };
          delete versionlessCursor.version;
          const nextPage = await getListAgentsByAccess({
            accessibleIds,
            otherParams: {},
            sort,
            limit: 1,
            after: encode(versionlessCursor),
          });
          expect(nextPage.data).toHaveLength(1);
        }

        if (sort === 'recent') {
          expect(Number.isNaN(new Date(cursor.updatedAt as string).getTime())).toBe(false);
          expect(mongoose.Types.ObjectId.isValid(cursor._id as string)).toBe(true);
          expect(cursor._id).toBe(cursor.secondary);
        } else {
          // An older instance must reject a non-recent cursor rather than silently
          // continue its updated-time walk from a boundary in another ordering.
          expect(cursor).not.toHaveProperty('updatedAt');
          expect(cursor).not.toHaveProperty('_id');
        }
      },
    );
  });

  describe('response contract', () => {
    test('never returns the internal sort keys, whichever mode is used', async () => {
      const user = await User.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'Author',
        email: `author-${uuidv4()}@example.com`,
        provider: 'local',
      });
      const agent = await createAgent({
        id: `agent_${uuidv4().slice(0, 12)}`,
        name: 'Contract Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: user._id,
      });
      await User.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'Fan',
        email: `fan-${uuidv4()}@example.com`,
        provider: 'local',
        favorites: [{ agentId: agent.id }],
      });

      const keySets: string[][] = [];
      for (const sort of ['newest', 'oldest', 'popular', 'author'] as const) {
        const result = await getListAgentsByAccess({
          accessibleIds: [agent._id] as mongoose.Types.ObjectId[],
          otherParams: {},
          sort,
        });

        expect(result.data).toHaveLength(1);
        expect(result.data[0]).not.toHaveProperty('createdAt');
        expect(result.data[0]).not.toHaveProperty('favoriteCount');
        expect(result.data[0]).not.toHaveProperty('authorDisplayName');
        expect(result.data[0]).not.toHaveProperty('authorSortKey');
        /* The author sort hands over the owner contact it had to join anyway, and
           `attachOwnerContacts` (`api/server/services/Agents/ownerContact.js`) either
           strips that marker or resolves the same contact itself, so a client receives
           the same keys either way. Excluded here so the projection still has to match
           across modes. */
        keySets.push(
          Object.keys(result.data[0])
            .filter((key) => key !== 'owner_contact' && key !== AGENT_OWNER_CONTACT_RESOLVED_FIELD)
            .sort(),
        );
      }

      // `?sort=` must not change the projection a client receives.
      keySets.forEach((keys) => expect(keys).toEqual(keySets[0]));
    });

    test('still emits a working cursor even though the sort key is stripped from the rows', async () => {
      const author = new mongoose.Types.ObjectId();
      const agents = [];
      for (let i = 0; i < 3; i++) {
        const agent = await createAgent({
          id: `agent_${uuidv4().slice(0, 12)}`,
          name: `Agent ${i}`,
          provider: 'openai',
          model: 'gpt-4',
          author,
        });
        await setCreatedAt(agent._id, new Date(2024, 0, i + 1));
        agents.push(agent);
      }
      const accessibleIds = agents.map((a) => a._id) as mongoose.Types.ObjectId[];

      const page1 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'newest',
        limit: 2,
      });
      const page2 = await getListAgentsByAccess({
        accessibleIds,
        otherParams: {},
        sort: 'newest',
        limit: 2,
        after: page1.after,
      });

      // A cursor built after the strip would carry an empty primary and restart the walk.
      expect(page1.data.map((a) => a.id)).toEqual([agents[2].id, agents[1].id]);
      expect(page2.data.map((a) => a.id)).toEqual([agents[0].id]);
    });
  });
});

describe('getAgentManagementListByAccess', () => {
  beforeEach(async () => {
    await Agent.deleteMany({});
  });

  it('returns full configuration with version counts without changing updatedAt', async () => {
    const tenantId = `tenant-${uuidv4()}`;
    const created = await tenantStorage.run({ tenantId }, () =>
      createAgent({
        id: `agent_${uuidv4()}`,
        name: 'Managed Agent',
        instructions: 'Keep this configuration',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        tools: ['web_search'],
      }),
    );
    await tenantStorage.run({ tenantId }, () =>
      updateAgent({ id: created.id }, { instructions: 'Updated configuration' }),
    );
    const before = await Agent.findById(created._id)
      .select({ updatedAt: 1 })
      .lean<{ updatedAt?: Date }>();
    const beforeUpdatedAt = before?.updatedAt;

    const result = await tenantStorage.run({ tenantId }, () =>
      getAgentManagementListByAccess({
        accessibleIds: [created._id],
        tenantId,
        limit: 20,
      }),
    );
    const after = await Agent.findById(created._id)
      .select({ updatedAt: 1 })
      .lean<{ updatedAt?: Date }>();

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: created.id,
      instructions: 'Updated configuration',
      tools: ['web_search'],
      version: 2,
    });
    expect(result.data[0].versions).toBeUndefined();
    expect(after?.updatedAt).toEqual(beforeUpdatedAt);
  });

  it('enforces tenant scope even when accessible IDs contain another tenant record', async () => {
    const tenantA = `tenant-a-${uuidv4()}`;
    const tenantB = `tenant-b-${uuidv4()}`;
    const publicId = `agent_${uuidv4()}`;
    const author = new mongoose.Types.ObjectId();
    const agentA = await tenantStorage.run({ tenantId: tenantA }, () =>
      createAgent({ id: publicId, name: 'A', provider: 'openai', model: 'gpt-4', author }),
    );
    const agentB = await tenantStorage.run({ tenantId: tenantB }, () =>
      createAgent({ id: publicId, name: 'B', provider: 'openai', model: 'gpt-4', author }),
    );

    const result = await tenantStorage.run({ tenantId: tenantA }, () =>
      getAgentManagementListByAccess({
        accessibleIds: [agentA._id, agentB._id],
        tenantId: tenantA,
        limit: 20,
      }),
    );

    expect(result.data.map(({ name }) => name)).toEqual(['A']);
  });

  it('keeps an unrestricted capability listing inside the authenticated tenant', async () => {
    const tenantA = `tenant-a-${uuidv4()}`;
    const tenantB = `tenant-b-${uuidv4()}`;
    const author = new mongoose.Types.ObjectId();
    await tenantStorage.run({ tenantId: tenantA }, () =>
      createAgent({
        id: `agent_${uuidv4()}`,
        name: 'A',
        provider: 'openai',
        model: 'gpt-4',
        author,
      }),
    );
    await tenantStorage.run({ tenantId: tenantB }, () =>
      createAgent({
        id: `agent_${uuidv4()}`,
        name: 'B',
        provider: 'openai',
        model: 'gpt-4',
        author,
      }),
    );

    const result = await tenantStorage.run({ tenantId: tenantA }, () =>
      getAgentManagementListByAccess({
        accessibleIds: null,
        tenantId: tenantA,
        limit: 20,
      }),
    );

    expect(result.data.map(({ name }) => name)).toEqual(['A']);
  });

  it('paginates deterministically without overlap', async () => {
    const tenantId = `tenant-${uuidv4()}`;
    const author = new mongoose.Types.ObjectId();
    const agents = await tenantStorage.run({ tenantId }, () =>
      Promise.all(
        ['A', 'B', 'C'].map((name) =>
          createAgent({
            id: `agent_${uuidv4()}`,
            name,
            provider: 'openai',
            model: 'gpt-4',
            author,
          }),
        ),
      ),
    );

    const first = await tenantStorage.run({ tenantId }, () =>
      getAgentManagementListByAccess({
        accessibleIds: agents.map(({ _id }) => _id),
        tenantId,
        limit: 2,
      }),
    );
    const second = await tenantStorage.run({ tenantId }, () =>
      getAgentManagementListByAccess({
        accessibleIds: agents.map(({ _id }) => _id),
        tenantId,
        limit: 2,
        after: first.after,
      }),
    );

    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.after).toBeTruthy();
    expect(second.data).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect(first.data.map(({ id }) => id)).not.toContain(second.data[0].id);
  });
});

function createBasicAgent(overrides = {}) {
  const defaults = {
    id: `agent_${uuidv4()}`,
    name: 'Test Agent',
    provider: 'test',
    model: 'test-model',
    author: new mongoose.Types.ObjectId(),
  };
  return createAgent({ ...defaults, ...overrides });
}

function createTestIds() {
  return {
    agentId: `agent_${uuidv4()}`,
    authorId: new mongoose.Types.ObjectId(),
    fileId: uuidv4(),
  };
}

function createFileOperations(agentId: string, fileIds: string[], operation = 'add') {
  return fileIds.map((fileId) =>
    operation === 'add'
      ? addAgentResourceFile({
          agent_id: agentId,
          tool_resource: EToolResources.execute_code,
          file_id: fileId,
        })
      : removeAgentResourceFiles({
          agent_id: agentId,
          files: [{ tool_resource: EToolResources.execute_code, file_id: fileId }],
        }),
  );
}

function mockFindOneAndUpdateError(errorOnCall = 1) {
  const original = Agent.findOneAndUpdate;
  let callCount = 0;

  Agent.findOneAndUpdate = jest.fn().mockImplementation((...args) => {
    callCount++;
    if (callCount === errorOnCall) {
      throw new Error('Database connection lost');
    }
    return original.apply(
      Agent,
      args as [
        filter?: RootFilterQuery<IAgent> | undefined,
        update?: UpdateQuery<IAgent> | undefined,
        options?: QueryOptions<IAgent> | null | undefined,
      ],
    );
  });

  return () => {
    Agent.findOneAndUpdate = original;
  };
}

function generateVersionTestCases() {
  return [
    {
      name: 'simple field update',
      initial: {
        name: 'Test Agent',
        description: 'Initial description',
      },
      update: { name: 'Updated Name' },
      duplicate: { name: 'Updated Name' },
    },
    {
      name: 'object field update',
      initial: {
        model_parameters: { temperature: 0.7 },
      },
      update: { model_parameters: { temperature: 0.8 } },
      duplicate: { model_parameters: { temperature: 0.8 } },
    },
    {
      name: 'array field update',
      initial: {
        tools: ['tool1', 'tool2'],
      },
      update: { tools: ['tool2', 'tool3'] },
      duplicate: { tools: ['tool2', 'tool3'] },
    },
  ];
}
