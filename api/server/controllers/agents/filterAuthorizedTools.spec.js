const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { Constants, actionDelimiter } = require('librechat-data-provider');
const { agentSchema } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

const d = Constants.mcp_delimiter;

const mockGetAllServerConfigs = jest.fn();
const mockUserCanUseMCPServers = jest.fn();

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({
    web_search: true,
    execute_code: true,
    file_search: true,
  }),
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: jest.fn(() => ({
    getAllServerConfigs: mockGetAllServerConfigs,
  })),
}));

jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
  createMCPPermissionContext: jest.fn((req) => ({
    canUseServers: (user) => mockUserCanUseMCPServers(user, req),
  })),
  userCanUseMCPServers: (...args) => mockUserCanUseMCPServers(...args),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  findPubliclyAccessibleResources: jest.fn().mockResolvedValue([]),
  grantPermission: jest.fn(),
  hasPublicPermission: jest.fn().mockResolvedValue(false),
  checkPermission: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createModels, createMethods } = require('@librechat/data-schemas');
  createModels(mongoose);
  const methods = createMethods(mongoose);
  return {
    ...methods,
    getCategoriesWithCounts: jest.fn(),
    deleteFileByFilter: jest.fn(),
  };
});

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  })),
}));

const {
  filterAuthorizedTools,
  createAgent: createAgentHandler,
  updateAgent: updateAgentHandler,
  duplicateAgent: duplicateAgentHandler,
  revertAgentVersion: revertAgentVersionHandler,
} = require('./v1');

const { getMCPServersRegistry } = require('~/config');

let Agent;

