import type { TModelSpec } from 'librechat-data-provider';
import type { LiteLLMModelSink } from '~/agents/litellm';
import type * as t from '~/types';
import {
  captureLiteLLMModel,
  getLiteLLMBranchMetadata,
  LITELLM_MODEL_NAME_HEADER,
  createLiteLLMModelCapture,
} from '~/agents/litellm';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function getFetch(configuration: t.OpenAIConfiguration): Fetch {
  return (configuration as { fetch: Fetch }).fetch;
}

describe('captureLiteLLMModel', () => {
  it('records the header and delegates to the existing fetch with the same arguments', async () => {
    const response = new Response('{}', {
      headers: { [LITELLM_MODEL_NAME_HEADER]: ' bedrock/us.anthropic.claude-sonnet-5-5 ' },
    });
    const baseFetch = jest.fn<Promise<Response>, Parameters<Fetch>>().mockResolvedValue(response);
    const configuration = { baseURL: 'http://litellm:4000', fetch: baseFetch };
    const sink: LiteLLMModelSink = {};

    const wrapped = captureLiteLLMModel(configuration as t.OpenAIConfiguration, sink);
    const init = { method: 'POST' };
    const result = await getFetch(wrapped)('http://litellm:4000/chat/completions', init);

    expect(result).toBe(response);
    expect(baseFetch).toHaveBeenCalledWith('http://litellm:4000/chat/completions', init);
    expect(sink.modelName).toBe('bedrock/us.anthropic.claude-sonnet-5-5');
  });

  it('returns a copy and leaves the source configuration untouched', () => {
    const baseFetch = jest.fn();
    const configuration = { baseURL: 'http://litellm:4000', fetch: baseFetch };

    const wrapped = captureLiteLLMModel(configuration as unknown as t.OpenAIConfiguration, {});

    expect(wrapped).not.toBe(configuration);
    expect(configuration.fetch).toBe(baseFetch);
    expect((wrapped as { baseURL: string }).baseURL).toBe('http://litellm:4000');
  });

  it('clears the model when a later response has no header (served model unknown)', async () => {
    const baseFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValueOnce(new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'a' } }))
      .mockResolvedValueOnce(new Response('{}'));
    const sink: LiteLLMModelSink = {};
    const wrapped = captureLiteLLMModel(
      { fetch: baseFetch } as unknown as t.OpenAIConfiguration,
      sink,
    );

    await getFetch(wrapped)('http://litellm:4000/a');
    expect(sink.modelName).toBe('a');
    await getFetch(wrapped)('http://litellm:4000/b');

    expect(sink.modelName).toBeUndefined();
  });

  it('reports the latest call when each response names a different model', async () => {
    const baseFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValueOnce(new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'a' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'b' } }));
    const sink: LiteLLMModelSink = {};
    const wrapped = captureLiteLLMModel(
      { fetch: baseFetch } as unknown as t.OpenAIConfiguration,
      sink,
    );

    await getFetch(wrapped)('http://litellm:4000/a');
    await getFetch(wrapped)('http://litellm:4000/b');

    expect(sink.modelName).toBe('b');
  });

  it('falls back to the global fetch when the configuration has none', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'b' } }));
    const sink: LiteLLMModelSink = {};
    try {
      const wrapped = captureLiteLLMModel({} as t.OpenAIConfiguration, sink);
      await getFetch(wrapped)('http://litellm:4000/c');
      expect(globalFetch).toHaveBeenCalledWith('http://litellm:4000/c', undefined);
      expect(sink.modelName).toBe('b');
    } finally {
      globalFetch.mockRestore();
    }
  });

  it('bounds an oversized header value', async () => {
    const baseFetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockResolvedValue(
        new Response('{}', { headers: { [LITELLM_MODEL_NAME_HEADER]: 'm'.repeat(1000) } }),
      );
    const sink: LiteLLMModelSink = {};
    const wrapped = captureLiteLLMModel(
      { fetch: baseFetch } as unknown as t.OpenAIConfiguration,
      sink,
    );

    await getFetch(wrapped)('http://litellm:4000/d');

    expect(sink.modelName).toHaveLength(256);
  });
});

