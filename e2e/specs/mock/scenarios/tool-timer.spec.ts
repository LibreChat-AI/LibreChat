import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, modelSelectorTrigger, sendMessage } from '../helpers';

test('a running tool includes hidden time before and after expansion @scenario:running-tool-timer-keeps-hidden-time', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const label = `timer-${Date.now()}`;
  await page.goto(NEW_CHAT_PATH);
  const modelSelector = modelSelectorTrigger(page);
  await modelSelector.click();
  await page.getByRole('option', { name: 'Mock Provider F', exact: true }).click();
  /** Mobile includes the nested Pin action in the option's accessible name. */
  await page.getByRole('option', { name: /^mock-model-f(?: Pin)?$/ }).click();
  await expect(modelSelector).toContainText('mock-model-f');
  await expect(modelSelector).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  await page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: /^E2E Memory\b/ })
    .click();
  await page.keyboard.press('Escape');
  /** `setFixedTime` hands every timer the page starts from then on to Playwright's clock, which
   *  runs one per task and falls seconds behind once the stream's cache notifications queue up.
   *  The palette is still closing here; a leave timer started after the install waits behind
   *  them, and the invisible popover covers the transcript and takes the click meant for the
   *  tool row. It unmounts when the leave ends, so wait for that on the page's own clock. */
  await expect(page.getByRole('dialog', { name: 'Attach and tools' })).toHaveCount(0);
  const start = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(start);
  await sendMessage(page, `E2E_INTERRUPT_TOOL_REPLY:${label}`);

  const view = messagesView(page);
  const card = view.getByTestId('activity-phase-card').last();
  const disclosure = card.locator('button[aria-expanded]').first();
  await expect(disclosure).toContainText(/Running/);
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  const row = card.locator(`[data-tool-call-id="call_interrupt_slow_${label}"]`);
  await expect(row).toHaveCount(0);

  await page.clock.setFixedTime(start + 8_000);
  await disclosure.click();
  const timer = row.getByTestId('stream-elapsed');
  await expect(timer).toHaveText(/^\d+s$/);
  const before = Number.parseInt((await timer.innerText()).trim(), 10);
  expect(before).toBeGreaterThanOrEqual(8);

  await disclosure.click();
  await expect(row).toHaveCount(0);
  await page.clock.setFixedTime(start + 11_000);
  await disclosure.click();
  await expect(timer).toBeVisible();
  expect(Number.parseInt((await timer.innerText()).trim(), 10)).toBeGreaterThanOrEqual(before + 3);
  await page.getByTestId('stop-generation-button').click();
});
