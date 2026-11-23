import { Providers, initializeModel } from '@librechat/agents';
import {
  THINKING_BLOCK_BINDING,
  THINKING_BINDING_BETA,
  ThinkingDisplay,
  SettingTypes,
  bedrockInputParser,
  bedrockOutputParser,
} from 'librechat-data-provider';
import type { Agent, TEndpoint } from 'librechat-data-provider';
import type { OpenAIConfigOptions, OpenAIConfiguration } from '~/types';
import {
  resolveAgentInferenceParameters,
  restoreAgentInferenceInput,
  retainAgentInferenceInput,
} from './inference';
import { getLLMConfig as getAnthropicLLMConfig } from '~/endpoints/anthropic/llm';
import { getOpenAIConfig } from '~/endpoints/openai/config';

const inferenceParameters = { foo_generation_mode: 'fast', min_p: 0.2, seed: 7 };
const paramDefinitions = [
  {
    key: 'foo_generation_mode',
    type: SettingTypes.Enum,
    default: 'accurate',
    options: ['fast', 'accurate'],
  },
  { key: 'min_p', type: SettingTypes.Number, default: 0.1 },
  { key: 'seed', type: SettingTypes.Number, default: 2 },
];

const wireCases: Array<{
  name: string;
  extras: Record<string, unknown>;
  addParams?: Record<string, unknown>;
  expectedMode: string;
  expectedSeed: number;
}> = [
  {
    name: 'explicit beats default and min_p drop wins',
    extras: inferenceParameters,
    expectedMode: 'fast',
    expectedSeed: 7,
  },
  {
    name: 'missing values use defaults and min_p drop wins',
    extras: {},
    expectedMode: 'accurate',
    expectedSeed: 2,
  },
  {
    name: 'admin add beats explicit and last min_p drop wins',
    extras: inferenceParameters,
    addParams: { foo_generation_mode: 'admin', min_p: 0.9, seed: 9 },
    expectedMode: 'admin',
    expectedSeed: 9,
  },
];

const customSettings = (defaultParamsEndpoint: string): NonNullable<TEndpoint['customParams']> => ({
  defaultParamsEndpoint,
  paramDefinitions,
});

function options(defaultParamsEndpoint: string): OpenAIConfigOptions {
  return {
    streaming: false,
    reverseProxyUrl: 'https://gateway.example/v1',
    modelOptions: { model: 'test-model' },
    inferenceParameters,
    customParams: customSettings(defaultParamsEndpoint),
    dropParams: ['min_p'],
  };
}

