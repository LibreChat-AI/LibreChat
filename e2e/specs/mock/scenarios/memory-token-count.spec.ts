import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * A long memory stores its real o200k token count, including when it is the first thing the
 * server tokenizes after startup, so the stored figure never stands in for its byte length.
 */

const PASSWORD = 'Memory-Tokens-1!';
/** Over the tokenizer's 4 KiB slice length, where the cold-start estimate was the byte length. */
const LONG_VALUE = 'The user prefers concise answers about gardening. '.repeat(100).trim();
/** Two of these exceed the e2e `memory.tokenLimit` (10000) only when counted as bytes. */
const LIMIT_VALUE = 'The user keeps a vegetable garden and tracks rainfall. '.repeat(160).trim();

type Session = { headers: Record<string, string> };
type StoredMemory = { key: string; value: string; tokenCount: number; id?: string; _id?: string };
type MemoryList = { memories: StoredMemory[]; totalTokens: number; tokenLimit: number | null };

async function signUp(request: APIRequestContext): Promise<Session> {
  const email = `memory-tokens-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: 'Memory Tokens', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function listMemories(request: APIRequestContext, session: Session): Promise<MemoryList> {
  const response = await request.get('/api/memories', { headers: session.headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as MemoryList;
}

async function storedMemory(
  request: APIRequestContext,
  session: Session,
  key: string,
): Promise<StoredMemory> {
  const { memories } = await listMemories(request, session);
  const memory = memories.find((entry) => entry.key === key);
  expect(memory).toBeDefined();
  return memory as StoredMemory;
}

/** A real o200k count for English prose is several times smaller than its byte length. */
function expectRealTokenCount(tokenCount: number, value: string) {
  expect(tokenCount).toBeGreaterThan(0);
  expect(tokenCount).toBeLessThan(Buffer.byteLength(value, 'utf8') / 3);
}

test.describe('memory token counts', () => {
  test('a long memory created through the API stores its real token count @scenario:long-memory-create-stores-real-token-count', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const created = await request.post('/api/memories', {
        headers: session.headers,
        data: { key: 'long_story', value: LONG_VALUE },
      });
      expect(created.status()).toBe(201);

      const memory = await storedMemory(request, session, 'long_story');
      expectRealTokenCount(memory.tokenCount, LONG_VALUE);
    } finally {
      await request.dispose();
    }
  });

  test('a memory updated to a long value stores its real token count @scenario:long-memory-update-stores-real-token-count', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const created = await request.post('/api/memories', {
        headers: session.headers,
        data: { key: 'garden_notes', value: 'Short note.' },
      });
      expect(created.status()).toBe(201);

      const updated = await request.patch('/api/memories/garden_notes', {
        headers: session.headers,
        data: { value: LONG_VALUE },
      });
      expect(updated.status()).toBe(200);

      const memory = await storedMemory(request, session, 'garden_notes');
      expect(memory.value).toBe(LONG_VALUE);
      expectRealTokenCount(memory.tokenCount, LONG_VALUE);
    } finally {
      await request.dispose();
    }
  });

  test('a memory updated by id to a long value stores its real token count @scenario:long-memory-update-by-id-stores-real-token-count', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const created = await request.post('/api/memories', {
        headers: session.headers,
        data: { key: 'by_id_notes', value: 'Short note.' },
      });
      expect(created.status()).toBe(201);
      const original = await storedMemory(request, session, 'by_id_notes');
      const id = original.id ?? original._id;
      expect(id).toBeTruthy();

      const updated = await request.patch(`/api/memories/id/${encodeURIComponent(String(id))}`, {
        headers: session.headers,
        data: { value: LONG_VALUE },
      });
      expect(updated.status()).toBe(200);

      const memory = await storedMemory(request, session, 'by_id_notes');
      expect(memory.value).toBe(LONG_VALUE);
      expectRealTokenCount(memory.tokenCount, LONG_VALUE);
    } finally {
      await request.dispose();
    }
  });

  test('two long memories both save under the token limit @scenario:long-memories-fit-under-token-limit', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      for (const key of ['garden_first', 'garden_second']) {
        const created = await request.post('/api/memories', {
          headers: session.headers,
          data: { key, value: LIMIT_VALUE },
        });
        expect(created.status()).toBe(201);
      }

      const { memories, totalTokens, tokenLimit } = await listMemories(request, session);
      expect(memories.map((memory) => memory.key).sort()).toEqual([
        'garden_first',
        'garden_second',
      ]);
      expect(tokenLimit).toBeGreaterThan(0);
      expect(2 * Buffer.byteLength(LIMIT_VALUE, 'utf8')).toBeGreaterThan(tokenLimit as number);
      expect(totalTokens).toBeLessThan(tokenLimit as number);
      memories.forEach((memory) => expectRealTokenCount(memory.tokenCount, LIMIT_VALUE));
    } finally {
      await request.dispose();
    }
  });
});
