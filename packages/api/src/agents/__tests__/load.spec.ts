import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Constants, FileSources } from 'librechat-data-provider';
import { agentSchema, createMethods } from '@librechat/data-schemas';
import type {
  Agent as LibreChatAgent,
  AgentModelParameters,
  TEphemeralAgent,
  TConversation,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { LoadAgentParams, LoadAgentDeps } from '../load';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '~/mcp/capabilities';
import { loadAddedAgent } from '../added';
import { loadAgent } from '../load';

let Agent: mongoose.Model<unknown>;
let createAgent: ReturnType<typeof createMethods>['createAgent'];
let getAgentWithVersionCount: ReturnType<typeof createMethods>['getAgentWithVersionCount'];

const mockGetMCPServerTools = jest.fn();
const mockGetAccessibleMCPServers = jest.fn();

const deps: LoadAgentDeps = {
  getAgent: (searchParameter) =>
    getAgentWithVersionCount(searchParameter) as Promise<LibreChatAgent | null>,
  getMCPServerTools: mockGetMCPServerTools,
  getAccessibleMCPServers: mockGetAccessibleMCPServers,
};

describe('loadAgent', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
    await mongoose.connect(mongoUri);
    const methods = createMethods(mongoose);
    createAgent = methods.createAgent;
    getAgentWithVersionCount = methods.getAgentWithVersionCount;
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    jest.clearAllMocks();
  });

  test('should return null when agent_id is not provided', async () => {
    const mockReq = { user: { id: 'user123' } };
    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: null as unknown as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result).toBeNull();
  });

  test('should return null when agent_id is empty string', async () => {
    const mockReq = { user: { id: 'user123' } };
    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: '',
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result).toBeNull();
  });

  test('should test ephemeral agent loading logic', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    // Mock getMCPServerTools to return tools for each server
    mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => {
      if (server === 'server1') {
        return { tool1_mcp_server1: {} };
      } else if (server === 'server2') {
        return { tool2_mcp_server2: {} };
      }
      return null;
    });

    const mockReq = {
      user: { id: 'user123' },
      body: {
        promptPrefix: 'Test instructions',
        ephemeralAgent: {
          execute_code: true,
          web_search: true,
          mcp: ['server1', 'server2'],
        },
      },
    };

    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4', temperature: 0.7 } as unknown as AgentModelParameters,
      },
      deps,
    );

    if (result) {
      // Ephemeral agent ID is encoded with endpoint and model
      expect(result.id).toBe('openai__gpt-4');
      expect(result.instructions).toBe('Test instructions');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4');
      expect(result.model_parameters.temperature).toBe(0.7);
      expect(result.tools).toContain('execute_code');
      expect(result.tools).toContain('web_search');
      expect(result.tools).toContain('tool1_mcp_server1');
      expect(result.tools).toContain('tool2_mcp_server2');
    } else {
      expect(result).toBeNull();
    }
  });

  test('should skip cached tools for servers made request-scoped by a config overlay', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    mockGetMCPServerTools.mockResolvedValue({ tool1_mcp_server1: {} });

    const mockReq = {
      user: { id: 'user123' },
      config: {
        mcpConfig: {
          'body-scoped': {
            type: 'streamable-http' as const,
            url: 'https://mcp.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
          },
        },
      } as unknown as AppConfig,
      body: {
        ephemeralAgent: {
          mcp: ['body-scoped', 'server1'],
        },
      },
    };

    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(mockGetMCPServerTools).toHaveBeenCalledTimes(1);
    expect(mockGetMCPServerTools).toHaveBeenCalledWith(
      'user123',
      'server1',
      undefined,
      STANDARD_MCP_CAPABILITY_PROFILE,
    );
    expect(result?.tools).toContain(`${Constants.mcp_all}${Constants.mcp_delimiter}body-scoped`);
    expect(result?.tools).toContain('tool1_mcp_server1');
  });

  describe('chat-selectable MCP narrowing', () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const loadEphemeral = (
      config: Record<string, unknown>,
      body: { ephemeralAgent: { mcp: string[] } },
      spec?: string,
    ) =>
      loadAgent(
        {
          req: {
            user: { id: 'user123', role: 'USER' },
            config: config as unknown as AppConfig,
            body,
          },
          spec,
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

    const selectedServerNames = () => mockGetMCPServerTools.mock.calls.map((call) => call[1]);

    beforeEach(() => {
      mockGetAccessibleMCPServers.mockResolvedValue({
        visible: { chatMenu: true },
        hidden: { chatMenu: false },
        'agent-only': { consumeOnly: true },
      });
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`tool_mcp_${server}`]: {},
      }));
    });

    test('drops a server the chat menu hides', async () => {
      const result = await loadEphemeral(
        { mcpConfig: {} },
        {
          ephemeralAgent: { mcp: ['visible', 'hidden'] },
        },
      );

      expect(selectedServerNames()).toEqual(['visible']);
      expect(result?.tools).toContain('tool_mcp_visible');
      expect(result?.tools).not.toContain('tool_mcp_hidden');
    });

    test('drops a server the user only reaches through an agent', async () => {
      const result = await loadEphemeral(
        { mcpConfig: {} },
        {
          ephemeralAgent: { mcp: ['visible', 'agent-only'] },
        },
      );

      expect(selectedServerNames()).toEqual(['visible']);
      expect(result?.tools).not.toContain('tool_mcp_agent-only');
    });

    test('resolves the accessible catalog with the requesting user role', async () => {
      await loadEphemeral({ mcpConfig: {} }, { ephemeralAgent: { mcp: ['visible'] } });
      expect(mockGetAccessibleMCPServers).toHaveBeenCalledWith('user123', 'USER');
    });

    test('keeps a spec-pinned server even when the chat menu hides it', async () => {
      const result = await loadEphemeral(
        {
          mcpConfig: {},
          modelSpecs: {
            list: [
              {
                name: 'pins-hidden',
                label: 'Pins Hidden',
                preset: { endpoint: 'openai', model: 'gpt-4' },
                mcpServers: ['hidden'],
              },
            ],
          },
        },
        { ephemeralAgent: { mcp: [] } },
        'pins-hidden',
      );

      expect(selectedServerNames()).toEqual(['hidden']);
      expect(result?.tools).toContain('tool_mcp_hidden');
    });

    test('keeps a request-tier server the registry cannot resolve', async () => {
      const result = await loadEphemeral(
        { mcpConfig: {} },
        {
          ephemeralAgent: { mcp: ['body-scoped'] },
        },
      );

      expect(selectedServerNames()).toEqual(['body-scoped']);
      expect(result?.tools).toContain('tool_mcp_body-scoped');
    });

    test('keeps the selection when the catalog lookup fails', async () => {
      mockGetAccessibleMCPServers.mockRejectedValue(new Error('registry unavailable'));

      const result = await loadEphemeral(
        { mcpConfig: {} },
        {
          ephemeralAgent: { mcp: ['flaky'] },
        },
      );

      expect(selectedServerNames()).toEqual(['flaky']);
      expect(result?.tools).toContain('tool_mcp_flaky');
    });

    test('publishes the servers actually in play back onto the request body', async () => {
      const body = { ephemeralAgent: { mcp: ['visible', 'hidden'] } };

      await loadEphemeral(
        {
          mcpConfig: {},
          modelSpecs: {
            list: [
              {
                name: 'pins-hidden',
                label: 'Pins Hidden',
                preset: { endpoint: 'openai', model: 'gpt-4' },
                mcpServers: ['hidden'],
              },
            ],
          },
        },
        body,
        'pins-hidden',
      );

      /** `applyContextToAgent` reads this straight off the body and prefers it
       *  over the agent's tools when loading `serverInstructions`: the hidden
       *  pick is gone, the spec's pin stays. */
      expect(body.ephemeralAgent.mcp).toEqual(['visible', 'hidden']);
    });

    const pinsBoth = {
      mcpConfig: {},
      modelSpecs: {
        list: [
          {
            name: 'pins-both',
            label: 'Pins Both',
            preset: { endpoint: 'openai', model: 'gpt-4' },
            mcpServers: ['visible', 'hidden'],
          },
        ],
      },
    };

    test('a spec server the picker offers follows the user deselecting it', async () => {
      const body = { ephemeralAgent: { mcp: [] as string[] } };
      const result = await loadEphemeral(pinsBoth, body, 'pins-both');

      /** The picker showed `visible` preselected and the user cleared it; the
       *  picker never offered `hidden`, so it stays as the operator pinned it. */
      expect(selectedServerNames()).toEqual(['hidden']);
      expect(result?.tools).not.toContain('tool_mcp_visible');
      expect(body.ephemeralAgent.mcp).toEqual(['hidden']);
    });

    test('every spec server applies when the request sends no selection', async () => {
      const result = await loadEphemeral(
        pinsBoth,
        { ephemeralAgent: {} } as unknown as { ephemeralAgent: { mcp: string[] } },
        'pins-both',
      );

      expect(selectedServerNames()).toEqual(['visible', 'hidden']);
      expect(result?.tools).toEqual(
        expect.arrayContaining(['tool_mcp_visible', 'tool_mcp_hidden']),
      );
    });

    test('classifies the selection and the spec servers with one catalog lookup', async () => {
      await loadEphemeral(pinsBoth, { ephemeralAgent: { mcp: ['visible'] } }, 'pins-both');

      expect(mockGetAccessibleMCPServers).toHaveBeenCalledTimes(1);
      expect(selectedServerNames()).toEqual(['visible', 'hidden']);
    });
  });

  test('addresses cached tools with a non-ephemeral request overlay', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;
    const overlayConfig = {
      type: 'streamable-http' as const,
      url: 'https://overlay.example.com/mcp',
    };
    mockGetMCPServerTools.mockResolvedValue({ overlay_tool_mcp_overlay: {} });

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          config: { mcpConfig: { overlay: overlayConfig } } as unknown as AppConfig,
          body: { ephemeralAgent: { mcp: ['overlay'] } },
        },
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(mockGetMCPServerTools).toHaveBeenCalledWith(
      'user123',
      'overlay',
      overlayConfig,
      STANDARD_MCP_CAPABILITY_PROFILE,
    );
    expect(result?.tools).toContain('overlay_tool_mcp_overlay');
  });

  test('should return null for non-existent agent', async () => {
    const mockReq = { user: { id: 'user123' } };
    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: 'agent_non_existent',
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result).toBeNull();
  });

  test('should load agent when user is the author', async () => {
    const userId = new mongoose.Types.ObjectId();
    const agentId = `agent_${uuidv4()}`;

    await createAgent({
      id: agentId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: userId,
      description: 'Test description',
      tools: ['web_search'],
    });

    const mockReq = { user: { id: userId.toString() } };
    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: agentId,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result).toBeDefined();
    expect(result!.id).toBe(agentId);
    expect(result!.name).toBe('Test Agent');
    expect(String(result!.author)).toBe(userId.toString());
    expect(result!.version).toBe(1);
  });

  test('should return agent even when user is not author (permissions checked at route level)', async () => {
    const authorId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const agentId = `agent_${uuidv4()}`;

    await createAgent({
      id: agentId,
      name: 'Test Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });

    const mockReq = { user: { id: userId.toString() } };
    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: agentId,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    // With the new permission system, loadAgent returns the agent regardless of permissions
    // Permission checks are handled at the route level via middleware
    expect(result).toBeTruthy();
    expect(result!.id).toBe(agentId);
    expect(result!.name).toBe('Test Agent');
  });

  test('should handle ephemeral agent with no MCP servers', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const mockReq = {
      user: { id: 'user123' },
      body: {
        promptPrefix: 'Simple instructions',
        ephemeralAgent: {
          execute_code: false,
          web_search: false,
          mcp: [],
        },
      },
    };

    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-3.5-turbo' } as unknown as AgentModelParameters,
      },
      deps,
    );

    if (result) {
      expect(result.tools).toEqual([]);
      expect(result.instructions).toBe('Simple instructions');
    } else {
      expect(result).toBeFalsy();
    }
  });

  test('should use parsed promptPrefix for ephemeral agent instructions', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: { user: { id: 'user123' }, body: {} },
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: {
          model: 'gpt-4',
          promptPrefix: 'Server-side model spec instructions',
        } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.instructions).toBe('Server-side model spec instructions');
    expect(result?.model_parameters).not.toHaveProperty('promptPrefix');
  });

  test('should equip ask_user_question from the ephemeralAgent request flag', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {
            ephemeralAgent: { ask_user_question: true } as TEphemeralAgent,
          },
        },
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.tools).toContain('ask_user_question');
  });

  test('should equip ask_user_question from a model spec (askUserQuestion: true)', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {},
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'asks-questions',
                  label: 'Asks Questions',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  askUserQuestion: true,
                },
                {
                  name: 'no-questions',
                  label: 'No Questions',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                },
              ],
            },
          },
        },
        spec: 'asks-questions',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.tools).toContain('ask_user_question');

    const withoutFlag = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {},
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'no-questions',
                  label: 'No Questions',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                },
              ],
            },
          },
        },
        spec: 'no-questions',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(withoutFlag?.tools).not.toContain('ask_user_question');
  });

  test('synthesizes background tool_options for eligible MCP tools from the ephemeralAgent flag', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;
    mockGetMCPServerTools.mockResolvedValue({ crm_lookup: { name: 'crm_lookup' } });

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {
            ephemeralAgent: {
              mcp: ['crm'],
              web_search: true,
              execute_code: true,
              run_in_background: true,
            } as TEphemeralAgent,
          },
        },
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    // recorded as a wildcard policy; eligibility (e.g. excluding web_search)
    // is enforced against the final definitions in applyBackgroundToolCalls
    expect(result?.tool_options).toEqual({ '*': { run_in_background: true } });
  });

  test('synthesizes background tool_options from a model spec: true opts in, false is an explicit opt-out, absent is no policy', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;
    mockGetMCPServerTools.mockResolvedValue({ crm_lookup: { name: 'crm_lookup' } });

    const buildReq = (specName: string, runInBackground?: boolean): LoadAgentParams['req'] =>
      ({
        user: { id: 'user123' },
        body: {},
        config: {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          modelSpecs: {
            list: [
              {
                name: specName,
                label: specName,
                preset: { endpoint: 'openai', model: 'gpt-4' },
                webSearch: true,
                mcpServers: ['crm'],
                runInBackground,
              },
            ],
          },
        },
      }) as unknown as LoadAgentParams['req'];

    const withFlag = await loadAgent(
      {
        req: buildReq('bg-on', true),
        spec: 'bg-on',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );
    expect(withFlag?.tool_options).toEqual({ '*': { run_in_background: true } });

    const withoutFlag = await loadAgent(
      {
        req: buildReq('bg-absent', undefined),
        spec: 'bg-absent',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );
    expect(withoutFlag?.tool_options).toBeUndefined();

    /** `false` must synthesize an explicit wildcard opt-out (not stay a
     *  no-op): the background-native code pair would otherwise default on
     *  against an admin's written `runInBackground: false`. */
    const withFalse = await loadAgent(
      {
        req: buildReq('bg-off', false),
        spec: 'bg-off',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );
    expect(withFalse?.tool_options).toEqual({ '*': { run_in_background: false } });
  });

  test('should enable full skill scope for ephemeral model spec with skills true', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {
            ephemeralAgent: {
              subagents: { enabled: false, agent_ids: ['agent_tampered'] },
            } as unknown as TEphemeralAgent,
          },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'skills-on',
                  label: 'Skills On',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  skills: true,
                },
              ],
            },
          },
        },
        spec: 'skills-on',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.skills_enabled).toBe(true);
    expect(result?.skills).toBeUndefined();
    expect(result?.subagents).toBeUndefined();
  });

  test('should initialize an empty allowlist for ephemeral model spec skill names', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {},
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'scoped-skills',
                  label: 'Scoped Skills',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  skills: ['finance-analyst', 'brand-writer'],
                },
              ],
            },
          },
        },
        spec: 'scoped-skills',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.skills_enabled).toBe(true);
    expect(result?.skills).toEqual([]);
  });

  test('should apply subagent config for ephemeral model specs', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;
    const subagents = { enabled: true, allowSelf: true, agent_ids: [] };

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {},
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'self-spawn',
                  label: 'Self Spawn',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  subagents,
                },
              ],
            },
          },
        },
        spec: 'self-spawn',
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.subagents).toEqual(subagents);
  });

  test('should ignore request subagents for ephemeral agents', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAgent(
      {
        req: {
          user: { id: 'user123' },
          body: {
            ephemeralAgent: {
              subagents: { enabled: true, allowSelf: true, agent_ids: ['agent_other'] },
            } as unknown as TEphemeralAgent,
          },
        },
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    expect(result?.subagents).toBeUndefined();
  });

  test('should ignore request subagents when added agent mirrors ephemeral primary tools', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          ephemeralAgent: { subagents: { enabled: true, allowSelf: true, agent_ids: [] } },
        } as unknown as TConversation,
        primaryAgent: { id: EPHEMERAL_AGENT_ID as string, tools: ['web_search'] } as LibreChatAgent,
      },
      deps,
    );

    expect(result?.tools).toEqual(['web_search']);
    expect(result?.subagents).toBeUndefined();
  });

  test('should ignore request subagents for added ephemeral agents', async () => {
    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          ephemeralAgent: { subagents: { enabled: true, allowSelf: true, agent_ids: [] } },
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.subagents).toBeUndefined();
  });

  test('addresses added-agent cached tools with the effective config overlay', async () => {
    const overlayConfig = {
      type: 'streamable-http' as const,
      url: 'https://overlay.example.com/mcp',
    };
    mockGetMCPServerTools.mockResolvedValue({ overlay_tool_mcp_overlay: {} });

    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            mcpConfig: { overlay: overlayConfig },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          ephemeralAgent: { mcp: ['overlay'] },
        } as unknown as TConversation,
      },
      deps,
    );

    expect(mockGetMCPServerTools).toHaveBeenCalledWith(
      'user123',
      'overlay',
      overlayConfig,
      STANDARD_MCP_CAPABILITY_PROFILE,
    );
    expect(result?.tools).toContain('overlay_tool_mcp_overlay');
  });

  test('should enable full skill scope for added ephemeral model spec with skills true', async () => {
    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'added-skills-on',
                  label: 'Added Skills On',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  skills: true,
                },
              ],
            },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          spec: 'added-skills-on',
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.skills_enabled).toBe(true);
    expect(result?.skills).toBeUndefined();
  });

  test('should initialize an empty allowlist for added ephemeral model spec skill names', async () => {
    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'added-scoped-skills',
                  label: 'Added Scoped Skills',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  skills: ['finance-analyst', 'brand-writer'],
                },
              ],
            },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          spec: 'added-scoped-skills',
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.skills_enabled).toBe(true);
    expect(result?.skills).toEqual([]);
  });

  test('should apply subagent config for added ephemeral model specs', async () => {
    const subagents = { enabled: true, allowSelf: true, agent_ids: [] };

    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'added-self-spawn',
                  label: 'Added Self Spawn',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  subagents,
                },
              ],
            },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          spec: 'added-self-spawn',
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.subagents).toEqual(subagents);
  });

  test('should apply model spec skills when added agent mirrors ephemeral primary tools', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;
    const subagents = { enabled: true, allowSelf: true, agent_ids: [] };

    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'mirrored-scoped-skills',
                  label: 'Mirrored Scoped Skills',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  skills: ['brand-writer'],
                  subagents,
                },
              ],
            },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          spec: 'mirrored-scoped-skills',
        } as unknown as TConversation,
        primaryAgent: { id: EPHEMERAL_AGENT_ID as string, tools: ['web_search'] } as LibreChatAgent,
      },
      deps,
    );

    expect(result?.tools).toEqual(['web_search']);
    expect(result?.skills_enabled).toBe(true);
    expect(result?.skills).toEqual([]);
    expect(result?.subagents).toEqual(subagents);
  });

  test('should equip ask_user_question for added agents from a model spec', async () => {
    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            modelSpecs: {
              list: [
                {
                  name: 'added-asks',
                  label: 'Added Asks',
                  preset: { endpoint: 'openai', model: 'gpt-4' },
                  askUserQuestion: true,
                },
              ],
            },
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          spec: 'added-asks',
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.tools).toContain('ask_user_question');
  });

  test('should equip ask_user_question for added agents from the ephemeralAgent flag', async () => {
    const result = await loadAddedAgent(
      {
        req: {
          user: { id: 'user123' },
          config: {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
          },
        },
        conversation: {
          endpoint: 'openai',
          model: 'gpt-4',
          ephemeralAgent: { ask_user_question: true },
        } as unknown as TConversation,
      },
      deps,
    );

    expect(result?.tools).toContain('ask_user_question');
  });

  test('should handle ephemeral agent with undefined ephemeralAgent in body', async () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const mockReq = {
      user: { id: 'user123' },
      body: {
        promptPrefix: 'Basic instructions',
      },
    };

    const result = await loadAgent(
      {
        req: mockReq,
        agent_id: EPHEMERAL_AGENT_ID as string,
        endpoint: 'openai',
        model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
      },
      deps,
    );

    if (result) {
      expect(result.tools).toEqual([]);
    } else {
      expect(result).toBeFalsy();
    }
  });

  describe('model spec tool flags are defaults, not mandates (#15277)', () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const buildReq = (
      ephemeralAgent: TEphemeralAgent | undefined,
      spec: Record<string, unknown>,
    ): LoadAgentParams['req'] =>
      ({
        user: { id: 'user123' },
        body: ephemeralAgent ? { ephemeralAgent } : {},
        config: {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          modelSpecs: {
            list: [
              {
                name: 'spec-under-test',
                label: 'spec-under-test',
                preset: { endpoint: 'openai', model: 'gpt-4' },
                ...spec,
              },
            ],
          },
        },
      }) as unknown as LoadAgentParams['req'];

    const load = (ephemeralAgent: TEphemeralAgent | undefined, spec: Record<string, unknown>) =>
      loadAgent(
        {
          req: buildReq(ephemeralAgent, spec),
          spec: 'spec-under-test',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

    test('carries the spec deferLoading selection as tool options', async () => {
      const agent = await load(undefined, { deferLoading: ['execute_code'] });
      expect(agent?.tool_options).toEqual({
        '*': { defer_loading: false },
        execute_code: { defer_loading: true },
      });
    });

    test('an explicit user "off" disables every spec-enabled tool', async () => {
      const result = await load(
        {
          web_search: false,
          file_search: false,
          execute_code: false,
          memory: false,
          ask_user_question: false,
        },
        {
          webSearch: true,
          fileSearch: true,
          executeCode: true,
          memory: true,
          askUserQuestion: true,
        },
      );

      expect(result?.tools).toEqual([]);
    });

    test('a spec flag still applies when the request carries no toggle for it', async () => {
      const result = await load({ web_search: false }, { webSearch: true, fileSearch: true });

      expect(result?.tools).toEqual(['file_search']);
    });

    test('a spec flag applies when no ephemeral agent accompanies the request', async () => {
      const result = await load(undefined, { webSearch: true, executeCode: true });

      expect(result?.tools).toEqual(['execute_code', 'web_search']);
    });

    test('a user "on" still equips a tool the spec leaves off', async () => {
      const result = await load({ web_search: true }, { webSearch: false });

      expect(result?.tools).toEqual(['web_search']);
    });

    test('a deselected MCP server is not re-added by the spec', async () => {
      mockGetMCPServerTools.mockResolvedValue({ crm_lookup: { name: 'crm_lookup' } });

      const result = await load({ mcp: [] }, { mcpServers: ['crm'] });

      expect(result?.tools).toEqual([]);
      expect(mockGetMCPServerTools).not.toHaveBeenCalled();
    });

    test('an MCP selection replaces the spec list rather than unioning with it', async () => {
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`lookup_mcp_${server}`]: { name: `lookup_mcp_${server}` },
      }));

      const result = await load({ mcp: ['jira'] }, { mcpServers: ['crm'] });

      expect(result?.tools).toEqual(['lookup_mcp_jira']);
    });

    test('the spec MCP list applies when the request sends no selection', async () => {
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`lookup_mcp_${server}`]: { name: `lookup_mcp_${server}` },
      }));

      const result = await load({ web_search: false }, { mcpServers: ['crm'] });

      expect(result?.tools).toEqual(['lookup_mcp_crm']);
    });

    test('an explicit skills "off" overrides a spec that enables skills', async () => {
      const result = await load({ skills: false }, { skills: true });

      expect(result?.skills_enabled).toBe(false);
      expect(result?.skills).toEqual([]);
    });

    test('a spec skill allowlist still narrows the catalog when skills stay on', async () => {
      const result = await load({ skills: true }, { skills: ['research'] });

      expect(result?.skills_enabled).toBe(true);
      expect(result?.skills).toEqual([]);
    });

    test('a spec `skills: false` remains a hard opt-out the badge cannot lift', async () => {
      const result = await load({ skills: true }, { skills: false });

      expect(result?.skills_enabled).toBe(false);
      expect(result?.skills).toEqual([]);
    });
  });

  describe('a hidden badge row makes the spec unconditional (#15277)', () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const hiddenReq = (ephemeralAgent: TEphemeralAgent) =>
      ({
        user: { id: 'user123' },
        body: { ephemeralAgent },
        config: {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          modelSpecs: {
            list: [
              {
                name: 'hidden-spec',
                label: 'Hidden Spec',
                preset: { endpoint: 'openai', model: 'gpt-4' },
                hideBadgeRow: true,
                webSearch: true,
                executeCode: true,
                skills: true,
                mcpServers: ['crm'],
              },
            ],
          },
        },
      }) as unknown as LoadAgentParams['req'];

    /** No badge exists to express an override with, so a toggle posted against
     *  such a spec — only an API caller can produce one — is dropped. */
    test('request toggles cannot strip a hidden spec of its tools', async () => {
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`lookup_mcp_${server}`]: { name: `lookup_mcp_${server}` },
      }));

      const result = await loadAgent(
        {
          req: hiddenReq({ web_search: false, execute_code: false, skills: false, mcp: [] }),
          spec: 'hidden-spec',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result?.tools).toEqual(['execute_code', 'web_search', 'lookup_mcp_crm']);
      expect(result?.skills_enabled).toBe(true);
    });

    /** A spec left out of the menu never reaches the client's config, so the
     *  badges sent beside it were seeded from the user's own defaults. */
    test('a spec left out of the menu holds the same authority', async () => {
      const req = hiddenReq({ web_search: false, file_search: true });
      const spec = (
        req.config as unknown as { modelSpecs: { list: Array<Record<string, unknown>> } }
      ).modelSpecs.list[0];
      delete spec.hideBadgeRow;
      spec.showInMenu = false;
      delete spec.mcpServers;

      const result = await loadAgent(
        {
          req,
          spec: 'hidden-spec',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result?.tools).toEqual(['execute_code', 'file_search', 'web_search']);
    });

    test('a hidden spec still applies the artifacts it configures', async () => {
      const req = hiddenReq({ web_search: false });
      const spec = (req.config as unknown as { modelSpecs: { list: Record<string, unknown>[] } })
        .modelSpecs.list[0];
      spec.artifacts = true;

      const result = await loadAgent(
        {
          req,
          spec: 'hidden-spec',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result?.artifacts).toBe('default');
    });

    test('a hidden spec leaves capabilities it does not configure to the request', async () => {
      const req = hiddenReq({ file_search: true });
      const spec = (req.config as unknown as { modelSpecs: { list: Record<string, unknown>[] } })
        .modelSpecs.list[0];
      /** Silent on file search, so it holds no authority over that toggle. */
      delete spec.fileSearch;
      delete spec.mcpServers;
      delete spec.skills;

      const result = await loadAgent(
        {
          req,
          spec: 'hidden-spec',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result?.tools).toEqual(['execute_code', 'file_search', 'web_search']);
    });

    test('an ordinary spec still honors the same toggles', async () => {
      const req = hiddenReq({ web_search: false, execute_code: false, skills: false, mcp: [] });
      const spec = (req.config as unknown as { modelSpecs: { list: Record<string, unknown>[] } })
        .modelSpecs.list[0];
      delete spec.hideBadgeRow;

      const result = await loadAgent(
        {
          req,
          spec: 'hidden-spec',
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result?.tools).toEqual([]);
      expect(result?.skills_enabled).toBe(false);
    });
  });

  describe('added conversations inherit the composer toggles (#15277)', () => {
    const { EPHEMERAL_AGENT_ID } = Constants;

    const addedReq = (ephemeralAgent?: TEphemeralAgent, spec?: Record<string, unknown>) =>
      ({
        user: { id: 'user123' },
        body: ephemeralAgent ? { ephemeralAgent } : {},
        config: {
          config: {},
          fileStrategy: FileSources.local,
          imageOutputType: 'png',
          modelSpecs: {
            list: [
              {
                name: 'added-spec',
                label: 'Added Spec',
                preset: { endpoint: 'openai', model: 'gpt-4' },
                ...spec,
              },
            ],
          },
        },
      }) as unknown as Parameters<typeof loadAddedAgent>[0]['req'];

    const addedConversation = {
      endpoint: 'openai',
      model: 'gpt-4',
      spec: 'added-spec',
    } as unknown as TConversation;

    /** The added pane never carries an `ephemeralAgent` of its own — one badge
     *  row submits one toggle set — so the request's state must reach it. */
    test('a composer opt-out disables a spec tool on the added pane', async () => {
      const result = await loadAddedAgent(
        {
          req: addedReq({ web_search: false }, { webSearch: true }),
          conversation: addedConversation,
        },
        deps,
      );

      expect(result?.tools).toEqual([]);
    });

    test('a composer skills opt-out reaches the added pane', async () => {
      const result = await loadAddedAgent(
        {
          req: addedReq({ skills: false }, { skills: true }),
          conversation: addedConversation,
        },
        deps,
      );

      expect(result?.skills_enabled).toBe(false);
      expect(result?.skills).toEqual([]);
    });

    test('the mirrored-tools branch applies the spec artifacts too', async () => {
      const { EPHEMERAL_AGENT_ID: EID } = Constants;
      const req = addedReq(undefined, { artifacts: true });

      /** This branch returns early, so every spec-configured capability has to
       *  be resolved before it, not after. */
      const result = await loadAddedAgent(
        {
          req,
          conversation: addedConversation,
          primaryAgent: { id: EID as string, tools: ['web_search'] } as LibreChatAgent,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search']);
      expect(result?.artifacts).toBe('default');
    });

    test('a composer skills opt-out reaches the mirrored-tools branch too', async () => {
      const result = await loadAddedAgent(
        {
          req: addedReq({ skills: false }, { skills: ['brand-writer'] }),
          conversation: addedConversation,
          primaryAgent: {
            id: EPHEMERAL_AGENT_ID as string,
            tools: ['web_search'],
          } as LibreChatAgent,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search']);
      expect(result?.skills_enabled).toBe(false);
    });

    test("records the pane's own skills choice when no spec configures skills", async () => {
      /** Otherwise the pane falls back to the run-level toggle, which belongs to
       *  the PRIMARY request — the other pane's badge scoping this one. */
      const offResult = await loadAddedAgent(
        { req: addedReq({ skills: false }, {}), conversation: addedConversation },
        deps,
      );
      expect(offResult?.skills_enabled).toBe(false);
      expect(offResult?.skills).toEqual([]);

      const onResult = await loadAddedAgent(
        { req: addedReq({ skills: true }, {}), conversation: addedConversation },
        deps,
      );
      expect(onResult?.skills_enabled).toBe(true);
      expect(onResult?.skills).toBeUndefined();
    });

    test('leaves skills unset when neither the spec nor the request decides', async () => {
      const result = await loadAddedAgent(
        { req: addedReq({ web_search: true }, {}), conversation: addedConversation },
        deps,
      );

      expect(result?.skills_enabled).toBeUndefined();
    });

    test('a spec still applies to the added pane when the composer is silent', async () => {
      const result = await loadAddedAgent(
        {
          req: addedReq(undefined, { webSearch: true, skills: true }),
          conversation: addedConversation,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search']);
      expect(result?.skills_enabled).toBe(true);
    });

    test('a partial pane object still inherits the toggles it omits', async () => {
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`lookup_mcp_${server}`]: { name: `lookup_mcp_${server}` },
      }));

      const result = await loadAddedAgent(
        {
          req: addedReq({ web_search: true, mcp: ['jira'] }, {}),
          conversation: {
            ...addedConversation,
            ephemeralAgent: { skills: false },
          } as unknown as TConversation,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search', 'lookup_mcp_jira']);
    });

    test('a pane whose spec hides the badge row keeps its spec capabilities', async () => {
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => ({
        [`lookup_mcp_${server}`]: { name: `lookup_mcp_${server}` },
      }));

      /** Those toggles were never offered for this pane, so the other pane's
       *  choices must not strip what its own spec configured. */
      const result = await loadAddedAgent(
        {
          req: addedReq(
            { web_search: false, skills: false, mcp: [] },
            { hideBadgeRow: true, webSearch: true, skills: true, mcpServers: ['crm'] },
          ),
          conversation: addedConversation,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search', 'lookup_mcp_crm']);
      expect(result?.skills_enabled).toBe(true);
    });

    test("the added pane's own toggles still outrank the request when present", async () => {
      const result = await loadAddedAgent(
        {
          req: addedReq({ web_search: false }, { webSearch: true }),
          conversation: {
            ...addedConversation,
            ephemeralAgent: { web_search: true },
          } as unknown as TConversation,
        },
        deps,
      );

      expect(result?.tools).toEqual(['web_search']);
    });
  });

  describe('Edge Cases', () => {
    test('should handle loadAgent with malformed req object', async () => {
      const result = await loadAgent(
        {
          req: null as unknown as LoadAgentParams['req'],
          agent_id: 'agent_test',
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      expect(result).toBeNull();
    });

    test('should handle ephemeral agent with extremely large tool list', async () => {
      const { EPHEMERAL_AGENT_ID } = Constants;

      const largeToolList = Array.from({ length: 100 }, (_, i) => `tool_${i}_mcp_server1`);
      const availableTools: Record<string, object> = {};
      for (const tool of largeToolList) {
        availableTools[tool] = {};
      }

      // Mock getMCPServerTools to return all tools for server1
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => {
        if (server === 'server1') {
          return availableTools; // All 100 tools belong to server1
        }
        return null;
      });

      const mockReq = {
        user: { id: 'user123' },
        body: {
          promptPrefix: 'Test',
          ephemeralAgent: {
            execute_code: true,
            web_search: true,
            mcp: ['server1'],
          },
        },
      };

      const result = await loadAgent(
        {
          req: mockReq,
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      if (result) {
        expect(result.tools!.length).toBeGreaterThan(100);
      }
    });

    test('should return agent from different project (permissions checked at route level)', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();
      const agentId = `agent_${uuidv4()}`;

      await createAgent({
        id: agentId,
        name: 'Project Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: authorId,
      });

      const mockReq = { user: { id: userId.toString() } };
      const result = await loadAgent(
        {
          req: mockReq,
          agent_id: agentId,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      // With the new permission system, loadAgent returns the agent regardless of permissions
      // Permission checks are handled at the route level via middleware
      expect(result).toBeTruthy();
      expect(result!.id).toBe(agentId);
      expect(result!.name).toBe('Project Agent');
    });

    test('should handle loadEphemeralAgent with malformed MCP tool names', async () => {
      const { EPHEMERAL_AGENT_ID } = Constants;

      // Mock getMCPServerTools to return only tools matching the server
      mockGetMCPServerTools.mockImplementation(async (_userId: string, server: string) => {
        if (server === 'server1') {
          // Only return tool that correctly matches server1 format
          return { tool_mcp_server1: {} };
        } else if (server === 'server2') {
          return { tool_mcp_server2: {} };
        }
        return null;
      });

      const mockReq = {
        user: { id: 'user123' },
        body: {
          promptPrefix: 'Test instructions',
          ephemeralAgent: {
            execute_code: false,
            web_search: false,
            mcp: ['server1'],
          },
        },
      };

      const result = await loadAgent(
        {
          req: mockReq,
          agent_id: EPHEMERAL_AGENT_ID as string,
          endpoint: 'openai',
          model_parameters: { model: 'gpt-4' } as unknown as AgentModelParameters,
        },
        deps,
      );

      if (result) {
        expect(result.tools).toEqual(['tool_mcp_server1']);
        expect(result.tools).not.toContain('malformed_tool_name');
        expect(result.tools).not.toContain('tool__server1');
        expect(result.tools).not.toContain('tool_mcp_server2');
      }
    });
  });
});
