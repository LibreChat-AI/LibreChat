import { expect, test } from '@playwright/test';
import { messagesView, NEW_CHAT_PATH, replyPrompt, replyText, selectModelSpec } from './helpers';

/** Spec with five `conversation_starters` in e2e/config/librechat.e2e.yaml; only four may render. */
const STARTER_SPEC_LABEL = 'E2E Starters';
const STARTER_PROMPTS = [
  replyPrompt('starter'),
  'Plan my week',
  'Third starter prompt',
  'Fourth starter prompt',
];
const STARTER_BEYOND_CAP = 'Fifth starter beyond the cap';

/** A spec without `conversation_starters`. */
const PLAIN_SPEC_LABEL = 'E2E Soft Default';

test.describe('model spec conversation starters', () => {
  test('starter prompts render on the landing for a spec that defines them', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectModelSpec(page, STARTER_SPEC_LABEL);

    for (const text of STARTER_PROMPTS) {
      await expect(page.getByRole('button', { name: text })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: STARTER_BEYOND_CAP })).toBeHidden();
  });

  test('a spec without starters shows none', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectModelSpec(page, PLAIN_SPEC_LABEL);

    for (const text of STARTER_PROMPTS) {
      await expect(page.getByRole('button', { name: text })).toBeHidden();
    }
  });

  test('clicking a starter submits it as the first message', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectModelSpec(page, STARTER_SPEC_LABEL);

    const prompt = replyPrompt('starter');
    await page.getByRole('button', { name: prompt }).click();

    await expect(messagesView(page).getByText(prompt)).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(replyText('starter'))).toBeVisible({
      timeout: 30000,
    });
  });
});
