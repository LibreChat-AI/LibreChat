import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { inOneProject } from './lint.helpers';
import { withMongo } from '../db';

/**
 * A theme a DB config override supplies is merged after the YAML loader ran, so the service
 * applies the loader's rules itself: unknown colors are left out of what `/api/config` serves,
 * and an override theme the client would reject leaves the principal with the base theme.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

type InterfaceBody = { interface?: { theme?: unknown; customWelcome?: string } };

/** A sibling field the override also sets, so a check never passes before the override applies. */
const MARKER = 'e2e theme override applied';

async function getPrimaryUserId(): Promise<string> {
  const { email } = getPrimaryE2EUser();
  const id = await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email }, { projection: { _id: 1 } });
    return user?._id?.toString();
  });
  if (!id) {
    throw new Error('primary user id not found');
  }
  return id;
}

async function withThemeOverride(
  request: APIRequestContext,
  theme: unknown,
  check: (token: string) => Promise<void>,
): Promise<void> {
  const token = await loginAdmin(request);
  const headers = { Authorization: `Bearer ${token}` };
  const path = `/api/admin/config/user/${encodeURIComponent(await getPrimaryUserId())}`;
  const saved = await request.put(path, {
    headers,
    data: { overrides: { interface: { theme, customWelcome: MARKER } } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  try {
    await check(token);
  } finally {
    const removed = await request.delete(path, { headers, failOnStatusCode: false });
    expect([200, 404], await removed.text()).toContain(removed.status());
  }
}

async function servedInterface(
  request: APIRequestContext,
  token: string,
): Promise<InterfaceBody['interface']> {
  const config = await requestResult(request, { path: '/api/config', token });
  return (config.body as InterfaceBody | undefined)?.interface;
}

async function servedOverrideTheme(request: APIRequestContext, token: string): Promise<unknown> {
  let served: InterfaceBody['interface'];
  await expect
    .poll(async () => {
      served = await servedInterface(request, token);
      return served?.customWelcome;
    })
    .toBe(MARKER);
  return served?.theme;
}

test.describe('interface.theme from a config override', () => {
  test.beforeEach(() => inOneProject());

  test('an override theme with an unknown color token is served without it @scenario:override-theme-unknown-color-left-out', async ({
    request,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-override',
      modes: { light: { colors: { 'rgb-surface-primary': '1 2 3', 'surface-future': '4 5 6' } } },
    };
    await withThemeOverride(request, theme, async (token) => {
      expect(await servedOverrideTheme(request, token)).toEqual({
        version: 1,
        name: 'e2e-override',
        modes: { light: { colors: { 'rgb-surface-primary': '1 2 3' } } },
      });
    });
  });

  test('an invalid override theme leaves the user with the base theme @scenario:override-theme-invalid-keeps-base', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const base = (await servedInterface(request, token))?.theme;
    const theme = {
      version: 1,
      name: 'e2e-override-invalid',
      modes: { dark: { colors: { 'rgb-surface-primary': '300 16 32' } } },
    };
    await withThemeOverride(request, theme, async (overrideToken) => {
      expect(await servedOverrideTheme(request, overrideToken)).toEqual(base);
    });
  });
});
