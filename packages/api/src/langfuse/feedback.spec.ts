import type { AppConfig } from '@librechat/data-schemas';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    },
    decryptV3: jest.fn((value: string) => {
      if (value === 'v3:test:tenant-secret-key') {
        return 'tenant-secret-key';
      }
      throw new Error('bad decrypt');
    }),
    encryptV3: jest.fn((value: string) => `v3:test:${value}`),
  }),
  { virtual: true },
);

jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn((value: string) =>
    value === 'v3:test:tenant-secret-key' ? 'tenant-secret-key' : undefined,
  ),
}));

const langfuseEnvKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PROJECT_ID',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_TRACING_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'LANGFUSE_TRACING_ENVIRONMENT',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_TENANT_DESTINATIONS',
  'LANGFUSE_FANOUT_TENANT_EU_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_US_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_JP_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED',
  'TENANT_ISOLATION_STRICT',
];
let fetchMock: jest.SpiedFunction<typeof fetch>;

function clearLangfuseEnv() {
  for (const key of langfuseEnvKeys) {
    delete process.env[key];
  }
}

function setLangfuseCredentials() {
  process.env.LANGFUSE_PUBLIC_KEY = 'public-key';
  process.env.LANGFUSE_SECRET_KEY = 'secret-key';
  process.env.LANGFUSE_PROJECT_ID = 'central-project-id';
}

function enableTenantFanout() {
  process.env.TENANT_ISOLATION_STRICT = 'true';
  process.env.LANGFUSE_FANOUT_ENABLED = 'true';
  process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
}

async function loadFeedback(): Promise<typeof import('./feedback')> {
  jest.resetModules();
  return import('./feedback');
}

function getFetchMock(): jest.SpiedFunction<typeof fetch> {
  return fetchMock;
}

function getTenantAuthorization(
  publicKey = 'tenant-public-key',
  secretKey = 'tenant-secret-key',
): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

function encryptedTenantSecret(): string {
  return 'v3:test:tenant-secret-key';
}

function getCentralAuthorization(): string {
  return getTenantAuthorization('public-key', 'secret-key');
}

function appConfigWithLangfuse(langfuse: AppConfig['langfuse']): AppConfig {
  return {
    langfuse: {
      enabled: true,
      projectId: 'tenant-project-id',
      ...langfuse,
    },
  } as AppConfig;
}

