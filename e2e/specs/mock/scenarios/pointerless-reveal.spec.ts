import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import {
  REPLY_TEXT,
  createProject,
  deleteChat,
  deleteProject,
  earlierReplyCopy,
  paintedOpacity,
  projectRow,
  replyTimestamp,
  seedReplyChat,
} from './reveal.helpers';

/**
 * A device with no pointer and no hover, such as a keyboard-only setup. No coarse pointer exists
 * there either, so a hiding rule gated only on its absence would hide controls that no hover can
 * ever reveal. Described to Blink directly, the same way the 2-in-1 spec does.
 */
test.use({
  hasTouch: false,
  isMobile: false,
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: [
      '--blink-settings=availablePointerTypes=1,primaryPointerType=1,availableHoverTypes=1,primaryHoverType=1',
    ],
  },
});
test.describe.configure({ timeout: 120_000 });

test('a pointerless device shows message actions, the timestamp and project row actions @scenario:pointerless-reveal-controls-visible', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('navVisible', 'true'));
  const conversationId = await seedReplyChat(`Pointerless reveal ${randomUUID().slice(0, 8)}`);
  await page.goto(`/c/${conversationId}`, { timeout: 15000 });
  const name = `Pointerless project ${randomUUID().slice(0, 8)}`;
  const projectId = await createProject(page, name);
  try {
    expect(
      await page.evaluate(() => ({
        hover: matchMedia('(hover: hover)').matches,
        coarse: matchMedia('(any-pointer: coarse)').matches,
      })),
    ).toEqual({ hover: false, coarse: false });
    await page.reload();
    await expect(page.getByText(REPLY_TEXT, { exact: true }).first()).toBeVisible({
      timeout: 20000,
    });

    expect(await paintedOpacity(earlierReplyCopy(page))).toBe(1);
    expect(await paintedOpacity(replyTimestamp(page))).toBe(1);

    const row = projectRow(page, name);
    await expect(row).toBeVisible({ timeout: 20000 });
    expect(
      await paintedOpacity(row.getByRole('button', { name: 'More options', exact: true })),
    ).toBe(1);
  } finally {
    await deleteProject(page, projectId);
    await deleteChat(conversationId);
  }
});
