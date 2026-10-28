import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright'; // 1
import { deleteConversations, seedConversations } from './mock/db';
import { getE2EUser } from '../setup/user';

const SEEDED_IDS = ['a11y-spec-convo-1', 'a11y-spec-convo-2'];

/** A fresh e2e user has no conversations, so without seeding the sidebar renders no rows
 *  and no scan below reaches the conversation row markup. The pre-delete keeps the suite
 *  idempotent: the ids are fixed and conversations are uniquely indexed, so a run that
 *  dies before afterAll would otherwise leave the next one to fail on insert. */
test.beforeAll(async () => {
  await deleteConversations(SEEDED_IDS);
  await seedConversations(
    getE2EUser().email,
    SEEDED_IDS.map((conversationId, i) => ({
      conversationId,
      title: `A11y conversation ${i + 1}`,
      updatedAt: new Date(),
    })),
  );
});

test.afterAll(async () => {
  await deleteConversations(SEEDED_IDS);
});

/** Scanning straight after navigation catches a pre-render DOM with no main landmark and
 *  no composer, so waiting for the composer keeps every scan on the loaded app. Navigate
 *  relative to the config `baseURL` rather than a hardcoded port. */
async function loadApp(page: Page) {
  await page.goto('/', { timeout: 30000 });
  await page.getByTestId('text-input').waitFor({ state: 'visible', timeout: 30000 });
}

test('Landing page should not have any automatically detectable accessibility issues', async ({
  page,
}) => {
  await loadApp(page);

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});

test('Conversation page should be accessible', async ({ page }) => {
  await loadApp(page);

  // Create a conversation (you may need to adjust this based on your app's behavior)
  const input = await page.locator('form').getByRole('textbox');
  await input.click();
  await input.fill('Hi!');
  await page.locator('form').getByRole('button').nth(1).click();
  await page.waitForTimeout(3500);

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});

test('Navigation elements should be accessible', async ({ page }) => {
  await loadApp(page);

  const navAccessibilityScanResults = await new AxeBuilder({ page }).include('nav').analyze();

  expect(navAccessibilityScanResults.violations).toEqual([]);
});

test('Input form should be accessible', async ({ page }) => {
  await loadApp(page);

  const formAccessibilityScanResults = await new AxeBuilder({ page }).include('form').analyze();

  expect(formAccessibilityScanResults.violations).toEqual([]);
});

/** Hovering reveals the row's options button, which is what makes the row an interactive
 *  control containing another interactive control. Wait on that button by id rather than
 *  on any button in the row: the row's title control is always present, so a role match
 *  would be satisfied with the options control still unmounted. */
test('Conversation list rows should be accessible with their controls revealed', async ({
  page,
}) => {
  await loadApp(page);

  const row = page.getByTestId('convo-item').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.hover();
  await expect(row.locator('[id^="conversation-menu-"]')).toBeVisible();

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});

test('Attach and tools palette should be accessible when open', async ({ page }) => {
  await loadApp(page);

  await page.getByRole('button', { name: 'Attach and tools' }).first().click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  await expect(palette).toBeVisible({ timeout: 10000 });
  await expect(
    palette.getByRole('combobox', { name: 'Search tools, skills and servers', exact: true }),
  ).toBeVisible();

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});
