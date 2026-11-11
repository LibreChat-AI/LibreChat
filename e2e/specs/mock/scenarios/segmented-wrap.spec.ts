import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { MOCK_ENDPOINTS, getAccessToken, requestJson } from '../helpers';
import { openAgentBuilder } from '../agents.helpers';
import { openSettings } from './ui-scale.helpers';

/**
 * A segmented control keeps each label on one line, so without `wrap` a row of long
 * labels sets a floor under the dialog's width and pushes it past a phone screen.
 * These dialogs carry such rows; each must stay inside the viewport.
 */

const WIDTHS = [360, 414];

/** Every radio group in the dialog sits inside it, and nothing between them scrolls sideways. */
async function expectGroupsContained(dialog: Locator, width: number) {
  const rows = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll('[role="radiogroup"]')).map((group) => {
      let overflowing = false;
      for (
        let node: Element | null = group;
        node && node !== element.parentElement;
        node = node.parentElement
      ) {
        overflowing ||= node.scrollWidth > node.clientWidth + 1;
      }
      const right = group.getBoundingClientRect().right;
      return { right, dialogRight: bounds.right, overflowing };
    });
  });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.overflowing).toBe(false);
    expect(row.right).toBeLessThanOrEqual(row.dialogRight + 1);
    expect(row.dialogRight).toBeLessThanOrEqual(width + 1);
  }
}

async function openActionAuthDialog(page: Page, agentName: string): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await form.getByRole('button', { name: 'Add tools' }).click();
  const library = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(library).toBeVisible();
  await library.getByRole('button', { name: 'Create new…' }).click();
  await page.getByRole('menuitem', { name: 'Actions' }).click();
  const actionDialog = page.getByRole('dialog', { name: 'New action' });
  await expect(actionDialog).toBeVisible();
  await actionDialog.getByRole('button', { name: /^None/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Authentication' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The Agent API keys row is gated on the Remote Agents permission; grant it in the role read. */
async function grantRemoteAgents(page: Page) {
  await page.route(/\/api\/roles\/[^/?]+$/, async (route) => {
    const response = await route.fetch();
    const role = await response.json();
    role.permissions = {
      ...role.permissions,
      REMOTE_AGENTS: { ...(role.permissions?.REMOTE_AGENTS ?? {}), USE: true, CREATE: true },
    };
    await route.fulfill({ response, json: role });
  });
  await page.route(/\/api\/api-keys(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { keys: [] } }) : route.continue(),
  );
}

test.describe('segmented controls wrap in narrow dialogs', () => {
  test('action OAuth settings stay inside the dialog @scenario:action-oauth-auth-fits-narrow-dialog', async ({
    page,
  }) => {
    test.setTimeout(240000);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/c/new', { timeout: 10000 });
      const token = await getAccessToken(page);
      const name = `segmented-wrap-${width}-${Date.now()}`;
      const agent = await requestJson<{ id: string }>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: { name, provider: MOCK_ENDPOINTS[0].label, model: MOCK_ENDPOINTS[0].model },
      });
      try {
        const dialog = await openActionAuthDialog(page, name);
        await dialog.getByRole('radio', { name: 'OAuth' }).click();
        await expect(
          dialog.getByRole('radiogroup', { name: 'Token Exchange Method' }),
        ).toBeVisible();
        await expectGroupsContained(dialog, width);
      } finally {
        await requestJson(page, { path: `/api/agents/${agent.id}`, token, method: 'DELETE' }).catch(
          () => undefined,
        );
      }
    }
  });

  test('API key expiry choices stay inside the dialog @scenario:api-key-expiry-fits-narrow-dialog', async ({
    page,
  }) => {
    test.setTimeout(240000);
    await grantRemoteAgents(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/c/new', { timeout: 10000 });
      await openSettings(page);
      const data = page.getByRole('tab', { name: /^Data/ });
      if (await data.isVisible().catch(() => false)) {
        await data.click();
      }
      await page
        .getByRole('button', { name: 'Agent API keys' })
        .filter({ visible: true })
        .first()
        .click();
      await page
        .getByRole('button', { name: /Create API key/i })
        .filter({ visible: true })
        .first()
        .click();
      const dialog = page.getByRole('dialog', { name: 'Create API Key' });
      await expect(dialog.getByRole('radiogroup', { name: 'Expiration' })).toBeVisible();
      await expectGroupsContained(dialog, width);
    }
  });
});
