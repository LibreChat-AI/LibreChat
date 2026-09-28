import { Tools, Constants, FileSources, encodeEphemeralAgentId } from 'librechat-data-provider';
import type { Agent, TConversation } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { loadEphemeralAgent } from '../load';
import { loadAddedAgent } from '../added';

const defaults: AppConfig = { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' };
const policy = { enabled: true, mcpServers: ['internal-search'] };
const toolName = `search${Constants.mcp_delimiter}internal-search`;
const placeholder = `${Constants.mcp_all}${Constants.mcp_delimiter}internal-search`;
const deps = {
  getAgent: jest.fn(),
  getMCPServerTools: jest.fn(async () => ({ [toolName]: {} })),
};

describe('ordinary endpoint PTC configuration', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['openAI', 'anthropic', 'bedrock'])(
    'equips %s without a user toggle or saved Agent',
    async (endpoint) => {
      const config: AppConfig = {
        ...defaults,
        endpoints: { [endpoint]: { programmaticTools: policy } },
      };
      const result = await loadEphemeralAgent(
        { req: { user: { id: 'user' }, config }, endpoint },
        deps,
      );
      expect(result?.provider).toBe(endpoint);
      expect(result?.tools).toEqual([Tools.execute_code, toolName]);
      expect(deps.getAgent).not.toHaveBeenCalled();
    },
  );

  it('keeps request-scoped servers lazy and includes ordinary user-selected tools', async () => {
    const req = {
      user: { id: 'user' },
      config: {
        ...defaults,
        endpoints: { all: { programmaticTools: policy } },
        mcpConfig: {
          'internal-search': {
            type: 'streamable-http',
            url: 'https://example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
          },
        },
      } satisfies AppConfig,
      body: { ephemeralAgent: { mcp: ['ordinary'] } },
    };
    const result = await loadEphemeralAgent(
      { req, endpoint: 'bedrock' },
      {
        ...deps,
        getMCPServerTools: async (_user, server) => ({
          [`search${Constants.mcp_delimiter}${server}`]: {},
        }),
      },
    );
    expect(result?.tools).toEqual([
      Tools.execute_code,
      `search${Constants.mcp_delimiter}ordinary`,
      placeholder,
    ]);
    expect(req.body.ephemeralAgent.mcp).toEqual(['ordinary', 'internal-search']);
  });

  it.each([
    undefined,
    { enabled: false, mcpServers: ['internal-search'] },
    { enabled: true, mcpServers: [] },
  ])('does not auto-equip tools for inactive or empty policy %j', async (programmaticTools) => {
    const config: AppConfig = { ...defaults, endpoints: { bedrock: { programmaticTools } } };
    const result = await loadEphemeralAgent(
      { req: { config: { ...config } }, endpoint: 'bedrock' },
      deps,
    );
    expect(result?.tools).toEqual([]);
    expect(deps.getMCPServerTools).not.toHaveBeenCalled();
  });

  it('uses the added Bedrock endpoint policy when the primary is a saved agent', async () => {
    const config: AppConfig = {
      ...defaults,
      endpoints: { bedrock: { programmaticTools: policy } },
    };
    const result = await loadAddedAgent(
      {
        req: { config: { ...config } },
        conversation: { endpoint: 'bedrock', model: 'test' } as TConversation,
      },
      deps,
    );
    expect(result?.tools).toEqual([Tools.execute_code, toolName]);
  });

  it('equips the added endpoint policy even when the primary is an ordinary chat', async () => {
    const config: AppConfig = {
      ...defaults,
      endpoints: { bedrock: { programmaticTools: policy } },
    };
    const primary = {
      id: encodeEphemeralAgentId({ endpoint: 'openAI', model: 'test' }),
      tools: [Tools.web_search],
    } as Agent;
    const result = await loadAddedAgent(
      {
        req: { config: { ...config } },
        primaryAgent: primary,
        conversation: { endpoint: 'bedrock', model: 'test' } as TConversation,
      },
      deps,
    );
    expect(result?.tools).toEqual([Tools.web_search, Tools.execute_code, placeholder]);
    expect(primary.tools).toEqual([Tools.web_search]);
  });

  it.each([false, true])(
    'isolates primary endpoint defaults when added PTC is %s',
    async (enabled) => {
      const config: AppConfig = {
        ...defaults,
        endpoints: {
          openAI: { programmaticTools: policy },
          bedrock: { programmaticTools: { enabled, mcpServers: ['warehouse'] } },
        },
      };
      const primary = {
        id: encodeEphemeralAgentId({ endpoint: 'openAI', model: 'test' }),
        tools: [Tools.execute_code, toolName, placeholder, 'lookup_mcp_user-selected'],
      } as Agent;
      const result = await loadAddedAgent(
        {
          req: { config: { ...config } },
          primaryAgent: primary,
          conversation: { endpoint: 'bedrock', model: 'test' } as TConversation,
        },
        deps,
      );
      expect(result?.tools).not.toContain(toolName);
      expect(result?.tools).not.toContain(placeholder);
      expect(result?.tools?.includes(Tools.execute_code)).toBe(enabled);
      expect(result?.tools).toContain('lookup_mcp_user-selected');
      expect(
        result?.tools?.includes(`${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`),
      ).toBe(enabled);
      expect(primary.tools).toContain(toolName);
    },
  );

  it.each(['toggle', 'model spec'])(
    'retains an added endpoint code opt-in from %s',
    async (source) => {
      const config: AppConfig = {
        ...defaults,
        endpoints: { openAI: { programmaticTools: policy } },
        modelSpecs: {
          list: [
            { name: 'code', label: 'Code', preset: { endpoint: 'bedrock' }, executeCode: true },
          ],
        },
      };
      const primary = {
        id: encodeEphemeralAgentId({ endpoint: 'openAI', model: 'test' }),
        tools: [Tools.execute_code, toolName],
      } as Agent;
      const conversation = {
        endpoint: 'bedrock',
        model: 'test',
        ...(source === 'toggle' ? { ephemeralAgent: { execute_code: true } } : { spec: 'code' }),
      } as TConversation;
      const result = await loadAddedAgent(
        { req: { config: { ...config } }, primaryAgent: primary, conversation },
        deps,
      );
      expect(result?.tools).toContain(Tools.execute_code);
      expect(result?.tools).not.toContain(toolName);
    },
  );
});
