import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';
import { openSidebar } from './scenarios/sidebar';

const firstConversation = (page: Page) => page.getByTestId('convo-item').first();

function uniqueLabel(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

async function sendAndExpectReply(page: Page, label: string) {
  const prompt = replyPrompt(label);
  const reply = replyText(label);
  const response = await sendMessageAndWaitForCompletion(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(prompt)).toBeVisible();
  await expect(messagesView(page).getByText(reply)).toBeVisible();
  return { prompt, reply };
}

async function openConversationMenu(conversation: Locator) {
  await conversation.hover();
  await conversation.getByRole('button', { name: 'Conversation Menu Options' }).click();
}

async function renameConversation(page: Page, conversation: Locator, title: string) {
  await openConversationMenu(conversation);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const titleInput = conversation.getByRole('textbox', { name: 'New Conversation Title' });
  await expect(titleInput).toBeVisible();
  await titleInput.fill(title);
  await conversation.getByRole('button', { name: 'Save' }).click();
  await expect(conversation).toContainText(title);
}

test.describe('conversation management', () => {
  test('loads a past sidebar conversation with its message history', async ({ page }) => {
    test.setTimeout(90000);
    const firstLabel = uniqueLabel('sidebar-history-first');
    const secondLabel = uniqueLabel('sidebar-history-second');

    await openMockChat(page);
    const firstTurn = await sendAndExpectReply(page, firstLabel);
    const secondTurn = await sendAndExpectReply(page, secondLabel);
    const conversationUrl = page.url();

    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/);
    await expect(firstConversation(page)).toBeVisible();

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(messagesView(page).getByText(firstTurn.prompt)).toHaveCount(0);
    await expect(messagesView(page).getByText(secondTurn.prompt)).toHaveCount(0);

    await firstConversation(page).click();
    await expect(page).toHaveURL(conversationUrl);
    await expect(messagesView(page).getByText(firstTurn.prompt)).toBeVisible();
    await expect(messagesView(page).getByText(firstTurn.reply)).toBeVisible();
    await expect(messagesView(page).getByText(secondTurn.prompt)).toBeVisible();
    await expect(messagesView(page).getByText(secondTurn.reply)).toBeVisible();
  });

  test('renames a conversation from the sidebar', async ({ page }) => {
    test.setTimeout(60000);
    const label = uniqueLabel('sidebar-rename');
    const renamedTitle = `Renamed ${label}`;

    await openMockChat(page);
    await sendAndExpectReply(page, label);

    await renameConversation(page, firstConversation(page), renamedTitle);
    const followUp = await sendMessage(page, `E2E_SLOW_REPLY:${label}-follow-up`);
    expect(followUp.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await expect(firstConversation(page)).toContainText(renamedTitle);
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30000,
    });
    await expect(firstConversation(page)).toContainText(renamedTitle);
    await page.reload({ timeout: 10000 });
    await expect(page.getByTestId('convo-item').filter({ hasText: renamedTitle })).toBeVisible();
  });

  for (const background of [false, true]) {
    test(`right-clicks and renames a running ${background ? 'background' : 'active'} chat`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      const label = uniqueLabel(`running-${background ? 'background' : 'active'}`);
      const originalTitle = `Original ${label}`;
      const renamedTitle = `Renamed ${label}`;
      await openMockChat(page);
      await sendAndExpectReply(page, label);
      await renameConversation(page, firstConversation(page), originalTitle);
      const conversationUrl = page.url();
      const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
      expect(run.ok()).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
      if (background) {
        await page.getByRole('link', { name: 'New chat', exact: true }).click();
        await expect(page).toHaveURL(/\/c\/new$/);
      }
      const row = firstConversation(page);
      await expect(row).toContainText(originalTitle);
      await expect(row.getByRole('img', { name: 'Generating' })).toBeVisible();
      await row.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem').first()).toBeFocused();
      const expectedOptions = ['Share', 'Pin'];
      if (background) expectedOptions.push('Mark as unread');
      expectedOptions.push('Rename', 'Duplicate', 'Change project', 'Archive', 'Delete');
      await expect(menu.getByRole('menuitem')).toHaveText(expectedOptions);
      await test.info().attach('running-chat-menu', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await expect(page).toHaveURL(background ? /\/c\/new$/ : conversationUrl);
      await expect(row.getByRole('img', { name: 'Generating' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(row.getByRole('button', { name: 'Conversation Menu Options' })).toBeFocused();
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      const titleInput = row.getByRole('textbox', { name: 'New Conversation Title' });
      await titleInput.fill(renamedTitle);
      const [renamed] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/convos/update',
        ),
        row.getByRole('button', { name: 'Save' }).click(),
      ]);
      expect(renamed.ok()).toBeTruthy();
      const renamedRow = page.getByTestId('convo-item').filter({ hasText: renamedTitle });
      await expect(renamedRow.getByRole('img', { name: 'Generating' })).toBeVisible();
      if (background) {
        await renamedRow.click();
        await expect(page).toHaveURL(conversationUrl);
      }
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 30000,
      });
      await expect(renamedRow).toBeVisible();
      await expect(page.getByTestId('convo-item').filter({ hasText: originalTitle })).toHaveCount(
        0,
      );
      await page.reload({ timeout: 10000 });
      await expect(renamedRow).toBeVisible();
    });
  }

  test('returns focus after right-clicking an unopened running menu on a small screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const label = uniqueLabel('running-small');
    await openMockChat(page);
    await sendAndExpectReply(page, label);
    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await openSidebar(page);
    await page.getByRole('link', { name: 'New chat', exact: true }).click();
    await openSidebar(page);
    const row = firstConversation(page);
    await expect(row.getByRole('img', { name: 'Generating' })).toBeVisible();
    await row.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    const trigger = row.getByRole('button', { name: 'Conversation Menu Options' });
    const originalTrigger = await trigger.elementHandle();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    expect(await originalTrigger?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(trigger).toBeFocused();
  });

  for (const timing of ['immediate', 'final'] as const) {
    test(`preserves a first-turn rename over a pending ${timing} automatic title`, async ({
      page,
      request,
    }) => {
      test.skip(process.env.E2E_TITLE_CONVO !== 'true', 'Requires the title-enabled mock profile');
      test.setTimeout(40000);
      const label = uniqueLabel(`first-rename-${timing}`);
      const renamedTitle = `Renamed ${label}`;
      const fixture = `http://127.0.0.1:${process.env.E2E_LABEL_PORT ?? '8889'}`;
      await request.post(`${fixture}/__e2e/reset`);
      await request.post(`${fixture}/__e2e/behavior`, {
        data: { label: `Generated ${label}`, hold: true, holdModel: 'mock-title-model' },
      });
      try {
        await page.goto(NEW_CHAT_PATH);
        await selectMockEndpoint(page, {
          label: `Mock Titles ${timing}`,
          model: `mock-titles-${timing}`,
        });
        const titleFetch = page.waitForRequest((request) =>
          new URL(request.url()).pathname.startsWith('/api/convos/gen_title/'),
        );
        const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
        await titleFetch;
        expect(run.ok()).toBeTruthy();
        await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
        const { conversationId } = await run.json();
        await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
        const row = page.locator(
          `[data-testid="convo-item"][data-conversation-id="${conversationId}"]`,
        );
        await expect(row.getByRole('img', { name: 'Generating' })).toBeVisible();
        await row.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        await row.getByRole('textbox', { name: 'New Conversation Title' }).fill(renamedTitle);
        await row.getByRole('button', { name: 'Save' }).click();
        await expect(row).toContainText(renamedTitle);
        const titleRequest = async () => {
          const body = await (await request.get(`${fixture}/__e2e/requests`)).json();
          return body.requests.find(
            (record: { prompt: string; model: string }) =>
              record.model === 'mock-title-model' && record.prompt.includes(label),
          );
        };
        await expect.poll(async () => !!(await titleRequest())).toBe(true);
        const published = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.startsWith('/api/convos/gen_title/') &&
            response.status() === 200,
          { timeout: 30000 },
        );
        await request.post(`${fixture}/__e2e/release`);
        expect((await (await published).json()).title).toBe(renamedTitle);
        await expect.poll(async () => (await titleRequest())?.completed === true).toBe(true);
        await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
          timeout: 30000,
        });
        await expect(row).toContainText(renamedTitle);
        await page.reload();
        await expect(
          page.getByTestId('convo-item').filter({ hasText: renamedTitle }),
        ).toBeVisible();
      } finally {
        await request.post(`${fixture}/__e2e/reset`, { timeout: 2000 }).catch(() => undefined);
      }
    });
  }

  test('deletes a conversation, clears its messages, and blocks direct URL access', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const label = uniqueLabel('sidebar-delete');
    const renamedTitle = `Delete ${label}`;

    await openMockChat(page);
    const turn = await sendAndExpectReply(page, label);
    const conversationUrl = page.url();

    const conversation = firstConversation(page);
    await renameConversation(page, conversation, renamedTitle);
    await openConversationMenu(conversation);
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    const dialog = page.getByRole('dialog', { name: 'Delete chat?' });
    await expect(dialog).toBeVisible();
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' && response.url().includes('/api/convos'),
        { timeout: 30000 },
      ),
      dialog.getByRole('button', { name: 'Delete' }).click(),
    ]);
    expect(deleteResponse.ok()).toBeTruthy();

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByTestId('convo-item').filter({ hasText: renamedTitle })).toHaveCount(0);
    await expect(messagesView(page).getByText(turn.prompt)).toHaveCount(0);
    await expect(messagesView(page).getByText(turn.reply)).toHaveCount(0);

    await page.goto(conversationUrl, { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(messagesView(page).getByText(turn.prompt)).toHaveCount(0);
    await expect(messagesView(page).getByText(turn.reply)).toHaveCount(0);
  });
});
