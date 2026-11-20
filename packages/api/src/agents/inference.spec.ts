import { SettingTypes } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import { resolveAgentInferenceParameters } from './inference';

type CustomParams = NonNullable<TEndpoint['customParams']>;
const custom = (paramDefinitions: CustomParams['paramDefinitions']): CustomParams => ({
  defaultParamsEndpoint: 'custom',
  paramDefinitions,
});
const resolve = (parameters: Record<string, unknown>, provider = 'openAI', model = 'test-model') =>
  resolveAgentInferenceParameters({ parameters, provider, model });

describe('resolveAgentInferenceParameters', () => {
  it('projects safe inference fields and LibreChat controls without modifying input', () => {
    const parameters = {
      temperature: '0.7',
      max_tokens: '4096',
      maxContextTokens: '32000',
      fileTokenLimit: 12000,
      resendFiles: false,
      imageDetail: 'high',
      promptPrefix: 'Be concise',
      disableStreaming: true,
      reasoning_effort: 'low',
      stop: ['END'],
    };
    expect(resolve(parameters)).toEqual({
      parameters: {
        ...parameters,
        temperature: 0.7,
        max_tokens: 4096,
        maxContextTokens: 32000,
      },
      customParameters: {},
      issues: [],
    });
    expect(parameters.temperature).toBe('0.7');
  });

  it.each(['openAI', 'openai', 'azureOpenAI', 'custom', 'some-private-endpoint'])(
    'uses the OpenAI projection for %s',
    (provider) => {
      expect(
        resolve({ topP: '0.8', maxOutputTokens: '2048', frequencyPenalty: '-1' }, provider),
      ).toEqual({
        parameters: { top_p: 0.8, max_tokens: 2048, frequency_penalty: -1 },
        customParameters: {},
        issues: [],
      });
    },
  );

  it.each(['google', 'vertexai'])(
    'uses Google enums and aliases for %s without admitting OpenAI-only fields',
    (provider) => {
      expect(
        resolve(
          {
            top_p: '0.9',
            top_k: '40',
            max_tokens: '1024',
            thinking_budget: '-1',
            thinkingLevel: 'low',
            url_context: true,
            frequency_penalty: 1,
          },
          provider,
        ),
      ).toEqual({
        parameters: {
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 1024,
          thinkingBudget: -1,
          thinkingLevel: 'low',
          url_context: true,
        },
        customParameters: {},
        issues: [{ path: ['frequency_penalty'], code: 'unsupported_parameter' }],
      });
    },
  );

  it('preserves the explicit unlimited context sentinel', () => {
    expect(resolve({ maxContextTokens: '-1', max_context_tokens: -1 }).parameters).toEqual({
      maxContextTokens: -1,
    });
    expect(resolve({ maxContextTokens: -2 }).issues).toEqual([
      { path: ['maxContextTokens'], code: 'invalid_parameter' },
    ]);
  });

  it.each(['openrouter', 'custom'])(
    'preserves OpenRouter prompt caching flags for %s',
    (provider) => {
      expect(
        resolveAgentInferenceParameters({
          parameters: { promptCache: true, promptCacheTtl: '1h' },
          provider,
          model: 'anthropic/claude',
          customParams: { defaultParamsEndpoint: 'openrouter' },
        }),
      ).toEqual({
        parameters: { promptCache: true, promptCacheTtl: '1h' },
        customParameters: {},
        issues: [],
      });
    },
  );

  it('uses the Anthropic projection and rejects invalid provider enums', () => {
    expect(
      resolve(
        {
          temperature: 0.8,
          max_tokens: 2048,
          top_p: 0.9,
          thinking: true,
          thinkingBudget: 1024,
          promptCache: true,
          promptCacheTtl: '1h',
          thinkingDisplay: 'not-a-display',
          reasoning_effort: 'low',
        },
        'anthropic',
      ),
    ).toEqual({
      parameters: {
        temperature: 0.8,
        maxOutputTokens: 2048,
        topP: 0.9,
        thinking: true,
        thinkingBudget: 1024,
        promptCache: true,
        promptCacheTtl: '1h',
      },
      customParameters: {},
      issues: [
        { path: ['thinkingDisplay'], code: 'invalid_parameter' },
        { path: ['reasoning_effort'], code: 'unsupported_parameter' },
      ],
    });
  });

  it('preserves Bedrock public controls without accepting opaque request fields', () => {
    const result = resolve(
      {
        maxOutputTokens: 4096,
        thinkingBudget: 1024,
        system: 'Answer briefly',
        region: 'us-east-1',
        additionalModelRequestFields: { arbitrary: true },
      },
      'bedrock',
      'us.anthropic.claude-sonnet',
    );
    expect(result.parameters).toEqual({
      maxTokens: 4096,
      thinkingBudget: 1024,
      system: 'Answer briefly',
      region: 'us-east-1',
    });
    expect(result.issues).toEqual([
      { path: ['additionalModelRequestFields'], code: 'unsupported_parameter' },
    ]);
    expect(resolve({ thinkingBudget: 1024 }, 'bedrock', 'amazon.nova').issues).toEqual([
      { path: ['thinkingBudget'], code: 'unsupported_parameter' },
    ]);
  });

  it('preserves safe Bedrock regions and reasoning, with server-configured region constraints', () => {
    const parameters = { region: 'us-west-2', reasoning_effort: 'low' };
    expect(resolve(parameters, 'bedrock', 'moonshot.kimi').parameters).toEqual(parameters);
    expect(
      resolveAgentInferenceParameters({
        parameters,
        provider: 'bedrock',
        model: 'moonshot.kimi',
        availableRegions: ['us-east-1'],
      }),
    ).toMatchObject({
      parameters: { reasoning_effort: 'low' },
      issues: [{ path: ['region'], code: 'invalid_parameter' }],
    });
    expect(resolve({ region: 'us-west-2@unchecked.invalid' }, 'bedrock').issues).toEqual([
      { path: ['region'], code: 'invalid_parameter' },
    ]);
  });

  it.each([
    [{ type: 'disabled' }, { thinking: false }],
    [{ type: 'between_tools' }, { thinking: false }],
    [
      { type: 'adaptive', display: 'omitted' },
      { thinking: true, thinkingDisplay: 'omitted' },
    ],
    [
      { type: 'enabled', budget_tokens: 4096 },
      { thinking: true, thinkingBudget: 4096 },
    ],
  ])('normalizes known legacy thinking %j before provider configuration', (thinking, expected) => {
    expect(resolve({ thinking }, 'anthropic', 'claude-opus-4-7')).toEqual({
      parameters: expected,
      customParameters: {},
      issues: [],
    });
    expect(
      resolve({ thinking: { ...thinking, configuration: { apiKey: 'secret' } } }, 'anthropic')
        .issues,
    ).toEqual([{ path: ['thinking'], code: 'invalid_parameter' }]);
  });

  it.each(['mistral', 'mistralai', 'mistral-compatible'])(
    'uses the narrow Mistral projection for %s',
    (provider) => {
      expect(resolve({ max_tokens: 1024, top_p: 0.8, reasoning_effort: 'low' }, provider)).toEqual({
        parameters: { maxTokens: 1024, topP: 0.8 },
        customParameters: {},
        issues: [{ path: ['reasoning_effort'], code: 'unsupported_parameter' }],
      });
    },
  );

  it('honors only recognized custom provider hints without overriding native providers', () => {
    const parameters = { thinkingBudget: 1024, max_tokens: 2048 };
    expect(
      resolveAgentInferenceParameters({
        parameters,
        provider: 'custom',
        model: 'test-model',
        customParams: { defaultParamsEndpoint: 'anthropic' },
      }).parameters,
    ).toEqual({ thinkingBudget: 1024, maxOutputTokens: 2048 });
    expect(
      resolveAgentInferenceParameters({
        parameters,
        provider: 'openAI',
        model: 'test-model',
        customParams: { defaultParamsEndpoint: 'google' },
      }).parameters,
    ).toEqual({ thinkingBudget: 1024, maxOutputTokens: 2048 });
    expect(
      resolveAgentInferenceParameters({
        parameters,
        provider: 'custom',
        model: 'test-model',
        customParams: { defaultParamsEndpoint: 'some-private-endpoint' },
      }).parameters,
    ).toEqual({ max_tokens: 2048 });
    expect(
      resolveAgentInferenceParameters({
        parameters: { thinkingBudget: -1 },
        provider: 'anthropic',
        model: 'test-model',
        customParams: { defaultParamsEndpoint: 'google' },
      }).issues,
    ).toEqual([{ path: ['thinkingBudget'], code: 'invalid_parameter' }]);
  });

  it('ignores absent and empty values while reporting each nonempty invalid field', () => {
    expect(
      resolve({
        temperature: 'placeholder-secret',
        top_p: 0,
        max_tokens: Infinity,
        fileTokenLimit: true,
        promptCache: null,
        apiKey: '',
        model: undefined,
        promptPrefix: '   ',
        imageDetail: 'not-a-detail',
        stop: ['END', { secret: 'never-echo-me' }],
      }),
    ).toEqual({
      parameters: { top_p: 0 },
      customParameters: {},
      issues: [
        { path: ['temperature'], code: 'invalid_parameter' },
        { path: ['max_tokens'], code: 'invalid_parameter' },
        { path: ['fileTokenLimit'], code: 'invalid_parameter' },
        { path: ['imageDetail'], code: 'invalid_parameter' },
        { path: ['stop'], code: 'invalid_parameter' },
      ],
    });
    expect(
      resolveAgentInferenceParameters({ parameters: null, provider: 'openAI', model: '' }),
    ).toEqual({ parameters: {}, customParameters: {}, issues: [] });
  });

  it.each([NaN, Infinity, -Infinity, {}, [], true, 'not-a-number'])(
    'rejects unsafe numeric input %p',
    (temperature) => {
      expect(resolve({ temperature, max_tokens: 10 })).toEqual({
        parameters: { max_tokens: 10 },
        customParameters: {},
        issues: [{ path: ['temperature'], code: 'invalid_parameter' }],
      });
    },
  );

  it('rejects out-of-range values and retains valid siblings', () => {
    expect(
      resolve({ temperature: 3, top_p: -1, max_tokens: 0.5, frequency_penalty: -1.5 }),
    ).toEqual({
      parameters: { frequency_penalty: -1.5 },
      customParameters: {},
      issues: [
        { path: ['temperature'], code: 'invalid_parameter' },
        { path: ['top_p'], code: 'invalid_parameter' },
        { path: ['max_tokens'], code: 'invalid_parameter' },
      ],
    });
  });

  it('keeps canonical values over aliases regardless of input order', () => {
    expect(resolve({ topP: 0.2, top_p: 0.8 }).parameters).toEqual({ top_p: 0.8 });
    expect(resolve({ top_p: 0.8, topP: 0.2 }).parameters).toEqual({ top_p: 0.8 });
    expect(resolve({ stopSequences: ['END'], reasoningEffort: 'low' }).parameters).toEqual({
      stop: ['END'],
      reasoning_effort: 'low',
    });
  });

  it('returns only declared, positively allowed, typed custom inference fields separately', () => {
    const result = resolveAgentInferenceParameters({
      provider: 'custom',
      model: 'test-model',
      parameters: {
        temperature: 0.5,
        seed: '42',
        do_sample: false,
        reasoning_format: 'hidden',
        samplers: ['top_k', 'top_p'],
        include_reasoning: true,
        min_p: 0.1,
      },
      customParams: custom([
        { key: 'seed', type: SettingTypes.Number, range: { min: 0, max: 100 } },
        { key: 'do_sample', type: SettingTypes.Boolean },
        { key: 'reasoning_format', type: SettingTypes.Enum, options: ['hidden', 'raw'] },
        { key: 'samplers', type: SettingTypes.Array, minTags: 1, maxTags: 3 },
        { key: 'include_reasoning', type: SettingTypes.Boolean },
      ]),
    });
    expect(result).toEqual({
      parameters: { temperature: 0.5 },
      customParameters: {
        seed: 42,
        do_sample: false,
        reasoning_format: 'hidden',
        samplers: ['top_k', 'top_p'],
        include_reasoning: true,
      },
      issues: [{ path: ['min_p'], code: 'unsupported_parameter' }],
    });
  });

  it('accepts future admin-declared flat extras without a hardcoded sampling-key list', () => {
    expect(
      resolveAgentInferenceParameters({
        provider: 'custom',
        model: 'test-model',
        parameters: { foo_generation_mode: 'fast', undeclared_generation_mode: 'fast' },
        customParams: custom([
          { key: 'foo_generation_mode', type: SettingTypes.Enum, options: ['fast', 'accurate'] },
        ]),
      }),
    ).toEqual({
      parameters: {},
      customParameters: { foo_generation_mode: 'fast' },
      issues: [{ path: ['undeclared_generation_mode'], code: 'unsupported_parameter' }],
    });
  });

  it('intersects builtin validation with admin ranges and enum options through aliases', () => {
    const customParams = custom([
      { key: 'temperature', type: SettingTypes.Number, range: { min: 0, max: 0.5 } },
      { key: 'top_p', type: SettingTypes.Number, range: { min: 0, max: 0.5 } },
      { key: 'reasoning_effort', type: SettingTypes.String, options: ['low'] },
      { key: 'max_tokens', range: { min: 10, max: 100 } },
    ]);
    expect(
      resolveAgentInferenceParameters({
        provider: 'openAI',
        model: 'test-model',
        customParams,
        parameters: { temperature: 0.8, topP: 0.8, reasoningEffort: 'high', maxOutputTokens: 5 },
      }).issues,
    ).toEqual([
      { path: ['temperature'], code: 'invalid_parameter' },
      { path: ['topP'], code: 'invalid_parameter' },
      { path: ['reasoningEffort'], code: 'invalid_parameter' },
      { path: ['maxOutputTokens'], code: 'invalid_parameter' },
    ]);
    expect(
      resolveAgentInferenceParameters({
        provider: 'openAI',
        model: 'test-model',
        customParams,
        parameters: { temperature: 0.4, topP: 0.4, reasoningEffort: 'low', maxOutputTokens: 50 },
      }),
    ).toEqual({
      parameters: { temperature: 0.4, top_p: 0.4, reasoning_effort: 'low', max_tokens: 50 },
      customParameters: {},
      issues: [],
    });
    expect(
      resolveAgentInferenceParameters({
        provider: 'openAI',
        model: 'test-model',
        parameters: { temperature: 3, reasoning_effort: 'invented' },
        customParams: custom([
          { key: 'temperature', type: SettingTypes.Number, range: { min: 0, max: 100 } },
          { key: 'reasoning_effort', type: SettingTypes.Enum, options: ['invented'] },
        ]),
      }).issues,
    ).toEqual([
      { path: ['temperature'], code: 'invalid_parameter' },
      { path: ['reasoning_effort'], code: 'invalid_parameter' },
    ]);
  });

  it('enforces custom ranges, enum membership, string limits, and scalar array elements', () => {
    expect(
      resolveAgentInferenceParameters({
        provider: 'custom',
        model: 'test-model',
        parameters: {
          seed: 101,
          do_sample: 'true',
          reasoning_format: 'other',
          samplers: [{ apiKey: 'never-echo' }],
          include_reasoning: true,
          mirostat: 'toolong',
          stop_token_ids: [1, 2],
        },
        customParams: custom([
          { key: 'seed', type: SettingTypes.Number, range: { min: 0, max: 100 } },
          { key: 'do_sample', type: SettingTypes.Boolean },
          { key: 'reasoning_format', type: SettingTypes.Enum, options: ['hidden'] },
          { key: 'samplers', type: SettingTypes.Array, maxTags: 2 },
          { key: 'include_reasoning', type: SettingTypes.Boolean },
          { key: 'mirostat', type: SettingTypes.String, minText: 1, maxText: 3 },
          { key: 'stop_token_ids', type: SettingTypes.Array, minTags: 1, maxTags: 4 },
        ]),
      }),
    ).toEqual({
      parameters: {},
      customParameters: { include_reasoning: true, stop_token_ids: [1, 2] },
      issues: [
        { path: ['seed'], code: 'invalid_parameter' },
        { path: ['do_sample'], code: 'invalid_parameter' },
        { path: ['reasoning_format'], code: 'invalid_parameter' },
        { path: ['samplers'], code: 'invalid_parameter' },
        { path: ['mirostat'], code: 'invalid_parameter' },
      ],
    });
  });

  it('does not synthesize custom defaults or allow declarations to widen builtin fields', () => {
    expect(
      resolveAgentInferenceParameters({
        provider: 'openAI',
        model: 'test-model',
        parameters: { temperature: 'high', thinkingBudget: 1024 },
        customParams: custom([
          { key: 'temperature', type: SettingTypes.String },
          { key: 'thinkingBudget', type: SettingTypes.Number },
          { key: 'seed', type: SettingTypes.Number, default: 42 },
        ]),
      }),
    ).toEqual({
      parameters: {},
      customParameters: {},
      issues: [
        { path: ['temperature'], code: 'invalid_parameter' },
        { path: ['thinkingBudget'], code: 'unsupported_parameter' },
      ],
    });
  });

  it.each([
    'model',
    'modelName',
    'models',
    'route',
    'fallbacks',
    'fallbackClient',
    'modelId',
    'timeoutMs',
    'abortSignal',
    'transport',
    'azureOpenAIApiKey',
    'modelKwargs',
    'configuration',
    'apiKey',
    'baseURL',
    'baseUrl',
    'user',
    'userId',
    'tools',
    'tool_choice',
    'toolChoice',
    'input',
    'contents',
    'prompt',
    'title',
    'modelLabel',
    'createdAt',
    'greeting',
    'default_headers',
    'fallback',
    'provider',
    'providers',
    'callback',
    'request_options',
    'callbacks',
    'timeout',
    'retries',
    'maxRetries',
    'signal',
    'fetch',
    'tags',
    'metadata',
    'client',
    'clientOptions',
    'httpAgent',
    'headers',
    'defaultHeaders',
    'endpoint',
    'conversationId',
    'messages',
    'presetOverride',
    'additionalModelRequestFields',
    'reasoning',
    'thinkingConfig',
    'response_format',
    '__proto__',
    'constructor',
    'prototype',
  ])('cannot custom-declare control or opaque field %s', (key) => {
    const result = resolveAgentInferenceParameters({
      provider: 'custom',
      model: 'test-model',
      parameters: { [key]: 'never-echo-this-value', temperature: 0.5 },
      customParams: custom([{ key, type: SettingTypes.String }]),
    });
    expect(result).toEqual({
      parameters: { temperature: 0.5 },
      customParameters: {},
      issues: [{ path: [key], code: 'unsupported_parameter' }],
    });
    expect(JSON.stringify(result)).not.toContain('never-echo-this-value');
  });
});
