import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';

const PASSWORD = 'Assistants-Deletion-1!';
const MODEL = 'gpt-4o-mini';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
/** The chat routes refuse a client that does not identify as a browser. */
const BROWSER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The fake Assistants server answers `E2E_ASSISTANT_SLOW` with 120 deltas, one every 250ms. */
const SLOW_PROMPT = 'E2E_ASSISTANT_SLOW';
const FIRST_CHUNK = 'achunk-003';
const LAST_CHUNK = 'achunk-120';

type Version = 'v1' | 'v2';

interface RunStream {
  transcript: () => string;
  finished: () => boolean;
  close: () => void;
}

interface Account {
  token: string;
  userId: string;
}

async function registerAndLogin(request: APIRequestContext): Promise<Account> {
  const email = `assistants-deletion-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: 'Assistants Deletion', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token, user } = (await login.json()) as {
    token: string;
    user: { _id?: string; id?: string };
  };
  return { token, userId: (user._id ?? user.id) as string };
}

/** Starts an Assistants turn and keeps reading its event stream in the background. */
async function startRun(
  baseURL: string,
  version: Version,
  token: string,
  body: Record<string, unknown>,
): Promise<RunStream> {
  const controller = new AbortController();
  const response = await fetch(new URL(`/api/assistants/${version}/chat`, baseURL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_AGENT,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let transcript = '';
  let finished = false;
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        transcript += decoder.decode(value, { stream: true });
      }
    } catch {
      /* the connection was closed by the server or by the test */
    }
    finished = true;
  })();
  return {
    transcript: () => transcript,
    finished: () => finished,
    close: () => controller.abort(),
  };
}

/**
 * Deletes the account while a slow assistant run is streaming. Erasure has to stop the run and
 * wait for it, so the run cannot write the conversation back for a user who no longer exists.
 */
async function deleteAccountMidRun(
  { playwright, baseURL }: Pick<PlaywrightWorkerArgs, 'playwright'> & { baseURL?: string },
  version: Version,
) {
  const request = await playwright.request.newContext({ baseURL });
  let conversationId: string | undefined;
  let run: RunStream | undefined;
  try {
    const { token, userId } = await registerAndLogin(request);
    const headers = { Authorization: `Bearer ${token}` };

    const created = await request.post(`/api/assistants/${version}`, {
      headers,
      data: { endpoint: 'assistants', model: MODEL, name: `E2E deletion drain ${version}` },
    });
    expect(created.ok()).toBeTruthy();
    const { id: assistantId } = (await created.json()) as { id: string };

    run = await startRun(baseURL!, version, token, {
      text: `${SLOW_PROMPT}:${randomUUID().slice(0, 8)}`,
      sender: 'User',
      endpoint: 'assistants',
      model: MODEL,
      assistant_id: assistantId,
      messageId: randomUUID(),
      parentMessageId: NO_PARENT,
      conversationId: null,
      isCreatedByUser: true,
      clientTimestamp: new Date().toISOString(),
    });
    await expect.poll(() => run!.transcript(), { timeout: 30_000 }).toContain(FIRST_CHUNK);
    conversationId = /"conversationId":"([0-9a-f-]{36})"/.exec(run.transcript())?.[1];
    expect(conversationId).toBeTruthy();

    const deletion = await request.delete('/api/user/delete', { headers });
    expect(deletion.status()).toBe(200);
    expect(await deletion.json()).toEqual({ message: 'User deleted' });

    /** The run ends, whether it was stopped or left to finish, and writes nothing afterwards. */
    await expect.poll(() => run!.finished(), { timeout: 60_000 }).toBe(true);
    const owner = new ObjectId(userId);
    const remaining = await withMongo(async (db) => ({
      messages: await db
        .collection('messages')
        .countDocuments({ $or: [{ conversationId }, { user: userId }] }),
      conversations: await db
        .collection('conversations')
        .countDocuments({ $or: [{ conversationId }, { user: userId }] }),
      transactions: await db.collection('transactions').countDocuments({ user: owner }),
      balances: await db.collection('balances').countDocuments({ user: owner }),
    }));
    expect(remaining).toEqual({ messages: 0, conversations: 0, transactions: 0, balances: 0 });
    /** Erasure stopped the run rather than waiting out the rest of its stream. */
    expect(run.transcript().includes(LAST_CHUNK)).toBe(false);
  } finally {
    run?.close();
    if (conversationId) {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
    await request.dispose();
  }
}

test.describe('assistants account deletion', () => {
  test('an account deleted while an assistant v2 run streams leaves nothing behind @scenario:assistants-run-drained-before-account-deletion', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    await deleteAccountMidRun({ playwright, baseURL }, 'v2');
  });

  test('an account deleted while an assistant v1 run streams leaves nothing behind @scenario:assistants-v1-run-drained-before-account-deletion', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    await deleteAccountMidRun({ playwright, baseURL }, 'v1');
  });
});
