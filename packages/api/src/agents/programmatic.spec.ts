import { AgentCapabilities, encodeEphemeralAgentId } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  resolveEndpointProgrammaticTools,
  resolveAgentProgrammaticTools,
  resolveAgentProgrammaticToolServers,
  applyEndpointProgrammaticCapabilities,
  getInheritedEndpointTools,
} from './programmatic';

const policy = { enabled: true, mcpServers: ['internal-search'] };
const agentId = (endpoint: string) => encodeEphemeralAgentId({ endpoint, model: 'test-model' });

describe('endpoint programmatic tools policy', () => {
  it.each(['openAI', 'anthropic', 'bedrock'])('resolves %s independently of Agents', (endpoint) => {
    const appConfig: Pick<AppConfig, 'endpoints'> = {
      endpoints: { [endpoint]: { programmaticTools: policy } },
    };
    expect(resolveEndpointProgrammaticTools(appConfig, endpoint)).toEqual(policy);
    expect(resolveAgentProgrammaticTools(appConfig, agentId(endpoint))).toEqual(policy);
    const original = new Set([AgentCapabilities.tools]);
    expect(applyEndpointProgrammaticCapabilities(appConfig, agentId(endpoint), original)).toEqual(
      new Set([AgentCapabilities.tools, AgentCapabilities.programmatic_tools]),
    );
    expect(original).toEqual(new Set([AgentCapabilities.tools]));
  });

  it('inherits global policy and replaces it with an endpoint policy', () => {
    const appConfig: Pick<AppConfig, 'endpoints'> = {
      endpoints: {
        all: { programmaticTools: policy },
        bedrock: { programmaticTools: { enabled: false, mcpServers: [] } },
        anthropic: { programmaticTools: { enabled: true, mcpServers: ['github'] } },
      },
    };
    expect(resolveAgentProgrammaticToolServers(appConfig, agentId('openAI'))).toEqual([
      'internal-search',
    ]);
    expect(resolveAgentProgrammaticToolServers(appConfig, agentId('bedrock'))).toEqual([]);
    expect(resolveAgentProgrammaticToolServers(appConfig, agentId('anthropic'))).toEqual([
      'github',
    ]);
    expect(
      applyEndpointProgrammaticCapabilities(
        appConfig,
        agentId('bedrock'),
        new Set([AgentCapabilities.programmatic_tools, AgentCapabilities.execute_code]),
      ),
    ).toEqual(new Set([AgentCapabilities.execute_code]));
  });

  it('resolves configured custom endpoints using their normalized name', () => {
    const appConfig: Pick<AppConfig, 'endpoints'> = {
      endpoints: { custom: [{ name: 'Ollama', programmaticTools: policy }] },
    };
    expect(resolveEndpointProgrammaticTools(appConfig, 'ollama')).toEqual(policy);
  });

  it.each(['agents', 'assistants', 'azureAssistants', 'unknown'])(
    'does not apply global policy to %s',
    (endpoint) => {
      expect(
        resolveEndpointProgrammaticTools(
          { endpoints: { all: { programmaticTools: policy } } },
          endpoint,
        ),
      ).toBeUndefined();
    },
  );

  it('leaves saved agents and unconfigured chats unchanged', () => {
    const capabilities = new Set([AgentCapabilities.programmatic_tools]);
    const appConfig: Pick<AppConfig, 'endpoints'> = {
      endpoints: { all: { programmaticTools: policy } },
    };
    expect(resolveAgentProgrammaticTools(appConfig, 'agent_saved')).toBeUndefined();
    expect(resolveAgentProgrammaticToolServers(appConfig, 'ephemeral')).toBeUndefined();
    expect(resolveEndpointProgrammaticTools(undefined, 'openAI')).toBeUndefined();
    expect(applyEndpointProgrammaticCapabilities(appConfig, 'agent_saved', capabilities)).toEqual(
      capabilities,
    );
    expect(applyEndpointProgrammaticCapabilities({}, agentId('openAI'), capabilities)).toEqual(
      capabilities,
    );
  });

  it('keeps inheritance unchanged without an enabled primary endpoint policy', () => {
    const tools = ['execute_code', 'search_mcp_selected'];
    expect(getInheritedEndpointTools(undefined, { id: agentId('openAI'), tools })).toEqual(tools);
    expect(getInheritedEndpointTools(undefined, { id: agentId('openAI') })).toEqual([]);
    expect(
      getInheritedEndpointTools(
        { endpoints: { openAI: { programmaticTools: { enabled: true, mcpServers: [] } } } },
        { id: agentId('openAI'), tools },
      ),
    ).toEqual(tools);
  });

  it('does not inherit primary policy tools under normalized or raw server names', () => {
    const config = {
      endpoints: {
        openAI: { programmaticTools: { enabled: true, mcpServers: ['Internal Search'] } },
      },
    };
    expect(
      getInheritedEndpointTools(config, {
        id: agentId('openAI'),
        tools: [
          'lookup_mcp_Internal Search',
          'lookup_mcp_Internal_Search',
          'execute_code',
          'lookup_mcp_selected',
        ],
      }),
    ).toEqual(['lookup_mcp_selected']);
  });
});
