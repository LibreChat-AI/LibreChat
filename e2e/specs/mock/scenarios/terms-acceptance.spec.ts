import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * `interface.termsOfService.modalAcceptance` is enforced by the server: a user who has not
 * accepted may read but not write. The flag is switched per user through a config override, so
 * every other spec keeps running with the harness default (off). The target user registers
 * unaccepted; the scenarios run in order because accepting is permanent.
 */

type Session = { headers: Record<string, string>; userId: string };

const targetUser = {
  email: `terms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Terms Target',
  password: 'securepassword789',
};

async function login(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<Session> {
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token, user: body } = (await res.json()) as {
    token: string;
    user: { id?: string; _id?: string };
  };
  return { headers: { Authorization: `Bearer ${token}` }, userId: (body.id ?? body._id) as string };
}

function configPath(userId: string): string {
  return `/api/admin/config/user/${userId}`;
}

async function setModalAcceptance(
  request: APIRequestContext,
  admin: Session,
  userId: string,
  modalAcceptance: boolean,
): Promise<void> {
  const res = await request.put(configPath(userId), {
    headers: admin.headers,
    data: {
      overrides: {
        interface: { termsOfService: { modalAcceptance, modalContent: 'E2E terms body' } },
      },
    },
  });
  expect(res.ok()).toBeTruthy();
  await expect
    .poll(
      async () => {
        const config = await request.get('/api/config', { headers: userSession!.headers });
        const body = (await config.json()) as {
          interface?: { termsOfService?: { modalAcceptance?: boolean } };
        };
        return body.interface?.termsOfService?.modalAcceptance === true;
      },
      { timeout: 30000, intervals: [500, 1000, 2000] },
    )
    .toBe(modalAcceptance);
}

async function createAgent(request: APIRequestContext, session: Session) {
  return request.post('/api/agents', {
    headers: session.headers,
    failOnStatusCode: false,
    data: {
      name: 'E2E terms agent',
      provider: 'openAI',
      model: 'gpt-4o',
      model_parameters: {},
      tools: [],
    },
  });
}

type OAuthStart = 'mcp' | 'pull-request';

const oauthStarts: OAuthStart[] = ['mcp', 'pull-request'];

/**
 * What answers a start that gets past the terms check. The mock config has no pull request OAuth
 * app and no pending MCP flow, so each handler turns the request away with a 404 of its own.
 */
const reachedHandler: Record<OAuthStart, Record<string, string>> = {
  mcp: { error: 'Flow not found' },
  'pull-request': { code: 'NOT_CONFIGURED' },
};

/** A read that starts an OAuth flow: the gate lets reads through, so each route asks for itself. */
async function startOAuth(
  request: APIRequestContext,
  session: Session,
  start: OAuthStart,
  method: 'GET' | 'HEAD' = 'GET',
) {
  const mcp = start === 'mcp';
  return request.fetch(
    mcp ? '/api/mcp/e2e-server/oauth/initiate' : '/api/pull-requests/oauth/connect',
    {
      method,
      headers: session.headers,
      params: mcp ? { userId: session.userId, flowId: `${session.userId}:e2e-server` } : {},
      failOnStatusCode: false,
      maxRedirects: 0,
    },
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 20000 });
  await page.getByLabel('Email').fill(targetUser.email);
  await page.getByLabel('Password').fill(targetUser.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\/new/, { timeout: 20000 });
}

let adminSession: Session | undefined;
let userSession: Session | undefined;

test.describe('Server-enforced terms acceptance', () => {
  test.describe.configure({ mode: 'serial' });
  /** The default session belongs to the primary user; each scenario signs the target user in itself. */
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      data: { ...targetUser, confirm_password: targetUser.password },
    });
    expect(res.ok()).toBeTruthy();
    adminSession = await login(request, getPrimaryE2EUser());
    userSession = await login(request, targetUser);
  });

  test.afterAll(async ({ request }) => {
    if (adminSession && userSession) {
      await request.delete(configPath(userSession.userId), { headers: adminSession.headers });
    }
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email: targetUser.email });
      if (!user) {
        return;
      }
      await db.collection('agents').deleteMany({ author: user._id });
      await db.collection('configs').deleteMany({ principalId: user._id.toString() });
      await db.collection('users').deleteOne({ _id: user._id });
    });
  });

  test('a user who has not accepted can still write when modalAcceptance is off @scenario:terms-flag-off-unaffected', async ({
    request,
  }) => {
    const session = userSession as Session;
    const res = await createAgent(request, session);
    expect(res.status(), await res.text()).toBe(201);
  });

  test('with modalAcceptance off, an unaccepted user starts an OAuth flow as before @scenario:terms-oauth-start-flag-off', async ({
    request,
  }) => {
    for (const start of oauthStarts) {
      const res = await startOAuth(request, userSession as Session, start);
      expect(res.status(), start).toBe(404);
      expect(await res.json(), start).toMatchObject(reachedHandler[start]);
    }
  });

  test('an unaccepted user sees the terms modal and every write is refused @scenario:terms-unaccepted-blocked', async ({
    page,
    request,
  }) => {
    await setModalAcceptance(
      request,
      adminSession as Session,
      (userSession as Session).userId,
      true,
    );

    const session = userSession as Session;
    const blocked = await createAgent(request, session);
    expect(blocked.status()).toBe(403);
    expect(((await blocked.json()) as { code: string }).code).toBe('terms_not_accepted');

    const credentialWrite = await request.post('/api/auth/2fa/disable', {
      headers: session.headers,
      failOnStatusCode: false,
    });
    expect(credentialWrite.status()).toBe(403);
    expect(((await credentialWrite.json()) as { code: string }).code).toBe('terms_not_accepted');

    const read = await request.get('/api/user/terms', { headers: session.headers });
    expect(read.ok()).toBeTruthy();
    expect(((await read.json()) as { termsAccepted: boolean }).termsAccepted).toBe(false);

    await signIn(page);
    const dialog = page.getByRole('dialog', { name: 'Terms and Conditions' });
    await expect(dialog).toBeVisible({ timeout: 20000 });
    await expect(dialog.getByText('E2E terms body')).toBeVisible();
  });

  test('an unaccepted user is refused when starting an OAuth flow, by GET or HEAD, without a cookie @scenario:terms-oauth-start-refused', async ({
    request,
  }) => {
    const session = userSession as Session;
    for (const start of oauthStarts) {
      const refused = await startOAuth(request, session, start);
      expect(refused.status(), start).toBe(403);
      expect(((await refused.json()) as { code: string }).code, start).toBe('terms_not_accepted');
      expect(refused.headers()['set-cookie'], start).toBeUndefined();

      const head = await startOAuth(request, session, start, 'HEAD');
      expect(head.status(), `${start} HEAD`).toBe(403);
      expect(head.headers()['set-cookie'], `${start} HEAD`).toBeUndefined();
    }
  });

  test('accepting the terms lets the same user write again @scenario:terms-accept-unblocks', async ({
    page,
    request,
  }) => {
    await signIn(page);
    const dialog = page.getByRole('dialog', { name: 'Terms and Conditions' });
    await expect(dialog).toBeVisible({ timeout: 20000 });
    await dialog.getByRole('button', { name: 'I accept' }).click();
    await expect(dialog).toBeHidden();

    const res = await createAgent(request, userSession as Session);
    expect(res.status(), await res.text()).toBe(201);
  });

  test('once the terms are accepted the same OAuth start reaches its handler @scenario:terms-oauth-start-after-accept', async ({
    request,
  }) => {
    for (const start of oauthStarts) {
      const res = await startOAuth(request, userSession as Session, start);
      expect(res.status(), start).toBe(404);
      expect(await res.json(), start).toMatchObject(reachedHandler[start]);
    }
  });
});