describe('canonical runtime inference provenance', () => {
  const makeAgent = (modelParameters: Record<string, unknown>): Agent => ({
    id: 'agent_runtime_input',
    name: 'Runtime input',
    description: null,
    created_at: 0,
    avatar: null,
    model: 'test-model',
    provider: 'openAI',
    model_parameters: modelParameters as Agent['model_parameters'],
  });

  it.each(['custom', 'anthropic', 'google'])(
    'retains explicit extensions through repeated real-adapter reentry (%s)',
    (mode) => {
      let agent = makeAgent({ min_p: 0.7, temperature: 0.4 });
      agent.provider = 'Gateway';
      for (let attempt = 0; attempt < 3; attempt++) {
        const canonical = restoreAgentInferenceInput(agent);
        expect(canonical.provider).toBe('Gateway');
        const projected = resolveAgentInferenceParameters({
          provider: canonical.provider,
          model: canonical.model ?? '',
          parameters: canonical.model_parameters,
          customParams: customSettings(mode),
        });
        expect(projected.customParameters).toEqual({ min_p: 0.7 });
        const configured = getOpenAIConfig(
          'test-key',
          {
            ...options(mode),
            dropParams: undefined,
            modelOptions: { ...projected.parameters, model: 'test-model' },
            inferenceParameters: projected.customParameters,
          },
          'Gateway',
        );
        agent = {
          ...canonical,
          provider: Providers.OPENAI,
          model_parameters: configured.llmConfig as Agent['model_parameters'],
        };
        retainAgentInferenceInput(agent, 'Gateway', {
          ...projected.parameters,
          ...projected.customParameters,
        });
        expect(agent.model_parameters).toMatchObject({ modelKwargs: { min_p: 0.7 } });
      }
      const restricted = resolveAgentInferenceParameters({
        provider: 'Gateway',
        model: 'test-model',
        parameters: restoreAgentInferenceInput(agent).model_parameters,
        customParams: {
          defaultParamsEndpoint: mode,
          paramDefinitions: [
            { key: 'min_p', type: SettingTypes.Number, range: { min: 0, max: 0.5 } },
          ],
        },
      });
      expect(restricted.customParameters).toEqual({});
      expect(restricted.issues).toContainEqual({ path: ['min_p'], code: 'invalid_parameter' });
    },
  );

  it('retains flat extensions when the native adapter emits invocation kwargs', () => {
    let agent = makeAgent({ min_p: 0.7, thinking: false });
    agent.provider = 'NativeGateway';
    agent.model = 'claude-3-5-sonnet-20241022';
    for (let attempt = 0; attempt < 3; attempt++) {
      const canonical = restoreAgentInferenceInput(agent);
      expect(canonical.provider).toBe('NativeGateway');
      const projected = resolveAgentInferenceParameters({
        provider: 'anthropic',
        model: canonical.model ?? '',
        parameters: canonical.model_parameters,
        customParams: customSettings('anthropic'),
      });
      expect(projected.customParameters).toEqual({ min_p: 0.7 });
      const configured = getAnthropicLLMConfig('test-key', {
        modelOptions: { ...projected.parameters, model: canonical.model ?? '' },
        inferenceParameters: projected.customParameters,
        defaultParams: { min_p: 0.1 },
      });
      agent = {
        ...canonical,
        provider: Providers.ANTHROPIC,
        model_parameters: configured.llmConfig as Agent['model_parameters'],
      };
      retainAgentInferenceInput(agent, 'NativeGateway', {
        ...projected.parameters,
        ...projected.customParameters,
      });
      expect(agent.model_parameters).toMatchObject({ invocationKwargs: { min_p: 0.7 } });
    }
  });

  it('does not trust JSON input, caller replacements, or copied lookalike provenance', () => {
    const runtime = makeAgent({ modelKwargs: { min_p: 0.9 } });
    retainAgentInferenceInput(runtime, 'Gateway', { min_p: 0.7 });
    const copy = { ...runtime };
    expect(restoreAgentInferenceInput(copy).model_parameters).toEqual({ min_p: 0.7 });
    const external = JSON.parse(JSON.stringify(runtime));
    expect(restoreAgentInferenceInput(external)).toBe(external);
    expect(
      resolveAgentInferenceParameters({
        parameters: external.model_parameters,
        provider: 'Gateway',
        model: 'test-model',
        customParams: customSettings('custom'),
      }).customParameters,
    ).toEqual({});
    const replacement = {
      ...runtime,
      model_parameters: makeAgent({ min_p: 0.3 }).model_parameters,
    };
    expect(restoreAgentInferenceInput(replacement)).toBe(replacement);
    const retargeted = { ...runtime, provider: 'google' };
    expect(restoreAgentInferenceInput(retargeted)).toBe(retargeted);
    const lookalike = makeAgent({ modelKwargs: { min_p: 0.9 } });
    Object.assign(lookalike, {
      agentInferenceSource: { provider: 'Gateway', parameters: { min_p: 0.7 } },
    });
    expect(restoreAgentInferenceInput(lookalike)).toBe(lookalike);
  });
});

