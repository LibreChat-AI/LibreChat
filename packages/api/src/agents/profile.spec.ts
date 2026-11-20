import yaml from 'js-yaml';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Providers, initializeModel, addTailCacheControl } from '@librechat/agents';
import {
  endpointSchema,
  extractEnvVariable,
  EModelEndpoint,
  ReasoningParameterFormat,
  SettingTypes,
  ComponentTypes,
  EImageOutputType,
  FileSources,
} from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { loadCustomEndpointsConfig, usesOpenRouterCatalog } from '../endpoints/custom/config';
import { getAgentInferencePolicy, parseAgentInferenceInput } from './input';
import { initializeCustom } from '../endpoints/custom/initialize';
import { resolveAgentInferenceParameters } from './inference';
import { getOpenAIConfig } from '../endpoints/openai/config';
import { createCustomConfigLoader } from '../app/loader';

const variable = 'TEST_INFERENCE_GATEWAY_URL';
const original = process.env[variable];
const endpoint = (options: Partial<TEndpoint> = {}) => ({
  name: 'Gateway',
  apiKey: 'synthetic-key',
  baseURL: '${TEST_INFERENCE_GATEWAY_URL}',
  models: { default: ['permitted'], fetch: false },
  ...options,
});

afterEach(() => {
  if (original === undefined) delete process.env[variable];
  else process.env[variable] = original;
});

