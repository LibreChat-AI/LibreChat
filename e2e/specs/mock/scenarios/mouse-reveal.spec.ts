import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import {
  REPLY_TEXT,
  createProject,
  deleteChat,
  deleteProject,
  paintedOpacity,
  projectRow,
  seedReplyChat,
} from './reveal.helpers';

/**
 * A mouse-only desktop keeps the reveal: message actions, the message timestamp and a project
 * row's actions stay hidden while the pointer is elsewhere, and come back on hover and on
 * keyboard focus. Every project runs this on a desktop context, since the mobile one has no hover
 * to test.
 */
test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 120_000 });

test('a mouse desktop reveals message actions on hover and keyboard focus @scenario:mouse-desktop-message-actions-reveal', async ({
  page,
}) => {
  const conversationId = await seedReplyChat(`Mouse reveal ${randomUUID().slice(0, 8)}`);
  try {
    await page.goto(`/c/${conversationId}`, { timeout: 15000 });
    expect(
      await page.evaluate(
        () => matchMedia('(hover: hover)').matches && !matchMedia('(any-pointer: coarse)').matches,
      ),
    ).toBe(true);
    const reply = page.getByText(REPLY_TEXT, { exact: true }).first();
    await expect(reply).toBeVisible({ timeout: 20000 });
    const copy = page.getByTestId('copy-response-button').first();
    const timestamp = page.locator('.message-render .message-timestamp').first();
    await expect(copy).toBeAttached();
    await expect(timestamp).toBeAttached();

    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(copy)).toBe(0);
    await expect.poll(() => paintedOpacity(timestamp)).toBe(0);

    await reply.hover();
    await expect.poll(() => paintedOpacity(copy)).toBe(1);
    await expect.poll(() => paintedOpacity(timestamp)).toBe(1);

    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(copy)).toBe(0);
    await page.keyboard.press('Shift');
    await copy.focus();
    await expect.poll(() => paintedOpacity(copy)).toBe(1);
  } finally {
    await deleteChat(conversationId);
  }
});

test('a mouse desktop reveals project row actions on hover and keyboard focus @scenario:mouse-desktop-project-row-actions-reveal', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('navVisible', 'true'));
  await page.goto('/c/new', { timeout: 15000 });
  const name = `Mouse project ${randomUUID().slice(0, 8)}`;
  const projectId = await createProject(page, name);
  try {
    await page.reload();
    const row = projectRow(page, name);
    await expect(row).toBeVisible({ timeout: 20000 });
    const options = row.getByRole('button', { name: 'More options', exact: true });

    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(options)).toBe(0);

    await row.hover();
    await expect.poll(() => paintedOpacity(options)).toBe(1);

    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(options)).toBe(0);
    await page.keyboard.press('Shift');
    await options.focus();
    await expect.poll(() => paintedOpacity(options)).toBe(1);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await deleteProject(page, projectId);
  }
});
