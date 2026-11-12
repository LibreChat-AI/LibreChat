import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  fetchJson,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/* Mock Provider A advertises Anthropic's `effort` enum: Auto, then Low through Max. */
const trigger = (page: Page) => page.getByTestId('composer-thinking-button');
const popover = (page: Page) => page.getByRole('dialog', { name: /^Thinking: / });

async function openNewChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(trigger(page)).toHaveAccessibleName('Thinking: Auto');
}

async function pick(page: Page, level: string) {
  await trigger(page).click();
  await popover(page).getByRole('radio', { name: level, exact: true }).click();
  await expect(trigger(page)).toHaveAccessibleName(`Thinking: ${level}`);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toBeHidden();
  /* Focus returns to the trigger, whose tooltip sits over the message field on a phone. */
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
}

/** Sends a turn and returns the reasoning override its request carried. */
async function send(page: Page, text: string) {
  const [request] = await Promise.all([
    page.waitForRequest(
      (req: Request) => req.method() === 'POST' && req.url().includes('/api/agents/chat'),
      { timeout: 30000 },
    ),
    sendMessageAndWaitForCompletion(page, `${text}-${Date.now()}`),
  ]);
  return (request.postDataJSON() as { reasoningOverride?: unknown }).reasoningOverride;
}

/** The level the server recorded on each user turn, oldest first. */
async function savedLevels(page: Page) {
  const conversationId = new URL(page.url()).pathname.split('/c/')[1];
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    await getAccessToken(page),
  );
  return messages
    .filter((message) => message.isCreatedByUser === true)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((message) => message.reasoningOverride?.value ?? null);
}

test.describe('composer thinking level', () => {
  test('Thinking level holds for the rest of the conversation @scenario:thinking-level-holds-for-the-conversation', async ({
    page,
  }) => {
    await openNewChat(page);
    await pick(page, 'Medium');

    expect(await send(page, 'first')).toEqual({ key: 'effort', value: 'medium' });
    await expect(trigger(page)).toHaveAccessibleName('Thinking: Medium');

    /* Nothing new picked: the server runs and records the branch's level. */
    expect(await send(page, 'second')).toBeUndefined();
    await expect(trigger(page)).toHaveAccessibleName('Thinking: Medium');
    expect(await savedLevels(page)).toEqual(['medium', 'medium']);
  });

  test('Thinking level survives a reload of the conversation @scenario:thinking-level-survives-reload', async ({
    page,
  }) => {
    await openNewChat(page);
    await pick(page, 'High');
    expect(await send(page, 'before-reload')).toEqual({ key: 'effort', value: 'high' });
    await expect(page).toHaveURL(/\/c\/(?!new)/);

    await page.reload();
    await expect(trigger(page)).toHaveAccessibleName('Thinking: High');
    await send(page, 'after-reload');
    expect(await savedLevels(page)).toEqual(['high', 'high']);
  });

  test('Picking another level replaces it for later messages @scenario:thinking-level-changes-with-a-new-pick', async ({
    page,
  }) => {
    await openNewChat(page);
    await pick(page, 'Medium');
    expect(await send(page, 'medium')).toEqual({ key: 'effort', value: 'medium' });

    await pick(page, 'Low');
    expect(await send(page, 'low')).toEqual({ key: 'effort', value: 'low' });
    await expect(trigger(page)).toHaveAccessibleName('Thinking: Low');
    await send(page, 'still-low');
    expect(await savedLevels(page)).toEqual(['medium', 'low', 'low']);
  });

  test('Thinking popover opens on the Auto toggle in Auto @scenario:thinking-popover-focuses-auto-toggle', async ({
    page,
  }) => {
    await openNewChat(page);
    await trigger(page).click();

    const autoToggle = popover(page).getByRole('button', { name: 'Auto' });
    await expect(autoToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(autoToggle).toBeFocused();
  });
});
