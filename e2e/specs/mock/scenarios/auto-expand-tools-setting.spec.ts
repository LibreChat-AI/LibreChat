import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * The "Auto-expand tool details" setting reaches the tool cards through the message parts host.
 * A finished message with two tool calls stays folded with the setting off, and opens with its
 * outputs showing once the setting is turned on in Settings and the conversation is reloaded.
 */
test.describe.configure({ timeout: 120_000 });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OUTPUTS = ['alpha-tool-output', 'beta-tool-output'];

async function routeToolConversation(page: Page): Promise<string> {
  const conversationId = unique('e2e-auto-expand');
  const now = new Date(0).toISOString();
  const message = {
    messageId: `${conversationId}-msg`,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: OUTPUTS.map((output, index) => ({
      type: 'tool_call',
      tool_call: {
        id: `${conversationId}-tool-${index}`,
        name: `lookup_records_${index}`,
        args: JSON.stringify({ query: output }),
        output,
        progress: 1,
      },
    })),
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Auto-expand tools',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  return conversationId;
}

const outputs = (page: Page): Locator[] =>
  OUTPUTS.map((output) => messagesView(page).locator('pre', { hasText: output }).first());

async function setAutoExpand(page: Page, on: boolean) {
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'Chat' }).click();
  const control = dialog.getByRole('switch', { name: 'Auto-expand tool details' });
  await expect(control).toBeVisible();
  if ((await control.getAttribute('aria-checked')) !== String(on)) {
    await control.click();
  }
  await expect(control).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test('the auto-expand tools setting opens tool cards @scenario:auto-expand-tools-setting-opens-tool-cards', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-auto-expand-seeded') == null) {
      localStorage.removeItem('autoExpandTools');
      sessionStorage.setItem('e2e-auto-expand-seeded', '1');
    }
  });
  const conversationId = await routeToolConversation(page);
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  await expect(
    messagesView(page).getByText('lookup_records_0', { exact: false }).first(),
  ).toBeVisible({
    timeout: 20000,
  });

  for (const output of outputs(page)) {
    await expect(output).toBeHidden();
  }

  await setAutoExpand(page, true);
  await page.reload();
  for (const output of outputs(page)) {
    await expect(output).toBeVisible({ timeout: 20000 });
  }

  await setAutoExpand(page, false);
  await page.reload();
  await expect(
    messagesView(page).getByText('lookup_records_0', { exact: false }).first(),
  ).toBeVisible({
    timeout: 20000,
  });
  for (const output of outputs(page)) {
    await expect(output).toBeHidden();
  }
});
