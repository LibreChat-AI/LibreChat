import yaml from 'js-yaml';
import { ChatOpenAI } from '@librechat/agents/llm/openai';
import { SettingTypes, ComponentTypes, endpointSchema } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import { createCustomConfigLoader, ConfigReloadError } from './loader';
import { resolveAgentInferenceParameters } from '../agents/inference';
import { getOpenAIConfig } from '../endpoints/openai/config';
import { parseAgentInferenceInput } from '../agents/input';
import { expandCustomEndpoint } from './params';

type Definition = NonNullable<NonNullable<TEndpoint['customParams']>['paramDefinitions']>[number];

const load = (definitions: Definition[], mode: 'startup' | 'reload' = 'startup') => {
  const text = yaml.dump({
    version: '1.3.17',
    endpoints: {
      custom: [
        {
          name: 'Gateway',
          apiKey: 'synthetic-server-key',
          baseURL: 'https://gateway.invalid/v1',
          models: { default: ['permitted'], fetch: false },
          customParams: { defaultParamsEndpoint: 'custom', paramDefinitions: definitions },
        },
      ],
    },
  });
  return createCustomConfigLoader({
    defaultConfigPath: 'inference.yaml',
    loadLocal: () => text,
    redactConfig: (config) => config,
  })(false, { mode });
};

const definitions: Definition[] = [
  {
    key: 'min_p',
    type: SettingTypes.Number,
    component: ComponentTypes.Input,
    range: { min: 0, max: 1 },
    default: 0.1,
  },
  { key: 'seed', type: SettingTypes.Number, component: ComponentTypes.Input, default: 7 },
  {
    key: 'foo_generation_mode',
    type: SettingTypes.Enum,
    component: ComponentTypes.Dropdown,
    options: ['fast', 'accurate'],
    default: 'accurate',
  },
];

describe('typed inference declarations in YAML', () => {
  it.each(['startup', 'reload'] as const)(
    'loads safe declarations in %s mode and uses them at the SDK boundary',
    async (mode) => {
      const config = await load(definitions, mode);
      expect(config).not.toBeNull();
      const loaded = config?.endpoints?.custom?.[0];
      const endpoint = loaded
        ? endpointSchema.parse(expandCustomEndpoint(loaded as TEndpoint))
        : undefined;
      expect(endpoint?.customParams?.paramDefinitions).toMatchObject(
        definitions.map((definition) => ({ ...definition, optionType: 'custom' })),
      );
      const parameters = parseAgentInferenceInput({
        provider: 'Gateway',
        model: 'permitted',
        parameters: { min_p: 0.7, seed: 11, foo_generation_mode: 'fast' },
        appConfig: { endpoints: { custom: endpoint ? [endpoint] : [] } },
      });
      const projected = resolveAgentInferenceParameters({
        provider: 'Gateway',
        model: 'permitted',
        parameters,
        customParams: endpoint?.customParams,
      });
      expect(projected.issues).toEqual([]);
      const { llmConfig } = getOpenAIConfig(
        'synthetic-server-key',
        {
          streaming: false,
          modelOptions: { model: 'permitted', ...projected.parameters },
          customParams: endpoint?.customParams,
          inferenceParameters: projected.customParameters,
        },
        'Gateway',
      );
      const client = new ChatOpenAI(llmConfig as ConstructorParameters<typeof ChatOpenAI>[0]);
      expect(client.invocationParams({})).toMatchObject({
        model: 'permitted',
        min_p: 0.7,
        seed: 11,
        foo_generation_mode: 'fast',
      });
      expect(() =>
        parseAgentInferenceInput({
          provider: 'Gateway',
          model: 'permitted',
          parameters: { min_p: 2 },
          appConfig: { endpoints: { custom: endpoint ? [endpoint] : [] } },
        }),
      ).toThrow();
    },
  );

  it.each([
    'modelKwargs',
    'configuration',
    'fallbacks',
    'apiKey',
    'baseURL',
    'model',
    'tools',
    'messages',
  ])('does not admit a typed SDK control declaration: %s', async (key) => {
    const definition = { key, type: SettingTypes.String, component: ComponentTypes.Input };
    await expect(load([definition])).rejects.toThrow('invalid key');
    await expect(load([definition], 'reload')).rejects.toBeInstanceOf(ConfigReloadError);
  });

  it('rejects undeclared, untyped, malformed enum and invalid-default extensions', async () => {
    await expect(load([{ key: 'min_p', component: ComponentTypes.Input }])).rejects.toThrow(
      'invalid key',
    );
    await expect(
      load([{ key: 'extra_mode', type: SettingTypes.Enum, component: ComponentTypes.Dropdown }]),
    ).rejects.toThrow('invalid key');
    await expect(load([{ ...definitions[0], default: 2 }])).rejects.toThrow('invalid key');
    await expect(
      load([{ key: 'reasoning', type: SettingTypes.String, component: ComponentTypes.Input }]),
    ).rejects.toThrow('invalid key');
  });

  it('keeps shorthand parameter declarations as written, and serves them expanded', async () => {
    const config = await load([{ key: 'temperature', default: 0.3 }]);
    const loaded = config?.endpoints?.custom?.[0];
    expect(loaded?.customParams?.paramDefinitions).toEqual([{ key: 'temperature', default: 0.3 }]);
    expect(
      loaded && expandCustomEndpoint(loaded as TEndpoint).customParams?.paramDefinitions?.[0],
    ).toMatchObject({
      key: 'temperature',
      type: 'number',
      default: 0.3,
      optionType: 'custom',
    });
  });
});
