import { AuthType, EModelEndpoint, ReasoningParameterFormat } from 'librechat-data-provider';
import type { TCustomEndpoints } from 'librechat-data-provider';
import { loadCustomEndpointsConfig } from './config';

const baseEndpoint = {
  apiKey: 'sk-test',
  baseURL: 'https://gateway.example.com',
  models: { default: ['claude-sonnet-4-5'] },
};

describe('loadCustomEndpointsConfig – native provider param set', () => {
  it('synthesizes defaultParamsEndpoint from provider so the UI shows the right params', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Claude-Compatible', provider: EModelEndpoint.anthropic },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Claude-Compatible']?.customParams?.defaultParamsEndpoint).toBe(
      EModelEndpoint.anthropic,
    );
  });

  it('does not set defaultParamsEndpoint for endpoints without a provider', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'My-LLM' },
    ] as unknown as TCustomEndpoints);

    expect(config?.['My-LLM']?.customParams).toBeUndefined();
  });

  it('respects an explicit non-default defaultParamsEndpoint over the provider', () => {
    const config = loadCustomEndpointsConfig([
      {
        ...baseEndpoint,
        name: 'Claude-Compatible',
        provider: EModelEndpoint.anthropic,
        customParams: { defaultParamsEndpoint: EModelEndpoint.google },
      },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Claude-Compatible']?.customParams?.defaultParamsEndpoint).toBe(
      EModelEndpoint.google,
    );
  });
});

