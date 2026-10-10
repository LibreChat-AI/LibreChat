import { expect, test } from '@playwright/test';
import { computedStyles } from './style.helpers';

/**
 * `cn()` is `twMerge(clsx(...))`, so it deletes any class it believes conflicts
 * with a later one — and `tailwind-merge@1.9.1` predates Tailwind 3.3, so its
 * conflict map is wrong in two ways that reach this app. It has one group for
 * every `touch-*` utility, which are combinable, so the earlier one is dropped.
 * And it has no group for `size-*` at all, so both survive and the stylesheet
 * order decides, which is never what the caller asked for.
 *
 * Both scenarios below name a surface whose classes really pass through `cn()`
 * and ask the browser what the element got. Under 1.9.1 each reports the other
 * value; the merged `class` attribute is included because it is the merge's own
 * output, and the computed style is what a user sees of it.
 */

test.describe('classes that survive cn()', () => {
  test.describe('the mobile drawer', () => {
    /** Below `sm` the sidebar is a drawer; the mock config has one desktop
     *  project, so the spec declares the viewport it describes. */
    test.use({ viewport: { width: 390, height: 844 } });

    test('the mobile drawer keeps vertical panning @scenario:the-mobile-drawer-keeps-vertical-panning', async ({
      page,
    }) => {
      await page.goto('/c/new', { timeout: 30000 });

      const drawer = page.locator('#mobile-drawer');
      await expect(drawer).toBeAttached({ timeout: 30000 });

      /** `touch-pan-y touch-pinch-zoom` is the pair the drawer writes: the close
       *  swipe reads horizontal touches, and zoom stays with the browser. v1
       *  groups every `touch-*` utility together and keeps only the last, so the
       *  drawer lost vertical panning — a surface that no longer scrolls. */
      const { touchAction } = await computedStyles(drawer, ['touchAction']);
      expect(touchAction).toContain('pan-y');
      expect(touchAction).toContain('pinch-zoom');
      await expect(drawer).toHaveClass(/touch-pan-y/);
    });
  });

  test('a header icon button keeps the size its caller set @scenario:a-header-icon-button-keeps-the-size-its-caller-set', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new', { timeout: 30000 });

    /** The header's overflow trigger is a `Button size="icon"`, whose recipe
     *  contributes `size-10`, with `size-9` written by the call site. `cn()` has
     *  to keep the caller's: 1.9.1 knows no `size-*` group, so it keeps both,
     *  and `.size-10` is emitted after `.size-9` — the button silently renders
     *  at 40px instead of the 36px the header lays out for. It is `md:hidden`,
     *  so the assertion reads the computed box, which is defined whether or not
     *  the viewport shows it. */
    const trigger = page.getByTestId('header-overflow-menu');
    await expect(trigger).toBeAttached({ timeout: 30000 });

    await expect(trigger).toHaveClass(/\bsize-9\b/);
    await expect(trigger).not.toHaveClass(/\bsize-10\b/);

    const { width, height } = await computedStyles(trigger, ['width', 'height']);
    expect(width).toBe('36px');
    expect(height).toBe('36px');
  });
});
