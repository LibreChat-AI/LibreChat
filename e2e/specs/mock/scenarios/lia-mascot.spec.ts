import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, sendMessage } from '../helpers';

/**
 * Lia, the welcome screen mascot: off until the user opts in from Settings, standing on the
 * composer clear of the greeting, waving the first message off, and absent from conversations.
 */
test.describe.configure({ timeout: 120_000 });

const lia = (page: Page) => page.getByTestId('lia');

async function open(page: Page, { optedIn }: { optedIn: boolean }) {
  await page.addInitScript((on) => {
    localStorage.setItem('showLia', JSON.stringify(on));
  }, optedIn);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 15000,
  });
}

/** The pixels Lia's body occupies: the canvas carries transparent room for raised arms. */
async function bodyBox(page: Page) {
  const box = await lia(page).boundingBox();
  if (!box) {
    throw new Error('Lia has no box');
  }
  const scale = box.width / 64;
  return { x: box.x + 12 * scale, y: box.y + 20 * scale, width: 40 * scale, height: 37 * scale };
}

test.describe('Lia mascot', () => {
  test('nobody sees Lia until they opt in @scenario:lia-off-by-default', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 15000,
    });
    await page.waitForTimeout(1500);
    await expect(lia(page)).toHaveCount(0);
  });

  test('turning Lia on in Settings shows her and remembers it @scenario:lia-opt-in-from-settings', async ({
    page,
  }) => {
    await open(page, { optedIn: false });
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 10000,
    });
    const toggle = page.getByTestId('showLia');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(lia(page)).toBeVisible({ timeout: 10000 });

    await page.reload();
    await expect(lia(page)).toBeVisible({ timeout: 15000 });
  });

  test('Lia stands on the composer without covering the greeting @scenario:lia-clear-of-greeting', async ({
    page,
  }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    const body = await bodyBox(page);
    const greeting = await page.evaluate(() => {
      const content = document.querySelector('[data-chat-pane="0"]')?.firstElementChild;
      if (!content) {
        return null;
      }
      const range = document.createRange();
      range.selectNodeContents(content);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    });
    expect(greeting).not.toBeNull();
    const overlaps =
      greeting != null &&
      body.x < greeting.x + greeting.width &&
      greeting.x < body.x + body.width &&
      body.y < greeting.y + greeting.height &&
      greeting.y < body.y + body.height;
    expect(overlaps).toBe(false);
    const composer = await page.getByRole('textbox', { name: 'Message input' }).boundingBox();
    expect(composer).not.toBeNull();
    expect(body.y + body.height).toBeLessThanOrEqual((composer?.y ?? 0) + 4);
  });

  test('hovering Lia says what she is doing @scenario:lia-hover-label', async ({ page }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    await lia(page).hover();
    await expect(lia(page)).toHaveAttribute('title', /^Lia: \S/, { timeout: 5000 });
  });

  test('Lia waves the first message off, then leaves the conversation @scenario:lia-farewell-on-send', async ({
    page,
  }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    await sendMessage(page, 'Hello Lia');
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
    await expect(lia(page)).toHaveCount(0, { timeout: 5000 });

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 15000,
    });
    await page.waitForTimeout(1500);
    await expect(lia(page)).toHaveCount(0);
  });

  test('a deployment that turns the mascot off hides Lia and her setting @scenario:lia-respects-deployment-opt-out', async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === '/api/config',
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: { ...body, interface: { ...body.interface, mascot: false } },
        });
      },
    );
    await open(page, { optedIn: true });
    await page.waitForTimeout(2000);
    await expect(lia(page)).toHaveCount(0);

    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId('centerFormOnLanding')).toBeVisible();
    await expect(page.getByTestId('showLia')).toHaveCount(0);
  });

  test('with reduced motion Lia stays where she stands @scenario:lia-reduced-motion-stays-put', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const first = await lia(page).boundingBox();
    await page.waitForTimeout(6000);
    const second = await lia(page).boundingBox();
    expect(second?.x).toBe(first?.x);
    expect(second?.y).toBe(first?.y);
  });
});
