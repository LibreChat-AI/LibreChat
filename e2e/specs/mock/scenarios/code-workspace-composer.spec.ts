import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  installCodeMocks,
  openCodeChat,
  secondMachine,
  singleMachine,
  workspace,
} from './codeWorkspaceMocks';

const APPROVAL = '[data-testid="code-approval-mode"]';
const WORKSPACE = '[data-testid="code-workspace"]';
const CHECKOUT = '[data-testid="code-checkout"]';

const chip = (page: Page, selector: string) => page.locator(selector);
const openMenu = (page: Page) => page.getByRole('menu');

async function openChip(page: Page, selector: string): Promise<Locator> {
  await chip(page, selector).click();
  const menu = openMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(openMenu(page)).toHaveCount(0);
}

const parseSeconds = (value: string) => {
  const first = value.split(',')[0].trim();
  return first.endsWith('ms') ? parseFloat(first) / 1000 : parseFloat(first);
};

test.describe('composer code workspace chips', () => {
  test('approval and workspace menus fade and scale in @scenario:code-chip-menus-animate-scale-and-fade', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()] });
    await openCodeChat(page);
    const reduced = await page.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );

    for (const selector of [APPROVAL, WORKSPACE]) {
      const menu = await openChip(page, selector);
      /** Sample the settled state: the enter transition has ended. */
      await expect
        .poll(() => menu.evaluate((element) => getComputedStyle(element).opacity))
        .toBe('1');
      const style = await menu.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          property: computed.transitionProperty,
          duration: computed.transitionDuration,
          opacity: computed.opacity,
          transform: computed.transform,
          scale: computed.scale,
        };
      });
      if (reduced) {
        expect(style.duration.split(',').every((value) => parseSeconds(value) === 0)).toBe(true);
      } else {
        expect(style.property).toContain('opacity');
        expect(style.property).toContain('scale');
        expect(style.property).toContain('translate');
        expect(parseSeconds(style.duration)).toBeGreaterThan(0);
        expect(parseSeconds(style.duration)).toBeLessThanOrEqual(0.2);
      }
      expect(style.opacity).toBe('1');
      expect(['none', '1', '1 1']).toContain(style.scale);
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(style.transform);
      await closeMenu(page);
    }
  });

  test('workspace rows are one line each @scenario:workspace-menu-rows-are-single-line', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()] });
    await openCodeChat(page);
    const menu = await openChip(page, WORKSPACE);

    for (const name of ['primary', 'librechat', 'agents', 'librechat-ai']) {
      const row = menu.getByRole('menuitemradio', { name: new RegExp(`^${name}(\\s|$)`) });
      await expect(row).toHaveCount(1);
      const box = await row.boundingBox();
      expect(box, `${name} row`).not.toBeNull();
      expect(box?.height ?? Infinity, `${name} row height`).toBeLessThan(40);
    }
    await expect(
      menu.getByRole('menuitemradio', { name: /librechat.*danny-avila\/LibreChat · dev/ }),
    ).toBeVisible();
    await expect(menu.getByText('AGENTS.md')).toHaveCount(0);
    await expect(menu.getByText('CLAUDE.md')).toHaveCount(0);
    await expect(menu.getByText('Checkout mode')).toHaveCount(0);
  });

  test('the checkout chip returns to Auto @scenario:checkout-chip-restores-auto', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()] });
    await openCodeChat(page);
    const checkout = chip(page, CHECKOUT);
    await expect(checkout).toContainText('Auto checkout');

    let menu = await openChip(page, CHECKOUT);
    await menu.getByRole('menuitemradio', { name: /Isolated worktree/ }).click();
    await expect(openMenu(page)).toHaveCount(0);
    await expect(checkout).toContainText('Worktree');
    await expect(checkout).not.toContainText('Auto checkout');

    menu = await openChip(page, CHECKOUT);
    await expect(menu.getByRole('menuitemradio', { name: /Isolated worktree/ })).toBeChecked();
    await menu.getByRole('menuitemradio', { name: /^Auto/ }).click();
    await expect(openMenu(page)).toHaveCount(0);
    await expect(checkout).toContainText('Auto checkout');

    /** The same flow without a pointer. */
    await checkout.focus();
    await page.keyboard.press('Enter');
    menu = openMenu(page);
    await expect(menu).toBeVisible();
    const isolated = menu.getByRole('menuitemradio', { name: /Isolated worktree/ });
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('ArrowDown');
      if ((await isolated.getAttribute('data-active-item')) != null) {
        break;
      }
    }
    await expect(isolated).toHaveAttribute('data-active-item', 'true');
    await page.keyboard.press('Enter');
    await expect(openMenu(page)).toHaveCount(0);
    await expect(checkout).toContainText('Worktree');
    await expect(checkout).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(openMenu(page)).toBeVisible();
    await closeMenu(page);
  });

  test('a workspace without worktrees still offers the registered checkout @scenario:checkout-source-without-worktree-support', async ({
    page,
  }) => {
    await installCodeMocks(page, {
      environments: [
        singleMachine({
          defaultWorkspaceId: 'plain',
          workspaces: [workspace('plain', { repo: 'LibreChat-AI/plain', ref: 'main' })],
        }),
      ],
    });
    await openCodeChat(page);
    const checkout = chip(page, CHECKOUT);
    await expect(checkout).toBeVisible();
    await expect(checkout).toBeEnabled();
    await expect(checkout).not.toHaveAttribute('aria-disabled', 'true');
    await expect(checkout).toContainText('Auto checkout');

    const menu = await openChip(page, CHECKOUT);
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu.getByRole('menuitemradio', { name: /^Auto/ })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: /Registered checkout/ })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: /Isolated worktree/ })).toHaveCount(0);

    await menu.getByRole('menuitemradio', { name: /Registered checkout/ }).click();
    await expect(openMenu(page)).toHaveCount(0);
    await expect(checkout).not.toContainText('Auto checkout');
    await expect(checkout).toContainText(/Registered|Source/);
  });

  test('several machines choose their checkout in the workspace menu @scenario:multi-machine-checkout-in-workspace-menu', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine(), secondMachine()] });
    await openCodeChat(page);
    await expect(chip(page, WORKSPACE)).toBeVisible();
    await expect(chip(page, CHECKOUT)).toHaveCount(0);

    let menu = await openChip(page, WORKSPACE);
    const zima = menu.locator('[data-code-environment-id="env-zimacube"]');
    const studio = menu.locator('[data-code-environment-id="env-studio"]');
    for (const environment of [zima, studio]) {
      await expect(environment.getByRole('menuitemradio', { name: /^Auto/ })).toBeVisible();
      await expect(
        environment.getByRole('menuitemradio', { name: /Isolated worktree/ }),
      ).toBeVisible();
      await expect(
        environment.getByRole('menuitemradio', { name: /Registered checkout/ }),
      ).toBeVisible();
    }
    /** Auto is the starting choice; pick another, then return to Auto. */
    await expect(zima.getByRole('menuitemradio', { name: /^Auto/ })).toBeChecked();
    await zima.getByRole('menuitemradio', { name: /Registered checkout/ }).click();
    await closeMenuIfOpen(page);

    menu = await openChip(page, WORKSPACE);
    const zimaReopened = menu.locator('[data-code-environment-id="env-zimacube"]');
    await expect(
      zimaReopened.getByRole('menuitemradio', { name: /Registered checkout/ }),
    ).toBeChecked();
    await zimaReopened.getByRole('menuitemradio', { name: /^Auto/ }).click();
    await closeMenuIfOpen(page);

    menu = await openChip(page, WORKSPACE);
    await expect(
      menu
        .locator('[data-code-environment-id="env-zimacube"]')
        .getByRole('menuitemradio', { name: /^Auto/ }),
    ).toBeChecked();
    await expect(
      menu
        .locator('[data-code-environment-id="env-studio"]')
        .getByRole('menuitemradio', { name: /^Auto/ }),
    ).toBeChecked();
  });

  test('an open chip menu does not read as disabled @scenario:open-chip-menu-not-disabled', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()] });
    await openCodeChat(page);

    for (const selector of [CHECKOUT, APPROVAL]) {
      const button = chip(page, selector);
      await openChip(page, selector);
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await expect
        .poll(() => button.evaluate((element) => getComputedStyle(element).opacity))
        .toBe('1');
      await closeMenu(page);
    }
  });

  test('the temporary composer is opaque over the rail @scenario:temporary-composer-is-opaque', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()] });
    await openCodeChat(page);
    const width = page.viewportSize()?.width ?? 0;
    if (width >= 768) {
      await page.getByRole('button', { name: 'Temporary Chat' }).click();
    } else {
      await page
        .getByRole('button', { name: /more|options|menu/i })
        .first()
        .click();
      await page.getByText('Temporary Chat', { exact: true }).click();
    }

    const surface = page.locator('.rounded-t-theme-surface-lg').first();
    await expect(surface).toBeVisible();
    await expect(chip(page, WORKSPACE)).toBeVisible();
    await expect
      .poll(() =>
        surface.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { color: computed.backgroundColor, image: computed.backgroundImage };
        }),
      )
      .toEqual({
        color: expect.stringMatching(/^(rgb\(|oklab\(|oklch\(|color\()(?!.*\/)/),
        image: expect.stringMatching(/gradient/),
      });
    const alpha = await surface.evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) {
        return -1;
      }
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha).toBe(255);

    /** The mode is persisted locally; leave the account as the suite found it. */
    await page.evaluate(() => localStorage.setItem('isTemporary', 'false'));
  });
});

async function closeMenuIfOpen(page: Page) {
  if (await openMenu(page).count()) {
    await page.keyboard.press('Escape');
  }
  await expect(openMenu(page)).toHaveCount(0);
}
