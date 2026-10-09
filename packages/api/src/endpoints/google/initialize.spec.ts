import { Providers } from '@librechat/agents';
import { AuthKeys, EModelEndpoint } from 'librechat-data-provider';
import type { EndpointDbMethods, ServerRequest } from '~/types';

const mockGetGoogleConfig = jest.fn(
  (_credentials?: unknown, _options?: unknown, _acceptRawApiKey?: unknown) => ({
    provider: Providers.VERTEXAI,
    llmConfig: { model: 'gemini-2.5-flash' },
  }),
);
const mockIsEnabled = jest.fn();
const mockLoadServiceKey = jest.fn();
const mockCheckUserKeyExpiry = jest.fn();

jest.mock('./llm', () => ({
  getGoogleConfig: (credentials: unknown, options: unknown, acceptRawApiKey?: unknown) =>
    mockGetGoogleConfig(credentials, options, acceptRawApiKey),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  isEnabled: (value: unknown) => mockIsEnabled(value),
  loadServiceKey: (keyPath: unknown) => mockLoadServiceKey(keyPath),
  checkUserKeyExpiry: (expiresAt: unknown, endpoint: unknown) =>
    mockCheckUserKeyExpiry(expiresAt, endpoint),
}));

import { initializeGoogle } from './initialize';

function createDb(): EndpointDbMethods {
  return {
    getUserKey: jest.fn().mockResolvedValue('user-google-key'),
    getUserKeyValues: jest.fn().mockResolvedValue({}),
  };
}

function createReq(): ServerRequest {
  return {
    body: {},
    config: {},
    user: { id: 'user-1' },
  } as ServerRequest;
}

function getGoogleConfigCall(): [Record<string, unknown>, Record<string, unknown>] {
  expect(mockGetGoogleConfig).toHaveBeenCalled();
  return mockGetGoogleConfig.mock.calls[0] as unknown as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
}

describe('initializeGoogle', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_KEY;
    delete process.env.GOOGLE_REVERSE_PROXY;
    delete process.env.GOOGLE_AUTH_HEADER;
    delete process.env.GOOGLE_SERVICE_KEY_FILE;
    delete process.env.VERTEX_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_PROJECT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('forces Vertex AI ADC config and ignores GOOGLE_KEY for vertexai endpoint', async () => {
    process.env.GOOGLE_KEY = 'test-api-key';
    process.env.VERTEX_PROJECT_ID = 'fiery-catwalk-385918';
    mockLoadServiceKey.mockResolvedValue(null);

    const db = createDb();

    await initializeGoogle({
      req: createReq(),
      endpoint: Providers.VERTEXAI,
      model_parameters: { model: 'gemini-2.5-flash' },
      db,
    });

    expect(mockLoadServiceKey).toHaveBeenCalledTimes(1);
    expect(db.getUserKey).not.toHaveBeenCalled();
    expect(mockCheckUserKeyExpiry).not.toHaveBeenCalled();

    const [credentials, options] = getGoogleConfigCall();
    expect(credentials).toEqual({
      [AuthKeys.GOOGLE_SERVICE_KEY]: {},
    });
    expect(credentials).not.toHaveProperty(AuthKeys.GOOGLE_API_KEY);
    expect(options).toEqual(
      expect.objectContaining({
        forceVertex: true,
        projectId: 'fiery-catwalk-385918',
        modelOptions: { model: 'gemini-2.5-flash' },
      }),
    );
  });

  it('keeps Google API-key config for the google endpoint', async () => {
    process.env.GOOGLE_KEY = 'test-api-key';
    process.env.VERTEX_PROJECT_ID = 'fiery-catwalk-385918';

    await initializeGoogle({
      req: createReq(),
      endpoint: EModelEndpoint.google,
      model_parameters: { model: 'gemini-2.5-flash' },
      db: createDb(),
    });

    expect(mockLoadServiceKey).not.toHaveBeenCalled();

    const [credentials, options] = getGoogleConfigCall();
    expect(credentials).toEqual({
      [AuthKeys.GOOGLE_SERVICE_KEY]: {},
      [AuthKeys.GOOGLE_API_KEY]: 'test-api-key',
    });
    expect(options).toEqual(
      expect.objectContaining({
        forceVertex: false,
        projectId: undefined,
        modelOptions: { model: 'gemini-2.5-flash' },
      }),
    );
  });

  it('loads the stored API key when a resumed request omits expiry metadata', async () => {
    process.env.GOOGLE_KEY = 'user_provided';
    const db = createDb();

    await initializeGoogle({
      req: createReq(),
      endpoint: EModelEndpoint.google,
      model_parameters: { model: 'gemini-2.5-flash' },
      db,
    });

    expect(db.getUserKey).toHaveBeenCalledWith({
      userId: 'user-1',
      name: EModelEndpoint.google,
    });
    expect(mockCheckUserKeyExpiry).not.toHaveBeenCalled();

    const [credentials] = getGoogleConfigCall();
    expect(credentials).toBe('user-google-key');
  });

  it('resolves configured headers at init (merged over endpoints.all) before getGoogleConfig', async () => {
    process.env.GOOGLE_KEY = 'test-api-key';

    const req = {
      body: { conversationId: 'convo-9' },
      user: { id: 'user-1' },
      config: {
        endpoints: {
          all: { headers: { 'X-Common': 'all', 'X-Override': 'all' } },
          [EModelEndpoint.google]: {
            headers: {
              'X-Override': 'google',
              'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
              'X-User-Id': '{{LIBRECHAT_USER_ID}}',
            },
          },
        },
      },
    } as unknown as ServerRequest;

    await initializeGoogle({
      req,
      endpoint: EModelEndpoint.google,
      model_parameters: { model: 'gemini-2.5-flash' },
      db: createDb(),
    });

    const [, options] = getGoogleConfigCall();
    expect(options.headers).toEqual({
      'X-Common': 'all',
      'X-Override': 'google',
      'X-Conversation-Id': 'convo-9',
      'X-User-Id': 'user-1',
    });
  });
});

