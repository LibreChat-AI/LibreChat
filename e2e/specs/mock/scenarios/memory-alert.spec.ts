import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * A memory that could not be saved shows its reason in an Alert under the memory row. The Alert
 * takes the library's own shape, so the same reason reads the same in every theme and both modes.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';

test.use({ viewport: { width: 1280, height: 800 } });

async function installThemeBridge(page: Page, definition: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

async function seedMemoryChat(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Memory alert', updatedAt: new Date() },
  ]);
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Remember my whole life story.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      text: 'I could not save that.',
      content: [{ type: 'text', text: 'I could not save that.' }],
      isCreatedByUser: false,
      sender: 'Mock Provider A',
      attachments: [
        {
          file_id: randomUUID(),
          filename: 'memory',
          type: 'memory',
          messageId: assistantMessageId,
          conversationId,
          memory: {
            key: 'life-story',
            type: 'error',
            value: JSON.stringify({ errorType: 'would_exceed', tokenCount: 4200 }),
          },
        },
      ],
    },
  ]);
  return conversationId;
}

/** Opens the memory row and reads the reason Alert's box and paint. */
async function memoryAlert(page: Page, conversationId: string, mode: Mode, theme: string) {
  await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
  const toggle = page.getByRole('button', { name: 'Updated saved memory' });
  await expect(toggle).toBeVisible({ timeout: 20000 });
  await toggle.click();
  const alert = page.getByRole('alert').filter({ hasText: 'Cannot save - would exceed limit' });
  await expect(alert).toBeVisible();
  /** The row opens with a height transition; the shot is taken once it has settled. A looping
   *  animation never finishes: a long chat list keeps skeleton rows pulsing in the sidebar. */
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
  await expect(alert).toBeInViewport({ ratio: 1 });
  await test.info().attach(`memory-alert-${theme}-${mode}`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  return alert.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      paddingInline: style.paddingLeft,
      paddingBlock: style.paddingTop,
      radius: parseFloat(style.borderTopLeftRadius),
      ink: style.color,
    };
  });
}

/** Opens the memory limit reason in both modes and checks the Alert's shared box. */
async function expectSharedShape(page: Page, theme: string, definition: unknown) {
  const conversationId = await seedMemoryChat();
  await installThemeBridge(page, definition);
  try {
    for (const mode of MODES) {
      const box = await memoryAlert(page, conversationId, mode, theme);
      expect(box.paddingInline).toBe('16px');
      expect(box.paddingBlock).toBe('12px');
      expect(box.radius).toBeGreaterThan(6);
      expect(box.ink).not.toBe('');
    }
  } finally {
    await deleteConversations([conversationId]);
  }
}

test.describe('memory save errors', () => {
  test('the memory limit reason keeps the shared Alert shape in the default theme in both modes @scenario:memory-alert-keeps-the-shared-shape-default', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await expectSharedShape(page, 'default', null);
  });

  test('the memory limit reason keeps the shared Alert shape in the ClickHouse theme in both modes @scenario:memory-alert-keeps-the-shared-shape-clickhouse', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await expectSharedShape(page, 'clickhouse', clickHouseTheme);
  });
});
