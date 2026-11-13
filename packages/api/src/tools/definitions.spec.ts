import { Providers, WebSearchToolDefinition, GitHubCompareToolDefinition } from '@librechat/agents';
import type {
  LoadToolDefinitionsParams,
  LoadToolDefinitionsResult,
  LoadToolDefinitionsDeps,
  ActionToolDefinition,
  MCPServerTools,
} from './definitions';
import { loadToolDefinitions, orderMCPServerNames } from './definitions';
import { toolkitExpansion, toolkitParent } from './toolkits/mapping';
import { getToolDefinition } from './registry/definitions';
import { getToolApprovalIdentity } from './approval';
import { formatMCPServerTools } from '~/mcp/tools';
import { getToolApprovalName } from './approval';

const MAX_PROVIDER_TOOL_DESCRIPTION_LENGTH = 1024;

describe('definitions.ts', () => {
  const mockGetOrFetchMCPServerTools = jest.fn().mockResolvedValue(null);
  const mockIsBuiltInTool = jest.fn().mockReturnValue(false);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the registered web_search description within common API limits', () => {
    const definition = getToolDefinition(WebSearchToolDefinition.name);

    if (definition == null) {
      throw new Error('Expected web_search tool definition to be registered');
    }

    expect(definition.description).toBe(WebSearchToolDefinition.description);
    expect(definition.description).toMatch(/search/i);
    expect(definition.description.length).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_DESCRIPTION_LENGTH);
  });

  describe('loadToolDefinitions', () => {
    it.each([undefined, false, true])(
      'gates selected comparison definitions on explicit opt-in (%p)',
      async (githubCompareEnabled) => {
        const result = await loadToolDefinitions(
          {
            userId: 'user',
            agentId: 'reviewer',
            tools: ['github_compare'],
            githubCompareEnabled,
          },
          { getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools, isBuiltInTool: () => true },
        );
        expect(result.toolRegistry.has('github_compare')).toBe(githubCompareEnabled === true);
        expect(result.toolDefinitions.map(({ name }) => name)).toEqual(
          githubCompareEnabled === true ? ['github_compare'] : [],
        );
        if (githubCompareEnabled) {
          expect(result.toolRegistry.get('github_compare')?.description).toBe(
            GitHubCompareToolDefinition.description,
          );
        }
        expect(mockGetOrFetchMCPServerTools).not.toHaveBeenCalled();
      },
    );
    it('does not auto-register comparison for code execution agents', async () => {
      const result = await loadToolDefinitions(
        {
          userId: 'user',
          agentId: 'coder',
          tools: ['calculator'],
          githubCompareEnabled: true,
        },
        { getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools, isBuiltInTool: () => true },
      );
      expect(result.toolRegistry.has('github_compare')).toBe(false);
    });

    it('should return empty result for empty tools array', async () => {
      const params: LoadToolDefinitionsParams = {
        userId: 'user-123',
        agentId: 'agent-123',
        tools: [],
      };

      const deps: LoadToolDefinitionsDeps = {
        getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
        isBuiltInTool: mockIsBuiltInTool,
      };

      const result = await loadToolDefinitions(params, deps);

      expect(result.toolDefinitions).toHaveLength(0);
      expect(result.toolRegistry.size).toBe(0);
      expect(result.hasDeferredTools).toBe(false);
      expect(result.oauthActionToolNames).toEqual([]);
    });

    describe('action tool definitions', () => {
      it('should include parameters in action tool definitions', async () => {
        const mockActionDefs: ActionToolDefinition[] = [
          {
            name: 'getWeather_action_weather_com',
            description: 'Get weather for a location',
            parameters: {
              type: 'object',
              properties: {
                latitude: { type: 'number', description: 'Latitude coordinate' },
                longitude: { type: 'number', description: 'Longitude coordinate' },
              },
              required: ['latitude', 'longitude'],
            },
          },
        ];

        const mockGetActionToolDefinitions = jest.fn().mockResolvedValue(mockActionDefs);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['getWeather_action_weather---com'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetActionToolDefinitions).toHaveBeenCalledWith('agent-123', [
          'getWeather_action_weather---com',
        ]);

        const actionDef = result.toolDefinitions.find(
          (d) => d.name === 'getWeather_action_weather_com',
        );
        expect(actionDef).toBeDefined();
        expect(actionDef?.parameters).toBeDefined();
        expect(actionDef?.parameters?.type).toBe('object');
        expect(actionDef?.parameters?.properties).toHaveProperty('latitude');
        expect(actionDef?.parameters?.properties).toHaveProperty('longitude');
        expect(actionDef?.parameters?.required).toContain('latitude');
        expect(actionDef?.parameters?.required).toContain('longitude');
      });

      it('should handle action definitions without parameters', async () => {
        const mockActionDefs: ActionToolDefinition[] = [
          {
            name: 'listItems_action_api_example_com',
            description: 'List all items',
          },
        ];

        const mockGetActionToolDefinitions = jest.fn().mockResolvedValue(mockActionDefs);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['listItems_action_api---example---com'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        const result = await loadToolDefinitions(params, deps);

        const actionDef = result.toolDefinitions.find(
          (d) => d.name === 'listItems_action_api_example_com',
        );
        expect(actionDef).toBeDefined();
        expect(actionDef?.parameters).toBeUndefined();
      });

      it('collects OAuth action tool names and strips the marker from emitted defs', async () => {
        const mockActionDefs: ActionToolDefinition[] = [
          {
            name: 'getWeather_action_weather_com',
            description: 'Get weather for a location',
            oauth: false,
          },
          {
            name: 'sendMail_action_mail_example_com',
            description: 'Send an email',
            oauth: true,
          },
          {
            name: 'listItems_action_api_example_com',
            description: 'List all items',
          },
        ];

        const mockGetActionToolDefinitions = jest.fn().mockResolvedValue(mockActionDefs);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: [
            'getWeather_action_weather---com',
            'sendMail_action_mail---example---com',
            'listItems_action_api---example---com',
          ],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(result.oauthActionToolNames).toEqual(['sendMail_action_mail_example_com']);
        for (const def of result.toolDefinitions) {
          expect(def).not.toHaveProperty('oauth');
        }
        const registryEntry = result.toolRegistry.get('sendMail_action_mail_example_com');
        expect(registryEntry).toBeDefined();
        expect(registryEntry).not.toHaveProperty('oauth');
      });

      it('should not classify MCP tools with _action in name as action tools', async () => {
        const mockGetActionToolDefinitions = jest.fn();
        const mcpTool = 'get_action_mcp_myserver';

        mockGetOrFetchMCPServerTools.mockResolvedValue({
          tools: [
            {
              name: 'get_action',
              description: 'Gets an action',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: [mcpTool],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        await loadToolDefinitions(params, deps);

        expect(mockGetActionToolDefinitions).not.toHaveBeenCalled();
        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalled();
      });

      it('should not call getActionToolDefinitions when no action tools present', async () => {
        const mockGetActionToolDefinitions = jest.fn();
        mockIsBuiltInTool.mockReturnValue(true);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['calculator', 'web_search'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        await loadToolDefinitions(params, deps);

        expect(mockGetActionToolDefinitions).not.toHaveBeenCalled();
      });
    });

    describe('built-in tool definitions', () => {
      it('should include parameters for known built-in tools', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'calculator');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['calculator'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const calcDef = result.toolDefinitions.find((d) => d.name === 'calculator');
        expect(calcDef).toBeDefined();
        expect(calcDef?.parameters).toBeDefined();
      });

      it('does not resolve `execute_code` as a builtin tool definition (registered by initializeAgent instead)', async () => {
        /* Phase 8: the legacy `CodeExecutionToolDefinition` is no longer in
           the registry. `execute_code` stays in `agent.tools` as the
           capability-trigger marker, but its tool definitions (`bash_tool`
           + `read_file`) are added by `registerCodeExecutionTools` during
           `initializeAgent` — not here. `loadToolDefinitions` must silently
           drop the name so nothing shadows that path. */
        mockIsBuiltInTool.mockImplementation((name) => name === 'execute_code');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['execute_code'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const execCodeDef = result.toolDefinitions.find((d) => d.name === 'execute_code');
        expect(execCodeDef).toBeUndefined();
        expect(result.toolRegistry.has('execute_code')).toBe(false);
      });

      it('should include parameters for web_search native tool', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'web_search');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['web_search'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const webSearchDef = result.toolDefinitions.find((d) => d.name === 'web_search');
        expect(webSearchDef).toBeDefined();
        expect(webSearchDef?.parameters).toBeDefined();
        expect(webSearchDef?.parameters?.properties).toHaveProperty('query');
        expect(webSearchDef?.parameters?.required).toContain('query');
      });

      it('should include parameters for file_search native tool', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'file_search');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['file_search'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const fileSearchDef = result.toolDefinitions.find((d) => d.name === 'file_search');
        expect(fileSearchDef).toBeDefined();
        expect(fileSearchDef?.parameters).toBeDefined();
        expect(fileSearchDef?.parameters?.properties).toHaveProperty('query');
        expect(fileSearchDef?.parameters?.required).toContain('query');
      });

      it('should skip built-in tools without registry definitions', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'unknown_tool');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['unknown_tool'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const unknownDef = result.toolDefinitions.find((d) => d.name === 'unknown_tool');
        expect(unknownDef).toBeUndefined();
        expect(result.toolRegistry.has('unknown_tool')).toBe(false);
      });

      it('should include description and parameters in registry for built-in tools', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'calculator');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['calculator'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const registryEntry = result.toolRegistry.get('calculator');
        expect(registryEntry).toBeDefined();
        expect(registryEntry?.description).toBeDefined();
        expect(registryEntry?.parameters).toBeDefined();
        expect(registryEntry?.allowed_callers).toContain('direct');
      });
    });

    describe('programmatic tool calling capability gate', () => {
      const mcpToolName = 'run_report_mcp_server_one';
      const serverTools = {
        [mcpToolName]: {
          function: {
            name: mcpToolName,
            description: 'Run report',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      it('does not add Bash PTC definitions unless both code and programmatic capabilities are enabled', async () => {
        mockGetOrFetchMCPServerTools.mockResolvedValueOnce(serverTools);

        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [mcpToolName],
            toolOptions: {
              [mcpToolName]: { allowed_callers: ['code_execution'] },
            },
            codeExecutionEnabled: true,
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(false);
        expect(result.toolRegistry.has('run_tools_with_bash')).toBe(false);
      });

      it('passes the selected attached environment into definitions-only classification', async () => {
        mockGetOrFetchMCPServerTools.mockResolvedValueOnce(serverTools);
        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [mcpToolName],
            toolOptions: { [mcpToolName]: { allowed_callers: ['code_execution'] } },
            programmaticToolsEnabled: true,
            codeExecutionEnabled: true,
            codeExecutionContext: {
              baseUrl: 'https://code.example',
              codeSessionKey: 'session',
              executionProfile: 'stateful',
              statefulSessions: true,
              environmentType: 'attached',
              environmentId: 'attached',
              bridgeWorkerId: 'worker',
            },
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );
        expect(
          result.toolDefinitions.some((definition) => definition.name === 'run_tools_with_bash'),
        ).toBe(false);
        expect(result.toolRegistry.has('run_tools_with_bash')).toBe(false);
      });

      it('adds Bash PTC definitions when code and programmatic capabilities are enabled', async () => {
        mockGetOrFetchMCPServerTools.mockResolvedValueOnce(serverTools);

        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [mcpToolName],
            toolOptions: {
              [mcpToolName]: { allowed_callers: ['code_execution'] },
            },
            programmaticToolsEnabled: true,
            codeExecutionEnabled: true,
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(true);
        expect(result.toolRegistry.has('run_tools_with_bash')).toBe(true);
      });
    });

    describe('MCP tool definitions with server name variants', () => {
      it('treats a server pin with no selected tools as intentionally empty', async () => {
        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: ['sys__server__sys_mcp_warehouse'],
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(mockGetOrFetchMCPServerTools).not.toHaveBeenCalled();
        expect(result.toolDefinitions).toEqual([]);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 0, resolvedToolCount: 0 });
      });

      it('refreshes a non-empty server catalog once when the selected tool is missing', async () => {
        const selectedTool = 'run_query_mcp_warehouse';
        const staleTools = {
          list_sources_mcp_warehouse: {
            function: {
              name: 'list_sources_mcp_warehouse',
              description: 'List databases',
              parameters: { type: 'object', properties: {} },
            },
          },
        };
        const refreshedTools = {
          ...staleTools,
          [selectedTool]: {
            function: {
              name: selectedTool,
              description: 'Run a read-only query',
              parameters: { type: 'object', properties: {} },
            },
          },
        };
        const refreshMCPServerTools = jest.fn().mockResolvedValue(refreshedTools);
        mockGetOrFetchMCPServerTools.mockResolvedValue(staleTools);

        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [selectedTool],
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            refreshMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(refreshMCPServerTools).toHaveBeenCalledTimes(1);
        expect(refreshMCPServerTools).toHaveBeenCalledWith('user-123', 'warehouse');
        expect(result.toolDefinitions).toEqual([
          expect.objectContaining({ name: selectedTool, serverName: 'warehouse' }),
        ]);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 1, resolvedToolCount: 1 });
      });

      it('refreshes an empty server catalog once when a selected tool is expected', async () => {
        const selectedTool = 'run_query_mcp_warehouse';
        const refreshedTools = {
          [selectedTool]: {
            function: {
              name: selectedTool,
              description: 'Run a read-only query',
              parameters: { type: 'object', properties: {} },
            },
          },
        };
        const refreshMCPServerTools = jest.fn().mockResolvedValue(refreshedTools);
        mockGetOrFetchMCPServerTools.mockResolvedValue({});

        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [selectedTool],
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            refreshMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(refreshMCPServerTools).toHaveBeenCalledTimes(1);
        expect(result.toolDefinitions).toEqual([
          expect.objectContaining({ name: selectedTool, serverName: 'warehouse' }),
        ]);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 1, resolvedToolCount: 1 });
      });

      it('refreshes an empty server catalog once when all server tools are expected', async () => {
        const wildcardTool = 'sys__all__sys_mcp_warehouse';
        const refreshedTool = 'run_query_mcp_warehouse';
        const refreshedTools = {
          [refreshedTool]: {
            function: {
              name: refreshedTool,
              description: 'Run a read-only query',
              parameters: { type: 'object', properties: {} },
            },
          },
        };
        const refreshMCPServerTools = jest.fn().mockResolvedValue(refreshedTools);
        mockGetOrFetchMCPServerTools.mockResolvedValue({});

        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: [wildcardTool],
          },
          {
            getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
            refreshMCPServerTools,
            isBuiltInTool: mockIsBuiltInTool,
          },
        );

        expect(refreshMCPServerTools).toHaveBeenCalledTimes(1);
        expect(result.toolDefinitions).toEqual([
          expect.objectContaining({ name: refreshedTool, serverName: 'warehouse' }),
        ]);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 1, resolvedToolCount: 1 });
      });

      it('should load MCP tools with underscored server names (server_one)', async () => {
        const mockServerTools = {
          list_items_mcp_server_one: {
            function: {
              name: 'list_items_mcp_server_one',
              description: 'List all items from server',
              parameters: {
                type: 'object',
                properties: {
                  limit: { type: 'number', description: 'Max items to return' },
                },
              },
            },
          },
          get_item_mcp_server_one: {
            function: {
              name: 'get_item_mcp_server_one',
              description: 'Get a specific item',
              parameters: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Item ID' },
                },
                required: ['id'],
              },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['sys__all__sys_mcp_server_one'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'server_one');
        expect(result.toolDefinitions).toHaveLength(2);

        const listItemsDef = result.toolDefinitions.find(
          (d) => d.name === 'list_items_mcp_server_one',
        );
        expect(listItemsDef).toBeDefined();
        expect(listItemsDef?.description).toBe('List all items from server');

        const getItemDef = result.toolDefinitions.find((d) => d.name === 'get_item_mcp_server_one');
        expect(getItemDef).toBeDefined();
        expect(getItemDef?.description).toBe('Get a specific item');
      });

      it('resolves a pre-strip persisted key against the stripped catalog, keeping the persisted name', async () => {
        /** Catalog keys drop a redundant leading server-name prefix; an agent
         *  saved before that must still resolve, and the definition keeps the
         *  persisted spelling so it matches the runtime instance name. */
        const mockServerTools = {
          search_mcp_acme: {
            serverToolName: 'acme_search',
            function: {
              name: 'search_mcp_acme',
              description: 'Search things',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['acme_search_mcp_acme'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(result.toolDefinitions).toHaveLength(1);
        expect(result.toolDefinitions[0]?.name).toBe('acme_search_mcp_acme');
        expect(result.toolDefinitions[0]?.description).toBe('Search things');
      });

      it('rejects a stripped-spelling match without matching upstream identity', async () => {
        /** A stale key for a removed tool must not resolve onto a DIFFERENT
         *  sibling whose key merely coincides with the stripped spelling. */
        const mockServerTools = {
          acme_foo_mcp_acme: {
            function: {
              name: 'acme_foo_mcp_acme',
              description: 'Different tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['acme_acme_foo_mcp_acme'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(result.toolDefinitions).toHaveLength(0);
      });

      it('union-flattens MCP tool schemas for Google, but preserves unions otherwise', async () => {
        const mockServerTools = {
          issue_write_mcp_github: {
            function: {
              name: 'issue_write_mcp_github',
              description: 'Write an issue',
              parameters: {
                type: 'object',
                properties: {
                  repo: { type: 'string' },
                  payload: {
                    anyOf: [
                      {
                        type: 'object',
                        properties: { action: { const: 'create' }, title: { type: 'string' } },
                      },
                      {
                        type: 'object',
                        properties: { action: { const: 'update' }, number: { type: 'number' } },
                      },
                    ],
                  },
                },
                required: ['repo'],
              },
            },
          },
        };
        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const googleResult = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: 'agent-123',
            tools: ['issue_write_mcp_github'],
            provider: Providers.GOOGLE,
          },
          deps,
        );
        const googleDef = googleResult.toolDefinitions.find(
          (d) => d.name === 'issue_write_mcp_github',
        );
        expect(JSON.stringify(googleDef?.parameters)).not.toContain('anyOf');
        expect(
          (googleDef?.parameters as { properties: Record<string, { properties: object }> })
            .properties.payload.properties,
        ).toEqual({ action: { type: 'string', enum: ['create'] }, title: { type: 'string' } });

        const defaultResult = await loadToolDefinitions(
          { userId: 'user-123', agentId: 'agent-123', tools: ['issue_write_mcp_github'] },
          deps,
        );
        const defaultDef = defaultResult.toolDefinitions.find(
          (d) => d.name === 'issue_write_mcp_github',
        );
        expect(JSON.stringify(defaultDef?.parameters)).toContain('anyOf');
      });

      it('should load MCP tools with hyphenated server names (server-one)', async () => {
        const mockServerTools = {
          'list_items_mcp_server-one': {
            function: {
              name: 'list_items_mcp_server-one',
              description: 'List all items from server',
              parameters: {
                type: 'object',
                properties: {
                  limit: { type: 'number', description: 'Max items to return' },
                },
              },
            },
          },
          'get_item_mcp_server-one': {
            function: {
              name: 'get_item_mcp_server-one',
              description: 'Get a specific item',
              parameters: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Item ID' },
                },
                required: ['id'],
              },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['sys__all__sys_mcp_server-one'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'server-one');
        expect(result.toolDefinitions).toHaveLength(2);

        const listItemsDef = result.toolDefinitions.find(
          (d) => d.name === 'list_items_mcp_server-one',
        );
        expect(listItemsDef).toBeDefined();
        expect(listItemsDef?.description).toBe('List all items from server');

        const getItemDef = result.toolDefinitions.find((d) => d.name === 'get_item_mcp_server-one');
        expect(getItemDef).toBeDefined();
        expect(getItemDef?.description).toBe('Get a specific item');
      });

      it('should handle individual MCP tool lookup with hyphenated server name', async () => {
        const mockServerTools = {
          'list_items_mcp_server-one': {
            function: {
              name: 'list_items_mcp_server-one',
              description: 'List all items from server',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['list_items_mcp_server-one'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'server-one');
        expect(result.toolDefinitions).toHaveLength(1);
        expect(result.toolDefinitions[0].name).toBe('list_items_mcp_server-one');
      });

      it('should include hyphenated server name tools in registry with correct serverName', async () => {
        const mockServerTools = {
          'list_items_mcp_my-server': {
            function: {
              name: 'list_items_mcp_my-server',
              description: 'List items',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['sys__all__sys_mcp_my-server'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(result.toolDefinitions).toHaveLength(1);
        expect(result.toolRegistry.size).toBeGreaterThan(0);

        const toolDef = result.toolDefinitions[0];
        expect(toolDef.name).toBe('list_items_mcp_my-server');
        expect((toolDef as { serverName?: string }).serverName).toBe('my-server');
      });

      it('resolves normalized keys to the RAW server for lookups and definition metadata', async () => {
        /** Config lookups and `serverName` metadata (server instructions are
         *  keyed by raw config names) must carry the raw name even though the
         *  key embeds the normalized form. Resolution is direct-first, so the
         *  raw alias is consulted only after the parsed name yields nothing. */
        const mockServerTools = {
          search_mcp_Connector__Company: {
            function: {
              name: 'search_mcp_Connector__Company',
              description: 'Search',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockImplementation(async (_userId: string, name: string) =>
          name === 'Connector: Company' ? mockServerTools : null,
        );

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['search_mcp_Connector__Company'],
          mcpServerNames: ['Connector__Company'],
          rawServerNames: ['Connector: Company'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'Connector: Company');
        expect(result.toolDefinitions).toHaveLength(1);
        const toolDef = result.toolDefinitions[0];
        expect(toolDef.name).toBe('search_mcp_Connector__Company');
        expect((toolDef as { serverName?: string }).serverName).toBe('Connector: Company');
      });

      it('does not alias-fallback when the parsed name IS a known accessible server', async () => {
        /** A null fetch for a KNOWN server means it is temporarily
         *  unavailable (OAuth pending, missing vars) — rerouting to the raw
         *  alias would emit the other server's definitions under its names. */
        mockGetOrFetchMCPServerTools.mockResolvedValue(null);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['search_mcp_Connector__Company'],
          mcpServerNames: ['Connector__Company'],
          rawServerNames: ['Connector: Company'],
          accessibleServerNames: ['Connector__Company', 'Connector: Company'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledTimes(1);
        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'Connector__Company');
        expect(result.toolDefinitions).toHaveLength(0);
      });

      it('prefers a server resolving under the parsed name as-is over the raw alias', async () => {
        /** A user-DB server may be named exactly like an operator server's
         *  normalized form; its tools must keep its own identity instead of
         *  being rerouted to the operator server. */
        const dbServerTools = {
          search_mcp_Connector__Company: {
            function: {
              name: 'search_mcp_Connector__Company',
              description: 'DB server tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockImplementation(async (_userId: string, name: string) =>
          name === 'Connector__Company' ? dbServerTools : null,
        );

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['search_mcp_Connector__Company'],
          mcpServerNames: ['Connector__Company'],
          rawServerNames: ['Connector: Company'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        expect(mockGetOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', 'Connector__Company');
        const toolDef = result.toolDefinitions[0];
        expect((toolDef as { serverName?: string }).serverName).toBe('Connector__Company');
      });

      it('should convert empty MCP tool descriptions to undefined', async () => {
        const mockServerTools = {
          no_desc_tool_mcp_asana: {
            function: {
              name: 'no_desc_tool_mcp_asana',
              description: '',
              parameters: { type: 'object', properties: {} },
            },
          },
          has_desc_tool_mcp_asana: {
            function: {
              name: 'has_desc_tool_mcp_asana',
              description: 'List tasks',
              parameters: { type: 'object', properties: {} },
            },
          },
        };

        mockGetOrFetchMCPServerTools.mockResolvedValue(mockServerTools);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['sys__all__sys_mcp_asana'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const noDef = result.toolDefinitions.find((d) => d.name === 'no_desc_tool_mcp_asana');
        expect(noDef).toBeDefined();
        expect(noDef?.description).toBeUndefined();

        const hasDef = result.toolDefinitions.find((d) => d.name === 'has_desc_tool_mcp_asana');
        expect(hasDef).toBeDefined();
        expect(hasDef?.description).toBe('List tasks');
      });

      it('should convert empty description to undefined for directly named MCP tool', async () => {
        const toolName = 'no_desc_tool_mcp_asana';
        mockGetOrFetchMCPServerTools.mockResolvedValue({
          [toolName]: {
            function: {
              name: toolName,
              description: '',
              parameters: { type: 'object', properties: {} },
            },
          },
        });

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: [toolName],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const def = result.toolDefinitions.find((d) => d.name === toolName);
        expect(def).toBeDefined();
        expect(def?.description).toBeUndefined();
      });
    });

    describe('concurrent MCP and action resolution', () => {
      type Fetched = MCPServerTools | null;
      type FetchMock = jest.Mock<Promise<Fetched>, [string, string]>;

      const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

      function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<T>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        return { promise, resolve, reject };
      }

      /** One tool per name, keyed the way a server catalog builds its keys. */
      function catalogOf(serverName: string, ...names: string[]): MCPServerTools {
        const catalog: MCPServerTools = {};
        for (const name of names) {
          const key = `${name}_mcp_${serverName}`;
          catalog[key] = {
            function: {
              name: key,
              description: `${name} on ${serverName}`,
              parameters: { type: 'object', properties: {} },
            },
          };
        }
        return catalog;
      }

      const calledServers = (fetch: FetchMock): string[] =>
        fetch.mock.calls.map(([, serverName]) => serverName);

      const toolNames = (result: Pick<LoadToolDefinitionsResult, 'toolDefinitions'>): string[] =>
        result.toolDefinitions.map(({ name }) => name);

      const toolServers = (
        result: Pick<LoadToolDefinitionsResult, 'toolDefinitions'>,
      ): [string, string | undefined][] =>
        result.toolDefinitions.map((def) => [
          def.name,
          'serverName' in def ? def.serverName : undefined,
        ]);

      const baseParams = { userId: 'user-123', agentId: 'agent-123' };

      it('starts the fetch for every distinct server before any of them resolves', async () => {
        const alpha = deferred<Fetched>();
        const beta = deferred<Fetched>();
        const fetch: FetchMock = jest.fn((_userId, serverName) =>
          serverName === 'alpha' ? alpha.promise : beta.promise,
        );

        const loading = loadToolDefinitions(
          { ...baseParams, tools: ['search_mcp_alpha', 'list_mcp_beta'] },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );
        await settle();

        try {
          expect(calledServers(fetch)).toEqual(['alpha', 'beta']);
        } finally {
          alpha.resolve(catalogOf('alpha', 'search'));
          beta.resolve(catalogOf('beta', 'list'));
        }

        const result = await loading;
        expect(toolNames(result)).toEqual(['search_mcp_alpha', 'list_mcp_beta']);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 2, resolvedToolCount: 2 });
      });

      it('fetches a server once however many of its tools are selected', async () => {
        const fetch: FetchMock = jest.fn(async (_userId, serverName) =>
          catalogOf(serverName, 'search', 'list'),
        );

        const result = await loadToolDefinitions(
          { ...baseParams, tools: ['search_mcp_alpha', 'list_mcp_beta', 'list_mcp_alpha'] },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );

        expect(calledServers(fetch).sort()).toEqual(['alpha', 'beta']);
        expect(toolNames(result)).toEqual(['search_mcp_alpha', 'list_mcp_beta', 'list_mcp_alpha']);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 3, resolvedToolCount: 3 });
      });

      it('keeps tool order in the output whatever order the fetches settle in', async () => {
        const gates = new Map([
          ['alpha', deferred<Fetched>()],
          ['beta', deferred<Fetched>()],
          ['gamma', deferred<Fetched>()],
        ]);
        const fetch: FetchMock = jest.fn(
          (_userId, serverName) => gates.get(serverName)?.promise ?? Promise.resolve(null),
        );

        const loading = loadToolDefinitions(
          { ...baseParams, tools: ['a_mcp_alpha', 'b_mcp_beta', 'c_mcp_gamma'] },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );
        await settle();

        try {
          expect(calledServers(fetch)).toEqual(['alpha', 'beta', 'gamma']);
        } finally {
          gates.get('gamma')?.resolve(catalogOf('gamma', 'c'));
          gates.get('alpha')?.resolve(catalogOf('alpha', 'a'));
          gates.get('beta')?.resolve(catalogOf('beta', 'b'));
        }

        const result = await loading;
        expect(toolNames(result)).toEqual(['a_mcp_alpha', 'b_mcp_beta', 'c_mcp_gamma']);
      });

      it('holds a lookup back until one of the allowed number has settled', async () => {
        const gates = new Map([
          ['alpha', deferred<Fetched>()],
          ['beta', deferred<Fetched>()],
          ['gamma', deferred<Fetched>()],
        ]);
        const fetch: FetchMock = jest.fn(
          (_userId, serverName) => gates.get(serverName)?.promise ?? Promise.resolve(null),
        );

        const loading = loadToolDefinitions(
          {
            ...baseParams,
            tools: ['a_mcp_alpha', 'b_mcp_beta', 'c_mcp_gamma'],
            mcpCatalogLookups: 2,
          },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );
        await settle();

        try {
          expect(calledServers(fetch)).toEqual(['alpha', 'beta']);
          gates.get('beta')?.resolve(catalogOf('beta', 'b'));
          await settle();
          expect(calledServers(fetch)).toEqual(['alpha', 'beta', 'gamma']);
        } finally {
          gates.get('alpha')?.resolve(catalogOf('alpha', 'a'));
          gates.get('beta')?.resolve(catalogOf('beta', 'b'));
          gates.get('gamma')?.resolve(catalogOf('gamma', 'c'));
        }

        const result = await loading;
        expect(toolNames(result)).toEqual(['a_mcp_alpha', 'b_mcp_beta', 'c_mcp_gamma']);
      });

      it('looks servers up one after another when the bound is 1', async () => {
        const alpha = deferred<Fetched>();
        const fetch: FetchMock = jest.fn((_userId, serverName) =>
          serverName === 'alpha' ? alpha.promise : Promise.resolve(catalogOf('beta', 'list')),
        );

        const loading = loadToolDefinitions(
          { ...baseParams, tools: ['search_mcp_alpha', 'list_mcp_beta'], mcpCatalogLookups: 1 },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );
        await settle();

        try {
          expect(calledServers(fetch)).toEqual(['alpha']);
        } finally {
          alpha.resolve(catalogOf('alpha', 'search'));
        }

        const result = await loading;
        expect(calledServers(fetch)).toEqual(['alpha', 'beta']);
        expect(toolNames(result)).toEqual(['search_mcp_alpha', 'list_mcp_beta']);
      });

      it('reports the looked-up servers in tool order whatever order they settle in', async () => {
        const gates = new Map([
          ['alpha', deferred<Fetched>()],
          ['beta', deferred<Fetched>()],
          ['gamma', deferred<Fetched>()],
        ]);
        const fetch: FetchMock = jest.fn(
          (_userId, serverName) => gates.get(serverName)?.promise ?? Promise.resolve(null),
        );

        const loading = loadToolDefinitions(
          { ...baseParams, tools: ['a_mcp_alpha', 'b_mcp_beta', 'c_mcp_gamma', 'd_mcp_alpha'] },
          { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
        );
        await settle();
        gates.get('gamma')?.resolve(catalogOf('gamma', 'c'));
        gates.get('beta')?.resolve(null);
        gates.get('alpha')?.resolve(catalogOf('alpha', 'a', 'd'));

        const result = await loading;
        expect(result.mcpServerLookupOrder).toEqual(['alpha', 'beta', 'gamma']);
      });

      describe('alias fallback', () => {
        const aliasParams = {
          ...baseParams,
          mcpServerNames: ['alpha', 'Connector__Company', 'Other__Server'],
          rawServerNames: ['alpha', 'Connector: Company', 'Other: Server'],
          accessibleServerNames: ['alpha', 'Other__Server', 'Other: Server'],
        };

        it('falls back to the raw alias only for a parsed name that is not a known server', async () => {
          const fetch: FetchMock = jest.fn(async (_userId, serverName) => {
            if (serverName === 'alpha') {
              return catalogOf('alpha', 'search');
            }
            return serverName === 'Connector: Company'
              ? catalogOf('Connector__Company', 'find')
              : null;
          });

          const result = await loadToolDefinitions(
            {
              ...aliasParams,
              tools: ['search_mcp_alpha', 'find_mcp_Connector__Company', 'ping_mcp_Other__Server'],
            },
            { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
          );

          expect(calledServers(fetch).sort()).toEqual([
            'Connector: Company',
            'Connector__Company',
            'Other__Server',
            'alpha',
          ]);
          expect(toolServers(result)).toEqual([
            ['search_mcp_alpha', 'alpha'],
            ['find_mcp_Connector__Company', 'Connector: Company'],
          ]);
          expect(result.mcpResolution).toEqual({ expectedToolCount: 3, resolvedToolCount: 2 });
        });

        it('shares one in-flight fetch between a direct lookup and an alias fallback to the same server', async () => {
          /** `Connector__Company` is not a known server, so it falls back to its raw alias,
           *  which the second tool key is already looking up directly. */
          const normalized = deferred<Fetched>();
          const raw = deferred<Fetched>();
          const fetch: FetchMock = jest.fn((_userId, serverName) =>
            serverName === 'Connector__Company' ? normalized.promise : raw.promise,
          );

          const loading = loadToolDefinitions(
            {
              ...aliasParams,
              tools: ['search_mcp_Connector__Company', 'lookup_mcp_Connector: Company'],
            },
            { getOrFetchMCPServerTools: fetch, isBuiltInTool: () => false },
          );
          await settle();
          normalized.resolve(null);
          await settle();
          raw.resolve({
            ...catalogOf('Connector__Company', 'search'),
            ...catalogOf('Connector: Company', 'lookup'),
          });

          const result = await loading;
          expect(calledServers(fetch)).toEqual(['Connector__Company', 'Connector: Company']);
          expect(toolServers(result)).toEqual([
            ['search_mcp_Connector__Company', 'Connector: Company'],
            ['lookup_mcp_Connector: Company', 'Connector: Company'],
          ]);
        });
      });

      it('keeps definition order, counts and OAuth action names for a mixed tool list', async () => {
        const fetch: FetchMock = jest.fn(async (_userId, serverName) =>
          serverName === 'alpha' ? catalogOf('alpha', 'search') : catalogOf('beta', 'list', 'get'),
        );
        const getActionToolDefinitions = jest.fn<
          Promise<ActionToolDefinition[]>,
          [string, string[]]
        >(async () => [
          { name: 'getWeather_action_weather_com', description: 'Get weather' },
          { name: 'sendMail_action_mail_example_com', description: 'Send an email', oauth: true },
        ]);

        const result = await loadToolDefinitions(
          {
            ...baseParams,
            tools: [
              'calculator',
              'search_mcp_alpha',
              'getWeather_action_weather---com',
              'sys__all__sys_mcp_beta',
              'web_search',
              'ghost_mcp_alpha',
              'sys__server__sys_mcp_alpha',
              'sendMail_action_mail---example---com',
              'not_a_builtin',
            ],
          },
          {
            getOrFetchMCPServerTools: fetch,
            getActionToolDefinitions,
            isBuiltInTool: (name) => name === 'calculator' || name === 'web_search',
          },
        );

        expect(toolNames(result)).toEqual([
          'search_mcp_alpha',
          'list_mcp_beta',
          'get_mcp_beta',
          'getWeather_action_weather_com',
          'sendMail_action_mail_example_com',
          'calculator',
          'web_search',
        ]);
        expect(result.mcpResolution).toEqual({ expectedToolCount: 3, resolvedToolCount: 3 });
        expect(result.oauthActionToolNames).toEqual(['sendMail_action_mail_example_com']);
        expect(calledServers(fetch).sort()).toEqual(['alpha', 'beta']);
        expect(getActionToolDefinitions).toHaveBeenCalledWith('agent-123', [
          'getWeather_action_weather---com',
          'sendMail_action_mail---example---com',
        ]);
      });

      it('starts the action definition fetch while MCP fetches are still pending', async () => {
        const alpha = deferred<Fetched>();
        const actions = deferred<ActionToolDefinition[]>();
        const fetch = jest.fn<Promise<Fetched>, [string, string]>(() => alpha.promise);
        const getActionToolDefinitions = jest.fn<
          Promise<ActionToolDefinition[]>,
          [string, string[]]
        >(() => actions.promise);

        const loading = loadToolDefinitions(
          { ...baseParams, tools: ['search_mcp_alpha', 'getWeather_action_weather---com'] },
          { getOrFetchMCPServerTools: fetch, getActionToolDefinitions, isBuiltInTool: () => false },
        );
        await settle();

        try {
          expect(getActionToolDefinitions).toHaveBeenCalledWith('agent-123', [
            'getWeather_action_weather---com',
          ]);
          expect(calledServers(fetch)).toEqual(['alpha']);
        } finally {
          actions.resolve([{ name: 'getWeather_action_weather_com', description: 'Get weather' }]);
          alpha.resolve(catalogOf('alpha', 'search'));
        }

        const result = await loading;
        expect(toolNames(result)).toEqual(['search_mcp_alpha', 'getWeather_action_weather_com']);
      });

      describe('failures', () => {
        const failureTools = ['a_mcp_alpha', 'b_mcp_beta'];

        it('rejects with the error of a rejecting fetch, while a null fetch only leaves the server empty', async () => {
          const failure = new Error('registry down');

          await expect(
            loadToolDefinitions(
              { ...baseParams, tools: failureTools },
              {
                getOrFetchMCPServerTools: async (_userId, serverName) => {
                  if (serverName === 'alpha') {
                    throw failure;
                  }
                  return catalogOf('beta', 'b');
                },
                isBuiltInTool: () => false,
              },
            ),
          ).rejects.toBe(failure);

          const unavailable = await loadToolDefinitions(
            { ...baseParams, tools: failureTools },
            { getOrFetchMCPServerTools: async () => null, isBuiltInTool: () => false },
          );
          expect(unavailable.toolDefinitions).toEqual([]);
          expect(unavailable.mcpResolution).toEqual({ expectedToolCount: 2, resolvedToolCount: 0 });
        });

        it('rejects with the error of the action fetch', async () => {
          const failure = new Error('actions unavailable');

          await expect(
            loadToolDefinitions(
              { ...baseParams, tools: ['a_mcp_alpha', 'getWeather_action_weather---com'] },
              {
                getOrFetchMCPServerTools: async () => catalogOf('alpha', 'a'),
                getActionToolDefinitions: async () => {
                  throw failure;
                },
                isBuiltInTool: () => false,
              },
            ),
          ).rejects.toBe(failure);
        });

        it('leaves no unhandled rejection when the other fetches fail after the first failure', async () => {
          /** jest-circus fails the running test on an unhandled rejection, so finishing this one
           *  after the late failures have fired is the assertion. */
          const failLater: Array<() => void> = [];
          const failLate = (label: string): Promise<never> =>
            new Promise((_resolve, reject) => {
              failLater.push(() => reject(new Error(`${label} failed late`)));
            });
          const fetch: FetchMock = jest.fn((_userId, serverName) =>
            serverName === 'alpha'
              ? Promise.reject(new Error('alpha failed'))
              : failLate(serverName),
          );
          const getActionToolDefinitions = jest.fn<
            Promise<ActionToolDefinition[]>,
            [string, string[]]
          >(() => failLate('actions'));

          await expect(
            loadToolDefinitions(
              {
                ...baseParams,
                tools: [
                  'a_mcp_alpha',
                  'b_mcp_beta',
                  'c_mcp_gamma',
                  'getWeather_action_weather---com',
                ],
              },
              {
                getOrFetchMCPServerTools: fetch,
                getActionToolDefinitions,
                isBuiltInTool: () => false,
              },
            ),
          ).rejects.toThrow('alpha failed');

          expect(failLater).toHaveLength(3);
          failLater.forEach((fail) => fail());
          await settle();
          await settle();
        });
      });

      describe('refresh', () => {
        it('stays serial and happens once per server', async () => {
          const staleAlpha = catalogOf('alpha', 'list');
          const staleBeta = catalogOf('beta', 'list');
          const alphaRefresh = deferred<Fetched>();
          const betaRefresh = deferred<Fetched>();
          const refresh: FetchMock = jest.fn((_userId, serverName) =>
            serverName === 'alpha' ? alphaRefresh.promise : betaRefresh.promise,
          );

          const loading = loadToolDefinitions(
            { ...baseParams, tools: ['run_mcp_alpha', 'run_mcp_beta', 'other_mcp_alpha'] },
            {
              getOrFetchMCPServerTools: async (_userId, serverName) =>
                serverName === 'alpha' ? staleAlpha : staleBeta,
              refreshMCPServerTools: refresh,
              isBuiltInTool: () => false,
            },
          );
          await settle();
          expect(calledServers(refresh)).toEqual(['alpha']);

          alphaRefresh.resolve({ ...staleAlpha, ...catalogOf('alpha', 'run', 'other') });
          await settle();
          expect(calledServers(refresh)).toEqual(['alpha', 'beta']);

          betaRefresh.resolve({ ...staleBeta, ...catalogOf('beta', 'run') });
          const result = await loading;

          expect(calledServers(refresh)).toEqual(['alpha', 'beta']);
          expect(toolNames(result)).toEqual(['run_mcp_alpha', 'run_mcp_beta', 'other_mcp_alpha']);
        });

        it('resolves a later spelling of a refreshed server against the refreshed catalog', async () => {
          /** The refreshed catalog is what a later lookup of the same server returns, as it is
           *  for the request-scoped tool memory the real loader dependency keeps. */
          let current: MCPServerTools = catalogOf('Connector__Company', 'other');
          const refreshed: MCPServerTools = {
            ...current,
            ...catalogOf('Connector__Company', 'search'),
            ...catalogOf('Connector: Company', 'lookup'),
          };

          const result = await loadToolDefinitions(
            {
              ...baseParams,
              tools: ['search_mcp_Connector__Company', 'lookup_mcp_Connector: Company'],
              mcpServerNames: ['Connector__Company'],
              rawServerNames: ['Connector: Company'],
            },
            {
              getOrFetchMCPServerTools: async (_userId, serverName) =>
                serverName === 'Connector: Company' ? current : null,
              refreshMCPServerTools: async () => {
                current = refreshed;
                return refreshed;
              },
              isBuiltInTool: () => false,
            },
          );

          expect(toolNames(result)).toEqual([
            'search_mcp_Connector__Company',
            'lookup_mcp_Connector: Company',
          ]);
          expect(result.mcpResolution).toEqual({ expectedToolCount: 2, resolvedToolCount: 2 });
        });

        it('resolves a later spelling again after a refresh made its server available', async () => {
          /** `legacy_mcp_Other: Server` names the raw server, unavailable until its refresh;
           *  `search_mcp_Other__Server` reaches the same server through its alias. */
          let available = false;
          const catalog: MCPServerTools = {
            ...catalogOf('Other__Server', 'search'),
            ...catalogOf('Other: Server', 'legacy'),
          };
          const refresh: FetchMock = jest.fn(async (_userId, serverName) => {
            if (serverName !== 'Other: Server') {
              return null;
            }
            available = true;
            return catalog;
          });

          const result = await loadToolDefinitions(
            {
              ...baseParams,
              tools: ['legacy_mcp_Other: Server', 'search_mcp_Other__Server'],
              mcpServerNames: ['Other__Server'],
              rawServerNames: ['Other: Server'],
            },
            {
              getOrFetchMCPServerTools: async (_userId, serverName) =>
                serverName === 'Other: Server' && available ? catalog : null,
              refreshMCPServerTools: refresh,
              isBuiltInTool: () => false,
            },
          );

          expect(calledServers(refresh)).toEqual(['Other: Server']);
          expect(toolServers(result)).toEqual([
            ['legacy_mcp_Other: Server', 'Other: Server'],
            ['search_mcp_Other__Server', 'Other: Server'],
          ]);
        });

        it('keeps an earlier spelling on the catalog it was resolved with', async () => {
          /** A tool only the refreshed catalog holds stays unresolved under the spelling that
           *  was already resolved: a refresh through the other spelling does not rewrite it. */
          let current: MCPServerTools = catalogOf('Connector__Company', 't2');
          const refreshed: MCPServerTools = {
            ...catalogOf('Connector__Company', 't2', 't3'),
            ...catalogOf('Connector: Company', 't3'),
          };

          const result = await loadToolDefinitions(
            {
              ...baseParams,
              tools: [
                't2_mcp_Connector__Company',
                't3_mcp_Connector: Company',
                't3_mcp_Connector__Company',
              ],
              mcpServerNames: ['Connector__Company'],
              rawServerNames: ['Connector: Company'],
            },
            {
              getOrFetchMCPServerTools: async (_userId, serverName) =>
                serverName === 'Connector: Company' ? current : null,
              refreshMCPServerTools: async () => {
                current = refreshed;
                return refreshed;
              },
              isBuiltInTool: () => false,
            },
          );

          expect(toolNames(result)).toEqual([
            't2_mcp_Connector__Company',
            't3_mcp_Connector: Company',
          ]);
          expect(result.mcpResolution).toEqual({ expectedToolCount: 3, resolvedToolCount: 2 });
        });
      });
    });

    describe('toolkit expansion', () => {
      it('should expand image_gen_oai to include image_edit_oai', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'image_gen_oai');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['image_gen_oai'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const genDef = result.toolDefinitions.find((d) => d.name === 'image_gen_oai');
        const editDef = result.toolDefinitions.find((d) => d.name === 'image_edit_oai');
        expect(genDef).toBeDefined();
        expect(editDef).toBeDefined();
        expect(editDef?.parameters).toBeDefined();
        expect(result.toolRegistry.has('image_gen_oai')).toBe(true);
        expect(result.toolRegistry.has('image_edit_oai')).toBe(true);
      });

      it('should not duplicate image_edit_oai when toolkit is the only tool', async () => {
        mockIsBuiltInTool.mockImplementation((name) => name === 'image_gen_oai');

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['image_gen_oai'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
        };

        const result = await loadToolDefinitions(params, deps);

        const editDefs = result.toolDefinitions.filter((d) => d.name === 'image_edit_oai');
        expect(editDefs).toHaveLength(1);
      });
    });

    describe('toolkit mapping invariants', () => {
      it('toolkitParent should be the inverse of toolkitExpansion', () => {
        expect(toolkitParent['image_edit_oai']).toBe('image_gen_oai');
        const parentKeys = Object.keys(toolkitParent).sort();
        const expansionChildren = Object.values(toolkitExpansion).flat().sort();
        expect(parentKeys).toEqual(expansionChildren);
      });

      it('every toolkitExpansion entry should reference existing tool definitions', () => {
        for (const [parent, children] of Object.entries(toolkitExpansion)) {
          expect(getToolDefinition(parent)).toBeDefined();
          for (const child of children) {
            expect(getToolDefinition(child)).toBeDefined();
          }
        }
      });
    });

    describe('tool registry metadata', () => {
      it('should include description and parameters in registry for action tools', async () => {
        const mockActionDefs: ActionToolDefinition[] = [
          {
            name: 'getWeather_action_weather_com',
            description: 'Get weather for a location',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'City name' },
              },
              required: ['city'],
            },
          },
        ];

        const mockGetActionToolDefinitions = jest.fn().mockResolvedValue(mockActionDefs);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['getWeather_action_weather---com'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        const result = await loadToolDefinitions(params, deps);

        const registryEntry = result.toolRegistry.get('getWeather_action_weather_com');
        expect(registryEntry).toBeDefined();
        expect(registryEntry?.description).toBe('Get weather for a location');
        expect(registryEntry?.parameters).toBeDefined();
        expect(registryEntry?.parameters?.properties).toHaveProperty('city');
        expect(registryEntry?.allowed_callers).toContain('direct');
      });

      it('should handle action tools without parameters in registry', async () => {
        const mockActionDefs: ActionToolDefinition[] = [
          {
            name: 'ping_action_api_com',
            description: 'Ping the API',
          },
        ];

        const mockGetActionToolDefinitions = jest.fn().mockResolvedValue(mockActionDefs);

        const params: LoadToolDefinitionsParams = {
          userId: 'user-123',
          agentId: 'agent-123',
          tools: ['ping_action_api---com'],
        };

        const deps: LoadToolDefinitionsDeps = {
          getOrFetchMCPServerTools: mockGetOrFetchMCPServerTools,
          isBuiltInTool: mockIsBuiltInTool,
          getActionToolDefinitions: mockGetActionToolDefinitions,
        };

        const result = await loadToolDefinitions(params, deps);

        const registryEntry = result.toolRegistry.get('ping_action_api_com');
        expect(registryEntry).toBeDefined();
        expect(registryEntry?.description).toBe('Ping the API');
        expect(registryEntry?.parameters).toBeUndefined();
        expect(registryEntry?.allowed_callers).toContain('direct');
      });
    });
  });
});

test('definitions-only loading retains the verified reset key without collapsing a collision sibling', async () => {
  const current = 'query_mcp_db';
  const legacy = 'db_query_mcp_db';
  const catalog = {
    [current]: {
      function: { name: current, parameters: { type: 'object' as const } },
      serverToolName: 'db_query',
    },
  };
  const options = {
    [current]: {
      approval_mode: 'chat' as const,
      approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
    },
  };
  const result = await loadToolDefinitions(
    {
      userId: 'user-a',
      agentId: 'agent-a',
      tools: [legacy],
      toolOptions: options,
      mcpServerNames: ['db'],
      rawServerNames: ['db'],
    },
    {
      getOrFetchMCPServerTools: async () => catalog,
      isBuiltInTool: () => false,
    },
  );
  expect(result.toolDefinitions[0].name).toBe(legacy);
  expect(getToolApprovalName(result.toolDefinitions[0])).toBe(current);
  const collision = await loadToolDefinitions(
    {
      userId: 'user-a',
      agentId: 'agent-a',
      tools: [legacy],
      mcpServerNames: ['db'],
      rawServerNames: ['db'],
    },
    {
      getOrFetchMCPServerTools: async () => ({
        ...catalog,
        [legacy]: { function: { name: legacy, parameters: { type: 'object' as const } } },
      }),
      isBuiltInTool: () => false,
    },
  );
  expect(getToolApprovalName(collision.toolDefinitions[0])).toBeUndefined();
});

test('live catalog reassignment changes consent while retaining the same displayed key and schema', async () => {
  const upstream = (name: string) => ({
    name,
    description: 'Same description',
    inputSchema: { type: 'object' as const, properties: {} },
  });
  const before = formatMCPServerTools('db', [upstream('query'), upstream('db_query')]);
  const after = formatMCPServerTools('db', [upstream('db_query')]);
  const params = {
    userId: 'user-a',
    agentId: 'agent-a',
    tools: ['query_mcp_db'],
    mcpServerNames: ['db'],
    rawServerNames: ['db'],
  };
  const first = await loadToolDefinitions(params, {
    isBuiltInTool: () => false,
    getOrFetchMCPServerTools: async () => before,
  });
  const second = await loadToolDefinitions(params, {
    isBuiltInTool: () => false,
    getOrFetchMCPServerTools: async () => after,
  });
  expect(second.toolDefinitions[0].name).toBe(first.toolDefinitions[0].name);
  expect(getToolApprovalIdentity(second.toolDefinitions[0])).not.toBe(
    getToolApprovalIdentity(first.toolDefinitions[0]),
  );
});

describe('orderMCPServerNames', () => {
  it('puts the names in lookup order', () => {
    expect(
      orderMCPServerNames(new Set(['gamma', 'alpha', 'beta']), ['alpha', 'beta', 'gamma']),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('keeps names that were never looked up after the rest, in the order given', () => {
    expect(orderMCPServerNames(['late', 'beta', 'other', 'alpha'], ['alpha', 'beta'])).toEqual([
      'alpha',
      'beta',
      'late',
      'other',
    ]);
  });

  it('returns nothing for no names', () => {
    expect(orderMCPServerNames([], ['alpha'])).toEqual([]);
  });

  it('returns the names as given when no lookup order is known', () => {
    expect(orderMCPServerNames(new Set(['beta', 'alpha']))).toEqual(['beta', 'alpha']);
  });
});
