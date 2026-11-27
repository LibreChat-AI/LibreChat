import {
  SettingTypes,
  paramSettings,
  ComponentTypes,
  agentParamSettings,
} from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import { expandCustomEndpoint } from './params';

/** A custom endpoint as librechat.yaml writes it, where `customParams` may be compact. */
const endpoint = (overrides: Record<string, unknown> = {}): TEndpoint =>
  ({
    name: 'Gateway',
    apiKey: '${GATEWAY_KEY}',
    baseURL: 'https://gateway.example.com/v1',
    models: { default: ['m1'] },
    ...overrides,
  }) as TEndpoint;

/** The default definition a key takes: the agent settings' over the regular ones, as expansion reads them. */
function getDefinition(defaultParamsEndpoint: string, key: string) {
  const isKey = (param: { key: string }) => param.key === key;
  return (
    agentParamSettings[defaultParamsEndpoint]?.find(isKey) ??
    paramSettings[defaultParamsEndpoint]?.find(isKey)
  );
}

describe('expandCustomEndpoint', () => {
  it('completes compact definitions from the defaults of their endpoint, as a copy', () => {
    const compact = endpoint({
      customParams: {
        defaultParamsEndpoint: 'anthropic',
        paramDefinitions: [{ key: 'temperature', default: 0.2 }],
      },
    });
    const written = structuredClone(compact);

    const expanded = expandCustomEndpoint(compact);

    expect(compact).toEqual(written);
    expect(expanded.customParams?.defaultParamsEndpoint).toBe('anthropic');
    const { range, component, type } = getDefinition('anthropic', 'temperature') ?? {};
    expect(expanded.customParams?.paramDefinitions).toEqual([
      expect.objectContaining({
        key: 'temperature',
        default: 0.2,
        optionType: 'custom',
        range,
        component,
        type,
      }),
    ]);
    expect(expanded.name).toBe('Gateway');
  });

  it('picks the defaults of the endpoint defaultParamsEndpoint names', () => {
    const forOpenAI = expandCustomEndpoint(
      endpoint({
        customParams: { defaultParamsEndpoint: 'openAI', paramDefinitions: [{ key: 'top_p' }] },
      }),
    );

    expect(forOpenAI.customParams?.paramDefinitions?.[0]).toMatchObject({
      ...getDefinition('openAI', 'top_p'),
      optionType: 'custom',
    });
  });

  it('is idempotent: expanding an expanded endpoint changes nothing', () => {
    const once = expandCustomEndpoint(
      endpoint({
        name: 'OpenRouter',
        customParams: { paramDefinitions: [{ key: 'temperature', default: 0.4 }] },
      }),
    );

    expect(expandCustomEndpoint(once)).toEqual(once);
  });

  it("adds OpenRouter's defaults by name or URL, and keeps an explicit promptCache", () => {
    const byName = expandCustomEndpoint(endpoint({ name: 'OpenRouter' }));
    const byURL = expandCustomEndpoint(endpoint({ baseURL: 'https://openrouter.ai/api/v1' }));
    const explicit = expandCustomEndpoint(
      endpoint({
        name: 'OpenRouter',
        customParams: { paramDefinitions: [{ key: 'promptCache', default: false }] },
      }),
    );

    for (const expanded of [byName, byURL]) {
      expect(expanded.customParams?.defaultParamsEndpoint).toBe('openrouter');
      expect(expanded.customParams?.paramDefinitions).toEqual([
        { ...getDefinition('openrouter', 'promptCache'), default: true, optionType: 'custom' },
      ]);
    }
    expect(explicit.customParams?.paramDefinitions).toEqual([
      { ...getDefinition('openrouter', 'promptCache'), default: false, optionType: 'custom' },
    ]);
  });

  it('leaves an OpenRouter endpoint whose defaults come from another provider alone', () => {
    const expanded = expandCustomEndpoint(
      endpoint({ name: 'OpenRouter', customParams: { defaultParamsEndpoint: 'anthropic' } }),
    );

    expect(expanded.customParams).toEqual({
      defaultParamsEndpoint: 'anthropic',
      paramDefinitions: [],
    });
  });

  it('returns an endpoint without customParams as written', () => {
    const plain = endpoint();

    expect(expandCustomEndpoint(plain)).toEqual(plain);
    expect(expandCustomEndpoint(plain)).not.toBe(plain);
  });

  it('throws for an unknown key, an unknown defaultParamsEndpoint and malformed definitions', () => {
    expect(() =>
      expandCustomEndpoint(
        endpoint({ customParams: { paramDefinitions: [{ key: 'notAParameter', default: 1 }] } }),
      ),
    ).toThrow('paramDefinitions of "Gateway" endpoint contains invalid key(s)');
    expect(() =>
      expandCustomEndpoint(endpoint({ customParams: { defaultParamsEndpoint: 'nowhere' } })),
    ).toThrow('defaultParamsEndpoint of "Gateway" endpoint is invalid');
    expect(() =>
      expandCustomEndpoint(
        endpoint({
          customParams: {
            paramDefinitions: [
              { key: 'temperature', type: 'noomba', component: 'inpoot' } as never,
            ],
          },
        }),
      ),
    ).toThrow('Custom parameter definitions for "Gateway" endpoint is malformed');
  });

  it('accepts a valid agent inference extension a provider does not define', () => {
    const expanded = expandCustomEndpoint(
      endpoint({
        customParams: {
          paramDefinitions: [
            {
              key: 'customTemperature',
              type: SettingTypes.Number,
              component: ComponentTypes.Slider,
              default: 0.5,
              range: { min: 0, max: 1, step: 0.1 },
            },
          ],
        },
      }),
    );

    expect(expanded.customParams?.paramDefinitions?.[0]).toMatchObject({
      key: 'customTemperature',
      optionType: 'custom',
    });
  });
});
