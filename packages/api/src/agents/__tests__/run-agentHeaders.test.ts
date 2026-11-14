import { createRun } from '~/agents/run';

/**
 * Guards `{{LIBRECHAT_AGENT_ID}}` resolution in `createRun`. The id must be the
 * root agent's on every built input, subagents included, so a forwarded header
 * matches the id persisted on the response message by
 * `BaseClient.getResponseModel` — a gateway attributing spend per agent would
 * otherwise bill a delegated step to a different agent than the database records.
 * Ephemeral runs must resolve to nothing rather than leaking preset text.
 */

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
  transports: { Console: jest.fn(), DailyRotateFile: jest.fn(), File: jest.fn() },
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
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

const AGENT_ID_HEADER = 'X-Agent-Id';

/**
 * Each agent gets its OWN `configuration.defaultHeaders` object. Sharing one
 * reference would let the idempotency `WeakSet` in `resolveConfigHeaders` skip
 * the second resolution and return the first agent's already-resolved map,
 * which would pass the subagent assertion without ever resolving its headers.
 */
function makeAgent(overrides?: Record<string, unknown>) {
  return {
    id: 'agent_root',
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-4o',
    tools: [],
    model_parameters: {
      model: 'gpt-4o',
      configuration: {
        defaultHeaders: { [AGENT_ID_HEADER]: '{{LIBRECHAT_AGENT_ID}}' },
      },
    },
    maxContextTokens: 100_000,
    toolContextMap: {},
    ...overrides,
  };
}

type CapturedInput = Record<string, unknown> & {
  agentId?: string;
  clientOptions?: { configuration?: { defaultHeaders?: Record<string, string> } };
  subagentConfigs?: Array<{ type?: string; agentInputs?: CapturedInput }>;
};

async function captureAgentInputs(
  agents: Array<Record<string, unknown>>,
): Promise<CapturedInput[]> {
  await createRun({
    agents: agents as never,
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
  });
  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  const callArgs = createMock.mock.calls[0][0] as {
    graphConfig: { agents: CapturedInput[] };
  };
  return callArgs.graphConfig.agents;
}

function headerOf(input: CapturedInput | undefined): string | undefined {
  return input?.clientOptions?.configuration?.defaultHeaders?.[AGENT_ID_HEADER];
}

describe('createRun agent-id header resolution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves the placeholder to the running agent id', async () => {
    const [rootInput] = await captureAgentInputs([makeAgent()]);

    expect(headerOf(rootInput)).toBe('agent_root');
  });

  it('resolves a subagent step to the ROOT agent id, not the subagent own id', async () => {
    const child = makeAgent({ id: 'agent_child', name: 'Child' });
    const root = makeAgent({
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
      subagentAgentConfigs: [child],
    });

    const [rootInput] = await captureAgentInputs([root]);
    const childInput = rootInput.subagentConfigs?.find(
      (config) => config.type === 'agent_child',
    )?.agentInputs;

    /** The subagent really is a different agent... */
    expect(childInput?.agentId).toBe('agent_child');
    /** ...yet the forwarded header carries the id the turn is attributed to. */
    expect(headerOf(childInput)).toBe('agent_root');
    expect(headerOf(rootInput)).toBe('agent_root');
  });

  it('resolves to an empty value for an ephemeral (plain-chat) run', async () => {
    const [rootInput] = await captureAgentInputs([makeAgent({ id: 'openAI__gpt-4o___My Preset' })]);

    expect(headerOf(rootInput)).toBe('');
  });

  it('leaves headers without the placeholder untouched', async () => {
    const [rootInput] = await captureAgentInputs([
      makeAgent({
        model_parameters: {
          model: 'gpt-4o',
          configuration: { defaultHeaders: { 'X-Static': 'value' } },
        },
      }),
    ]);

    expect(rootInput.clientOptions?.configuration?.defaultHeaders).toEqual({ 'X-Static': 'value' });
  });
});
