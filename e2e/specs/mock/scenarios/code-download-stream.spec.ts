import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { CODE_API_BASE } from '../helpers';

/** The route accepts 21-character ids; a fresh file id keeps parallel projects apart. */
const SESSION_ID = 'e2esessionstream00001';
const newFileId = (): string => randomBytes(16).toString('hex').slice(0, 21);
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Starts a download and drops the connection as soon as the first bytes arrive. */
function downloadAndDisconnect(url: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    /** The API rejects requests without a browser user agent before any route runs. */
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': BROWSER_UA,
    };
    const req = http.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`download answered ${res.statusCode}`));
        return;
      }
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => undefined);
  });
}

test.describe('code output downloads', () => {
  /* The fake code API trickles a long body. Once the browser side leaves, LibreChat must close
     its upstream download too instead of holding the connection open, paused, until a timeout. */
  test('leaving a download closes the upstream code download @scenario:abandoned-code-download-closes-upstream', async ({
    playwright,
    baseURL,
    request,
  }) => {
    const client = await playwright.request.newContext({ baseURL });
    try {
      const { email, password } = getE2EUser();
      const login = await client.post('/api/auth/login', { data: { email, password } });
      expect(login.ok()).toBeTruthy();
      const { token } = (await login.json()) as { token: string };

      const fileId = newFileId();
      const slow = await request.post(`${CODE_API_BASE}/__debug/slow-downloads`, {
        data: { fileId, slow: true },
      });
      expect(slow.ok()).toBeTruthy();

      await downloadAndDisconnect(
        new URL(`/api/files/code/download/${SESSION_ID}/${fileId}`, baseURL).toString(),
        token,
      );

      await expect
        .poll(
          async () => {
            const response = await request.get(
              `${CODE_API_BASE}/__debug/downloads?fileId=${fileId}`,
            );
            return ((await response.json()) as { closed: number }).closed;
          },
          { timeout: 5_000, intervals: [250] },
        )
        .toBe(1);
      expect((await client.get('/health')).status()).toBe(200);
      await request.post(`${CODE_API_BASE}/__debug/slow-downloads`, {
        data: { fileId, slow: false },
      });
    } finally {
      await client.dispose();
    }
  });
});
