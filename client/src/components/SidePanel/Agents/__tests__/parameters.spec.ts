import { agentParamSettings, EModelEndpoint } from 'librechat-data-provider';
import type { AgentModelParameters } from 'librechat-data-provider';
import { pruneAgentModelParameters, resolveAgentParameterSettings } from '../parameters';

/**
 * `web_search` is a default model parameter for the OpenAI, Anthropic and Google
 * column sets, so the builder offers its switch to every agent editor unless the
 * role grant is consulted here — the model-parameters twin of the Web Search
 * capability toggle.
 */
describe('resolveAgentParameterSettings — web_search role gating', () => {
  const settings = (webSearchAllowed: boolean, provider = 'openAI', model = 'gpt-4o') =>
    resolveAgentParameterSettings({
      endpointsConfig: {},
      startupConfig: undefined,
      model,
      provider,
      webSearchAllowed,
    });

  const resolve = (webSearchAllowed: boolean, provider = 'openAI', model = 'gpt-4o') =>
    settings(webSearchAllowed, provider, model).visibleParameters.map((param) => param.key);

  it.each([
    ['openAI', 'gpt-4o'],
    ['anthropic', 'claude-3-5-sonnet'],
    ['google', 'gemini-1.5-pro'],
  ])('offers web_search on %s when the role grants it', (provider, model) => {
    expect(resolve(true, provider, model)).toContain('web_search');
  });

  it.each([
    ['openAI', 'gpt-4o'],
    ['anthropic', 'claude-3-5-sonnet'],
    ['google', 'gemini-1.5-pro'],
  ])('withholds web_search on %s when the role denies it', (provider, model) => {
    expect(resolve(false, provider, model)).not.toContain('web_search');
  });

  it('withholds only web_search, leaving the rest of the set intact', () => {
    const granted = resolve(true);
    const denied = resolve(false);
    expect(granted.length - denied.length).toBe(1);
    expect(denied).toEqual(granted.filter((key) => key !== 'web_search'));
  });
});

/**
 * A parameter the role may not see is still part of the endpoint schema. Pruning
 * has to keep recognising it, or a user without the permission opening someone
 * else's agent silently drops that agent's configuration on the next save.
 */
describe('resolveAgentParameterSettings — denied parameters survive pruning', () => {
  const resolved = (webSearchAllowed: boolean) =>
    resolveAgentParameterSettings({
      endpointsConfig: {},
      startupConfig: undefined,
      model: 'gpt-4o',
      provider: 'openAI',
      webSearchAllowed,
    });

  it('keeps web_search in the full parameter set even when the role denies it', () => {
    const keys = resolved(false).parameters.map((param) => param.key);
    expect(keys).toContain('web_search');
  });

  it("preserves a stored web_search value through a denied editor's save", () => {
    const denied = resolved(false);
    const stored = { model: 'gpt-4o', web_search: true, temperature: 0.5 } as never;
    expect(pruneAgentModelParameters(stored, denied)).toEqual(stored);
  });

  it('still prunes a parameter the schema genuinely does not define', () => {
    const denied = resolved(false);
    const stored = { model: 'gpt-4o', not_a_real_param: true } as never;
    expect(pruneAgentModelParameters(stored, denied)).not.toHaveProperty('not_a_real_param');
  });
});

const defaults: AgentModelParameters = {
  temperature: null,
  maxContextTokens: null,
  max_context_tokens: null,
  max_output_tokens: null,
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
};

describe.each([
  ['anthropic', 'claude-opus-5-5'],
  ['bedrock', 'global.anthropic.claude-opus-5-5'],
])('%s model-hidden parameters', (provider, model) => {
  const hidden = {
    thinking: false,
    thinkingBudget: 4096,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
  };
  const stored = { ...defaults, ...hidden };

  it('keeps hidden parameters recognized without exposing controls or bypassing role gating', () => {
    const settings = resolveAgentParameterSettings({ provider, model, webSearchAllowed: false });
    expect(settings.parameters.map(({ key }) => key)).toEqual(
      expect.arrayContaining(Object.keys(hidden)),
    );
    for (const key of [...Object.keys(hidden), 'web_search']) {
      expect(settings.visibleParameters.map((param) => param.key)).not.toContain(key);
    }
    expect(pruneAgentModelParameters(stored, settings)).toBe(stored);
  });

  it('continues pruning explicitly dropped parameters and unknown keys', () => {
    const settings = resolveAgentParameterSettings({
      provider,
      model,
      webSearchAllowed: true,
      startupConfig: { endpointsDropParamsMap: { [provider]: { [model]: ['temperature'] } } },
    });
    const result = pruneAgentModelParameters(
      { ...stored, not_a_parameter: true } as AgentModelParameters,
      settings,
    );
    expect(result).not.toHaveProperty('temperature');
    expect(result).not.toHaveProperty('not_a_parameter');
    expect(result).toMatchObject({ thinking: false, thinkingBudget: 4096, topP: 0.9, topK: 40 });
    expect(stored.temperature).toBe(0.7);
  });
});

it('preserves custom Anthropic settings while applying overrides only to visible controls', () => {
  const definitions = agentParamSettings.anthropic ?? [];
  const effort = definitions.find(({ key }) => key === 'effort')!;
  const temperature = definitions.find(({ key }) => key === 'temperature')!;
  const settings = resolveAgentParameterSettings({
    provider: 'custom-anthropic',
    model: 'claude-opus-5-5',
    webSearchAllowed: false,
    endpointsConfig: {
      'custom-anthropic': {
        order: 0,
        type: EModelEndpoint.custom,
        customParams: {
          defaultParamsEndpoint: 'anthropic',
          paramDefinitions: [
            { ...effort, default: 'low' },
            { ...temperature, default: 0.3 },
          ],
        },
      },
    },
  });
  expect(settings.visibleParameters.find(({ key }) => key === 'effort')?.default).toBe('low');
  expect(settings.visibleParameters.some(({ key }) => key === 'temperature')).toBe(false);
  expect(settings.visibleParameters.some(({ key }) => key === 'web_search')).toBe(false);
  const stored = { ...defaults, temperature: 0.7, thinking: false, web_search: true };
  expect(pruneAgentModelParameters(stored, settings)).toBe(stored);
});
