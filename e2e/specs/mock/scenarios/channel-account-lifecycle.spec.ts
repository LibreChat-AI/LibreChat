import type { ChannelLinkView } from 'librechat-data-provider';
import { appURL } from '../../../setup/authenticate';
import { openAgentBuilder } from '../agents.helpers';
import { expect, test } from '../fixtures';
import { openSidebar } from './sidebar';

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

const SCENARIO = {
  light: '@scenario:channel-confirmation-and-personal-withdrawal-light',
  dark: '@scenario:channel-confirmation-and-personal-withdrawal-dark',
} as const;

for (const mode of ['light', 'dark'] as const) {
  test(`channel confirmation and personal withdrawal use current state (${mode}) ${SCENARIO[mode]}`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Channel lifecycle requires a configured app URL');
    const ticket = 'Ab_-09'.repeat(8).slice(0, 43);
    let state: ChannelLinkView['state'] = 'pending';
    let accepts = 0;
    let revokes = 0;
    const view = () => ({
      identity: {
        tenantId: '_',
        channelId: 'channel-browser',
        channelRevision: 'channel-revision',
        teamId: 'Workspace T1',
        externalUserId: 'U1',
        agentId: 'Agent browser',
      },
      linkId: 'link-browser',
      revision: 'revision-browser',
      state,
      expiresAtMs: Date.now() + 600_000,
    });
    await page.addInitScript((theme) => localStorage.setItem('color-theme', theme), mode);
    await page.route('**/api/auth/refresh', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.route('**/api/channels/links**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/accept')) {
        expect(route.request().postDataJSON()).toEqual({ ticket, revision: 'revision-browser' });
        accepts++;
        state = 'accepted';
      }
      if (route.request().method() === 'DELETE') {
        revokes++;
        state = 'revoked';
      }
      await route.fulfill({
        json: url.pathname.endsWith('/api/channels/links') ? [view()] : { ok: true, value: view() },
      });
    });
    await page.goto(`${appURL(baseURL, 'channels/link')}#${ticket}`);
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe(new URL(appURL(baseURL, 'channels/link')).pathname);
    expect(page.url()).not.toContain(ticket);
    await page.getByRole('button', { name: 'Link account', exact: true }).click();
    await expect(page.locator('main img')).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('main img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await expect(page.getByRole('status')).toContainText('Back in Slack, confirm this account');
    state = 'active';
    // A real focus transition refetches the active query without remounting the route.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('status')).toHaveText('Active');
    expect(accepts).toBe(1);
    if (process.env.E2E_CHANNEL_VISUAL_PREFIX) {
      await page.screenshot({ path: `${process.env.E2E_CHANNEL_VISUAL_PREFIX}-link-${mode}.png` });
    }
    state = 'unavailable';
    await page.goto(appURL(baseURL, 'c/new'));
    await openSidebar(page);
    await page.getByTestId('nav-user').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('tab', { name: 'Account', exact: true }).click();
    const links = settings.getByRole('region', { name: 'Your channel account links' });
    await expect(links.getByRole('status')).toHaveText('Unavailable');
    if (process.env.E2E_CHANNEL_VISUAL_PREFIX) {
      await page.screenshot({
        path: `${process.env.E2E_CHANNEL_VISUAL_PREFIX}-settings-${mode}.png`,
      });
    }
    await settings.getByRole('button', { name: /^Disconnect from agent / }).click();
    expect(revokes).toBe(0);
    const confirmation = page.getByRole('dialog', {
      name: 'Disconnect this account?',
      exact: true,
    });
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(settings.getByRole('status')).toHaveText('Revoked');
    expect(revokes).toBe(1);
    await page.keyboard.press('Escape');
    await page.route('**/api/endpoints', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      config.agents = { ...config.agents, channels: { enabled: true } };
      await route.fulfill({ response, json: config });
    });
    await page.reload();
    const form = await openAgentBuilder(page, { navigate: false });
    await expect(form.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
    await expect(form.getByText('Save this Agent to configure channels.')).toBeVisible();
    await form.getByText('Save this Agent to configure channels.').scrollIntoViewIfNeeded();
    await form.getByRole('heading', { name: 'Channels', exact: true }).scrollIntoViewIfNeeded();
    if (process.env.E2E_CHANNEL_VISUAL_PREFIX) {
      await page.screenshot({
        path: `${process.env.E2E_CHANNEL_VISUAL_PREFIX}-builder-${mode}.png`,
      });
    }
  });
}
