import AxeBuilder from '@axe-core/playwright';
import type { ChannelLinkView } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const ticket = 'Browser_-09'.repeat(5).slice(0, 43);
const storageKey = 'channel_link_pending_ticket';
const account = {
  id: 'handoff-user',
  _id: 'handoff-user',
  name: 'Browser account',
  username: 'handoff',
  email: 'handoff@example.com',
  provider: 'local',
  role: 'USER',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test.use({
  storageState: { cookies: [], origins: [] },
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

/** Every API call is intercepted, including auth, so this spec needs no database or real user. */
async function mockLinkApi(page: Page) {
  const fixture = {
    signedIn: false,
    state: 'pending' as ChannelLinkView['state'],
    previews: [] as object[],
    accepts: [] as object[],
    requests: [] as string[],
  };
  page.on('request', (request) => fixture.requests.push(request.url()));
  const view = (): ChannelLinkView => ({
    linkId: 'browser-link',
    revision: 'browser-revision',
    state: fixture.state,
    expiresAtMs: Date.now() + 600_000,
    identity: {
      provider: 'discord',
      tenantId: '_',
      channelId: 'browser-binding',
      channelRevision: 'binding-revision',
      applicationId: '123456789012345678',
      guildId: '223456789012345678',
      externalUserId: '323456789012345678',
      agentId: 'browser-agent',
    },
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: object = {};
    if (path.endsWith('/api/auth/refresh')) {
      if (!fixture.signedIn) {
        await route.fulfill({ status: 200, body: 'Refresh token not provided' });
        return;
      }
      body = { token: 'browser-auth-token', user: account };
    } else if (path.endsWith('/api/auth/login')) {
      expect(request.postDataJSON()).toEqual({
        email: account.email,
        password: 'browser-password',
      });
      fixture.signedIn = true;
      body = { token: 'browser-auth-token', user: account };
    } else if (path.endsWith('/api/user')) body = account;
    else if (path.endsWith('/api/config')) {
      body = { appTitle: 'LibreChat', emailLoginEnabled: true, interface: {} };
    } else if (path.includes('/api/roles/')) body = { name: 'USER', permissions: {} };
    else if (path.endsWith('/api/agents/browser-agent')) body = { name: 'Browser agent' };
    else if (path.endsWith('/api/channels/links/preview')) {
      expect(fixture.signedIn).toBe(true);
      fixture.previews.push(request.postDataJSON());
      body = { ok: true, value: view() };
    } else if (path.endsWith('/api/channels/links/accept')) {
      expect(fixture.signedIn).toBe(true);
      fixture.accepts.push(request.postDataJSON());
      fixture.state = 'accepted';
      body = { ok: true, value: view() };
    } else expect(request.method(), `Unexpected write to ${path}`).toBe('GET');
    await route.fulfill({ json: body });
  });
  return fixture;
}

async function openHandoff(page: Page) {
  await page.goto(`/channels/link#${ticket}`);
  await expect(page.getByRole('heading', { name: 'Connect to LibreChat' })).toBeVisible();
  expect(page.url()).not.toContain(ticket);
}

async function expectPhoneLayout(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  const result = await new AxeBuilder({ page }).include('main').analyze();
  expect(result.violations).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`private phone handoff is keyboard accessible at phone width (${theme}) @scenario:channel-link-phone-${theme}`, async ({
    page,
  }) => {
    const fixture = await mockLinkApi(page);
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    await openHandoff(page);
    expect(fixture.previews).toEqual([]);
    await expect(page.getByText(account.email)).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const phone = page.getByRole('button', { name: 'Use my phone', exact: true });
    await expect(phone).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(phone).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByText('This address only works on this computer.', { exact: false }),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Private account linking URL')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeFocused();
    await expectPhoneLayout(page);
    expect(fixture.requests.some((url) => url.includes(ticket))).toBe(false);
    await page.screenshot({
      path: test.info().outputPath(`channel-handoff-${theme}.png`),
      fullPage: true,
    });
  });
}

test('the private ticket survives login and browser consent waits for Discord confirmation @scenario:channel-link-login-confirmation', async ({
  page,
}) => {
  const fixture = await mockLinkApi(page);
  await openHandoff(page);
  await page.getByRole('button', { name: 'Continue here', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  // Login banks the return path in tab storage before a session refresh can normalize its URL.
  expect(await page.evaluate(() => sessionStorage.getItem('post_login_redirect_to'))).toBe(
    '/channels/link',
  );
  expect(page.url()).not.toContain(ticket);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill('browser-password');
  await page.getByTestId('login-button').click();
  await expect(
    page.getByRole('heading', { name: 'Connect your account to Discord' }),
  ).toBeVisible();
  expect(fixture.previews).toContainEqual({ ticket });
  await expect(page.getByText(account.email, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Link account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'One more step in Discord' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Return to the original Discord channel');
  expect(fixture.accepts).toEqual([{ ticket, revision: 'browser-revision' }]);
  expect(fixture.state).toBe('accepted');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBeNull();
  // The native actor confirmation is represented by a new authoritative preview, never a browser write.
  fixture.state = 'active';
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible();
  expect(fixture.accepts).toHaveLength(1);
  expect(fixture.requests.some((url) => url.includes(ticket))).toBe(false);
  await page.screenshot({
    path: test.info().outputPath('channel-link-confirmed.png'),
    fullPage: true,
  });
});

test('failed clipboard copying leaves a selectable private link @scenario:channel-link-clipboard-recovery', async ({
  page,
}) => {
  await mockLinkApi(page);
  await page.addInitScript(() => {
    document.execCommand = () => false;
    window.prompt = () => null;
  });
  await openHandoff(page);
  await page.getByRole('button', { name: 'Use my phone', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(
    page.getByText('Copy did not work. Select the text above and copy it manually.'),
  ).toBeVisible();
  const input = page.getByLabel('Private account linking URL');
  await input.focus();
  expect(
    await input.evaluate((node: HTMLInputElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      length: node.value.length,
    })),
  ).toEqual({
    start: 0,
    end: (await input.inputValue()).length,
    length: (await input.inputValue()).length,
  });
  await expectPhoneLayout(page);
});

test('an expired ticket closes the phone handoff and offers safe recovery @scenario:channel-link-expired-recovery', async ({
  page,
}) => {
  const fixture = await mockLinkApi(page);
  await page.clock.install();
  await page.addInitScript(
    ({ key, value }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({ ticket: value, savedAt: Date.now(), expiresAtMs: Date.now() + 60_000 }),
      );
    },
    { key: storageKey, value: ticket },
  );
  await page.goto('/channels/link');
  await page.getByRole('button', { name: 'Use my phone', exact: true }).click();
  await expect(page.getByLabel('Private account linking URL')).toBeVisible();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole('heading', { name: "This link can't be used" })).toBeVisible();
  await expect(page.getByLabel('Private account linking URL')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to LibreChat' })).toHaveAttribute('href', '/');
  expect(fixture.previews).toEqual([]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBeNull();
  await expectPhoneLayout(page);
  await page.screenshot({
    path: test.info().outputPath('channel-handoff-expired.png'),
    fullPage: true,
  });
});
