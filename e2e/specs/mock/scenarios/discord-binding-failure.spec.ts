import type { DiscordGuild } from 'librechat-data-provider';
import translations from '../../../../client/src/locales/en/translation.json';
import { expect, test } from '../fixtures';
import {
  cleanupAgent,
  openAgentBuilder,
  selectMockModel,
  uniqueAgentName,
} from '../agents.helpers';

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

const themes = ['light', 'dark'] as const;
const token = 'browser-test-placeholder-token';
const channelId = '323456789012345678';
const guild: DiscordGuild = {
  applicationId: '123456789012345678',
  installationId: 'browser-installation',
  guildId: '223456789012345678',
  guildName: 'Browser server',
  revision: 'guild-r1',
  createdBy: 'browser-admin',
  authorityWrites: 0,
  status: 'active',
};

test.describe('Discord binding failures', () => {
  test.skip(
    process.env.E2E_DISCORD_CHANNELS !== 'true',
    'The builder offers Channels only when the server enables them: needs the Discord channels lane',
  );

  for (const theme of themes) {
    test(`Discord names a refused binding and still requires a status check (${theme}) @scenario:discord-binding-provider-refusal-${theme}`, async ({
      page,
    }) => {
      test.setTimeout(90000);
      let binds = 0;
      await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
      await page.route('**/api/channels/discord/guilds**', (route) =>
        route.fulfill({ json: { guilds: [guild] } }),
      );
      await page.route('**/api/channels/discord/agents/*/binding**', (route) => {
        const method = route.request().method();
        if (method === 'GET') {
          return route.fulfill({
            json: {
              ok: true,
              value: { occupied: false, assignedToThisAgent: false, canReplace: true },
            },
          });
        }
        if (method === 'PUT') {
          binds += 1;
          return route.fulfill({
            status: 409,
            json: {
              ok: false,
              error: { code: 'provider_refused', message: `Bot ${token} refused` },
            },
          });
        }
        return route.fulfill({ status: 400, json: { message: 'Unexpected request' } });
      });

      const agentName = uniqueAgentName('E2E Binding');
      let agentId: string | undefined;
      try {
        const form = await openAgentBuilder(page);
        await form.getByLabel('Agent name').fill(agentName);
        await form
          .getByRole('textbox', { name: 'Instructions', exact: true })
          .fill('Answer briefly.');
        await selectMockModel(page, true);
        const [created] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/agents' &&
              response.status() === 201,
            { timeout: 30000 },
          ),
          form.getByRole('button', { name: 'Create' }).click(),
        ]);
        agentId = ((await created.json()) as { id: string }).id;

        await form.getByRole('button', { name: translations.com_ui_channels_add }).click();
        await page
          .getByRole('dialog', { name: translations.com_ui_channels_title })
          .getByRole('button', { name: new RegExp(translations.com_ui_discord_title) })
          .click();
        const binding = page.getByRole('dialog', {
          name: translations.com_ui_discord_title,
          exact: true,
        });
        await binding
          .getByRole('combobox', { name: translations.com_ui_discord_binding_server })
          .click();
        await page.getByRole('option', { name: /Browser server/ }).click();
        const channel = binding.getByLabel(translations.com_ui_discord_binding_channel);
        await channel.fill(channelId);
        const connect = binding.getByRole('button', {
          name: translations.com_ui_discord_binding_connect,
        });
        await expect(connect).toBeEnabled();
        await connect.click();

        const warning = binding
          .getByRole('alert')
          .filter({ hasText: translations.com_ui_discord_binding_refused });
        await expect(warning).toBeVisible();
        await expect(warning).toContainText(translations.com_ui_discord_binding_check_help);
        expect(await binding.innerText()).not.toContain(token);
        const check = binding.getByRole('button', {
          name: translations.com_ui_discord_binding_check,
        });
        await expect(check).toBeFocused();
        await expect(connect).toBeDisabled();
        await expect(channel).toBeDisabled();
        expect(binds).toBe(1);

        await check.click();
        await expect(warning).toHaveCount(0);
        await expect(connect).toBeEnabled();
        expect(binds).toBe(1);
      } finally {
        await cleanupAgent(page, agentId);
      }
    });
  }
});
