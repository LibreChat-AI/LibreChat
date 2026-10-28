import {
  agentParamSettings,
  EModelEndpoint,
  SettingTypes,
  ComponentTypes,
  ReasoningParameterFormat,
} from 'librechat-data-provider';
import type { AgentModelParameters, TModelReasoning } from 'librechat-data-provider';
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

describe('resolveAgentParameterSettings: OpenRouter reasoning efforts', () => {
  const resolve = (modelReasoning?: TModelReasoning | null) =>
    resolveAgentParameterSettings({
      provider: 'openrouter',
      model: 'openai/gpt-6.1-sol',
      webSearchAllowed: true,
      modelReasoning,
    });
  const keys = (list: { key: string }[]) => list.map(({ key }) => key);

  it('hides the effort control while the efforts are unknown to be loading', () => {
    expect(keys(resolve(null).visibleParameters)).not.toContain('reasoning_effort');
  });

  it('keeps the stored effort in the recognized schema while the control is hidden', () => {
    const settings = resolve(null);
    const stored = { reasoning_effort: 'max' } as unknown as AgentModelParameters;

    expect(keys(settings.parameters)).toContain('reasoning_effort');
    expect(pruneAgentModelParameters(stored, settings)).toBe(stored);
  });

  it('offers the effort control narrowed to what the model reports', () => {
    const settings = resolve({ efforts: ['low', 'high'] });

    const effort = settings.visibleParameters.find(({ key }) => key === 'reasoning_effort');
    expect(effort?.options).toEqual(['', 'low', 'high']);
  });
});

describe('administrator-declared inference controls', () => {
  const endpointsConfig = {
    Gateway: {
      order: 0,
      type: EModelEndpoint.custom,
      customParams: {
        defaultParamsEndpoint: 'custom',
        paramDefinitions: [
          {
            key: 'min_p',
            type: SettingTypes.Number,
            component: ComponentTypes.Input,
            label: 'Minimum Probability',
            default: 0.1,
          },
          {
            key: 'foo_generation_mode',
            type: SettingTypes.Enum,
            component: ComponentTypes.Dropdown,
            label: 'Generation Mode',
            options: ['fast', 'accurate'],
            default: 'accurate',
          },
          { key: 'modelLabel', type: SettingTypes.String, component: ComponentTypes.Input },
        ],
      },
    },
  };
  const stored = {
    temperature: 0.3,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
    min_p: 0.7,
    foo_generation_mode: 'fast',
  };
  const resolve = (drops: string[] = []) =>
    resolveAgentParameterSettings({
      provider: 'Gateway',
      model: 'permitted',
      webSearchAllowed: true,
      endpointsConfig,
      startupConfig: { endpointsDropParamsMap: { Gateway: drops } },
    });

  it('offers typed controls and retains their saved values on unrelated edits', () => {
    const settings = resolve();
    expect(settings.visibleParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'min_p', label: 'Minimum Probability' }),
        expect.objectContaining({ key: 'foo_generation_mode', options: ['fast', 'accurate'] }),
      ]),
    );
    expect(settings.parameters.map(({ key }) => key)).not.toContain('modelLabel');
    expect(pruneAgentModelParameters(stored, settings)).toBe(stored);
  });

  it('honors administrator drops for both rendering and persistence', () => {
    const settings = resolve(['min_p']);
    expect(settings.visibleParameters.map(({ key }) => key)).not.toContain('min_p');
    expect(pruneAgentModelParameters(stored, settings)).not.toHaveProperty('min_p');
    expect(pruneAgentModelParameters(stored, settings)).toHaveProperty(
      'foo_generation_mode',
      'fast',
    );
  });
});

describe('OpenRouter cache preferences do not depend on reasoning', () => {
  it.each(['reasoning', 'reasoning_effort'])(
    'keeps cache controls when %s is dropped',
    (dropped) => {
      const settings = resolveAgentParameterSettings({
        provider: 'Gateway',
        model: 'permitted',
        webSearchAllowed: true,
        endpointsConfig: {
          Gateway: {
            order: 0,
            type: EModelEndpoint.custom,
            customParams: {
              defaultParamsEndpoint: 'openrouter',
              reasoningFormat: ReasoningParameterFormat.disabled,
            },
          },
        },
        startupConfig: { endpointsDropParamsMap: { Gateway: [dropped] } },
      });
      expect(settings.visibleParameters.map(({ key }) => key)).toEqual(
        expect.arrayContaining(['promptCache', 'promptCacheTtl']),
      );
      expect(settings.visibleParameters.map(({ key }) => key)).not.toContain('reasoning_effort');
      const saved = { ...defaults, promptCache: false, promptCacheTtl: '1h' as const };
      expect(pruneAgentModelParameters(saved, settings)).toBe(saved);
    },
  );
});

describe('legacy reasoning control visibility', () => {
  it.each([false, true])(
    'preserves stored values but hides an explicitly disabled legacy control (%s)',
    (disabled) => {
      const settings = resolveAgentParameterSettings({
        provider: 'Gateway',
        model: 'permitted',
        webSearchAllowed: true,
        endpointsConfig: {
          Gateway: {
            order: 0,
            type: EModelEndpoint.custom,
            customParams: {
              defaultParamsEndpoint: 'openrouter',
              reasoningFormat: disabled
                ? ReasoningParameterFormat.disabled
                : ReasoningParameterFormat.reasoningEffort,
              paramDefinitions: [
                {
                  key: 'include_reasoning',
                  type: SettingTypes.Boolean,
                  component: ComponentTypes.Checkbox,
                },
              ],
            },
          },
        },
      });
      expect(settings.visibleParameters.some(({ key }) => key === 'include_reasoning')).toBe(
        !disabled,
      );
      expect(settings.parameters.some(({ key }) => key === 'include_reasoning')).toBe(true);
      const saved = { ...defaults, include_reasoning: true, promptCache: false };
      expect(pruneAgentModelParameters(saved, settings)).toBe(saved);
    },
  );
});
