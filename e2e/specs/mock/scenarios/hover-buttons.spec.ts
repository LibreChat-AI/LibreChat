import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  replyText,
  replyPrompt,
  NEW_CHAT_PATH,
  messagesView,
  MOCK_ENDPOINTS,
  isAgentsStream,
  sendMessage,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';

/** The toolbar `@librechat/chat` renders under each turn: rerun, continue, edit, copy and
 *  read-aloud, with the thread and the read-aloud control supplied by the app's messages host. */

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const userEmail = getE2EUser().email;
const createdConversationIds: string[] = [];

test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  await deleteMessagesByConversation(createdConversationIds);
  await deleteConversations(createdConversationIds);
});

const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function replyInNewChat(page: Page, prefix: string) {
  const label = `${prefix}-${randomUUID().slice(0, 8)}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  const reply = replyText(label);
  await expect(messagesView(page).getByText(reply)).toBeVisible({ timeout: 30000 });
  const conversationId = new URL(page.url()).pathname.split('/c/')[1];
  if (conversationId) {
    createdConversationIds.push(conversationId);
  }
  return { label, reply };
}

/**
 * A run in flight withholds rerun on every settled reply without removing the button, so the
 * check is what the reader gets, not which classes the button carries: nothing to see, nothing
 * to focus, and the same button back when the run ends. Below `lg` the app's own stylesheet
 * forces toolbar buttons visible, which a concealed one has to be exempt from.
 */
async function expectRerunWithheldDuringRun(page: Page, width: number) {
  const { reply, label } = await replyInNewChat(page, 'hover-conceal');
  await page.setViewportSize({ width, height: 900 });
  const row = messageRender(page, reply);
  const rerun = row.locator('button[aria-label="Regenerate"]');
  await row.hover();
  await expect(rerun).toBeVisible();

  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  const stop = page.getByTestId('stop-generation-button');
  await expect(stop).toBeVisible({ timeout: 15_000 });

  await row.hover();
  await expect(rerun).toHaveCount(1);
  await expect(rerun).toBeHidden();
  const tookFocus = await rerun.evaluate((button: HTMLElement) => {
    button.focus();
    return document.activeElement === button;
  });
  expect(tookFocus).toBe(false);

  await expect(stop).toBeHidden({ timeout: 60_000 });
  await row.hover();
  await expect(rerun).toBeVisible();
}

test.describe('message hover toolbar', () => {
  test('a settled reply withholds rerun on a wide screen while a run is in flight @scenario:hover-rerun-withheld-during-run-wide', async ({
    page,
  }) => {
    await expectRerunWithheldDuringRun(page, 1280);
  });

  test('a settled reply withholds rerun on a narrow screen while a run is in flight @scenario:hover-rerun-withheld-during-run-narrow', async ({
    page,
  }) => {
    await expectRerunWithheldDuringRun(page, 800);
  });

  test('regenerating a reply replays its turn @scenario:hover-regenerate-replays-turn', async ({
    page,
  }) => {
    const { reply } = await replyInNewChat(page, 'hover-regen');

    const row = messageRender(page, reply);
    await row.hover();
    const [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByTestId('regenerate-generation-button').click(),
    ]);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('2 / 2')).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(reply)).toBeVisible();
  });

  test('a cut-off reply offers continue and a finished one does not @scenario:hover-continue-on-cut-off-reply', async ({
    page,
  }) => {
    const { reply } = await replyInNewChat(page, 'hover-finished');
    await messageRender(page, reply).hover();
    await expect(page.getByTestId('regenerate-generation-button')).toBeVisible();
    await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);

    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const responseId = randomUUID();
    await seedConversations(userEmail, [
      { conversationId, title: `Cut off ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
    ]);
    createdConversationIds.push(conversationId);
    await seedMessages(userEmail, conversationId, [
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: 'Write a long answer',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: responseId,
        parentMessageId: userMessageId,
        text: 'The answer stopped at the token lim',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
      },
    ]);

    await page.goto(`/c/${conversationId}`);
    const row = page.locator(`[id="${responseId}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await expect(page.getByTestId('continue-generation-button')).toBeVisible();
    await expect(page.getByTestId('continue-generation-button')).toHaveAccessibleName('Continue');
  });

  test('editing a sent message opens its editor and cancel closes it @scenario:hover-edit-opens-editor', async ({
    page,
  }) => {
    const { label } = await replyInNewChat(page, 'hover-edit');
    const prompt = replyPrompt(label);

    const row = messageRender(page, prompt);
    await row.hover();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = messagesView(page).getByTestId('message-text-editor');
    await expect(editor).toHaveValue(prompt);
    await expect(editor).toBeFocused();

    await messagesView(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(messagesView(page).getByText(prompt)).toBeVisible();
  });

  test('copying a reply puts its text on the clipboard @scenario:hover-copy-writes-clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { reply } = await replyInNewChat(page, 'hover-copy');

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByTestId('copy-response-button').click();
    await expect(row.getByRole('button', { name: 'Copied to clipboard' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(reply);
  });

  test('read aloud shows on a reply while text to speech is on @scenario:hover-read-aloud-with-tts-on', async ({
    page,
  }) => {
    const { reply } = await replyInNewChat(page, 'hover-tts-on');

    const row = messageRender(page, reply);
    await row.hover();
    await expect(row.getByRole('button', { name: 'Read aloud' })).toBeVisible();
  });

  test('read aloud is absent while text to speech is off @scenario:hover-read-aloud-absent-with-tts-off', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('textToSpeech', JSON.stringify(false)));
    const { reply } = await replyInNewChat(page, 'hover-tts-off');

    const row = messageRender(page, reply);
    await row.hover();
    await expect(row.getByTestId('copy-response-button')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Read aloud' })).toHaveCount(0);
  });
});
