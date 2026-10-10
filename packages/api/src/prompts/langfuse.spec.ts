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
// this worker may have left Langfuse env vars set, and `../langfuse/destinations`
// reads them at import time for its own warm-up lookup.
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

import type { LangfuseSourceResolution } from '../langfuse/promptSync';
import type { LangfusePromptConnection } from '../langfuse/prompts';
import type { PromptGroupRecord } from './types';
import { LangfusePromptRequestError } from '../langfuse/prompts';
import { createLangfusePromptAdapter } from './langfuse';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const connection: LangfusePromptConnection = {
  baseUrl: 'https://cloud.langfuse.test',
  authorization: 'Basic cGs6c2s=',
};

function makeGroup(overrides: Partial<PromptGroupRecord> = {}): PromptGroupRecord {
  return {
    _id: 'group-1',
    name: 'Langfuse group',
    author: 'author-1',
    authorName: 'Author',
    source: 'langfuse',
    sourcePromptName: 'greeting',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function okResolution(): LangfuseSourceResolution {
  return { ok: true, connection };
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

describe('createLangfusePromptAdapter', () => {
  it('sends label=production and no version for a production selection', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'greeting',
        version: 4,
        type: 'text',
        labels: ['production'],
        prompt: 'Hi {{name}}',
      }),
    );

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'production' },
    });

    expect(resolveSource).toHaveBeenCalledWith(makeGroup());
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.langfuse.test/api/public/v2/prompts/greeting?label=production');
    expect(result).toEqual({
      ok: true,
      value: {
        source: 'langfuse',
        groupId: 'group-1',
        prompt: 'Hi {{name}}',
        type: 'text',
        version: 4,
        labels: ['production'],
      },
    });
  });

  it('sends version=N and no label for a version selection', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(
      jsonResponse({ name: 'greeting', version: 3, type: 'text', labels: [], prompt: 'Hi there' }),
    );

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'version', version: 3 },
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.langfuse.test/api/public/v2/prompts/greeting?version=3');
    expect(result).toEqual({
      ok: true,
      value: {
        source: 'langfuse',
        groupId: 'group-1',
        prompt: 'Hi there',
        type: 'text',
        version: 3,
        labels: [],
      },
    });
  });

  it('returns unsupported_content for a chat prompt without parsing its content', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'support-chat',
        version: 1,
        type: 'chat',
        labels: ['production'],
        prompt: [{ role: 'system', content: 'secret system content' }],
      }),
    );

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'production' },
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'unsupported_content', reason: 'chat_prompt' },
    });
    expect(JSON.stringify(result)).not.toContain('secret system content');
  });

  it('returns source_not_found on a 404', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'production' },
    });

    expect(result).toEqual({ ok: false, error: { type: 'source_not_found', source: 'langfuse' } });
  });

  it('returns unsupported_selection for an exact selection without calling resolveSource or fetch', async () => {
    const resolveSource = jest.fn();
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'exact', promptId: 'prompt-1' },
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'unsupported_selection', source: 'langfuse' },
    });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns source_unavailable not_configured when the group has no sourcePromptName, without calling resolveSource or fetch', async () => {
    const resolveSource = jest.fn();
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });

    const result = await adapter.resolvePrompt({
      group: makeGroup({ sourcePromptName: undefined }),
      selection: { type: 'production' },
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'source_unavailable', source: 'langfuse', reason: 'not_configured' },
    });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'not_configured', 'source_changed'] as const)(
    'passes a resolveSource %s reason through as source_unavailable, without fetching',
    async (reason) => {
      const resolveSource = jest.fn().mockResolvedValue({ ok: false, reason });
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });

      const result = await adapter.resolvePrompt({
        group: makeGroup(),
        selection: { type: 'production' },
      });

      expect(result).toEqual({
        ok: false,
        error: { type: 'source_unavailable', source: 'langfuse', reason },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('throws LangfusePromptRequestError on an unauthorized response rather than returning a result', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    expect.assertions(2);
    try {
      await adapter.resolvePrompt({ group: makeGroup(), selection: { type: 'production' } });
    } catch (error) {
      expect(error).toBeInstanceOf(LangfusePromptRequestError);
      expect(error).toMatchObject({ code: 'unauthorized' });
    }
  });

  it('throws LangfusePromptRequestError on a timeout rather than returning a result', async () => {
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    expect.assertions(2);
    try {
      await adapter.resolvePrompt({ group: makeGroup(), selection: { type: 'production' } });
    } catch (error) {
      expect(error).toBeInstanceOf(LangfusePromptRequestError);
      expect(error).toMatchObject({ code: 'timeout' });
    }
  });

  it('uses the default timeout when none is supplied', async () => {
    delete process.env.LANGFUSE_PROMPT_SYNC_TIMEOUT_MS;
    const resolveSource = jest.fn().mockResolvedValue(okResolution());
    const adapter = createLangfusePromptAdapter({ resolveSource });
    fetchMock.mockResolvedValue(
      jsonResponse({ name: 'greeting', version: 1, type: 'text', labels: [], prompt: 'Hi' }),
    );
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

    const result = await adapter.resolvePrompt({
      group: makeGroup(),
      selection: { type: 'production' },
    });

    // No `timeoutMs` override, so the adapter must fall back to the shared
    // Langfuse prompt-sync default (10 seconds) rather than skip the bound.
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(result).toMatchObject({ ok: true });
    timeoutSpy.mockRestore();
  });
});
