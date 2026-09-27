const { createHash } = require('node:crypto');
const { Constants: AgentConstants } = require('@librechat/agents');
const {
  Tools,
  Constants,
  ResourceType,
  ErrorTypes,
  Permissions,
  EToolResources,
  EModelEndpoint,
  isActionTool,
  actionDelimiter,
  PermissionTypes,
  AgentCapabilities,
  defaultAgentCapabilities,
} = require('librechat-data-provider');

const mockGetEndpointsConfig = jest.fn();
const mockGetAppConfig = jest.fn();
const mockGetMCPServerTools = jest.fn();
const mockGetCachedTools = jest.fn();
const mockSendEvent = jest.fn();
const mockEmitChunk = jest.fn();
const mockCreateAttachedWorkspaceBashTool = jest.fn(() => ({ name: AgentConstants.BASH_TOOL }));
const attachedWorkspaceOperations = [
  'read_file',
  'search_text',
  'list_files',
  'write_file',
  'preview_edit',
  'edit_file',
  'execute_command',
];
const mockResolveCodeExecutionContext = jest.fn(
  ({ statefulSessions, environment, userId, agentId, conversationId }) => {
    if (!statefulSessions) {
      return {
        baseUrl: (process.env.LIBRECHAT_CODE_BASEURL ?? 'https://api.librechat.ai').replace(
          /\/$/,
          '',
        ),
        codeSessionKey: 'execute_code',
        executionProfile: 'default',
        statefulSessions: false,
      };
    }
    const baseUrl = process.env.LIBRECHAT_CODE_BASEURL_STATEFUL?.replace(/\/$/, '');
    if (!baseUrl) {
      throw new Error('LIBRECHAT_CODE_BASEURL_STATEFUL is not configured');
    }
    const fingerprint = (...parts) =>
      createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
    let runtimeSessionHint = `v2:user:${fingerprint(userId)}`;
    if (environment === 'agent-user') {
      runtimeSessionHint = `v2:agent-user:${fingerprint(userId, agentId)}`;
    } else if (environment === 'conversation') {
      runtimeSessionHint = `v2:conversation:${fingerprint(userId, conversationId)}`;
    }
    return {
      baseUrl,
      codeSessionKey: `execute_code:stateful:${runtimeSessionHint}`,
      executionProfile: 'stateful',
      runtimeSessionHint,
      statefulSessions: true,
    };
  },
);
const mockResolveCodeExecutionWorkspaceContext = jest.fn(async ({ context }) => {
  if (context.environmentType !== 'attached') {
    return context;
  }
  const environmentId = context.environmentId ?? 'personal-machine';
  return {
    ...context,
    environmentId,
    codeWorkspace: {
      environmentId,
      workspaceId: 'project-a',
      operations: attachedWorkspaceOperations,
    },
  };
});
const mockPrimeSearchFiles = jest.fn().mockResolvedValue({});
const mockPrimeCodeFiles = jest.fn().mockResolvedValue({});
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
  getAppConfig: (...args) => mockGetAppConfig(...args),
  getMCPServerTools: (...args) => mockGetMCPServerTools(...args),
  getCachedTools: (...args) => mockGetCachedTools(...args),
}));

const mockLoadToolDefinitions = jest.fn();
const mockGetUserMCPAuthMap = jest.fn();
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
  isFatalAgentInitializationError: (error, { signal } = {}) =>
    (signal?.aborted === true && (error === signal.reason || error?.name === 'AbortError')) ||
    ['AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 'resource_recovery_required'].includes(error?.code),
  selectMCPUpstreamTokenProvider: ({
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    createSessionProvider,
  }) =>
    upstreamTokenProviderResolver
      ? upstreamTokenProvider
      : (upstreamTokenProvider ?? createSessionProvider()),
  loadToolDefinitions: (...args) => mockLoadToolDefinitions(...args),
  getUserMCPAuthMap: (...args) => mockGetUserMCPAuthMap(...args),
  createAuthIdentityContext: ({ user, tenantId }) => ({
    appUserId: user?._id?.toString?.() ?? user?.id,
    openidSubject: user?.openidId,
    tenantId: tenantId ?? user?.tenantId,
    openidIssuer: user?.openidIssuer,
  }),
  sendEvent: (...args) => mockSendEvent(...args),
  GenerationJobManager: {
    emitChunk: (...args) => mockEmitChunk(...args),
  },
  resolveCodeExecutionContext: (...args) => mockResolveCodeExecutionContext(...args),
  resolveCodeExecutionWorkspaceContext: (...args) =>
    mockResolveCodeExecutionWorkspaceContext(...args),
  createAttachedWorkspaceBashTool: (...args) => mockCreateAttachedWorkspaceBashTool(...args),
}));

const mockLoadToolsUtil = jest.fn();
jest.mock('~/app/clients/tools/util', () => ({
  loadTools: (...args) => mockLoadToolsUtil(...args),
}));

const mockLoadActionSets = jest.fn();
const mockDomainParser = jest.fn();
const mockLegacyDomainEncode = jest.fn();
const mockDecryptMetadata = jest.fn();
const mockCreateActionTool = jest.fn();
const mockGetServerConfig = jest.fn();
const mockFlowManager = { getFlowState: jest.fn() };
const mockResolveConfigServers = jest.fn();
const mockResolveMcpServerNames = jest.fn();
const mockUserCanUseMCPServers = jest.fn().mockResolvedValue(true);
jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/Tools/search', () => ({
  createOnSearchResults: jest.fn(),
}));
jest.mock('~/server/services/Tools/mcp', () => ({
  reinitMCPServer: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  processFileURL: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: (...args) => mockPrimeSearchFiles(...args),
}));
jest.mock('~/server/services/Files/Code/process', () => ({
  primeFiles: (...args) => mockPrimeCodeFiles(...args),
}));
jest.mock('../ActionService', () => ({
  loadActionSets: (...args) => mockLoadActionSets(...args),
  decryptMetadata: (...args) => mockDecryptMetadata(...args),
  createActionTool: (...args) => mockCreateActionTool(...args),
  domainParser: (...args) => mockDomainParser(...args),
  legacyDomainEncode: (...args) => mockLegacyDomainEncode(...args),
}));
jest.mock('~/server/services/Threads', () => ({
  recordUsage: jest.fn(),
}));
const mockGetRoleByName = jest.fn();
jest.mock('~/models', () => ({
  findPluginAuthsByKeys: jest.fn(),
  getRoleByName: (...args) => mockGetRoleByName(...args),
}));
jest.mock('~/config', () => ({
  getFlowStateManager: jest.fn(() => mockFlowManager),
  getMCPServersRegistry: jest.fn(() => ({
    getServerConfig: (...args) => mockGetServerConfig(...args),
  })),
}));
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: (...args) => mockResolveConfigServers(...args),
  resolveMcpServerNames: (...args) => mockResolveMcpServerNames(...args),
  resolveMcpServerContext: async (...args) => {
    const configServers = (await mockResolveConfigServers(...args)) ?? {};
    const serverNames = Object.keys(configServers);
    return { configServers, serverNames, rawServerNames: serverNames };
  },
  /** Mirrors the real resolver's shape; these fixtures use safe names, so the
   *  raw set is always the complete audit. */
  resolveCollisionAuditNames: jest.fn(async ({ rawServerNames, accessibleServerNames }) => ({
    names: accessibleServerNames?.length ? accessibleServerNames : rawServerNames,
    complete: true,
  })),
  createMCPPermissionContext: jest.fn((req) => ({
    canUseServers: (user) => mockUserCanUseMCPServers(user, req),
  })),
  userCanUseMCPServers: mockUserCanUseMCPServers,
}));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({})),
}));
const {
  loadAgentTools,
  loadToolsForExecution,
  processRequiredActions,
  resolveAgentCapabilities,
} = require('../ToolService');
const { createOnSearchResults } = require('~/server/services/Tools/search');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const { ContentFilterError, PENDING_STALE_MS } = require('@librechat/api');

/** Role document shape `checkAccess` reads; all three role-gated tools granted. */
function buildRole(overrides = {}) {
  return {
    name: 'USER',
    permissions: {
      [PermissionTypes.FILE_SEARCH]: { [Permissions.USE]: true },
      [PermissionTypes.RUN_CODE]: { [Permissions.USE]: true },
      [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: true },
      ...overrides,
    },
  };
}

function createMockReq(capabilities) {
  return {
    user: { id: 'user_123', role: 'USER' },
    config: {
      endpoints: {
        [EModelEndpoint.agents]: {
          capabilities,
        },
      },
    },
  };
}

function createEndpointsConfig(capabilities) {
  return {
    [EModelEndpoint.agents]: { capabilities },
  };
}

