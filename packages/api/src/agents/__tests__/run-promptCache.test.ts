import { HumanMessage } from '@langchain/core/messages';
import { EModelEndpoint } from 'librechat-data-provider';
import type { AgentInputs } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { createRun } from '~/agents/run';

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    Run: {
      create: jest.fn().mockResolvedValue({
        processStream: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn().mockResolvedValue({}),
}));

import { Run } from '@librechat/agents';

const CANONICAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const CACHE_MARKERS = [
  'promptCacheKeyEnabled',
  'promptCacheScope',
  'promptCacheScopeId',
  'promptCacheStableInstructions',
] as const;

type TestAgent = {
  id: string;
  provider: string;
  endpoint: string;
  model: string;
  model_parameters: Record<string, unknown>;
  tools: unknown[];
  maxContextTokens: number;
  toolContextMap: Record<string, unknown>;
  [key: string]: unknown;
};

type CapturedAgent = AgentInputs & {
  clientOptions: Record<string, unknown>;
  subagentConfigs?: Array<Record<string, unknown>>;
};

function realOpenAIModelParameters(
  options: {
    wireUser?: string;
    addParams?: Record<string, unknown>;
    dropParams?: string[];
  } = {},
): Record<string, unknown> {
  const { llmConfig } = getOpenAIConfig(
    'sk-prompt-cache-test',
    {
      reverseProxyUrl: CANONICAL_OPENAI_BASE_URL,
      modelOptions: {
        model: 'gpt-5.6',
        user: options.wireUser ?? 'wire-user',
      },
      promptCacheKeyEnabled: true,
      ...(options.addParams != null ? { addParams: options.addParams } : {}),
      ...(options.dropParams != null ? { dropParams: options.dropParams } : {}),
    },
    EModelEndpoint.openAI,
  );
  return llmConfig as Record<string, unknown>;
}

function makeAgent(overrides: Partial<TestAgent> & Record<string, unknown> = {}): TestAgent {
  return {
    id: 'agent-root',
    provider: EModelEndpoint.openAI,
    endpoint: EModelEndpoint.openAI,
    model: 'gpt-5.6',
    model_parameters: realOpenAIModelParameters(),
    tools: [],
    maxContextTokens: 100_000,
    toolContextMap: {},
    ...overrides,
  };
}

async function captureRun(options: {
  agent: TestAgent;
  user: string;
  /** A caller whose user came from a lean query carries only the document id. */
  leanUser?: boolean;
  conversationId?: string;
  messages?: HumanMessage[];
}): Promise<CapturedAgent[]> {
  const createMock = Run.create as jest.Mock;
  createMock.mockClear();
  await createRun({
    agents: [options.agent] as never,
    signal: new AbortController().signal,
    conversationId: options.conversationId,
    messages: options.messages,
    requestBody: options.conversationId ? { conversationId: options.conversationId } : undefined,
    user: (options.leanUser === true
      ? { _id: options.user }
      : { id: options.user }) as unknown as IUser,
    streaming: true,
    streamUsage: true,
  });
  expect(createMock).toHaveBeenCalledTimes(1);
  return createMock.mock.calls[0][0].graphConfig.agents as CapturedAgent[];
}

function cacheKey(agent: CapturedAgent): string {
  return agent.clientOptions.promptCacheKey as string;
}

