import { classificationProviderSchema, classificationSchema, configSchema } from './config';

const LAYA_ENDPOINT = 'http://localhost:8000/v1/systemone';

describe('classification configuration', () => {
  it('stays absent when not configured and off when present without an opt-in', () => {
    expect(configSchema.parse({ version: '1.2.1' }).classification).toBeUndefined();
    expect(classificationSchema.parse({})).toEqual({
      enabled: false,
      provider: 'http',
      providers: {},
    });
  });

  it('accepts Laya without forcing a model or an API key', () => {
    const parsed = configSchema.parse({
      version: '1.2.1',
      classification: {
        enabled: true,
        provider: 'laya',
        providers: { laya: { baseURL: LAYA_ENDPOINT } },
      },
    });

    expect(parsed.classification?.providers.laya).toEqual({ baseURL: LAYA_ENDPOINT });
    expect(parsed.classification?.providers.laya.model).toBeUndefined();
    expect(parsed.classification?.providers.laya.apiKeyEnv).toBeUndefined();
  });

  it('preserves explicit wire settings, optional authentication and a credential variable name', () => {
    const config = classificationSchema.parse({
      enabled: true,
      provider: 'inhouse',
      providers: {
        inhouse: {
          baseURL: LAYA_ENDPOINT,
          model: 'my-checkpoint',
          dialect: 'systemone',
          requestKey: 'input',
          responseKey: 'result',
          timeoutMs: 4000,
          maxRetries: 2,
          requiresAuth: false,
          apiKeyEnv: 'INHOUSE_CLASSIFIER_KEY',
        },
      },
    });

    expect(config.providers.inhouse).toEqual({
      baseURL: LAYA_ENDPOINT,
      model: 'my-checkpoint',
      dialect: 'systemone',
      requestKey: 'input',
      responseKey: 'result',
      timeoutMs: 4000,
      maxRetries: 2,
      requiresAuth: false,
      apiKeyEnv: 'INHOUSE_CLASSIFIER_KEY',
    });
  });

  it.each([
    { enabled: true, enabeld: true },
    { enabled: true, providers: { laya: { baseURL: LAYA_ENDPOINT, apiKey: 'literal' } } },
    { enabled: true, providers: { laya: { baseURL: LAYA_ENDPOINT, requestkey: 'input' } } },
  ])('rejects unknown fields rather than silently ignoring a typo or a literal key', (value) => {
    expect(classificationSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { baseURL: 'not-a-url' },
    { baseURL: 'localhost:8000/v1/systemone' },
    { baseURL: 'ftp://example.com/v1/systemone' },
    { baseURL: 'https://user:password@example.com/v1/systemone' },
    { model: '' },
    { dialect: 'json' },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { maxRetries: -1 },
    { maxRetries: 6 },
    { apiKeyEnv: 'KEY=value' },
    { apiKeyEnv: '' },
  ])('rejects invalid HTTP provider settings: %j', (value) => {
    expect(classificationProviderSchema.safeParse(value).success).toBe(false);
  });
});
