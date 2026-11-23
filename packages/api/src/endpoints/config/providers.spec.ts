import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  getProviderConfig,
  providerConfigMap,
  resolveTitleConfig,
  resolveTitleTiming,
} from './providers';

const buildAppConfig = (
  customEndpoints: Array<{ name: string; baseURL?: string; apiKey?: string; provider?: string }>,
): AppConfig =>
  ({
    endpoints: {
      [EModelEndpoint.custom]: customEndpoints,
    },
  }) as unknown as AppConfig;

describe('getProviderConfig', () => {
  it('resolves the existing google (API key) path to initializeGoogle', () => {
    // Regression guard: the API-key path uses `Providers.GOOGLE === 'google'`,
    // which has always mapped via `EModelEndpoint.google`. Adding the
    // `Providers.VERTEXAI` entry must not perturb this.
    const result = getProviderConfig({
      provider: Providers.GOOGLE,
      appConfig: buildAppConfig([]),
    });

    expect(result.overrideProvider).toBe(Providers.GOOGLE);
    expect(result.getOptions).toBe(providerConfigMap[EModelEndpoint.google]);
    expect(result.customEndpointConfig).toBeUndefined();
  });

  it('vertexai resolves to the same initializer as google (issue #13006 follow-up)', () => {
    const result = getProviderConfig({
      provider: Providers.VERTEXAI,
      appConfig: buildAppConfig([]),
    });

    expect(result.overrideProvider).toBe(Providers.VERTEXAI);
    expect(result.getOptions).toBe(providerConfigMap[EModelEndpoint.google]);
    expect(result.customEndpointConfig).toBeUndefined();
  });

  it('falls back case-insensitively when only a CamelCase match exists', () => {
    // Agent runtime resolved provider to lowercase `"openrouter"`, but the
    // user's `librechat.yaml` declared `name: "OpenRouter"`.
    const appConfig = buildAppConfig([
      { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
    ]);

    const result = getProviderConfig({ provider: 'openrouter', appConfig });

    expect(result.overrideProvider).toBe(Providers.OPENROUTER);
    expect(result.customEndpointConfig?.name).toBe('OpenRouter');
  });

  it('prefers the exact-case match when both casings exist (preserves case-sensitive identity)', () => {
    // Two distinct custom endpoints differing only in case is supported by
    // `loadCustomEndpointsConfig` (the keys are case-preserving). Direct
    // exact-case lookup should win — case-insensitive fallback must not
    // shadow the user's intent.
    const appConfig = buildAppConfig([
      { name: 'OpenRouter', baseURL: 'https://prod.example/v1', apiKey: 'prod' },
      { name: 'openrouter', baseURL: 'https://staging.example/v1', apiKey: 'staging' },
    ]);

    const result = getProviderConfig({ provider: 'openrouter', appConfig });

    expect(result.customEndpointConfig?.baseURL).toBe('https://staging.example/v1');
  });

  it('resolves an exact-case lowercase entry', () => {
    const appConfig = buildAppConfig([
      { name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-test' },
    ]);

    const result = getProviderConfig({ provider: 'openrouter', appConfig });

    expect(result.customEndpointConfig?.name).toBe('openrouter');
  });

  it('throws on ambiguous case-insensitive matches when no exact-case entry exists (codex review)', () => {
    // User has two distinct entries differing only in case, both
    // non-lowercase. The agent runtime resolves provider to lowercase
    // "openrouter" — neither matches case-sensitively, and silently
    // picking array-first could route requests to the wrong baseURL/apiKey.
    const appConfig = buildAppConfig([
      { name: 'OpenRouter', baseURL: 'https://prod.example/v1', apiKey: 'prod' },
      { name: 'OPENROUTER', baseURL: 'https://canary.example/v1', apiKey: 'canary' },
    ]);

    expect(() => getProviderConfig({ provider: 'openrouter', appConfig })).toThrow(
      /ambiguous.*OpenRouter.*OPENROUTER/i,
    );
  });

  it('throws when openrouter has no matching custom endpoint at all', () => {
    expect(() =>
      getProviderConfig({ provider: 'openrouter', appConfig: buildAppConfig([]) }),
    ).toThrow('Provider openrouter not supported');
  });

  it('routes a custom endpoint with provider:anthropic to the Anthropic client', () => {
    const appConfig = buildAppConfig([
      {
        name: 'Claude-Compatible',
        baseURL: 'https://gateway.example.com',
        apiKey: 'sk-ant',
        provider: EModelEndpoint.anthropic,
      },
    ]);

    const result = getProviderConfig({ provider: 'Claude-Compatible', appConfig });

    expect(result.overrideProvider).toBe(Providers.ANTHROPIC);
    expect(result.customEndpointConfig?.provider).toBe(EModelEndpoint.anthropic);
  });

  it('defaults a custom endpoint without provider to the OpenAI-compatible client', () => {
    const appConfig = buildAppConfig([
      { name: 'My-LLM', baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' },
    ]);

    const result = getProviderConfig({ provider: 'My-LLM', appConfig });

    expect(result.overrideProvider).toBe(Providers.OPENAI);
    expect(result.customEndpointConfig?.name).toBe('My-LLM');
  });

  it('applies provider:anthropic even when the endpoint name collides with a known custom provider', () => {
    // `openrouter` resolves via `providerConfigMap` first (skipping the generic
    // custom branch); the override must still be re-applied from the config so
    // overrideProvider-derived values (token/context budget) use the Anthropic map.
    const appConfig = buildAppConfig([
      {
        name: 'openrouter',
        baseURL: 'https://gateway.example.com',
        apiKey: 'sk-ant',
        provider: EModelEndpoint.anthropic,
      },
    ]);

    const result = getProviderConfig({ provider: 'openrouter', appConfig });

    expect(result.overrideProvider).toBe(Providers.ANTHROPIC);
  });
});

describe('resolveTitleTiming', () => {
  const withEndpoints = (endpoints: Record<string, unknown>): AppConfig =>
    ({ endpoints }) as unknown as AppConfig;

  it("defaults to 'immediate' when no config is provided", () => {
    expect(resolveTitleTiming({})).toBe('immediate');
  });

  it("defaults to 'immediate' when endpoints is missing", () => {
    expect(resolveTitleTiming({ appConfig: {} as AppConfig })).toBe('immediate');
  });

  it("defaults to 'immediate' when no titleTiming is set", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.agents]: { titleConvo: true } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it("returns 'final' from the global `all` config", () => {
    const appConfig = withEndpoints({ all: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it("returns 'final' from the per-endpoint config when `all` is unset", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.agents]: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it('lets `all` take precedence over the per-endpoint value', () => {
    const appConfig = withEndpoints({
      all: { titleTiming: 'immediate' },
      [EModelEndpoint.agents]: { titleTiming: 'final' },
    });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it('does not let unrelated `all` config block a per-endpoint value', () => {
    const appConfig = withEndpoints({
      all: { titleConvo: true },
      [EModelEndpoint.agents]: { titleTiming: 'final' },
    });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it('checks endpoint candidates in order before provider fallback', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.agents]: { titleTiming: 'final' },
      [EModelEndpoint.openAI]: { titleTiming: 'immediate' },
    });
    expect(
      resolveTitleTiming({
        appConfig,
        endpoint: [EModelEndpoint.agents, EModelEndpoint.openAI],
      }),
    ).toBe('final');
  });

  it('falls back to backing provider timing when agents has no titleTiming', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.agents]: { titleConvo: true },
      [EModelEndpoint.openAI]: { titleTiming: 'final' },
    });
    expect(
      resolveTitleTiming({
        appConfig,
        endpoint: [EModelEndpoint.agents, EModelEndpoint.openAI],
      }),
    ).toBe('final');
  });

  it("returns 'immediate' for an endpoint with no override and no `all`", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.openAI]: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it("resolves 'final' from a custom endpoint config (endpoints.custom[])", () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.custom]: [{ name: 'MyProvider', titleTiming: 'final' }],
    });
    expect(resolveTitleTiming({ appConfig, endpoint: 'MyProvider' })).toBe('final');
  });

  it('resolves a normalized custom provider name (openrouter -> OpenRouter)', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.custom]: [
        { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', titleTiming: 'final' },
      ],
    });
    expect(resolveTitleTiming({ appConfig, endpoint: 'openrouter' })).toBe('final');
  });
});

