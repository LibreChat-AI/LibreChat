import type { TModelSpec } from './models';
import {
  tModelSpecSchema,
  findLiteLLMModelDisplaySpec,
  getLiteLLMModelDisplayLabel,
} from './models';

const modelSpecs = {
  list: [
    {
      name: 'litellm-model-router',
      label: 'Claude Auto',
      litellmRoutedModel: { showOnResponses: true },
      preset: { endpoint: 'AnthropicClaude', model: 'litellm-model-router' },
    },
    {
      name: 'claude-sonnet',
      label: 'Claude Sonnet',
      preset: { endpoint: 'AnthropicClaude', model: 'claude-sonnet-5-5' },
    },
    {
      name: 'claude-opus',
      label: 'Claude Opus',
      litellmRoutedModel: { showOnResponses: false },
      preset: { endpoint: 'AnthropicClaude', model: 'claude-opus-5-5' },
    },
  ] as TModelSpec[],
};

/** Whether a response on `target` opts in to the routed-model label. */
const isLiteLLMModelDisplayEnabled = (...args: Parameters<typeof findLiteLLMModelDisplaySpec>) =>
  findLiteLLMModelDisplaySpec(...args) != null;

describe('findLiteLLMModelDisplaySpec matching', () => {
  it('follows the flag of the spec in use', () => {
    expect(isLiteLLMModelDisplayEnabled(modelSpecs, { spec: 'litellm-model-router' })).toBe(true);
    expect(isLiteLLMModelDisplayEnabled(modelSpecs, { spec: 'claude-sonnet' })).toBe(false);
    expect(isLiteLLMModelDisplayEnabled(modelSpecs, { spec: 'claude-opus' })).toBe(false);
    expect(isLiteLLMModelDisplayEnabled(modelSpecs, { spec: 'missing' })).toBe(false);
  });

  it('lets the spec in use decide even when the model matches a flagged preset', () => {
    expect(
      isLiteLLMModelDisplayEnabled(modelSpecs, {
        spec: 'claude-sonnet',
        endpoint: 'AnthropicClaude',
        model: 'litellm-model-router',
      }),
    ).toBe(false);
  });

  it('matches a specless chat to a flagged spec by its preset endpoint and model', () => {
    expect(
      isLiteLLMModelDisplayEnabled(modelSpecs, {
        endpoint: 'AnthropicClaude',
        model: 'litellm-model-router',
      }),
    ).toBe(true);
    expect(
      isLiteLLMModelDisplayEnabled(modelSpecs, {
        endpoint: 'AnthropicClaude',
        model: 'claude-sonnet-5-5',
      }),
    ).toBe(false);
    expect(
      isLiteLLMModelDisplayEnabled(modelSpecs, {
        endpoint: 'OpenAI',
        model: 'litellm-model-router',
      }),
    ).toBe(false);
  });

  it('is false with nothing to match or no spec list', () => {
    expect(isLiteLLMModelDisplayEnabled(modelSpecs, {})).toBe(false);
    expect(
      isLiteLLMModelDisplayEnabled(modelSpecs, { spec: '', endpoint: 'AnthropicClaude' }),
    ).toBe(false);
    expect(isLiteLLMModelDisplayEnabled(undefined, { spec: 'litellm-model-router' })).toBe(false);
  });
});

describe('findLiteLLMModelDisplaySpec', () => {
  it('returns the flagged spec for its name or its preset endpoint and model', () => {
    const router = modelSpecs.list[0];
    expect(findLiteLLMModelDisplaySpec(modelSpecs, { spec: 'litellm-model-router' })).toBe(router);
    expect(
      findLiteLLMModelDisplaySpec(modelSpecs, {
        endpoint: 'AnthropicClaude',
        model: 'litellm-model-router',
      }),
    ).toBe(router);
    expect(findLiteLLMModelDisplaySpec(modelSpecs, { spec: 'claude-sonnet' })).toBeUndefined();
  });
});

describe('getLiteLLMModelDisplayLabel', () => {
  const spec = {
    litellmRoutedModel: {
      labels: [
        { model: 'bedrock/us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { model: 'bedrock/us.anthropic.claude-sonnet-5' },
        { model: 'bedrock/us.anthropic.claude-opus-4-6-v1', label: '  ' },
      ],
    },
  };

  it('uses the configured label for a listed model', () => {
    expect(getLiteLLMModelDisplayLabel(spec, 'bedrock/us.anthropic.claude-haiku-5-5')).toBe(
      'Claude Haiku 5.5',
    );
  });

  it('falls back to the model name when unlisted, unlabeled, or blank', () => {
    expect(getLiteLLMModelDisplayLabel(spec, 'bedrock/other')).toBe('bedrock/other');
    expect(getLiteLLMModelDisplayLabel(spec, 'bedrock/us.anthropic.claude-sonnet-5')).toBe(
      'bedrock/us.anthropic.claude-sonnet-5',
    );
    expect(getLiteLLMModelDisplayLabel(spec, 'bedrock/us.anthropic.claude-opus-4-6-v1')).toBe(
      'bedrock/us.anthropic.claude-opus-4-6-v1',
    );
  });

  it('falls back to the model name without a label list or spec', () => {
    expect(getLiteLLMModelDisplayLabel({}, 'bedrock/x')).toBe('bedrock/x');
    expect(
      getLiteLLMModelDisplayLabel({ litellmRoutedModel: { showOnResponses: true } }, 'bedrock/x'),
    ).toBe('bedrock/x');
    expect(getLiteLLMModelDisplayLabel(undefined, 'bedrock/x')).toBe('bedrock/x');
  });
});

describe('tModelSpecSchema litellmRoutedModel', () => {
  const base = { name: 'router', label: 'Router', preset: { endpoint: 'AnthropicClaude' } };

  it('accepts showOnResponses with label entries with or without a label', () => {
    const litellmRoutedModel = {
      showOnResponses: true,
      labels: [{ model: 'bedrock/a', label: 'A' }, { model: 'bedrock/b' }],
    };
    const parsed = tModelSpecSchema.parse({ ...base, litellmRoutedModel });
    expect(parsed.litellmRoutedModel).toEqual(litellmRoutedModel);
  });

  it('accepts either field on its own', () => {
    expect(
      tModelSpecSchema.safeParse({ ...base, litellmRoutedModel: { showOnResponses: true } })
        .success,
    ).toBe(true);
    expect(
      tModelSpecSchema.safeParse({ ...base, litellmRoutedModel: { labels: [] } }).success,
    ).toBe(true);
  });

  it('rejects a label entry without a model', () => {
    const result = tModelSpecSchema.safeParse({
      ...base,
      litellmRoutedModel: { labels: [{ label: 'A' }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean showOnResponses', () => {
    expect(
      tModelSpecSchema.safeParse({ ...base, litellmRoutedModel: { showOnResponses: 'yes' } })
        .success,
    ).toBe(false);
  });
});
