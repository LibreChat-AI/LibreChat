import { Providers } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { GenericTool } from '@librechat/agents';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import type { LCToolRegistry } from './classification';
import {
  buildToolRegistryFromAgentOptions,
  aliasMCPToolOptions,
  agentHasProgrammaticTools,
  buildToolClassification,
  collectMCPToolAliases,
  getServerNameFromTool,
  agentHasDeferredTools,
} from './classification';

describe('classification.ts', () => {
  describe('getServerNameFromTool', () => {
    it('should extract server name from MCP tool name', () => {
      const result = getServerNameFromTool('list_files_mcp_Google-Workspace');
      expect(result).toBe('Google-Workspace');
    });

    it('should return undefined for non-MCP tool', () => {
      const result = getServerNameFromTool('simple_tool');
      expect(result).toBeUndefined();
    });

    it('should handle multiple delimiters', () => {
      const result = getServerNameFromTool('some_tool_mcp_Server_Name');
      expect(result).toBe('Server_Name');
    });
  });

  describe('collectMCPToolAliases', () => {
    it('collects both alias directions from definitions', () => {
      const defs = [
        { name: 'search_mcp_acme', serverName: 'acme', serverToolName: 'acme_search' },
        {
          name: 'acme_list_mcp_acme',
          serverName: 'acme',
          serverToolName: 'acme_list',
          currentToolName: 'list',
        },
        { name: 'plain_mcp_acme', serverName: 'acme' },
      ];

      expect(collectMCPToolAliases(defs)).toEqual([
        { name: 'search_mcp_acme', aliasName: 'acme_search_mcp_acme' },
        { name: 'acme_list_mcp_acme', aliasName: 'list_mcp_acme' },
      ]);
    });

    it('normalizes the server name when reconstructing alias keys', () => {
      const defs = [
        {
          name: 'search_mcp_My_Server',
          serverName: 'My Server',
          serverToolName: 'my_server_search',
        },
      ];

      expect(collectMCPToolAliases(defs)).toEqual([
        { name: 'search_mcp_My_Server', aliasName: 'my_server_search_mcp_My_Server' },
      ]);
    });
  });

  describe('aliasMCPToolOptions', () => {
    it('aliases pre-strip option keys onto the current instance name, identity-gated', () => {
      /** Wildcard-expanded catalogs rename stripped tools without any
       *  `agent.tools` entry to preserve the spelling — persisted defer,
       *  programmatic, background, and intent settings must follow. */
      const defs = [
        {
          name: 'search_mcp_acme',
          serverName: 'acme',
          serverToolName: 'acme_search',
        },
        { name: 'list_items_mcp_acme', serverName: 'acme' },
      ];
      const agentToolOptions: AgentToolOptions = {
        acme_search_mcp_acme: { defer_loading: true },
      };

      aliasMCPToolOptions(collectMCPToolAliases(defs), agentToolOptions);

      expect(agentToolOptions['search_mcp_acme']).toEqual({ defer_loading: true });
      const registry = buildToolRegistryFromAgentOptions(defs, agentToolOptions);
      expect(registry.get('search_mcp_acme')?.defer_loading).toBe(true);
    });

    it('aliases current-keyed options back onto a legacy-named instance', () => {
      /** The editor migrates `tool_options` keys to the current catalog
       *  spelling, while an unedited `agent.tools` entry keeps the legacy
       *  instance name — options must follow the reverse direction too. */
      const defs = [
        {
          name: 'acme_search_mcp_acme',
          serverName: 'acme',
          serverToolName: 'acme_search',
          currentToolName: 'search',
        },
      ];
      const agentToolOptions: AgentToolOptions = {
        search_mcp_acme: { defer_loading: true },
      };

      aliasMCPToolOptions(collectMCPToolAliases(defs), agentToolOptions);

      expect(agentToolOptions['acme_search_mcp_acme']).toEqual({ defer_loading: true });
      const registry = buildToolRegistryFromAgentOptions(defs, agentToolOptions);
      expect(registry.get('acme_search_mcp_acme')?.defer_loading).toBe(true);
    });

    it('never overrides an explicit entry under the instance name', () => {
      const defs = [{ name: 'search_mcp_acme', serverName: 'acme', serverToolName: 'acme_search' }];
      const agentToolOptions: AgentToolOptions = {
        search_mcp_acme: { defer_loading: false },
        acme_search_mcp_acme: { defer_loading: true },
      };

      aliasMCPToolOptions(collectMCPToolAliases(defs), agentToolOptions);

      expect(agentToolOptions['search_mcp_acme']).toEqual({ defer_loading: false });
    });

    it('does nothing without recorded upstream identity', () => {
      const defs = [{ name: 'search_mcp_acme', serverName: 'acme' }];
      const agentToolOptions: AgentToolOptions = {
        acme_search_mcp_acme: { defer_loading: true },
      };

      aliasMCPToolOptions(collectMCPToolAliases(defs), agentToolOptions);

      expect(agentToolOptions['search_mcp_acme']).toBeUndefined();
    });
  });

  describe('buildToolRegistryFromAgentOptions', () => {
    it('should use agent tool options for defer_loading', () => {
      const tools = [
        { name: 'tool1', description: 'Tool 1' },
        { name: 'tool2', description: 'Tool 2' },
      ];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
        tool2: { defer_loading: false },
      };

      const registry = buildToolRegistryFromAgentOptions(tools, agentToolOptions);

      expect(registry.get('tool1')?.defer_loading).toBe(true);
      expect(registry.get('tool2')?.defer_loading).toBe(false);
    });

    it('should default defer_loading to false when not specified', () => {
      const tools = [{ name: 'tool1', description: 'Tool 1' }];

      const agentToolOptions: AgentToolOptions = {};

      const registry = buildToolRegistryFromAgentOptions(tools, agentToolOptions);

      expect(registry.get('tool1')?.defer_loading).toBe(false);
    });

    it('should use agent allowed_callers when specified', () => {
      const tools = [{ name: 'tool1', description: 'Tool 1' }];

      const agentToolOptions: AgentToolOptions = {
        tool1: { allowed_callers: ['code_execution'] },
      };

      const registry = buildToolRegistryFromAgentOptions(tools, agentToolOptions);

      expect(registry.get('tool1')?.allowed_callers).toEqual(['code_execution']);
    });

    it('should default allowed_callers to direct when not specified', () => {
      const tools = [{ name: 'tool1', description: 'Tool 1' }];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const registry = buildToolRegistryFromAgentOptions(tools, agentToolOptions);

      expect(registry.get('tool1')?.allowed_callers).toEqual(['direct']);
    });
  });

  describe('agentHasDeferredTools', () => {
    it('should return true when registry has deferred tools', () => {
      const registry: LCToolRegistry = new Map([
        ['tool1', { name: 'tool1', allowed_callers: ['direct'], defer_loading: true }],
        ['tool2', { name: 'tool2', allowed_callers: ['direct'], defer_loading: false }],
      ]);

      expect(agentHasDeferredTools(registry)).toBe(true);
    });

    it('should return false when no tools are deferred', () => {
      const registry: LCToolRegistry = new Map([
        ['tool1', { name: 'tool1', allowed_callers: ['direct'], defer_loading: false }],
        ['tool2', { name: 'tool2', allowed_callers: ['direct'], defer_loading: false }],
      ]);

      expect(agentHasDeferredTools(registry)).toBe(false);
    });

    it('should return false for empty registry', () => {
      const registry: LCToolRegistry = new Map();
      expect(agentHasDeferredTools(registry)).toBe(false);
    });
  });

  describe('agentHasProgrammaticTools', () => {
    it('should return true when registry has programmatic tools', () => {
      const registry: LCToolRegistry = new Map([
        ['tool1', { name: 'tool1', allowed_callers: ['code_execution'], defer_loading: false }],
      ]);

      expect(agentHasProgrammaticTools(registry)).toBe(true);
    });

    it('should return true for dual context tools', () => {
      const registry: LCToolRegistry = new Map([
        [
          'tool1',
          { name: 'tool1', allowed_callers: ['direct', 'code_execution'], defer_loading: false },
        ],
      ]);

      expect(agentHasProgrammaticTools(registry)).toBe(true);
    });

    it('should return false when no programmatic tools', () => {
      const registry: LCToolRegistry = new Map([
        ['tool1', { name: 'tool1', allowed_callers: ['direct'], defer_loading: false }],
      ]);

      expect(agentHasProgrammaticTools(registry)).toBe(false);
    });
  });

  describe('buildToolClassification with deferredToolsEnabled', () => {
    const createMCPTool = (name: string, description?: string) =>
      ({
        name,
        description,
        mcp: true,
        mcpJsonSchema: { type: 'object', properties: {} },
      }) as unknown as GenericTool;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return hasDeferredTools: false when deferredToolsEnabled is false', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1'), createMCPTool('tool2')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: false,
      });

      expect(result.hasDeferredTools).toBe(false);
      expect(result.additionalTools.length).toBe(0);
    });

    it('should clear defer_loading from all tools when deferredToolsEnabled is false', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1'), createMCPTool('tool2')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: false,
      });

      expect(result.toolRegistry).toBeDefined();
      expect(result.toolRegistry?.get('tool1')?.defer_loading).toBe(false);
      expect(result.toolRegistry?.get('tool2')?.defer_loading).toBe(false);
    });

    it('should preserve defer_loading when deferredToolsEnabled is true', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1'), createMCPTool('tool2')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
        tool2: { defer_loading: false },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
      });

      expect(result.hasDeferredTools).toBe(true);
      expect(result.toolRegistry?.get('tool1')?.defer_loading).toBe(true);
      expect(result.toolRegistry?.get('tool2')?.defer_loading).toBe(false);
    });

    it('should create tool search when deferredToolsEnabled is true and has deferred tools', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
      });

      expect(result.hasDeferredTools).toBe(true);
      expect(result.additionalTools.some((t) => t.name === 'tool_search')).toBe(true);
    });

    it('should NOT create tool search when deferredToolsEnabled is false', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: false,
      });

      expect(result.hasDeferredTools).toBe(false);
      expect(result.additionalTools.some((t) => t.name === 'tool_search')).toBe(false);
    });

    it('should default deferredToolsEnabled to true when not specified', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
      });

      expect(result.hasDeferredTools).toBe(true);
    });

    it('should return early when no MCP tools are present', async () => {
      const loadedTools: GenericTool[] = [
        { name: 'regular_tool', mcp: false } as unknown as GenericTool,
      ];

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        deferredToolsEnabled: true,
      });

      expect(result.toolRegistry).toBeUndefined();
      expect(result.hasDeferredTools).toBe(false);
      expect(result.additionalTools.length).toBe(0);
    });
  });

  describe('buildToolClassification with definitionsOnly', () => {
    const createMCPTool = (name: string, description?: string) =>
      ({
        name,
        description,
        mcp: true,
        mcpJsonSchema: { type: 'object', properties: {} },
      }) as unknown as GenericTool;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should NOT create tool instances when definitionsOnly=true', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        programmaticToolsEnabled: true,
        codeExecutionEnabled: true,
        definitionsOnly: true,
      });

      expect(result.additionalTools.length).toBe(0);
    });

    it('should still add tool_search definition when definitionsOnly=true and has deferred tools', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        programmaticToolsEnabled: true,
        codeExecutionEnabled: true,
        definitionsOnly: true,
      });

      expect(result.toolDefinitions.some((d) => d.name === 'tool_search')).toBe(true);
      expect(result.toolRegistry?.has('tool_search')).toBe(true);
    });

    type ToolSearchParams = {
      properties?: Record<string, { oneOf?: unknown[]; type?: string }>;
    };

    it('should sanitize the tool_search schema for Google providers (no union types)', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        definitionsOnly: true,
        provider: Providers.GOOGLE,
      });

      const toolSearchDef = result.toolDefinitions.find((d) => d.name === 'tool_search');
      const params = toolSearchDef?.parameters as ToolSearchParams | undefined;
      expect(params?.properties?.mcp_server?.oneOf).toBeUndefined();
      expect(params?.properties?.mcp_server?.type).toBe('string');
    });

    it('should sanitize the tool_search instance schema for Vertex AI provider', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        provider: Providers.VERTEXAI,
      });

      const toolSearchTool = result.additionalTools.find((t) => t.name === 'tool_search');
      const schema = (toolSearchTool as unknown as { schema: ToolSearchParams }).schema;
      expect(schema.properties?.mcp_server?.oneOf).toBeUndefined();
      expect(schema.properties?.mcp_server?.type).toBe('string');
    });

    it('should keep the original tool_search schema for non-Google providers', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        definitionsOnly: true,
        provider: Providers.OPENAI,
      });

      const toolSearchDef = result.toolDefinitions.find((d) => d.name === 'tool_search');
      const params = toolSearchDef?.parameters as ToolSearchParams | undefined;
      expect(Array.isArray(params?.properties?.mcp_server?.oneOf)).toBe(true);
    });

    it('should add PTC definition when definitionsOnly=true and capabilities allow programmatic tools', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { allowed_callers: ['code_execution'] },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
        programmaticToolsEnabled: true,
        codeExecutionEnabled: true,
        definitionsOnly: true,
      });

      expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(true);
      expect(result.toolRegistry?.has('run_tools_with_bash')).toBe(true);
      expect(result.additionalTools.length).toBe(0);
    });

    it.each(
      [false, true].flatMap((definitionsOnly) => [
        {
          definitionsOnly,
          statefulWorkspace: false,
          runtimes: ['bash'],
          supported: false,
          selected: false,
        },
        {
          definitionsOnly,
          statefulWorkspace: true,
          runtimes: ['py'],
          supported: false,
          selected: false,
        },
        {
          definitionsOnly,
          statefulWorkspace: true,
          runtimes: ['bash'],
          supported: false,
          selected: false,
        },
        {
          definitionsOnly,
          statefulWorkspace: false,
          runtimes: [],
          supported: true,
          selected: true,
        },
      ]),
    )(
      'gates attached PTC: definitionsOnly=$definitionsOnly stateful=$statefulWorkspace runtimes=$runtimes',
      async ({ definitionsOnly, statefulWorkspace, runtimes, supported, selected }) => {
        const workerId = `worker-${definitionsOnly}-${statefulWorkspace}-${runtimes[0]}-${selected}`;
        process.env.TEST_CODE_CAPABILITY_TOKEN = 'capability-test-token';
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              workerId: workerId,
              online: true,
              ready: true,
              leaseExpiresInMs: 45_000,
              capabilities: {
                statefulWorkspace,
                sandboxProfile: 'native-srt',
                runtimes,
                ...(selected
                  ? {
                      workspaceTools: {
                        protocolVersion: 1,
                        operations: ['execute_command'],
                        programmaticLanguages: ['bash'],
                        workspaces: [{ id: 'project-a', operations: ['execute_command'] }],
                      },
                    }
                  : {}),
              },
            }),
          ),
        );
        const codeEnvironments: CodeEnvironmentConfig[] = [
          {
            id: 'attached',
            name: 'Attached',
            type: 'attached',
            owner: 'deployment',
            baseURL: 'https://code.example',
            pairing: {
              workerId: workerId,
              allowPrincipalWorkers: false,
              tokenEnv: 'TEST_CODE_CAPABILITY_TOKEN',
            },
          },
        ];
        try {
          const result = await buildToolClassification({
            loadedTools: [createMCPTool('tool1')],
            userId: 'user1',
            agentId: 'agent1',
            agentToolOptions: {
              tool1: { allowed_callers: ['direct', 'code_execution'], defer_loading: true },
            },
            programmaticToolsEnabled: true,
            codeExecutionEnabled: true,
            deferredToolsEnabled: true,
            definitionsOnly,
            codeExecutionContext: {
              baseUrl: 'https://code.example',
              codeSessionKey: 'session',
              executionProfile: 'stateful',
              statefulSessions: true,
              environmentType: 'attached',
              environmentId: 'attached',
              bridgeWorkerId: workerId,
              ...(selected
                ? {
                    codeWorkspace: {
                      environmentId: 'attached',
                      workspaceId: 'project-a',
                      operations: ['execute_command' as const],
                    },
                  }
                : {}),
            },
            codeEnvironments,
            getAppConfig: jest.fn().mockResolvedValue({
              endpoints: { agents: { statefulCodeSessions: { environments: codeEnvironments } } },
            }),
          });
          expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(
            supported,
          );
          expect(result.toolRegistry?.has('run_tools_with_bash')).toBe(supported);
          expect(result.additionalTools.some((tool) => tool.name === 'run_tools_with_bash')).toBe(
            supported && !definitionsOnly,
          );
          expect(result.hasDeferredTools).toBe(true);
          expect(result.toolRegistry?.get('tool1')?.allowed_callers).toEqual([
            'direct',
            'code_execution',
          ]);
          if (selected) {
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(
              result.toolDefinitions.find((tool) => tool.name === 'run_tools_with_bash')
                ?.description,
            ).toContain('selected persistent workspace');
          } else expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
          delete process.env.TEST_CODE_CAPABILITY_TOKEN;
        }
      },
    );

    it('should create bash PTC tool when capabilities allow programmatic tools', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { allowed_callers: ['code_execution'] },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        programmaticToolsEnabled: true,
        codeExecutionEnabled: true,
      });

      expect(result.additionalTools.some((t) => t.name === 'run_tools_with_bash')).toBe(true);
      expect(result.additionalTools.some((t) => t.name === 'run_tools_with_code')).toBe(false);
      expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(true);
    });

    it('should not add PTC when programmatic tools capability is disabled', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions: {
          tool1: { allowed_callers: ['code_execution'] },
        },
        codeExecutionEnabled: true,
      });

      expect(result.additionalTools.some((t) => t.name === 'run_tools_with_bash')).toBe(false);
      expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(false);
      expect(result.toolRegistry?.has('run_tools_with_bash')).toBe(false);
    });

    it('should not add PTC when code execution is not enabled for the agent', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions: {
          tool1: { allowed_callers: ['code_execution'] },
        },
        programmaticToolsEnabled: true,
      });

      expect(result.additionalTools.some((t) => t.name === 'run_tools_with_bash')).toBe(false);
      expect(result.toolDefinitions.some((d) => d.name === 'run_tools_with_bash')).toBe(false);
      expect(result.toolRegistry?.has('run_tools_with_bash')).toBe(false);
    });

    it('should create tool instances when definitionsOnly=false (default)', async () => {
      const loadedTools: GenericTool[] = [createMCPTool('tool1')];

      const agentToolOptions: AgentToolOptions = {
        tool1: { defer_loading: true },
      };

      const result = await buildToolClassification({
        loadedTools,
        userId: 'user1',
        agentId: 'agent1',
        agentToolOptions,
        deferredToolsEnabled: true,
      });

      expect(result.additionalTools.some((t) => t.name === 'tool_search')).toBe(true);
    });
  });
});
