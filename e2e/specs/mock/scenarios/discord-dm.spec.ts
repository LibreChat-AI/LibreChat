import type { ChannelLinkView, DiscordDmSelectionView } from 'librechat-data-provider';
import { expect, test } from '../fixtures';
import { openSidebar } from './sidebar';

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

for (const theme of ['light', 'dark'] as const) {
  test(`Discord DM selection keeps codes temporary and cleanup available (${theme}) @scenario:discord-dm-selection-${theme}`, async ({
    page,
  }) => {
    const link: ChannelLinkView = {
      linkId: 'browser-link',
      revision: 'link-r1',
      state: 'active',
      expiresAtMs: Date.now() + 3600000,
      identity: {
        provider: 'discord',
        tenantId: '_',
        channelId: 'browser-binding',
        channelRevision: 'binding-r1',
        applicationId: '123456789012345678',
        guildId: '223456789012345678',
        externalUserId: '323456789012345678',
        agentId: 'Browser agent',
      },
    };
    let enabled = true;
    let selections: DiscordDmSelectionView[] = [];
    const issued: unknown[] = [];
    const revoked: unknown[] = [];
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    await page.route('**/api/channels/links', (route) => route.fulfill({ json: [link] }));
    await page.route('**/api/channels/discord/dm/**', (route) => {
      const request = route.request();
      if (request.method() === 'GET')
        return route.fulfill({ json: { ok: true, value: { enabled, selections } } });
      if (request.method() === 'POST') {
        issued.push(request.postDataJSON());
        return route.fulfill({
          json: {
            ok: true,
            value: { code: 'browser-test-one-time-code', expiresAtMs: Date.now() + 600000 },
          },
        });
      }
      if (request.method() === 'DELETE') {
        revoked.push(request.postDataJSON());
        selections = selections.map((selection) => ({ ...selection, state: 'revoked' }));
        return route.fulfill({ json: { ok: true, value: null } });
      }
      return route.fulfill({ status: 400, json: {} });
    });
    await page.goto('/c/new');
    await openSidebar(page);
    await page.getByTestId('nav-user').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('tab', { name: 'Account', exact: true }) });
    await settings.getByRole('tab', { name: 'Account', exact: true }).click();
    const dm = settings.getByRole('region', { name: 'Discord Direct Messages' });
    const select = dm.getByRole('button', {
      name: 'Use in Direct Messages: agent Browser agent, Discord user 323456789012345678, server 223456789012345678 (application 123456789012345678)',
    });
    await select.click();
    const codeDialog = page.getByRole('dialog', { name: 'Use in Direct Messages', exact: true });
    await expect(
      codeDialog.getByText('The selection starts only after you confirm the code in Discord.', {
        exact: false,
      }),
    ).toBeVisible();
    await codeDialog.getByRole('button', { name: 'Generate Code', exact: true }).click();
    await expect(codeDialog.getByLabel('Selection code')).toHaveValue('browser-test-one-time-code');
    expect(issued).toEqual([{ linkId: 'browser-link', expectedLinkRevision: 'link-r1' }]);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain('browser-test-one-time-code');
    await expect(codeDialog.getByLabel('Selection code')).toBeFocused();
    const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`discord-dm-code-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(codeDialog).not.toBeVisible();
    await expect(select).toBeFocused();
    await select.click();
    await expect(codeDialog.getByLabel('Selection code')).toHaveCount(0);
    await codeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    enabled = false;
    selections = [
      {
        selectionId: 'browser-selection',
        revision: 'selection-r1',
        linkId: link.linkId,
        agentId: 'Browser agent',
        applicationId: '123456789012345678',
        dmChannelId: '423456789012345678',
        expiresAtMs: Date.now() + 3600000,
        state: 'unavailable',
      },
    ];
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      dm.getByText(
        'New Discord DM selections are disabled. You can still revoke existing selections.',
      ),
    ).toBeVisible();
    await expect(select).toHaveCount(0);
    const revoke = dm.getByRole('button', {
      name: 'Revoke DM Selection: agent Browser agent, channel 423456789012345678',
    });
    await revoke.click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(revoked).toEqual([]);
    await expect(revoke).toBeFocused();
    await revoke.click();
    await confirmation.getByRole('button', { name: 'Revoke DM Selection', exact: true }).click();
    await expect(dm.getByRole('status').filter({ hasText: 'Revoked' })).toBeVisible();
    expect(revoked).toEqual([{ revision: 'selection-r1' }]);
    await expect(revoke).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`discord-dm-revoked-${theme}.png`) });
  });
}
import AxeBuilder from '@axe-core/playwright';
