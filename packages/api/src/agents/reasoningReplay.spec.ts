import {
  replaysSignedReasoning,
  getReasoningReplayTarget,
  callsAnthropicMessagesApi,
} from './reasoningReplay';

const ON = { endpoints: { agents: { promptCache: { stableContext: true } } } };

describe('signed reasoning replay', () => {
  it('applies to Anthropic with stableContext only', () => {
    expect(replaysSignedReasoning(ON, 'anthropic')).toBe(true);
    expect(replaysSignedReasoning({}, 'anthropic')).toBe(false);
    expect(replaysSignedReasoning(undefined, 'anthropic')).toBe(false);
  });

  it.each(['bedrock', 'openAI', 'azureOpenAI', 'google', 'openrouter', undefined, null])(
    'does not apply to %s',
    (provider) => {
      expect(replaysSignedReasoning(ON, provider)).toBe(false);
    },
  );

  it('names the model the run serves, through the modelName alias too', () => {
    expect(
      getReasoningReplayTarget(ON, {
        provider: 'anthropic',
        model: 'agent-model',
        model_parameters: { model: 'claude-test' },
      }),
    ).toEqual({ provider: 'anthropic', model: 'claude-test' });
    expect(
      getReasoningReplayTarget(ON, {
        provider: 'anthropic',
        model: 'agent-model',
        model_parameters: { modelName: 'alias-model' },
      }),
    ).toEqual({ provider: 'anthropic', model: 'alias-model' });
    expect(
      getReasoningReplayTarget(ON, { provider: 'bedrock', model_parameters: { model: 'm' } }),
    ).toBeUndefined();
    expect(getReasoningReplayTarget(ON, { provider: 'anthropic' })).toBeUndefined();
  });

  it('counts any client of the Anthropic Messages API, also behind a proxy, but not Vertex AI', () => {
    expect(callsAnthropicMessagesApi({ model: 'claude-test', clientOptions: {} })).toBe(true);
    expect(callsAnthropicMessagesApi(undefined)).toBe(true);
    expect(callsAnthropicMessagesApi({ clientOptions: { baseURL: 'https://proxy.test' } })).toBe(
      true,
    );
    expect(callsAnthropicMessagesApi({ anthropicApiUrl: 'https://proxy.test' })).toBe(true);
    expect(callsAnthropicMessagesApi({ createClient: () => ({}) })).toBe(false);
  });
});
