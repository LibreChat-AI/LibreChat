import type { SettingDefinition } from './generate';
import {
  paramSettings,
  resolveReasoningSetting,
  resolveReasoningSettingForTarget,
  isReasoningOverrideSupported,
  applyModelAwareDefaults,
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
