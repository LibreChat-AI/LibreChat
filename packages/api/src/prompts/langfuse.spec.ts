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
    sourceProjectId: 'project-1',
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
        sourceUrl: 'https://cloud.langfuse.test/project/project-1/prompts/greeting',
      },
    });
  });

  it('builds sourceUrl from the connection base URL, the project id and the encoded prompt name', async () => {
    const scopedConnection: LangfusePromptConnection = {
      baseUrl: 'https://host.test/lf/',
      authorization: 'Basic cGs6c2s=',
    };
    const resolveSource = jest.fn().mockResolvedValue({
      ok: true,
      connection: scopedConnection,
    } satisfies LangfuseSourceResolution);
    const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: 'support/greeting one',
        version: 1,
        type: 'text',
        labels: ['production'],
        prompt: 'Hi',
      }),
    );

    const result = await adapter.resolvePrompt({
      group: makeGroup({ sourcePromptName: 'support/greeting one', sourceProjectId: 'proj 1' }),
      selection: { type: 'production' },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceUrl: 'https://host.test/lf/project/proj%201/prompts/support%2Fgreeting%20one',
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
        sourceUrl: 'https://cloud.langfuse.test/project/project-1/prompts/greeting',
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

  describe('listRevisions', () => {
    function listResponse(
      items: Array<{
        name?: string;
        type?: 'text' | 'chat';
        versions?: number[];
      }>,
      totalItems: number,
    ) {
      return jsonResponse({
        data: items.map((item) => ({
          name: 'greeting',
          type: 'text',
          versions: [1],
          labels: [],
          tags: [],
          lastUpdatedAt: '2026-01-01T00:00:00.000Z',
          ...item,
        })),
        meta: { page: 1, limit: 1, totalItems, totalPages: 1 },
      });
    }

    it('sends a filter with the name condition only, page 1 and limit 1, no type', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse([{ versions: [1, 2, 3] }], 1));

      await adapter.listRevisions({ group: makeGroup() });

      const [url] = fetchMock.mock.calls[0];
      const parsedUrl = new URL(url as string);
      expect(parsedUrl.searchParams.get('page')).toBe('1');
      expect(parsedUrl.searchParams.get('limit')).toBe('1');
      expect(parsedUrl.searchParams.get('name')).toBe('greeting');
      expect(JSON.parse(parsedUrl.searchParams.get('filter') as string)).toEqual([
        { type: 'string', column: 'name', operator: '=', value: 'greeting' },
      ]);
    });

    it('forwards the configured timeout to listPrompts', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 7000 });
      fetchMock.mockResolvedValue(listResponse([{ versions: [1] }], 1));
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

      await adapter.listRevisions({ group: makeGroup() });

      // Mirrors the `resolvePrompt` default-timeout test: asserts the timeout
      // the adapter was configured with reaches the request `listPrompts`
      // makes, rather than some other value or the shared default.
      expect(timeoutSpy).toHaveBeenCalledWith(7000);
      timeoutSpy.mockRestore();
    });

    it('lists versions newest first for a matched text prompt', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse([{ versions: [1, 3, 2] }], 1));

      const result = await adapter.listRevisions({ group: makeGroup() });

      expect(result).toEqual({
        ok: true,
        value: {
          source: 'langfuse',
          groupId: 'group-1',
          revisions: [
            { source: 'langfuse', version: 3 },
            { source: 'langfuse', version: 2 },
            { source: 'langfuse', version: 1 },
          ],
        },
      });
    });

    it('returns source_not_found when no items and totalItems is 0', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse([], 0));

      const result = await adapter.listRevisions({ group: makeGroup() });

      expect(result).toEqual({
        ok: false,
        error: { type: 'source_not_found', source: 'langfuse' },
      });
    });

    it('returns unsupported_content chat_prompt for a matched chat prompt', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse([{ type: 'chat', versions: [1] }], 1));

      const result = await adapter.listRevisions({ group: makeGroup() });

      expect(result).toEqual({
        ok: false,
        error: { type: 'unsupported_content', reason: 'chat_prompt' },
      });
    });

    it('returns source_unavailable not_configured when the group has no sourcePromptName, without fetching', async () => {
      const resolveSource = jest.fn();
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });

      const result = await adapter.listRevisions({
        group: makeGroup({ sourcePromptName: undefined }),
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

        const result = await adapter.listRevisions({ group: makeGroup() });

        expect(result).toEqual({
          ok: false,
          error: { type: 'source_unavailable', source: 'langfuse', reason },
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('propagates a thrown LangfusePromptRequestError from the list request', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      expect.assertions(2);
      try {
        await adapter.listRevisions({ group: makeGroup() });
      } catch (error) {
        expect(error).toBeInstanceOf(LangfusePromptRequestError);
        expect(error).toMatchObject({ code: 'unauthorized' });
      }
    });

    it.each<[string, Array<{ name?: string; versions?: number[] }>, number]>([
      ['a returned name that differs from sourcePromptName', [{ name: 'other', versions: [1] }], 1],
      ['totalItems greater than 1 despite one item', [{ versions: [1] }], 2],
      ['items present but totalItems is 0', [{ versions: [1] }], 0],
      ['no items despite totalItems greater than 0', [], 1],
      ['a matched text prompt with no versions', [{ versions: [] }], 1],
    ])('throws invalid_response for %s', async (_label, items, totalItems) => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse(items, totalItems));

      await expect(adapter.listRevisions({ group: makeGroup() })).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    it('does not include credentials or a URL in a successful result', async () => {
      const resolveSource = jest.fn().mockResolvedValue(okResolution());
      const adapter = createLangfusePromptAdapter({ resolveSource, timeoutMs: () => 5000 });
      fetchMock.mockResolvedValue(listResponse([{ versions: [1] }], 1));

      const result = await adapter.listRevisions({ group: makeGroup() });

      expect(JSON.stringify(result)).not.toMatch(/authorization|cloud\.langfuse\.test/i);
    });
  });
});
