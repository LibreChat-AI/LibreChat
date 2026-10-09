import type { MCPConnection } from '~/mcp/connection';
import type * as t from '~/mcp/types';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { createMockConnection } from './mcpConnectionsMock.helper';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { detectOAuthRequirement } from '~/mcp/oauth';

// Mock external dependencies
jest.mock('../../oauth/detectOAuth');
jest.mock('../../MCPConnectionFactory');

const mockDetectOAuthRequirement = detectOAuthRequirement as jest.MockedFunction<
  typeof detectOAuthRequirement
>;

describe('MCPServerInspector', () => {
  let mockConnection: jest.Mocked<MCPConnection>;

  beforeEach(() => {
    mockConnection = createMockConnection('test_server');
    jest.clearAllMocks();
  });

  describe('inspect()', () => {
    it('should process env and fetch all metadata for non-OAuth stdio server with serverInstructions=true', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: true,
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: true,
        resolvedInstructions: 'instructions for test_server',
        requiresOAuth: false,
        capabilities:
          '{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"get":"getPrompts for test_server"}}',
        tools: 'listFiles',
        toolFunctions: {
          listFiles_mcp_test_server: expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'listFiles_mcp_test_server',
            }),
          }),
        },
        initDuration: expect.any(Number),
      });
    });

    it('should detect OAuth and skip capabilities fetch for streamable-http server', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: true,
        method: 'protected-resource-metadata',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        requiresOAuth: true,
        oauthMetadata: undefined,
        initDuration: expect.any(Number),
      });
    });

    it('should keep trusted direct OpenID bearer configuration out of MCP OAuth detection', async () => {
      const rawConfig = {
        type: 'streamable-http' as const,
        url: 'https://api.example.com/mcp',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result.requiresOAuth).toBe(false);
      expect(result.oauthMetadata).toBeNull();
      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('recognizes a chat-only direct bearer before probing OAuth metadata', async () => {
      const rawConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        source: 'yaml',
        requestHeaders: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);
      const result = await MCPServerInspector.inspect('test_server', rawConfig);
      expect(result.requiresOAuth).toBe(false);
      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverDefinition: rawConfig,
          serverConfig: expect.not.objectContaining({ requestHeaders: expect.anything() }),
        }),
      );
      expect(result.toolFunctions).toBeDefined();
    });

    it('should skip capabilities fetch when startup=false', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        startup: false,
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        startup: false,
        requiresOAuth: false,
        initDuration: expect.any(Number),
      });
    });

    it('should skip capabilities fetch when customUserVars is defined', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@test/mcp-stdio-server'],
        env: { API_KEY: '{{MY_KEY}}' },
        customUserVars: {
          MY_KEY: { title: 'API Key', description: 'Your API key' },
        },
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@test/mcp-stdio-server'],
        env: { API_KEY: '{{MY_KEY}}' },
        customUserVars: {
          MY_KEY: { title: 'API Key', description: 'Your API key' },
        },
        requiresOAuth: false,
        initDuration: expect.any(Number),
      });

      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(mockConnection.disconnect).not.toHaveBeenCalled();
    });

    it('should NOT create a temp connection when customUserVars is defined and no connection is provided', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@test/mcp-stdio-server'],
        env: { API_KEY: '{{MY_KEY}}' },
        customUserVars: {
          MY_KEY: { title: 'API Key', description: 'Your API key' },
        },
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(result.requiresOAuth).toBe(false);
      expect(result.capabilities).toBeUndefined();
      expect(result.toolFunctions).toBeUndefined();
    });

    it('should skip capabilities fetch when trusted config needs runtime user context', async () => {
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        headers: {
          'X-LibreChat-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      expect(result).toEqual({
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        headers: {
          'X-LibreChat-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
        requiresOAuth: false,
        oauthMetadata: undefined,
        initDuration: expect.any(Number),
      });
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should still probe at startup when body placeholders live only in requestHeaders', async () => {
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        headers: { 'X-Workspace': 'workspace-1' },
        requestHeaders: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      };

      const tempMockConnection = createMockConnection('test_server');
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(tempMockConnection);

      await MCPServerInspector.inspect('test_server', rawConfig);

      /** The chat-only map must neither block the probe nor reach it. */
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      const probeConfig = (MCPConnectionFactory.create as jest.Mock).mock.calls[0][0].serverConfig;
      expect(probeConfig.headers).toEqual({ 'X-Workspace': 'workspace-1' });
      expect(probeConfig).not.toHaveProperty('requestHeaders');
    });

    it('should skip OAuth detection when trusted URL needs runtime user context', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/users/{{LIBRECHAT_USER_USERNAME}}/mcp',
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      expect(result).toEqual({
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/users/{{LIBRECHAT_USER_USERNAME}}/mcp',
        initDuration: expect.any(Number),
      });
      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should skip capabilities fetch when obo is configured', async () => {
      // OBO servers mint per-user delegated tokens at tool-call time; an
      // unauthenticated probe at inspection has no valid bearer to attach,
      // so the upstream rejects the MCP `initialize` handshake and the
      // create/update fails with MCP_INSPECTION_FAILED. Treat `obo` as
      // user-scoped auth alongside requiresOAuth and customUserVars.
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result.obo).toEqual({ scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' });
      expect(result.requiresOAuth).toBe(false);
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(mockConnection.disconnect).not.toHaveBeenCalled();
    });

    it('should NOT create a temp connection when obo is configured and no connection is provided', async () => {
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const rawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(result.requiresOAuth).toBe(false);
      expect(result.capabilities).toBeUndefined();
      expect(result.toolFunctions).toBeUndefined();
    });

    it('should keep custom serverInstructions string and not fetch from server', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: 'Custom instructions here',
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: 'Custom instructions here',
        requiresOAuth: false,
        capabilities:
          '{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"get":"getPrompts for test_server"}}',
        tools: 'listFiles',
        toolFunctions: expect.any(Object),
        initDuration: expect.any(Number),
      });
    });

    /** The declaration is preserved verbatim: overwriting it in place made a re-inspected
     * config compare unequal to its own YAML cache entry (issue #14798). */
    it('should handle serverInstructions as string "true" and fetch from server', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: 'true', // String "true" from YAML
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: 'true',
        resolvedInstructions: 'instructions for test_server',
        requiresOAuth: false,
        capabilities:
          '{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"get":"getPrompts for test_server"}}',
        tools: 'listFiles',
        toolFunctions: expect.any(Object),
        initDuration: expect.any(Number),
      });
    });

    it('should handle predefined requiresOAuth without detection', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com/sse',
        requiresOAuth: true,
      };

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'sse',
        url: 'https://api.example.com/sse',
        requiresOAuth: true,
        initDuration: expect.any(Number),
      });
    });

    it('should set requiresOAuth to false when apiKey.source is admin', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com/sse',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'my-api-key',
        },
      };

      // OAuth detection should be skipped
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: true, // This would be returned if called, but it shouldn't be
        method: 'protected-resource-metadata',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      // Should NOT call OAuth detection
      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();

      // requiresOAuth should be false due to admin-provided API key
      expect(result.requiresOAuth).toBe(false);
      expect(result.apiKey?.source).toBe('admin');
    });

    it('should set requiresOAuth to false and skip probing when apiKey.source is user', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com/sse',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
      };

      // A credential-less probe of a bearer server returns the same 401 challenge as
      // an OAuth server. Detection must be skipped so the user's API key is honored
      // instead of forcing an OAuth flow.
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: true, // This would be returned if called, but it shouldn't be
        method: 'protected-resource-metadata',
      });

      // No connection provided: the user's key is supplied per-user at connect time, so
      // inspection must NOT open an unauthenticated connection (it would 401 and fail save).
      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(result.requiresOAuth).toBe(false);
      expect(result.apiKey?.source).toBe('user');
    });

    it('should honor an explicit oauth block even when a user apiKey is present', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'sse',
        url: 'https://api.example.com/sse',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
        oauth: {
          authorization_url: 'https://api.example.com/oauth/authorize',
          token_url: 'https://api.example.com/oauth/token',
          scope: 'read',
        },
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: true,
        method: 'protected-resource-metadata',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      // An explicit oauth config must take precedence over the apiKey short-circuit.
      expect(mockDetectOAuthRequirement).toHaveBeenCalled();
      expect(result.requiresOAuth).toBe(true);
    });

    it('should fetch capabilities when server has no tools', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      // Mock server with no tools
      mockConnection.fetchTools = jest.fn().mockResolvedValue([]);
      mockConnection.fetchOrderedToolsSnapshot = jest
        .fn()
        .mockResolvedValue({ tools: [], complete: true });

      const result = await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        requiresOAuth: false,
        capabilities:
          '{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"get":"getPrompts for test_server"}}',
        tools: '',
        toolFunctions: {},
        initDuration: expect.any(Number),
      });
    });

    it('should create temporary connection when no connection is provided', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: true,
      };

      const tempMockConnection = createMockConnection('test_server');
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(tempMockConnection);

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      const result = await MCPServerInspector.inspect('test_server', rawConfig);

      // Verify factory was called to create connection
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'test_server',
          serverConfig: expect.objectContaining({ type: 'stdio', command: 'node' }),
        }),
      );

      // Verify temporary connection was disconnected
      expect(tempMockConnection.disconnect).toHaveBeenCalled();

      // Verify result is correct
      expect(result).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: true,
        resolvedInstructions: 'instructions for test_server',
        requiresOAuth: false,
        capabilities:
          '{"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"get":"getPrompts for test_server"}}',
        tools: 'listFiles',
        toolFunctions: expect.any(Object),
        initDuration: expect.any(Number),
      });
    });

    it('should not create temporary connection when connection is provided', async () => {
      const rawConfig: t.MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        serverInstructions: true,
      };

      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: false,
        method: 'no-metadata-found',
      });

      await MCPServerInspector.inspect('test_server', rawConfig, mockConnection);

      // Verify factory was NOT called
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();

      // Verify provided connection was NOT disconnected
      expect(mockConnection.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('getToolCatalog()', () => {
    it('should convert MCP tools to LibreChat tool functions format', async () => {
      mockConnection.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        complete: true,
        tools: [
          {
            name: 'file_read',
            description: 'Read a file',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
          {
            name: 'file_write',
            description: 'Write a file',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        ],
      });

      const { tools: result } = await MCPServerInspector.getToolCatalog(
        'my_server',
        mockConnection,
      );

      expect(result).toEqual({
        file_read_mcp_my_server: {
          type: 'function',
          function: {
            name: 'file_read_mcp_my_server',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        },
        file_write_mcp_my_server: {
          type: 'function',
          function: {
            name: 'file_write_mcp_my_server',
            description: 'Write a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      });
    });

    it('should handle empty tools list', async () => {
      mockConnection.fetchOrderedToolsSnapshot = jest
        .fn()
        .mockResolvedValue({ tools: [], complete: true });

      const { tools: result } = await MCPServerInspector.getToolCatalog(
        'my_server',
        mockConnection,
      );

      expect(result).toEqual({});
    });

    it('builds keys with the normalized server name (model-facing contract)', async () => {
      mockConnection.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        complete: true,
        tools: [
          {
            name: 'file_read',
            description: 'Read a file',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const { tools: result } = await MCPServerInspector.getToolCatalog(
        'My Server',
        mockConnection,
      );

      const key = 'file_read_mcp_My_Server';
      expect(Object.keys(result)).toEqual([key]);
      expect(result[key]['function'].name).toBe(key);
    });

    it('strips a redundant server-name prefix from keys and records the raw name', async () => {
      mockConnection.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        complete: true,
        tools: [
          {
            name: 'acme_trace_top_time_consuming_operations',
            description: 'Trace',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'list_services',
            description: 'List',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const { tools: result } = await MCPServerInspector.getToolCatalog('acme', mockConnection);

      const strippedKey = 'trace_top_time_consuming_operations_mcp_acme';
      const plainKey = 'list_services_mcp_acme';
      expect(Object.keys(result).sort()).toEqual([plainKey, strippedKey].sort());
      expect(result[strippedKey]['function'].name).toBe(strippedKey);
      expect(result[strippedKey].serverToolName).toBe('acme_trace_top_time_consuming_operations');
      expect(result[plainKey].serverToolName).toBeUndefined();
    });

    it('rejects an incomplete snapshot before it can replace cached tools', async () => {
      mockConnection.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        tools: [{ name: 'partial', inputSchema: { type: 'object' } }],
        complete: false,
      });

      await expect(MCPServerInspector.getToolCatalog('my_server', mockConnection)).rejects.toThrow(
        'Incomplete tools/list snapshot for MCP server my_server',
      );
    });
  });
});
