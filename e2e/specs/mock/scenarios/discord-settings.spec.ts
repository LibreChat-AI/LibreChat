import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import { DISCORD_COMMAND_MANIFEST_VERSION } from 'librechat-data-provider';
import translations from '../../../../client/src/locales/en/translation.json';
import { expect, test } from '../fixtures';
import { openSidebar } from './sidebar';

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

/** Server epoch times of the last bot-token observation before and after the credential update. */
const observedBefore = Date.UTC(2026, 10, 15, 9, 30);
const observedAfter = Date.UTC(2026, 10, 16, 8, 0);

test('Discord setup recovers, replaces credentials and confirms disconnection independently of Slack @scenario:discord-settings-recovery-and-management', async ({
  page,
}) => {
  let failed = true;
  let app: DiscordApplication = {
    applicationId: '123456789012345678',
    botUserId: '223456789012345678',
    publicKey: 'a'.repeat(64),
    name: 'Browser application',
    revision: 'app-r1',
    createdBy: 'browser-admin',
    authorityWrites: 0,
    credentialHealth: { state: 'invalid', checkedAt: observedBefore },
  };
  let guild: DiscordGuild = {
    applicationId: app.applicationId,
    installationId: 'browser-installation',
    guildId: '323456789012345678',
    guildName: 'Browser server',
    revision: 'guild-r1',
    createdBy: 'browser-admin',
    authorityWrites: 0,
    status: 'active',
  };
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/channels/workspaces**', (route) =>
    route.fulfill({ status: 404, json: { message: 'Unavailable' } }),
  );
  await page.route('**/api/channels/discord/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'GET' && path.endsWith('/apps')) {
      return route.fulfill(
        failed
          ? { status: 503, json: { message: 'Unavailable' } }
          : {
              json: {
                applications: [app],
                setup: {
                  oauthCallbackUrl: 'https://chat.example/api/channels/discord/callback',
                  interactionBaseUrl: 'https://gateway.example/discord/',
                },
              },
            },
      );
    }
    if (method === 'GET' && path.endsWith('/guilds')) {
      return route.fulfill({ json: { guilds: [guild] } });
    }
    if (method === 'PUT' && path.endsWith('/apps')) {
      writes.push({ method, path, body: request.postDataJSON() });
      app = {
        ...app,
        revision: 'app-r2',
        credentialHealth: { state: 'valid', checkedAt: observedAfter },
      };
      return route.fulfill({ json: app });
    }
    if (method === 'POST' && path.endsWith('/commands')) {
      writes.push({ method, path, body: request.postDataJSON() });
      return route.fulfill({
        json: {
          applicationId: app.applicationId,
          commandId: '423456789012345678',
          providerVersion: '523456789012345678',
          manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
        },
      });
    }
    if (method === 'DELETE' && path.endsWith('/guilds/browser-installation')) {
      writes.push({ method, path, body: request.postDataJSON() });
      guild = { ...guild, status: 'disconnected', revision: 'guild-r2' };
      return route.fulfill({ json: guild });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected request' } });
  });
  await page.goto('/c/new');
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('tab', { name: 'Account', exact: true }).click();
  await settings.getByRole('button', { name: 'Discord', exact: true }).click();
  const discord = page.getByRole('dialog', { name: 'Discord', exact: true });
  await expect(
    discord.getByText(
      'The operation could not be confirmed. Refresh the configuration before trying again.',
    ),
  ).toBeVisible();
  await expect(discord.getByRole('button', { name: 'Add application' })).toBeDisabled();
  failed = false;
  await discord.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(discord.getByLabel('Interactions endpoint URL')).toHaveValue(
    `https://gateway.example/discord/${app.applicationId}/interactions`,
  );
  await expect(discord.getByText(translations.com_ui_discord_health_invalid)).toBeVisible();
  await expect(
    discord.locator(`time[datetime="${new Date(observedBefore).toISOString()}"]`),
  ).toBeVisible();
  const update = discord.getByRole('button', {
    name: 'Update credentials for Browser application',
  });
  await update.click();
  await expect(discord.getByLabel('Application ID')).toHaveAttribute('readonly');
  await discord.getByLabel('Bot token', { exact: true }).fill('browser-test-placeholder-token');
  await discord.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    discord.getByText('Application saved. Credentials are never returned.'),
  ).toBeVisible();
  await expect(discord.getByText(translations.com_ui_discord_health_valid)).toBeVisible();
  await expect(discord.getByText(translations.com_ui_discord_health_invalid)).toHaveCount(0);
  await expect(
    discord.locator(`time[datetime="${new Date(observedAfter).toISOString()}"]`),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    method: 'PUT',
    body: {
      applicationId: app.applicationId,
      expectedRevision: 'app-r1',
      botToken: 'browser-test-placeholder-token',
    },
  });
  await expect(update).toBeFocused();
  await update.click();
  await expect(discord.getByLabel('Bot token', { exact: true })).toHaveValue('');
  await discord.getByRole('button', { name: 'Cancel', exact: true }).click();
  await discord
    .getByRole('button', { name: 'Register or update /librechat commands for Browser application' })
    .click();
  await expect(
    discord.getByText('Registered /librechat commands. Discord may take time to show the update.'),
  ).toBeVisible();
  expect(writes[1]).toMatchObject({
    method: 'POST',
    body: {
      applicationId: app.applicationId,
      expectedRevision: 'app-r2',
      manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
    },
  });
  const disconnect = discord.getByRole('button', {
    name: 'Disconnect Browser server',
    exact: true,
  });
  await disconnect.click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes.filter((write) => write.method === 'DELETE')).toHaveLength(0);
  await disconnect.click();
  await confirmation.getByRole('button', { name: 'Disconnect server', exact: true }).click();
  await expect(discord.getByText('Disconnected', { exact: true })).toBeVisible();
  expect(writes.filter((write) => write.method === 'DELETE')).toEqual([
    {
      method: 'DELETE',
      path: '/api/channels/discord/guilds/browser-installation',
      body: { revision: 'guild-r1' },
    },
  ]);
});
