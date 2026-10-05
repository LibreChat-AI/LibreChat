import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  conversationRow,
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
    await expect(conversationRow(page)).toBeVisible();

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(messagesView(page).getByText(firstTurn.prompt)).toHaveCount(0);
    await expect(messagesView(page).getByText(secondTurn.prompt)).toHaveCount(0);

    await conversationRow(page, conversationUrl).click();
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

    await renameConversation(page, conversationRow(page), renamedTitle);
    const followUp = await sendMessage(page, `E2E_SLOW_REPLY:${label}-follow-up`);
    expect(followUp.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await expect(conversationRow(page)).toContainText(renamedTitle);
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30000,
    });
    await expect(conversationRow(page)).toContainText(renamedTitle);
    await page.reload({ timeout: 10000 });
    await expect(conversationRow(page)).toContainText(renamedTitle);
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
      await renameConversation(page, conversationRow(page), originalTitle);
      const conversationUrl = page.url();
      const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
      expect(run.ok()).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
      if (background) {
        await page.getByRole('link', { name: 'New chat', exact: true }).click();
        await expect(page).toHaveURL(/\/c\/new$/);
      }
      const row = conversationRow(page, conversationUrl);
      await expect(row).toContainText(originalTitle);
      await expect(row.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
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
      await expect(row.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
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
      const renamedRow = row;
      await expect(renamedRow.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
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

  test('keeps a rename when an older navigation refresh lands before the next message', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const label = uniqueLabel('refresh-rename');
    const originalTitle = `Original ${label}`;
    const renamedTitle = `Renamed ${label}`;
    await openMockChat(page);
    await sendAndExpectReply(page, label);
    await renameConversation(page, conversationRow(page), originalTitle);
    const conversationUrl = page.url();
    const conversationId = new URL(conversationUrl).pathname.split('/').pop()!;
    await page.getByRole('link', { name: 'New chat', exact: true }).click();
    let release!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const pattern = `**/api/convos/${conversationId}`;
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response });
    });
    await conversationRow(page, conversationUrl).click();
    await ready;
    await renameConversation(page, conversationRow(page), renamedTitle);
    const staleRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/convos/${conversationId}`,
    );
    release();
    await staleRead;
    await page.unroute(pattern);
    await expect(conversationRow(page)).toContainText(renamedTitle);
    expect(
      (await sendMessageAndWaitForCompletion(page, replyPrompt(`${label}-next`))).ok(),
    ).toBeTruthy();
    await expect(conversationRow(page)).toContainText(renamedTitle);
    await page.reload();
    await expect(conversationRow(page)).toContainText(renamedTitle);
  });

  test('adopts a newer rename from another tab when the next stream finishes', async ({ page }) => {
    test.setTimeout(45000);
    const label = uniqueLabel('cross-tab-rename');
    const firstTitle = `First ${label}`;
    const secondTitle = `Second ${label}`;
    await openMockChat(page);
    await sendAndExpectReply(page, label);
    await renameConversation(page, conversationRow(page), firstTitle);
    const url = page.url();
    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(url);
      await expect(otherTab.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await renameConversation(otherTab, conversationRow(otherTab), secondTitle);
      await expect(conversationRow(page)).toContainText(firstTitle);
      expect(
        (await sendMessageAndWaitForCompletion(page, replyPrompt(`${label}-next`))).ok(),
      ).toBeTruthy();
      await expect(conversationRow(page)).toContainText(secondTitle);
      await page.reload();
      await expect(conversationRow(page)).toContainText(secondTitle);
    } finally {
      await otherTab.close();
    }
  });

  test('leaves the native context menu available on a portaled shared-link input', async ({
    page,
  }) => {
    await openMockChat(page);
    await sendAndExpectReply(page, uniqueLabel('portal-context'));
    await conversationRow(page).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Share link to chat' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Create a shared link' }).click();
    const input = dialog.getByTestId('shared-link-url');
    await expect(input).toHaveValue(/\/share\//);
    const nativeMenuAllowed = await input.evaluate((element) =>
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(nativeMenuAllowed).toBe(true);
    await expect(dialog).toBeVisible();
  });

  for (const missingProtocol of [false, true]) {
    test(`fences running rename with ${missingProtocol ? 'an older replica' : 'deployment opt-out'}`, async ({
      page,
    }) => {
      await page.route('**/api/config', async (route) => {
        const response = await route.fetch();
        const config = await response.json();
        if (missingProtocol) delete config.conversationTitleOwnershipVersion;
        else config.interface = { ...config.interface, runningChatRename: false };
        await route.fulfill({ response, json: config });
      });
      await openMockChat(page);
      const label = uniqueLabel('rollout-fence');
      await sendAndExpectReply(page, label);
      expect((await sendMessage(page, `E2E_SLOW_REPLY:${label}`)).ok()).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
      const row = conversationRow(page);
      await row.click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeDisabled();
      await expect(page.getByRole('menuitem', { name: 'Pin', exact: true })).toBeEnabled();
      await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeEnabled();
      await expect(row.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(row.getByRole('button', { name: 'Conversation Menu Options' })).toBeFocused();
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
    const conversationUrl = page.url();
    await openSidebar(page);
    await page.getByRole('link', { name: 'New chat', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.locator('#mobile-drawer')).toHaveCSS('visibility', 'hidden');
    await openSidebar(page);
    const row = conversationRow(page, conversationUrl);
    await expect(row.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
    await row.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    const trigger = row.getByRole('button', { name: 'Conversation Menu Options' });
    const originalTrigger = await trigger.elementHandle();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    expect(await originalTrigger?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(trigger).toBeFocused();
  });

  for (const timing of ['immediate', 'final', 'unchanged'] as const) {
    test(`preserves a first-turn rename over a pending ${timing} automatic title`, async ({
      page,
      request,
    }) => {
      test.skip(process.env.E2E_TITLE_CONVO !== 'true', 'Requires the title-enabled mock profile');
      test.setTimeout(40000);
      const label = uniqueLabel(`first-rename-${timing}`);
      const renamedTitle = timing === 'unchanged' ? 'New Chat' : `Renamed ${label}`;
      const titleTiming = timing === 'unchanged' ? 'immediate' : timing;
      const fixture = `http://127.0.0.1:${process.env.E2E_LABEL_PORT ?? '8889'}`;
      await request.post(`${fixture}/__e2e/reset`);
      await request.post(`${fixture}/__e2e/behavior`, {
        data: { label: `Generated ${label}`, hold: true, holdModel: 'mock-title-model' },
      });
      try {
        await page.goto(NEW_CHAT_PATH);
        await selectMockEndpoint(page, {
          label: `Mock Titles ${titleTiming}`,
          model: `mock-titles-${titleTiming}`,
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
        const row = conversationRow(page, new URL(`/c/${conversationId}`, page.url()).href);
        await expect(row.getByRole('button', { name: /, Generating\.\.\.$/ })).toBeVisible();
        const titleRequest = async () => {
          const body = await (await request.get(`${fixture}/__e2e/requests`)).json();
          return body.requests.find(
            (record: { prompt: string; model: string }) =>
              record.model === 'mock-title-model' && record.prompt.includes(label),
          );
        };
        if (timing === 'unchanged')
          await expect.poll(async () => !!(await titleRequest())).toBe(true);
        await row.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        await row.getByRole('textbox', { name: 'New Conversation Title' }).fill(renamedTitle);
        const [renameResponse] = await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/convos/update' &&
              response.request().method() === 'POST',
          ),
          row.getByRole('button', { name: 'Save' }).click(),
        ]);
        expect(renameResponse.ok()).toBeTruthy();
        expect(await renameResponse.json()).toEqual(
          expect.objectContaining({
            title: renamedTitle,
            titleSetByUser: true,
          }),
        );
        await expect(row).toContainText(renamedTitle);
        if (titleTiming === 'final') {
          await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
            timeout: 30000,
          });
        }
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
        await expect(row).toContainText(renamedTitle);
      } finally {
        await request.post(`${fixture}/__e2e/reset`, { timeout: 2000 }).catch(() => undefined);
      }
    });
  }

  test('adopts a newer remote rename from delayed final-title polling', async ({
    page,
    request,
  }) => {
    test.skip(process.env.E2E_TITLE_CONVO !== 'true', 'Requires the title-enabled mock profile');
    test.setTimeout(50000);
    const label = uniqueLabel('final-poll-rename');
    const firstTitle = `First ${label}`;
    const secondTitle = `Second ${label}`;
    const fixture = `http://127.0.0.1:${process.env.E2E_LABEL_PORT ?? '8889'}`;
    await request.post(`${fixture}/__e2e/reset`);
    await request.post(`${fixture}/__e2e/behavior`, {
      data: { label: `Generated ${label}`, hold: true, holdModel: 'mock-title-model' },
    });
    let otherTab: Page | undefined;
    try {
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, { label: 'Mock Titles final', model: 'mock-titles-final' });
      const published = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.startsWith('/api/convos/gen_title/') &&
          response.status() === 200,
      );
      expect((await sendMessage(page, `E2E_SLOW_REPLY:${label}`)).ok()).toBeTruthy();
      await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
      otherTab = await page.context().newPage();
      await otherTab.goto(page.url());
      await renameConversation(otherTab, conversationRow(otherTab), firstTitle);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 30000,
      });
      await expect(conversationRow(page)).toContainText(firstTitle);
      await renameConversation(otherTab, conversationRow(otherTab), secondTitle);
      await expect(conversationRow(page)).toContainText(firstTitle);
      await request.post(`${fixture}/__e2e/release`);
      expect(await (await published).json()).toEqual({
        title: secondTitle,
        titleSetByUser: true,
        titleRevision: 2,
      });
      await expect(conversationRow(page)).toContainText(secondTitle);
      await page.reload();
      await expect(conversationRow(page)).toContainText(secondTitle);
    } finally {
      await otherTab?.close();
      await request.post(`${fixture}/__e2e/reset`, { timeout: 2000 }).catch(() => undefined);
    }
  });

  test('deletes a conversation, clears its messages, and blocks direct URL access', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const label = uniqueLabel('sidebar-delete');
    const renamedTitle = `Delete ${label}`;

    await openMockChat(page);
    const turn = await sendAndExpectReply(page, label);
    const conversationUrl = page.url();

    const conversation = conversationRow(page);
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
