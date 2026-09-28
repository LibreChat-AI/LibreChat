import { Providers, BashProgrammaticToolCallingDefinition } from '@librechat/agents';
import { Tools, Constants, FileSources, AgentCapabilities } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MCPServerTools } from '~/tools/definitions';
import {
  applyEndpointProgrammaticCapabilities,
  resolveAgentProgrammaticToolServers,
} from '../programmatic';
import { loadToolDefinitions } from '~/tools/definitions';
import { loadEphemeralAgent } from '../load';

const internalServer = 'internal-search';
const internalTool = `search${Constants.mcp_delimiter}${internalServer}`;
const ordinaryTool = `search${Constants.mcp_delimiter}ordinary`;
const placeholder = `${Constants.mcp_all}${Constants.mcp_delimiter}${internalServer}`;
const catalog = (name: string): MCPServerTools => ({
  [name]: {
    function: {
      name,
      description: 'Search the selected server',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
});

const providers = [
  { endpoint: 'openAI', provider: Providers.OPENAI },
  { endpoint: 'anthropic', provider: Providers.ANTHROPIC },
  { endpoint: 'bedrock', provider: Providers.BEDROCK },
  { endpoint: 'custom-chat', provider: Providers.OPENAI },
];
const scenarios = [
  { name: 'enabled', enabled: true, tools: true, code: true, expectedPTC: true },
  { name: 'disabled by endpoint', enabled: false, tools: true, code: true, expectedPTC: false },
  { name: 'tools disabled', enabled: true, tools: false, code: true, expectedPTC: false },
  { name: 'code disabled', enabled: true, tools: true, code: false, expectedPTC: false },
];

describe.each(providers)(
  'ordinary $endpoint programmatic tool integration',
  ({ endpoint, provider }) => {
    it.each(scenarios)(
      'expands request-scoped tools and respects $name',
      async ({ enabled, tools, code, expectedPTC }) => {
        const policy = { enabled, mcpServers: [internalServer] };
        const config: AppConfig = {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          endpoints:
            endpoint === 'custom-chat'
              ? { custom: [{ name: endpoint, programmaticTools: policy }] }
              : { [endpoint]: { programmaticTools: policy } },
          mcpConfig: {
            [internalServer]: {
              type: 'streamable-http',
              url: 'https://mcp.example/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
            },
          },
        };
        const getMCPServerTools = jest.fn(async (_userId: string, serverName: string) =>
          serverName === 'ordinary' ? catalog(ordinaryTool) : null,
        );
        const getAgent = jest.fn(async () => null);
        const agent = await loadEphemeralAgent(
          {
            req: {
              user: { id: 'user-123' },
              config,
              body: { ephemeralAgent: { mcp: ['ordinary'] } },
            },
            endpoint,
          },
          { getAgent, getMCPServerTools },
        );
        if (!agent?.tools) {
          throw new Error('Expected an ordinary endpoint agent');
        }
        expect(agent.provider).toBe(endpoint);
        expect(getAgent).not.toHaveBeenCalled();
        expect(getMCPServerTools.mock.calls).toEqual([['user-123', 'ordinary', undefined]]);
        expect(agent.tools).toEqual(
          enabled ? [Tools.execute_code, ordinaryTool, placeholder] : [ordinaryTool],
        );

        const capabilities = applyEndpointProgrammaticCapabilities(
          config,
          agent.id,
          new Set([
            ...(tools ? [AgentCapabilities.tools] : []),
            ...(code ? [AgentCapabilities.execute_code] : []),
          ]),
        );
        const getOrFetchMCPServerTools = jest.fn(async (_userId: string, serverName: string) => {
          if (serverName === internalServer) {
            return catalog(internalTool);
          }
          return serverName === 'ordinary' ? catalog(ordinaryTool) : null;
        });
        const result = await loadToolDefinitions(
          {
            userId: 'user-123',
            agentId: agent.id,
            tools: agent.tools,
            toolOptions: agent.tool_options,
            provider,
            programmaticToolsEnabled: capabilities.has(AgentCapabilities.programmatic_tools),
            programmaticToolServers: resolveAgentProgrammaticToolServers(config, agent.id),
            codeExecutionEnabled:
              capabilities.has(AgentCapabilities.execute_code) &&
              agent.tools.includes(Tools.execute_code),
          },
          { getOrFetchMCPServerTools, isBuiltInTool: (name) => name === Tools.execute_code },
        );
        expect(result.toolRegistry.get(ordinaryTool)?.allowed_callers).toEqual(['direct']);
        expect(result.toolRegistry.has(placeholder)).toBe(false);
        expect(result.toolRegistry.has(BashProgrammaticToolCallingDefinition.name)).toBe(
          expectedPTC,
        );
        expect(
          result.toolDefinitions.some(
            ({ name }) => name === BashProgrammaticToolCallingDefinition.name,
          ),
        ).toBe(expectedPTC);
        if (enabled) {
          expect(getOrFetchMCPServerTools).toHaveBeenCalledWith('user-123', internalServer);
          expect(result.toolRegistry.get(internalTool)).toMatchObject({
            serverName: internalServer,
            allowed_callers: ['direct', 'code_execution'],
          });
          expect(result.mcpResolution).toEqual({ expectedToolCount: 2, resolvedToolCount: 2 });
        } else {
          expect(result.toolRegistry.has(internalTool)).toBe(false);
        }
      },
    );
  },
);
