import { Providers, WebSearchToolDefinition } from '@librechat/agents';
import type {
  LoadToolDefinitionsParams,
  LoadToolDefinitionsDeps,
  ActionToolDefinition,
} from './definitions';
import { toolkitExpansion, toolkitParent } from './toolkits/mapping';
import { getToolDefinition } from './registry/definitions';
import { loadToolDefinitions } from './definitions';

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
