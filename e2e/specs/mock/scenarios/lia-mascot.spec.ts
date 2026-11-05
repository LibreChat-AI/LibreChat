import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, sendMessage } from '../helpers';

/**
 * Lia, the welcome screen mascot: off until the user opts in from Settings, standing on the
 * composer clear of the greeting, waving the first message off, and absent from conversations.
 */
test.describe.configure({ timeout: 120_000 });

const lia = (page: Page) => page.getByTestId('lia');

/* The greeting rotates with the clock and some lines span the whole composer, leaving Lia no
 * room by design; this morning shows the short "Good morning" line on every run. */
const MORNING = new Date(2026, 0, 14, 10, 0);

/** Opens the welcome screen; `optedIn` stores the preference before the app boots. */
async function open(page: Page, { optedIn }: { optedIn: boolean }) {
  /* Only the wall clock moves to the morning: Playwright's clock would also take over timers and
   * animation frames, freezing Lia's animation loop. */
  await page.addInitScript((morning) => {
    const RealDate = Date;
    const offset = morning - RealDate.now();
    class MorningDate extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [RealDate.now() + offset]) as [number]));
      }
      static now() {
        return RealDate.now() + offset;
      }
    }
    window.Date = MorningDate as DateConstructor;
  }, MORNING.getTime());
  if (optedIn) {
    await page.addInitScript(() => localStorage.setItem('showLia', 'true'));
  }
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 15000,
  });
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 768;

/** Opens Settings from the account menu, which lives in the drawer on phones. */
async function openSettings(page: Page) {
  if (isPhone(page)) {
    const drawer = page.locator('#mobile-drawer');
    await expect(drawer).toBeAttached();
    await expect(async () => {
      if (await drawer.evaluate((element) => element.hasAttribute('inert'))) {
        await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 2_000 });
      }
      await expect(drawer).not.toHaveAttribute('inert', /.*/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  }
  const account = isPhone(page)
    ? page.locator('#mobile-drawer').getByTestId('nav-user')
    : page.getByTestId('nav-user');
  await account.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 10000,
  });
  if (isPhone(page)) {
    /* Phones open Settings on its section list; the General rows render once it is chosen. */
    await page.getByRole('dialog').getByText('General', { exact: true }).click();
  }
}

/** Closes Settings and, on phones, the drawer it was opened from. */
async function closeSettings(page: Page) {
  const heading = page.getByRole('heading', { name: 'Settings', exact: true });
  /* On phones the first Escape may step back to the section list before closing. */
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(heading).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  if (isPhone(page)) {
    const drawer = page.locator('#mobile-drawer');
    await expect(async () => {
      if (!(await drawer.evaluate((element) => element.hasAttribute('inert')))) {
        await page.getByRole('button', { name: 'Close sidebar' }).click({ timeout: 2_000 });
      }
      await expect(drawer).toHaveAttribute('inert', /.*/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  }
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
    await openSettings(page);
    const toggle = page.getByTestId('showLia');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await closeSettings(page);
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
    const body = page.getByTestId('lia-body');
    await body.hover();
    await expect(body).toHaveAttribute('title', /^Lia: \S/, { timeout: 5000 });
  });

  test('what Lia says stays inside her stage @scenario:lia-bubble-in-stage', async ({ page }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.pressSequentially('hello ', { delay: 50 });
    const bubble = page.getByTestId('lia-bubble');
    await expect(bubble).toHaveText('Hi!', { timeout: 5000 });
    const stage = await lia(page).evaluate((canvas) => {
      const { x, width } = (canvas.parentElement as HTMLElement).getBoundingClientRect();
      return { x, width };
    });
    /* Sampled while she waves, since the bubble follows her across frames. */
    for (let i = 0; i < 5; i++) {
      const box = await bubble.boundingBox();
      if (!box) {
        break;
      }
      expect(box.x).toBeGreaterThanOrEqual(stage.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
      await page.waitForTimeout(200);
    }
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

  test('a new chat opened during the farewell brings Lia back instead of hiding her @scenario:lia-farewell-cancelled-by-new-chat', async ({
    page,
  }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    const control = page.getByRole('button', { name: /^Lia: / });
    await sendMessage(page, 'Hello Lia');
    await expect(control).toHaveAccessibleName('Lia: Waves your message off');
    /* Back on the welcome screen inside the farewell, which would hide her for five seconds; the
     * header button stands in for the sidebar's link only while the sidebar is closed. */
    const header = page.getByTestId('header-new-chat-button');
    await (
      (await header.isVisible())
        ? header
        : page.getByRole('link', { name: 'New chat', exact: true })
    ).click();
    await expect(page).toHaveURL(/\/c\/new/);
    /* Unfixed, the farewell would keep her name on it for most of its 6.8 s. */
    await expect(control).toHaveAccessibleName('Lia: Boots up', { timeout: 3000 });
    await page.waitForTimeout(2500);
    await expect(control).not.toHaveAccessibleName('Lia: Waves your message off');
    await expect(lia(page)).toBeVisible();
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

    await openSettings(page);
    await expect(page.getByTestId('centerFormOnLanding')).toBeAttached();
    await expect(page.getByTestId('showLia')).toHaveCount(0);
  });

  test('Lia can be picked up, carried and set down on the composer @scenario:lia-drag-to-move', async ({
    page,
  }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    const start = await bodyBox(page);
    const composer = await page.getByRole('textbox', { name: 'Message input' }).boundingBox();
    if (!composer) {
      throw new Error('The composer has no box');
    }
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    /* Toward the other end of the composer from where she stands. */
    const target =
      from.x > composer.x + composer.width / 2
        ? composer.x + composer.width * 0.15
        : composer.x + composer.width * 0.85;
    const lift = { x: (from.x + target) / 2, y: from.y - 60 };
    const centerX = async () => {
      const box = await bodyBox(page);
      return box.x + box.width / 2;
    };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(lift.x, lift.y, { steps: 10 });
    /* While held she follows the pointer, off the composer. */
    await expect.poll(async () => Math.abs((await centerX()) - lift.x)).toBeLessThan(start.width);
    expect((await bodyBox(page)).y).toBeLessThan(start.y - 20);

    await page.mouse.move(target, lift.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(2500);
    const end = await bodyBox(page);
    expect(Math.abs(end.x + end.width / 2 - target)).toBeLessThan(Math.abs(from.x - target));
    expect(end.y + end.height).toBeLessThanOrEqual(composer.y + 4);
  });

  test('a keyboard user can pet Lia and move her along the composer @scenario:lia-keyboard-control', async ({
    page,
  }) => {
    await open(page, { optedIn: true });
    await expect(lia(page)).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(3500);
    const control = page.getByRole('button', { name: /^Lia: / });
    await expect(control).toHaveAccessibleDescription(/arrow keys/);
    await control.focus();
    await expect(control).toBeFocused();

    const composer = await page.getByRole('textbox', { name: 'Message input' }).boundingBox();
    if (!composer) {
      throw new Error('The composer has no box');
    }
    /* She stops at the end of the free span she stands in, and where the greeting cuts it short
     * depends on the fonts, so walk her both ways and measure the ground she covered. */
    const xs = [(await bodyBox(page)).x];
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowRight'] as const) {
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press(key);
      }
      await expect(control).toHaveAccessibleName('Lia: Lands with a thumbs up');
      /* The landing outranks a pet, so let it finish (1.6 s) before the next key. */
      await page.waitForTimeout(2000);
      const box = await bodyBox(page);
      expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 4);
      xs.push(box.x);
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40);

    await page.keyboard.press('Enter');
    await expect(control).toHaveAccessibleName('Lia: Gets petted');
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
