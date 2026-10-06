import type { TModelReasoning, TReasoningCapabilityMap } from './types';
import type { SettingDefinition } from './generate';
import {
  paramSettings,
  resolveReasoningSetting,
  resolveReasoningSettingForTarget,
  isReasoningOverrideSupported,
  applyModelAwareDefaults,
  getModelReasoning,
  effectiveModelReasoning,
  hasExplicitReasoningEffort,
  resolveModelReasoning,
  isOpenRouterEffortSupported,
  resolveDropParamsUIKeys,
} from './parameterSettings';
import { BedrockProviders, EModelEndpoint, Providers } from './types';
import { ReasoningEffort, ReasoningParameterFormat } from './schemas';

const googleParams = paramSettings[EModelEndpoint.google] as SettingDefinition[];
const anthropicParams = paramSettings[EModelEndpoint.anthropic] as SettingDefinition[];
const maxOut = (params: SettingDefinition[]) => params.find((p) => p.key === 'maxOutputTokens');
const maxContext = (params: SettingDefinition[]) =>
  params.find((p) => p.key === 'maxContextTokens');
const thinkingBudget = (params: SettingDefinition[]) =>
  params.find((p) => p.key === 'thinkingBudget');
const hasSetting = (params: SettingDefinition[], key: string) =>
  params.some((param) => param.key === key);

