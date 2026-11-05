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
import type { AgentInputs } from '@librechat/agents';
import { createRun } from '~/agents/run';

function makeAgent(overrides?: Record<string, unknown>) {
  return {
    id: 'agent_1',
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-6-luna',
    tools: ['lookup'],
    model_parameters: { model: 'gpt-6-luna' },
    maxContextTokens: 100_000,
    toolContextMap: {},
    ...overrides,
  };
}

async function captureAgentInput(agent = makeAgent()): Promise<AgentInputs> {
  await createRun({
    agents: [agent] as never,
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
  });
  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  const config = createMock.mock.calls[0][0] as { graphConfig: { agents: AgentInputs[] } };
  return config.graphConfig.agents[0];
}

describe('createRun GPT-6 Responses API defaults', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'])(
    'defaults %s agents to Responses API when unset',
    async (model) => {
      const agentInput = await captureAgentInput(
        makeAgent({
          model,
          model_parameters: { model },
        }),
      );
      const clientOptions = agentInput.clientOptions as Record<string, unknown>;
      expect(clientOptions.useResponsesApi).toBe(true);
      expect(clientOptions.firstPartyEndpoint).toBe(true);
      expect(agentInput.reasoningKey).toBe('reasoning');
    },
  );

  it('respects explicit useResponsesApi: false on GPT-6 agents', async () => {
    const agentInput = await captureAgentInput(
      makeAgent({
        model: 'gpt-6-luna',
        model_parameters: { model: 'gpt-6-luna', useResponsesApi: false },
      }),
    );
    const clientOptions = agentInput.clientOptions as Record<string, unknown>;
    expect(clientOptions.useResponsesApi).toBe(false);
    expect(agentInput.reasoningKey).not.toBe('reasoning');
  });

  it('does not force Responses API on custom endpoints', async () => {
    const agentInput = await captureAgentInput(
      makeAgent({
        model: 'gpt-6-luna',
        endpoint: 'custom',
        provider: 'openAI',
        model_parameters: { model: 'gpt-6-luna' },
      }),
    );
    const clientOptions = agentInput.clientOptions as Record<string, unknown>;
    expect(clientOptions.useResponsesApi).toBeUndefined();
  });

  it('leaves standard models without Responses API preference unset', async () => {
    const agentInput = await captureAgentInput(
      makeAgent({
        model: 'gpt-4o',
        model_parameters: { model: 'gpt-4o' },
      }),
    );
    const clientOptions = agentInput.clientOptions as Record<string, unknown>;
    expect(clientOptions.useResponsesApi).toBeUndefined();
    expect(clientOptions.firstPartyEndpoint).toBeUndefined();
  });
});