describe('legacy Bedrock inference preferences', () => {
  it.each([
    ['us.anthropic.claude-sonnet-5', { type: 'disabled' }, 'disabled'],
    ['us.anthropic.claude-sonnet-5-5', { type: 'between_tools' }, 'between_tools'],
    [
      'us.anthropic.claude-opus-5-5',
      { type: 'adaptive', display: 'omitted', block_binding: THINKING_BLOCK_BINDING },
      'adaptive',
    ],
    ['us.anthropic.claude-3-7-sonnet', { type: 'enabled', budget_tokens: 4096 }, 'enabled'],
  ])(
    'recovers only known preferences from a legacy record for %s',
    (model, thinking, expectedType) => {
      const parameters = {
        additionalModelRequestFields: {
          thinking,
          output_config: { effort: 'low' },
          apiKey: 'untrusted',
          model: 'restricted',
          configuration: { baseURL: 'https://unchecked.invalid' },
        },
      };
      const projected = resolveAgentInferenceParameters({ provider: 'bedrock', model, parameters });
      expect(projected.parameters.thinking).toBe(
        !['disabled', 'between_tools'].includes(expectedType),
      );
      expect(projected.parameters).not.toHaveProperty('additionalModelRequestFields');
      expect(projected.parameters).not.toHaveProperty('apiKey');
      expect(projected.parameters).not.toHaveProperty('configuration');
      expect(projected.issues).toEqual([
        { path: ['additionalModelRequestFields'], code: 'unsupported_parameter' },
      ]);
      const configured = bedrockOutputParser(
        bedrockInputParser.parse({ ...projected.parameters, model }),
      );
      expect(configured.additionalModelRequestFields).toMatchObject({
        thinking: { type: expectedType },
      });
      expect(JSON.stringify(configured)).not.toContain('untrusted');
      if (expectedType === 'adaptive') {
        expect(configured.additionalModelRequestFields).toMatchObject({
          thinking: { display: 'omitted', block_binding: THINKING_BLOCK_BINDING },
          output_config: { effort: 'low' },
        });
      }
      if (expectedType === 'enabled') {
        expect(configured.additionalModelRequestFields).toMatchObject({
          thinking: { budget_tokens: 4096 },
        });
      }
    },
  );

  it('keeps flat preferences authoritative and drops malformed nested values', () => {
    const projected = resolveAgentInferenceParameters({
      provider: 'bedrock',
      model: 'us.anthropic.claude-sonnet-5',
      parameters: {
        thinking: false,
        effort: 'medium',
        additionalModelRequestFields: {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'low' },
        },
      },
    });
    expect(projected.parameters).toMatchObject({ thinking: false, effort: 'medium' });
    expect(
      resolveAgentInferenceParameters({
        provider: 'bedrock',
        model: 'us.anthropic.claude-sonnet-5',
        parameters: {
          additionalModelRequestFields: {
            thinking: { type: 'disabled', unknownControl: true },
            output_config: { effort: 'invalid' },
          },
        },
      }).parameters,
    ).toEqual({});
  });

  it('recovers a recognized non-Anthropic reasoning preference without forwarding its envelope', () => {
    const projected = resolveAgentInferenceParameters({
      provider: 'bedrock',
      model: 'moonshot.kimi',
      parameters: {
        additionalModelRequestFields: {
          reasoning_config: 'low',
          configuration: { apiKey: 'untrusted' },
        },
      },
    });
    expect(projected.parameters).toEqual({ reasoning_effort: 'low' });
    const configured = bedrockOutputParser(
      bedrockInputParser.parse({ ...projected.parameters, model: 'moonshot.kimi' }),
    );
    expect(configured.additionalModelRequestFields).toEqual({ reasoning_config: 'low' });
  });
});

