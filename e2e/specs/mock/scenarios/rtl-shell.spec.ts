import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * In a right-to-left locale the app shell mirrors: the sidebar and the mobile drawer sit on the
 * right, the drawer slides in from the right and a swipe follows the finger, the resize handle
 * sits on the sidebar's left edge and grows it toward the left, submenus and rail tooltips open
 * toward the content, and the artifacts panel lands on the inline end while its handle still
 * follows the pointer.
 *
 * Arabic is chosen through the stored language, the same path the language setting writes, so
 * `<html dir="rtl">` comes from i18n rather than from the test. Controls are found by test id,
 * role or untranslated text because the visible copy is Arabic.
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const HTML_ARTIFACT = 'E2E HTML Artifact';

async function useArabic(page: Page, navVisible?: boolean) {
  await page.addInitScript((visible) => {
    localStorage.setItem('lang', JSON.stringify('ar'));
    if (visible != null) {
      localStorage.setItem('navVisible', JSON.stringify(visible));
    }
  }, navVisible ?? null);
}

async function openRtl(page: Page, path = NEW_CHAT_PATH) {
  await page.goto(path, { timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl', { timeout: 30000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function firstVisible(candidates: Locator): Promise<Locator> {
  await expect
    .poll(async () => {
      for (const candidate of await candidates.all()) {
        if (await candidate.isVisible()) {
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  for (const candidate of await candidates.all()) {
    if (await candidate.isVisible()) {
      return candidate;
    }
  }
  throw new Error('no visible candidate');
}

/** Resolves once two reads of the element's box agree, so a transition has finished. */
async function still(locator: Locator) {
  let last = '';
  await expect
    .poll(async () => {
      const rect = await box(locator);
      const current = [rect.x, rect.width].map(Math.round).join(',');
      const same = current === last;
      last = current;
      return same;
    })
    .toBe(true);
}

/**
 * A slide hands its inline transform back to the classes a beat after it lands, and the gesture
 * ignores touches until then, so a swipe waits for that hand-off like a finger would.
 */
async function settled(drawer: Locator) {
  await expect
    .poll(() => drawer.evaluate((node) => (node as HTMLElement).style.transform))
    .toBe('');
}

/** A one-finger horizontal drag through the protocol, in small steps like a real swipe. */
async function swipe(session: CDPSession, from: { x: number; y: number }, dx: number) {
  const steps = 12;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= steps; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * step) / steps, y: from.y }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Asserts the open artifacts panel's placement and drag in RTL. */
async function expectArtifactsHandleFollowsPointer(page: Page, panel: Locator) {
  const handle = page.locator('[role="separator"]:not([aria-label="Resize sidebar"])').first();
  await expect(handle).toBeVisible();
  /** The panel opens with a transition; measure once the handle has stopped moving. */
  await still(handle);
  const panelBox = await box(panel);
  const handleBox = await box(handle);
  const messagesBefore = await box(messagesView(page));
  /** Inline end is the left in RTL: artifacts, then the handle, then the messages. */
  expect(panelBox.x + panelBox.width / 2).toBeLessThan(handleBox.x);
  expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(messagesBefore.x + 2);

  /**
   * Dragging the handle right by 80px moves it 80px right, widening the artifacts and narrowing
   * the messages by as much. The drag runs toward the messages so the pointer never crosses the
   * preview iframe, which takes pointer events for itself in either direction.
   */
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 4 });
  await page.mouse.move(x + 80, y, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await box(handle)).x - handleBox.x))
    .toBeGreaterThanOrEqual(70);
  const moved = await box(handle);
  expect(moved.x - handleBox.x).toBeLessThanOrEqual(90);
  const messagesAfter = await box(messagesView(page));
  expect(messagesBefore.width - messagesAfter.width).toBeGreaterThan(60);
}

test.describe('phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the mobile drawer opens from the right edge and follows a swipe in RTL @scenario:rtl-mobile-drawer-opens-from-the-right-and-follows-swipes', async ({
    page,
  }) => {
    await useArabic(page);
    await openRtl(page);
    await expect(page.locator('#prompt-textarea')).toBeVisible({ timeout: 30000 });

    const drawer = page.locator('#mobile-drawer');
    const closeButton = drawer.getByTestId('close-sidebar-button');
    if (!(await closeButton.isVisible())) {
      await page.getByTestId('header-open-sidebar-button').click();
    }
    await expect(closeButton).toBeVisible();
    await expect(drawer).not.toHaveAttribute('inert');
    /** Anchored to the inline start, which is the right edge in RTL. */
    await expect
      .poll(async () => {
        const rect = await box(drawer);
        return Math.round(rect.x + rect.width);
      })
      .toBe(PHONE.width);

    const session = await page.context().newCDPSession(page);
    try {
      /** Closing travels toward the edge the drawer hides behind: rightward in RTL. */
      await settled(drawer);
      const open = await box(drawer);
      await swipe(session, { x: open.x + open.width / 2, y: open.y + open.height / 2 }, 240);
      await expect
        .poll(async () => Math.round((await box(drawer)).x))
        .toBeGreaterThanOrEqual(PHONE.width);
      await expect(page.getByTestId('header-open-sidebar-button')).toBeVisible();

      /** Opening from the pane travels away from that edge: leftward in RTL. */
      await settled(drawer);
      await swipe(session, { x: PHONE.width - 60, y: PHONE.height / 3 }, -260);
      await expect
        .poll(async () => {
          const rect = await box(drawer);
          return Math.round(rect.x + rect.width);
        })
        .toBe(PHONE.width);
      await expect(closeButton).toBeVisible();
    } finally {
      await session.detach();
    }

    /** The close control's icon mirrors with the layout. */
    const icon = closeButton.locator('svg').first();
    const scale = await icon.evaluate((node) => getComputedStyle(node).scale);
    expect(scale.split(' ')[0]).toBe('-1');
  });
});

