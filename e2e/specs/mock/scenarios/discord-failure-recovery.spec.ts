import type { Page } from '@playwright/test';
import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import translations from '../../../../client/src/locales/en/translation.json';
import { expect, test } from '../fixtures';
import { openSidebar } from './sidebar';

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

const themes = ['light', 'dark'] as const;
const token = 'browser-test-placeholder-token';
const app: DiscordApplication = {
  applicationId: '123456789012345678',
  botUserId: '223456789012345678',
  publicKey: 'a'.repeat(64),
  name: 'Browser application',
  revision: 'app-r1',
  createdBy: 'browser-admin',
  authorityWrites: 0,
};
const guild: DiscordGuild = {
  applicationId: app.applicationId,
  installationId: 'browser-installation',
  guildId: '323456789012345678',
  guildName: 'Browser server',
  revision: 'guild-r1',
  createdBy: 'browser-admin',
  authorityWrites: 0,
  status: 'active',
};

/** Every code the callback redirects with that has its own remedy, and the message it must show. */
const landing = [
  ['discord_forbidden', translations.com_ui_discord_admin],
  ['discord_not_configured', translations.com_ui_discord_disabled],
  ['discord_invalid_state', translations.com_ui_discord_oauth_restart],
  ['discord_invalid_input', translations.com_ui_discord_oauth_restart],
  ['discord_invalid_grant', translations.com_ui_discord_oauth_restart],
  ['discord_application_changed', translations.com_ui_discord_oauth_changed],
  ['discord_installation_changed', translations.com_ui_discord_oauth_changed],
  ['discord_guild_changed', translations.com_ui_discord_guild_changed],
  ['discord_missing_permissions', translations.com_ui_discord_permissions],
  ['discord_unsupported_installation', translations.com_ui_discord_code_grant],
  ['discord_provider_refused', translations.com_ui_discord_oauth_refused],
  ['discord_rate_limited', translations.com_ui_discord_rate_limited],
  ['discord_provider_unavailable', translations.com_ui_discord_provider_unavailable],
  ['discord_timeout', translations.com_ui_discord_provider_unavailable],
  ['discord_transactions_unavailable', translations.com_ui_channels_transaction_required],
] as const;

async function openDiscord(page: Page) {
  await page.goto('/c/new');
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('tab', { name: 'Account', exact: true }).click();
  await settings.getByRole('button', { name: 'Discord', exact: true }).click();
  return page.getByRole('dialog', { name: 'Discord', exact: true });
}

for (const theme of themes) {
  test(`Discord keeps a failed save in view and Refresh returns keyboard focus to its trigger (${theme}) @scenario:discord-failed-save-keyboard-recovery-${theme}`, async ({
    page,
  }) => {
    let current = app;
    let failing = true;
    const writes: Record<string, unknown>[] = [];
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    await page.route('**/api/channels/workspaces**', (route) =>
      route.fulfill({ status: 404, json: { message: 'Unavailable' } }),
    );
    await page.route('**/api/channels/discord/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (method === 'GET' && path.endsWith('/apps')) {
        return route.fulfill({
          json: {
            applications: [current],
            setup: { oauthCallbackUrl: 'https://chat.example/api/channels/discord/callback' },
          },
        });
      }
      if (method === 'GET' && path.endsWith('/guilds')) {
        return route.fulfill({ json: { guilds: [guild] } });
      }
      if (method === 'PUT' && path.endsWith('/apps')) {
        writes.push(request.postDataJSON());
        if (failing) {
          return route.fulfill({
            status: 409,
            json: {
              ok: false,
              error: { code: 'unsupported_installation', message: `Bot ${token} refused` },
            },
          });
        }
        current = { ...current, revision: 'app-r3' };
        return route.fulfill({ json: current });
      }
      return route.fulfill({ status: 400, json: { message: 'Unexpected request' } });
    });

    const discord = await openDiscord(page);
    const update = discord.getByRole('button', {
      name: 'Update credentials for Browser application',
    });
    const botToken = discord.getByLabel('Bot token', { exact: true });
    const save = discord.getByRole('button', { name: 'Save', exact: true });
    await update.click();
    await botToken.fill(token);
    /** Scroll the dialog body so that the notice area above the form is out of view. */
    await discord.hover();
    await page.mouse.wheel(0, 1200);
    await expect(discord.getByLabel('OAuth callback URL')).not.toBeInViewport();

    await save.focus();
    await page.keyboard.press('Enter');
    const failure = discord
      .getByRole('alert')
      .filter({ hasText: translations.com_ui_discord_code_grant });
    await expect(failure).toBeInViewport({ ratio: 1 });
    await expect(failure).toBeFocused();
    expect(await discord.innerText()).not.toContain(token);
    await expect(botToken).toHaveValue('');

    /** The write may have landed elsewhere: only a refresh may reveal the current revision. */
    current = { ...app, revision: 'app-r2' };
    failing = false;
    await page.keyboard.press('Tab');
    await expect(failure.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(failure).toHaveCount(0);
    await expect(botToken).toHaveCount(0);
    await expect(update).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(botToken).toBeFocused();
    await botToken.fill(token);
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(discord.getByText(translations.com_ui_discord_saved)).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ expectedRevision: 'app-r1' });
    expect(writes[1]).toMatchObject({ expectedRevision: 'app-r2', botToken: token });
  });

  test(`Discord callback failures land on a localized, actionable page (${theme}) @scenario:discord-oauth-landing-failures-${theme}`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    for (const [code, message] of landing) {
      await page.goto(`/oauth/error?error=${code}&flow=flow-a`);
      await expect(page.getByRole('heading', { level: 1 }), code).toBeVisible();
      await expect(page.getByText(message, { exact: true }), code).toBeVisible();
    }
    /** Codes with no distinct remedy, and codes this client does not know, stay generic. */
    for (const code of [
      'discord_unavailable',
      'discord_principal_unavailable',
      'discord_unknown',
    ]) {
      await page.goto(`/oauth/error?error=${code}`);
      await expect(
        page.getByText(translations.com_ui_oauth_error_generic, { exact: true }),
        code,
      ).toBeVisible();
    }
    /** Provider text carried in the redirect is never rendered. */
    await page.goto(
      `/oauth/error?error=discord_provider_refused&error_description=${encodeURIComponent(`Bot ${token} refused`)}`,
    );
    await expect(
      page.getByText(translations.com_ui_discord_oauth_refused, { exact: true }),
    ).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(token);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/oauth/error?error=discord_provider_refused');
    await expect(
      page.getByText(translations.com_ui_discord_oauth_refused, { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}
