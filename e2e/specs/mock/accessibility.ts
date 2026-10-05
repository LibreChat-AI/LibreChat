import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export async function expectAccessible(page: Page) {
  // Dialog fades blend theme colors with the scrim; scan the settled interface.
  // Leave continuous progress animations and paused animations alone.
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity),
      );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
  });
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
}