describe('inference transition invariants', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-7'])(
    'preserves the generated thinking preference across repeated initialization for %s',
    (model) => {
      let resolved = getAnthropicLLMConfig('test-key', {
        modelOptions: { model, thinking: true, thinkingDisplay: ThinkingDisplay.omitted },
      }).llmConfig;
      const initialThinking = structuredClone(resolved.thinking);
      for (let attempt = 0; attempt < 3; attempt++) {
        const projected = resolveAgentInferenceParameters({
          provider: 'anthropic',
          model,
          parameters: resolved,
        });
        expect(projected.issues).not.toContainEqual({
          path: ['thinking'],
          code: 'invalid_parameter',
        });
        expect(projected.parameters.thinkingDisplay).toBe('omitted');
        expect(projected.parameters).not.toHaveProperty('block_binding');
        expect(projected.parameters).not.toHaveProperty('apiKey');
        expect(projected.parameters).not.toHaveProperty('clientOptions');
        resolved = getAnthropicLLMConfig('test-key', {
          modelOptions: { ...projected.parameters, model },
        }).llmConfig;
        expect(resolved.thinking).toEqual(initialThinking);
      }
    },
  );

  it('regenerates a known binding for the current model instead of forwarding it', () => {
    const projected = resolveAgentInferenceParameters({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      parameters: {
        thinking: { type: 'adaptive', display: 'omitted', block_binding: THINKING_BLOCK_BINDING },
      },
    });
    expect(projected).toEqual({
      parameters: { thinking: true, thinkingDisplay: 'omitted' },
      customParameters: {},
      issues: [],
    });
    const { llmConfig } = getAnthropicLLMConfig('test-key', {
      modelOptions: { ...projected.parameters, model: 'claude-opus-4-7' },
    });
    expect(llmConfig.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(llmConfig.clientOptions?.defaultHeaders).toHaveProperty(
      'anthropic-beta',
      expect.not.stringContaining(THINKING_BINDING_BETA),
    );
  });

  it.each([
    { prefix_mismatch_behavior: 'keep_block' },
    { prefix_mismatch_behavior: 'drop_block', configuration: { apiKey: 'untrusted' } },
  ])('rejects an unrecognized binding %j', (block_binding) => {
    expect(
      resolveAgentInferenceParameters({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        parameters: { thinking: { type: 'adaptive', display: 'omitted', block_binding } },
      }).issues,
    ).toEqual([{ path: ['thinking'], code: 'invalid_parameter' }]);
  });
});

