process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const langfuseEnvKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PROJECT_ID',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_FANOUT_ENABLED',
  'LANGFUSE_FANOUT_COLLECTOR_URL',
  'LANGFUSE_FANOUT_TENANT_DESTINATIONS',
  'LANGFUSE_FANOUT_TENANT_EU_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_US_BASE_URL',
  'LANGFUSE_FANOUT_TENANT_JP_BASE_URL',
  'TENANT_ISOLATION_STRICT',
];

function clearLangfuseEnv() {
  for (const key of langfuseEnvKeys) {
    delete process.env[key];
  }
}

// Cleared before the module graph loads: another spec file running earlier in
// this worker may have left Langfuse env vars set, and `./destinations` reads
// them at import time for its own warm-up lookup.
clearLangfuseEnv();

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  }),
  { virtual: true },
);

jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn((value: string) =>
    value === 'v3:test:tenant-secret-key' ? 'tenant-secret-key' : undefined,
  ),
}));

import type { AppConfig } from '@librechat/data-schemas';
import {
  listLangfusePrompts,
  getLangfuseTextPrompt,
  resolveLangfusePromptConnection,
  LangfusePromptRequestError,
  type LangfusePromptConnection,
} from './prompts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeConnection(
  overrides: Partial<LangfusePromptConnection> = {},
): LangfusePromptConnection {
  return {
    baseUrl: 'https://cloud.langfuse.test',
    authorization: 'Basic cGs6c2s=',
    ...overrides,
  };
}

function appConfigWithLangfuse(langfuse?: AppConfig['langfuse']): AppConfig {
  return { langfuse } as AppConfig;
}

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  clearLangfuseEnv();
  fetchMock = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  clearLangfuseEnv();
  fetchMock.mockRestore();
  jest.clearAllMocks();
});

describe('listLangfusePrompts', () => {
  it('passes through only the defined query params, sends no filter, and keeps every type', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            name: 'greeting',
            type: 'text',
            versions: [1, 2],
            labels: ['production'],
            tags: ['demo'],
            lastUpdatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            name: 'support-chat',
            type: 'chat',
            versions: [1],
            labels: [],
            tags: [],
            lastUpdatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        meta: { page: 1, limit: 10, totalItems: 2, totalPages: 1 },
      }),
    );

    const result = await listLangfusePrompts(
      conn,
      { name: 'greeting', label: 'production', page: 1, limit: 10 },
      { timeoutMs: 5000 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://cloud.langfuse.test/api/public/v2/prompts?name=greeting&label=production&page=1&limit=10',
    );
    expect(url).not.toContain('filter');
    expect(init).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: conn.authorization }),
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ name: 'greeting', type: 'text' });
    expect(result.items[1]).toMatchObject({ name: 'support-chat', type: 'chat' });
    expect(result.meta).toEqual({ page: 1, limit: 10, totalItems: 2, totalPages: 1 });
  });

  it('omits undefined query params entirely', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [], meta: { page: 1, limit: 10, totalItems: 0, totalPages: 0 } }),
    );

    await listLangfusePrompts(conn, {}, { timeoutMs: 5000 });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.langfuse.test/api/public/v2/prompts');
  });

  it('sends tag, fromUpdatedAt and toUpdatedAt as given', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [], meta: { page: 1, limit: 10, totalItems: 0, totalPages: 0 } }),
    );

    await listLangfusePrompts(
      conn,
      {
        tag: 'demo',
        fromUpdatedAt: '2026-01-01T00:00:00.000Z',
        toUpdatedAt: '2026-02-01T00:00:00.000Z',
      },
      { timeoutMs: 5000 },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://cloud.langfuse.test/api/public/v2/prompts?tag=demo&fromUpdatedAt=2026-01-01T00%3A00%3A00.000Z&toUpdatedAt=2026-02-01T00%3A00%3A00.000Z',
    );
  });
});

