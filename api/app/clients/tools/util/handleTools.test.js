const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockPluginService = {
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: jest.fn(),
  getUserPluginAuthValue: jest.fn(),
};
const mockGetMCPServerTools = jest.fn();
const mockCreateMCPTool = jest.fn();
const mockCreateMCPTools = jest.fn();
const mockGetServerConfig = jest.fn();
const mockGetAccessibleMcpServerNames = jest.fn(async () => []);
const mockPrimeCodeFiles = jest.fn(async () => ({ files: [], toolContext: undefined }));

const mockCreateSearchTool = jest.fn(() => ({ name: 'web_search' }));
const mockCreateCodeExecutionTool = jest.fn(() => ({ name: 'execute_code' }));
const mockLoadWebSearchAuth = jest.fn(async () => ({
  authenticated: true,
  authResult: { searchProvider: 'serper', searxngInstanceUrl: 'http://searxng.internal:8080' },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createSearchTool: (...args) => mockCreateSearchTool(...args),
  createCodeExecutionTool: (...args) => mockCreateCodeExecutionTool(...args),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  primeFiles: (...args) => mockPrimeCodeFiles(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  loadWebSearchAuth: (...args) => mockLoadWebSearchAuth(...args),
}));

jest.mock('~/server/services/PluginService', () => mockPluginService);

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    // Default app config for tool tests
    paths: { uploads: '/tmp' },
    fileStrategy: 'local',
    filteredTools: [],
    includedTools: [],
  }),
  getCachedTools: jest.fn().mockResolvedValue({
    // Default cached tools for tests
    dalle: {
      type: 'function',
      function: {
        name: 'dalle',
        description: 'DALL-E image generation',
        parameters: {},
      },
    },
  }),
  getMCPServerTools: (...args) => mockGetMCPServerTools(...args),
}));

jest.mock('~/server/services/MCP', () => ({
  createMCPTool: (...args) => mockCreateMCPTool(...args),
  createMCPTools: (...args) => mockCreateMCPTools(...args),
  createMCPPermissionContext: jest.fn(() => ({
    canUseServers: jest.fn().mockResolvedValue(true),
  })),
  resolveConfigServers: jest.fn().mockResolvedValue({}),
  resolveMcpServerContext: jest.fn(async () => ({ configServers: {}, serverNames: [] })),
  /** Mirrors the real resolver: threaded set wins, then the accessible fetch
   *  (union with raw so operator-only fixtures keep working), incomplete on
   *  failure. The pure sensitivity predicate is the REAL @librechat/api one. */
  resolveCollisionAuditNames: jest.fn(async ({ rawServerNames, accessibleServerNames }) => {
    if (accessibleServerNames?.length) {
      return { names: accessibleServerNames, complete: true };
    }
    try {
      const fetched = await mockGetAccessibleMcpServerNames();
      return {
        names: fetched?.length ? fetched : rawServerNames,
        complete: true,
      };
    } catch {
      return { names: rawServerNames, complete: false };
    }
  }),
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: jest.fn(() => ({
    getServerConfig: (...args) => mockGetServerConfig(...args),
  })),
}));

const { Calculator } = require('@librechat/agents');
const { Tools, Constants } = require('librechat-data-provider');
const { ASK_USER_QUESTION_TOOL_NAME } = require('@librechat/api');

const { User } = require('~/db/models');
const PluginService = require('~/server/services/PluginService');
const { validateTools, loadTools, loadToolWithAuth } = require('./handleTools');
const { StructuredSD, availableTools, DALLE3 } = require('../');

