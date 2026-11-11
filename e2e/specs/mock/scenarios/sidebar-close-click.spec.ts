import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Clicking the sidebar's close toggle closes it without a runtime error. The toggle used to hand
 * its click event to the close handler as the post-slide callback, which then threw when invoked:
 * synchronously on desktop and with reduced motion, from `requestAnimationFrame` on the animated
 * phone drawer.
 */

const DRAWER = '#mobile-drawer';

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openSidebar(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });

  if (isPhone(page)) {
    const drawer = page.locator(DRAWER);
    if (!(await drawer.getByTestId('close-sidebar-button').isVisible())) {
      await page.getByTestId('header-open-sidebar-button').click();
    }
    await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
    await expect(drawer).not.toHaveAttribute('inert');
    return drawer.getByTestId('close-sidebar-button');
  }

  const opener = page.getByTestId('open-sidebar-button');
  if (await opener.isVisible()) {
    await opener.click();
  }
  const close = page.getByTestId('close-sidebar-button');
  await expect(close).toBeVisible();
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  return close;
}

async function closeAndExpectNoError(page: Page, errors: string[]) {
  const close = await openSidebar(page);
  await close.click();

  if (isPhone(page)) {
    await expect(page.locator(DRAWER)).toHaveCSS('visibility', 'hidden');
  } else {
    await expect(page.getByTestId('open-sidebar-button')).toHaveAttribute('aria-expanded', 'false');
  }
  /** The animated drawer runs the post-slide callback three frames after the click. */
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))),
      ),
  );
  expect(errors, `Unexpected runtime errors: ${errors.join(', ')}`).toEqual([]);
}

test.describe('sidebar close toggle', () => {
  test('closing the sidebar with its toggle raises no runtime error @scenario:sidebar-close-toggle-raises-no-error', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await closeAndExpectNoError(page, errors);
  });

  test('closing the sidebar with reduced motion raises no runtime error @scenario:sidebar-close-reduced-motion-raises-no-error', async ({
    page,
  }) => {
    const errors = collectPageErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await closeAndExpectNoError(page, errors);
  });
});