describe('applyModelAwareDefaults', () => {
  it('resolves the Google maxOutputTokens default for current Gemini models', () => {
    const result = applyModelAwareDefaults(googleParams, EModelEndpoint.google, 'gemini-2.5-pro');
    expect(maxOut(result)?.default).toBe(65535);
  });

  it('resolves the legacy default for older Gemini models', () => {
    const result = applyModelAwareDefaults(googleParams, EModelEndpoint.google, 'gemini-1.5-flash');
    expect(maxOut(result)?.default).toBe(8192);
  });

  it('resolves the image default for Gemini image models', () => {
    const result = applyModelAwareDefaults(
      googleParams,
      EModelEndpoint.google,
      'gemini-2.5-flash-image',
    );
    expect(maxOut(result)?.default).toBe(32768);
  });

  it('returns settings unchanged for unrelated endpoints', () => {
    const result = applyModelAwareDefaults(googleParams, EModelEndpoint.openAI, 'gemini-2.5-pro');
    expect(result).toBe(googleParams);
  });

  it('keeps prompt-cache controls for future Claude models that support caching', () => {
    const result = applyModelAwareDefaults(
      anthropicParams,
      EModelEndpoint.anthropic,
      'claude-sonnet-6',
    );

    expect(hasSetting(result, 'promptCache')).toBe(true);
    expect(hasSetting(result, 'promptCacheTtl')).toBe(true);
  });

  it('hides prompt-cache controls for Anthropic models that do not support caching', () => {
    const result = applyModelAwareDefaults(
      anthropicParams,
      EModelEndpoint.anthropic,
      'claude-3-5-sonnet-latest',
    );

    expect(hasSetting(result, 'promptCache')).toBe(false);
    expect(hasSetting(result, 'promptCacheTtl')).toBe(false);
    expect(hasSetting(result, 'temperature')).toBe(true);
  });

  it('hides unsupported thinking and sampling controls for Opus 5.5', () => {
    const result = applyModelAwareDefaults(
      anthropicParams,
      EModelEndpoint.anthropic,
      'claude-opus-5-5',
    );

    expect(hasSetting(result, 'thinking')).toBe(false);
    expect(hasSetting(result, 'thinkingBudget')).toBe(false);
    expect(hasSetting(result, 'temperature')).toBe(false);
    expect(hasSetting(result, 'topP')).toBe(false);
    expect(hasSetting(result, 'topK')).toBe(false);
    expect(hasSetting(result, 'effort')).toBe(true);
  });

  it.each(['claude-sonnet-5-5', 'claude-sonnet-5.5'])(
    'keeps the thinking toggle but hides budget and sampling controls for %s',
    (model) => {
      const result = applyModelAwareDefaults(anthropicParams, EModelEndpoint.anthropic, model);

      expect(hasSetting(result, 'thinking')).toBe(true);
      expect(result.find((setting) => setting.key === 'thinking')?.description).toBe(
        'com_endpoint_anthropic_thinking_between_tools',
      );
      expect(hasSetting(result, 'thinkingBudget')).toBe(false);
      expect(hasSetting(result, 'temperature')).toBe(false);
      expect(hasSetting(result, 'topP')).toBe(false);
      expect(hasSetting(result, 'topK')).toBe(false);
      expect(hasSetting(result, 'effort')).toBe(true);
      expect(hasSetting(result, 'thinkingDisplay')).toBe(true);
      expect(hasSetting(result, 'promptCache')).toBe(true);
    },
  );

  it('returns settings unchanged when no model is provided', () => {
    expect(applyModelAwareDefaults(googleParams, EModelEndpoint.google, '')).toBe(googleParams);
  });

  it('does not mutate the original settings', () => {
    const before = maxOut(googleParams)?.default;
    applyModelAwareDefaults(googleParams, EModelEndpoint.google, 'gemini-2.5-pro');
    expect(maxOut(googleParams)?.default).toBe(before);
  });

  it('lets a configured override applied afterward take precedence', () => {
    const modelAware = applyModelAwareDefaults(
      googleParams,
      EModelEndpoint.google,
      'gemini-2.5-pro',
    );
    const override = { ...maxOut(modelAware), default: 2048 } as SettingDefinition;
    const final = modelAware.map((p) => (p.key === 'maxOutputTokens' ? override : p));
    expect(maxOut(final)?.default).toBe(2048);
  });

  it('keeps thinkingBudget -1 as the range minimum and applies the Pro floor separately', () => {
    const result = applyModelAwareDefaults(googleParams, EModelEndpoint.google, 'gemini-2.5-pro');
    expect(thinkingBudget(result)?.range).toMatchObject({
      min: -1,
      max: 32768,
      positiveMin: 128,
    });
  });

  it('applies the Flash Lite thinking-budget floor without raising the sentinel minimum', () => {
    const result = applyModelAwareDefaults(
      googleParams,
      EModelEndpoint.google,
      'gemini-2.5-flash-lite',
    );
    expect(thinkingBudget(result)?.range).toMatchObject({
      min: -1,
      max: 24576,
      positiveMin: 512,
    });
  });

  it('applies the Flash thinking-budget ceiling and a zero positive floor', () => {
    const result = applyModelAwareDefaults(googleParams, EModelEndpoint.google, 'gemini-2.5-flash');
    expect(thinkingBudget(result)?.range).toMatchObject({
      min: -1,
      max: 24576,
      positiveMin: 0,
    });
  });
});

