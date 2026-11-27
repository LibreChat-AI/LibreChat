import { expect, test } from '@playwright/test';
import { getBaseE2EEnv, getE2EBaseURL } from '../../../setup/env';

/** The settings that place the harness; a developer shell or `reviewctl verify` may set any of
 *  them, so each case starts from none and names its own. */
const ADDRESS_KEYS = [
  'E2E_BASE_URL',
  'E2E_HOST',
  'E2E_PORT',
  'E2E_DOMAIN_CLIENT',
  'E2E_DOMAIN_SERVER',
];

/** Resolves the address and server environment a fresh run with `env` would start LibreChat on. */
function resolveHarness(env: Record<string, string>) {
  const saved = new Map(ADDRESS_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ADDRESS_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    const { HOST, PORT, DOMAIN_CLIENT, DOMAIN_SERVER } = getBaseE2EEnv();
    return { baseURL: getE2EBaseURL(), HOST, PORT, DOMAIN_CLIENT, DOMAIN_SERVER };
  } finally {
    for (const [key, value] of saved) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test.describe('harness address', () => {
  test('a run with no address settings serves LibreChat beside a deployment on 3080 @scenario:default-harness-address-leaves-port-3080-free', () => {
    const harness = resolveHarness({});

    expect(harness).toEqual({
      baseURL: 'http://localhost:3180',
      HOST: 'localhost',
      PORT: '3180',
      DOMAIN_CLIENT: 'http://localhost:3180',
      DOMAIN_SERVER: 'http://localhost:3180',
    });
    expect(new URL(harness.baseURL).port).not.toBe('3080');
  });

  test('E2E_BASE_URL moves the server port and both domains together @scenario:explicit-base-url-moves-the-whole-harness', () => {
    const address = 'https://127.0.0.1:3081/';

    expect(resolveHarness({ E2E_BASE_URL: address })).toEqual({
      baseURL: address,
      HOST: '127.0.0.1',
      PORT: '3081',
      DOMAIN_CLIENT: address,
      DOMAIN_SERVER: address,
    });
  });

  test('a spec opens the harness at its configured address @scenario:specs-open-the-harness-at-its-configured-address', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBe(getE2EBaseURL());
    const chat = new URL('/c/', getE2EBaseURL()).href;

    await page.goto('/', { timeout: 10000 });
    await page.waitForURL(/\/c\/new/, { timeout: 10000 });

    expect(page.url().startsWith(chat)).toBe(true);
    await expect(page.getByRole('textbox').first()).toBeVisible();
  });
});