describe('getLangfuseTextPrompt', () => {
  it('gets a text prompt by the production label and URL-encodes the name', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'a/b c',
        version: 3,
        type: 'text',
        labels: ['production'],
        prompt: 'Hello {{name}}',
      }),
    );

    const result = await getLangfuseTextPrompt(
      conn,
      'a/b c',
      { label: 'production' },
      { timeoutMs: 5000 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.langfuse.test/api/public/v2/prompts/a%2Fb%20c?label=production',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: conn.authorization }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { name: 'a/b c', version: 3, labels: ['production'], prompt: 'Hello {{name}}' },
    });
  });

  it('URL-encodes a prompt name containing a path separator', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'folder/name',
        version: 1,
        type: 'text',
        labels: ['production'],
        prompt: 'Hello {{name}}',
      }),
    );

    const result = await getLangfuseTextPrompt(
      conn,
      'folder/name',
      { label: 'production' },
      { timeoutMs: 5000 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.langfuse.test/api/public/v2/prompts/folder%2Fname?label=production',
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: { name: 'folder/name', version: 1, labels: ['production'], prompt: 'Hello {{name}}' },
    });
  });

  it('gets a text prompt by an exact version', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({ name: 'greeting', version: 2, type: 'text', labels: [], prompt: 'Hi there' }),
    );

    const result = await getLangfuseTextPrompt(
      conn,
      'greeting',
      { version: 2 },
      { timeoutMs: 5000 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.langfuse.test/api/public/v2/prompts/greeting?version=2',
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: { name: 'greeting', version: 2, labels: [], prompt: 'Hi there' },
    });
  });

  it('rejects a chat prompt as unsupported_type without returning its content', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'support-chat',
        version: 1,
        type: 'chat',
        labels: ['production'],
        prompt: [{ role: 'system', content: 'secret system content' }],
      }),
    );

    const result = await getLangfuseTextPrompt(
      conn,
      'support-chat',
      { label: 'production' },
      { timeoutMs: 5000 },
    );

    expect(result).toEqual({ ok: false, error: { code: 'unsupported_type' } });
    expect(JSON.stringify(result)).not.toContain('secret system content');
  });

  it('reports not_found on a 404', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const result = await getLangfuseTextPrompt(
      conn,
      'missing',
      { label: 'production' },
      { timeoutMs: 5000 },
    );

    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

describe('Langfuse prompt request errors', () => {
  it.each([401, 403])('maps a %i response to unauthorized', async (status) => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('maps a 500 response to upstream with the status, never forwarding the body', async () => {
    const conn = makeConnection({ authorization: 'Basic cGs6c2VjcmV0LWtleQ==' });
    fetchMock.mockResolvedValue(jsonResponse({ message: 'MARKER_SECRET_LEAK_TOKEN' }, 500));

    const error: unknown = await listLangfusePrompts(conn, {}, { timeoutMs: 5000 }).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(LangfusePromptRequestError);
    const requestError = error as LangfusePromptRequestError;
    expect(requestError.code).toBe('upstream');
    expect(requestError.status).toBe(500);
    expect(requestError.message).not.toContain('MARKER_SECRET_LEAK_TOKEN');
    expect(requestError.message).not.toContain(conn.authorization);
    expect(JSON.stringify(requestError)).not.toContain('MARKER_SECRET_LEAK_TOKEN');
    expect(JSON.stringify(requestError)).not.toContain(conn.authorization);
  });

  it('maps a timeout to timeout', async () => {
    const conn = makeConnection();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('maps an abort to timeout', async () => {
    const conn = makeConnection();
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValue(abort);

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('maps a body read aborted by timeout to timeout, not invalid_response', async () => {
    const conn = makeConnection();
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(abort),
    } as unknown as Response);

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('maps a network error to upstream without a status', async () => {
    const conn = makeConnection();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error: unknown = await listLangfusePrompts(conn, {}, { timeoutMs: 5000 }).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(LangfusePromptRequestError);
    const requestError = error as LangfusePromptRequestError;
    expect(requestError.code).toBe('upstream');
    expect(requestError.status).toBeUndefined();
  });

  it('maps unparseable JSON to invalid_response', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('maps a response with the wrong shape to invalid_response', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(jsonResponse({ data: 'not-an-array' }));

    await expect(listLangfusePrompts(conn, {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('maps a get response with the wrong shape to invalid_response', async () => {
    const conn = makeConnection();
    fetchMock.mockResolvedValue(jsonResponse({ name: 'greeting' }));

    await expect(
      getLangfuseTextPrompt(conn, 'greeting', { label: 'production' }, { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('resolveLangfusePromptConnection', () => {
  it('resolves the central env project in single-tenant mode when env keys are set', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';

    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'us',
      }),
    );

    expect(conn).toEqual({
      baseUrl: 'https://cloud.langfuse.com',
      authorization: `Basic ${Buffer.from('env-public:env-secret').toString('base64')}`,
    });
  });

  it('resolves the tenant stored connection in single-tenant mode without env keys', () => {
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'us=https://us.cloud.langfuse.example';

    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'us',
      }),
    );

    expect(conn).toEqual({
      baseUrl: 'https://us.cloud.langfuse.example',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
  });

  it('uses only the tenant connection in multi-tenant mode, even when env keys are set', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.TENANT_ISOLATION_STRICT = 'true';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector:4318';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'us=https://us.cloud.langfuse.example';

    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'us',
      }),
    );

    expect(conn).toEqual({
      baseUrl: 'https://us.cloud.langfuse.example',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
  });

  it('uses only the tenant connection for a tenant user while strict isolation is off', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'us=https://us.cloud.langfuse.example';

    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'us',
      }),
      { tenantId: 'tenant-a' },
    );

    expect(conn).toEqual({
      baseUrl: 'https://us.cloud.langfuse.example',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
  });

  it('returns null for a tenant user with no stored connection, even when env keys exist', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';

    const conn = resolveLangfusePromptConnection(appConfigWithLangfuse(undefined), {
      tenantId: 'tenant-a',
    });

    expect(conn).toBeNull();
  });

  it('returns null in multi-tenant mode with no stored connection, even when env keys exist', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
    process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    process.env.TENANT_ISOLATION_STRICT = 'true';

    const conn = resolveLangfusePromptConnection(appConfigWithLangfuse(undefined));

    expect(conn).toBeNull();
  });

  it('returns null when the stored connection has no destination', () => {
    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
      }),
    );

    expect(conn).toBeNull();
  });

  it('returns null when the stored connection names an unknown destination', () => {
    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'not-a-real-destination',
      }),
    );

    expect(conn).toBeNull();
  });

  it('returns null when the stored secret cannot be decrypted', () => {
    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        publicKey: 'tenant-public-key',
        secretKey: 'not-encrypted',
        destination: 'us',
      }),
    );

    expect(conn).toBeNull();
  });

  it('resolves the stored connection even when tracing is disabled for the tenant', () => {
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'us=https://us.cloud.langfuse.example';

    const conn = resolveLangfusePromptConnection(
      appConfigWithLangfuse({
        enabled: false,
        publicKey: 'tenant-public-key',
        secretKey: 'v3:test:tenant-secret-key',
        destination: 'us',
      }),
    );

    expect(conn).toEqual({
      baseUrl: 'https://us.cloud.langfuse.example',
      authorization: `Basic ${Buffer.from('tenant-public-key:tenant-secret-key').toString('base64')}`,
    });
  });
});