describe('createLiteLLMModelCapture', () => {
  const ROUTER = 'litellm-model-router';
  const modelSpecs = {
    list: [
      {
        name: ROUTER,
        label: 'Claude Auto',
        litellmRoutedModel: { showOnResponses: true },
        preset: { endpoint: 'AnthropicClaude', model: ROUTER },
      },
      {
        name: 'claude-opus',
        label: 'Claude Opus',
        preset: { endpoint: 'AnthropicClaude', model: 'claude-opus' },
      },
    ] as TModelSpec[],
  };
  const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
  const ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';
  const agent = (id: string, model: string) => ({
    id,
    provider: 'AnthropicClaude',
    model_parameters: { model },
  });

  it('gives each opted-in agent its own sink and none to the others', () => {
    const capture = createLiteLLMModelCapture({ modelSpecs, primaryAgentId: PRIMARY });
    const primary = capture.getSink(agent(PRIMARY, ROUTER));
    const added = capture.getSink(agent(ADDED, ROUTER));

    expect(primary).toEqual({});
    expect(added).toEqual({});
    expect(added).not.toBe(primary);
    expect(capture.getSink(agent(PRIMARY, ROUTER))).toBe(primary);
    expect(capture.getSink(agent('opus____1', 'claude-opus'))).toBeUndefined();
  });

  it('reports the primary on the message fields and other agents as a list', () => {
    const capture = createLiteLLMModelCapture({ modelSpecs, primaryAgentId: PRIMARY });
    capture.getSink(agent(PRIMARY, ROUTER))!.modelName = 'bedrock/claude-haiku';
    capture.getSink(agent(ADDED, ROUTER))!.modelName = 'bedrock/claude-opus';

    expect(capture.getMetadata()).toEqual({
      litellmModelName: 'bedrock/claude-haiku',
      litellmRoutedModelSpec: ROUTER,
      litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/claude-opus', spec: ROUTER }],
    });
  });

  it('captures an added router agent when the primary is another model', () => {
    const capture = createLiteLLMModelCapture({ modelSpecs, primaryAgentId: 'opus' });
    expect(capture.getSink(agent('opus', 'claude-opus'))).toBeUndefined();
    capture.getSink(agent(ADDED, ROUTER))!.modelName = 'bedrock/claude-haiku';

    expect(capture.getMetadata()).toEqual({
      litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/claude-haiku', spec: ROUTER }],
    });
  });

  it("resolves added agents by the added conversation's spec, not the first preset match", () => {
    const sharedPreset = { endpoint: 'AnthropicClaude', model: ROUTER };
    const capture = createLiteLLMModelCapture({
      modelSpecs: {
        list: [
          {
            name: 'router-a',
            label: 'A',
            litellmRoutedModel: { showOnResponses: true },
            preset: sharedPreset,
          },
          {
            name: 'router-b',
            label: 'B',
            litellmRoutedModel: { showOnResponses: true },
            preset: sharedPreset,
          },
        ] as TModelSpec[],
      },
      primaryAgentId: PRIMARY,
      primarySpec: 'router-a',
      addedSpec: 'router-b',
    });
    capture.getSink(agent(PRIMARY, ROUTER))!.modelName = 'bedrock/claude-haiku';
    capture.getSink(agent(ADDED, ROUTER))!.modelName = 'bedrock/claude-opus';

    expect(capture.getMetadata()).toEqual({
      litellmModelName: 'bedrock/claude-haiku',
      litellmRoutedModelSpec: 'router-a',
      litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/claude-opus', spec: 'router-b' }],
    });
  });

  it('does not capture an added agent whose own spec does not opt in', () => {
    const capture = createLiteLLMModelCapture({
      modelSpecs,
      primaryAgentId: PRIMARY,
      addedSpec: 'claude-opus',
    });

    expect(capture.getSink(agent(ADDED, ROUTER))).toBeUndefined();
  });

  it('keeps an agent id with dots as a value, never as a stored key', () => {
    const dotted = 'openAI__gpt-4.1___GPT-4.1____1';
    const capture = createLiteLLMModelCapture({
      modelSpecs: {
        list: [
          {
            name: 'gpt-router',
            label: 'GPT Auto',
            litellmRoutedModel: { showOnResponses: true },
            preset: { endpoint: 'openAI', model: 'gpt-4.1' },
          } as TModelSpec,
        ],
      },
      primaryAgentId: 'other',
    });
    capture.getSink({ id: dotted, provider: 'openAI', model: 'gpt-4.1' })!.modelName =
      'gpt-4.1-mini';

    const { litellmAgentModels } = capture.getMetadata();
    expect(litellmAgentModels).toEqual([
      { agentId: dotted, modelName: 'gpt-4.1-mini', spec: 'gpt-router' },
    ]);
    expect(JSON.stringify(litellmAgentModels)).not.toMatch(/"[^"]*\.[^"]*":/);
  });

  it('never captures a saved agent, even on an opted-in spec', () => {
    const capture = createLiteLLMModelCapture({
      modelSpecs,
      primaryAgentId: 'agent_abc',
      primarySpec: ROUTER,
    });

    expect(capture.getSink(agent('agent_abc', ROUTER))).toBeUndefined();
    expect(capture.getSink(agent('agent_abc____1', ROUTER))).toBeUndefined();
    expect(capture.getMetadata()).toEqual({});
  });

  it('resolves the primary by its spec name and omits agents with nothing captured', () => {
    const capture = createLiteLLMModelCapture({
      modelSpecs,
      primaryAgentId: 'ephemeral',
      primarySpec: ROUTER,
    });
    expect(capture.getSink(agent('ephemeral', 'some-alias'))).toEqual({});
    capture.getSink(agent(ADDED, ROUTER));

    expect(capture.getMetadata()).toEqual({});
  });
});