describe('initializeGoogle streamRate resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_KEY = 'test-api-key';
  });

  async function initWithConfig(
    endpointsConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const req = createReq();
    (req as unknown as { config: Record<string, unknown> }).config = {
      endpoints: endpointsConfig,
    };
    const result = await initializeGoogle({
      req,
      endpoint: EModelEndpoint.google,
      model_parameters: { model: 'gemini-2.5-flash' },
      db: createDb(),
    });
    return result.llmConfig as Record<string, unknown>;
  }

  it('wires the endpoint streamRate into llmConfig._lc_stream_delay', async () => {
    const llmConfig = await initWithConfig({ [EModelEndpoint.google]: { streamRate: 25 } });
    expect(llmConfig._lc_stream_delay).toBe(25);
  });

  it('preserves the endpoint streamRate when `endpoints.all` exists without one', async () => {
    const llmConfig = await initWithConfig({
      [EModelEndpoint.google]: { streamRate: 25 },
      all: { activityLabel: true },
    });
    expect(llmConfig._lc_stream_delay).toBe(25);
  });

  it('lets `endpoints.all.streamRate` override the endpoint value', async () => {
    const llmConfig = await initWithConfig({
      [EModelEndpoint.google]: { streamRate: 25 },
      all: { streamRate: 10 },
    });
    expect(llmConfig._lc_stream_delay).toBe(10);
  });

  it('lets `endpoints.all.streamRate: 0` disable smoothing explicitly', async () => {
    const llmConfig = await initWithConfig({
      [EModelEndpoint.google]: { streamRate: 25 },
      all: { streamRate: 0 },
    });
    expect(llmConfig._lc_stream_delay).toBe(0);
  });

  it('leaves the delay unset when neither level configures a streamRate', async () => {
    const llmConfig = await initWithConfig({ all: { activityLabel: true } });
    expect(llmConfig._lc_stream_delay).toBeUndefined();
  });
});
