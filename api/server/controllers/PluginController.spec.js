jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
const { getCachedTools, getAppConfig } = require('~/server/services/Config');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
  getAppConfig: jest.fn().mockResolvedValue({
    filteredTools: [],
    includedTools: [],
  }),
  setCachedTools: jest.fn(),
}));

jest.mock('~/app/clients/tools', () => ({
  availableTools: [],
  toolkits: [],
}));

const { getAvailableTools, getAvailablePluginsController } = require('./PluginController');

describe('PluginController', () => {
  let mockReq, mockRes;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      user: { id: 'test-user-id' },
      config: {
        filteredTools: [],
        includedTools: [],
      },
    };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    require('~/app/clients/tools').availableTools.length = 0;
    require('~/app/clients/tools').toolkits.length = 0;

    getCachedTools.mockReset();

    getAppConfig.mockReset();
    getAppConfig.mockResolvedValue({
      filteredTools: [],
      includedTools: [],
    });
  });

  describe('getAvailablePluginsController', () => {
    it('should use filterUniquePlugins to remove duplicate plugins', async () => {
      const mockPlugins = [
        { name: 'Plugin1', pluginKey: 'key1', description: 'First' },
        { name: 'Plugin1', pluginKey: 'key1', description: 'First duplicate' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      ];

      require('~/app/clients/tools').availableTools.push(...mockPlugins);

      getAppConfig.mockResolvedValueOnce({
        filteredTools: [],
        includedTools: [],
      });

      await getAvailablePluginsController(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData).toHaveLength(2);
      expect(responseData[0].pluginKey).toBe('key1');
      expect(responseData[1].pluginKey).toBe('key2');
    });

    it('should use checkPluginAuth to verify plugin authentication', async () => {
      const mockPlugin = { name: 'Plugin1', pluginKey: 'key1', description: 'First' };

      require('~/app/clients/tools').availableTools.push(mockPlugin);

      getAppConfig.mockResolvedValueOnce({
        filteredTools: [],
        includedTools: [],
      });

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData[0].authenticated).toBeUndefined();
    });

    it('excludes agentsOnly plugins from the legacy plugins endpoint (no run to pause)', async () => {
      require('~/app/clients/tools').availableTools.push(
        { name: 'Ask User', pluginKey: 'ask_user_question', description: 'q', agentsOnly: true },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      );

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData.map((p) => p.pluginKey)).toEqual(['key2']);
    });

    it('should filter plugins based on includedTools', async () => {
      const mockPlugins = [
        { name: 'Plugin1', pluginKey: 'key1', description: 'First' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      ];

      require('~/app/clients/tools').availableTools.push(...mockPlugins);

      mockReq.config = {
        filteredTools: [],
        includedTools: ['key1'],
      };

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData).toHaveLength(1);
      expect(responseData[0].pluginKey).toBe('key1');
    });

    it('should exclude plugins in filteredTools', async () => {
      const mockPlugins = [
        { name: 'Plugin1', pluginKey: 'key1', description: 'First' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      ];

      require('~/app/clients/tools').availableTools.push(...mockPlugins);

      mockReq.config = {
        filteredTools: ['key2'],
        includedTools: [],
      };

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData).toHaveLength(1);
      expect(responseData[0].pluginKey).toBe('key1');
    });

    it('should ignore filteredTools when includedTools is set', async () => {
      const mockPlugins = [
        { name: 'Plugin1', pluginKey: 'key1', description: 'First' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
        { name: 'Plugin3', pluginKey: 'key3', description: 'Third' },
      ];

      require('~/app/clients/tools').availableTools.push(...mockPlugins);

      mockReq.config = {
        includedTools: ['key1', 'key2'],
        filteredTools: ['key2'],
      };

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData).toHaveLength(2);
      expect(responseData.map((p) => p.pluginKey)).toEqual(['key1', 'key2']);
    });
  });

  describe('getAvailableTools', () => {
    it('scopes agentsOnly plugins out of the ASSISTANTS listing but keeps them for agents', async () => {
      const cached = {
        ask_user_question: {
          type: 'function',
          function: { name: 'ask_user_question', description: 'q', parameters: {} },
        },
      };
      require('~/app/clients/tools').availableTools.push({
        name: 'Ask User',
        pluginKey: 'ask_user_question',
        description: 'q',
        agentsOnly: true,
      });

      // Agents route: listed.
      getCachedTools.mockResolvedValueOnce(cached);
      mockReq.baseUrl = '/api/agents/tools';
      await getAvailableTools(mockReq, mockRes);
      expect(mockRes.json.mock.calls[0][0].map((t) => t.pluginKey)).toContain('ask_user_question');

      // Assistants route: the runtime executes tools with no run to pause — excluded.
      mockRes.json.mockClear();
      getCachedTools.mockResolvedValueOnce(cached);
      mockReq.baseUrl = '/api/assistants/v2/tools';
      await getAvailableTools(mockReq, mockRes);
      expect(mockRes.json.mock.calls[0][0].map((t) => t.pluginKey)).not.toContain(
        'ask_user_question',
      );
    });

    it('should use filterUniquePlugins to deduplicate combined tools', async () => {
      const mockUserTools = {
        'user-tool': {
          type: 'function',
          function: {
            name: 'user-tool',
            description: 'User tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      require('~/app/clients/tools').availableTools.push(
        { name: 'user-tool', pluginKey: 'user-tool', description: 'Duplicate user tool' },
        { name: 'ManifestTool', pluginKey: 'manifest-tool', description: 'Manifest tool' },
      );

      getCachedTools.mockResolvedValueOnce(mockUserTools);
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(Array.isArray(responseData)).toBe(true);
      const userToolCount = responseData.filter((tool) => tool.pluginKey === 'user-tool').length;
      expect(userToolCount).toBe(1);
    });

    it('should use checkPluginAuth to verify authentication status', async () => {
      const mockPlugin = {
        name: 'Tool1',
        pluginKey: 'tool1',
        description: 'Tool 1',
      };

      require('~/app/clients/tools').availableTools.push(mockPlugin);

      getCachedTools.mockResolvedValueOnce({
        tool1: {
          type: 'function',
          function: {
            name: 'tool1',
            description: 'Tool 1',
            parameters: {},
          },
        },
      });
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(Array.isArray(responseData)).toBe(true);
      const tool = responseData.find((t) => t.pluginKey === 'tool1');
      expect(tool).toBeDefined();
      expect(tool.authenticated).toBeUndefined();
    });

    it('should use getToolkitKey for toolkit validation', async () => {
      const mockToolkit = {
        name: 'Toolkit1',
        pluginKey: 'toolkit1',
        description: 'Toolkit 1',
        toolkit: true,
      };

      require('~/app/clients/tools').availableTools.push(mockToolkit);

      require('~/app/clients/tools').toolkits.push({
        name: 'Toolkit1',
        pluginKey: 'toolkit1',
        tools: ['toolkit1_function'],
      });

      getCachedTools.mockResolvedValueOnce({
        toolkit1_function: {
          type: 'function',
          function: {
            name: 'toolkit1_function',
            description: 'Toolkit function',
            parameters: {},
          },
        },
      });
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(Array.isArray(responseData)).toBe(true);
      const toolkit = responseData.find((t) => t.pluginKey === 'toolkit1');
      expect(toolkit).toBeDefined();
    });
  });

  describe('helper function integration', () => {
    it('should handle error cases gracefully', async () => {
      getCachedTools.mockRejectedValue(new Error('Cache error'));

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ message: 'Cache error' });
    });
  });

  describe('edge cases with undefined/null values', () => {
    it('should handle null cachedTools', async () => {
      getCachedTools.mockResolvedValueOnce({});
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });

    it('should handle when getCachedTools returns undefined', async () => {
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      getCachedTools.mockReset();
      getCachedTools.mockResolvedValueOnce(undefined);

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });

    it('should handle empty toolDefinitions object', async () => {
      getCachedTools.mockReset();
      getCachedTools.mockResolvedValue({});
      mockReq.config = {};

      require('~/app/clients/tools').availableTools.length = 0;

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith([]);
    });

    it('should handle undefined filteredTools and includedTools', async () => {
      mockReq.config = {};

      getAppConfig.mockResolvedValueOnce({});

      await getAvailablePluginsController(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });

    it('should handle toolkit with undefined toolDefinitions keys', async () => {
      const mockToolkit = {
        name: 'Toolkit1',
        pluginKey: 'toolkit1',
        description: 'Toolkit 1',
        toolkit: true,
      };

      require('~/app/clients/tools').availableTools.push(mockToolkit);

      getCachedTools.mockResolvedValueOnce({});
      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('should handle undefined toolDefinitions when checking isToolDefined', async () => {
      const mockPlugin = {
        name: 'Traversaal Search',
        pluginKey: 'traversaal_search',
        description: 'Search plugin',
      };

      require('~/app/clients/tools').availableTools.push(mockPlugin);

      mockReq.config = {
        mcpConfig: null,
        paths: { structuredTools: '/mock/path' },
      };

      getCachedTools.mockResolvedValueOnce(undefined);

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });

    it('should re-initialize tools from appConfig when cache returns null', async () => {
      const mockAppTools = {
        tool1: {
          type: 'function',
          function: {
            name: 'tool1',
            description: 'Tool 1',
            parameters: {},
          },
        },
        tool2: {
          type: 'function',
          function: {
            name: 'tool2',
            description: 'Tool 2',
            parameters: {},
          },
        },
      };

      require('~/app/clients/tools').availableTools.push(
        { name: 'Tool 1', pluginKey: 'tool1', description: 'Tool 1' },
        { name: 'Tool 2', pluginKey: 'tool2', description: 'Tool 2' },
      );

      getCachedTools.mockResolvedValueOnce(null);

      mockReq.config = {
        filteredTools: [],
        includedTools: [],
        availableTools: mockAppTools,
      };

      const { setCachedTools } = require('~/server/services/Config');

      await getAvailableTools(mockReq, mockRes);

      expect(setCachedTools).toHaveBeenCalledWith(mockAppTools);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData).toHaveLength(2);
      expect(responseData.find((t) => t.pluginKey === 'tool1')).toBeDefined();
      expect(responseData.find((t) => t.pluginKey === 'tool2')).toBeDefined();
    });

    it('should handle cache clear without appConfig.availableTools gracefully', async () => {
      getAppConfig.mockResolvedValue({
        filteredTools: [],
        includedTools: [],
      });

      require('~/app/clients/tools').availableTools.length = 0;

      getCachedTools.mockResolvedValueOnce(null);

      mockReq.config = {
        filteredTools: [],
        includedTools: [],
      };

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });
  });
});
