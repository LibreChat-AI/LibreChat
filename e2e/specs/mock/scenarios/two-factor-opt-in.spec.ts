import { expect, test } from '@playwright/test';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';
import { deleteUserByEmail, withMongo } from '../db';

const PASSWORD = 'test1234!';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 6238 with the parameters the server verifies: SHA-1, 30 second steps, six digits. */
function totp(secret: string): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 1000 / 30), 4);
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

type Session = { request: APIRequestContext; token: string };

async function newClient(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
): Promise<APIRequestContext> {
  // The harness trusts one proxy; isolate each client's login rate-limit budget.
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
    },
  });
}

async function signIn(request: APIRequestContext, email: string): Promise<Session> {
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  expect(token).toBeTruthy();
  return { request, token };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function isAuthorized(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.get('/api/user', { headers: bearer(token) });
  return response.ok();
}

async function refreshedToken(request: APIRequestContext): Promise<string | undefined> {
  const response = await request.post('/api/auth/refresh');
  if (!response.ok()) {
    return undefined;
  }
  const body = (await response.json().catch(() => ({}))) as { token?: string };
  return body.token;
}

/** Enables 2FA from account settings with `session` and returns the session confirmation hands back. */
async function optIn(session: Session): Promise<{ token: string; secret: string }> {
  const enable = await session.request.post('/api/auth/2fa/enable', {
    headers: bearer(session.token),
  });
  expect(enable.ok()).toBeTruthy();
  const { otpauthUrl } = (await enable.json()) as { otpauthUrl: string };
  const secret = new URL(otpauthUrl).searchParams.get('secret') ?? '';
  expect(secret).toBeTruthy();

  const confirm = await session.request.post('/api/auth/2fa/confirm', {
    headers: bearer(session.token),
    data: { token: totp(secret) },
  });
  expect(confirm.status()).toBe(200);
  const body = (await confirm.json()) as { token: string; user: { twoFactorEnabled?: boolean } };
  expect(body.token).toBeTruthy();
  expect(body.user.twoFactorEnabled).toBe(true);
  return { token: body.token, secret };
}

async function registerUser(request: APIRequestContext): Promise<string> {
  const email = `opt-in-2fa-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: 'Opt-in 2FA', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  return email;
}

test.describe('opt-in two-factor enrollment', () => {
  test('confirming 2FA from settings ends every other session @scenario:optin-2fa-retires-prior-sessions', async ({
    playwright,
    baseURL,
  }) => {
    const confirming = await newClient(playwright, baseURL);
    const other = await newClient(playwright, baseURL);
    const email = await registerUser(confirming);
    try {
      const confirmingSession = await signIn(confirming, email);
      const otherSession = await signIn(other, email);
      expect(await isAuthorized(other, otherSession.token)).toBe(true);

      const { token } = await optIn(confirmingSession);

      expect(await isAuthorized(confirming, token)).toBe(true);
      expect(await isAuthorized(confirming, confirmingSession.token)).toBe(false);
      expect(await isAuthorized(other, otherSession.token)).toBe(false);
      expect(await refreshedToken(other)).toBeUndefined();

      const rotated = await refreshedToken(confirming);
      expect(rotated).toBeTruthy();
      expect(await isAuthorized(confirming, rotated as string)).toBe(true);

      await withMongo(async (db) => {
        const user = await db.collection('users').findOne({ email });
        expect(user?.twoFactorEnabled).toBe(true);
        expect(user?.twoFactorEnrolledAt).toBeInstanceOf(Date);
      });
    } finally {
      await deleteUserByEmail(email);
      await confirming.dispose();
      await other.dispose();
    }
  });

  test('re-enabling 2FA after disabling it ends the sessions opened in between @scenario:optin-2fa-reenable-retires-sessions', async ({
    playwright,
    baseURL,
  }) => {
    const confirming = await newClient(playwright, baseURL);
    const other = await newClient(playwright, baseURL);
    const email = await registerUser(confirming);
    try {
      const first = await optIn(await signIn(confirming, email));
      const disable = await confirming.post('/api/auth/2fa/disable', {
        headers: bearer(first.token),
        data: { token: totp(first.secret) },
      });
      expect(disable.ok()).toBeTruthy();

      const otherSession = await signIn(other, email);
      expect(await isAuthorized(other, otherSession.token)).toBe(true);

      const second = await optIn({ request: confirming, token: first.token });

      expect(await isAuthorized(confirming, second.token)).toBe(true);
      expect(await isAuthorized(other, otherSession.token)).toBe(false);
      expect(await refreshedToken(other)).toBeUndefined();
    } finally {
      await deleteUserByEmail(email);
      await confirming.dispose();
      await other.dispose();
    }
  });
});