test.describe('desktop', () => {
  test.use({ viewport: DESKTOP, hasTouch: false, isMobile: false });

  test('the sidebar resize handle grows the sidebar toward the left in RTL @scenario:rtl-sidebar-resize-follows-pointer-and-arrow-keys', async ({
    page,
  }) => {
    await useArabic(page, true);
    await openRtl(page);

    const handle = page.getByRole('separator', { name: 'Resize sidebar' });
    await expect(handle).toBeVisible({ timeout: 30000 });
    const sidebar = handle.locator('xpath=..');
    const initial = await box(sidebar);
    /** The sidebar hugs the right edge and its handle sits on its left edge. */
    expect(Math.round(initial.x + initial.width)).toBe(DESKTOP.width);
    const handleBox = await box(handle);
    expect(handleBox.x).toBeLessThan(initial.x + 8);

    /** Arrow keys: the arrow pointing away from the sidebar (left) grows it. */
    await handle.focus();
    const valueOf = async () => Number(await handle.getAttribute('aria-valuenow'));
    const start = await valueOf();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(valueOf).toBeGreaterThan(start);
    const grown = await valueOf();
    await page.keyboard.press('ArrowRight');
    await expect.poll(valueOf).toBeLessThan(grown);

    /** Pointer: dragging left by 60px widens the sidebar by the same 60px. */
    await still(sidebar);
    await still(handle);
    const before = await box(sidebar);
    const grab = await box(handle);
    const x = grab.x + grab.width / 2;
    const y = grab.y + grab.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 30, y, { steps: 4 });
    await page.mouse.move(x - 60, y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.round((await box(sidebar)).width - before.width))
      .toBeGreaterThanOrEqual(55);
    const after = await box(sidebar);
    expect(after.width - before.width).toBeLessThanOrEqual(65);
    expect(Math.round(after.x + after.width)).toBe(DESKTOP.width);
  });

  test('account menu submenus open toward the content and by the left arrow in RTL @scenario:rtl-account-submenu-opens-toward-the-content', async ({
    page,
  }) => {
    await useArabic(page, true);
    await openRtl(page);

    await (await firstVisible(page.getByTestId('nav-user'))).click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    const help = menu.locator('[role="menuitem"][aria-haspopup]').first();
    await expect(help).toBeVisible();

    await help.focus();
    await page.keyboard.press('ArrowLeft');
    const submenu = page.getByRole('menu').nth(1);
    await expect(submenu).toBeVisible();
    await expect(help).toHaveAttribute('aria-expanded', 'true');

    const helpBox = await box(help);
    const submenuBox = await box(submenu);
    /** Toward the content is leftward in RTL, where the sidebar is on the right. */
    expect(submenuBox.x + submenuBox.width).toBeLessThanOrEqual(helpBox.x + 8);
  });

  test('collapsed rail tooltips open toward the content in RTL @scenario:rtl-rail-tooltips-open-toward-the-content', async ({
    page,
  }) => {
    await useArabic(page, false);
    await openRtl(page);

    const newChat = await firstVisible(page.getByTestId('new-chat-button'));
    const buttonBox = await box(newChat);
    /** The rail sits on the right edge. */
    expect(buttonBox.x).toBeGreaterThan(DESKTOP.width / 2);

    await newChat.hover();
    const tooltip = page.getByRole('tooltip').first();
    await expect(tooltip).toBeVisible();
    const tooltipBox = await box(tooltip);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(buttonBox.x + 2);
  });

  test('the artifacts panel sits on the inline end and its handle follows the pointer in RTL @scenario:rtl-artifacts-panel-on-inline-end-and-handle-follows-pointer', async ({
    page,
  }) => {
    test.setTimeout(150000);

    /** The reply is produced in English, where the shared helpers find their controls. */
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/);
    const conversationPath = new URL(page.url()).pathname;

    await page.evaluate(() => localStorage.setItem('lang', JSON.stringify('ar')));
    await openRtl(page, conversationPath);

    await messagesView(page)
      .getByRole('button', { name: new RegExp(HTML_ARTIFACT) })
      .click();
    const panel = page.getByRole('region', { name: HTML_ARTIFACT });
    await expect(panel).toBeVisible({ timeout: 30000 });

    await expectArtifactsHandleFollowsPointer(page, panel);
  });

  test('switching to RTL with the artifacts panel open keeps its handle following the pointer @scenario:rtl-live-language-switch-keeps-artifacts-handle-following-pointer', async ({
    page,
  }) => {
    test.setTimeout(150000);

    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/);
    await messagesView(page)
      .getByRole('button', { name: new RegExp(HTML_ARTIFACT) })
      .click();
    const panel = page.getByRole('region', { name: HTML_ARTIFACT });
    await expect(panel).toBeVisible({ timeout: 30000 });
    await expect(page.locator('html')).not.toHaveAttribute('dir', 'rtl');

    /** The panels mount in LTR order; Arabic is then picked in Settings without a reload. */
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('combobox', { name: /^Language/ }).click();
    await page.getByRole('option', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(panel).toBeVisible();
    await expectArtifactsHandleFollowsPointer(page, panel);

    /** The arrow keys move the handle the way they point, as they did before the switch. */
    const handle = page.locator('[role="separator"]:not([aria-label="Resize sidebar"])').first();
    await handle.focus();
    const before = await box(handle);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await box(handle)).x - before.x).toBeGreaterThan(10);
    const after = await box(handle);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => after.x - (await box(handle)).x).toBeGreaterThan(10);
  });
});
