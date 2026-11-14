import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Provider brand tokens are bare custom properties on the document root
 * (`--provider-*`), declared by the theme defaults, and are not exposed as
 * `--color-*` utilities. The served app is the only place both stylesheets are
 * parsed together, so this reads what the browser resolves.
 */
test.describe('provider brand tokens', () => {
  test('@scenario:provider-brand-tokens-are-bare-custom-properties a brand token resolves on the root without a color utility', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    const resolved = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        brand: style.getPropertyValue('--provider-anthropic').trim(),
        utility: style.getPropertyValue('--color-provider-anthropic').trim(),
      };
    });

    expect(resolved.brand).not.toBe('');
    expect(resolved.utility).toBe('');
  });
});