describe('resolveReasoningSetting', () => {
  it('selects qualitative reasoning effort for OpenAI reasoning models', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-5.6',
        settings: paramSettings[EModelEndpoint.openAI] ?? [],
      })?.key,
    ).toBe('reasoning_effort');
  });

  it('hides the control for known non-reasoning OpenAI models', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        settings: paramSettings[EModelEndpoint.openAI] ?? [],
      }),
    ).toBeUndefined();
  });

  it('uses the configured Azure capability for administrator-defined deployment names', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'production-reasoning-west',
        settings: paramSettings[EModelEndpoint.azureOpenAI] ?? [],
      })?.key,
    ).toBe('reasoning_effort');
  });

  it('keeps custom OpenAI-compatible models capability-driven', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.custom,
        model: 'qwen3.8-max',
        settings: paramSettings[EModelEndpoint.custom] ?? [],
      })?.key,
    ).toBe('reasoning_effort');
  });

  it('uses effort for adaptive Claude and a token budget for manual-thinking Claude', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.anthropic,
        model: 'claude-sonnet-4.6',
        settings: paramSettings[EModelEndpoint.anthropic] ?? [],
      })?.key,
    ).toBe('effort');
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.anthropic,
        model: 'claude-3-7-sonnet-latest',
        settings: paramSettings[EModelEndpoint.anthropic] ?? [],
      })?.key,
    ).toBe('thinkingBudget');
  });

  it('uses thinking level for Gemini 3 and a token budget for Gemini 2.5', () => {
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.google,
        model: 'gemini-3.5-flash',
        settings: paramSettings[EModelEndpoint.google] ?? [],
      })?.key,
    ).toBe('thinkingLevel');
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.google,
        model: 'gemini-2.5-pro',
        settings: paramSettings[EModelEndpoint.google] ?? [],
      })?.key,
    ).toBe('thinkingBudget');
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.google,
        model: 'gemini-1.5-pro',
        settings: paramSettings[EModelEndpoint.google] ?? [],
      }),
    ).toBeUndefined();
  });

  it('uses the Bedrock provider-specific settings surface', () => {
    const endpoint = `${EModelEndpoint.bedrock}-${BedrockProviders.Moonshot}`;
    expect(
      resolveReasoningSetting({
        endpoint,
        model: 'moonshot.kimi-k2.5',
        settings: paramSettings[endpoint] ?? [],
      })?.key,
    ).toBe('reasoning_effort');
  });

  it('supports Bedrock Claude but hides non-reasoning Bedrock families', () => {
    const anthropicEndpoint = `${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}`;
    expect(
      resolveReasoningSetting({
        endpoint: anthropicEndpoint,
        model: 'anthropic.claude-sonnet-4-6-v1:0',
        settings: paramSettings[anthropicEndpoint] ?? [],
      })?.key,
    ).toBe('effort');

    const metaEndpoint = `${EModelEndpoint.bedrock}-${BedrockProviders.Meta}`;
    expect(
      resolveReasoningSetting({
        endpoint: metaEndpoint,
        model: 'meta.llama4-maverick-instruct-v1:0',
        settings: paramSettings[metaEndpoint] ?? [],
      }),
    ).toBeUndefined();
  });

  it('normalizes the production-shaped bare Bedrock endpoint before selecting Claude reasoning', () => {
    const settings = paramSettings[`${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}`] ?? [];
    expect(
      resolveReasoningSetting({
        endpoint: EModelEndpoint.bedrock,
        model: 'anthropic.claude-3-7-sonnet-20250219-v1:0',
        settings,
      })?.key,
    ).toBe('thinkingBudget');
  });
});

