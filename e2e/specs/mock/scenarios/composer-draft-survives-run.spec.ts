import { expect, test } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * Words written in the composer and not sent stay there when a run starts that the composer did
 * not send: a reply rerun from its row, for one.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test('a draft stays in the composer while a reply is regenerated, and after @scenario:composer-draft-survives-a-regenerate', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const label = uniqueLabel('rerun');
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const first = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(first.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

  const composer = page
    .locator('main form')
    .first()
    .getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await page.keyboard.type('still writing this one');

  const reply = messagesView(page).locator('.message-render').last();
  await reply.hover();
  const [rerun] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/agents\/chat\/[^/]+$/.test(new URL(request.url()).pathname),
    ),
    reply.getByRole('button', { name: 'Regenerate' }).click(),
  ]);
  expect((rerun.postDataJSON() as { isRegenerate?: boolean }).isRegenerate).toBe(true);

  /** While the rerun is under way, and once it is over, the words are where they were. */
  await expect(composer).toHaveValue('still writing this one');
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(messagesView(page).getByText(/2\s*\/\s*2/)).toBeVisible();
  await expect(composer).toHaveValue('still writing this one');

  /** And they are still the conversation's draft after a reload. */
  await page.reload();
  await expect(
    page.locator('main form').first().getByRole('textbox', { name: 'Message input' }),
  ).toHaveValue('still writing this one', { timeout: 30_000 });
});
