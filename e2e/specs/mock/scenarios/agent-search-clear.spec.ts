import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

/** The ink a control draws, resolved to the colour the browser paints. */
const readInk = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color);

test.describe('agent search clear button', () => {
  test('@scenario:agent-search-clear-quiet-ink the clear button rests in the secondary ink and rises to the primary ink on hover', async ({
    page,
  }) => {
    await page.goto('/agents/all', { timeout: 10000 });
    const search = page.locator('#agent-search');
    await expect(search).toBeVisible({ timeout: 30000 });
    await search.fill('clear me');

    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await expect(clear).toBeVisible();

    const probe = await page.evaluate(() => {
      const paint = (variable: string) => {
        const element = document.createElement('span');
        element.style.color = `rgb(var(${variable}))`;
        document.body.appendChild(element);
        const color = getComputedStyle(element).color;
        element.remove();
        return color;
      };
      return { secondary: paint('--text-secondary'), primary: paint('--text-primary') };
    });

    expect(await readInk(clear)).toBe(probe.secondary);
    await clear.hover();
    await expect.poll(() => readInk(clear)).toBe(probe.primary);

    await clear.click();
    await expect(search).toHaveValue('');
    await expect(clear).toBeHidden();
  });
});
