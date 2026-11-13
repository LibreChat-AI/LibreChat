import { expect, test } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openAgentBuilder } from '../agents.helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared controls the panels are built from. Every expectation is read off a throwaway element
 * painted with the utility the control is meant to use, so the same assertion holds in light and
 * dark mode and under a custom theme.
 */

test('a number field shows no browser stepper arrows @scenario:number-field-shows-no-browser-stepper', async ({
  page,
}) => {
  await openAgentBuilder(page);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();

  const field = page.getByRole('spinbutton', { name: 'Max Agent Steps' });
  await expect(field).toBeVisible();
  expect(await field.evaluate((input) => getComputedStyle(input).appearance)).toBe('textfield');

  /** The field is still a number input: the arrow keys step it and the value stays numeric. */
  await field.fill('12');
  await field.press('ArrowUp');
  await expect(field).toHaveValue('13');
});

test.describe('over a dialog', () => {
  /** The conversation menu that opens the share dialog lives in the desktop header; the hover card
   *  and the dialog are the same at any width, so this scenario runs on the desktop layout. */
  test.use({ viewport: { width: 1280, height: 800 } });

  test('an info hover card opened over a dialog draws a medium border @scenario:hover-card-over-dialog-draws-a-medium-border', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByTestId('share-conversation-menu-item').click();
    const dialog = page.getByRole('dialog', { name: 'Share link to chat' });
    await expect(dialog).toBeVisible();

    const note = 'Your name and any messages you add after sharing stay private.';
    await dialog.getByRole('button', { name: note }).hover();
    const card = page
      .locator('[data-radix-popper-content-wrapper] [data-side]')
      .filter({ hasText: note });
    await expect(card).toBeVisible();

    const medium = await probeStyle(page, 'border border-border-medium', 'border-top-color');
    const light = await probeStyle(page, 'border border-border-light', 'border-top-color');
    /** The two roles must paint differently, or this comparison could not tell them apart. */
    expect(medium).not.toBe(light);
    expect(await card.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(medium);
  });
});

test('a radio group draws its track in the card surface @scenario:radio-track-uses-the-card-surface', async ({
  page,
}) => {
  const form = await openAgentBuilder(page);
  const group = form.getByRole('radiogroup', { name: 'Instructions source' });
  await expect(group).toBeVisible();

  const card = await probeStyle(page, 'bg-surface-secondary', 'background-color');
  const previous = await probeStyle(page, 'bg-surface-tertiary', 'background-color');
  expect(card).not.toBe(previous);
  expect(await group.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(card);
});