describe('MCP Tool Authorization', () => {
  let mongoServer;
  let mockReq;
  let mockRes;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    jest.clearAllMocks();

    getMCPServersRegistry.mockImplementation(() => ({
      getAllServerConfigs: mockGetAllServerConfigs,
    }));
    mockGetAllServerConfigs.mockResolvedValue({
      authorizedServer: { type: 'sse', url: 'https://authorized.example.com' },
      anotherServer: { type: 'sse', url: 'https://another.example.com' },
    });
    mockUserCanUseMCPServers.mockResolvedValue(true);

    mockReq = {
      user: {
        id: new mongoose.Types.ObjectId().toString(),
        role: 'USER',
      },
      body: {},
      params: {},
      query: {},
      app: { locals: { fileStrategy: 'local' } },
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  describe('filterAuthorizedTools', () => {
    const availableTools = { web_search: true, custom_tool: true };
    const userId = 'test-user-123';
    const testUser = { id: userId, role: 'USER' };

    test('should keep authorized MCP tools and strip unauthorized ones', async () => {
      const result = await filterAuthorizedTools({
        tools: [`toolA${d}authorizedServer`, `toolB${d}forbiddenServer`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toContain(`toolA${d}authorizedServer`);
      expect(result).toContain('web_search');
      expect(result).not.toContain(`toolB${d}forbiddenServer`);
    });

    test('should strip MCP tools when user lacks MCP server use permission', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);

      const result = await filterAuthorizedTools({
        tools: [
          `toolA${d}authorizedServer`,
          `${Constants.mcp_all}${d}authorizedServer`,
          'web_search',
        ],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toEqual(['web_search']);
      expect(mockUserCanUseMCPServers).toHaveBeenCalledWith({ id: userId, role: 'USER' });
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should strip MCP tools when user context is missing', async () => {
      mockUserCanUseMCPServers.mockResolvedValueOnce(false);

      const result = await filterAuthorizedTools({
        tools: [`toolA${d}authorizedServer`, 'web_search'],
        userId,
        availableTools,
      });

      expect(result).toEqual(['web_search']);
      expect(mockUserCanUseMCPServers).toHaveBeenCalledWith(undefined);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should keep system tools without querying MCP registry', async () => {
      const result = await filterAuthorizedTools({
        tools: ['execute_code', 'file_search', 'web_search', 'memory'],
        userId,
        availableTools: {},
      });

      expect(result).toEqual(['execute_code', 'file_search', 'web_search', 'memory']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should not query MCP registry when no MCP tools are present', async () => {
      const result = await filterAuthorizedTools({
        tools: ['web_search', 'custom_tool'],
        userId,
        availableTools,
      });

      expect(result).toEqual(['web_search', 'custom_tool']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should filter all MCP tools when registry is uninitialized', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      const result = await filterAuthorizedTools({
        tools: [`toolA${d}someServer`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toEqual(['web_search']);
      expect(result).not.toContain(`toolA${d}someServer`);
    });

    test('should handle mixed authorized and unauthorized MCP tools', async () => {
      const result = await filterAuthorizedTools({
        tools: [
          'web_search',
          `search${d}authorizedServer`,
          `attack${d}victimServer`,
          'execute_code',
          `list${d}anotherServer`,
          `steal${d}nonexistent`,
        ],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toEqual([
        'web_search',
        `search${d}authorizedServer`,
        'execute_code',
        `list${d}anotherServer`,
      ]);
    });

    test('should handle empty tools array', async () => {
      const result = await filterAuthorizedTools({
        tools: [],
        userId,
        availableTools,
      });

      expect(result).toEqual([]);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should handle null/undefined tool entries gracefully', async () => {
      const result = await filterAuthorizedTools({
        tools: [null, undefined, '', 'web_search'],
        userId,
        availableTools,
      });

      expect(result).toEqual(['web_search']);
    });

    test('should call getAllServerConfigs with the correct userId', async () => {
      await filterAuthorizedTools({
        tools: [`tool${d}authorizedServer`],
        userId: 'specific-user-id',
        user: { id: 'specific-user-id', role: 'USER' },
        availableTools,
      });

      expect(mockGetAllServerConfigs).toHaveBeenCalledWith('specific-user-id', undefined);
    });

    test('should pass configServers to getAllServerConfigs and allow config-override servers', async () => {
      const configServers = {
        'config-override-server': { type: 'sse', url: 'https://override.example.com' },
      };
      mockGetAllServerConfigs.mockResolvedValue({
        'config-override-server': configServers['config-override-server'],
      });

      const result = await filterAuthorizedTools({
        tools: [`tool${d}config-override-server`, `tool${d}unauthorizedServer`],
        userId,
        user: testUser,
        availableTools,
        configServers,
      });

      expect(mockGetAllServerConfigs).toHaveBeenCalledWith(userId, configServers);
      expect(result).toContain(`tool${d}config-override-server`);
      expect(result).not.toContain(`tool${d}unauthorizedServer`);
    });

    test('should only call getAllServerConfigs once even with multiple MCP tools', async () => {
      await filterAuthorizedTools({
        tools: [`tool1${d}authorizedServer`, `tool2${d}anotherServer`, `tool3${d}unknownServer`],
        userId,
        user: testUser,
        availableTools,
      });

      expect(mockGetAllServerConfigs).toHaveBeenCalledTimes(1);
    });

    test('should preserve existing MCP tools when registry is unavailable', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      const existingTools = [`toolA${d}serverA`, `toolB${d}serverB`];

      const result = await filterAuthorizedTools({
        tools: [...existingTools, `newTool${d}unknownServer`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
        existingTools,
      });

      expect(result).toContain(`toolA${d}serverA`);
      expect(result).toContain(`toolB${d}serverB`);
      expect(result).toContain('web_search');
      expect(result).not.toContain(`newTool${d}unknownServer`);
    });

    test('should still reject all MCP tools when registry is unavailable and no existingTools', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      const result = await filterAuthorizedTools({
        tools: [`toolA${d}serverA`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toEqual(['web_search']);
    });

    test('should not preserve a tool key with no delimiter at all when registry is unavailable', async () => {
      // A key that isn't a real MCP tool key (no delimiter, so it has no
      // resolvable server) is rejected regardless of the existing-tools
      // fallback - unlike a key with multiple delimiters, which does have a
      // resolvable server (the segment after the last delimiter) and is
      // covered separately below.
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      // Deliberately not named anything containing "_mcp_" - that would
      // ironically make it an MCP tool key itself, exactly the class of
      // naming collision this whole regression is about. (Confirmed
      // programmatically, not just by eye - it's an easy mistake to repeat.)
      const noDelimiterTool = 'regular_web_tool';
      const result = await filterAuthorizedTools({
        tools: [noDelimiterTool, `legit${d}serverA`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
        existingTools: [noDelimiterTool, `legit${d}serverA`],
      });

      expect(result).toContain(`legit${d}serverA`);
      expect(result).toContain('web_search');
      expect(result).not.toContain(noDelimiterTool);
    });

    test('should preserve an existing MCP tool key with multiple delimiters when registry is unavailable', async () => {
      // Regression test for https://github.com/LibreChat-AI/LibreChat/issues/14440:
      // a tool key with more than one delimiter occurrence is not inherently
      // malformed - it just means the raw tool-name half (everything before
      // the *last* delimiter) itself contains the delimiter substring, which
      // legitimately happens with some upstream MCP tool names. The
      // registry-unavailable fallback should treat it like any other
      // previously-persisted tool, not single it out as broken.
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      const multiDelimiterTool = `a${d}b${d}c`;
      const result = await filterAuthorizedTools({
        tools: [multiDelimiterTool, `legit${d}serverA`, 'web_search'],
        userId,
        user: testUser,
        availableTools,
        existingTools: [multiDelimiterTool, `legit${d}serverA`],
      });

      expect(result).toContain(multiDelimiterTool);
      expect(result).toContain(`legit${d}serverA`);
      expect(result).toContain('web_search');
    });

    test('should gate app-level MCP tools present in the global tool cache', async () => {
      const appMcpTool = `appTool${d}authorizedServer`;
      const forbiddenAppMcpTool = `appTool${d}forbiddenServer`;
      const cacheWithMCPTools = {
        ...availableTools,
        [appMcpTool]: true,
        [forbiddenAppMcpTool]: true,
      };

      const result = await filterAuthorizedTools({
        tools: [appMcpTool, forbiddenAppMcpTool, 'web_search'],
        userId,
        user: testUser,
        availableTools: cacheWithMCPTools,
      });

      expect(result).toContain(appMcpTool);
      expect(result).toContain('web_search');
      expect(result).not.toContain(forbiddenAppMcpTool);
    });

    test('should strip app-level MCP tools from the cache when user lacks MCP server use permission', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      const appMcpTool = `appTool${d}authorizedServer`;
      const cacheWithMCPTools = { ...availableTools, [appMcpTool]: true };

      const result = await filterAuthorizedTools({
        tools: [appMcpTool, 'web_search'],
        userId,
        user: testUser,
        availableTools: cacheWithMCPTools,
      });

      expect(result).toEqual(['web_search']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should resolve MCP tool keys with multiple delimiters using the last segment as the server name', async () => {
      // Regression test for https://github.com/LibreChat-AI/LibreChat/issues/14440.
      // A tool key with more than one delimiter occurrence is not inherently
      // malformed - it means the raw tool-name half (the part before the
      // *last* delimiter, which is always the segment LibreChat itself
      // appends) legitimately contains the delimiter substring. Previously
      // any key with >2 segments was rejected outright; now the server name
      // is always the last segment, matching how the key is actually built.
      //
      // `multiSegmentTool` below has an unrelated string ("victimServer")
      // embedded in its raw-tool-name half purely to prove there's no way to
      // spoof a *different* server via that embedded text - only the real
      // last segment ("authorizedServer") is ever consulted for
      // authorization, so this does not grant access to anything the user
      // isn't already allowed to use.
      const multiSegmentTool = `attack${d}victimServer${d}authorizedServer`;
      const unauthorizedMultiSegmentTool = `a${d}b${d}c${d}forbiddenServer`;

      const result = await filterAuthorizedTools({
        tools: [
          multiSegmentTool,
          `legit${d}authorizedServer`,
          unauthorizedMultiSegmentTool,
          'web_search',
        ],
        userId,
        user: testUser,
        availableTools,
      });

      expect(result).toContain(multiSegmentTool);
      expect(result).toContain(`legit${d}authorizedServer`);
      expect(result).toContain('web_search');
      // The unrelated embedded text does not let the key resolve to a
      // different, unauthorized server: only the true last segment
      // ("forbiddenServer", not in the mocked server configs) is checked,
      // and it's correctly rejected.
      expect(result).not.toContain(unauthorizedMultiSegmentTool);
    });
  });

  describe('createAgentHandler - MCP tool authorization', () => {
    test('should strip unauthorized MCP tools on create', async () => {
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'MCP Test Agent',
        tools: ['web_search', `validTool${d}authorizedServer`, `attack${d}forbiddenServer`],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const agent = mockRes.json.mock.calls[0][0];
      expect(agent.tools).toContain('web_search');
      expect(agent.tools).toContain(`validTool${d}authorizedServer`);
      expect(agent.tools).not.toContain(`attack${d}forbiddenServer`);
    });

    test('should strip all MCP tools on create when user lacks MCP server use permission', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'MCP Denied Test Agent',
        tools: [
          'web_search',
          `validTool${d}authorizedServer`,
          `${Constants.mcp_all}${d}authorizedServer`,
        ],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const agent = mockRes.json.mock.calls[0][0];
      expect(agent.tools).toEqual(['web_search']);
      expect(agent.mcpServerNames).toEqual([]);
    });

    test('should not 500 when MCP registry is uninitialized', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'MCP Uninitialized Test',
        tools: [`tool${d}someServer`, 'web_search'],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const agent = mockRes.json.mock.calls[0][0];
      expect(agent.tools).toEqual(['web_search']);
    });

    test('should store mcpServerNames only for authorized servers', async () => {
      mockReq.body = {
        provider: 'openai',
        model: 'gpt-4',
        name: 'MCP Names Test',
        tools: [`toolA${d}authorizedServer`, `toolB${d}forbiddenServer`],
      };

      await createAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const agent = mockRes.json.mock.calls[0][0];
      const agentInDb = await Agent.findOne({ id: agent.id });
      expect(agentInDb.mcpServerNames).toContain('authorizedServer');
      expect(agentInDb.mcpServerNames).not.toContain('forbiddenServer');
    });
  });

  describe('updateAgentHandler - MCP tool authorization', () => {
    let existingAgentId;
    let existingAgentAuthorId;

    beforeEach(async () => {
      existingAgentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Original Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: existingAgentAuthorId,
        tools: ['web_search', `existingTool${d}authorizedServer`],
        mcpServerNames: ['authorizedServer'],
        versions: [
          {
            name: 'Original Agent',
            provider: 'openai',
            model: 'gpt-4',
            tools: ['web_search', `existingTool${d}authorizedServer`],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
      existingAgentId = agent.id;
    });

    test('should preserve existing MCP tools even if editor lacks access', async () => {
      mockGetAllServerConfigs.mockResolvedValue({});

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.tools).toContain('web_search');
    });

    test('should reject newly added unauthorized MCP tools', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`, `attack${d}forbiddenServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toContain('web_search');
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.tools).not.toContain(`attack${d}forbiddenServer`);
    });

    test('should strip all MCP tools, including retained ones, when user lacks MCP server use permission', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`, `newTool${d}anotherServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      // Permission revoked: update must not preserve stale MCP bindings, matching
      // the create/duplicate/revert paths.
      expect(updatedAgent.tools).toEqual(['web_search']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should strip retained MCP tools on an unrelated owner edit after permission revocation', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Renamed After Revocation',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toEqual(['web_search']);
      expect(updatedAgent.name).toBe('Renamed After Revocation');
    });

    test('should not strip shared agent MCP tools on unrelated editor changes after revocation', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = new mongoose.Types.ObjectId().toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Shared Rename After Revocation',
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.name).toBe('Shared Rename After Revocation');
      expect(agentInDb.tools).toContain(`existingTool${d}authorizedServer`);
      expect(agentInDb.mcpServerNames).toEqual(['authorizedServer']);
    });

    test('should not strip shared agent MCP tools on frontend-style full tools save after revocation', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = new mongoose.Types.ObjectId().toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Shared Full Save After Revocation',
        tools: ['web_search', `existingTool${d}authorizedServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.name).toBe('Shared Full Save After Revocation');
      expect(agentInDb.tools).toContain(`existingTool${d}authorizedServer`);
      expect(agentInDb.mcpServerNames).toEqual(['authorizedServer']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should reject new shared-agent MCP tools after revocation while retaining existing MCP tools', async () => {
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = new mongoose.Types.ObjectId().toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`, `newTool${d}anotherServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.tools).not.toContain(`newTool${d}anotherServer`);
      expect(agentInDb.tools).toContain(`existingTool${d}authorizedServer`);
      expect(agentInDb.tools).not.toContain(`newTool${d}anotherServer`);
      expect(agentInDb.mcpServerNames).toEqual(['authorizedServer']);
      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should not strip action tools whose operationId contains the MCP delimiter on revocation', async () => {
      // `sync_mcp_state_action_...` contains the `_mcp_` substring but is a
      // genuine OpenAPI action tool (isActionTool === true). Losing
      // MCP_SERVERS.USE must not drop it — action use is unrelated to MCP.
      const actionTool = `sync_mcp_state${actionDelimiter}api---example---com`;
      await Agent.updateOne(
        { id: existingAgentId },
        { $set: { tools: ['web_search', actionTool] } },
      );

      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Edited Without MCP Permission',
        tools: ['web_search', actionTool],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(updatedAgent.tools).toContain(actionTool);
      expect(updatedAgent.tools).toContain('web_search');
      expect(agentInDb.mcpServerNames).toEqual([]);
    });

    test('should allow adding authorized MCP tools', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`, `newTool${d}anotherServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toContain(`newTool${d}anotherServer`);
    });

    test('should drop mcpServerNames for a server detached in the same edit that adds another', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      /** Swapping servers in one edit: authorizedServer loses its only tool while
       *  anotherServer gains one. Carrying the prior names forward wholesale would
       *  leave authorizedServer indexed, so its viewers would keep agent-scoped
       *  access to a server the agent no longer references. */
      mockReq.body = { tools: ['web_search', `newTool${d}anotherServer`] };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.tools).not.toContain(`existingTool${d}authorizedServer`);
      expect(agentInDb.tools).toContain(`newTool${d}anotherServer`);
      expect(agentInDb.mcpServerNames).toEqual(['anotherServer']);
    });

    test('should preserve resolved mcpServerNames when a non-owner retains MCP tools', async () => {
      /** The shared-agent path keeps the existing MCP tools verbatim; re-deriving the
       *  index from their keys would turn a delimiter-bearing configured server into
       *  its trailing segment, which `ServerConfigsDB` then treats as a DB server. */
      await Agent.updateOne(
        { id: existingAgentId },
        {
          tools: ['web_search', `existingTool${d}Google${d}Workspace`],
          mcpServerNames: [`Google${d}Workspace`],
        },
      );
      mockUserCanUseMCPServers.mockResolvedValue(false);
      mockReq.user.id = new mongoose.Types.ObjectId().toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { tools: ['web_search', `existingTool${d}Google${d}Workspace`] };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.mcpServerNames).toEqual([`Google${d}Workspace`]);
      expect(agentInDb.mcpServerNames).not.toContain('Workspace');
    });

    test('should let persistence derive when an unindexed agent retains MCP tools', async () => {
      /** A legacy or partially migrated agent can hold MCP tools with no stored
       *  mcpServerNames. Pinning the index to [] here would suppress the derivation
       *  in updateAgent and strip agent-scoped access to its DB-backed server. */
      await Agent.updateOne({ id: existingAgentId }, { $unset: { mcpServerNames: 1 } });
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { tools: ['web_search', `existingTool${d}authorizedServer`] };

      await updateAgentHandler(mockReq, mockRes);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.tools).toContain(`existingTool${d}authorizedServer`);
      expect(agentInDb.mcpServerNames).toEqual(['authorizedServer']);
    });

    test('should not query MCP registry when no new MCP tools added', async () => {
      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        tools: ['web_search', `existingTool${d}authorizedServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockGetAllServerConfigs).not.toHaveBeenCalled();
    });

    test('should preserve existing MCP tools when registry unavailable and user edits agent', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Renamed After Restart',
        tools: ['web_search', `existingTool${d}authorizedServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.tools).toContain('web_search');
      expect(updatedAgent.name).toBe('Renamed After Restart');
    });

    test('should preserve existing MCP tools when server not in configs (disconnected)', async () => {
      mockGetAllServerConfigs.mockResolvedValue({});

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = {
        name: 'Edited While Disconnected',
        tools: ['web_search', `existingTool${d}authorizedServer`],
      };

      await updateAgentHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const updatedAgent = mockRes.json.mock.calls[0][0];
      expect(updatedAgent.tools).toContain(`existingTool${d}authorizedServer`);
      expect(updatedAgent.name).toBe('Edited While Disconnected');
    });
  });

  describe('duplicateAgentHandler - MCP tool authorization', () => {
    let sourceAgentId;
    let sourceAgentAuthorId;

    beforeEach(async () => {
      sourceAgentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Source Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: sourceAgentAuthorId,
        tools: ['web_search', `tool${d}authorizedServer`, `tool${d}forbiddenServer`],
        mcpServerNames: ['authorizedServer', 'forbiddenServer'],
        versions: [
          {
            name: 'Source Agent',
            provider: 'openai',
            model: 'gpt-4',
            tools: ['web_search', `tool${d}authorizedServer`, `tool${d}forbiddenServer`],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
      sourceAgentId = agent.id;
    });

    test('should strip unauthorized MCP tools from duplicated agent', async () => {
      mockGetAllServerConfigs.mockResolvedValue({
        authorizedServer: { type: 'sse' },
      });

      mockReq.user.id = sourceAgentAuthorId.toString();
      mockReq.params.id = sourceAgentId;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const { agent: newAgent } = mockRes.json.mock.calls[0][0];
      expect(newAgent.id).not.toBe(sourceAgentId);
      expect(newAgent.tools).toContain('web_search');
      expect(newAgent.tools).toContain(`tool${d}authorizedServer`);
      expect(newAgent.tools).not.toContain(`tool${d}forbiddenServer`);

      const agentInDb = await Agent.findOne({ id: newAgent.id });
      expect(agentInDb.mcpServerNames).toContain('authorizedServer');
      expect(agentInDb.mcpServerNames).not.toContain('forbiddenServer');
    });

    test('should preserve source agent MCP tools when registry is unavailable', async () => {
      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      mockReq.user.id = sourceAgentAuthorId.toString();
      mockReq.params.id = sourceAgentId;

      await duplicateAgentHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      const { agent: newAgent } = mockRes.json.mock.calls[0][0];
      expect(newAgent.tools).toContain('web_search');
      expect(newAgent.tools).toContain(`tool${d}authorizedServer`);
      expect(newAgent.tools).toContain(`tool${d}forbiddenServer`);
    });
  });

  describe('revertAgentVersionHandler - MCP tool authorization', () => {
    let existingAgentId;
    let existingAgentAuthorId;

    beforeEach(async () => {
      existingAgentAuthorId = new mongoose.Types.ObjectId();
      const agent = await Agent.create({
        id: `agent_${uuidv4()}`,
        name: 'Reverted Agent V2',
        provider: 'openai',
        model: 'gpt-4',
        author: existingAgentAuthorId,
        tools: ['web_search'],
        versions: [
          {
            name: 'Reverted Agent V1',
            provider: 'openai',
            model: 'gpt-4',
            tools: ['web_search', `oldTool${d}revokedServer`],
            createdAt: new Date(Date.now() - 10000),
            updatedAt: new Date(Date.now() - 10000),
          },
          {
            name: 'Reverted Agent V2',
            provider: 'openai',
            model: 'gpt-4',
            tools: ['web_search'],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
      existingAgentId = agent.id;
    });

    test('should strip unauthorized MCP tools after reverting to a previous version', async () => {
      mockGetAllServerConfigs.mockResolvedValue({
        authorizedServer: { type: 'sse' },
      });

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const result = mockRes.json.mock.calls[0][0];
      expect(result.tools).toContain('web_search');
      expect(result.tools).not.toContain(`oldTool${d}revokedServer`);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.tools).toContain('web_search');
      expect(agentInDb.tools).not.toContain(`oldTool${d}revokedServer`);
    });

    test('should keep authorized MCP tools after revert', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        { $set: { 'versions.0.tools': ['web_search', `tool${d}authorizedServer`] } },
      );

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const result = mockRes.json.mock.calls[0][0];
      expect(result.tools).toContain('web_search');
      expect(result.tools).toContain(`tool${d}authorizedServer`);
    });

    test('should preserve version MCP tools when registry is unavailable on revert', async () => {
      await Agent.updateOne(
        { id: existingAgentId },
        {
          $set: {
            'versions.0.tools': [
              'web_search',
              `validTool${d}authorizedServer`,
              `otherTool${d}anotherServer`,
            ],
          },
        },
      );

      getMCPServersRegistry.mockImplementation(() => {
        throw new Error('MCPServersRegistry has not been initialized.');
      });

      mockReq.user.id = existingAgentAuthorId.toString();
      mockReq.params.id = existingAgentId;
      mockReq.body = { version_index: 0 };

      await revertAgentVersionHandler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();
      const result = mockRes.json.mock.calls[0][0];
      expect(result.tools).toContain('web_search');
      expect(result.tools).toContain(`validTool${d}authorizedServer`);
      expect(result.tools).toContain(`otherTool${d}anotherServer`);

      const agentInDb = await Agent.findOne({ id: existingAgentId });
      expect(agentInDb.tools).toContain(`validTool${d}authorizedServer`);
      expect(agentInDb.tools).toContain(`otherTool${d}anotherServer`);
    });
  });
});