describe('loadCustomEndpointsConfig: host-implied reasoning support', () => {
  const load = (endpoint: Record<string, unknown>) => {
    const name = typeof endpoint.name === 'string' ? endpoint.name : 'Gateway';
    return loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Gateway', ...endpoint },
    ] as unknown as TCustomEndpoints)?.[name]?.customParams;
  };

  it('declares effort-style reasoning for OpenRouter', () => {
    expect(load({ baseURL: 'https://openrouter.ai/api/v1' })?.reasoningFormat).toBe(
      ReasoningParameterFormat.reasoningEffort,
    );
  });

  it.each(['https://api.openai.com/v1', 'https://api.x.ai/v1'])(
    'leaves %s to explicit config: its capability depends on the model',
    (baseURL) => {
      expect(load({ baseURL })).toBeUndefined();
    },
  );

  it.each([['reasoning_effort'], ['reasoning']])(
    'does not advertise reasoning that dropParams %j removes',
    (...dropParams) => {
      expect(load({ baseURL: 'https://openrouter.ai/api/v1', dropParams })).toBeUndefined();
    },
  );

  describe('OpenRouter identified from the resolved host', () => {
    const envKey = 'OPENROUTER_BASE_URL_PROBE';
    afterEach(() => {
      delete process.env[envKey];
    });

    it('marks an endpoint whose URL comes from an environment variable and whose name does not say OpenRouter', () => {
      process.env[envKey] = 'https://openrouter.ai/api/v1';

      const params = load({ name: 'Gateway', baseURL: `\${${envKey}}` });

      expect(params?.defaultParamsEndpoint).toBe('openrouter');
      expect(params?.reasoningFormat).toBe(ReasoningParameterFormat.reasoningEffort);
    });

    it('marks a literal OpenRouter URL under any endpoint name', () => {
      expect(
        load({ name: 'Models', baseURL: 'https://openrouter.ai/api/v1' })?.defaultParamsEndpoint,
      ).toBe('openrouter');
    });

    it('keeps an administrator-chosen params endpoint', () => {
      expect(
        load({
          baseURL: 'https://openrouter.ai/api/v1',
          customParams: { defaultParamsEndpoint: EModelEndpoint.openAI },
        })?.defaultParamsEndpoint,
      ).toBe(EModelEndpoint.openAI);
    });

    it('replaces the generic default the schema fills in', () => {
      expect(
        load({
          baseURL: 'https://openrouter.ai/api/v1',
          customParams: { defaultParamsEndpoint: EModelEndpoint.custom },
        })?.defaultParamsEndpoint,
      ).toBe('openrouter');
    });

    it('does not mark a host that is not OpenRouter', () => {
      process.env[envKey] = 'https://api.mistral.ai/v1';

      expect(load({ name: 'Gateway', baseURL: `\${${envKey}}` })).toBeUndefined();
    });

    it('does not mark an endpoint whose URL the user provides', () => {
      expect(load({ baseURL: 'user_provided' })).toBeUndefined();
    });

    it('does not mark an endpoint that drops the effort', () => {
      expect(
        load({ baseURL: 'https://openrouter.ai/api/v1', dropParams: ['reasoning_effort'] }),
      ).toBeUndefined();
    });

    it('keeps an administrator-defined reasoning_effort authoritative', () => {
      const params = load({
        baseURL: 'https://openrouter.ai/api/v1',
        customParams: { paramDefinitions: [{ key: 'reasoning_effort' }] },
      });

      expect(params?.defaultParamsEndpoint).toBe('openrouter');
      expect(params?.reasoningFormat).toBeUndefined();
    });
  });

  it('advertises reasoning for the OpenRouter params endpoint the config loader injects', () => {
    expect(
      load({
        baseURL: 'https://openrouter.ai/api/v1',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          paramDefinitions: [{ key: 'promptCache', default: true }],
        },
      }),
    ).toEqual({
      defaultParamsEndpoint: 'openrouter',
      paramDefinitions: [{ key: 'promptCache', default: true }],
      reasoningFormat: ReasoningParameterFormat.reasoningEffort,
    });
  });

  it('still advertises reasoning when dropParams removes something else', () => {
    expect(
      load({ baseURL: 'https://openrouter.ai/api/v1', dropParams: ['temperature'] })
        ?.reasoningFormat,
    ).toBe(ReasoningParameterFormat.reasoningEffort);
  });

  it('does not infer reasoning from the endpoint name alone', () => {
    expect(load({ name: 'Gateway', baseURL: 'http://localhost:8080/v1', iconURL: 'xai' })).toBe(
      undefined,
    );
  });

  it.each(['https://api.mistral.ai/v1', 'https://api.groq.com/openai/v1'])(
    'does not infer reasoning for the host %s without verified effort support',
    (baseURL) => {
      expect(load({ baseURL })).toBeUndefined();
    },
  );

  it('keeps an explicit reasoning format', () => {
    expect(
      load({
        baseURL: 'https://openrouter.ai/api/v1',
        customParams: { reasoningFormat: ReasoningParameterFormat.disabled },
      })?.reasoningFormat,
    ).toBe(ReasoningParameterFormat.disabled);
  });

  it('defers to explicit reasoning parameter definitions', () => {
    const customParams = load({
      baseURL: 'https://openrouter.ai/api/v1',
      customParams: { paramDefinitions: [{ key: 'thinkingLevel' }] },
    });
    expect(customParams?.reasoningFormat).toBeUndefined();
    expect(customParams?.paramDefinitions).toEqual([{ key: 'thinkingLevel' }]);
  });

  it('defers to an explicit non-default params endpoint', () => {
    expect(
      load({
        baseURL: 'https://openrouter.ai/api/v1',
        customParams: { defaultParamsEndpoint: EModelEndpoint.anthropic },
      })?.reasoningFormat,
    ).toBeUndefined();
  });

  it('leaves a native provider endpoint to its own param set', () => {
    expect(
      load({ baseURL: 'https://openrouter.ai/api/v1', provider: EModelEndpoint.anthropic })
        ?.reasoningFormat,
    ).toBeUndefined();
  });
});

describe('loadCustomEndpointsConfig – user credential prompts', () => {
  it('requires a user key when the custom base URL is user-provided', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'User URL', baseURL: AuthType.USER_PROVIDED },
    ] as unknown as TCustomEndpoints);

    expect(config?.['User URL']).toEqual(
      expect.objectContaining({
        userProvide: true,
        userProvideURL: true,
      }),
    );
  });

  it('requires a user key when the custom API key is user-provided', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'User Key', apiKey: AuthType.USER_PROVIDED },
    ] as unknown as TCustomEndpoints);

    expect(config?.['User Key']).toEqual(
      expect.objectContaining({
        userProvide: true,
        userProvideURL: false,
      }),
    );
  });

  it('does not require a user key for admin-trusted credentials and base URL', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Admin Trusted' },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Admin Trusted']).toEqual(
      expect.objectContaining({
        userProvide: false,
        userProvideURL: false,
      }),
    );
  });
});
