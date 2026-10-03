import { expect, test } from '@playwright/test';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { getAccessToken, requestJson, MOCK_ENDPOINTS, NEW_CHAT_PATH } from './helpers';

for (const [theme, width] of [
  ['light', 1280],
  ['dark', 1280],
  ['dark', 390],
] as const) {
  test(`approval mode controls persist in ${theme} mode at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('color-theme', value), theme);
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const name = uniqueAgentName('Approval modes');
    const agent = await requestJson<{ id: string }>(page, {
      path: '/api/agents',
      method: 'POST',
      token,
      body: {
        name,
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        tools: [
          'sys__server__sys_mcp_e2e-memory',
          'remember_fact_mcp_e2e-memory',
          'recall_fact_mcp_e2e-memory',
        ],
      },
    });
    try {
      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(name);
      await form.getByRole('button', { name: 'Configure', exact: true }).last().click();
      const dialog = page.getByTestId('item-dialog');
      await expect(dialog.getByText('Tools in this server')).toBeVisible();
      const row = dialog.getByRole('button', { name: 'remember_fact', exact: true }).locator('..');
      await row.getByRole('button', { name: /^Tool approval mode:/ }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const label of [
        'Use inherited policy',
        'Always ask',
        'Always approve',
        'Ask once per chat',
        'Ask once, then always approve',
      ]) {
        await expect(
          menu.getByRole('menuitemcheckbox', { name: label, exact: true }),
        ).toBeVisible();
      }
      await menu.getByRole('menuitemcheckbox', { name: 'Ask once per chat', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Tool approval mode: Ask once per chat', exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole('button', { name: /Approval mode for all listed tools: Mixed/ })
        .click();
      await menu.getByRole('menuitemcheckbox', { name: 'Always ask', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Tool approval mode: Always ask', exact: true }),
      ).toBeVisible();
      await row.getByRole('button', { name: /^Tool approval mode:/ }).focus();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitemcheckbox', { name: 'Ask once per chat', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await row.getByRole('button', { name: /^Tool approval mode:/ }).click();
      await testInfo.attach('Approval menu', {
        body: await menu.screenshot(),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await openAgentBuilder(page, { navigate: false });
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            response.url().includes(`/api/agents/${agent.id}`),
        ),
        form.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
      const body = await saved.json();
      expect(body.tool_options['remember_fact_mcp_e2e-memory'].approval_mode).toBe('chat');
      await page.reload();
      const reopened = await openAgentBuilder(page, { navigate: false });
      await reopened.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name }).click();
      await reopened.getByRole('button', { name: 'Configure', exact: true }).last().click();
      await expect(
        dialog.getByRole('button', { name: 'Tool approval mode: Ask once per chat', exact: true }),
      ).toBeVisible();
      await testInfo.attach('MCP tool approval controls', {
        body: await dialog.screenshot(),
        contentType: 'image/png',
      });
      const overflow = await dialog.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      );
      expect(overflow).toBe(false);
    } finally {
      await page.keyboard.press('Escape');
      await cleanupAgent(page, agent.id);
    }
  });
}
