import type { PluginAuthMethods } from '@librechat/data-schemas';
import type { GenericTool } from '@librechat/agents';
import { getUserMCPAuthMap, getServerCustomUserVars } from '../auth';
import { getPluginAuthMap } from '~/agents/auth';

jest.mock('~/agents/auth', () => ({
  getPluginAuthMap: jest.fn(),
}));

const mockGetPluginAuthMap = getPluginAuthMap as jest.MockedFunction<typeof getPluginAuthMap>;

const createMockTool = (
  name: string,
  mcpRawServerName?: string,
  mcp = true,
): GenericTool & { mcpRawServerName?: string; mcp?: boolean } =>
  ({
    name,
    mcpRawServerName,
    mcp,
    description: 'Mock tool',
  }) as GenericTool & { mcpRawServerName?: string; mcp?: boolean };

const mockFindPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'] = jest.fn();

describe('getUserMCPAuthMap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Core Functionality', () => {
    it('should handle server names with various special characters and spaces', async () => {
      const testCases = [
        {
          originalName: 'Connector: Company',
          normalizedToolName: 'tool_mcp_Connector__Company',
        },
        {
          originalName: 'Server (Production) @ Company.com',
          normalizedToolName: 'tool_mcp_Server__Production____Company.com',
        },
        {
          originalName: '🌟 Testing Server™ (α-β) 测试服务器',
          normalizedToolName: 'tool_mcp_____Testing_Server_________',
        },
      ];

      const toolInstances = testCases.map((testCase) =>
        createMockTool(testCase.normalizedToolName, testCase.originalName),
      );

      const expectedKeys = testCases.map((tc) => `mcp_${tc.originalName}`);
      mockGetPluginAuthMap.mockResolvedValue({});

      await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith({
        userId: 'user123',
        pluginKeys: expectedKeys,
        throwError: false,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });
    });
  });

  describe('tool-key boundary', () => {
    it('resolves the plugin key from the last delimiter for a gateway-prefixed tool name', async () => {
      /** The raw upstream name carries the delimiter, so first-occurrence extraction
       *  asked for `mcp_server_version_mcp_gitlab` and silently resolved no
       *  customUserVars, leaving API-key/header placeholders unfilled. */
      mockGetPluginAuthMap.mockResolvedValue({});

      await getUserMCPAuthMap({
        userId: 'user123',
        tools: ['gitlab-get_mcp_server_version_mcp_gitlab'],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith(
        expect.objectContaining({ pluginKeys: ['mcp_gitlab'] }),
      );
    });

    it('resolves a configured server whose own name contains the delimiter', async () => {
      mockGetPluginAuthMap.mockResolvedValue({});

      await getUserMCPAuthMap({
        userId: 'user123',
        tools: ['search_mcp_Google_mcp_Workspace'],
        serverNames: ['Google_mcp_Workspace'],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith(
        expect.objectContaining({ pluginKeys: ['mcp_Google_mcp_Workspace'] }),
      );
    });

    it('fetches auth under both spellings for normalized keys, raw-only for legacy keys', async () => {
      /** Plugin auth rows are stored under the raw config name, but a
       *  normalized match could equally belong to a user-DB server named
       *  exactly like it — fetch the superset and let consumers read by
       *  their own server name. Legacy raw keys resolve directly. */
      mockGetPluginAuthMap.mockResolvedValue({});

      await getUserMCPAuthMap({
        userId: 'user123',
        tools: ['search_mcp_Connector__Company', 'lookup_mcp_Connector: Company'],
        serverNames: ['Connector: Company'],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginKeys: expect.arrayContaining(['mcp_Connector__Company', 'mcp_Connector: Company']),
        }),
      );
    });
  });

  describe('Edge Cases', () => {
    it('should return empty object when no tools have mcpRawServerName', async () => {
      const toolInstances = [
        createMockTool('regular_tool', undefined, false),
        createMockTool('another_tool', undefined, false),
        createMockTool('test_mcp_Server_no_raw_name', undefined),
      ];

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({});
      expect(mockGetPluginAuthMap).not.toHaveBeenCalled();
    });

    it('should handle empty or undefined tools array', async () => {
      let result = await getUserMCPAuthMap({
        userId: 'user123',
        tools: [],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });
      expect(result).toEqual({});
      expect(mockGetPluginAuthMap).not.toHaveBeenCalled();

      result = await getUserMCPAuthMap({
        userId: 'user123',
        tools: undefined,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });
      expect(result).toEqual({});
      expect(mockGetPluginAuthMap).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      const toolInstances = [createMockTool('test_mcp_Server1', 'Server1')];
      const dbError = new Error('Database connection failed');

      mockGetPluginAuthMap.mockRejectedValue(dbError);

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({});
    });

    it('propagates lookup failures when throwOnError is set, and asks the map to throw too', async () => {
      const toolInstances = [createMockTool('test_mcp_Server1', 'Server1')];
      const dbError = new Error('Database connection failed');

      mockGetPluginAuthMap.mockRejectedValue(dbError);

      await expect(
        getUserMCPAuthMap({
          userId: 'user123',
          toolInstances,
          findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
          throwOnError: true,
        }),
      ).rejects.toThrow('Database connection failed');

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith(
        expect.objectContaining({ throwError: true }),
      );
    });

    it('should handle non-Error exceptions gracefully', async () => {
      const toolInstances = [createMockTool('test_mcp_Server1', 'Server1')];

      mockGetPluginAuthMap.mockRejectedValue('String error');

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({});
    });

    it('should handle mixed null/undefined values in tools array', async () => {
      const tools = [
        'test_mcp_Server1',
        null,
        'test_mcp_Server2',
        undefined,
        'regular_tool',
        'test_mcp_Server3',
      ];

      mockGetPluginAuthMap.mockResolvedValue({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        tools: tools as (string | undefined)[],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith({
        userId: 'user123',
        pluginKeys: ['mcp_Server1', 'mcp_Server2', 'mcp_Server3'],
        throwError: false,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });
    });

    it('should handle mixed null/undefined values in servers array', async () => {
      const servers = ['Server1', null, 'Server2', undefined, 'Server3'];

      mockGetPluginAuthMap.mockResolvedValue({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        servers: servers as (string | undefined)[],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith({
        userId: 'user123',
        pluginKeys: ['mcp_Server1', 'mcp_Server2', 'mcp_Server3'],
        throwError: false,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });
    });

    it('should handle mixed null/undefined values in toolInstances array', async () => {
      const toolInstances = [
        createMockTool('test_mcp_Server1', 'Server1'),
        null,
        createMockTool('test_mcp_Server2', 'Server2'),
        undefined,
        createMockTool('regular_tool', undefined, false),
        createMockTool('test_mcp_Server3', 'Server3'),
      ];

      mockGetPluginAuthMap.mockResolvedValue({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances: toolInstances as (GenericTool | null)[],
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith({
        userId: 'user123',
        pluginKeys: ['mcp_Server1', 'mcp_Server2', 'mcp_Server3'],
        throwError: false,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual({
        mcp_Server1: { API_KEY: 'key1' },
        mcp_Server2: { API_KEY: 'key2' },
        mcp_Server3: { API_KEY: 'key3' },
      });
    });
  });

  describe('Integration', () => {
    it('should handle complete workflow with normalized tool names and original server names', async () => {
      const originalServerName = 'Connector: Company';
      const toolName = 'test_auth_mcp_Connector__Company';

      const toolInstances = [createMockTool(toolName, originalServerName)];

      const mockCustomUserVars = {
        'mcp_Connector: Company': {
          API_KEY: 'test123',
          SECRET_TOKEN: 'secret456',
        },
      };

      mockGetPluginAuthMap.mockResolvedValue(mockCustomUserVars);

      const result = await getUserMCPAuthMap({
        userId: 'user123',
        toolInstances,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(mockGetPluginAuthMap).toHaveBeenCalledWith({
        userId: 'user123',
        pluginKeys: ['mcp_Connector: Company'],
        throwError: false,
        findPluginAuthsByKeys: mockFindPluginAuthsByKeys,
      });

      expect(result).toEqual(mockCustomUserVars);
    });
  });
});

describe('getServerCustomUserVars', () => {
  it('reads a server entry by its mcp_-prefixed key', () => {
    const authMap = {
      'mcp_my-server': { API_KEY: 'sk-123' },
      'mcp_other-server': { TOKEN: 'abc' },
    };
    expect(getServerCustomUserVars(authMap, 'my-server')).toEqual({ API_KEY: 'sk-123' });
  });

  it('returns undefined for a missing server or map', () => {
    expect(
      getServerCustomUserVars({ 'mcp_my-server': { API_KEY: 'sk-123' } }, 'absent'),
    ).toBeUndefined();
    expect(getServerCustomUserVars(undefined, 'my-server')).toBeUndefined();
  });
});
