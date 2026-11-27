import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * The model disclaimer belongs to the welcome screen, where it is first read. It
 * used to repeat under the composer in every conversation, and it carried
 * `text-primary`, the weight of the greeting above it.
 *
 * The footer is hidden below `sm`, so both scenarios run on the desktop
 * projects and skip the mobile one.
 */

const DISCLAIMER = 'a[href="https://librechat.ai"]';
/** WCAG AA for body text; the disclaimer renders at 12px. */
const AA_CONTRAST = 4.5;

const skipBelowSm = (page: Page) => {
  const width = page.viewportSize()?.width ?? 0;
  test.skip(width < 640, 'the disclaimer is hidden below the sm breakpoint');
};

async function seedConversation(title: string) {
  const conversationId = randomUUID();
  await seedConversations(getE2EUser().email, [{ conversationId, title, updatedAt: new Date() }]);
  return conversationId;
}

async function contrastOfDisclaimer(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const link = document.querySelector<HTMLElement>(selector);
    if (!link) {
      throw new Error('the disclaimer is not rendered');
    }
    const parse = (value: string): [number, number, number] => {
      const parts = value.match(/[\d.]+/g);
      if (!parts || parts.length < 3) {
        throw new Error(`unreadable colour ${value}`);
      }
      return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    };
    const luminance = ([r, g, b]: [number, number, number]) => {
      const channel = (value: number) => {
        const ratio = value / 255;
        return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    /** The bar itself paints nothing; walk up to whatever fills behind it. */
    let node: HTMLElement | null = link;
    let background = 'rgba(0, 0, 0, 0)';
    while (node) {
      const painted = getComputedStyle(node).backgroundColor;
      if (painted && painted !== 'rgba(0, 0, 0, 0)' && painted !== 'transparent') {
        background = painted;
        break;
      }
      node = node.parentElement;
    }
    const foreground = luminance(parse(getComputedStyle(link).color));
    const behind = luminance(parse(background));
    const lighter = Math.max(foreground, behind);
    const darker = Math.min(foreground, behind);
    return (lighter + 0.05) / (darker + 0.05);
  }, DISCLAIMER);
}

test.describe('welcome screen disclaimer', () => {
  test('the disclaimer stays on the welcome screen and leaves the conversation @scenario:welcome-screen-disclaimer-only', async ({
    page,
  }) => {
    skipBelowSm(page);
    const conversationId = await seedConversation('Disclaimer placement');

    try {
      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(DISCLAIMER)).toBeVisible();

      await page.goto(`/c/${conversationId}`, { timeout: 10000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await expect(page.locator(DISCLAIMER)).toHaveCount(0);

      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(DISCLAIMER)).toBeVisible();
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the muted disclaimer still clears AA contrast @scenario:welcome-disclaimer-readable-while-muted', async ({
    page,
  }) => {
    skipBelowSm(page);
    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.locator(DISCLAIMER)).toBeVisible();

    const contrast = await contrastOfDisclaimer(page);
    expect(contrast).toBeGreaterThanOrEqual(AA_CONTRAST);
    /** Muted, not merely readable: the greeting's own weight is far above this. */
    expect(contrast).toBeLessThan(12);
  });
});