describe('resolveReasoningSettingForTarget', () => {
  it('uses a custom-backed agent default parameter surface', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: 'ClaudeProxy',
        model: 'claude-sonnet-4-6',
        isAgent: true,
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      })?.key,
    ).toBe('effort');
  });

  it('prefers a custom endpoint default over the generic custom surface', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'claude-sonnet-4-6',
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      })?.key,
    ).toBe('effort');
  });
  it.each([EModelEndpoint.custom, Providers.OPENROUTER])(
    'does not infer reasoning for an undeclared %s deployment',
    (endpoint) => {
      expect(
        resolveReasoningSettingForTarget({
          endpoint,
          model: 'deployment-model',
        }),
      ).toBeUndefined();
    },
  );
  it('requires an explicit reasoning definition for Azure deployments', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'administrator-named-deployment',
      }),
    ).toBeUndefined();
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'administrator-named-deployment',
        paramDefinitions: [{ key: 'reasoning_effort' }],
      })?.key,
    ).toBe('reasoning_effort');
  });
  it('honors an explicit reasoning format on a custom deployment', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'deployment-model',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
      })?.key,
    ).toBe('reasoning_effort');
  });
  it('hides a custom deployment when its reasoning format is disabled', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'deployment-model',
        reasoningFormat: ReasoningParameterFormat.disabled,
      }),
    ).toBeUndefined();
  });

  it('offers only the declared options a request override can carry', () => {
    const declared = (options: string[]) =>
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'deployment-model',
        paramDefinitions: [{ key: 'thinkingLevel', type: 'enum', options }],
      });
    expect(declared(['', 'low', 'ultra', 'high'])?.options).toEqual(['', 'low', 'high']);
    expect(declared(['ultra', 'turbo'])).toBeUndefined();
  });

  it('merges a deployment-owned reasoning definition into provider defaults', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'deployment-model',
        paramDefinitions: [
          {
            key: 'reasoning_effort',
            type: 'enum',
            options: ['low', 'high'],
          } as SettingDefinition,
        ],
      })?.options,
    ).toEqual(['low', 'high']);
  });

  it('resolves the declared effort control for a custom endpoint using Anthropic defaults', () => {
    const setting = resolveReasoningSettingForTarget({
      endpoint: EModelEndpoint.custom,
      model: 'mock-model-a',
      defaultParamsEndpoint: EModelEndpoint.anthropic,
      paramDefinitions: [{ key: 'effort' }],
    });

    expect(setting).toMatchObject({
      key: 'effort',
      options: expect.arrayContaining(['low', 'high']),
    });
  });
  it.each([
    [
      'effort',
      { key: 'effort', type: 'enum', options: ['low', 'high'] } as Partial<SettingDefinition>,
    ],
    [
      'thinkingLevel',
      {
        key: 'thinkingLevel',
        type: 'enum',
        options: ['low', 'high'],
      } as Partial<SettingDefinition>,
    ],
    [
      'thinkingBudget',
      {
        key: 'thinkingBudget',
        type: 'number',
        range: { min: 256, max: 32768, step: 128 },
      } as Partial<SettingDefinition>,
    ],
  ])(
    'appends the declared %s reasoning definition without a default parameter endpoint',
    (key, definition) => {
      const setting = resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model: 'deployment-model',
        paramDefinitions: [definition],
      });

      expect(setting?.key).toBe(key);
      expect(setting).toMatchObject(definition);
    },
  );
});

describe('isReasoningOverrideSupported', () => {
  it('rejects a stale key and a model-specific value outside its range', () => {
    const setting = {
      key: 'thinkingBudget',
      type: 'number',
      range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
    } as SettingDefinition;

    expect(
      isReasoningOverrideSupported(
        { key: 'reasoning_effort', value: ReasoningEffort.high },
        setting,
      ),
    ).toBe(false);
    expect(isReasoningOverrideSupported({ key: 'thinkingBudget', value: 64000 }, setting)).toBe(
      false,
    );
    expect(isReasoningOverrideSupported({ key: 'thinkingBudget', value: 32768 }, setting)).toBe(
      true,
    );
  });
});

/**
 * The field is rendered by every endpoint, so bounds written for Gemini would
 * silently clamp a context window another provider accepts.
 */
describe('maxContextTokens bounds', () => {
  it('bounds the Google field to the documented context window', () => {
    expect(maxContext(googleParams)?.range).toEqual({ min: 10, max: 2000000, step: 1000 });
  });

  it('leaves every other endpoint unbounded', () => {
    const bounded = Object.entries(paramSettings)
      .filter(([endpoint]) => endpoint !== EModelEndpoint.google)
      .filter(([, params]) => maxContext(params as SettingDefinition[])?.range != null)
      .map(([endpoint]) => endpoint);

    expect(bounded).toEqual([]);
  });
});

