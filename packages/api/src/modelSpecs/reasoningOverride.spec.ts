import {
  AnthropicEffort,
  EModelEndpoint,
  ReasoningEffort,
  ReasoningParameterFormat,
  ThinkingLevel,
  type TReasoningOverride,
} from 'librechat-data-provider';
import {
  resolveReasoningOverride,
  type ReasoningOverrideInput,
  type ReasoningOverrideResult,
} from './reasoningOverride';

const baseInput: ReasoningOverrideInput = {
  reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
  endpointOption: {
    model_parameters: { model: 'gpt-5.1', reasoning_effort: 'low' },
    agent: Promise.resolve({ provider: EModelEndpoint.openAI, model: 'gpt-5.1' }),
  },
  endpoint: EModelEndpoint.openAI,
  isAgent: true,
  endpointsConfig: {},
};

const resolve = async (
  overrides: Partial<ReasoningOverrideInput> = {},
): Promise<ReasoningOverrideResult> =>
  resolveReasoningOverride({
    ...baseInput,
    ...overrides,
    endpointOption: {
      ...baseInput.endpointOption,
      ...overrides.endpointOption,
    },
  });

const expectInvalid = (result: ReasoningOverrideResult) => {
  expect(result).toEqual({ ok: false, reason: 'invalid-reasoning-override' });
};

describe('resolveReasoningOverride', () => {
  it('applies a supported override and records the existing value', async () => {
    const result = await resolve();

    expect(result).toEqual({
      ok: true,
      modelParameters: {
        model: 'gpt-5.1',
        reasoning_effort: 'high',
      },
      reasoningOverrideBase: {
        key: 'reasoning_effort',
        hadValue: true,
        value: 'low',
      },
    });
  });

  it('rejects an override whose field does not belong to the effective provider', async () => {
    const result = await resolve({
      reasoningOverride: { key: 'effort', value: AnthropicEffort.high },
    });

    expectInvalid(result);
  });

  it.each([
    [EModelEndpoint.anthropic, 'claude-sonnet-4-6', { key: 'effort', value: 'max' }],
    [EModelEndpoint.google, 'gemini-3-pro', { key: 'thinkingLevel', value: ThinkingLevel.high }],
    [EModelEndpoint.google, 'gemini-2.5-pro', { key: 'thinkingBudget', value: 32768 }],
  ])('applies the supported %s reasoning field', async (endpoint, model, reasoningOverride) => {
    const result = await resolve({
      endpoint,
      reasoningOverride: reasoningOverride as TReasoningOverride,
      endpointOption: {
        model_parameters: { model },
        agent: Promise.resolve({ provider: endpoint, model }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelParameters: {
        model,
        [reasoningOverride.key]: reasoningOverride.value,
        thinking: true,
      },
    });
  });

  it('rejects the wrong Google reasoning field for Gemini 2.5', async () => {
    const result = await resolve({
      endpoint: EModelEndpoint.google,
      reasoningOverride: { key: 'thinkingLevel', value: ThinkingLevel.high },
      endpointOption: {
        model_parameters: { model: 'gemini-2.5-pro' },
        agent: Promise.resolve({ provider: EModelEndpoint.google, model: 'gemini-2.5-pro' }),
      },
    });

    expectInvalid(result);
  });

  it('rejects overrides for custom endpoints that disable reasoning parameters', async () => {
    const result = await resolve({
      endpoint: 'QwenCompatible',
      isAgent: true,
      reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      endpointOption: {
        model_parameters: { model: 'qwen3-max' },
        agent: Promise.resolve({ provider: 'QwenCompatible', model: 'qwen3-max' }),
      },
      endpointsConfig: {
        QwenCompatible: {
          order: 0,
          type: EModelEndpoint.custom,
          customParams: { reasoningFormat: ReasoningParameterFormat.disabled },
        },
      },
    });

    expectInvalid(result);
  });

  it.each([
    ['anthropic.claude-sonnet-4-6-v1:0', 'effort', 'high'],
    ['moonshot.kimi-k2.5', 'reasoning_effort', 'high'],
    ['zai.glm-4.7', 'reasoning_effort', 'high'],
  ])('applies the Bedrock model-family reasoning field for %s', async (model, key, value) => {
    const result = await resolve({
      endpoint: EModelEndpoint.bedrock,
      reasoningOverride: { key, value } as TReasoningOverride,
      endpointOption: {
        model_parameters: { model },
        agent: Promise.resolve({ provider: EModelEndpoint.bedrock, model }),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelParameters: { model, [key]: value },
    });
  });

  it('preserves the saved base value for a repeated override key', async () => {
    const existingBase = {
      key: 'reasoning_effort' as const,
      hadValue: true,
      value: 'medium',
    };
    const result = await resolve({ reasoningOverrideBase: existingBase });

    expect(result).toMatchObject({ ok: true, reasoningOverrideBase: existingBase });
  });

  it('uses a custom-backed agent provider default when validating its override', async () => {
    const result = await resolve({
      endpoint: EModelEndpoint.agents,
      reasoningOverride: { key: 'effort', value: AnthropicEffort.high },
      endpointOption: {
        model_parameters: { model: 'claude-sonnet-4-6', effort: 'low' },
        agent: Promise.resolve({ provider: 'ClaudeProxy', model: 'claude-sonnet-4-6' }),
      },
      endpointsConfig: {
        ClaudeProxy: {
          order: 0,
          type: EModelEndpoint.custom,
          customParams: { defaultParamsEndpoint: EModelEndpoint.anthropic },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelParameters: { effort: 'high' },
    });
  });

  it('rejects an override for a field owned by an enforced model spec', async () => {
    const result = await resolve({
      enforcedModelSpecFields: new Set(['reasoning_effort']),
    });

    expectInvalid(result);
  });
});