describe('resolveTitleConfig', () => {
  const withEndpoints = (endpoints: Record<string, unknown>): AppConfig =>
    ({ endpoints }) as unknown as AppConfig;

  const openAITitles = {
    titleConvo: true,
    titleModel: 'gpt-4o-mini',
    titleMethod: 'structured',
    titlePrompt: 'OpenAI prompt',
    titlePromptTemplate: 'OpenAI template: {convo}',
  } as const;

  it('returns no settings when nothing is configured', () => {
    expect(resolveTitleConfig({ endpoint: EModelEndpoint.openAI })).toEqual({});
    expect(
      resolveTitleConfig({ appConfig: {} as AppConfig, endpoint: EModelEndpoint.openAI }),
    ).toEqual({});
  });

  it('keeps the endpoint title settings when `all` sets only other keys', () => {
    const appConfig = withEndpoints({
      all: { streamRate: 1, headers: { 'x-gateway': 'a' }, activityLabel: true },
      [EModelEndpoint.openAI]: openAITitles,
    });

    expect(resolveTitleConfig({ appConfig, endpoint: EModelEndpoint.openAI })).toEqual(
      openAITitles,
    );
  });

  it('lets each `all` field win on its own, keeping the endpoint value for the rest', () => {
    const appConfig = withEndpoints({
      all: { titlePrompt: 'Global prompt', titleMethod: 'completion' },
      [EModelEndpoint.openAI]: openAITitles,
    });

    expect(resolveTitleConfig({ appConfig, endpoint: EModelEndpoint.openAI })).toEqual({
      ...openAITitles,
      titlePrompt: 'Global prompt',
      titleMethod: 'completion',
    });
  });

  it('takes titleEndpoint and titleModel together from the first layer that sets either', () => {
    const allSetsEndpoint = withEndpoints({
      all: { titleEndpoint: EModelEndpoint.anthropic },
      [EModelEndpoint.openAI]: openAITitles,
    });
    const allSetsModel = withEndpoints({
      all: { titleModel: 'claude-haiku' },
      [EModelEndpoint.openAI]: { titleEndpoint: EModelEndpoint.anthropic, titleModel: 'gpt-4o' },
    });

    expect(
      resolveTitleConfig({ appConfig: allSetsEndpoint, endpoint: EModelEndpoint.openAI }),
    ).toMatchObject({ titleEndpoint: EModelEndpoint.anthropic, titleModel: undefined });
    expect(
      resolveTitleConfig({ appConfig: allSetsModel, endpoint: EModelEndpoint.openAI }),
    ).toMatchObject({ titleEndpoint: undefined, titleModel: 'claude-haiku' });
  });

  it('treats an explicit current_model in `all` as setting the model choice', () => {
    const appConfig = withEndpoints({
      all: { titleModel: 'current_model' },
      [EModelEndpoint.openAI]: { titleEndpoint: EModelEndpoint.anthropic, titleModel: 'x' },
    });

    expect(resolveTitleConfig({ appConfig, endpoint: EModelEndpoint.openAI })).toMatchObject({
      titleEndpoint: undefined,
      titleModel: 'current_model',
    });
  });

  it('disables titles everywhere through `all.titleConvo: false`', () => {
    const appConfig = withEndpoints({
      all: { titleConvo: false },
      [EModelEndpoint.openAI]: openAITitles,
    });

    expect(resolveTitleConfig({ appConfig, endpoint: EModelEndpoint.openAI }).titleConvo).toBe(
      false,
    );
  });

  it('honors an endpoint `titleConvo: false` next to an unrelated `all` block', () => {
    const appConfig = withEndpoints({
      all: { streamRate: 1 },
      [EModelEndpoint.openAI]: { titleConvo: false },
    });

    expect(resolveTitleConfig({ appConfig, endpoint: EModelEndpoint.openAI }).titleConvo).toBe(
      false,
    );
  });

  it('falls back to the custom endpoint config, still behind `all`', () => {
    const appConfig = withEndpoints({
      all: { titlePrompt: 'Global prompt' },
      [EModelEndpoint.custom]: [
        {
          name: 'Gateway',
          baseURL: 'https://gateway.example/v1',
          apiKey: 'gateway-key',
          titleModel: 'gateway-small',
          titleMethod: 'completion',
          titlePrompt: 'Gateway prompt',
        },
      ],
    });
    const { customEndpointConfig } = getProviderConfig({ provider: 'Gateway', appConfig });

    expect(resolveTitleConfig({ appConfig, endpoint: 'Gateway', customEndpointConfig })).toEqual({
      titleModel: 'gateway-small',
      titleMethod: 'completion',
      titlePrompt: 'Global prompt',
    });
  });

  it('prefers the named endpoint block over the custom config field by field', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.openAI]: { titlePrompt: 'Named prompt' },
    });

    expect(
      resolveTitleConfig({
        appConfig,
        endpoint: EModelEndpoint.openAI,
        customEndpointConfig: { titlePrompt: 'Custom prompt', titleMethod: 'functions' },
      }),
    ).toEqual({ titlePrompt: 'Named prompt', titleMethod: 'functions' });
  });
});