describe('Tool Handlers', () => {
  let mongoServer;
  let fakeUser;
  const pluginKey = 'dalle';
  const pluginKey2 = 'wolfram';
  const ToolClass = DALLE3;
  const initialTools = [pluginKey, pluginKey2];
  const mockCredential = 'mock-credential';
  const mainPlugin = availableTools.find((tool) => tool.pluginKey === pluginKey);
  const authConfigs = mainPlugin.authConfig;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    const userAuthValues = {};
    mockPluginService.getUserPluginAuthValue.mockImplementation((userId, authField) => {
      return userAuthValues[`${userId}-${authField}`];
    });
    mockPluginService.updateUserPluginAuth.mockImplementation(
      (userId, authField, _pluginKey, credential) => {
        const fields = authField.split('||');
        fields.forEach((field) => {
          userAuthValues[`${userId}-${field}`] = credential;
        });
      },
    );

    fakeUser = new User({
      name: 'Fake User',
      username: 'fakeuser',
      email: 'fakeuser@example.com',
      emailVerified: false,
      // file deepcode ignore NoHardcodedPasswords/test: fake value
      password: 'fakepassword123',
      avatar: '',
      provider: 'local',
      role: 'USER',
      googleId: null,
      plugins: [],
      refreshToken: [],
    });
    await fakeUser.save();
    for (const authConfig of authConfigs) {
      await PluginService.updateUserPluginAuth(
        fakeUser._id,
        authConfig.authField,
        pluginKey,
        mockCredential,
      );
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear mocks but not the database since we need the user to persist
    jest.clearAllMocks();

    // Reset the mock implementations
    const userAuthValues = {};
    mockPluginService.getUserPluginAuthValue.mockImplementation((userId, authField) => {
      return userAuthValues[`${userId}-${authField}`];
    });
    mockPluginService.updateUserPluginAuth.mockImplementation(
      (userId, authField, _pluginKey, credential) => {
        const fields = authField.split('||');
        fields.forEach((field) => {
          userAuthValues[`${userId}-${field}`] = credential;
        });
      },
    );

    // Re-add the auth configs for the user
    for (const authConfig of authConfigs) {
      await PluginService.updateUserPluginAuth(
        fakeUser._id,
        authConfig.authField,
        pluginKey,
        mockCredential,
      );
    }
  });

  describe('validateTools', () => {
    it('returns valid tools given input tools and user authentication', async () => {
      const validTools = await validateTools(fakeUser._id, initialTools);
      expect(validTools).toBeDefined();
      expect(validTools.some((tool) => tool === pluginKey)).toBeTruthy();
      expect(validTools.length).toBeGreaterThan(0);
    });

    it('removes tools without valid credentials from the validTools array', async () => {
      const validTools = await validateTools(fakeUser._id, initialTools);
      expect(validTools.some((tool) => tool.pluginKey === pluginKey2)).toBeFalsy();
    });

    it('returns an empty array when no authenticated tools are provided', async () => {
      const validTools = await validateTools(fakeUser._id, []);
      expect(validTools).toEqual([]);
    });

    it('should validate a tool from an Environment Variable', async () => {
      const plugin = availableTools.find((tool) => tool.pluginKey === pluginKey2);
      const authConfigs = plugin.authConfig;
      for (const authConfig of authConfigs) {
        process.env[authConfig.authField] = mockCredential;
      }
      const validTools = await validateTools(fakeUser._id, [pluginKey2]);
      expect(validTools.length).toEqual(1);
      for (const authConfig of authConfigs) {
        delete process.env[authConfig.authField];
      }
    });
  });

  describe('loadTools', () => {
    let toolFunctions;
    let loadTool1;
    let loadTool2;
    let loadTool3;
    const sampleTools = [...initialTools, 'calculator'];
    let ToolClass2 = Calculator;
    let remainingTools = availableTools.filter(
      (tool) => sampleTools.indexOf(tool.pluginKey) === -1,
    );

    beforeAll(async () => {
      const toolMap = await loadTools({
        user: fakeUser._id,
        tools: sampleTools,
        returnMap: true,
        useSpecs: true,
      });
      toolFunctions = toolMap;
      loadTool1 = toolFunctions[sampleTools[0]];
      loadTool2 = toolFunctions[sampleTools[1]];
      loadTool3 = toolFunctions[sampleTools[2]];
    });

    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env;
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns the expected load functions for requested tools', async () => {
      expect(loadTool1).toBeDefined();
      expect(loadTool2).toBeDefined();
      expect(loadTool3).toBeDefined();

      for (const tool of remainingTools) {
        expect(toolFunctions[tool.pluginKey]).toBeUndefined();
      }
    });

    it('should initialize an authenticated tool or one without authentication', async () => {
      const authTool = await loadTool1();
      const tool = await loadTool3();
      expect(authTool).toBeInstanceOf(ToolClass);
      expect(tool).toBeInstanceOf(ToolClass2);
    });

    it('should initialize an authenticated tool with primary auth field', async () => {
      process.env.DALLE3_API_KEY = 'mocked_api_key';
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).not.toHaveBeenCalled();
    });

    it('should initialize an authenticated tool with alternate auth field when primary is missing', async () => {
      delete process.env.DALLE3_API_KEY; // Ensure the primary key is not set
      process.env.DALLE_API_KEY = 'mocked_alternate_api_key';
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledTimes(1);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledWith(
        'userId',
        'DALLE3_API_KEY',
        true,
      );
    });

    it('should fallback to getUserPluginAuthValue when env vars are missing', async () => {
      mockPluginService.updateUserPluginAuth('userId', 'DALLE_API_KEY', 'dalle', 'mocked_api_key');
      const initToolFunction = loadToolWithAuth(
        'userId',
        ['DALLE3_API_KEY||DALLE_API_KEY'],
        ToolClass,
      );
      const authTool = await initToolFunction();

      expect(authTool).toBeInstanceOf(ToolClass);
      expect(mockPluginService.getUserPluginAuthValue).toHaveBeenCalledTimes(2);
    });

    it('marks credentials without an operator value as user-provided', async () => {
      class CapturingTool {
        constructor(fields) {
          this.userProvidedAuthFields = fields.userProvidedAuthFields;
        }
      }

      process.env.SD_WEBUI_URL = 'user_provided';
      const initToolFunction = loadToolWithAuth('userId', ['SD_WEBUI_URL'], CapturingTool);
      const tool = await initToolFunction();

      expect(tool.userProvidedAuthFields).toEqual(new Set(['SD_WEBUI_URL']));
      delete process.env.SD_WEBUI_URL;
    });

    it('should throw an error for an unauthenticated tool', async () => {
      try {
        await loadTool2();
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
    it('returns an empty object when no tools are requested', async () => {
      toolFunctions = await loadTools({
        user: fakeUser._id,
        returnMap: true,
        useSpecs: true,
      });
      expect(toolFunctions).toEqual({});
    });
    it('should return the StructuredTool version when using functions', async () => {
      process.env.SD_WEBUI_URL = mockCredential;
      toolFunctions = await loadTools({
        user: fakeUser._id,
        tools: ['stable-diffusion'],
        functions: true,
        returnMap: true,
        useSpecs: true,
      });
      const structuredTool = await toolFunctions['stable-diffusion']();
      expect(structuredTool).toBeInstanceOf(StructuredSD);
      delete process.env.SD_WEBUI_URL;
    });

    it('loads the ask_user_question tool when not returning a map', async () => {
      const { loadedTools } = await loadTools({
        user: fakeUser._id,
        tools: [ASK_USER_QUESTION_TOOL_NAME],
        useSpecs: true,
      });
      expect(loadedTools).toHaveLength(1);
      expect(loadedTools[0].name).toBe(ASK_USER_QUESTION_TOOL_NAME);
    });

    it('routes code file priming to the selected bridge worker', async () => {
      const bridgeWorkerId = 'principal-worker';
      const controller = new AbortController();
      const toolMap = await loadTools({
        user: fakeUser._id.toString(),
        tools: [Tools.execute_code],
        returnMap: true,
        agent: { id: 'agent-1' },
        signal: controller.signal,
        options: {
          codeExecutionContext: {
            baseUrl: 'https://code.example.com/v1',
            bridgeWorkerId,
          },
        },
      });

      await toolMap[Tools.execute_code]();

      expect(mockPrimeCodeFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          codeApiBaseUrl: 'https://code.example.com/v1',
          bridgeWorkerId,
          signal: controller.signal,
        }),
      );
    });

    describe('MCP credential failure propagation', () => {
      const {
        OpenIDReauthRequiredError,
        MCPAuthenticationRejectedError,
        MCPAuthenticationRefreshError,
        OboTokenResolutionError,
      } = require('@librechat/api');
      const failures = [
        new OpenIDReauthRequiredError('Please sign in again'),
        new MCPAuthenticationRejectedError('private-mcp', false),
        new MCPAuthenticationRejectedError('private-mcp', true),
        new MCPAuthenticationRefreshError(new Error('temporarily unavailable')),
        new OboTokenResolutionError('session_refresh_failed', 'Please sign in again', false),
        new OboTokenResolutionError('session_refresh_failed', 'Retry later', true),
      ];
      const toolKey = (name, server = 'private-mcp') =>
        `${name}${Constants.mcp_delimiter}${server}`;
      const load = (tools, signal) =>
        loadTools({
          user: fakeUser._id.toString(),
          tools,
          signal,
          options: { req: { user: { id: fakeUser._id.toString(), role: 'USER' }, body: {} } },
        });

      beforeEach(() => {
        mockGetServerConfig.mockResolvedValue({
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          source: 'yaml',
        });
        mockGetMCPServerTools.mockResolvedValue({});
        mockCreateMCPTool.mockReset();
        mockCreateMCPTools.mockReset();
      });

      it.each(failures)('preserves an all-tools credential failure: %s', async (error) => {
        mockCreateMCPTools.mockRejectedValueOnce(error);
        await expect(load([toolKey(Constants.mcp_all)])).rejects.toBe(error);
      });

      it.each(failures)('preserves a selected-tool credential failure: %s', async (error) => {
        mockCreateMCPTool.mockRejectedValueOnce(error);
        await expect(load([toolKey('search')])).rejects.toBe(error);
      });

      it('keeps ordinary unavailable servers optional and loads healthy tools', async () => {
        mockCreateMCPTools.mockRejectedValueOnce(new Error('server offline'));
        const healthyTool = { name: toolKey('search', 'healthy') };
        mockCreateMCPTool.mockResolvedValueOnce(healthyTool);
        await expect(load([toolKey(Constants.mcp_all), healthyTool.name])).resolves.toMatchObject({
          loadedTools: [healthyTool],
        });
      });

      it('preserves owned cancellation but not a dependency abort of a live run', async () => {
        const controller = new AbortController();
        const error = new DOMException('Stopped', 'AbortError');
        mockCreateMCPTool.mockRejectedValueOnce(error);
        await expect(load([toolKey('search')], controller.signal)).resolves.toMatchObject({
          loadedTools: [],
        });
        mockCreateMCPTool.mockRejectedValueOnce(error);
        controller.abort(error);
        await expect(load([toolKey('search')], controller.signal)).rejects.toBe(error);
      });

      it('observes early bulk rejection while a selected tool is still loading', async () => {
        const error = failures[0];
        mockCreateMCPTools.mockRejectedValueOnce(error);
        mockCreateMCPTool.mockImplementationOnce(
          () => new Promise((resolve) => setImmediate(() => resolve({ name: 'healthy' }))),
        );
        await expect(load([toolKey(Constants.mcp_all), toolKey('search', 'healthy')])).rejects.toBe(
          error,
        );
      });

      it('settles outstanding bulk loads before surfacing a selected-tool failure', async () => {
        const error = failures[0];
        let bulkSettled = false;
        mockCreateMCPTools.mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              setImmediate(() => {
                bulkSettled = true;
                resolve([{ name: 'healthy' }]);
              }),
            ),
        );
        mockCreateMCPTool.mockRejectedValueOnce(error);
        await expect(load([toolKey(Constants.mcp_all, 'healthy'), toolKey('search')])).rejects.toBe(
          error,
        );
        expect(bulkSettled).toBe(true);
      });

      it.each([false, true])(
        'lets cancellation supersede an auth failure after sibling settlement: authFailure=%s',
        async (authFailure) => {
          const controller = new AbortController();
          const stopped = new Error('request cancelled');
          let siblingSettled = false;
          mockCreateMCPTools.mockImplementationOnce(async () => {
            if (authFailure) {
              throw failures[0];
            }
            return [{ name: 'first' }];
          });
          mockCreateMCPTools.mockImplementationOnce(
            () =>
              new Promise((resolve) =>
                setImmediate(() => {
                  controller.abort(stopped);
                  siblingSettled = true;
                  resolve([{ name: 'sibling' }]);
                }),
              ),
          );
          await expect(
            load(
              [toolKey(Constants.mcp_all), toolKey(Constants.mcp_all, 'healthy')],
              controller.signal,
            ),
          ).rejects.toBe(stopped);
          expect(siblingSettled).toBe(true);
        },
      );

      it('allows a later request to recover after re-authentication', async () => {
        mockCreateMCPTools.mockRejectedValueOnce(failures[0]);
        await expect(load([toolKey(Constants.mcp_all)])).rejects.toBe(failures[0]);
        mockCreateMCPTools.mockResolvedValueOnce([{ name: 'search' }]);
        await expect(load([toolKey(Constants.mcp_all)])).resolves.toMatchObject({
          loadedTools: [{ name: 'search' }],
        });
      });
    });

    it('passes request body to chat MCP tool creation and skips stale cache for BODY-scoped servers', async () => {
      const serverName = 'body-scoped';
      const toolKey = `search${Constants.mcp_delimiter}${serverName}`;
      const requestBody = { conversationId: 'conv-123', messageId: 'msg-123' };
      const jobCreatedAt = 1234;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      };

      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'loaded-mcp-tool' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [toolKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: requestBody,
          },
          jobCreatedAt,
        },
      });

      expect(result.loadedTools).toEqual([{ name: 'loaded-mcp-tool' }]);
      expect(mockGetMCPServerTools).toHaveBeenCalledWith(
        fakeUser._id.toString(),
        serverName,
        serverConfig,
      );
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody,
          jobCreatedAt,
          toolKey,
          config: serverConfig,
        }),
      );
    });

    it('resolves normalized tool keys back to the raw server for config lookups', async () => {
      /** Model-facing keys embed `normalizeServerName(server)`, while the
       *  registry/config/cache are keyed by the raw config name — a
       *  special-character server must still resolve its config and receive
       *  the normalized key as the toolKey. */
      const rawServerName = 'Connector: Company';
      const normalizedKey = `search${Constants.mcp_delimiter}Connector__Company`;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
      };

      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: { [rawServerName]: serverConfig },
        serverNames: ['Connector__Company'],
        rawServerNames: [rawServerName],
      });
      /** Direct-first: the parsed (normalized) name is tried as-is and only
       *  the raw alias resolves — mirroring a registry keyed by raw names. */
      mockGetServerConfig.mockImplementation(async (name) =>
        name === rawServerName ? serverConfig : null,
      );
      mockCreateMCPTool.mockResolvedValue({ name: normalizedKey });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [normalizedKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: normalizedKey }]);
      expect(mockGetServerConfig).toHaveBeenCalledWith(
        rawServerName,
        expect.anything(),
        expect.anything(),
      );
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolKey: normalizedKey,
          serverName: rawServerName,
        }),
      );
    });

    it('skips tools of a shadowed server (colliding normalized names) at execution', async () => {
      /** Instances of a shadowed server get the SAME normalized names as the
       *  winner's, so in-run dispatch could execute either — legacy raw keys
       *  and mcp_all tokens bypass catalog filtering, so execution must also
       *  fail closed. */
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://x.example/mcp',
        source: 'yaml',
      };
      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: {},
        serverNames: ['Sales_Force', 'Sales_Force'],
        rawServerNames: ['Sales Force', 'Sales:Force'],
      });
      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'never' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [`search${Constants.mcp_delimiter}Sales:Force`],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([]);
      expect(mockCreateMCPTool).not.toHaveBeenCalled();
    });

    it('detects CROSS-TIER collisions via the accessible-server set at execution', async () => {
      /** A user-DB server `foo` shadowing operator `foo!` is invisible to the
       *  operator-config names — the guard must consult the full accessible
       *  set so the operator server's legacy raw key fails closed instead of
       *  joining the run under the same normalized name as the DB server. */
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://x.example/mcp',
        source: 'yaml',
      };
      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: {},
        serverNames: ['foo'],
        rawServerNames: ['foo!'],
      });
      mockGetAccessibleMcpServerNames.mockResolvedValueOnce(['foo', 'foo!']);
      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'never' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [`search${Constants.mcp_delimiter}foo!`],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([]);
      expect(mockCreateMCPTool).not.toHaveBeenCalled();
    });

    it('reuses the initialization audit snapshot threaded as bare execution options', async () => {
      /** Deferred execution threads initialization's COMPLETE audit as
       *  `options.accessibleMcpServerNames` (no server context is resolved
       *  there) — a transient registry failure at execution must not
       *  fail-closed a tool the same turn already advertised. */
      const rawServerName = 'Connector: Company';
      const normalizedKey = `search${Constants.mcp_delimiter}Connector__Company`;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
      };
      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: { [rawServerName]: serverConfig },
        serverNames: ['Connector__Company'],
        rawServerNames: [rawServerName],
      });
      mockGetAccessibleMcpServerNames.mockImplementation(async () => {
        throw new Error('registry down');
      });
      mockGetServerConfig.mockImplementation(async (name) =>
        name === rawServerName ? serverConfig : null,
      );
      mockCreateMCPTool.mockResolvedValue({ name: normalizedKey });

      try {
        const result = await loadTools({
          user: fakeUser._id.toString(),
          tools: [normalizedKey],
          options: {
            accessibleMcpServerNames: [rawServerName],
            req: {
              user: { id: fakeUser._id.toString(), role: 'USER' },
              body: {},
            },
          },
        });

        expect(result.loadedTools).toEqual([{ name: normalizedKey }]);
        expect(mockGetAccessibleMcpServerNames).not.toHaveBeenCalled();
      } finally {
        mockGetAccessibleMcpServerNames.mockImplementation(async () => []);
      }
    });

    it('detects cross-tier collisions from the execution-threaded audit snapshot', async () => {
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://x.example/mcp',
        source: 'yaml',
      };
      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: {},
        serverNames: ['foo'],
        rawServerNames: ['foo!'],
      });
      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'never' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [`search${Constants.mcp_delimiter}foo!`],
        options: {
          accessibleMcpServerNames: ['foo', 'foo!'],
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([]);
      expect(mockCreateMCPTool).not.toHaveBeenCalled();
    });

    it('keeps a server resolving under the parsed name as-is (direct identity wins)', async () => {
      /** A user-DB server named exactly like an operator server's normalized
       *  form must keep its own identity instead of being rerouted. */
      const dbServerName = 'Connector__Company';
      const toolKey = `search${Constants.mcp_delimiter}${dbServerName}`;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://db.example.com/mcp',
        source: 'user',
      };

      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: {},
        serverNames: ['Connector__Company'],
        rawServerNames: ['Connector: Company'],
      });
      mockGetServerConfig.mockImplementation(async (name) =>
        name === dbServerName ? serverConfig : null,
      );
      mockCreateMCPTool.mockResolvedValue({ name: toolKey });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [toolKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: toolKey }]);
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolKey,
          serverName: dbServerName,
        }),
      );
    });

    it('still resolves legacy raw-keyed tools for a special-character server', async () => {
      const rawServerName = 'Connector: Company';
      const legacyKey = `search${Constants.mcp_delimiter}${rawServerName}`;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
      };

      const { resolveMcpServerContext } = require('~/server/services/MCP');
      resolveMcpServerContext.mockResolvedValueOnce({
        configServers: { [rawServerName]: serverConfig },
        serverNames: ['Connector__Company'],
        rawServerNames: [rawServerName],
      });
      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'loaded-mcp-tool' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [legacyKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: {},
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: 'loaded-mcp-tool' }]);
      expect(mockGetServerConfig).toHaveBeenCalledWith(
        rawServerName,
        expect.anything(),
        expect.anything(),
      );
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolKey: legacyKey,
          serverName: rawServerName,
        }),
      );
    });

    it('resolves an MCP tool whose raw name itself contains the delimiter substring', async () => {
      // Regression test for https://github.com/LibreChat-AI/LibreChat/issues/14440:
      // gateways that prefix aggregated tool names by server (e.g. LiteLLM's
      // MCP proxy) can produce a raw tool name that already contains "_mcp_"
      // (e.g. GitLab's own "get_mcp_server_version" tool becomes
      // "gitlab-get_mcp_server_version" once gateway-prefixed). Once
      // LibreChat appends its own server suffix, the combined key has the
      // delimiter twice - a naive split used to silently derive the wrong
      // server name ("server_version" instead of "gitlab") and drop the tool.
      const serverName = 'gitlab';
      const rawToolName = 'gitlab-get_mcp_server_version';
      const toolKey = `${rawToolName}${Constants.mcp_delimiter}${serverName}`;
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://litellm.example.com/gitlab/mcp',
        source: 'yaml',
      };

      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'loaded-mcp-tool' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [toolKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: 'loaded-mcp-tool' }]);
      expect(mockGetServerConfig).toHaveBeenCalledWith(
        serverName,
        expect.anything(),
        expect.anything(),
      );
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolKey,
          config: serverConfig,
          /** The resolved server rides along, so `createMCPTool` uses it for auth,
           *  reconnection and invocation instead of re-parsing the ambiguous key. */
          serverName,
        }),
      );
    });

    it('uses run-scoped MCP tool definitions before cache lookup', async () => {
      const serverName = 'body-scoped';
      const toolKey = `search${Constants.mcp_delimiter}${serverName}`;
      const requestBody = { conversationId: 'conv-123', messageId: 'msg-123' };
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      };
      const runScopedTools = {
        [toolKey]: {
          function: {
            name: toolKey,
            description: 'Run-scoped search',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool.mockResolvedValue({ name: 'loaded-mcp-tool' });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [toolKey],
        options: {
          mcpAvailableTools: {
            [serverName]: runScopedTools,
          },
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: requestBody,
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: 'loaded-mcp-tool' }]);
      expect(mockGetMCPServerTools).not.toHaveBeenCalled();
      expect(mockCreateMCPTool).toHaveBeenCalledWith(
        expect.objectContaining({
          availableTools: runScopedTools,
          requestBody,
          toolKey,
          config: serverConfig,
        }),
      );
    });

    it('reuses discovered request-scoped MCP tool definitions within a server loop', async () => {
      const serverName = 'body-scoped';
      const firstToolKey = `search${Constants.mcp_delimiter}${serverName}`;
      const secondToolKey = `lookup${Constants.mcp_delimiter}${serverName}`;
      const requestBody = { conversationId: 'conv-123', messageId: 'msg-123' };
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      };
      const discoveredTools = {
        [firstToolKey]: {
          function: {
            description: 'Search',
            parameters: { type: 'object', properties: {} },
          },
        },
        [secondToolKey]: {
          function: {
            description: 'Lookup',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      mockGetServerConfig.mockResolvedValue(serverConfig);
      mockCreateMCPTool
        .mockImplementationOnce(async ({ onAvailableTools }) => {
          onAvailableTools(discoveredTools);
          return { name: 'search-tool' };
        })
        .mockImplementationOnce(async ({ availableTools }) => {
          expect(availableTools).toBe(discoveredTools);
          return { name: 'lookup-tool' };
        });

      const result = await loadTools({
        user: fakeUser._id.toString(),
        tools: [firstToolKey, secondToolKey],
        options: {
          req: {
            user: { id: fakeUser._id.toString(), role: 'USER' },
            body: requestBody,
          },
        },
      });

      expect(result.loadedTools).toEqual([{ name: 'search-tool' }, { name: 'lookup-tool' }]);
      expect(mockGetMCPServerTools).toHaveBeenCalledTimes(1);
      expect(mockCreateMCPTool).toHaveBeenCalledTimes(2);
      expect(mockCreateMCPTool).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          availableTools: discoveredTools,
          requestBody,
          toolKey: secondToolKey,
        }),
      );
    });
  });

  describe('web_search SSRF-safe agent wiring', () => {
    const buildReq = () => ({
      user: { id: fakeUser._id.toString(), role: 'USER' },
      body: {},
    });

    /** Uses the real resolver, so this fails if the wiring delivers agents that do not guard. */
    async function loadWebSearchConfig(webSearch) {
      const toolMap = await loadTools({
        user: fakeUser._id.toString(),
        tools: [Tools.web_search],
        returnMap: true,
        webSearch,
        options: { req: buildReq() },
      });
      await toolMap[Tools.web_search]();
      return mockCreateSearchTool.mock.calls.at(-1)[0];
    }

    it('threads pooled SSRF-safe agents into the search tool config', async () => {
      const config = await loadWebSearchConfig({ allowedAddresses: ['localhost:8888'] });

      expect(typeof config.httpAgent.createConnection).toBe('function');
      expect(typeof config.httpsAgent.createConnection).toBe('function');
      expect(config.httpAgent.options.keepAlive).toBe(true);
    });

    it('threads agents that actually reject a private target', async () => {
      const config = await loadWebSearchConfig({});

      expect(() =>
        config.httpAgent.createConnection({ host: '169.254.169.254', port: 80 }),
      ).toThrow(expect.objectContaining({ code: 'ESSRF' }));
    });

    it('honors allowedAddresses end to end, exempting the configured host:port only', async () => {
      const config = await loadWebSearchConfig({ allowedAddresses: ['127.0.0.1:8080'] });

      const socket = config.httpAgent.createConnection({ host: '127.0.0.1', port: 8080 });
      socket?.destroy?.();
      expect(() => config.httpAgent.createConnection({ host: '127.0.0.1', port: 9 })).toThrow(
        expect.objectContaining({ code: 'ESSRF' }),
      );
    });

    it('does not throw out of loadTools when allowedAddresses is not an array', async () => {
      await expect(
        loadWebSearchConfig({ allowedAddresses: { '10.0.0.5:11434': true } }),
      ).resolves.toBeDefined();
    });

    it('does not construct web search when authentication is incomplete', async () => {
      mockLoadWebSearchAuth.mockResolvedValueOnce({
        authenticated: false,
        authResult: { searchProvider: 'keenable' },
      });

      const toolMap = await loadTools({
        user: fakeUser._id.toString(),
        tools: [Tools.web_search],
        returnMap: true,
        webSearch: {},
        options: { req: buildReq() },
      });

      expect(toolMap[Tools.web_search]).toBeUndefined();
      expect(mockCreateSearchTool).not.toHaveBeenCalled();
    });
  });
});