describe('ToolService - Action Capability Gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadToolDefinitions.mockResolvedValue({
      toolDefinitions: [],
      toolRegistry: new Map(),
      hasDeferredTools: false,
    });
    mockLoadToolsUtil.mockResolvedValue({ loadedTools: [], toolContextMap: {} });
    mockLoadActionSets.mockResolvedValue([]);
    mockDecryptMetadata.mockImplementation(async (metadata) => metadata);
    mockGetMCPServerTools.mockResolvedValue(null);
    mockGetCachedTools.mockResolvedValue(null);
    mockGetUserMCPAuthMap.mockResolvedValue({});
    mockGetRoleByName.mockResolvedValue(buildRole());
    mockGetServerConfig.mockResolvedValue(undefined);
    mockFlowManager.getFlowState.mockResolvedValue(undefined);
    mockResolveConfigServers.mockResolvedValue({});
    mockResolveMcpServerNames.mockResolvedValue([]);
    mockPrimeSearchFiles.mockResolvedValue({});
    mockPrimeCodeFiles.mockResolvedValue({});
  });

  describe('processRequiredActions content protection', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const buildFilters = (field, sentinel) => ({
      toolArguments: {
        pii: {
          fields: [field],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private',
              label: 'private value',
              regex: sentinel,
            },
          ],
        },
      },
    });

    const buildClient = (filters) => ({
      req: {
        user: { id: 'user_123' },
        body: {
          assistant_id: 'assistant_content_filter',
          model: 'gpt-4o-mini',
          endpoint: 'openAI',
        },
        config: { filters },
      },
      res: {},
      apiKey: 'test-key',
      mappedOrder: new Map([['call_1', 0]]),
      seenToolCalls: new Map(),
      addContentData: jest.fn(),
    });

    const buildAction = (overrides = {}) => ({
      tool: 'safe_tool',
      toolInput: { value: 'safe' },
      toolCallId: 'call_1',
      thread_id: 'thread_1',
      run_id: 'run_1',
      ...overrides,
    });

    it('blocks a filtered tool name before lookup, logging, or execution', async () => {
      const privateName = 'PRIVATE-NAME';
      const client = buildClient(buildFilters('name', privateName));
      const debugSpy = jest.spyOn(require('@librechat/data-schemas').logger, 'debug');

      await expect(
        processRequiredActions(client, [buildAction({ tool: privateName })]),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        message: expect.not.stringContaining(privateName),
      });

      expect(mockGetCachedTools).not.toHaveBeenCalled();
      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('blocks filtered arguments before tool execution', async () => {
      const privateArgument = 'PRIVATE-ARGUMENT';
      const client = buildClient(buildFilters('arguments', privateArgument));

      await expect(
        processRequiredActions(client, [
          buildAction({ toolInput: { nested: { value: privateArgument } } }),
        ]),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        message: expect.not.stringContaining(privateArgument),
      });

      expect(mockGetCachedTools).not.toHaveBeenCalled();
      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
    });

    it('blocks a visible argument match before enforcing its traversal overflow', async () => {
      const privateArgument = 'PRIVATE-ARGUMENT';
      const deeplyNestedArguments = { visible: privateArgument };
      let current = deeplyNestedArguments;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      const client = buildClient(buildFilters('arguments', privateArgument));

      await expect(
        processRequiredActions(client, [buildAction({ toolInput: deeplyNestedArguments })]),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        message: expect.not.stringContaining(privateArgument),
      });

      expect(mockGetCachedTools).not.toHaveBeenCalled();
      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
    });

    it('fails closed before execution when selected arguments exhaust traversal', async () => {
      const deeplyNestedArguments = { visible: 'safe' };
      let current = deeplyNestedArguments;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      const client = buildClient(buildFilters('arguments', 'PRIVATE-ARGUMENT'));

      await expect(
        processRequiredActions(client, [buildAction({ toolInput: deeplyNestedArguments })]),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: {
          error: 'content_filter_uninspectable',
          source: 'tool_argument',
          field: 'arguments',
        },
      });

      expect(mockGetCachedTools).not.toHaveBeenCalled();
      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
    });

    it('does not inspect required-action values when the source has no active patterns', async () => {
      const opaqueArguments = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('inactive arguments were traversed');
          },
        },
      );
      const client = buildClient({
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
          },
        },
      });

      await expect(
        processRequiredActions(client, [buildAction({ toolInput: opaqueArguments })]),
      ).resolves.toEqual({ tool_outputs: [] });

      expect(mockGetCachedTools).toHaveBeenCalledTimes(1);
      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
    });

    it('does not traverse unselected required-action arguments', async () => {
      const opaqueArguments = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('unselected arguments were traversed');
          },
        },
      );
      const client = buildClient(buildFilters('name', 'PRIVATE-NAME'));

      await expect(
        processRequiredActions(client, [buildAction({ toolInput: opaqueArguments })]),
      ).resolves.toEqual({ tool_outputs: [] });

      expect(mockGetCachedTools).toHaveBeenCalledTimes(1);
      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
    });

    it('does not traverse unselected required-action output', async () => {
      const opaqueOutput = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('unselected output was traversed');
          },
        },
      );
      const toolCall = jest.fn().mockResolvedValue(opaqueOutput);
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [{ name: 'safe_tool', _call: toolCall }],
        toolContextMap: {},
      });
      const client = buildClient(buildFilters('arguments', 'PRIVATE-ARGUMENT'));

      const result = await processRequiredActions(client, [buildAction()]);

      expect(result.tool_outputs[0].tool_call_id).toBe('call_1');
      expect(result.tool_outputs[0].output).toBe(opaqueOutput);
    });

    it('does not traverse unselected required-action arguments for output-only policies', async () => {
      const deeplyNestedArguments = { value: 'safe' };
      let current = deeplyNestedArguments;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      const toolCall = jest.fn().mockResolvedValue('safe output');
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [{ name: 'safe_tool', _call: toolCall }],
        toolContextMap: {},
      });
      const client = buildClient(buildFilters('output', 'PRIVATE-OUTPUT'));

      await expect(
        processRequiredActions(client, [buildAction({ toolInput: deeplyNestedArguments })]),
      ).resolves.toEqual({
        tool_outputs: [{ tool_call_id: 'call_1', output: 'safe output' }],
      });

      expect(toolCall).toHaveBeenCalledWith(deeplyNestedArguments);
    });

    it('replaces a filtered tool output before UI or model submission', async () => {
      const privateOutput = 'PRIVATE-OUTPUT';
      const toolCall = jest.fn().mockResolvedValue(privateOutput);
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [{ name: 'safe_tool', _call: toolCall }],
        toolContextMap: {},
      });
      const client = buildClient(buildFilters('output', privateOutput));
      const action = buildAction();

      const result = await processRequiredActions(client, [action]);

      expect(toolCall).toHaveBeenCalledWith(action.toolInput);
      expect(result.tool_outputs).toEqual([
        {
          tool_call_id: 'call_1',
          output: JSON.stringify({
            error: 'content_filter_block',
            message: 'Submitted content was blocked by content policy.',
            source: 'tool_argument',
            field: 'output',
          }),
        },
      ]);
      expect(action.output).not.toContain(privateOutput);
      expect(client.addContentData).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_call: expect.objectContaining({
            function: expect.objectContaining({
              output: expect.not.stringContaining(privateOutput),
            }),
          }),
        }),
      );
    });

    it('replaces an uninspectable tool output before UI or model submission', async () => {
      const deeplyNestedOutput = { visible: 'safe' };
      let current = deeplyNestedOutput;
      for (let depth = 0; depth < 30; depth++) {
        current.nested = {};
        current = current.nested;
      }
      const toolCall = jest.fn().mockResolvedValue(deeplyNestedOutput);
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [{ name: 'safe_tool', _call: toolCall }],
        toolContextMap: {},
      });
      const client = buildClient(buildFilters('output', 'PRIVATE-OUTPUT'));
      const action = buildAction();

      const result = await processRequiredActions(client, [action]);
      const output = result.tool_outputs[0].output;

      expect(JSON.parse(output)).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'tool_argument',
        field: 'output',
      });
      expect(action.output).toBe(output);
      expect(output).not.toContain('PRIVATE-OUTPUT');
      expect(client.addContentData).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_call: expect.objectContaining({
            function: expect.objectContaining({ output }),
          }),
        }),
      );
    });

    it.each([
      ['bearer_header', 'Authorization: Bearer required-action-token', 'Bearer token'],
      ['api_key_header', 'api-key: required-action-token', 'api-key header'],
    ])(
      'returns a stable required-action %s block output',
      async (starterPattern, privateOutput, detectorLabel) => {
        mockLoadToolsUtil.mockResolvedValue({
          loadedTools: [{ name: 'safe_tool', _call: jest.fn().mockResolvedValue(privateOutput) }],
          toolContextMap: {},
        });
        const client = buildClient({
          toolArguments: {
            pii: {
              fields: ['output'],
              starterPatterns: [starterPattern],
            },
          },
        });

        const result = await processRequiredActions(client, [buildAction()]);
        const output = result.tool_outputs[0].output;

        expect(JSON.parse(output)).toEqual({
          error: 'content_filter_block',
          message: 'Submitted content was blocked by content policy.',
          source: 'tool_argument',
          field: 'output',
        });
        expect(output).not.toContain(privateOutput);
        expect(output).not.toContain(detectorLabel);
      },
    );

    it('normalizes a required-action policy error without tool-output filtering', async () => {
      const privateOutput = 'Authorization: Bearer generated-file-token';
      const policyError = new ContentFilterError({
        detectorId: 'pii-pattern',
        ruleId: 'bearer_header',
        label: 'Bearer token',
        source: 'file',
        field: 'content',
        provenance: 'tool',
        fragmentId: 'generated-file',
        fragmentPath: '/content',
      });
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [
          {
            name: 'safe_tool',
            _call: jest.fn().mockRejectedValue(policyError),
          },
        ],
        toolContextMap: {},
      });
      const client = buildClient({
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: ['bearer_header'],
          },
        },
      });

      const result = await processRequiredActions(client, [buildAction()]);
      const output = result.tool_outputs[0].output;

      expect(JSON.parse(output)).toEqual({
        error: 'content_filter_block',
        message: 'Submitted content was blocked by content policy.',
        source: 'file',
        field: 'content',
      });
      expect(output).not.toContain(privateOutput);
      expect(output).not.toContain('Bearer token');
      expect(output).not.toContain('bearer_header');
    });

    it('blocks persisted Assistant action metadata before required-action execution', async () => {
      const actionToolName = `get_weather${actionDelimiter}api_example_com`;
      const filters = {
        actionMetadata: {
          pii: {
            fields: ['api_key'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      const metadata = {
        domain: 'https://api.example.com',
        raw_spec: '{}',
        api_key: 'encrypted-value',
      };
      const client = buildClient(filters);
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'assistant_action_private_auth',
          metadata,
        },
      ]);
      mockDecryptMetadata.mockResolvedValue({
        ...metadata,
        api_key: 'PRIVATE-AUTH',
      });

      await expect(
        processRequiredActions(client, [buildAction({ tool: actionToolName })]),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'action_metadata',
          field: 'api_key',
        },
      });

      expect(mockDomainParser).not.toHaveBeenCalled();
      expect(mockCreateActionTool).not.toHaveBeenCalled();
    });
  });

  describe('resolveAgentCapabilities', () => {
    it('should return capabilities from endpoints config', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await resolveAgentCapabilities(req, req.config, 'agent_123');

      expect(result).toBeInstanceOf(Set);
      expect(result.has(AgentCapabilities.tools)).toBe(true);
      expect(result.has(AgentCapabilities.actions)).toBe(true);
      expect(result.has(AgentCapabilities.web_search)).toBe(false);
    });

    it('should fall back to default capabilities for ephemeral agents with empty config', async () => {
      const req = createMockReq(defaultAgentCapabilities);
      mockGetEndpointsConfig.mockResolvedValue({});

      const result = await resolveAgentCapabilities(req, req.config, Constants.EPHEMERAL_AGENT_ID);

      for (const cap of defaultAgentCapabilities) {
        expect(result.has(cap)).toBe(true);
      }
    });

    it('should return empty set when no capabilities and not ephemeral', async () => {
      const req = createMockReq([]);
      mockGetEndpointsConfig.mockResolvedValue({});

      const result = await resolveAgentCapabilities(req, req.config, 'agent_123');

      expect(result.size).toBe(0);
    });
  });

  describe('isActionTool — cross-delimiter collision guard', () => {
    it('should identify real action tools', () => {
      expect(isActionTool(`get_weather${actionDelimiter}api_example_com`)).toBe(true);
      expect(isActionTool(`fetch_data${actionDelimiter}my---domain---com`)).toBe(true);
    });

    it('should identify action tools whose operationId contains _mcp_', () => {
      expect(isActionTool(`sync_mcp_state${actionDelimiter}api---example---com`)).toBe(true);
      expect(isActionTool(`get_mcp_config${actionDelimiter}internal---api---com`)).toBe(true);
    });

    it('should reject MCP tools whose name ends with _action', () => {
      expect(isActionTool(`get_action${Constants.mcp_delimiter}myserver`)).toBe(false);
      expect(isActionTool(`fetch_action${Constants.mcp_delimiter}server_name`)).toBe(false);
      expect(isActionTool(`retrieve_action${Constants.mcp_delimiter}srv`)).toBe(false);
    });

    it('should reject MCP tools with _action_ in the middle of their name', () => {
      expect(isActionTool(`get_action_data${Constants.mcp_delimiter}myserver`)).toBe(false);
      expect(isActionTool(`create_action_item${Constants.mcp_delimiter}server`)).toBe(false);
    });

    it('should reject tools without the action delimiter', () => {
      expect(isActionTool('calculator')).toBe(false);
      expect(isActionTool(`web_search${Constants.mcp_delimiter}myserver`)).toBe(false);
    });

    it('known limitation: non-RFC domain with _mcp_ substring yields false negative', () => {
      // RFC 952/1123 prohibit underscores in hostnames, so this is not expected in practice.
      // Encoded domain `api_mcp_internal_com` places `_mcp_` after `_action_`, which
      // the guard interprets as the MCP suffix.
      const edgeCaseTool = `getData${actionDelimiter}api_mcp_internal_com`;
      expect(isActionTool(edgeCaseTool)).toBe(false);
    });
  });

  describe('loadAgentTools tool-resource content protection', () => {
    const opaqueFileFilters = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: ['sk_prefix'],
          uninspectable: 'block',
        },
      },
    };

    const patternFilters = (source, fields, regex) => ({
      [source]: {
        pii: {
          fields,
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex }],
        },
      },
    });

    it.each([true, false])(
      'blocks historical execute-code resources before code-file priming (definitionsOnly=%s)',
      async (definitionsOnly) => {
        const privateFileId = 'file-historical-code';
        const req = createMockReq([AgentCapabilities.execute_code]);
        req.config.filters = opaqueFileFilters;
        mockGetEndpointsConfig.mockResolvedValue(
          createEndpointsConfig([AgentCapabilities.execute_code]),
        );

        await expect(
          loadAgentTools({
            req,
            res: {},
            agent: { id: 'agent_code', tools: [Tools.execute_code] },
            tool_resources: {
              [EToolResources.execute_code]: { file_ids: [privateFileId] },
            },
            definitionsOnly,
          }),
        ).rejects.toMatchObject({
          code: 'content_filter_uninspectable',
          message: expect.not.stringContaining(privateFileId),
        });

        expect(mockLoadToolDefinitions).not.toHaveBeenCalled();
        expect(mockPrimeCodeFiles).not.toHaveBeenCalled();
        expect(mockPrimeSearchFiles).not.toHaveBeenCalled();
      },
    );

    it.each([true, false])(
      'blocks historical file-search resources before search-file priming (definitionsOnly=%s)',
      async (definitionsOnly) => {
        const privateFileId = 'file-historical-search';
        const req = createMockReq([AgentCapabilities.file_search]);
        req.config.filters = opaqueFileFilters;
        mockGetEndpointsConfig.mockResolvedValue(
          createEndpointsConfig([AgentCapabilities.file_search]),
        );

        await expect(
          loadAgentTools({
            req,
            res: {},
            agent: { id: 'agent_search', tools: [Tools.file_search] },
            tool_resources: {
              [EToolResources.file_search]: { file_ids: [privateFileId] },
            },
            definitionsOnly,
          }),
        ).rejects.toMatchObject({
          code: 'content_filter_uninspectable',
          message: expect.not.stringContaining(privateFileId),
        });

        expect(mockLoadToolDefinitions).not.toHaveBeenCalled();
        expect(mockPrimeCodeFiles).not.toHaveBeenCalled();
        expect(mockPrimeSearchFiles).not.toHaveBeenCalled();
      },
    );

    it('does not apply prompt policy to canonical file-resource content', async () => {
      const privateFilename = 'PRIVATE-FILE.txt';
      const req = createMockReq([AgentCapabilities.file_search]);
      req.config.filters = patternFilters('prompts', ['name'], privateFilename);
      mockGetEndpointsConfig.mockResolvedValue(
        createEndpointsConfig([AgentCapabilities.file_search]),
      );

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_search', tools: [Tools.file_search] },
          tool_resources: {
            [EToolResources.file_search]: {
              files: [{ file_id: 'file-safe', filename: privateFilename }],
            },
          },
          definitionsOnly: true,
        }),
      ).resolves.toBeDefined();

      expect(mockPrimeSearchFiles).toHaveBeenCalledTimes(1);
      expect(mockPrimeCodeFiles).not.toHaveBeenCalled();
    });

    it('does not apply an unselected file field to canonical resource content', async () => {
      const privateContent = 'PRIVATE-CONTENT';
      const req = createMockReq([AgentCapabilities.execute_code]);
      req.config.filters = patternFilters('files', ['name'], privateContent);
      mockGetEndpointsConfig.mockResolvedValue(
        createEndpointsConfig([AgentCapabilities.execute_code]),
      );

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_code', tools: [Tools.execute_code] },
          tool_resources: {
            [EToolResources.execute_code]: {
              files: [
                {
                  file_id: 'file-safe',
                  filename: 'safe.txt',
                  text: privateContent,
                },
              ],
            },
          },
          definitionsOnly: true,
        }),
      ).resolves.toBeDefined();

      expect(mockPrimeCodeFiles).toHaveBeenCalledTimes(1);
      expect(mockPrimeSearchFiles).not.toHaveBeenCalled();
    });

    it('does not log raw code-file priming errors', async () => {
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-CODE-FILE-PROVIDER-ECHO';
      const errorSpy = jest.spyOn(logger, 'error');
      const providerError = Object.assign(new Error(`Provider echoed ${rawValue}`), {
        response: { status: 502, data: { file: rawValue } },
      });
      mockPrimeCodeFiles.mockRejectedValueOnce(providerError);
      const req = createMockReq([AgentCapabilities.execute_code]);
      mockGetEndpointsConfig.mockResolvedValue(
        createEndpointsConfig([AgentCapabilities.execute_code]),
      );

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_code', tools: [Tools.execute_code] },
        tool_resources: {
          [EToolResources.execute_code]: { file_ids: ['file-safe'] },
        },
        definitionsOnly: true,
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[loadToolDefinitionsWrapper] Error priming code files:',
        { type: 'Error', status: 502 },
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(rawValue);
      errorSpy.mockRestore();
    });

    it('does not log raw search-file priming errors', async () => {
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-SEARCH-FILE-PROVIDER-ECHO';
      const errorSpy = jest.spyOn(logger, 'error');
      const providerError = Object.assign(new Error(`Provider echoed ${rawValue}`), {
        response: { status: 503, data: { file: rawValue } },
      });
      mockPrimeSearchFiles.mockRejectedValueOnce(providerError);
      const req = createMockReq([AgentCapabilities.file_search]);
      mockGetEndpointsConfig.mockResolvedValue(
        createEndpointsConfig([AgentCapabilities.file_search]),
      );

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_search', tools: [Tools.file_search] },
        tool_resources: {
          [EToolResources.file_search]: { file_ids: ['file-safe'] },
        },
        definitionsOnly: true,
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[loadToolDefinitionsWrapper] Error priming search files:',
        { type: 'Error', status: 503 },
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(rawValue);
      errorSpy.mockRestore();
    });
  });

  describe('loadAgentTools (definitionsOnly=true) — action tool filtering', () => {
    const actionToolName = `get_weather${actionDelimiter}api_example_com`;
    const regularTool = 'calculator';

    it('should preserve the remote-agent permission boundary while priming files', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.file_search,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const tool_resources = {
        file_search: { file_ids: ['search-file'] },
        execute_code: { file_ids: ['code-file'] },
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code] },
        tool_resources,
        agentResourceType: ResourceType.REMOTE_AGENT,
        definitionsOnly: true,
      });

      const expectedParams = {
        req,
        tool_resources,
        agentId: 'agent_123',
        agentResourceType: ResourceType.REMOTE_AGENT,
      };
      expect(mockPrimeSearchFiles).toHaveBeenCalledWith(expectedParams);
      expect(mockPrimeCodeFiles).toHaveBeenCalledWith({
        ...expectedParams,
        codeApiBaseUrl: 'https://api.librechat.ai',
        executionProfile: 'default',
        codeFileLocation: 'sandbox',
      });
    });

    it('primes code files through the initializer-selected stateful route', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.execute_code];
      const req = createMockReq(capabilities);
      const tool_resources = { execute_code: { file_ids: ['stateful-file'] } };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'stateful-agent', tools: [Tools.execute_code] },
        tool_resources,
        definitionsOnly: true,
        codeExecutionContext: {
          baseUrl: 'https://stateful-code.example.com',
          codeSessionKey: 'execute_code:stateful:v2:user:abc',
          executionProfile: 'stateful',
          runtimeSessionHint: 'v2:user:abc',
          statefulSessions: true,
          bridgeWorkerId: 'worker-abc',
        },
      });

      expect(mockPrimeCodeFiles).toHaveBeenCalledWith({
        req,
        tool_resources,
        agentId: 'stateful-agent',
        agentResourceType: undefined,
        codeApiBaseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'worker-abc',
        codeFileLocation: 'sandbox',
      });
    });

    it('primes code files for an attached workspace as unavailable to workspace tools', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.execute_code];
      const req = createMockReq(capabilities);
      req.body = {
        codeWorkspaces: [{ environmentId: 'personal-machine', workspaceId: 'project-a' }],
      };
      const tool_resources = { execute_code: { file_ids: ['attached-file'] } };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'attached-agent', tools: [Tools.execute_code] },
        tool_resources,
        definitionsOnly: true,
        codeExecutionContext: {
          baseUrl: 'http://attached-code.test/v1',
          codeSessionKey: 'execute_code:stateful:attached',
          executionProfile: 'stateful',
          statefulSessions: true,
          environmentType: 'attached',
          environmentId: 'personal-machine',
          bridgeWorkerId: 'worker-abc',
        },
      });

      expect(mockPrimeCodeFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_resources,
          bridgeWorkerId: 'worker-abc',
          codeFileLocation: 'programmatic',
        }),
      );
    });

    it('propagates a typed CodeAPI resource recovery failure before model invocation', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.execute_code];
      const req = createMockReq(capabilities);
      const resourceRecoveryError = Object.assign(new Error('resource recovery required'), {
        code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      });
      mockPrimeCodeFiles.mockRejectedValueOnce(resourceRecoveryError);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: {
            id: 'agent_123',
            tools: [Tools.execute_code, 'run_query_mcp_warehouse'],
          },
          tool_resources: { execute_code: { file_ids: ['stale-file'] } },
          definitionsOnly: true,
        }),
      ).rejects.toBe(resourceRecoveryError);
    });

    it('should exclude action tools from definitions when actions capability is disabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, actionToolName] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(regularTool);
      expect(callArgs.tools).not.toContain(actionToolName);
    });

    it('should include action tools in definitions when actions capability is enabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, actionToolName] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(regularTool);
      expect(callArgs.tools).toContain(actionToolName);
    });

    it('blocks a persisted action schema before domain parsing during definition loading', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      req.config.filters = {
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_private_schema',
          metadata: {
            domain: 'https://api.example.com',
            raw_spec: '{"description":"PRIVATE-SCHEMA"}',
          },
        },
      ]);
      mockLoadToolDefinitions.mockImplementationOnce(async (_options, dependencies) => {
        await dependencies.getActionToolDefinitions('agent_123', [actionToolName]);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', tools: [actionToolName] },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'tool_argument',
          field: 'arguments',
        },
      });

      expect(mockDecryptMetadata).not.toHaveBeenCalled();
      expect(mockDomainParser).not.toHaveBeenCalled();
    });

    it('blocks decrypted persisted action secrets before definition-time domain work', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      req.config.filters = {
        actionMetadata: {
          pii: {
            fields: ['api_key'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      const metadata = {
        domain: 'https://api.example.com',
        raw_spec: '{}',
        api_key: 'encrypted-value',
      };
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_private_auth',
          metadata,
        },
      ]);
      mockDecryptMetadata.mockResolvedValue({
        ...metadata,
        api_key: 'PRIVATE-AUTH',
      });
      mockLoadToolDefinitions.mockImplementationOnce(async (_options, dependencies) => {
        await dependencies.getActionToolDefinitions('agent_123', [actionToolName]);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', tools: [actionToolName] },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'action_metadata',
          field: 'api_key',
        },
      });

      expect(mockDecryptMetadata).toHaveBeenCalledWith(metadata);
      expect(mockDomainParser).not.toHaveBeenCalled();
    });

    it.each([
      [
        'inactive secret-field policy',
        {
          actionMetadata: {
            pii: {
              fields: ['api_key'],
              starterPatterns: [],
            },
          },
        },
      ],
      [
        'active plaintext-field policy',
        {
          actionMetadata: {
            pii: {
              fields: ['raw_spec'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private',
                  label: 'private value',
                  regex: 'PRIVATE-[A-Z]+',
                },
              ],
            },
          },
        },
      ],
    ])('does not decrypt action metadata for an %s', async (_label, filters) => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      req.config.filters = filters;
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolDefinitions.mockReset().mockResolvedValue({
        toolDefinitions: [],
        toolRegistry: new Map(),
        hasDeferredTools: false,
      });
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_safe_metadata',
          metadata: {
            domain: 'https://api.example.com',
            raw_spec: '{}',
            api_key: 'encrypted-value',
          },
        },
      ]);

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [actionToolName] },
        definitionsOnly: true,
      });

      expect(mockDecryptMetadata).not.toHaveBeenCalled();
    });

    it('blocks persisted action metadata before MCP definition initialization', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      const mcpTool = `search${Constants.mcp_delimiter}private-server`;
      req.config.filters = {
        actionMetadata: {
          pii: {
            fields: ['raw_spec'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_private_before_mcp',
          metadata: {
            domain: 'https://api.example.com',
            raw_spec: '{"description":"PRIVATE-ACTION"}',
          },
        },
      ]);
      mockLoadToolDefinitions.mockImplementationOnce(async (options, dependencies) => {
        await dependencies.getOrFetchMCPServerTools(options.userId, 'private-server');
        await dependencies.getActionToolDefinitions('agent_123', [actionToolName]);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', tools: [mcpTool, actionToolName] },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'action_metadata',
          field: 'raw_spec',
        },
      });

      expect(mockLoadToolDefinitions).not.toHaveBeenCalled();
      expect(mockGetUserMCPAuthMap).not.toHaveBeenCalled();
      expect(mockResolveConfigServers).not.toHaveBeenCalled();
      expect(reinitMCPServer).not.toHaveBeenCalled();
    });

    it('should exclude ask_user_question when its capability is disabled (even if tools is enabled)', async () => {
      // ask_user_question is gated by its OWN capability, like execute_code —
      // NOT the generic `tools` capability. Here `tools` is on but the ask
      // capability is not, so the tool must be filtered out.
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, 'ask_user_question'] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(regularTool);
      expect(callArgs.tools).not.toContain('ask_user_question');
    });

    it('should include ask_user_question when its capability is enabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.ask_user_question];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, 'ask_user_question'] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain('ask_user_question');
    });

    it('should not filter MCP tools whose name contains _action (cross-delimiter collision)', async () => {
      const mcpToolWithAction = `get_action${Constants.mcp_delimiter}myserver`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, mcpToolWithAction] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(mcpToolWithAction);
      expect(callArgs.tools).toContain(regularTool);
    });

    it('fails initialization when an explicitly selected MCP tool cannot be resolved', async () => {
      const mcpTool = `search${Constants.mcp_delimiter}warehouse`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockResolveConfigServers.mockResolvedValue({
        warehouse: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/warehouse',
        },
      });
      mockLoadToolDefinitions.mockResolvedValueOnce({
        toolDefinitions: [],
        toolRegistry: new Map(),
        hasDeferredTools: false,
        mcpResolution: { expectedToolCount: 1, resolvedToolCount: 0 },
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', name: 'Target Agent', tools: [mcpTool] },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
        statusCode: 503,
        message: expect.stringContaining('can access its selected tools'),
      });
    });

    it('fails closed when MCP definition loading throws before resolution completes', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolDefinitions.mockRejectedValueOnce(new Error('MCP registry unavailable'));

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: {
            id: 'agent_123',
            name: 'Target Agent',
            tools: [`run_query${Constants.mcp_delimiter}warehouse`],
          },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
        statusCode: 503,
        cause: expect.objectContaining({ message: 'MCP registry unavailable' }),
      });
    });

    it('allows a server pin with no explicitly selected MCP tools', async () => {
      const serverPin = `${Constants.mcp_server}${Constants.mcp_delimiter}warehouse`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolDefinitions.mockResolvedValueOnce({
        toolDefinitions: [],
        toolRegistry: new Map(),
        hasDeferredTools: false,
        mcpResolution: { expectedToolCount: 0, resolvedToolCount: 0 },
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', tools: [serverPin] },
          definitionsOnly: true,
        }),
      ).resolves.toMatchObject({ toolDefinitions: [] });
    });

    it('allows partial MCP resolution when at least one expected tool is available', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolDefinitions.mockResolvedValueOnce({
        toolDefinitions: [{ name: 'list_sources_mcp_warehouse', toolType: 'mcp' }],
        toolRegistry: new Map(),
        hasDeferredTools: false,
        mcpResolution: { expectedToolCount: 2, resolvedToolCount: 1 },
      });

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: {
            id: 'agent_123',
            tools: [
              `list_sources${Constants.mcp_delimiter}warehouse`,
              `run_query${Constants.mcp_delimiter}warehouse`,
            ],
          },
          definitionsOnly: true,
        }),
      ).resolves.toMatchObject({
        toolDefinitions: [expect.objectContaining({ name: 'list_sources_mcp_warehouse' })],
      });
    });

    it('should filter MCP tool definitions when user lacks MCP server use permission', async () => {
      const { userCanUseMCPServers } = require('~/server/services/MCP');
      userCanUseMCPServers.mockResolvedValueOnce(false);

      const mcpTool = `search${Constants.mcp_delimiter}myserver`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, mcpTool] },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(regularTool);
      expect(callArgs.tools).not.toContain(mcpTool);
    });

    it('fails explicitly when MCP permission filtering removes every expected tool', async () => {
      const { userCanUseMCPServers } = require('~/server/services/MCP');
      userCanUseMCPServers.mockResolvedValueOnce(false);

      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: {
            id: 'agent_123',
            tools: [`run_query${Constants.mcp_delimiter}warehouse`],
          },
          definitionsOnly: true,
        }),
      ).rejects.toMatchObject({
        code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
        statusCode: 503,
      });
      expect(mockLoadToolDefinitions).not.toHaveBeenCalled();
    });

    it('should return actionsEnabled in the result', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool] },
        definitionsOnly: true,
      });

      expect(result.actionsEnabled).toBe(false);
    });

    it('emits separate MCP OAuth login steps and completion events for multiple pending servers', async () => {
      const req = createMockReq([AgentCapabilities.tools]);
      const res = { writableEnded: false };
      const servers = ['ELI', 'Vespa'];
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig([AgentCapabilities.tools]));
      mockResolveConfigServers.mockResolvedValue(
        Object.fromEntries(
          servers.map((serverName) => [
            serverName,
            {
              type: 'streamable-http',
              url: `https://mcp.example.com/${serverName}`,
              requiresOAuth: true,
            },
          ]),
        ),
      );

      mockLoadToolDefinitions
        .mockImplementationOnce(async (_args, deps) => {
          await deps.getOrFetchMCPServerTools(req.user.id, servers[0]);
          await deps.getOrFetchMCPServerTools(req.user.id, servers[1]);
          return {
            toolDefinitions: [],
            toolRegistry: new Map(),
            hasDeferredTools: false,
          };
        })
        .mockResolvedValue({
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        });

      reinitMCPServer.mockImplementation(
        async ({ serverName, returnOnOAuth, oauthStart, oauthEnd }) => {
          if (returnOnOAuth === false) {
            await oauthStart(`https://auth.example.com/${serverName}`);
            await oauthEnd();
            return { availableTools: { [`tool_${serverName}`]: {} } };
          }

          await oauthStart(`https://auth.example.com/${serverName}`);
          return { availableTools: null };
        },
      );

      await loadAgentTools({
        req,
        res,
        agent: {
          id: 'agent_123',
          tools: servers.map((server) => `search${Constants.mcp_delimiter}${server}`),
        },
        definitionsOnly: true,
      });

      const runStepEvents = mockSendEvent.mock.calls
        .map(([, event]) => event)
        .filter((event) => event.data?.stepDetails?.type === 'tool_calls');
      const deltaEvents = mockSendEvent.mock.calls
        .map(([, event]) => event)
        .filter((event) => event.data?.delta?.type === 'tool_calls');
      const authDeltaEvents = deltaEvents.filter((event) => event.data.delta.auth);
      const completionEvents = mockSendEvent.mock.calls
        .map(([, event]) => event)
        .filter((event) => event.data?.result?.tool_call?.name?.startsWith('oauth'));

      expect(runStepEvents.map((event) => event.data.index)).toEqual([0, 1]);
      expect(authDeltaEvents.map((event) => event.data.id)).toEqual([
        'step_oauth_login_ELI',
        'step_oauth_login_Vespa',
      ]);
      expect(completionEvents.map((event) => event.data.result.id)).toEqual([
        'step_oauth_login_ELI',
        'step_oauth_login_Vespa',
      ]);
    });

    it('does not count an empty post-OAuth catalog as tools available or reload definitions', async () => {
      const req = createMockReq([AgentCapabilities.tools]);
      const res = { writableEnded: false };
      const serverName = 'Empty-Catalog';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig([AgentCapabilities.tools]));
      mockResolveConfigServers.mockResolvedValue({
        [serverName]: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/empty',
          requiresOAuth: true,
        },
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockLoadToolDefinitions.mockImplementationOnce(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
          mcpResolution: { resolvedToolCount: 1 },
        };
      });
      reinitMCPServer
        .mockImplementationOnce(async ({ oauthStart }) => {
          await oauthStart(`https://auth.example.com/${serverName}`);
          return { availableTools: null };
        })
        .mockResolvedValueOnce({ availableTools: {} });

      const result = await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([]);
      expect(result.mcpAvailableTools).toEqual({});
      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
    });

    it('fences resumable MCP OAuth definition events to the owning job epoch', async () => {
      const req = createMockReq([AgentCapabilities.tools]);
      const res = { writableEnded: false };
      const serverName = 'Epoch-Server';
      const streamId = 'stream-epoch';
      const jobCreatedAt = 1234;
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig([AgentCapabilities.tools]));
      mockResolveConfigServers.mockResolvedValue({
        [serverName]: {
          type: 'streamable-http',
          url: `https://mcp.example.com/${serverName}`,
          requiresOAuth: true,
        },
      });
      mockLoadToolDefinitions
        .mockImplementationOnce(async (_args, deps) => {
          await deps.getOrFetchMCPServerTools(req.user.id, serverName);
          return {
            toolDefinitions: [],
            toolRegistry: new Map(),
            hasDeferredTools: false,
          };
        })
        .mockResolvedValue({
          toolDefinitions: [mcpTool],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        });
      reinitMCPServer.mockImplementation(async ({ returnOnOAuth, oauthStart, oauthEnd }) => {
        await oauthStart(`https://auth.example.com/${serverName}`);
        if (returnOnOAuth === false) {
          await oauthEnd();
          return { availableTools: { [mcpTool]: {} } };
        }
        return { availableTools: null };
      });

      await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
        streamId,
        jobCreatedAt,
      });

      expect(mockSendEvent).not.toHaveBeenCalled();
      expect(mockEmitChunk).toHaveBeenCalledTimes(3);
      expect(mockEmitChunk.mock.calls.map(([, event]) => event.event)).toEqual([
        'on_run_step',
        'on_run_step_delta',
        'on_run_step_completed',
      ]);
      for (const [emittedStreamId, , options] of mockEmitChunk.mock.calls) {
        expect(emittedStreamId).toBe(streamId);
        expect(options).toEqual({ expectedCreatedAt: jobCreatedAt });
      }
    });

    it('should not expose cached MCP tool definitions when the registry lookup fails', async () => {
      const serverName = 'PRIVATE-MCP-SERVER-NAME';
      const privateRegistryError = 'PRIVATE-MCP-REGISTRY-ERROR';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const warnSpy = jest
        .spyOn(require('@librechat/data-schemas').logger, 'warn')
        .mockImplementation(() => {});
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockImplementation(() => {
        throw new Error(privateRegistryError);
      });
      mockGetMCPServerTools.mockResolvedValue({
        [mcpTool]: {
          function: {
            name: mcpTool,
            description: 'Cached private search',
            parameters: {},
          },
        },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        const serverTools = await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: serverTools ? Object.keys(serverTools) : [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      const result = await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      const loggedText = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(result.toolDefinitions).toEqual([]);
      expect(mockGetMCPServerTools).not.toHaveBeenCalled();
      expect(loggedText).not.toContain(serverName);
      expect(loggedText).not.toContain(privateRegistryError);
      expect(warnSpy).toHaveBeenCalledWith(
        '[Tool Definitions] MCP registry unavailable; skipping tool exposure for one server',
      );
      warnSpy.mockRestore();
    });

    it('should re-emit pending MCP OAuth prompts when cached tool definitions exist', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/mcp',
        requiresOAuth: true,
      });
      mockGetMCPServerTools.mockResolvedValue({
        [mcpTool]: {
          function: {
            name: mcpTool,
            description: 'Cached search',
            parameters: {},
          },
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        createdAt: Date.now(),
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        const serverTools = await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: serverTools ? Object.keys(serverTools) : [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockImplementation(async ({ oauthStart }) => {
        await oauthStart(authorizationUrl);
        return { availableTools: { [mcpTool]: {} } };
      });

      const result = await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([mcpTool]);
      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        req.user.id,
        serverName,
        expect.objectContaining({ requiresOAuth: true }),
      );
      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          returnOnOAuth: false,
          oauthStart: expect.any(Function),
        }),
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
          }),
        }),
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step_delta',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
            delta: expect.objectContaining({
              auth: authorizationUrl,
            }),
          }),
        }),
      );
    });

    it('should not join in-flight MCP initialization before replaying pending OAuth prompts', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `${Constants.mcp_all}${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/mcp',
        requiresOAuth: true,
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        createdAt: Date.now(),
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockImplementation(async ({ oauthStart }) => {
        await oauthStart(authorizationUrl);
        return { availableTools: null };
      });

      await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        req.user.id,
        serverName,
        expect.objectContaining({ requiresOAuth: true }),
      );
      expect(reinitMCPServer).toHaveBeenCalledTimes(1);
      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          returnOnOAuth: false,
          oauthStart: expect.any(Function),
        }),
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step_delta',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
            delta: expect.objectContaining({
              auth: authorizationUrl,
            }),
          }),
        }),
      );
    });

    it('propagates owning-run cancellation from the pending OAuth fan-out', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `${Constants.mcp_all}${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      const controller = new AbortController();
      const reason = new Error('generation stopped');
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/mcp',
        requiresOAuth: true,
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        createdAt: Date.now(),
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );

      const loading = loadAgentTools({
        req,
        res,
        signal: controller.signal,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(reason);

      await expect(loading).rejects.toBe(reason);
    });

    it('should re-emit pending MCP OAuth prompts when selected MCP tools are already concrete', async () => {
      const serverName = `Google${Constants.mcp_delimiter}Workspace`;
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      /** A server whose own name contains the delimiter is only resolvable
       *  against the configured set, so the key boundary is unambiguous. */
      mockResolveConfigServers.mockResolvedValue({ [serverName]: {} });
      const res = { writableEnded: false };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        createdAt: Date.now(),
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockResolvedValue({
        toolDefinitions: [mcpTool],
        toolRegistry: new Map(),
        hasDeferredTools: false,
      });
      reinitMCPServer.mockImplementation(async ({ oauthStart }) => {
        await oauthStart(authorizationUrl);
        return { availableTools: { [mcpTool]: {} } };
      });

      const result = await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([mcpTool]);
      expect(mockGetMCPServerTools).not.toHaveBeenCalled();
      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          returnOnOAuth: false,
          oauthStart: expect.any(Function),
        }),
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step_delta',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
            delta: expect.objectContaining({
              auth: authorizationUrl,
            }),
          }),
        }),
      );
    });

    it('should emit stored pending MCP OAuth prompts before waiting on a silent in-flight join', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        createdAt: Date.now(),
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockResolvedValue({
        toolDefinitions: [mcpTool],
        toolRegistry: new Map(),
        hasDeferredTools: false,
      });
      reinitMCPServer.mockResolvedValue({ availableTools: null });

      const result = await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([mcpTool]);
      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          returnOnOAuth: false,
          oauthStart: expect.any(Function),
        }),
      );
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step_delta',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
            delta: expect.objectContaining({
              auth: authorizationUrl,
            }),
          }),
        }),
      );
    });

    it('should preserve OAuth URLs emitted while discovering MCP tools before a silent wait join', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/mcp',
        requiresOAuth: true,
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer
        .mockImplementationOnce(async ({ oauthStart }) => {
          await oauthStart(authorizationUrl, { expiresAt: Date.now() + 60_000 });
          return { availableTools: null };
        })
        .mockResolvedValue({ availableTools: null });

      await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(reinitMCPServer).toHaveBeenCalledTimes(2);
      expect(mockSendEvent).toHaveBeenCalledWith(
        res,
        expect.objectContaining({
          event: 'on_run_step_delta',
          data: expect.objectContaining({
            id: `step_oauth_login_${serverName}`,
            delta: expect.objectContaining({
              auth: authorizationUrl,
            }),
          }),
        }),
      );
    });

    it('should pass request body context into MCP tool definition reinitialization', async () => {
      const serverName = 'Body-Scoped';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      req.body = { conversationId: 'conv-123', messageId: 'msg-123' };

      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockResolvedValue({ availableTools: null });

      await loadAgentTools({
        req,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          requestBody: req.body,
        }),
      );
      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        req.user.id,
        serverName,
        expect.objectContaining({
          url: expect.stringContaining('LIBRECHAT_BODY_MESSAGEID'),
        }),
      );
    });

    it('forwards OBO context through forced MCP catalog refreshes', async () => {
      const serverName = 'OBO-Refresh';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      req.user = {
        id: 'user_123',
        provider: 'openid',
        openidId: 'oidc-sub-123',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      };

      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/obo',
        obo: { scopes: 'api://obo/Mcp.Tools.ReadWrite' },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, dependencies) => {
        await dependencies.refreshMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockResolvedValue({ availableTools: {} });

      await loadAgentTools({
        req,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          forceNew: true,
          upstreamTokenProvider: expect.any(Function),
          oboIdentityContext: expect.objectContaining({
            appUserId: 'user_123',
            openidSubject: 'oidc-sub-123',
            tenantId: 'tenant-1',
            openidIssuer: 'https://issuer.example.com',
          }),
        }),
      );
    });

    it('uses host-supplied renewable upstream credentials when loading tools', async () => {
      const serverName = 'Scheduled-OBO';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      req.body = { conversationId: 'conv-123', messageId: 'msg-123' };
      req.user = {
        id: 'user_123',
        provider: 'openid',
        openidId: 'oidc-sub-123',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      };
      const scheduledProvider = jest.fn().mockResolvedValue({ access_token: 'renewed-token' });

      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/obo',
        obo: { scopes: 'api://obo/Mcp.Tools.ReadWrite' },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, dependencies) => {
        await dependencies.refreshMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockResolvedValue({ availableTools: {} });
      const signal = new AbortController().signal;

      await loadAgentTools({
        req,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
        signal,
        upstreamTokenProvider: scheduledProvider,
      });

      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          forceNew: true,
          upstreamTokenProvider: scheduledProvider,
        }),
      );
    });

    it('keeps a deferred OBO resolver separate from direct-bearer credentials', async () => {
      const serverName = 'Scheduled-OBO';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const upstreamTokenProviderResolver = jest.fn();

      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/obo',
        obo: { scopes: 'api://obo/Mcp.Tools.ReadWrite' },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, dependencies) => {
        await dependencies.refreshMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockResolvedValue({ availableTools: {} });

      await loadAgentTools({
        req,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
        upstreamTokenProviderResolver,
      });

      expect(reinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          forceNew: true,
          upstreamTokenProvider: undefined,
          upstreamTokenProviderResolver,
        }),
      );
      expect(upstreamTokenProviderResolver).not.toHaveBeenCalled();
    });

    it('returns run-scoped MCP tool definitions for request-scoped servers', async () => {
      const serverName = 'ClickHouse';
      const mcpTool = `list_tables${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      req.body = { conversationId: 'conv-123', messageId: 'msg-123' };
      const availableTools = {
        [mcpTool]: {
          function: {
            name: mcpTool,
            description: 'List tables',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        const serverTools = await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: serverTools ? Object.keys(serverTools) : [],
          toolRegistry: new Map([[mcpTool, { name: mcpTool }]]),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer.mockResolvedValue({ availableTools });

      const result = await loadAgentTools({
        req,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([mcpTool]);
      expect(result.mcpAvailableTools).toEqual({ [serverName]: availableTools });
      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        req.user.id,
        serverName,
        expect.objectContaining({
          url: expect.stringContaining('LIBRECHAT_BODY_MESSAGEID'),
        }),
      );
    });

    it('should preserve pending-flow expiry for OAuth URLs captured during discovery', async () => {
      const serverName = 'Google-Workspace';
      const authorizationUrl = 'https://auth.example.com/Google-Workspace';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      const res = { writableEnded: false };
      const createdAt = Date.now() - 45_000;
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockGetServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://demo.librechat.ai/mcp',
        requiresOAuth: true,
      });
      mockGetMCPServerTools.mockResolvedValue(null);
      mockFlowManager.getFlowState.mockResolvedValueOnce(null).mockResolvedValueOnce({
        status: 'PENDING',
        createdAt,
        metadata: { authorizationUrl },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });
      reinitMCPServer
        .mockImplementationOnce(async ({ oauthStart }) => {
          await oauthStart(authorizationUrl);
          return { availableTools: null };
        })
        .mockResolvedValue({ availableTools: null });

      await loadAgentTools({
        req,
        res,
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      const authDeltaEvent = mockSendEvent.mock.calls
        .map(([, event]) => event)
        .find((event) => event.data?.delta?.auth === authorizationUrl);
      expect(authDeltaEvent?.data.delta.expires_at).toBe(createdAt + PENDING_STALE_MS);
    });

    it('should use request-scoped MCP config before falling back to the registry', async () => {
      const serverName = 'config-server';
      const mcpTool = `search${Constants.mcp_delimiter}${serverName}`;
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockResolveConfigServers.mockResolvedValue({
        [serverName]: {
          type: 'streamable-http',
          url: 'https://config.example.com/mcp',
          customUserVars: {
            TOKEN: { title: 'Token', description: 'Token' },
          },
        },
      });
      mockGetUserMCPAuthMap.mockResolvedValue({
        [`${Constants.mcp_prefix}${serverName}`]: { TOKEN: 'secret' },
      });
      mockGetMCPServerTools.mockResolvedValue({
        [mcpTool]: {
          function: {
            name: mcpTool,
            description: 'Config search',
            parameters: {},
          },
        },
      });
      mockLoadToolDefinitions.mockImplementation(async (params, deps) => {
        const serverTools = await deps.getOrFetchMCPServerTools(params.userId, serverName);
        return {
          toolDefinitions: serverTools ? Object.keys(serverTools) : [],
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      const result = await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [mcpTool] },
        definitionsOnly: true,
      });

      expect(result.toolDefinitions).toEqual([mcpTool]);
      expect(mockGetServerConfig).not.toHaveBeenCalled();
      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        req.user.id,
        serverName,
        expect.objectContaining({ url: 'https://config.example.com/mcp' }),
      );
    });
  });

  describe('loadAgentTools (definitionsOnly=false) — action tool filtering', () => {
    const actionToolName = `get_weather${actionDelimiter}api_example_com`;
    const regularTool = 'calculator';

    it('threads the owning job epoch into web-search attachment callbacks', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      const res = {};
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res,
        streamId: 'conversation-1',
        jobCreatedAt: 1234,
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        definitionsOnly: false,
      });

      expect(createOnSearchResults).toHaveBeenCalledWith(res, 'conversation-1', 1234);
    });

    it('should not load action sets when actions capability is disabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, actionToolName] },
        definitionsOnly: false,
      });

      expect(mockLoadActionSets).not.toHaveBeenCalled();
    });

    it('should load action sets when actions capability is enabled and action tools present', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [regularTool, actionToolName] },
        definitionsOnly: false,
      });

      expect(mockLoadActionSets).toHaveBeenCalledWith({ agentId: 'agent_123' });
    });

    it('blocks persisted action metadata before generic tool initialization', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      req.config.filters = {
        actionMetadata: {
          pii: {
            fields: ['raw_spec'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_private_before_generic',
          metadata: {
            domain: 'https://api.example.com',
            raw_spec: '{"description":"PRIVATE-ACTION"}',
          },
        },
      ]);

      await expect(
        loadAgentTools({
          req,
          res: {},
          agent: { id: 'agent_123', tools: [regularTool, actionToolName] },
          definitionsOnly: false,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'action_metadata',
          field: 'raw_spec',
        },
      });

      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
      expect(mockDomainParser).not.toHaveBeenCalled();
      expect(mockCreateActionTool).not.toHaveBeenCalled();
    });
  });

  describe('loadToolsForExecution — action tool gating', () => {
    it('should preserve the remote-agent permission boundary for deferred tool loading', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.file_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search] },
        toolNames: [Tools.file_search],
        agentResourceType: ResourceType.REMOTE_AGENT,
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            agentResourceType: ResourceType.REMOTE_AGENT,
          }),
        }),
      );
    });

    it('threads the normalized MCP body through deferred tool loading', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      const requestBody = {
        messageId: 'response-1',
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        requestBody,
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        toolNames: [Tools.web_search],
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ requestBody }),
        }),
      );
      expect(result.configurable.requestBody).toBe(requestBody);
    });

    const actionToolName = `get_weather${actionDelimiter}api_example_com`;
    const regularTool = Tools.web_search;

    it('threads the owning job epoch into web-search attachment callbacks', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      const res = {};
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadToolsForExecution({
        req,
        res,
        streamId: 'conversation-1',
        jobCreatedAt: 1234,
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        toolNames: [Tools.web_search],
        actionsEnabled: false,
      });

      expect(createOnSearchResults).toHaveBeenCalledWith(res, 'conversation-1', 1234);
    });

    it('does not load code execution tools that were not registered for the agent', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.web_search,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const toolRegistry = new Map([[Tools.web_search, { name: Tools.web_search }]]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_without_code', tools: [Tools.web_search] },
        toolNames: [AgentConstants.BASH_TOOL, Tools.execute_code],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(result.loadedTools.map((tool) => tool.name)).toEqual([]);
      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
    });

    it('keeps stateless and stateful agents on isolated execution profiles in one run', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      req.body = { conversationId: 'conversation-1' };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      process.env.LIBRECHAT_CODE_BASEURL = 'http://code-default.test/v1';
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';

      try {
        const stateless = await loadToolsForExecution({
          req,
          res: {},
          agent: { id: 'stateless-agent', tools: [Tools.execute_code] },
          toolNames: [],
        });
        const stateful = await loadToolsForExecution({
          req,
          res: {},
          agent: {
            id: 'stateful-agent',
            tools: [Tools.execute_code],
            stateful_code_sessions: true,
            stateful_code_environment: 'agent-user',
          },
          toolNames: [],
        });

        expect(stateless.configurable.codeExecutionContext).toEqual({
          baseUrl: 'http://code-default.test/v1',
          codeSessionKey: 'execute_code',
          executionProfile: 'default',
          statefulSessions: false,
        });
        expect(stateful.configurable.codeExecutionContext).toEqual({
          baseUrl: 'http://code-stateful.test/v1',
          codeSessionKey: 'execute_code:stateful:v2:agent-user:7c684f0773d9642c122f67aa30e9e0f4',
          executionProfile: 'stateful',
          runtimeSessionHint: 'v2:agent-user:7c684f0773d9642c122f67aa30e9e0f4',
          statefulSessions: true,
        });
      } finally {
        delete process.env.LIBRECHAT_CODE_BASEURL;
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      }
    });

    it.each(['read_file', 'create_file', 'edit_file'])(
      'resolves stateful routing for standalone %s with the controller conversation ID',
      async (toolName) => {
        const capabilities = [
          AgentCapabilities.tools,
          AgentCapabilities.execute_code,
          AgentCapabilities.stateful_code_sessions,
        ];
        const req = createMockReq(capabilities);
        req.body = {};
        mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
        process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';

        try {
          const result = await loadToolsForExecution({
            req,
            res: {},
            conversationId: 'resolved-api-conversation',
            agent: {
              id: 'stateful-agent',
              tools: [Tools.execute_code],
              stateful_code_sessions: true,
              stateful_code_environment: 'conversation',
            },
            toolNames: [toolName],
            actionsEnabled: false,
          });

          expect(result.configurable.codeExecutionContext.executionProfile).toBe('stateful');
          expect(mockResolveCodeExecutionContext).toHaveBeenLastCalledWith(
            expect.objectContaining({
              statefulSessions: true,
              conversationId: 'resolved-api-conversation',
            }),
          );
        } finally {
          delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
        }
      },
    );

    it.each(['read_file', 'create_file', 'edit_file'])(
      'keeps standalone %s on the selected attached worker',
      async (toolName) => {
        const capabilities = [
          AgentCapabilities.tools,
          AgentCapabilities.execute_code,
          AgentCapabilities.stateful_code_sessions,
        ];
        const req = createMockReq(capabilities);
        req.config.endpoints.agents.statefulCodeSessions = {
          environments: [
            {
              id: 'personal-machine',
              type: 'attached',
              baseURL: 'https://attached-code.test/v1',
              workerId: 'worker-personal',
            },
          ],
        };
        mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
        mockResolveCodeExecutionContext.mockImplementationOnce(
          jest.requireActual('@librechat/api').resolveCodeExecutionContext,
        );

        const result = await loadToolsForExecution({
          req,
          res: {},
          conversationId: 'resolved-api-conversation',
          agent: {
            id: 'attached-agent',
            tools: [Tools.execute_code],
            stateful_code_sessions: true,
            code_environment_id: 'personal-machine',
          },
          toolNames: [toolName],
          actionsEnabled: false,
        });

        expect(result.configurable.codeExecutionContext).toEqual(
          expect.objectContaining({
            baseUrl: 'https://attached-code.test/v1',
            executionProfile: 'stateful',
            environmentType: 'attached',
            environmentId: 'personal-machine',
            bridgeWorkerId: 'worker-personal',
          }),
        );
      },
    );

    it('preserves attached routing when workspace search is the only requested tool', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';

      try {
        const result = await loadToolsForExecution({
          req,
          res: {},
          agent: {
            id: 'stateful-agent',
            tools: [Tools.execute_code],
            stateful_code_sessions: true,
            stateful_code_environment: 'agent-user',
          },
          toolNames: ['search_workspace'],
          actionsEnabled: false,
        });

        expect(result.configurable.codeExecutionContext.executionProfile).toBe('stateful');
        expect(mockResolveCodeExecutionContext).toHaveBeenLastCalledWith(
          expect.objectContaining({ statefulSessions: true, environment: 'agent-user' }),
        );
      } finally {
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      }
    });

    it('preserves attached routing when workspace listing is the only requested tool', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';

      try {
        const result = await loadToolsForExecution({
          req,
          res: {},
          agent: {
            id: 'stateful-agent',
            tools: [Tools.execute_code],
            stateful_code_sessions: true,
            stateful_code_environment: 'agent-user',
          },
          toolNames: ['list_workspace_files'],
          actionsEnabled: false,
        });

        expect(result.configurable.codeExecutionContext.executionProfile).toBe('stateful');
        expect(mockResolveCodeExecutionContext).toHaveBeenLastCalledWith(
          expect.objectContaining({ statefulSessions: true, environment: 'agent-user' }),
        );
      } finally {
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      }
    });

    it('loads bash execution through the attached worker transport', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      req.body = {
        codeWorkspaces: [{ environmentId: 'personal-machine', workspaceId: 'project-a' }],
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockResolveCodeExecutionContext.mockReturnValueOnce({
        baseUrl: 'http://attached-code.test/v1',
        codeSessionKey: 'execute_code:stateful:attached',
        executionProfile: 'stateful',
        statefulSessions: true,
        environmentType: 'attached',
        environmentId: 'personal-machine',
        bridgeWorkerId: 'worker-abc',
        codeEnvironmentConfigSchema: { limits: { maxCommandTimeoutMs: 120000, maxQueueWaitMs: 0 } },
      });
      const toolRegistry = new Map([
        [AgentConstants.BASH_TOOL, { name: AgentConstants.BASH_TOOL }],
      ]);

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: {
          id: 'attached-agent',
          tools: [Tools.execute_code],
          stateful_code_sessions: true,
          stateful_code_environment: 'agent-user',
          git_identity: { name: 'LibreChat Agent', email: 'agent@example.com' },
        },
        toolNames: [AgentConstants.BASH_TOOL],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(mockCreateAttachedWorkspaceBashTool).toHaveBeenCalledWith({
        authHeaders: expect.any(Function),
        baseUrl: 'http://attached-code.test/v1',
        workspaceId: 'project-a',
        gitIdentity: { name: 'LibreChat Agent', email: 'agent@example.com' },
        maxTimeoutMs: 120000,
        maxQueueWaitMs: 0,
      });
      expect(mockResolveCodeExecutionWorkspaceContext).toHaveBeenCalledWith(
        expect.objectContaining({ requestedSelections: req.body.codeWorkspaces }),
      );
      expect(result.loadedTools).toContainEqual({ name: AgentConstants.BASH_TOOL });
    });

    it('resolves stateful routing when handle_skill is the only requested tool', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'http://code-stateful.test/v1';

      try {
        const result = await loadToolsForExecution({
          req,
          res: {},
          agent: {
            id: 'stateful-agent',
            tools: [Tools.execute_code],
            stateful_code_sessions: true,
            stateful_code_environment: 'agent-user',
          },
          toolNames: [AgentConstants.SKILL_TOOL],
          actionsEnabled: false,
        });

        expect(result.configurable.codeExecutionContext.executionProfile).toBe('stateful');
        expect(mockResolveCodeExecutionContext).toHaveBeenLastCalledWith(
          expect.objectContaining({ statefulSessions: true, environment: 'agent-user' }),
        );
      } finally {
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      }
    });

    it('loads bash PTC under the legacy programmatic tool name when code capabilities are enabled', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const toolRegistry = new Map([['custom_tool', { name: 'custom_tool' }]]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(result.loadedTools.map((tool) => tool.name)).toEqual([
        Constants.PROGRAMMATIC_TOOL_CALLING,
      ]);
      expect(result.configurable.toolRegistry).toBe(toolRegistry);
      expect(result.configurable.ptcToolMap.size).toBe(0);
    });

    it('passes run-scoped MCP tool definitions into PTC execution loading', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const serverName = 'ClickHouse';
      const mcpTool = `list_tables${Constants.mcp_delimiter}${serverName}`;
      const mcpAvailableTools = {
        [serverName]: {
          [mcpTool]: {
            function: {
              name: mcpTool,
              description: 'List tables',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      };
      const toolRegistry = new Map([
        [mcpTool, { name: mcpTool, allowed_callers: ['code_execution'] }],
      ]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        mcpAvailableTools,
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [mcpTool],
          options: expect.objectContaining({
            mcpAvailableTools,
          }),
        }),
      );
    });

    it('loads only code_execution tools into the PTC execution map', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const programmaticTool = {
        name: 'programmatic_tool',
        invoke: jest.fn(),
      };
      const toolRegistry = new Map([
        [
          programmaticTool.name,
          { name: programmaticTool.name, allowed_callers: ['code_execution'] },
        ],
        ['direct_tool', { name: 'direct_tool', allowed_callers: ['direct'] }],
      ]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [programmaticTool],
        toolContextMap: {},
      });

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({ tools: ['programmatic_tool'] }),
      );
      expect([...result.configurable.ptcToolMap.keys()]).toEqual(['programmatic_tool']);
    });

    it('intersects PTC loading with the SDK live caller projection', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const activeTool = { name: 'active_programmatic_tool', invoke: jest.fn() };
      const deferredTool = { name: 'deferred_programmatic_tool', invoke: jest.fn() };
      const toolRegistry = new Map([
        [activeTool.name, { name: activeTool.name, allowed_callers: ['code_execution'] }],
        [
          deferredTool.name,
          {
            name: deferredTool.name,
            allowed_callers: ['code_execution'],
            defer_loading: true,
          },
        ],
      ]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [activeTool],
        toolContextMap: {},
      });

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        callerCapabilityProjection: {
          version: 1,
          directToolNames: [],
          codeExecutionToolNames: [activeTool.name],
          directOnlyToolNames: [],
          codeExecutionOnlyToolNames: [activeTool.name],
        },
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({ tools: [activeTool.name] }),
      );
      expect([...result.configurable.ptcToolMap.keys()]).toEqual([activeTool.name]);
    });

    it('treats an empty versioned caller projection as authoritative', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const toolRegistry = new Map([
        [
          'deferred_programmatic_tool',
          { name: 'deferred_programmatic_tool', allowed_callers: ['code_execution'] },
        ],
      ]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        callerCapabilityProjection: {
          version: 1,
          directToolNames: [],
          codeExecutionToolNames: [],
          directOnlyToolNames: [],
          codeExecutionOnlyToolNames: [],
        },
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).not.toHaveBeenCalled();
      expect(result.configurable.ptcToolMap).toEqual(new Map());
    });

    it('falls back to registry projection for unknown snapshot versions', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const programmaticTool = { name: 'programmatic_tool', invoke: jest.fn() };
      const toolRegistry = new Map([
        [
          programmaticTool.name,
          { name: programmaticTool.name, allowed_callers: ['code_execution'] },
        ],
      ]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockLoadToolsUtil.mockResolvedValue({
        loadedTools: [programmaticTool],
        toolContextMap: {},
      });

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        callerCapabilityProjection: {
          version: 2,
          directToolNames: [],
          codeExecutionToolNames: [],
          directOnlyToolNames: [],
          codeExecutionOnlyToolNames: [],
        },
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({ tools: [programmaticTool.name] }),
      );
    });

    it('does not lazily load PTC for an attached worker without confirmed stateful support', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
        AgentCapabilities.stateful_code_sessions,
      ];
      const req = createMockReq(capabilities);
      req.config.endpoints.agents.statefulCodeSessions = {
        environments: [
          {
            id: 'personal',
            name: 'Personal',
            type: 'attached',
            owner: 'deployment',
            baseURL: 'https://attached.example',
            workerId: 'worker',
          },
        ],
      };
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
      mockResolveCodeExecutionContext.mockImplementationOnce(
        jest.requireActual('@librechat/api').resolveCodeExecutionContext,
      );
      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: {
          id: 'agent_ptc',
          tools: [Tools.execute_code],
          stateful_code_sessions: true,
          code_environment_id: 'personal',
        },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry: new Map(),
        actionsEnabled: false,
      });
      expect(result.loadedTools.map((tool) => tool.name)).not.toContain(
        Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
      );
    });

    it.each([
      { statefulWorkspace: false, runtimes: ['bash'], supported: false },
      { statefulWorkspace: true, runtimes: ['py'], supported: false },
      { statefulWorkspace: true, runtimes: ['bash'], supported: false },
    ])(
      'suppresses workspace-unaware attached PTC: stateful=$statefulWorkspace runtimes=$runtimes',
      async ({ statefulWorkspace, runtimes, supported }) => {
        const capabilities = [
          AgentCapabilities.tools,
          AgentCapabilities.programmatic_tools,
          AgentCapabilities.execute_code,
          AgentCapabilities.stateful_code_sessions,
        ];
        const req = createMockReq(capabilities);
        const environment = {
          id: 'personal',
          name: 'Personal',
          type: 'attached',
          owner: 'deployment',
          baseURL: 'https://attached.example',
          workerId: `worker-${statefulWorkspace}-${runtimes[0]}`,
          pairing: {
            workerId: `worker-${statefulWorkspace}-${runtimes[0]}`,
            tokenEnv: 'TEST_PTC_DEPLOYMENT_TOKEN',
          },
        };
        req.config.endpoints.agents.statefulCodeSessions = { environments: [environment] };
        mockGetAppConfig.mockResolvedValueOnce({
          endpoints: { agents: { statefulCodeSessions: { environments: [environment] } } },
        });
        mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
        mockResolveCodeExecutionContext.mockImplementationOnce(
          jest.requireActual('@librechat/api').resolveCodeExecutionContext,
        );
        process.env.TEST_PTC_DEPLOYMENT_TOKEN = `deployment-token-${statefulWorkspace}`;
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              workerId: environment.workerId,
              online: true,
              ready: true,
              leaseExpiresInMs: 45_000,
              capabilities: { statefulWorkspace, sandboxProfile: 'native-srt', runtimes },
            }),
          ),
        );
        try {
          const result = await loadToolsForExecution({
            req,
            res: {},
            agent: {
              id: 'agent_ptc',
              tools: [Tools.execute_code],
              stateful_code_sessions: true,
              code_environment_id: 'personal',
            },
            toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
            toolRegistry: new Map(),
            actionsEnabled: false,
          });
          expect(
            result.loadedTools.some(
              (tool) => tool.name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
            ),
          ).toBe(supported);
          expect(mockGetAppConfig).toHaveBeenCalledTimes(1);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
          fetchSpy.mockRestore();
          delete process.env.TEST_PTC_DEPLOYMENT_TOKEN;
        }
      },
    );

    it('does not load PTC when programmatic tools capability is disabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.execute_code];
      const req = createMockReq(capabilities);
      const toolRegistry = new Map([['custom_tool', { name: 'custom_tool' }]]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [Tools.execute_code] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(result.loadedTools.map((tool) => tool.name)).toEqual([]);
      expect(result.configurable.toolRegistry).toBeUndefined();
      expect(result.configurable.ptcToolMap).toBeUndefined();
    });

    it('does not load PTC when agent did not request execute_code', async () => {
      const capabilities = [
        AgentCapabilities.tools,
        AgentCapabilities.programmatic_tools,
        AgentCapabilities.execute_code,
      ];
      const req = createMockReq(capabilities);
      const toolRegistry = new Map([['custom_tool', { name: 'custom_tool' }]]);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_ptc', tools: [] },
        toolNames: [Constants.BASH_PROGRAMMATIC_TOOL_CALLING],
        toolRegistry,
        actionsEnabled: false,
      });

      expect(result.loadedTools.map((tool) => tool.name)).toEqual([]);
      expect(result.configurable.toolRegistry).toBeUndefined();
      expect(result.configurable.ptcToolMap).toBeUndefined();
    });

    it('should skip action tool loading when actionsEnabled=false', async () => {
      const req = createMockReq([]);
      req.config = {};

      const result = await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123' },
        toolNames: [regularTool, actionToolName],
        actionsEnabled: false,
      });

      expect(mockLoadActionSets).not.toHaveBeenCalled();
      expect(result.loadedTools).toBeDefined();
    });

    it('should load action tools when actionsEnabled=true', async () => {
      const req = createMockReq([AgentCapabilities.actions]);
      req.config = {};

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123' },
        toolNames: [actionToolName],
        actionsEnabled: true,
      });

      expect(mockLoadActionSets).toHaveBeenCalledWith({ agentId: 'agent_123' });
    });

    it('blocks decrypted persisted action secrets before execution-time domain work', async () => {
      const req = createMockReq([AgentCapabilities.actions]);
      req.config.filters = {
        actionMetadata: {
          pii: {
            fields: ['oauth_client_secret'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      };
      const metadata = {
        domain: 'https://api.example.com',
        raw_spec: '{}',
        oauth_client_secret: 'encrypted-value',
      };
      mockLoadActionSets.mockResolvedValue([
        {
          action_id: 'action_private_auth',
          metadata,
        },
      ]);
      mockDecryptMetadata.mockResolvedValue({
        ...metadata,
        oauth_client_secret: 'PRIVATE-OAUTH',
      });

      await expect(
        loadToolsForExecution({
          req,
          res: {},
          agent: { id: 'agent_123' },
          toolNames: [actionToolName],
          actionsEnabled: true,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source: 'action_metadata',
          field: 'oauth_client_secret',
        },
      });

      expect(mockDecryptMetadata).toHaveBeenCalledWith(metadata);
      expect(mockDomainParser).not.toHaveBeenCalled();
      expect(mockCreateActionTool).not.toHaveBeenCalled();
    });

    it('should resolve actionsEnabled from capabilities when not explicitly provided', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123' },
        toolNames: [actionToolName],
      });

      expect(mockGetEndpointsConfig).toHaveBeenCalled();
      expect(mockLoadActionSets).not.toHaveBeenCalled();
    });

    it('should not call loadActionSets when there are no action tools', async () => {
      const req = createMockReq([AgentCapabilities.actions]);
      req.config = {};

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123' },
        toolNames: [regularTool],
        actionsEnabled: true,
      });

      expect(mockLoadActionSets).not.toHaveBeenCalled();
    });
  });

  describe('checkCapability logic', () => {
    const createCheckCapability = (enabledCapabilities, logger = { warn: jest.fn() }) => {
      return (capability) => {
        const enabled = enabledCapabilities.has(capability);
        if (!enabled) {
          const isToolCapability = [
            AgentCapabilities.file_search,
            AgentCapabilities.execute_code,
            AgentCapabilities.web_search,
          ].includes(capability);
          const suffix = isToolCapability ? ' despite configured tool.' : '.';
          logger.warn(`Capability "${capability}" disabled${suffix}`);
        }
        return enabled;
      };
    };

    it('should return true when capability is enabled', () => {
      const enabledCapabilities = new Set([AgentCapabilities.deferred_tools]);
      const checkCapability = createCheckCapability(enabledCapabilities);

      expect(checkCapability(AgentCapabilities.deferred_tools)).toBe(true);
    });

    it('should return false when capability is not enabled', () => {
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities);

      expect(checkCapability(AgentCapabilities.deferred_tools)).toBe(false);
    });

    it('should log warning with "despite configured tool" for tool capabilities', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.file_search);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.execute_code);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.web_search);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('despite configured tool'));
    });

    it('should log warning without "despite configured tool" for non-tool capabilities', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.deferred_tools);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "deferred_tools" disabled.'),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('despite configured tool'),
      );

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.tools);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "tools" disabled.'),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('despite configured tool'),
      );

      logger.warn.mockClear();
      checkCapability(AgentCapabilities.actions);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Capability "actions" disabled.'),
      );
    });

    it('should not log warning when capability is enabled', () => {
      const logger = { warn: jest.fn() };
      const enabledCapabilities = new Set([
        AgentCapabilities.deferred_tools,
        AgentCapabilities.file_search,
      ]);
      const checkCapability = createCheckCapability(enabledCapabilities, logger);

      checkCapability(AgentCapabilities.deferred_tools);
      checkCapability(AgentCapabilities.file_search);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('defaultAgentCapabilities', () => {
    it('should include deferred_tools capability by default', () => {
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.deferred_tools);
    });

    it('should include all expected default capabilities', () => {
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.execute_code);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.file_search);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.web_search);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.artifacts);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.actions);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.context);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.ask_user_question);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.tools);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.chain);
      expect(defaultAgentCapabilities).toContain(AgentCapabilities.ocr);
    });
  });

  describe('userMCPAuthMap gating', () => {
    const shouldFetchMCPAuth = (tools) =>
      tools?.some((t) => t.includes(Constants.mcp_delimiter)) ?? false;

    it('should return true when agent has MCP tools', () => {
      const tools = ['web_search', `search${Constants.mcp_delimiter}my-mcp-server`, 'calculator'];
      expect(shouldFetchMCPAuth(tools)).toBe(true);
    });

    it('should return false when agent has no MCP tools', () => {
      const tools = ['web_search', 'calculator', 'code_interpreter'];
      expect(shouldFetchMCPAuth(tools)).toBe(false);
    });

    it('should return false when tools is empty', () => {
      expect(shouldFetchMCPAuth([])).toBe(false);
    });

    it('should return false when tools is undefined', () => {
      expect(shouldFetchMCPAuth(undefined)).toBe(false);
    });

    it('should return false when tools is null', () => {
      expect(shouldFetchMCPAuth(null)).toBe(false);
    });

    it('should detect MCP tools with different server names', () => {
      const tools = [
        `listFiles${Constants.mcp_delimiter}file-server`,
        `query${Constants.mcp_delimiter}db-server`,
      ];
      expect(shouldFetchMCPAuth(tools)).toBe(true);
    });

    it('should return true even when only one tool is MCP', () => {
      const tools = [
        'web_search',
        'calculator',
        'code_interpreter',
        `echo${Constants.mcp_delimiter}test-server`,
      ];
      expect(shouldFetchMCPAuth(tools)).toBe(true);
    });
  });

  describe('deferredToolsEnabled integration', () => {
    it('should correctly determine deferredToolsEnabled from capabilities set', () => {
      const createCheckCapability = (enabledCapabilities) => {
        return (capability) => enabledCapabilities.has(capability);
      };

      const withDeferred = new Set([AgentCapabilities.deferred_tools, AgentCapabilities.tools]);
      const checkWithDeferred = createCheckCapability(withDeferred);
      expect(checkWithDeferred(AgentCapabilities.deferred_tools)).toBe(true);

      const withoutDeferred = new Set([AgentCapabilities.tools, AgentCapabilities.actions]);
      const checkWithoutDeferred = createCheckCapability(withoutDeferred);
      expect(checkWithoutDeferred(AgentCapabilities.deferred_tools)).toBe(false);
    });

    it('should use defaultAgentCapabilities when no capabilities configured', () => {
      const endpointsConfig = {};
      const enabledCapabilities = new Set(
        endpointsConfig?.capabilities ?? defaultAgentCapabilities,
      );

      expect(enabledCapabilities.has(AgentCapabilities.deferred_tools)).toBe(true);
    });
  });

  describe('multi-action domain collision regression', () => {
    // Two distinct OpenAPI Actions whose `servers[0].url` resolves to the
    // same hostname must both contribute their tools to the agent. The
    // previous implementation indexed processed action sets by encoded
    // domain, so the second action overwrote the first in the map and one
    // action's tools silently disappeared from the LLM payload.
    //
    // The encoded domain we use as the lookup key for the action sets is
    // mocked to a fixed string for both actions to make the collision
    // condition deterministic without depending on the real base64
    // truncation rules.
    const SHARED_DOMAIN = 'https://api.example.com';
    const ENCODED_DOMAIN = 'shared_dom';
    const LEGACY_ENCODED_DOMAIN = 'legacy_dom';

    const buildSpec = (operationId, path) =>
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: `Mock ${operationId}`, version: '1.0.0' },
        servers: [{ url: SHARED_DOMAIN }],
        paths: {
          [path]: {
            get: {
              operationId,
              summary: `Mock ${operationId}`,
              responses: {
                200: {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'object' } } },
                },
              },
            },
          },
        },
      });

    const actionA = {
      action_id: 'action_a',
      metadata: {
        domain: SHARED_DOMAIN,
        raw_spec: buildSpec('echoMessage', '/echo'),
      },
    };
    const actionB = {
      action_id: 'action_b',
      metadata: {
        domain: SHARED_DOMAIN,
        raw_spec: buildSpec('listItems', '/items'),
      },
    };

    const toolNameA = `echoMessage${actionDelimiter}${ENCODED_DOMAIN}`;
    const toolNameB = `listItems${actionDelimiter}${ENCODED_DOMAIN}`;

    beforeEach(() => {
      // Both actions share a hostname → both call sites get the same encoded
      // value back. This is precisely the collision shape that triggered
      // the bug in production.
      mockDomainParser.mockResolvedValue(ENCODED_DOMAIN);
      mockLegacyDomainEncode.mockReturnValue(LEGACY_ENCODED_DOMAIN);
      mockDecryptMetadata.mockImplementation(async (metadata) => metadata);
      mockCreateActionTool.mockImplementation(async ({ name, requestBuilder }) => ({
        name,
        // Surface the request builder identity on the returned tool so
        // assertions can verify each tool was wired to the correct action's
        // builder, not its sibling's.
        _builder: requestBuilder,
        // Resolve instead of returning undefined — processRequiredActions
        // chains `.then(handleToolOutput)` directly onto this call, which
        // would throw synchronously on an undefined return and mask the
        // test as a simulated runtime crash.
        _call: jest.fn().mockResolvedValue('{"status":"ok"}'),
        schema: {},
        description: '',
      }));
    });

    const expectBothActionsResolved = (calls) => {
      const callsByName = new Map(calls.map((c) => [c[0].name, c[0]]));
      expect(callsByName.has(toolNameA)).toBe(true);
      expect(callsByName.has(toolNameB)).toBe(true);
      // Each tool's request builder must come from the matching action's
      // own parsed spec — not the sibling's. The previous bug would either
      // route both to the same action's builders (and drop one as
      // undefined) or silently skip one entirely.
      const builderA = callsByName.get(toolNameA).requestBuilder;
      const builderB = callsByName.get(toolNameB).requestBuilder;
      expect(builderA).toBeDefined();
      expect(builderB).toBeDefined();
      expect(builderA).not.toBe(builderB);
      // Each builder targets its own operation path — confirms the
      // request builder lookup didn't cross-contaminate between actions.
      expect(builderA.path).toBe('/echo');
      expect(builderB.path).toBe('/items');
    };

    it('loadAgentTools resolves both actions when they share a hostname', async () => {
      mockLoadActionSets.mockResolvedValue([actionA, actionB]);
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_collision', tools: [toolNameA, toolNameB] },
        definitionsOnly: false,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      expectBothActionsResolved(mockCreateActionTool.mock.calls);
    });

    it('loadAgentTools is order-invariant for two actions sharing a hostname', async () => {
      // Reverse the actionSets order — what used to flip the "winner" of
      // the encoded-domain Map overwrite must now make zero observable
      // difference.
      mockLoadActionSets.mockResolvedValue([actionB, actionA]);
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_collision', tools: [toolNameA, toolNameB] },
        definitionsOnly: false,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      expectBothActionsResolved(mockCreateActionTool.mock.calls);
    });

    it('loadToolsForExecution resolves both actions when they share a hostname', async () => {
      mockLoadActionSets.mockResolvedValue([actionA, actionB]);
      const req = createMockReq([AgentCapabilities.actions]);
      req.config = {};

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_collision' },
        toolNames: [toolNameA, toolNameB],
        actionsEnabled: true,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      expectBothActionsResolved(mockCreateActionTool.mock.calls);
    });

    it('processRequiredActions resolves both actions when they share a hostname', async () => {
      // The assistants/threads path received the same structural rewrite
      // as the agent paths. Cover it directly so future regressions in the
      // `toolToAction` map shape or the lookup normalization don't slip
      // through just because the agent-path tests still pass.
      mockLoadActionSets.mockResolvedValue([actionA, actionB]);
      const client = {
        req: {
          user: { id: 'user_123' },
          body: {
            assistant_id: 'assistant_collision',
            model: 'gpt-4o-mini',
            endpoint: 'openAI',
          },
          config: {},
        },
        res: {},
        apiKey: 'sk-test',
        mappedOrder: new Map(),
        seenToolCalls: new Map(),
        addContentData: jest.fn(),
      };

      await processRequiredActions(client, [
        {
          tool: toolNameA,
          toolInput: {},
          toolCallId: 'call_a',
          thread_id: 'thread_1',
          run_id: 'run_1',
        },
        {
          tool: toolNameB,
          toolInput: {},
          toolCallId: 'call_b',
          thread_id: 'thread_1',
          run_id: 'run_1',
        },
      ]);

      // The assistants path intentionally doesn't forward `name` to
      // createActionTool (see ToolService.js — "intentionally not passing
      // zodSchema, name, and description for assistants API"), so key
      // resolution assertions off the request builder path instead.
      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      expect(mockLoadToolsUtil).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ res: client.res }),
        }),
      );
      const builderPaths = mockCreateActionTool.mock.calls.map((c) => c[0].requestBuilder?.path);
      expect(builderPaths).toEqual(expect.arrayContaining(['/echo', '/items']));
      // Each call must carry a distinct builder — guards against the bug
      // where the surviving action's builders got routed to every tool.
      expect(builderPaths[0]).not.toBe(builderPaths[1]);
    });

    it('loadAgentTools resolves legacy-format tool names via the legacy encoding branch', async () => {
      // Agents whose tool names predate the current domain encoding store
      // them under `legacyDomainEncode`'s output. The map registers both
      // encodings per function so these keep resolving after the fix;
      // this test exercises the `if (legacyNormalized !== normalizedDomain)`
      // branch, which was previously never hit by any test.
      mockLoadActionSets.mockResolvedValue([actionA]);
      const legacyToolName = `echoMessage${actionDelimiter}${LEGACY_ENCODED_DOMAIN}`;
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_legacy', tools: [legacyToolName] },
        definitionsOnly: false,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(1);
      const [callArgs] = mockCreateActionTool.mock.calls[0];
      expect(callArgs.name).toBe(legacyToolName);
      expect(callArgs.requestBuilder.path).toBe('/echo');
    });

    it('definitions-only loading emits the selected legacy action name', async () => {
      mockLoadActionSets.mockResolvedValue([actionA]);
      const legacyToolName = `echoMessage${actionDelimiter}${LEGACY_ENCODED_DOMAIN}`;
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      mockLoadToolDefinitions.mockImplementationOnce(async (_options, dependencies) => {
        const definitions = await dependencies.getActionToolDefinitions('agent_legacy', [
          legacyToolName,
        ]);
        expect(definitions).toEqual([
          expect.objectContaining({ name: legacyToolName, description: 'Mock echoMessage' }),
        ]);
        return {
          toolDefinitions: definitions,
          toolRegistry: new Map(),
          hasDeferredTools: false,
        };
      });

      await loadAgentTools({
        req,
        res: {},
        agent: {
          id: 'agent_legacy',
          tools: [legacyToolName],
          tool_options: { [legacyToolName]: { run_in_background: true } },
        },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
    });

    it('loadAgentTools distinguishes operationIds that differ only by `---` vs `_`', async () => {
      // `openapiToFunction` uses the user-supplied operationId verbatim
      // and only sanitizes the synthetic `<method>_<path>` fallback, and
      // `sanitizeOperationId` preserves `-`. So two operations whose
      // operationIds differ only by `---` vs `_` (e.g. `get_foo---bar`
      // and `get_foo_bar`) are legitimately distinct on the same spec —
      // or, here, on two actions sharing a hostname.
      //
      // Normalization must only touch the encoded-domain suffix after
      // `actionDelimiter`; if it also collapsed the operationId, both
      // tools would write to the same map slot and resolve to the
      // surviving entry's request builder.
      const hyphenSpec = {
        action_id: 'action_hyphen',
        metadata: {
          domain: SHARED_DOMAIN,
          raw_spec: buildSpec('get_foo---bar', '/foo-bar'),
        },
      };
      const underscoreSpec = {
        action_id: 'action_underscore',
        metadata: {
          domain: SHARED_DOMAIN,
          raw_spec: buildSpec('get_foo_bar', '/foo_bar'),
        },
      };
      mockLoadActionSets.mockResolvedValue([hyphenSpec, underscoreSpec]);

      const hyphenTool = `get_foo---bar${actionDelimiter}${ENCODED_DOMAIN}`;
      const underscoreTool = `get_foo_bar${actionDelimiter}${ENCODED_DOMAIN}`;
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_hyphen', tools: [hyphenTool, underscoreTool] },
        definitionsOnly: false,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      const callsByName = new Map(mockCreateActionTool.mock.calls.map((c) => [c[0].name, c[0]]));
      expect(callsByName.has(hyphenTool)).toBe(true);
      expect(callsByName.has(underscoreTool)).toBe(true);
      expect(callsByName.get(hyphenTool).requestBuilder.path).toBe('/foo-bar');
      expect(callsByName.get(underscoreTool).requestBuilder.path).toBe('/foo_bar');
      // Critical: the two must resolve to distinct builders. If the
      // operationId half of the key is normalized, both collapse to
      // the same map slot and one silently overwrites the other.
      expect(callsByName.get(hyphenTool).requestBuilder).not.toBe(
        callsByName.get(underscoreTool).requestBuilder,
      );
    });

    it('loadAgentTools resolves raw `---`-separated tool names from agent.tools', async () => {
      // Hostnames at or below ENCODED_DOMAIN_LENGTH round-trip through
      // `domainParser(..., true)` as a `---`-separated string, and agents
      // persist that raw form in `agent.tools`. The map is always keyed
      // with the `_`-collapsed form, so the lookup must normalize the
      // incoming name or short-hostname tools silently drop out.
      mockDomainParser.mockResolvedValue('shared---dom');
      mockLoadActionSets.mockResolvedValue([actionA, actionB]);
      const rawNameA = `echoMessage${actionDelimiter}shared---dom`;
      const rawNameB = `listItems${actionDelimiter}shared---dom`;
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.actions];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_short', tools: [rawNameA, rawNameB] },
        definitionsOnly: false,
      });

      expect(mockCreateActionTool).toHaveBeenCalledTimes(2);
      const callsByName = new Map(mockCreateActionTool.mock.calls.map((c) => [c[0].name, c[0]]));
      expect(callsByName.has(rawNameA)).toBe(true);
      expect(callsByName.has(rawNameB)).toBe(true);
      expect(callsByName.get(rawNameA).requestBuilder.path).toBe('/echo');
      expect(callsByName.get(rawNameB).requestBuilder.path).toBe('/items');
    });
  });

  /**
   * `AgentCapabilities` is the instance-wide switch; `FILE_SEARCH`/`RUN_CODE` are
   * the per-role grants. A tool has to clear both, on the definitions path and the
   * runtime path alike — otherwise a denied user is handed a definition the model
   * will call and the loader will refuse.
   */
  describe('loadAgentTools — tool role permission gating', () => {
    const capabilities = [
      AgentCapabilities.tools,
      AgentCapabilities.file_search,
      AgentCapabilities.execute_code,
      AgentCapabilities.web_search,
    ];

    const denyPermission = (deniedType) =>
      mockGetRoleByName.mockResolvedValue(
        buildRole({ [deniedType]: { [Permissions.USE]: false } }),
      );

    beforeEach(() => {
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));
    });

    it('omits file_search from definitions when FILE_SEARCH.USE is denied', async () => {
      denyPermission(PermissionTypes.FILE_SEARCH);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code] },
        tool_resources: { file_search: { file_ids: ['search-file'] } },
        definitionsOnly: true,
      });

      expect(mockLoadToolDefinitions).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain(Tools.file_search);
      expect(callArgs.tools).toContain(Tools.execute_code);
    });

    it('does not prime search files for a denied user', async () => {
      denyPermission(PermissionTypes.FILE_SEARCH);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search] },
        tool_resources: { file_search: { file_ids: ['search-file'] } },
        definitionsOnly: true,
      });

      expect(mockPrimeSearchFiles).not.toHaveBeenCalled();
    });

    it('omits file_search from the runtime loader when FILE_SEARCH.USE is denied', async () => {
      denyPermission(PermissionTypes.FILE_SEARCH);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code] },
        definitionsOnly: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).not.toContain(Tools.file_search);
      expect(callArgs.tools).toContain(Tools.execute_code);
    });

    it('omits execute_code when RUN_CODE.USE is denied', async () => {
      denyPermission(PermissionTypes.RUN_CODE);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code] },
        tool_resources: { execute_code: { file_ids: ['code-file'] } },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain(Tools.execute_code);
      expect(callArgs.tools).toContain(Tools.file_search);
      expect(mockPrimeCodeFiles).not.toHaveBeenCalled();
    });

    /** Dropping `execute_code` from the tool list is not enough: this flag also
     *  reaches tool classification and the programmatic bash tool, either of
     *  which would otherwise run code for a role denied `RUN_CODE`. */
    it('clears codeExecutionEnabled for the definitions payload when RUN_CODE is denied', async () => {
      denyPermission(PermissionTypes.RUN_CODE);

      await loadAgentTools({
        req: createMockReq([...capabilities, AgentCapabilities.programmatic_tools]),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.execute_code, 'calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.codeExecutionEnabled).toBe(false);
    });

    it('keeps both tools when the role grants them', async () => {
      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toEqual(
        expect.arrayContaining([Tools.file_search, Tools.execute_code]),
      );
      expect(callArgs.codeExecutionEnabled).toBe(true);
    });

    it('omits web_search from definitions when WEB_SEARCH.USE is denied', async () => {
      denyPermission(PermissionTypes.WEB_SEARCH);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search, Tools.execute_code] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain(Tools.web_search);
      expect(callArgs.tools).toContain(Tools.execute_code);
    });

    it('omits web_search from the runtime loader when WEB_SEARCH.USE is denied', async () => {
      denyPermission(PermissionTypes.WEB_SEARCH);

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search, Tools.execute_code] },
        definitionsOnly: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).not.toContain(Tools.web_search);
      expect(callArgs.tools).toContain(Tools.execute_code);
    });

    it('keeps web_search when the role grants it', async () => {
      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain(Tools.web_search);
    });

    it('keeps web_search in the runtime loader when the role grants it', async () => {
      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        definitionsOnly: false,
      });

      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).toContain(Tools.web_search);
    });

    it('fails closed when the role lookup throws', async () => {
      mockGetRoleByName.mockRejectedValue(new Error('role lookup failed'));

      await loadAgentTools({
        req: createMockReq(capabilities),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code, 'calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toEqual(['calculator']);
    });

    it('skips the permission check when the capability is already disabled', async () => {
      const toolsOnly = [AgentCapabilities.tools];
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(toolsOnly));

      await loadAgentTools({
        req: createMockReq(toolsOnly),
        res: {},
        agent: { id: 'agent_123', tools: [Tools.file_search, Tools.execute_code, 'calculator'] },
        definitionsOnly: true,
      });

      expect(mockGetRoleByName).not.toHaveBeenCalled();
      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toEqual(['calculator']);
    });
  });
});
