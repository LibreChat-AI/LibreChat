import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from './helpers';

const ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const uniqueLabel = () => `thought-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

/** The line the live header currently shows: the current ticker line's title. */
async function headerLine(page: Page): Promise<string | null> {
  const card = messagesView(page).getByTestId('activity-phase-card').first();
  if (!(await card.isVisible().catch(() => false))) {
    return null;
  }
  return card.locator('button [title]').first().getAttribute('title');
}

test.describe('live reasoning', () => {
  test('previews finished sentences and the thought peek, then titles the open card', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const finalText = `E2E slow think reply done ${label}`;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const run = await sendMessage(page, `E2E_SLOW_THINK_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    const lines = new Set<string>();
    let peekSeen = false;
    for (let index = 0; index < 20; index += 1) {
      await page.waitForTimeout(150);
      const line = await headerLine(page);
      if (line != null) {
        lines.add(line);
      }
      if (
        await messagesView(page)
          .getByTestId('streaming-thought-peek')
          .isVisible()
          .catch(() => false)
      ) {
        peekSeen = true;
      }
      if (index === 6 && process.env.E2E_FOLD_SHOTS) {
        await page.screenshot({ path: `${process.env.E2E_FOLD_SHOTS}/thought-collapsed.png` });
      }
      if (index === 12) {
        /** Open the card mid-stream: the header becomes a title. */
        await messagesView(page)
          .getByTestId('activity-phase-card')
          .getByRole('button')
          .first()
          .click();
        await page.waitForTimeout(1100);
        const open = await headerLine(page);
        if (process.env.E2E_FOLD_SHOTS) {
          await page.screenshot({ path: `${process.env.E2E_FOLD_SHOTS}/thought-open.png` });
        }
        expect(open, 'open card title').not.toMatch(/[a-z]\.$/);
        expect(await messagesView(page).getByTestId('streaming-thought-peek').count()).toBe(0);
      }
    }
    /** Every collapsed line was either the generic line or a whole sentence,
     *  never a fragment cut mid-thought. */
    for (const line of lines) {
      expect(line, `header line "${line}"`).toMatch(/^(Thinking\.\.\.|Thinking…|.+[.!?])$/);
    }
    expect(peekSeen, 'thought peek under the collapsed card').toBe(true);

    await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 60000 });
    /** The settled thought's header sits at the shared row scale. */
    const thoughts = messagesView(page)
      .getByRole('button', { name: /Thoughts|Thinking/ })
      .first();
    await expect(thoughts).toBeVisible();
    const sizes = await thoughts.evaluate((button) => {
      const root = getComputedStyle(document.documentElement);
      const markdown = parseFloat(root.getPropertyValue('--markdown-font-size')) * 16;
      return { button: parseFloat(getComputedStyle(button).fontSize), row: markdown * 0.9 };
    });
    expect(sizes.button).toBeCloseTo(sizes.row, 1);
  });
});