describe('Langfuse feedback scores', () => {
  beforeEach(() => {
    clearLangfuseEnv();
    setLangfuseCredentials();
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    clearLangfuseEnv();
    fetchMock.mockRestore();
    jest.clearAllMocks();
  });

  it('posts feedback scores when Langfuse tracing is enabled by default', async () => {
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp', tag: 'helpful', text: 'nice' },
      metadata: {
        messageId: 'message-id',
        conversationId: 'conversation-id',
        sessionId: 'conversation-id',
        userId: 'user-id',
        endpoint: 'agents',
        empty: '',
        missing: undefined,
      },
      observationId: 'observation-id',
    });

    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://cloud.langfuse.com/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('public-key:secret-key').toString('base64')}`,
          'Content-Type': 'application/json',
        }),
        body: expect.any(String),
      }),
    );
    const [, init] = getFetchMock().mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      id: 'feedback-trace-id',
      traceId: 'trace-id',
      name: 'user-feedback',
      value: 1,
      dataType: 'BOOLEAN',
      comment: 'helpful — nice',
      observationId: 'observation-id',
      metadata: {
        rating: 'thumbsUp',
        tag: 'helpful',
        messageId: 'message-id',
        conversationId: 'conversation-id',
        sessionId: 'conversation-id',
        userId: 'user-id',
        endpoint: 'agents',
      },
    });
    expect(JSON.parse(init?.body as string).metadata).not.toHaveProperty('empty');
    expect(JSON.parse(init?.body as string).metadata).not.toHaveProperty('missing');
  });

  it('posts feedback scores to the configured Langfuse host', async () => {
    process.env.LANGFUSE_HOST = 'http://langfuse-server:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
    });

    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://langfuse-server:3000/api/public/scores',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts scores only to the stored connection in single-tenant mode without env credentials', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'us=https://us.cloud.langfuse.example';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'us',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://us.cloud.langfuse.example/api/public/scores',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: getTenantAuthorization() }),
      }),
    );
  });

  it('keeps scores on environment credentials in single-tenant mode', async () => {
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'us',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://cloud.langfuse.com/api/public/scores',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('does not send scores for a disabled stored connection in single-tenant mode', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        enabled: false,
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'us',
      }),
    });

    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it('does not send a score for a trace excluded by fractional sampling', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.5';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '658f74b0a232417fc3e6e4d9ef5f563a',
      feedback: { rating: 'thumbsUp' },
    });

    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it('preserves a sampled trace when the sample rate decreases', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.1';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '658f74b0a232417fc3e6e4d9ef5f563a',
      sampled: true,
      feedback: { rating: 'thumbsUp' },
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it('preserves an excluded trace when the sample rate increases', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '1';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      sampled: false,
      feedback: { rating: 'thumbsUp' },
    });

    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it('posts feedback scores to central fanout and tenant Langfuse projects', async () => {
    enableTenantFanout();
    delete process.env.TENANT_ISOLATION_STRICT;
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsDown', tag: 'wrong' },
      metadata: { tenantId: 'tenant-a' },
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      1,
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getCentralAuthorization(),
        }),
      }),
    );
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      2,
      'http://tenant-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getTenantAuthorization(),
        }),
      }),
    );
    const [, tenantInit] = getFetchMock().mock.calls[1];
    expect(JSON.parse(tenantInit?.body as string)).toMatchObject({
      id: 'feedback-trace-id',
      traceId: 'trace-id',
      name: 'user-feedback',
      value: 0,
      metadata: {
        rating: 'thumbsDown',
        tag: 'wrong',
        tenantId: 'tenant-a',
      },
    });
  });

  it('does not send feedback to a destination that did not receive the original trace', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds: ['original-destination-id'],
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'new-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it('keeps the destination identity stable when project credentials rotate', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { sendFeedbackScore } = await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');
    const originalConfig = appConfigWithLangfuse({
      projectId: 'stable-project-id',
      publicKey: 'old-public-key',
      secretKey: encryptedTenantSecret(),
      destination: 'eu',
    });
    const destinationIds = await getLangfuseTraceDestinationIds(originalConfig, 'trace-id', true);

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds,
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        projectId: 'stable-project-id',
        publicKey: 'new-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(destinationIds).toHaveLength(1);
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it('records the sampling decision of the run a failed turn stands for', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0.5';
    await loadFeedback();
    const { getLangfuseTraceMessageFields } = await import('./destinations');
    const { isLangfuseTraceSampled } = await import('./policy');
    const { traceIdForMessage } = await import('./trace');
    const ids = Array.from({ length: 64 }, (_, index) => `id-${index}`);
    const sampled = (id: string) => isLangfuseTraceSampled(traceIdForMessage(id));
    const runId = ids.find(sampled) as string;
    const rowId = ids.find((id) => !sampled(id)) as string;

    await expect(getLangfuseTraceMessageFields(undefined, rowId, { runId })).resolves.toEqual({
      langfuseSampled: true,
      langfuseDestinationIds: [expect.any(String)],
      langfuseRunId: runId,
    });
    await expect(getLangfuseTraceMessageFields(undefined, runId)).resolves.not.toHaveProperty(
      'langfuseRunId',
    );
    await expect(getLangfuseTraceMessageFields(undefined, rowId)).resolves.toMatchObject({
      langfuseSampled: false,
    });
  });

  it('names the run of a failed turn only when that run was created', async () => {
    await loadFeedback();
    const { getFailedTurnTraceFields } = await import('./destinations');

    await expect(
      getFailedTurnTraceFields(undefined, {
        messageId: 'user-1_',
        runId: 'run-1',
        runCreated: false,
      }),
    ).resolves.toEqual({});
    await expect(
      getFailedTurnTraceFields(undefined, { messageId: 'user-1_', runId: null, runCreated: true }),
    ).resolves.toEqual({});
    await expect(
      getFailedTurnTraceFields(undefined, {
        messageId: 'user-1_',
        runId: 'run-1',
        runCreated: true,
      }),
    ).resolves.toMatchObject({ langfuseSampled: true, langfuseRunId: 'run-1' });
  });

  it('keeps the central destination identity stable when credentials rotate', async () => {
    const { sendFeedbackScore } = await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');
    const destinationIds = await getLangfuseTraceDestinationIds(undefined, 'trace-id', true);
    process.env.LANGFUSE_PUBLIC_KEY = 'rotated-public-key';
    process.env.LANGFUSE_SECRET_KEY = 'rotated-secret-key';

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds,
      feedback: { rating: 'thumbsUp' },
    });

    expect(destinationIds).toHaveLength(1);
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://cloud.langfuse.com/api/public/scores',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: getTenantAuthorization('rotated-public-key', 'rotated-secret-key'),
        }),
      }),
    );
  });

  it('does not reroute central feedback after a project replacement on the same host', async () => {
    const { sendFeedbackScore } = await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');
    const destinationIds = await getLangfuseTraceDestinationIds(undefined, 'trace-id', true);
    process.env.LANGFUSE_PROJECT_ID = 'replacement-project-id';
    process.env.LANGFUSE_PUBLIC_KEY = 'replacement-public-key';
    process.env.LANGFUSE_SECRET_KEY = 'replacement-secret-key';

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds,
      feedback: { rating: 'thumbsUp' },
    });

    expect(destinationIds).toHaveLength(1);
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it('discovers and caches the central project identity when it is not configured', async () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'discovered-project-id' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { sendFeedbackScore } = await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');
    await new Promise((resolve) => setImmediate(resolve));
    const destinationIds = await getLangfuseTraceDestinationIds(undefined, 'trace-id', true);

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds,
      feedback: { rating: 'thumbsUp' },
    });

    expect(destinationIds).toHaveLength(1);
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      1,
      'https://cloud.langfuse.com/api/public/projects',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      2,
      'https://cloud.langfuse.com/api/public/scores',
      expect.any(Object),
    );
  });

  it('does not block trace completion while central project discovery is pending', async () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    let resolveLookup!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');

    const pendingDestinationIds = await getLangfuseTraceDestinationIds(undefined, 'trace-id', true);

    expect(pendingDestinationIds).toBeUndefined();
    expect(getFetchMock()).toHaveBeenCalledTimes(1);

    resolveLookup(
      new Response(JSON.stringify({ data: [{ id: 'background-project-id' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(getLangfuseTraceDestinationIds(undefined, 'trace-id', true)).resolves.toHaveLength(
      1,
    );
  });

  it('retries a failed central project lookup after the cooldown', async () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'recovered-project-id' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      await loadFeedback();
      const { getScoreDestinations } = await import('./destinations');
      await new Promise((resolve) => setImmediate(resolve));

      expect(await getScoreDestinations(undefined, 'trace-id', true)).toEqual([
        expect.objectContaining({ id: undefined, name: 'central' }),
      ]);

      now += 30_001;
      expect(await getScoreDestinations(undefined, 'trace-id', true)).toEqual([
        expect.objectContaining({ id: expect.any(String), name: 'central' }),
      ]);
      expect(getFetchMock()).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('preserves legacy feedback behavior when a connection has no project identity', async () => {
    delete process.env.TENANT_ISOLATION_STRICT;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { sendFeedbackScore } = await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');
    const legacyConfig = appConfigWithLangfuse({
      projectId: undefined,
      publicKey: 'tenant-public-key',
      secretKey: encryptedTenantSecret(),
      destination: 'eu',
    });
    const destinationIds = await getLangfuseTraceDestinationIds(legacyConfig, 'trace-id', true);

    await sendFeedbackScore({
      traceId: 'trace-id',
      sampled: true,
      destinationIds,
      feedback: { rating: 'thumbsUp' },
      appConfig: legacyConfig,
    });

    expect(destinationIds).toBeUndefined();
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it('decrypts encrypted tenant secrets before sending tenant feedback scores', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      2,
      'http://tenant-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getTenantAuthorization(),
        }),
      }),
    );
  });

  it('skips tenant feedback scores when encrypted tenant secret decryption fails', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:bad-secret',
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getCentralAuthorization(),
        }),
      }),
    );
  });

  it('skips tenant feedback scores when tenant keys are configured without a tenant destination', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('posts tenant feedback scores to the configured tenant destination', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'us',
      }),
    });

    expect(getFetchMock()).toHaveBeenNthCalledWith(
      2,
      'https://us.cloud.langfuse.com/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getTenantAuthorization(),
        }),
      }),
    );
  });

  it('skips tenant feedback scores when the tenant destination is not configured', async () => {
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=https://cloud.langfuse.com';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'unconfigured',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('deletes feedback scores from central and tenant Langfuse projects', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: null,
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      1,
      'http://central-langfuse:3000/api/public/scores/feedback-trace-id',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: getCentralAuthorization() },
      }),
    );
    expect(getFetchMock()).toHaveBeenNthCalledWith(
      2,
      'http://tenant-langfuse:3000/api/public/scores/feedback-trace-id',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          Authorization: getTenantAuthorization(),
        },
      }),
    );
  });

  it('posts feedback scores to tenant Langfuse when no central destination is configured', async () => {
    enableTenantFanout();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://tenant-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getTenantAuthorization() }),
      }),
    );
  });

  it('skips tenant scores when tenant Langfuse is disabled but keeps central scores', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        enabled: false,
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('skips tenant scores when tenant enabled is missing', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: {
        langfuse: {
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('skips tenant scores when tenant Langfuse enabled is the string false', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        enabled: 'false',
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      } as unknown as AppConfig['langfuse']),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('skips tenant scores when tenant fanout export is disabled but keeps central scores', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('does not disable tenant scores for a blank emergency toggle', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = '  ';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://cloud.langfuse.com/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getTenantAuthorization() }),
      }),
    );
  });

  it.each(['true', '1', 'yes', 'on'])(
    'disables tenant scores when the emergency toggle is %s',
    async (value) => {
      enableTenantFanout();
      process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = value;
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      });

      expect(getFetchMock()).toHaveBeenCalledTimes(1);
      expect(getFetchMock()).toHaveBeenCalledWith(
        'http://central-langfuse:3000/api/public/scores',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
        }),
      );
    },
  );

  it.each(['false', '0', 'no', 'off'])(
    'does not disable tenant scores when the emergency toggle is %s',
    async (value) => {
      enableTenantFanout();
      process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = value;
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      });

      expect(getFetchMock()).toHaveBeenCalledTimes(2);
      expect(getFetchMock()).toHaveBeenCalledWith(
        'https://cloud.langfuse.com/api/public/scores',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: getTenantAuthorization() }),
        }),
      );
    },
  );

  it('skips tenant scores when global fanout is disabled', async () => {
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('skips tenant scores when fanout has no collector URL', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://central-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
      }),
    );
  });

  it('deduplicates matching central and tenant score destinations', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_PUBLIC_KEY = 'tenant-public-key';
    process.env.LANGFUSE_SECRET_KEY = 'tenant-secret-key';
    process.env.LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://cloud.langfuse.com/api/public/scores',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('attempts every destination and reports partial feedback score failures', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    fetchMock
      .mockResolvedValueOnce(new Response('central down', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { sendFeedbackScore } = await loadFeedback();
    const { logger } = await import('@librechat/data-schemas');

    await expect(
      sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      }),
    ).rejects.toThrow('langfuse central score create failed: score create 500: central down');

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[langfuse] central feedback score send failed'),
      expect.any(Error),
    );
  });

  it('reports tenant feedback score failures after central succeeds', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('tenant down', { status: 503 }));
    const { sendFeedbackScore } = await loadFeedback();
    const { logger } = await import('@librechat/data-schemas');

    await expect(
      sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      }),
    ).rejects.toThrow('langfuse tenant score create failed: score create 503: tenant down');

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[langfuse] central feedback score sent'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[langfuse] tenant feedback score send failed'),
      expect.any(Error),
    );
  });

  it('aggregates feedback score failures when every destination fails', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    fetchMock
      .mockResolvedValueOnce(new Response('central down', { status: 500 }))
      .mockResolvedValueOnce(new Response('tenant down', { status: 503 }));
    const { sendFeedbackScore } = await loadFeedback();

    await expect(
      sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      }),
    ).rejects.toThrow(
      'langfuse central score create failed: score create 500: central down; langfuse tenant score create failed: score create 503: tenant down',
    );

    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it.each(['false', '0', 'no', 'off'])(
    'skips scores when Langfuse tracing is disabled with %s',
    async (value) => {
      process.env.LANGFUSE_TRACING_ENABLED = value;
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsDown' },
      });

      expect(getFetchMock()).not.toHaveBeenCalled();
    },
  );

  it.each(['true', '1', 'yes', 'on'])(
    'enables tenant scores when global fanout is %s',
    async (value) => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      process.env.LANGFUSE_FANOUT_ENABLED = value;
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
      process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      });

      expect(getFetchMock()).toHaveBeenCalledTimes(2);
      expect(getFetchMock()).toHaveBeenCalledWith(
        'https://cloud.langfuse.com/api/public/scores',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: getTenantAuthorization() }),
        }),
      );
    },
  );

  it.each(['false', '0', 'no', 'off'])(
    'keeps tenant scores disabled when global fanout is %s',
    async (value) => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      process.env.LANGFUSE_FANOUT_ENABLED = value;
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
      process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: 'trace-id',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
      });

      expect(getFetchMock()).toHaveBeenCalledTimes(1);
      expect(getFetchMock()).toHaveBeenCalledWith(
        'http://central-langfuse:3000/api/public/scores',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: getCentralAuthorization() }),
        }),
      );
    },
  );

  it('skips scores when Langfuse sampling is set to zero', async () => {
    process.env.LANGFUSE_SAMPLE_RATE = '0';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
    });

    expect(getFetchMock()).not.toHaveBeenCalled();
  });
  it('captures no destinations when central export is suppressed without a fanout route', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');

    /** `resolveLangfuseExportPlan` reports `disabled` for this shape — no fanout
     *  route to fall back on — so capturing the configured connection would let
     *  later feedback reach a project the trace never went to. */
    await expect(
      getLangfuseTraceDestinationIds(
        appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
        }),
        'trace-id',
        true,
        { centralTraceExportEnabled: false },
      ),
    ).resolves.toEqual([]);
  });

  it('records no restriction when a suppressed-central trace has no identifiable destination', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    await loadFeedback();
    const { getLangfuseTraceDestinationIds } = await import('./destinations');

    /** Tenant `projectId` is optional, so this eligible destination carries no
     *  stable id. An empty list would reject it at feedback time and drop the
     *  rating; the opt-out is re-asserted through `sendFeedbackScore` instead. */
    await expect(
      getLangfuseTraceDestinationIds(
        appConfigWithLangfuse({
          publicKey: 'tenant-public-key',
          secretKey: encryptedTenantSecret(),
          destination: 'eu',
          projectId: undefined,
        }),
        'trace-id',
        true,
        { centralTraceExportEnabled: false },
      ),
    ).resolves.toBeUndefined();
  });

  it('sends unrestricted suppressed-central feedback to the tenant only', async () => {
    enableTenantFanout();
    process.env.LANGFUSE_BASE_URL = 'http://central-langfuse:3000';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=http://tenant-langfuse:3000';
    const { sendFeedbackScore } = await loadFeedback();

    /** The trace reached the tenant through its fanout route while central export
     *  was suppressed, and left no destination ids to filter on. The rating has to
     *  follow the same policy: tenant receives it, central stays excluded. */
    await sendFeedbackScore({
      traceId: 'trace-id',
      feedback: { rating: 'thumbsUp' },
      destinationIds: undefined,
      centralTraceExportEnabled: false,
      appConfig: appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: encryptedTenantSecret(),
        destination: 'eu',
        projectId: undefined,
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    expect(getFetchMock()).toHaveBeenCalledWith(
      'http://tenant-langfuse:3000/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: getTenantAuthorization(),
        }),
      }),
    );
  });

  it('sends configured headers with score creation', async () => {
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        headers: { 'CF-Access-Client-Id': 'proxy-client' },
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://langfuse.internal/api/public/scores',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'proxy-client',
          Authorization: getCentralAuthorization(),
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('refuses redirects on requests carrying custom headers', async () => {
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        headers: { 'X-Proxy-Token': 'proxy-token' },
      }),
    });

    /** Node drops `Authorization` across a cross-origin redirect but keeps
     *  arbitrary headers, so following one would hand the gateway credential
     *  to a host that passed no origin check. */
    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  it('keeps default redirect handling when no custom headers are configured', async () => {
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({}),
    });

    const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBeUndefined();
  });

  it('withholds configured headers from an unconfigured origin', async () => {
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        headers: { 'CF-Access-Client-Id': 'internal-gateway-token' },
      }),
    });

    /** Default central export is Langfuse Cloud, which the operator never
     *  pointed at — a gateway credential must not be disclosed to it. */
    const [url, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.langfuse.com/api/public/scores');
    expect(JSON.stringify(init.headers)).not.toContain('internal-gateway-token');
  });

  it('sends configured headers with score deletion', async () => {
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: null,
      appConfig: appConfigWithLangfuse({
        headers: { 'CF-Access-Client-Id': 'proxy-client' },
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledWith(
      expect.stringContaining('/api/public/scores/'),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'proxy-client',
          Authorization: getCentralAuthorization(),
        }),
      }),
    );
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    'never lets a configured %s header displace the Langfuse authorization',
    async (headerName) => {
      const { sendFeedbackScore } = await loadFeedback();

      await sendFeedbackScore({
        traceId: '86d413435f8b0d7f32d4d010ce769e2e',
        feedback: { rating: 'thumbsUp' },
        appConfig: appConfigWithLangfuse({
          headers: { [headerName]: 'Bearer proxy-token' },
        }),
      });

      const [, init] = getFetchMock().mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      /** A surviving case variant would be *appended* by fetch, sending a
       *  combined "Bearer proxy-token, Basic ..." value rather than ours. */
      expect(
        Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization'),
      ).toHaveLength(1);
      expect(Object.values(headers)).toContain(getCentralAuthorization());
      expect(Object.values(headers)).not.toContain('Bearer proxy-token');
    },
  );

  it('sends configured headers with the central project identity lookup', async () => {
    delete process.env.LANGFUSE_PROJECT_ID;
    process.env.LANGFUSE_BASE_URL = 'https://langfuse.internal';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'discovered-project' }] }), { status: 200 }),
    );
    const { sendFeedbackScore } = await loadFeedback();

    await sendFeedbackScore({
      traceId: '86d413435f8b0d7f32d4d010ce769e2e',
      feedback: { rating: 'thumbsUp' },
      appConfig: appConfigWithLangfuse({
        headers: { 'CF-Access-Client-Id': 'proxy-client' },
      }),
    });

    expect(getFetchMock()).toHaveBeenCalledWith(
      'https://langfuse.internal/api/public/projects',
      expect.objectContaining({
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'proxy-client',
          Authorization: getCentralAuthorization(),
        }),
      }),
    );
  });
});
