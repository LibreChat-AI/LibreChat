import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH, messagesView, sendMessageAndWaitForCompletion } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * Theme-sized controls read their inline padding and icon-to-label gap from control roles, apart
 * from the shared spacing that also pads message bubbles and the composer's send button. The
 * temporary-chat status chip is a real `size="theme"` control on the chat header.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const TOGGLE = 'button[aria-label="Temporary Chat"]';

/** A definition from before the control roles, which named only the shared spacing. */
const legacySpacingTheme: ThemeDefinition = {
  version: 1,
  name: 'legacy-spacing-reference',
  modes: {
    light: { appearance: { spaceNormal: '0.5rem', spaceCompact: '0.25rem' } },
    dark: { appearance: { spaceNormal: '0.5rem', spaceCompact: '0.25rem' } },
  },
};

async function storeDefinition(page: Page, definition: ThemeDefinition | null) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored === null) {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
      return;
    }
    localStorage.setItem('theme-definition', JSON.stringify(stored));
    localStorage.setItem('theme-source', 'definition');
  }, definition);
}

/**
 * Starts a temporary chat and returns its header status chip, which appears once the first
 * message is sent; the exchange also renders a message bubble padded by the shared spacing.
 */
async function temporaryChip(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const toggle = page.locator(TOGGLE);
  await expect(toggle).toBeVisible({ timeout: 20000 });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await sendMessageAndWaitForCompletion(page, 'Control spacing probe');
  const chip = page.getByRole('status').filter({ has: page.locator('svg.lucide-hat-glasses') });
  await expect(chip).toBeVisible({ timeout: 20000 });
  return chip;
}

/** The mode is persisted locally, so the next scenario starts from a normal chat. */
async function leaveTemporaryChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const toggle = page.locator(TOGGLE);
  await expect(toggle).toBeVisible({ timeout: 20000 });
  if ((await toggle.getAttribute('aria-pressed')) === 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

/** The sent message's bubble, the one element padded by `px-theme-normal`. */
const bubblePadding = (page: Page) =>
  messagesView(page)
    .locator('.px-theme-normal')
    .first()
    .evaluate((node: HTMLElement) => getComputedStyle(node).paddingLeft);

const spacing = (chip: Locator) =>
  chip.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      gap: style.columnGap,
    };
  });

test.describe('theme control spacing', () => {
  test('theme-sized controls keep 12px padding and a 6px gap without a theme @scenario:theme-controls-keep-default-spacing', async ({
    page,
  }) => {
    await storeDefinition(page, null);
    const chip = await temporaryChip(page);

    expect(await spacing(chip)).toEqual({ paddingLeft: '12px', paddingRight: '12px', gap: '6px' });
    expect(await probeStyle(page, 'px-theme-control-x', 'padding-left')).toBe('12px');
    expect(await probeStyle(page, 'gap-theme-control-gap', 'column-gap')).toBe('6px');
    expect(await bubblePadding(page)).toBe('12px');

    await leaveTemporaryChat(page);
  });

  test('ClickHouse controls take Click UI button padding and gap while message spacing stays @scenario:clickhouse-controls-take-click-ui-spacing', async ({
    page,
  }) => {
    await storeDefinition(page, clickHouseTheme);
    const chip = await temporaryChip(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

    /** `button.basic.space.x` and `button.basic.space.gap`. */
    expect(await spacing(chip)).toEqual({ paddingLeft: '16px', paddingRight: '16px', gap: '8px' });
    /** Message bubbles keep `spaceNormal`, which Click UI's `spaces.3` matches, and the compact
     *  spacing takes `spaces.2`. */
    expect(await bubblePadding(page)).toBe('12px');
    expect(await probeStyle(page, 'p-theme-compact', 'padding-top')).toBe('8px');

    await leaveTemporaryChat(page);
  });

  test('a theme naming only the shared spacing keeps its controls on it @scenario:legacy-space-theme-keeps-control-spacing', async ({
    page,
  }) => {
    await storeDefinition(page, legacySpacingTheme);
    const chip = await temporaryChip(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-spacing-reference');

    expect(await spacing(chip)).toEqual({ paddingLeft: '8px', paddingRight: '8px', gap: '4px' });
    expect(await bubblePadding(page)).toBe('8px');

    await leaveTemporaryChat(page);
  });
});
