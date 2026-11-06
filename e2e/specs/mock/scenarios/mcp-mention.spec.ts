import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  modelSelectorTrigger,
  selectMockEndpoint,
} from '../helpers';

async function openInlineMention(page: Page, server: string) {
  const textarea = page.getByRole('textbox', { name: 'Message input' });
  await textarea.fill('Find  tomorrow');
  await textarea.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
  await textarea.press('@');
  const picker = page.getByRole('combobox', { name: 'Select an MCP server', exact: true });
  await expect(picker).toBeFocused();
  await picker.fill(server);
  return { textarea, picker };
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test.describe(`MCP mentions on ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test.beforeEach(async ({ page }) => {
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    });

    test('keyboard selection preserves the draft and model and does not toggle an active server off', async ({
      page,
    }) => {
      const initialModel = await modelSelectorTrigger(page).innerText();
      const submissions: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/api\/(agents|ask)\//.test(request.url())) {
          submissions.push(request.url());
        }
      });
      const { textarea, picker } = await openInlineMention(page, 'e2e-memory');
      await expect(page.getByRole('option', { name: /^E2E Memory\b/ })).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath('mcp-picker.png'),
        animations: 'disabled',
      });
      await picker.press('Enter');
      await expect(picker).toHaveCount(0);
      await expect(textarea).toHaveValue('Find  tomorrow');
      await expect(textarea).toBeFocused();
      expect(
        await textarea.evaluate((element: HTMLTextAreaElement) => element.selectionStart),
      ).toBe(5);
      await expect(modelSelectorTrigger(page)).toHaveText(initialModel);
      await expect(page).toHaveURL(/\/c\/new(?:\?|$)/);
      expect(submissions).toEqual([]);

      const repeated = await openInlineMention(page, 'e2e-memory');
      const option = page.getByRole('option', { name: /^E2E Memory\b/ });
      await expect(option).toContainText('Selected');
      await page.screenshot({
        path: test.info().outputPath('mcp-selected.png'),
        animations: 'disabled',
      });
      await option.click();
      await expect(repeated.picker).toHaveCount(0);
      await page.getByRole('button', { name: 'Attach and tools' }).click();
      const palette = page.getByRole('dialog', { name: 'Attach and tools' });
      const row = palette.getByRole('button', { name: /^E2E Memory\b/ });
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      await row.click();
      await expect(row).toHaveAttribute('aria-pressed', 'false');
    });

    test('keeps hidden servers out and preserves the draft on dismissal', async ({ page }) => {
      const { textarea, picker } = await openInlineMention(page, 'e2e-oauth-deferred');
      await expect(page.getByRole('option')).toHaveCount(0);
      await picker.press('Enter');
      await expect(textarea).toHaveValue('Find @ tomorrow');
      await expect(textarea).toBeFocused();
      await textarea.fill('person@example.com');
      await textarea.press('x');
      await expect(page.getByRole('combobox', { name: 'Select an MCP server' })).toHaveCount(0);
    });

    test('opens the existing user-variable dialog without selecting or losing the draft', async ({
      page,
    }) => {
      const { textarea, picker } = await openInlineMention(page, 'e2e-user-vars');
      await expect(page.getByRole('option', { name: /^E2E User Vars\b/ })).toBeVisible();
      await picker.press('Enter');
      const dialog = page
        .getByRole('dialog')
        .filter({ hasText: /Configure Variables for e2e-user-vars/i });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('E2E User Token')).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath('mcp-configuration.png'),
        animations: 'disabled',
      });
      await expect(picker).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(textarea).toHaveValue('Find  tomorrow');
      const reopened = await openInlineMention(page, 'e2e-user-vars');
      await expect(page.getByRole('option', { name: /^E2E User Vars\b/ })).not.toContainText(
        'Selected',
      );
      await reopened.picker.press('Escape');
    });
  });
}

test('an MCP mention starts the existing OAuth flow and waits for readiness before selecting', async ({
  page,
  context,
}) => {
  await context.route('https://oauth.example.test/**', (route) =>
    route.fulfill({ body: 'Pending test authorization' }),
  );
  await page.route('**/api/mcp/connection/status', (route) =>
    route.fulfill({
      json: {
        success: true,
        connectionStatus: {
          'e2e-memory': { connectionState: 'disconnected', requiresOAuth: true },
        },
      },
    }),
  );
  let attempts = 0;
  await page.route('**/api/mcp/e2e-memory/reinitialize', (route) => {
    attempts++;
    return route.fulfill({
      json: {
        success: true,
        serverName: 'e2e-memory',
        oauthRequired: true,
        oauthUrl: 'https://oauth.example.test/authorize',
        flowId: 'mcp-mention-test',
        oauthTimeout: 30000,
      },
    });
  });
  await page.route('**/api/mcp/oauth/status/**', (route) =>
    route.fulfill({ json: { status: 'PENDING' } }),
  );
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const { textarea, picker } = await openInlineMention(page, 'e2e-memory');
  await expect(page.getByRole('option', { name: /^E2E Memory\b/ })).toBeVisible();
  await picker.press('Enter');
  await expect.poll(() => attempts).toBe(1);
  await expect(textarea).toHaveValue('Find  tomorrow');
  const reopened = await openInlineMention(page, 'e2e-memory');
  await expect(page.getByRole('option', { name: /^E2E Memory\b/ })).toContainText('Initializing');
  await expect(page.getByRole('option', { name: /^E2E Memory\b/ })).not.toContainText('Selected');
  await reopened.picker.press('Escape');
});