describe('LiteLLM capture across a HITL pause', () => {
  const ROUTER = 'litellm-model-router';
  const modelSpecs = {
    list: [
      {
        name: ROUTER,
        label: 'Claude Auto',
        litellmRoutedModel: { showOnResponses: true },
        preset: { endpoint: 'AnthropicClaude', model: ROUTER },
      },
    ] as TModelSpec[],
  };
  const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
  const ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';
  const agent = (id: string, model = ROUTER) => ({
    id,
    provider: 'AnthropicClaude',
    model_parameters: { model },
  });
  const create = () =>
    createLiteLLMModelCapture({ modelSpecs, primaryAgentId: PRIMARY, primarySpec: ROUTER });

  it('snapshots every captured agent, and nothing when none was captured', () => {
    const capture = create();
    expect(capture.getSnapshot()).toBeUndefined();
    capture.getSink(agent(PRIMARY))!.modelName = 'bedrock/claude-opus';
    capture.getSink(agent(ADDED))!.modelName = 'bedrock/claude-haiku';
    capture.getSink(agent('agent_saved'));

    expect(capture.getSnapshot()).toEqual([
      { agentId: PRIMARY, modelName: 'bedrock/claude-opus' },
      { agentId: ADDED, modelName: 'bedrock/claude-haiku' },
    ]);
  });

  it('keeps the model of an agent that finished before the pause and is not rerun', () => {
    const paused = create();
    paused.getSink(agent(PRIMARY))!.modelName = 'bedrock/claude-opus';
    paused.getSink(agent(ADDED))!.modelName = 'bedrock/claude-haiku';

    const resumed = create();
    resumed.restore(paused.getSnapshot());
    resumed.getSink(agent(PRIMARY));
    /** The added column paused for approval and runs again; its call reports a new model. */
    resumed.getSink(agent(ADDED))!.modelName = 'bedrock/claude-sonnet';

    expect(resumed.getMetadata()).toEqual({
      litellmModelName: 'bedrock/claude-opus',
      litellmRoutedModelSpec: ROUTER,
      litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/claude-sonnet', spec: ROUTER }],
    });
  });

  it('lets a rerun call clear a restored model', () => {
    const resumed = create();
    resumed.restore([{ agentId: PRIMARY, modelName: 'bedrock/claude-opus' }]);
    resumed.getSink(agent(PRIMARY))!.modelName = undefined;

    expect(resumed.getMetadata()).toEqual({});
  });

  it('seeds only agents that still opt in, and drops malformed entries', () => {
    const resumed = create();
    resumed.restore([
      null,
      { agentId: PRIMARY, modelName: 7 },
      { agentId: '', modelName: 'x' },
      { agentId: ADDED, modelName: 'm'.repeat(257) },
      { agentId: 'agent_saved', modelName: 'bedrock/claude-opus' },
    ]);
    expect(resumed.getSink(agent(PRIMARY))).toEqual({});
    expect(resumed.getSink(agent(ADDED))).toEqual({});
    expect(resumed.getSink(agent('agent_saved'))).toBeUndefined();

    resumed.restore('not a list');
    expect(resumed.getSnapshot()).toBeUndefined();
  });
});

describe('getLiteLLMBranchMetadata', () => {
  const PRIMARY = 'AnthropicClaude__litellm-model-router___Claude';
  const ADDED = 'AnthropicClaude__litellm-model-router___Claude____1';
  const metadata = {
    litellmModelName: 'bedrock/claude-haiku',
    litellmRoutedModelSpec: 'router-a',
    litellmAgentModels: [{ agentId: ADDED, modelName: 'bedrock/claude-opus', spec: 'router-b' }],
    usage: { total: 1 },
  };

  it("promotes the primary column's message-level fields", () => {
    expect(getLiteLLMBranchMetadata(metadata, PRIMARY)).toEqual({
      litellmModelName: 'bedrock/claude-haiku',
      litellmRoutedModelSpec: 'router-a',
    });
  });

  it("promotes an added column's own entry, never the primary's model", () => {
    expect(getLiteLLMBranchMetadata(metadata, ADDED)).toEqual({
      litellmModelName: 'bedrock/claude-opus',
      litellmRoutedModelSpec: 'router-b',
    });
  });

  it('returns undefined for an added column with no entry of its own', () => {
    const { litellmAgentModels: _omitted, ...primaryOnly } = metadata;
    expect(getLiteLLMBranchMetadata(primaryOnly, ADDED)).toBeUndefined();
    expect(getLiteLLMBranchMetadata(metadata, 'other____2')).toBeUndefined();
  });

  it('returns undefined when nothing was captured or the stored fields are malformed', () => {
    expect(getLiteLLMBranchMetadata(undefined, PRIMARY)).toBeUndefined();
    expect(getLiteLLMBranchMetadata({ usage: { total: 1 } }, PRIMARY)).toBeUndefined();
    expect(getLiteLLMBranchMetadata({ litellmModelName: 'x' }, PRIMARY)).toBeUndefined();
    expect(
      getLiteLLMBranchMetadata(
        { litellmAgentModels: [null, { agentId: ADDED, modelName: 7 }] },
        ADDED,
      ),
    ).toBeUndefined();
  });
});