describe('resolveDropParamsUIKeys', () => {
  it('aliases backend param names to their UI keys for OpenAI-compatible endpoints', () => {
    expect(
      resolveDropParamsUIKeys(
        ['maxTokens', 'topP', 'frequencyPenalty', 'presencePenalty'],
        EModelEndpoint.openAI,
      ),
    ).toEqual(new Set(['max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty']));
  });

  it('aliases backend param names for azureOpenAI, custom, and openRouter endpoints', () => {
    expect(resolveDropParamsUIKeys(['maxTokens'], EModelEndpoint.azureOpenAI)).toEqual(
      new Set(['max_tokens']),
    );
    expect(resolveDropParamsUIKeys(['topP'], EModelEndpoint.custom)).toEqual(new Set(['top_p']));
    expect(resolveDropParamsUIKeys(['topP'], Providers.OPENROUTER)).toEqual(new Set(['top_p']));
  });

  it('preserves native keys for a custom endpoint overridden to anthropic/google, since their UI key already matches the backend name', () => {
    expect(resolveDropParamsUIKeys(['topP'], EModelEndpoint.anthropic)).toEqual(new Set(['topP']));
    expect(resolveDropParamsUIKeys(['topP'], EModelEndpoint.google)).toEqual(new Set(['topP']));
  });

  it('preserves native keys for bedrock endpoints', () => {
    expect(
      resolveDropParamsUIKeys(['maxTokens', 'topP'], `${EModelEndpoint.bedrock}-anthropic`),
    ).toEqual(new Set(['maxTokens', 'topP']));
  });

  it('returns an empty set when dropParams is undefined or empty', () => {
    expect(resolveDropParamsUIKeys(undefined, EModelEndpoint.openAI)).toEqual(new Set());
    expect(resolveDropParamsUIKeys([], EModelEndpoint.openAI)).toEqual(new Set());
  });
});

describe('per-model OpenRouter reasoning efforts', () => {
  const openRouterSettings = paramSettings[Providers.OPENROUTER] as SettingDefinition[];
  const model = 'openai/gpt-6.1-sol';
  const effortOptions = (
    modelReasoning?: TModelReasoning | null,
    endpoint: string = Providers.OPENROUTER,
    forModel: string = model,
  ) =>
    applyModelAwareDefaults(openRouterSettings, endpoint, forModel, undefined, modelReasoning).find(
      (setting) => setting.key === 'reasoning_effort',
    )?.options;
  const target = (modelReasoning?: TModelReasoning | null) =>
    resolveReasoningSettingForTarget({
      endpoint: EModelEndpoint.custom,
      model,
      defaultParamsEndpoint: Providers.OPENROUTER,
      reasoningFormat: ReasoningParameterFormat.reasoningEffort,
      modelReasoning,
    });

  it('keeps the generic list while capabilities are still unknown', () => {
    expect(effortOptions(undefined)).toContain(ReasoningEffort.max);
    expect(target(undefined)?.options).toContain(ReasoningEffort.none);
  });

  it('offers only the efforts the model supports, plus Auto', () => {
    expect(effortOptions({ efforts: ['low', 'high'] })).toEqual([
      ReasoningEffort.unset,
      ReasoningEffort.low,
      ReasoningEffort.high,
    ]);
  });

  it('drops none for a model whose reasoning is mandatory', () => {
    expect(effortOptions({ efforts: ['none', 'low', 'high'], mandatory: true })).toEqual([
      ReasoningEffort.unset,
      ReasoningEffort.low,
      ReasoningEffort.high,
    ]);
  });

  it('keeps none when reasoning can be turned off', () => {
    expect(effortOptions({ efforts: ['none', 'low'] })).toContain(ReasoningEffort.none);
  });

  it('hides the setting for a model without reasoning metadata', () => {
    expect(effortOptions(null)).toBeUndefined();
  });

  it('hides the setting when no supported effort is a known level', () => {
    expect(effortOptions({ efforts: ['ultra'] })).toBeUndefined();
  });

  it('does not narrow an endpoint that is not OpenRouter', () => {
    expect(effortOptions({ efforts: ['low'] }, EModelEndpoint.openAI)).toContain(
      ReasoningEffort.max,
    );
  });

  it('keeps a model family list inside the efforts the provider reports', () => {
    expect(
      effortOptions({ efforts: ['low', 'max'] }, Providers.OPENROUTER, 'x-ai/grok-4.7'),
    ).toEqual([ReasoningEffort.unset, ReasoningEffort.low]);
  });

  it('keeps an administrator-defined reasoning_effort when the model reports no reasoning', () => {
    const setting = resolveReasoningSettingForTarget({
      endpoint: EModelEndpoint.custom,
      model,
      defaultParamsEndpoint: Providers.OPENROUTER,
      paramDefinitions: [{ key: 'reasoning_effort', options: ['low', 'max'] }],
      modelReasoning: null,
    });

    expect(setting?.options).toEqual(['low', 'max']);
  });

  it('does not narrow an administrator-defined reasoning_effort', () => {
    const setting = resolveReasoningSettingForTarget({
      endpoint: EModelEndpoint.custom,
      model,
      defaultParamsEndpoint: Providers.OPENROUTER,
      paramDefinitions: [{ key: 'reasoning_effort', options: ['low', 'max'] }],
      modelReasoning: { efforts: ['high'] },
    });

    expect(setting?.options).toEqual(['low', 'max']);
  });

  it('narrows the composer setting for an OpenRouter custom endpoint', () => {
    expect(target({ efforts: ['low', 'high'] })?.options).toEqual([
      ReasoningEffort.unset,
      ReasoningEffort.low,
      ReasoningEffort.high,
    ]);
  });

  it('hides the composer setting for a model without reasoning metadata', () => {
    expect(target(null)).toBeUndefined();
  });

  it('leaves an explicit reasoning definition untouched', () => {
    expect(
      resolveReasoningSettingForTarget({
        endpoint: EModelEndpoint.custom,
        model,
        defaultParamsEndpoint: Providers.OPENROUTER,
        paramDefinitions: [{ key: 'reasoning_effort', options: ['low', 'max'] }],
        modelReasoning: null,
      })?.options,
    ).toEqual(['low', 'max']);
  });
});

