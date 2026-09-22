import {
  AnthropicEffort,
  EModelEndpoint,
  ReasoningEffort,
  ReasoningParameterFormat,
  ThinkingLevel,
  type TReasoningOverride,
} from 'librechat-data-provider';
import {
  parseReasoningOverrideRequest,
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

describe('parseReasoningOverrideRequest', () => {
  it('accepts a request that carries no reasoning override', () => {
    expect(parseReasoningOverrideRequest(undefined)).toEqual({ ok: true });
    expect(parseReasoningOverrideRequest(null)).toEqual({ ok: true });
  });

  it('returns the parsed override for a well-formed payload', () => {
    const result = parseReasoningOverrideRequest({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.reasoningOverride).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
  });

  it('rejects an unknown key rather than passing it to the resolver', () => {
    expect(
      parseReasoningOverrideRequest({ key: 'not_a_reasoning_field', value: ReasoningEffort.high }),
    ).toEqual({
      ok: false,
      reason: 'invalid-reasoning-override',
    });
  });

  it('rejects a payload that is not an object', () => {
    expect(parseReasoningOverrideRequest('reasoning_effort')).toEqual({
      ok: false,
      reason: 'invalid-reasoning-override',
    });
  });
});

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

    expect(result).toEqual({ ok: false, reason: 'invalid-reasoning-override' });
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

    expect(result).toEqual({ ok: false, reason: 'invalid-reasoning-override' });
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

    expect(result).toEqual({ ok: false, reason: 'invalid-reasoning-override' });
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
  it('accepts the effort level advertised by a non-agent custom endpoint', async () => {
    const result = await resolve({
      endpoint: 'Mock Provider A',
      endpointType: EModelEndpoint.custom,
      parsedModel: 'mock-model-a',
      isAgent: false,
      reasoningOverride: { key: 'effort', value: AnthropicEffort.high },
      endpointOption: {
        endpointType: EModelEndpoint.custom,
        model_parameters: { model: 'mock-model-a' },
      },
      endpointsConfig: {
        'Mock Provider A': {
          order: 0,
          type: EModelEndpoint.custom,
          customParams: {
            defaultParamsEndpoint: EModelEndpoint.anthropic,
            paramDefinitions: [{ key: 'effort' }],
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelParameters: { model: 'mock-model-a', effort: AnthropicEffort.high, thinking: true },
    });
  });

  describe('a thinking budget range the operator widened past the built-in maximum', () => {
    const wideBudget = (value: number) =>
      resolve({
        endpoint: 'Mock Provider A',
        endpointType: EModelEndpoint.custom,
        parsedModel: 'mock-model-a',
        isAgent: false,
        reasoningOverride: { key: 'thinkingBudget', value },
        endpointOption: {
          endpointType: EModelEndpoint.custom,
          model_parameters: { model: 'mock-model-a' },
        },
        endpointsConfig: {
          'Mock Provider A': {
            order: 0,
            type: EModelEndpoint.custom,
            customParams: {
              defaultParamsEndpoint: EModelEndpoint.anthropic,
              paramDefinitions: [
                { key: 'thinkingBudget', range: { min: 1024, max: 500000, step: 1024 } },
              ],
            },
          },
        },
      });

    it('parses and applies a budget inside the configured range', async () => {
      expect(parseReasoningOverrideRequest({ key: 'thinkingBudget', value: 300032 })).toEqual({
        ok: true,
        reasoningOverride: { key: 'thinkingBudget', value: 300032 },
      });
      await expect(wideBudget(300032)).resolves.toMatchObject({ ok: true });
    });

    it('still rejects a budget above the configured range', async () => {
      await expect(wideBudget(600064)).resolves.toMatchObject({ ok: false });
    });
  });

  it('rejects an override for a field owned by an enforced model spec', async () => {
    const result = await resolve({
      enforcedModelSpecFields: new Set(['reasoning_effort']),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-reasoning-override' });
  });
});
