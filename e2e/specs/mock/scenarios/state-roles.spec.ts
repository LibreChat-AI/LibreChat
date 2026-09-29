import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The pressed and disabled state roles. A held control takes `surface-pressed` (or the inverted
 * pressed fill), which defaults to the hover fill a pointer press has always shown. A disabled
 * control dims to half opacity unless the theme's `disabledStyle` is `fill`, which paints it in
 * `surface-disabled` and `text-disabled` at full opacity. The probes carry the class lists the
 * shared `IconButton` and `Field` primitives compose, so only those rules style them.
 */

type Mode = 'light' | 'dark';

const PRESS_CLASSES = 'bg-surface-secondary hover:bg-surface-hover hover:active:bg-surface-pressed';
const DISABLED_CLASSES =
  'bg-transparent text-text-primary disabled:opacity-50 theme-disabled:bg-surface-disabled theme-disabled:text-text-disabled theme-disabled:opacity-100';

/** Names every state role apart from the hover and ink it would otherwise follow. */
const STATE_ROLE_THEME = {
  version: 1,
  name: 'e2e-state-roles',
  modes: {
    light: {
      colors: {
        'rgb-surface-hover': '200 200 200',
        'rgb-surface-pressed': '150 60 20',
        'rgb-surface-disabled': '20 150 60',
        'rgb-text-disabled': '60 20 150',
      },
      appearance: { disabledStyle: 'fill' },
    },
    dark: {
      colors: {
        'rgb-surface-hover': '60 60 60',
        'rgb-surface-pressed': '240 160 120',
        'rgb-surface-disabled': '120 240 160',
        'rgb-text-disabled': '160 120 240',
      },
      appearance: { disabledStyle: 'fill' },
    },
  },
} as const;

async function openChat(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([appearance, stored]) => {
      localStorage.setItem('color-theme', appearance as string);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (stored) {
        localStorage.setItem('theme-definition', JSON.stringify(stored));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [mode, definition ?? null] as [string, unknown],
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  const root = page.locator('html');
  if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
  await expect(root).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

async function addProbe(page: Page, id: string, className: string, disabled = false) {
  await page.evaluate(
    ([probeId, classes, isDisabled]) => {
      const probe = document.createElement('button');
      probe.id = probeId as string;
      probe.className = classes as string;
      probe.disabled = isDisabled as boolean;
      probe.textContent = 'State probe';
      probe.style.position = 'fixed';
      probe.style.top = '8px';
      probe.style.left = '8px';
      probe.style.zIndex = '2147483647';
      document.body.append(probe);
    },
    [id, className, disabled] as [string, string, boolean],
  );
  return page.locator(`#${id}`);
}

/**
 * Holds the pointer down on a hovered probe and reads its fill. Tailwind gates `hover:` behind
 * `(hover: hover)`, so on a touch device neither the hover nor the pressed fill applies and the
 * probe keeps its resting fill, as it always has; `null` marks that case.
 */
async function pressedFill(page: Page): Promise<string | null> {
  if (!(await page.evaluate(() => matchMedia('(hover: hover)').matches))) {
    return null;
  }
  const probe = await addProbe(page, 'state-press-probe', PRESS_CLASSES);
  const box = await probe.boundingBox();
  if (!box) {
    throw new Error('press probe has no box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const fill = await probe.evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.mouse.up();
  return fill;
}

async function disabledLook(page: Page) {
  const probe = await addProbe(page, 'state-disabled-probe', DISABLED_CLASSES, true);
  return probe.evaluate((node) => {
    const style = getComputedStyle(node);
    return { fill: style.backgroundColor, ink: style.color, opacity: style.opacity };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  mode: Mode;
  definition?: { name: string };
  pressed: string;
  disabled: { fill: string; ink: string; opacity: string };
}> = [
  {
    title:
      'the default light theme presses in its hover fill and dims disabled controls @scenario:state-roles-default-light-unchanged',
    mode: 'light',
    pressed: 'rgb(227, 227, 227)',
    disabled: { fill: 'rgba(0, 0, 0, 0)', ink: 'rgb(33, 33, 33)', opacity: '0.5' },
  },
  {
    title:
      'the default dark theme presses in its hover fill and dims disabled controls @scenario:state-roles-default-dark-unchanged',
    mode: 'dark',
    pressed: 'rgb(57, 57, 57)',
    disabled: { fill: 'rgba(0, 0, 0, 0)', ink: 'rgb(236, 236, 236)', opacity: '0.5' },
  },
  {
    title:
      'the ClickHouse light theme presses and disables in Click UI fills @scenario:state-roles-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    pressed: 'rgb(221, 222, 225)',
    disabled: { fill: 'rgb(223, 223, 223)', ink: 'rgb(160, 160, 160)', opacity: '1' },
  },
  {
    title:
      'the ClickHouse dark theme presses and disables in Click UI fills @scenario:state-roles-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
    pressed: 'rgb(36, 36, 36)',
    disabled: { fill: 'rgb(65, 65, 65)', ink: 'rgb(128, 128, 128)', opacity: '1' },
  },
];

test.describe('pressed and disabled state roles', () => {
  for (const { title, mode, definition, pressed, disabled } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      const fill = await pressedFill(page);
      if (fill !== null) {
        expect(fill).toBe(pressed);
      }
      expect(await disabledLook(page)).toEqual(disabled);
    });
  }

  test('a theme that names the state roles presses and disables in them, in both modes @scenario:state-roles-follow-reference-theme', async ({
    page,
  }) => {
    const expected: Record<Mode, { pressed: string; fill: string; ink: string }> = {
      light: { pressed: 'rgb(150, 60, 20)', fill: 'rgb(20, 150, 60)', ink: 'rgb(60, 20, 150)' },
      dark: {
        pressed: 'rgb(240, 160, 120)',
        fill: 'rgb(120, 240, 160)',
        ink: 'rgb(160, 120, 240)',
      },
    };
    /** One page per mode: a page's init scripts accumulate, and their order is not guaranteed. */
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, STATE_ROLE_THEME);

      const fill = await pressedFill(modePage);
      if (fill !== null) {
        expect(fill).toBe(expected[mode].pressed);
      }
      expect(await disabledLook(modePage)).toEqual({
        fill: expected[mode].fill,
        ink: expected[mode].ink,
        opacity: '1',
      });
    }
  });
});
