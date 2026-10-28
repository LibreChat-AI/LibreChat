import type { LiteLLMModelSink } from '~/agents/litellm';
import { LITELLM_MODEL_NAME_HEADER } from '~/agents/litellm';
import { createRun } from '~/agents/run';

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

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeAgent(configuration: Record<string, unknown>, id = 'agent_1') {
  return {
    id,
    provider: 'AnthropicClaude',
    endpoint: 'AnthropicClaude',
    model: 'claude-sonnet-5-5',
    tools: [],
    model_parameters: { model: 'claude-sonnet-5-5', configuration },
    maxContextTokens: 100_000,
    toolContextMap: {},
  };
}

async function captureClientConfiguration(
  agent: ReturnType<typeof makeAgent>,
  litellmModelSink?: LiteLLMModelSink,
): Promise<{ baseURL?: string; fetch?: Fetch }> {
  await createRun({
    agents: [agent] as never,
    signal: new AbortController().signal,
    getLiteLLMModelSink: litellmModelSink != null ? () => litellmModelSink : undefined,
  });
  const runConfig = (Run.create as jest.Mock).mock.calls[0][0] as {
    graphConfig: { agents: Array<{ clientOptions: { configuration: Record<string, unknown> } }> };
  };
  return runConfig.graphConfig.agents[0].clientOptions.configuration;
}

describe('createRun LiteLLM model capture', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes the primary client through a fetch that fills the sink', async () => {
    const baseFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValue(
        new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'bedrock/claude' } }),
      );
    const configuration = { baseURL: 'http://litellm:4000', fetch: baseFetch };
    const agent = makeAgent(configuration);
    const sink: LiteLLMModelSink = {};

    const clientConfiguration = await captureClientConfiguration(agent, sink);
    await clientConfiguration.fetch?.('http://litellm:4000/chat/completions');

    expect(clientConfiguration.baseURL).toBe('http://litellm:4000');
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(sink.modelName).toBe('bedrock/claude');
    expect(agent.model_parameters.configuration).toBe(configuration);
    expect(configuration.fetch).toBe(baseFetch);
  });

  it('does not attribute a headerless final answer to an earlier tool call', async () => {
    const baseFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValueOnce(
        new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'bedrock/claude-haiku' } }),
      )
      .mockResolvedValueOnce(new Response('{}'));
    const sink: LiteLLMModelSink = {};
    const clientConfiguration = await captureClientConfiguration(
      makeAgent({ baseURL: 'http://litellm:4000', fetch: baseFetch }),
      sink,
    );

    /** Tool-loop step: the model asks for a tool, and LiteLLM names the model. */
    await clientConfiguration.fetch?.('http://litellm:4000/chat/completions');
    expect(sink.modelName).toBe('bedrock/claude-haiku');
    /** Final answer after the tool result: no header, so the model is unknown. */
    await clientConfiguration.fetch?.('http://litellm:4000/chat/completions');

    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(sink.modelName).toBeUndefined();
  });

  it('gives each top-level agent its own sink, so one cannot overwrite another', async () => {
    const primaryFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValue(
        new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'bedrock/claude-haiku' } }),
      );
    const addedFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValue(
        new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'bedrock/claude-opus' } }),
      );
    const sinks: Record<string, LiteLLMModelSink> = { agent_1: {}, agent_2: {} };
    await createRun({
      agents: [
        makeAgent({ baseURL: 'http://litellm:4000', fetch: primaryFetch }),
        makeAgent({ baseURL: 'http://litellm:4000', fetch: addedFetch }, 'agent_2'),
      ] as never,
      signal: new AbortController().signal,
      getLiteLLMModelSink: (agent) => sinks[agent.id],
    });
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0] as {
      graphConfig: { agents: Array<{ clientOptions: { configuration: { fetch?: Fetch } } }> };
    };
    const [primary, added] = runConfig.graphConfig.agents.map(
      (agent) => agent.clientOptions.configuration,
    );

    await primary.fetch?.('http://litellm:4000/chat/completions');
    await added.fetch?.('http://litellm:4000/chat/completions');

    expect(sinks.agent_1.modelName).toBe('bedrock/claude-haiku');
    expect(sinks.agent_2.modelName).toBe('bedrock/claude-opus');
  });

  it('leaves an agent unwrapped when the sink getter returns undefined', async () => {
    const primaryFetch = jest.fn();
    const addedFetch = jest.fn();
    await createRun({
      agents: [
        makeAgent({ baseURL: 'http://litellm:4000', fetch: primaryFetch }),
        makeAgent({ baseURL: 'http://litellm:4000', fetch: addedFetch }, 'agent_2'),
      ] as never,
      signal: new AbortController().signal,
      getLiteLLMModelSink: (agent) => (agent.id === 'agent_2' ? {} : undefined),
    });
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0] as {
      graphConfig: { agents: Array<{ clientOptions: { configuration: { fetch?: unknown } } }> };
    };
    const [primary, added] = runConfig.graphConfig.agents.map(
      (agent) => agent.clientOptions.configuration,
    );

    expect(primary.fetch).toBe(primaryFetch);
    expect(added.fetch).not.toBe(addedFetch);
  });

  it('leaves the client configuration as-is without a sink', async () => {
    const baseFetch = jest.fn();
    const clientConfiguration = await captureClientConfiguration(
      makeAgent({ baseURL: 'http://litellm:4000', fetch: baseFetch }),
    );

    expect(clientConfiguration.fetch).toBe(baseFetch);
  });
});