describe('trusted inference profile consistency', () => {
  it.each([undefined, { defaultParamsEndpoint: 'custom' }])(
    'resolves the configured URL before discovery, write validation, and runtime projection',
    async (customParams) => {
      process.env[variable] = 'https://openrouter.ai/api/v1';
      const text = yaml.dump({
        version: '1.3.17',
        endpoints: { custom: [endpoint({ customParams })] },
      });
      const config = await createCustomConfigLoader({
        defaultConfigPath: 'inference-profile.yaml',
        loadLocal: () => text,
        redactConfig: (value) => value,
      })(false);
      const loaded = endpointSchema.parse(config?.endpoints?.custom?.[0]);
      const appConfig = { endpoints: { custom: [loaded] } };
      const advertised = loadCustomEndpointsConfig([loaded])?.Gateway;
      const policy = getAgentInferencePolicy('Gateway', appConfig);
      expect(policy.customParams).toEqual(advertised?.customParams);
      expect(policy.customParams?.defaultParamsEndpoint).toBe('openrouter');
      const values = { promptCache: false, promptCacheTtl: '1h' };
      const parameters = parseAgentInferenceInput({
        provider: 'Gateway',
        model: 'permitted',
        parameters: values,
        appConfig,
      });
      expect(parameters).toEqual(values);
      const runtime = resolveAgentInferenceParameters({
        ...getAgentInferencePolicy('Gateway', appConfig, loaded),
        model: 'permitted',
        parameters: values,
      });
      expect(runtime.parameters).toEqual(values);
      const { llmConfig, configOptions, provider } = getOpenAIConfig(
        'synthetic-key',
        {
          reverseProxyUrl: extractEnvVariable(loaded.baseURL),
          customParams: loaded.customParams,
          modelOptions: { ...runtime.parameters, model: 'permitted' },
        },
        'Gateway',
      );
      expect(llmConfig.promptCache).not.toBe(true);
      const bodies: Record<string, unknown>[] = [];
      const client = initializeModel({
        provider: provider ?? Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          streaming: false,
          configuration: {
            ...configOptions,
            fetch: async (_url: unknown, init: { body?: unknown } | undefined) => {
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({
                id: 'chatcmpl-cache',
                object: 'chat.completion',
                created: 1,
                model: 'permitted',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
            },
          },
        },
      });
      await client.invoke('hello');
      expect(bodies).toHaveLength(1);
      expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
      expect(llmConfig).not.toHaveProperty('promptCacheTtl');
      expect(loaded.baseURL).toBe('${TEST_INFERENCE_GATEWAY_URL}');
      expect(loaded.customParams?.defaultParamsEndpoint).not.toBe('openrouter');
    },
  );

  it.each([
    { customParams: { defaultParamsEndpoint: EModelEndpoint.google } },
    { provider: EModelEndpoint.anthropic as const },
  ])('preserves explicit profile and capability decisions: %j', (overrides) => {
    process.env[variable] = 'https://openrouter.ai/api/v1';
    const loaded = endpointSchema.parse(endpoint(overrides));
    const policy = getAgentInferencePolicy('Gateway', { endpoints: { custom: [loaded] } });
    expect(policy.customParams).toEqual(loadCustomEndpointsConfig([loaded])?.Gateway?.customParams);
    expect(policy.customParams?.defaultParamsEndpoint).not.toBe('openrouter');
  });

  it.each([
    'https://openrouter.ai.untrusted.invalid/v1',
    'user_provided',
    'https://gateway.invalid/v1',
  ])('does not infer a profile from untrusted or unrelated destinations: %s', (url) => {
    process.env[variable] = url;
    const loaded = endpointSchema.parse(endpoint());
    const appConfig = { endpoints: { custom: [loaded] } };
    expect(getAgentInferencePolicy('Gateway', appConfig).customParams).toBeUndefined();
    expect(() =>
      parseAgentInferenceInput({
        provider: 'Gateway',
        model: 'permitted',
        parameters: { promptCache: false, baseURL: 'https://openrouter.ai' },
        appConfig,
      }),
    ).toThrow();
  });
});

describe('OpenRouter identity is independent of reasoning capability', () => {
  const policies: Array<Partial<TEndpoint> & { name: string }> = [
    { name: 'reasoning object drop', dropParams: ['reasoning'] },
    { name: 'effort drop', dropParams: ['reasoning_effort'] },
    {
      name: 'disabled reasoning',
      customParams: {
        defaultParamsEndpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.disabled,
      },
    },
  ];
  const cases = ['literal', 'environment'].flatMap((urlKind) =>
    [undefined, 'custom', 'openrouter'].flatMap((profile) =>
      policies.flatMap((policy) =>
        [false, true].map((cache) => ({ urlKind, profile, policy, cache })),
      ),
    ),
  );

  it.each(cases)(
    '$urlKind, $profile, $policy.name, cache=$cache',
    async ({ urlKind, profile, policy, cache }) => {
      process.env[variable] = 'https://openrouter.ai/api/v1';
      const configured = endpoint({
        ...policy,
        name: 'Gateway',
        baseURL:
          urlKind === 'literal' ? 'https://openrouter.ai/api/v1' : '${TEST_INFERENCE_GATEWAY_URL}',
        customParams: {
          ...policy.customParams,
          defaultParamsEndpoint: profile ?? policy.customParams?.defaultParamsEndpoint ?? 'custom',
        },
      });
      const text = yaml.dump({ version: '1.3.17', endpoints: { custom: [configured] } });
      const config = await createCustomConfigLoader({
        defaultConfigPath: 'cache-reasoning.yaml',
        loadLocal: () => text,
        redactConfig: (value) => value,
      })(false);
      const loaded = endpointSchema.parse(config?.endpoints?.custom?.[0]);
      const appConfig = { endpoints: { custom: [loaded] } };
      const advertised = loadCustomEndpointsConfig([loaded])?.Gateway?.customParams;
      const effective = getAgentInferencePolicy('Gateway', appConfig);
      expect(effective.customParams).toEqual(advertised);
      expect(effective.customParams?.defaultParamsEndpoint).toBe('openrouter');
      expect(effective.customParams?.reasoningFormat).toBe(ReasoningParameterFormat.disabled);
      expect(usesOpenRouterCatalog(loaded, extractEnvVariable(loaded.baseURL))).toBe(false);
      const values = { promptCache: cache, promptCacheTtl: '1h' };
      expect(
        parseAgentInferenceInput({
          provider: 'Gateway',
          model: 'permitted',
          parameters: values,
          appConfig,
        }),
      ).toEqual(values);
      const projected = resolveAgentInferenceParameters({
        ...effective,
        model: 'permitted',
        parameters: { ...values, reasoning_effort: 'high' },
      });
      expect(projected.parameters).toMatchObject(values);
      const result = getOpenAIConfig(
        'synthetic-key',
        {
          reverseProxyUrl: extractEnvVariable(loaded.baseURL),
          customParams: effective.customParams,
          dropParams: loaded.dropParams,
          modelOptions: { ...projected.parameters, model: 'permitted' },
        },
        'Gateway',
      );
      expect(result.llmConfig.promptCache === true).toBe(cache);
      const bodies: Record<string, unknown>[] = [];
      const client = initializeModel({
        provider: result.provider ?? Providers.OPENAI,
        clientOptions: {
          ...result.llmConfig,
          streaming: false,
          configuration: {
            ...result.configOptions,
            fetch: async (_url: unknown, init: { body?: unknown } | undefined) => {
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({
                id: 'chatcmpl-policy',
                object: 'chat.completion',
                created: 1,
                model: 'permitted',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
            },
          },
        },
      });
      const messages = [new SystemMessage('Synthetic system context'), new HumanMessage('hello')];
      const prepared =
        result.llmConfig.promptCache === true ? addTailCacheControl(messages, '1h') : messages;
      await client.invoke(prepared);
      expect(bodies).toHaveLength(1);
      expect(JSON.stringify(bodies[0]).includes('cache_control')).toBe(cache);
      expect(bodies[0]).not.toHaveProperty('reasoning');
      expect(bodies[0]).not.toHaveProperty('reasoning_effort');
      expect(bodies[0]).not.toHaveProperty('include_reasoning');
    },
  );
});

describe('disabled reasoning owns all legacy wire aliases', () => {
  it.each([false, true])(
    'suppresses a declared legacy opt-in while retaining cache=%s',
    async (cache) => {
      const configured = endpoint({
        baseURL: 'https://openrouter.ai/api/v1',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          reasoningFormat: ReasoningParameterFormat.disabled,
          paramDefinitions: [
            {
              key: 'include_reasoning',
              type: SettingTypes.Boolean,
              component: ComponentTypes.Checkbox,
              default: false,
            },
          ],
        },
      });
      const text = yaml.dump({ version: '1.3.17', endpoints: { custom: [configured] } });
      const config = await createCustomConfigLoader({
        defaultConfigPath: 'legacy-reasoning.yaml',
        loadLocal: () => text,
        redactConfig: (value) => value,
      })(false);
      const loaded = endpointSchema.parse(config?.endpoints?.custom?.[0]);
      const appConfig = { endpoints: { custom: [loaded] } };
      const policy = getAgentInferencePolicy('Gateway', appConfig);
      const input = parseAgentInferenceInput({
        provider: 'Gateway',
        model: 'permitted',
        appConfig,
        parameters: { promptCache: cache, include_reasoning: true },
      });
      const projected = resolveAgentInferenceParameters({
        ...policy,
        model: 'permitted',
        parameters: input,
      });
      expect(projected.customParameters).toEqual({ include_reasoning: true });
      const result = getOpenAIConfig(
        'synthetic-key',
        {
          reverseProxyUrl: loaded.baseURL,
          customParams: policy.customParams,
          modelOptions: { ...projected.parameters, model: 'permitted' },
          inferenceParameters: projected.customParameters,
        },
        'Gateway',
      );
      const bodies: Record<string, unknown>[] = [];
      const client = initializeModel({
        provider: result.provider ?? Providers.OPENAI,
        clientOptions: {
          ...result.llmConfig,
          streaming: false,
          configuration: {
            ...result.configOptions,
            fetch: async (_url: unknown, init: { body?: unknown } | undefined) => {
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({
                id: 'chatcmpl-legacy-flag',
                object: 'chat.completion',
                created: 1,
                model: 'permitted',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
            },
          },
        },
      });
      const messages = [new SystemMessage('Synthetic system context'), new HumanMessage('hello')];
      await client.invoke(cache ? addTailCacheControl(messages, '1h') : messages);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('include_reasoning');
      expect(bodies[0]).not.toHaveProperty('reasoning');
      expect(bodies[0]).not.toHaveProperty('reasoning_effort');
      expect(JSON.stringify(bodies[0]).includes('cache_control')).toBe(cache);
    },
  );
});

describe('enabled generic inference extensions', () => {
  it('preserves a declared legacy opt-in when reasoning is not disabled', async () => {
    const configured = endpointSchema.parse(
      endpoint({
        baseURL: 'https://gateway.invalid/v1',
        customParams: {
          defaultParamsEndpoint: 'custom',
          reasoningFormat: ReasoningParameterFormat.reasoningEffort,
          paramDefinitions: [
            {
              key: 'include_reasoning',
              type: SettingTypes.Boolean,
              component: ComponentTypes.Checkbox,
            },
          ],
        },
      }),
    );
    const appConfig: AppConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: EImageOutputType.PNG,
      endpoints: { custom: [configured] },
    };
    const values = parseAgentInferenceInput({
      provider: 'Gateway',
      model: 'permitted',
      appConfig,
      parameters: { include_reasoning: true },
    });
    const projected = resolveAgentInferenceParameters({
      ...getAgentInferencePolicy('Gateway', appConfig),
      model: 'permitted',
      parameters: values,
    });
    const result = await initializeCustom({
      runtime: { appConfig, requestBody: {} },
      endpoint: 'Gateway',
      model_parameters: { ...projected.parameters, model: 'permitted' },
      inferenceParameters: projected.customParameters,
      db: {
        getUserKey: jest.fn().mockResolvedValue(''),
        getUserKeyValues: jest.fn().mockResolvedValue({}),
      },
    });
    expect(result.llmConfig).toMatchObject({ modelKwargs: { include_reasoning: true } });
    expect(configured.customParams?.reasoningFormat).toBe(ReasoningParameterFormat.reasoningEffort);
  });
});

describe('production custom initialization owns the effective inference profile', () => {
  const cases = [
    {
      name: 'OpenRouter reasoning drop',
      url: 'https://openrouter.ai/api/v1',
      dropParams: ['reasoning'],
    },
    {
      name: 'OpenRouter effort drop',
      url: 'https://openrouter.ai/api/v1',
      dropParams: ['reasoning_effort'],
    },
    ...['custom', 'openrouter', 'google', 'anthropic'].map((profile) => ({
      name: `explicit disabled ${profile}`,
      url: profile === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://gateway.invalid/v1',
      customParams: {
        defaultParamsEndpoint: profile,
        reasoningFormat: ReasoningParameterFormat.disabled,
      },
    })),
  ];

  it.each(
    ['literal', 'environment'].flatMap((urlKind) => cases.map((policy) => ({ urlKind, policy }))),
  )(
    '$urlKind, $policy.name applies the same policy through initializeCustom and SDK construction',
    async ({ urlKind, policy }) => {
      process.env[variable] = policy.url;
      const configured = endpoint({
        baseURL: urlKind === 'literal' ? policy.url : '${TEST_INFERENCE_GATEWAY_URL}',
        ...('dropParams' in policy ? { dropParams: policy.dropParams } : {}),
        customParams: {
          ...('customParams' in policy ? policy.customParams : { defaultParamsEndpoint: 'custom' }),
          paramDefinitions: [
            {
              key: 'include_reasoning',
              type: SettingTypes.Boolean,
              component: ComponentTypes.Checkbox,
              default: false,
            },
          ],
        },
      });
      const text = yaml.dump({ version: '1.3.17', endpoints: { custom: [configured] } });
      const config = await createCustomConfigLoader({
        defaultConfigPath: 'production-profile.yaml',
        loadLocal: () => text,
        redactConfig: (value) => value,
      })(false);
      const loaded = endpointSchema.parse(config?.endpoints?.custom?.[0]);
      const appConfig: AppConfig = {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: EImageOutputType.PNG,
        endpoints: { custom: [loaded] },
      };
      const effective = getAgentInferencePolicy('Gateway', appConfig);
      expect(effective.customParams?.reasoningFormat).toBe(ReasoningParameterFormat.disabled);
      const hasCacheProfile = effective.customParams?.defaultParamsEndpoint === 'openrouter';
      const supplied = {
        ...(hasCacheProfile ? { promptCache: false, promptCacheTtl: '1h' } : {}),
        include_reasoning: true,
      };
      const parsed = parseAgentInferenceInput({
        provider: 'Gateway',
        model: 'permitted',
        parameters: supplied,
        appConfig,
      });
      const projected = resolveAgentInferenceParameters({
        ...effective,
        model: 'permitted',
        parameters: parsed,
      });
      const db = {
        getUserKey: jest.fn().mockResolvedValue(''),
        getUserKeyValues: jest.fn().mockResolvedValue({}),
      };
      const result = await initializeCustom({
        runtime: { appConfig, requestBody: {} },
        endpoint: 'Gateway',
        db,
        model_parameters: { ...projected.parameters, model: 'permitted' },
        inferenceParameters: projected.customParameters,
      });
      expect(db.getUserKeyValues).not.toHaveBeenCalled();
      if (hasCacheProfile) {
        expect(result.llmConfig).not.toHaveProperty('promptCache', true);
      }
      const bodies: Record<string, unknown>[] = [];
      const client = initializeModel({
        provider: result.provider ?? Providers.OPENAI,
        clientOptions: {
          ...result.llmConfig,
          streaming: false,
          configuration: {
            ...result.configOptions,
            fetch: async (_url: unknown, init: { body?: unknown } | undefined) => {
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({
                id: 'chatcmpl-real-initializer',
                object: 'chat.completion',
                created: 1,
                model: 'permitted',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              });
            },
          },
        },
      });
      await client.invoke('hello');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('reasoning');
      expect(bodies[0]).not.toHaveProperty('reasoning_effort');
      expect(bodies[0]).not.toHaveProperty('include_reasoning');
      expect(JSON.stringify(bodies[0])).not.toContain('apiKey');
      expect(loaded.customParams).toEqual(config?.endpoints?.custom?.[0].customParams);
    },
  );
});