describe('getModelReasoning', () => {
  const capabilities: TReasoningCapabilityMap = {
    OpenRouter: {
      'openai/gpt-6.1-sol': { efforts: ['low', 'high'] },
      'meta/plain': { efforts: [] },
    },
  };
  const lookup = (model: string) => getModelReasoning(capabilities, 'OpenRouter', model);

  it('is unknown when the endpoint was never resolved', () => {
    expect(getModelReasoning(undefined, 'OpenRouter', 'openai/gpt-6.1-sol')).toBeUndefined();
    expect(getModelReasoning(capabilities, 'Other', 'openai/gpt-6.1-sol')).toBeUndefined();
  });

  it('returns the efforts of a listed model', () => {
    expect(lookup('openai/gpt-6.1-sol')).toEqual({ efforts: ['low', 'high'] });
  });

  it('matches a model variant to its base model', () => {
    expect(lookup('openai/gpt-6.1-sol:nitro')).toEqual({ efforts: ['low', 'high'] });
  });

  it('reports no reasoning for a model the provider lists without effort selection', () => {
    expect(lookup('meta/plain')).toBeNull();
    expect(lookup('meta/plain:free')).toBeNull();
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'keeps a model id that names an Object.prototype member unknown: %s',
    (model) => {
      expect(lookup(model)).toBeUndefined();
      expect(lookup(`${model}:free`)).toBeUndefined();
    },
  );

  it('keeps an endpoint named after an Object.prototype member unknown', () => {
    expect(getModelReasoning(capabilities, 'constructor', 'openai/gpt-6.1-sol')).toBeUndefined();
    expect(getModelReasoning(capabilities, '__proto__', 'openai/gpt-6.1-sol')).toBeUndefined();
  });

  it('still finds a listed model that happens to be named like a prototype member', () => {
    const named = { OpenRouter: { constructor: { efforts: ['low'] } } };

    expect(getModelReasoning(named, 'OpenRouter', 'constructor')).toEqual({ efforts: ['low'] });
  });

  it('keeps a model the provider does not list unknown, such as an alias', () => {
    expect(lookup('meta/unlisted')).toBeUndefined();
    expect(lookup('~openai/gpt-latest')).toBeUndefined();
  });
});

describe('isOpenRouterEffortSupported', () => {
  it('accepts anything while the model capabilities are unknown', () => {
    expect(isOpenRouterEffortSupported('max', undefined)).toBe(true);
  });

  it('always accepts Auto, which sends no effort', () => {
    expect(isOpenRouterEffortSupported('', null)).toBe(true);
    expect(isOpenRouterEffortSupported(ReasoningEffort.unset, { efforts: ['low'] })).toBe(true);
  });

  it('accepts a reported effort and rejects an unreported one', () => {
    expect(isOpenRouterEffortSupported('low', { efforts: ['low', 'high'] })).toBe(true);
    expect(isOpenRouterEffortSupported('max', { efforts: ['low', 'high'] })).toBe(false);
  });

  it('rejects none for a model whose reasoning is mandatory', () => {
    expect(isOpenRouterEffortSupported('none', { efforts: ['none', 'low'], mandatory: true })).toBe(
      false,
    );
  });

  it('rejects any effort for a model the provider reports no reasoning for', () => {
    expect(isOpenRouterEffortSupported('low', null)).toBe(false);
  });
});

describe('effectiveModelReasoning', () => {
  const reported = { efforts: ['low'] };

  it('passes the reported efforts through without an explicit definition', () => {
    expect(effectiveModelReasoning(reported, undefined)).toBe(reported);
    expect(effectiveModelReasoning(null, [{ key: 'promptCache' }])).toBeNull();
  });

  it('ignores the reported efforts when the administrator defines reasoning_effort', () => {
    expect(effectiveModelReasoning(reported, [{ key: 'reasoning_effort' }])).toBeUndefined();
    expect(effectiveModelReasoning(null, [{ key: 'reasoning_effort' }])).toBeUndefined();
  });
});

describe('hasExplicitReasoningEffort', () => {
  it('is true only when reasoning_effort is defined', () => {
    expect(hasExplicitReasoningEffort([{ key: 'reasoning_effort' }])).toBe(true);
    expect(hasExplicitReasoningEffort([{ key: 'promptCache' }])).toBe(false);
    expect(hasExplicitReasoningEffort(undefined)).toBe(false);
    expect(hasExplicitReasoningEffort(null)).toBe(false);
  });
});

describe('resolveModelReasoning', () => {
  const capabilities = { OpenRouter: { 'a/b': { efforts: ['low'] }, 'c/d': { efforts: [] } } };
  const resolve = (overrides: Partial<Parameters<typeof resolveModelReasoning>[0]> = {}) =>
    resolveModelReasoning({ capabilities, endpoint: 'OpenRouter', model: 'a/b', ...overrides });

  it('returns the reported efforts once the capabilities are known', () => {
    expect(resolve()).toEqual({ efforts: ['low'] });
  });

  it('reports no reasoning for a model the catalog lists without it', () => {
    expect(resolve({ model: 'c/d' })).toBeNull();
  });

  it('keeps the generic efforts for a model the catalog does not list', () => {
    expect(resolve({ model: '~openai/gpt-latest' })).toBeUndefined();
  });

  it('hides the efforts while the capabilities are unknown, loading or failed', () => {
    expect(resolve({ capabilities: undefined })).toBeNull();
  });

  it('never narrows or hides an administrator-defined reasoning_effort', () => {
    const paramDefinitions = [{ key: 'reasoning_effort' }];

    expect(resolve({ paramDefinitions })).toBeUndefined();
    expect(resolve({ capabilities: undefined, paramDefinitions })).toBeUndefined();
  });
});
