import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  REPLY_TEXT,
  createProject,
  deleteChat,
  deleteProject,
  hitAtCenter,
  paintedOpacity,
  projectRow,
  seedReplyChat,
} from './reveal.helpers';

/**
 * A 2-in-1: a trackpad that hovers beside a touchscreen. Chromium's own touch emulation makes the
 * primary pointer coarse and drops hover, which is a phone, so the device is described to Blink
 * directly: fine and coarse pointers available, the fine one primary, and hover available. That
 * is the case `(hover: hover)` answers "yes" for while a finger still cannot hover, and every
 * reveal-on-hover control has to be visible and tappable without it.
 */
test.use({
  hasTouch: false,
  isMobile: false,
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: [
      '--blink-settings=availablePointerTypes=6,primaryPointerType=4,availableHoverTypes=3,primaryHoverType=2',
    ],
  },
});
test.describe.configure({ timeout: 120_000 });

async function expectTwoInOne(page: Page) {
  const media = await page.evaluate(() => ({
    hover: matchMedia('(hover: hover)').matches,
    coarse: matchMedia('(any-pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
  }));
  expect(media).toEqual({ hover: true, coarse: true, fine: true });
}

/** A finger tap: touch events through the protocol, so no mouse hover precedes it. */
async function tap(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

/** Opening the sidebar with a click would leave the mouse over it, so it is opened by default. */
async function openWithSidebar(page: Page, path: string) {
  await page.addInitScript(() => localStorage.setItem('navVisible', 'true'));
  await page.goto(path, { timeout: 15000 });
}

test('a 2-in-1 shows message actions and the timestamp without hover @scenario:two-in-one-message-actions-visible', async ({
  page,
}) => {
  const conversationId = await seedReplyChat(`2-in-1 reveal ${randomUUID().slice(0, 8)}`);
  try {
    await openWithSidebar(page, `/c/${conversationId}`);
    await expectTwoInOne(page);
    await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
      timeout: 20000,
    });

    const copy = page.getByTestId('copy-response-button').first();
    await expect(copy).toBeAttached();
    expect(await paintedOpacity(copy)).toBe(1);
    expect(await hitAtCenter(copy)).toBe(true);

    const timestamp = page.locator('.message-render .message-timestamp').first();
    await expect(timestamp).toBeAttached();
    expect(await paintedOpacity(timestamp)).toBe(1);
  } finally {
    await deleteChat(conversationId);
  }
});

test('a 2-in-1 shows a project row action and opens it with a tap @scenario:two-in-one-project-row-actions-tappable', async ({
  page,
}) => {
  await openWithSidebar(page, '/c/new');
  await expectTwoInOne(page);
  const name = `2-in-1 project ${randomUUID().slice(0, 8)}`;
  const projectId = await createProject(page, name);
  try {
    await page.reload();
    const row = projectRow(page, name);
    await expect(row).toBeVisible({ timeout: 20000 });
    const options = row.getByRole('button', { name: 'More options', exact: true });
    const newChat = row.getByRole('link', { name: `New chat in ${name}`, exact: true });

    for (const action of [newChat, options]) {
      expect(await paintedOpacity(action)).toBe(1);
      expect(await hitAtCenter(action)).toBe(true);
    }

    await tap(page, options);
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await deleteProject(page, projectId);
  }
});