describe('run-level prompt cache identity', () => {
  it('keeps one agent’s cache partition separate for different authenticated users while reusing it across conversations', async () => {
    const agent = makeAgent();
    const [userA] = await captureRun({ agent, user: 'user-a', conversationId: 'conversation-a' });
    const [userB] = await captureRun({ agent, user: 'user-b', conversationId: 'conversation-b' });
    const [userAAgain] = await captureRun({
      agent,
      user: 'user-a',
      conversationId: 'conversation-a-different',
      messages: [new HumanMessage('a different conversation message')],
    });

    expect(cacheKey(userA)).toBeDefined();
    expect(cacheKey(userB)).toBeDefined();
    expect(cacheKey(userA)).not.toBe(cacheKey(userB));
    expect(cacheKey(userAAgain)).toBe(cacheKey(userA));
  });

  it('keeps authenticated users’ partitions separate even when the outgoing user field is fixed', async () => {
    const agent = makeAgent({
      model_parameters: realOpenAIModelParameters({ addParams: { user: 'tenant-fixed' } }),
    });
    const [userA] = await captureRun({ agent, user: 'user-a' });
    const [userB] = await captureRun({ agent, user: 'user-b' });

    expect(userA.clientOptions.user).toBe('tenant-fixed');
    expect(userB.clientOptions.user).toBe('tenant-fixed');
    expect(cacheKey(userA)).not.toBe(cacheKey(userB));
  });

  it('keeps authenticated users’ partitions separate even when the outgoing user field is omitted', async () => {
    const agent = makeAgent({
      model_parameters: realOpenAIModelParameters({ dropParams: ['user'] }),
    });
    const [userA] = await captureRun({ agent, user: 'user-a' });
    const [userB] = await captureRun({ agent, user: 'user-b' });

    expect(userA.clientOptions).not.toHaveProperty('user');
    expect(userB.clientOptions).not.toHaveProperty('user');
    expect(cacheKey(userA)).not.toBe(cacheKey(userB));
  });

  it('gives requests a deterministic cache key without exposing cache setup fields', async () => {
    const agents = await captureRun({ agent: makeAgent(), user: 'user-a' });

    expect(agents).not.toHaveLength(0);
    for (const agent of agents) {
      for (const marker of CACHE_MARKERS) {
        expect(agent.clientOptions).not.toHaveProperty(marker);
      }
      expect(cacheKey(agent)).toEqual(expect.stringMatching(/^librechat:/));
    }
  });

  it('sends no key at all when the run has no identity to partition by', async () => {
    const createMock = Run.create as jest.Mock;
    createMock.mockClear();
    await createRun({
      agents: [makeAgent()] as never,
      signal: new AbortController().signal,
      user: {} as IUser,
      streaming: true,
      streamUsage: true,
    });
    const [agent] = createMock.mock.calls[0][0].graphConfig.agents as CapturedAgent[];

    /** An unscoped key would file every such run under one entry. */
    expect(agent.clientOptions).not.toHaveProperty('promptCacheKey');
    for (const marker of CACHE_MARKERS) {
      expect(agent.clientOptions).not.toHaveProperty(marker);
    }
  });

  it('separates two users whose caller only carries the document id', async () => {
    const agent = makeAgent();
    const [forA] = await captureRun({ agent, user: 'user-a', leanUser: true });
    const [forB] = await captureRun({ agent, user: 'user-b', leanUser: true });

    expect(cacheKey(forA)).toEqual(expect.stringMatching(/^librechat:/));
    expect(cacheKey(forA)).not.toBe(cacheKey(forB));
    /** And it is the same partition the virtual `id` would have produced. */
    const [viaVirtual] = await captureRun({ agent, user: 'user-a' });
    expect(cacheKey(forA)).toBe(cacheKey(viaVirtual));
  });

  it('keeps a delegated child’s cache partition separate for different authenticated users', async () => {
    const child = makeAgent({ id: 'agent-child', instructions: 'Child prefix.' });
    const parent = makeAgent({
      subagents: { enabled: true, allowSelf: false },
      subagentAgentConfigs: [child],
    });

    const childOf = async (user: string): Promise<CapturedAgent> => {
      const [rootInput] = await captureRun({ agent: parent, user });
      const entry = (rootInput.subagentConfigs ?? []).find(
        (config) => config.type === 'agent-child',
      ) as { agentInputs?: CapturedAgent } | undefined;
      expect(entry?.agentInputs).toBeDefined();
      return entry!.agentInputs!;
    };

    const childForA = await childOf('user-a');
    const childForB = await childOf('user-b');

    expect(cacheKey(childForA)).toEqual(expect.stringMatching(/^librechat:/));
    expect(cacheKey(childForA)).not.toBe(cacheKey(childForB));
  });

  it('gives one saved-team member its own sealed cache key in each team occurrence', async () => {
    const member = makeAgent({ id: 'shared-member' });
    const writer = makeAgent({ id: 'writer' });
    const reviewer = makeAgent({ id: 'reviewer' });
    const teamOne = {
      type: 'team-one',
      name: 'Team One',
      description: 'Member writes',
      edges: [{ from: 'shared-member', to: 'writer', edgeType: 'direct' }],
      entry_agent_id: 'shared-member',
      result_agent_id: 'writer',
    };
    const teamTwo = {
      type: 'team-two',
      name: 'Team Two',
      description: 'Member reviews',
      edges: [{ from: 'shared-member', to: 'reviewer', edgeType: 'direct' }],
      entry_agent_id: 'shared-member',
      result_agent_id: 'reviewer',
    };
    const root = makeAgent({
      subagents: { enabled: true, allowSelf: false },
      subagentGraphConfigs: [
        { definition: teamOne, memberConfigs: [member, writer] },
        { definition: teamTwo, memberConfigs: [member, reviewer] },
      ],
    });

    const [rootInput] = await captureRun({ agent: root, user: 'user-a' });
    const graphConfigs = (rootInput.subagentConfigs ?? []).filter(
      (config) => 'kind' in config && config.kind === 'graph',
    ) as Array<{ agents: CapturedAgent[] }>;
    const memberInputs = graphConfigs.map((config) => {
      const graphAgents = config.agents;
      return graphAgents.find((agent) => agent.agentId === 'shared-member');
    });

    expect(graphConfigs).toHaveLength(2);
    expect(memberInputs).toHaveLength(2);
    expect(cacheKey(memberInputs[0]!)).toEqual(expect.stringMatching(/^librechat:/));
    expect(cacheKey(memberInputs[1]!)).toEqual(expect.stringMatching(/^librechat:/));
    /**
     * A saved team routes its members with direct edges, which the model never
     * sees, so both occurrences describe one prefix and must reuse one entry.
     */
    expect(cacheKey(memberInputs[0]!)).toBe(cacheKey(memberInputs[1]!));
  });

  it.each([
    ['a handoff edge the model can call', 'handoff', false],
    ['automatic routing the model never sees', 'direct', true],
  ])('treats %s accordingly', async (_label, edgeType, expectReuse) => {
    const target = makeAgent({ id: 'writer' });
    const plain = makeAgent({ id: 'supervisor' });
    const withEdge = makeAgent({
      id: 'supervisor',
      edges: [{ from: 'supervisor', to: 'writer', edgeType, description: 'Hand the draft over' }],
    });

    const [plainInput] = await captureRun({ agent: plain, user: 'user-a' });
    const [edgeInput] = await captureRun({ agent: withEdge, user: 'user-a' });
    void target;

    if (expectReuse) {
      expect(cacheKey(edgeInput)).toBe(cacheKey(plainInput));
    } else {
      expect(cacheKey(edgeInput)).not.toBe(cacheKey(plainInput));
    }
  });

  it('reads an omitted edge type as the handoff the SDK creates', async () => {
    const [implicit] = await captureRun({
      agent: makeAgent({
        id: 'supervisor',
        edges: [{ from: 'supervisor', to: 'writer', description: 'Hand the draft over' }],
      }),
      user: 'user-a',
    });
    const [explicit] = await captureRun({
      agent: makeAgent({
        id: 'supervisor',
        edges: [
          {
            from: 'supervisor',
            to: 'writer',
            edgeType: 'handoff',
            description: 'Hand the draft over',
          },
        ],
      }),
      user: 'user-a',
    });

    expect(cacheKey(implicit)).toBe(cacheKey(explicit));
  });

  it('treats a handoff prompt callback as the no-prompt tool the model receives', async () => {
    const base = { from: 'supervisor', to: 'writer', edgeType: 'handoff' as const };
    const [plain] = await captureRun({
      agent: makeAgent({ id: 'supervisor', edges: [base] }),
      user: 'user-a',
    });
    const [callback] = await captureRun({
      agent: makeAgent({
        id: 'supervisor',
        edges: [{ ...base, prompt: () => 'resolved per turn', promptKey: 'brief' }],
      }),
      user: 'user-a',
    });

    /**
     * The SDK builds the handoff input only from a string prompt, so a
     * callback reaches the model in no form and must not partition the cache.
     */
    expect(cacheKey(callback)).toBe(cacheKey(plain));
  });

  it('reads a spelled-out default handoff parameter name as the default', async () => {
    const edge = (promptKey?: string) => ({
      from: 'supervisor',
      to: 'writer',
      edgeType: 'handoff',
      prompt: 'Hand the draft over',
      ...(promptKey != null ? { promptKey } : {}),
    });

    const [implicit] = await captureRun({
      agent: makeAgent({ id: 'supervisor', edges: [edge()] }),
      user: 'user-a',
    });
    const [explicit] = await captureRun({
      agent: makeAgent({ id: 'supervisor', edges: [edge('instructions')] }),
      user: 'user-a',
    });

    /** Both advertise the same handoff parameter, so both must reuse one entry. */
    expect(cacheKey(implicit)).toBe(cacheKey(explicit));
  });
});
