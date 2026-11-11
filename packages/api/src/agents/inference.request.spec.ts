import { ChatOpenAI } from '@librechat/agents/llm/openai';
import { resolveAgentInferenceParameters } from './inference';
import { getOpenAILLMConfig } from '~/endpoints/openai/llm';

const buildRequest = (parameters: Record<string, unknown>) => {
  const { parameters: inference } = resolveAgentInferenceParameters({
    parameters,
    provider: 'openAI',
    model: 'gpt-4o-mini',
  });
  const { llmConfig } = getOpenAILLMConfig({
    apiKey: 'synthetic-server-key',
    streaming: true,
    endpoint: 'openAI',
    modelOptions: { ...inference, model: 'gpt-4o-mini' },
  });
  const client = new ChatOpenAI(llmConfig as ConstructorParameters<typeof ChatOpenAI>[0]);
  return { request: client.invocationParams({}), client };
};

describe('inference parameters at the SDK request boundary', () => {
  it('cannot replace the authorized model, transport, tools, or identity', () => {
    const { request, client } = buildRequest({
      temperature: 0.3,
      model: 'gpt-4o',
      modelName: 'gpt-4o',
      modelKwargs: { model: 'gpt-4o', messages: ['untrusted'], tools: ['untrusted'] },
      apiKey: 'untrusted-key',
      configuration: { apiKey: 'untrusted-key', baseURL: 'https://unchecked.invalid' },
      fallbacks: [{ provider: 'openAI', clientOptions: { model: 'gpt-4o' } }],
      tools: ['untrusted'],
      user: 'untrusted-user',
      futureConstructorControl: { arbitrary: true },
    });
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.temperature).toBe(0.3);
    expect(request.tools).toBeUndefined();
    expect(request).not.toHaveProperty('messages');
    expect(request.user).not.toBe('untrusted-user');
    expect(client.apiKey).toBe('synthetic-server-key');
    expect(JSON.stringify(request)).not.toContain('untrusted');
  });

  it.each(['gpt-4o-search-preview', 'gpt-4o-mini-search-preview'])(
    'does not reintroduce unsupported sampling after normalizing top_p for %s',
    (model) => {
      const { parameters } = resolveAgentInferenceParameters({
        parameters: { top_p: 0.8, temperature: 0.4, max_tokens: 256 },
        provider: 'openAI',
        model,
      });
      const { llmConfig } = getOpenAILLMConfig({
        apiKey: 'synthetic-server-key',
        streaming: false,
        endpoint: 'openAI',
        modelOptions: { ...parameters, model },
      });
      const client = new ChatOpenAI(llmConfig as ConstructorParameters<typeof ChatOpenAI>[0]);
      const request = client.invocationParams({});
      expect(request.top_p).toBeUndefined();
      expect(request.temperature).toBeUndefined();
      expect(request).toMatchObject({ max_tokens: 256 });
    },
  );

  it('honors an administrator top_p drop after alias normalization', () => {
    const { parameters } = resolveAgentInferenceParameters({
      parameters: { topP: 0.8 },
      provider: 'openAI',
      model: 'gpt-4o-mini',
    });
    const { llmConfig } = getOpenAILLMConfig({
      apiKey: 'synthetic-server-key',
      streaming: false,
      endpoint: 'openAI',
      modelOptions: { ...parameters, model: 'gpt-4o-mini' },
      dropParams: ['top_p'],
    });
    const client = new ChatOpenAI(llmConfig as ConstructorParameters<typeof ChatOpenAI>[0]);
    expect(client.invocationParams({}).top_p).toBeUndefined();
  });

  it('retains supported inference settings in the final wire payload', () => {
    const { request } = buildRequest({
      temperature: '0.4',
      top_p: 0.8,
      max_tokens: '256',
      stop: ['END'],
    });
    expect(request).toMatchObject({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 256,
      stop: ['END'],
    });
  });
});