describe('validated inference extension adapter seam', () => {
  it.each(['custom', 'anthropic', 'google'])(
    'applies explicit extras before defaults and drops in %s mode',
    (mode) => {
      const result = getOpenAIConfig('test-key', options(mode), 'gateway');
      expect(result.llmConfig.modelKwargs).toMatchObject({ foo_generation_mode: 'fast', seed: 7 });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('min_p');
      expect(result.llmConfig).not.toHaveProperty('foo_generation_mode');
      expect(result.llmConfig).not.toHaveProperty('inferenceParameters');
      expect(inferenceParameters).toEqual({ foo_generation_mode: 'fast', min_p: 0.2, seed: 7 });
    },
  );

  it.each(['custom', 'anthropic', 'google'])(
    'fills only missing extras and lets admin additions win in %s mode',
    (mode) => {
      const defaults = getOpenAIConfig(
        'test-key',
        { ...options(mode), inferenceParameters: {} },
        'gateway',
      );
      expect(defaults.llmConfig.modelKwargs).toMatchObject({ foo_generation_mode: 'accurate' });
      const result = getOpenAIConfig(
        'test-key',
        {
          ...options(mode),
          addParams: { foo_generation_mode: 'admin', min_p: 0.9, seed: 9 },
        },
        'gateway',
      );
      expect(result.llmConfig.modelKwargs).toMatchObject({ foo_generation_mode: 'admin' });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('min_p');
      expect(
        result.llmConfig.modelKwargs?.seed ??
          (result.llmConfig as unknown as Record<string, unknown>).seed,
      ).toBe(9);
    },
  );

  it('does not accept raw model kwargs but preserves trusted admin wire kwargs', () => {
    const result = getOpenAIConfig(
      'test-key',
      {
        ...options('custom'),
        modelOptions: {
          model: 'test-model',
          modelKwargs: { untrusted: true },
        } as OpenAIConfigOptions['modelOptions'],
        addParams: { modelKwargs: { server_field: 'configured' } },
      },
      'gateway',
    );
    expect(result.llmConfig.modelKwargs).toMatchObject({
      foo_generation_mode: 'fast',
      server_field: 'configured',
    });
    expect(result.llmConfig.modelKwargs).not.toHaveProperty('untrusted');
    expect(result.llmConfig.modelKwargs).not.toHaveProperty('modelKwargs');
  });

  it.each(
    ['custom', 'anthropic', 'google'].flatMap((mode) =>
      wireCases.map((testCase) => ({ mode, ...testCase })),
    ),
  )('never recreates a dropped envelope ($mode: $name)', async ({ mode, extras, addParams }) => {
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-key',
      {
        ...options(mode),
        inferenceParameters: extras,
        addParams,
        dropParams: ['modelKwargs'],
      },
      'gateway',
    );
    expect(llmConfig).not.toHaveProperty('modelKwargs');
    const bodies: Record<string, unknown>[] = [];
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'chatcmpl-drop',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const model = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: { ...configOptions, fetch },
      },
    });
    await model.invoke('hello');
    expect(bodies).toHaveLength(1);
    for (const key of Object.keys(inferenceParameters)) expect(bodies[0]).not.toHaveProperty(key);
  });

  it.each(wireCases)(
    'native Anthropic drops the entire invocation envelope: $name',
    ({ extras, addParams }) => {
      const { llmConfig } = getAnthropicLLMConfig('test-key', {
        modelOptions: { model: 'claude-3-5-sonnet-20241022', thinking: false },
        inferenceParameters: extras,
        defaultParams: { foo_generation_mode: 'accurate', seed: 2 },
        addParams,
        dropParams: ['invocationKwargs'],
      });
      expect(llmConfig).not.toHaveProperty('invocationKwargs');
    },
  );

  it('composes native Anthropic invocation extras before defaults, admin additions, and drops', () => {
    const result = getAnthropicLLMConfig('test-key', {
      modelOptions: { model: 'claude-3-5-sonnet-20241022', user: 'user-1', thinking: false },
      inferenceParameters,
      defaultParams: { foo_generation_mode: 'accurate', seed: 2 },
      addParams: { seed: 9, min_p: 0.9 },
      dropParams: ['min_p'],
    });
    expect(result.llmConfig.invocationKwargs).toMatchObject({
      foo_generation_mode: 'fast',
      seed: 9,
      metadata: { user_id: 'user-1' },
    });
    expect(result.llmConfig.invocationKwargs).not.toHaveProperty('min_p');
    expect(result.llmConfig).not.toHaveProperty('foo_generation_mode');
  });

  it.each(
    ['custom', 'anthropic', 'google'].flatMap((mode) =>
      wireCases.map((testCase) => ({ mode, ...testCase })),
    ),
  )(
    'OpenAI SDK wire, $mode hint: $name',
    async ({ mode, extras, addParams, expectedMode, expectedSeed }) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      };
      const { llmConfig, configOptions } = getOpenAIConfig(
        'test-key',
        {
          ...options(mode),
          inferenceParameters: extras,
          addParams,
        },
        'gateway',
      );
      const model = initializeModel({
        provider: Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          verbosity: undefined,
          configuration: { ...configOptions, fetch },
        },
      });
      await model.invoke('hello');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ foo_generation_mode: expectedMode, seed: expectedSeed });
      expect(bodies[0]).not.toHaveProperty('min_p');
      expect(bodies[0]).not.toHaveProperty('inferenceParameters');
      expect(bodies[0]).not.toHaveProperty('modelKwargs');
    },
  );

  it.each(wireCases)(
    'native Anthropic SDK wire: $name',
    async ({ extras, addParams, expectedMode, expectedSeed }) => {
      const bodies: Record<string, unknown>[] = [];
      const { llmConfig } = getAnthropicLLMConfig('test-key', {
        modelOptions: { model: 'claude-3-5-sonnet-20241022', stream: false, thinking: false },
        inferenceParameters: extras,
        defaultParams: { foo_generation_mode: 'accurate', min_p: 0.1, seed: 2 },
        addParams,
        dropParams: ['min_p'],
      });
      const model = initializeModel({
        provider: Providers.ANTHROPIC,
        clientOptions: {
          ...llmConfig,
          streaming: false,
          clientOptions: {
            ...llmConfig.clientOptions,
            fetch: async (_url, init) => {
              bodies.push(JSON.parse(String(init?.body)));
              return Response.json({
                id: 'msg-test',
                type: 'message',
                role: 'assistant',
                model: 'claude-3-5-sonnet-20241022',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              });
            },
          },
        },
      });
      await model.invoke('hello');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ foo_generation_mode: expectedMode, seed: expectedSeed });
      expect(bodies[0]).not.toHaveProperty('min_p');
      expect(bodies[0]).not.toHaveProperty('inferenceParameters');
    },
  );
});
