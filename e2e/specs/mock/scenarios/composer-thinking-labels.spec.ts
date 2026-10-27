import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, sendMessage } from '../helpers';

/* Mock Provider A advertises Anthropic's `effort` enum: Auto, then Low through Max. */
async function openThinking(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const trigger = page.getByTestId('composer-thinking-button');
  await expect(trigger).toHaveAccessibleName('Thinking: Auto');
  await trigger.click();
  const popover = page.getByRole('dialog', { name: /^Thinking: / });
  await expect(popover.getByRole('radiogroup', { name: 'Thinking' })).toBeVisible();
  return { trigger, popover };
}

test.describe('composer thinking labels', () => {
  test('Thinking popover names the levels in Auto @scenario:thinking-popover-names-levels-in-auto', async ({
    page,
  }) => {
    const { popover } = await openThinking(page);

    await expect(popover.getByRole('radio')).toHaveCount(5);
    await expect(popover.getByText('Auto', { exact: true }).first()).toBeVisible();
    await expect(popover.getByText('Low', { exact: true })).toBeVisible();
    await expect(popover.getByText('Max', { exact: true })).toBeVisible();

    const autoToggle = popover.getByRole('button', { name: 'Auto' });
    await expect(autoToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(autoToggle).toBeFocused();
  });

  test('Thinking popover names the picked level @scenario:thinking-popover-names-the-picked-level', async ({
    page,
  }) => {
    const { trigger, popover } = await openThinking(page);

    await popover.getByRole('radio', { name: 'Medium' }).click();

    await expect(popover.getByRole('radio', { name: 'Medium' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(popover.getByText('Medium', { exact: true })).toBeVisible();
    await expect(popover.getByRole('button', { name: 'Auto' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(trigger).toHaveAccessibleName('Thinking: Medium');

    await page.keyboard.press('Escape');
    await trigger.click();
    await expect(popover.getByRole('radio', { name: 'Medium' })).toBeFocused();
  });

  test('Thinking popover says the level applies to the next message @scenario:thinking-popover-says-level-applies-to-next-message', async ({
    page,
  }) => {
    const { trigger, popover } = await openThinking(page);
    const group = popover.getByRole('radiogroup', { name: 'Thinking' });

    await expect(group).toHaveAccessibleDescription('Applies to your next message');
    await expect(popover.getByText('Applies to your next message')).toBeVisible();

    await popover.getByRole('radio', { name: 'High', exact: true }).click();
    await expect(trigger).toHaveAccessibleName('Thinking: High');
    await page.keyboard.press('Escape');

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.method() === 'POST' && req.url().includes('/api/agents/chat'),
        { timeout: 30000 },
      ),
      sendMessage(page, `thinking-scope-${Date.now()}`),
    ]);
    expect(request.postDataJSON()).toEqual(
      expect.objectContaining({ reasoningOverride: { key: 'effort', value: 'high' } }),
    );
    await expect(trigger).toHaveAccessibleName('Thinking: Auto');
  });
});
