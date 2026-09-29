import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The app-wide keyboard focus outline and the shared primitives' focus ring, the `focus-outline`
 * and `focus-control` theme roles. The default light and dark themes draw the outline in black and
 * white and the ring in their primary ink, a theme definition that names only its own
 * `ring-primary` draws the outline in that ring, one that leaves the ring to the default keeps
 * black and white, one that names the roles draws both in them, and the contrast modes keep their
 * heavier outline. The probes are bare buttons reached with Tab, so nothing but the global rule
 * and the primitives' ring classes styles them.
 */

type Appearance = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';
type Outline = { color: string; style: string; width: string; offset: string };

const PROBE = 'focus-outline-probe';

const CUSTOM_RING_THEME = {
  version: 1,
  name: 'e2e-focus-ring',
  modes: {
    light: { colors: { 'rgb-ring-primary': '10 20 30' } },
    dark: { colors: { 'rgb-ring-primary': '200 210 220' } },
  },
} as const;

/** Names the roles apart from its ring and ink, so an outline or ring that followed either shows. */
const FOCUS_ROLE_THEME = {
  version: 1,
  name: 'e2e-focus-roles',
  modes: {
    light: {
      colors: {
        'rgb-ring-primary': '10 20 30',
        'rgb-focus-outline': '180 0 110',
        'rgb-focus-control': '0 90 160',
      },
    },
    dark: {
      colors: {
        'rgb-ring-primary': '200 210 220',
        'rgb-focus-outline': '255 140 200',
        'rgb-focus-control': '120 200 255',
      },
    },
  },
} as const;

/** Leaves `rgb-ring-primary` to the default, which resolves to a gray too dim for a dark surface. */
const RINGLESS_THEME = {
  version: 1,
  name: 'e2e-ringless',
  modes: {
    light: { colors: { 'rgb-accent-primary': '10 20 30' } },
    dark: { colors: { 'rgb-accent-primary': '200 210 220' } },
  },
} as const;

async function installAppearance(page: Page, appearance: Appearance, definition?: unknown) {
  await page.addInitScript(
    ([mode, stored]) => {
      localStorage.setItem('color-theme', mode as string);
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
    [appearance, definition ?? null] as [string, unknown],
  );
}

/**
 * Tabs onto a bare button and reads the outline it draws. Tab moves on from the focused element,
 * so a sentinel that takes script focus but sits outside the tab order anchors the move.
 */
async function keyboardFocusOutline(page: Page): Promise<Outline> {
  await page.evaluate((id) => {
    const sentinel = document.createElement('span');
    sentinel.tabIndex = -1;
    const probe = document.createElement('button');
    probe.id = id;
    probe.textContent = 'Focus probe';
    document.body.prepend(sentinel, probe);
    sentinel.focus();
  }, PROBE);
  await page.keyboard.press('Tab');

  const probe = page.locator(`#${PROBE}`);
  await expect(probe).toBeFocused();
  expect(await probe.evaluate((node) => node.matches(':focus-visible'))).toBe(true);

  return probe.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: style.outlineWidth,
      offset: style.outlineOffset,
    };
  });
}

/** The ring classes `Checkbox`, `Switch` and `IconButton` draw keyboard focus with. */
const CONTROL_RING_CLASSES =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control';

/** Tabs onto a bare button carrying the primitives' ring classes and reads the ring's color. */
async function keyboardFocusRing(page: Page): Promise<string> {
  const id = `${PROBE}-ring`;
  await page.evaluate(
    ([probeId, classes]) => {
      const sentinel = document.createElement('span');
      sentinel.tabIndex = -1;
      const probe = document.createElement('button');
      probe.id = probeId;
      probe.className = classes;
      probe.textContent = 'Ring probe';
      document.body.prepend(sentinel, probe);
      sentinel.focus();
    },
    [id, CONTROL_RING_CLASSES],
  );
  await page.keyboard.press('Tab');

  const probe = page.locator(`#${id}`);
  await expect(probe).toBeFocused();
  const shadow = await probe.evaluate((node) => getComputedStyle(node).boxShadow);
  /** Tailwind lists transparent offset and shadow layers beside the ring; the ring is the opaque one. */
  const layers = shadow.match(/rgba?\([^)]*\)/g) ?? [];
  return layers.find((color) => !/,\s*0\)$/.test(color)) ?? shadow;
}

async function openChat(page: Page, appearance: Appearance, definition?: { name: string }) {
  await installAppearance(page, appearance, definition);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  const root = page.locator('html');
  if (appearance.startsWith('high-contrast')) {
    await expect(root).toHaveClass(/\bhigh-contrast\b/);
  } else if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
  await expect(root).toHaveClass(appearance.endsWith('dark') ? /\bdark\b/ : /\blight\b/);
}

const outline = (color: string, width = '2px'): Outline => ({
  color,
  style: 'solid',
  width,
  offset: '2px',
});

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  appearance: Appearance;
  definition?: { name: string };
  expected: Outline;
}> = [
  {
    title:
      'the default light theme keeps its black focus outline @scenario:focus-outline-default-light-unchanged',
    appearance: 'light',
    expected: outline('rgb(0, 0, 0)'),
  },
  {
    title:
      'the default dark theme keeps its white focus outline @scenario:focus-outline-default-dark-unchanged',
    appearance: 'dark',
    expected: outline('rgb(255, 255, 255)'),
  },
  {
    title:
      'the ClickHouse light theme draws focus in its outline blue @scenario:focus-outline-follows-clickhouse-ring-light',
    appearance: 'light',
    definition: clickHouseTheme,
    expected: outline('rgb(67, 126, 239)'),
  },
  {
    title:
      'the ClickHouse dark theme draws focus in its brand yellow @scenario:focus-outline-follows-clickhouse-ring-dark',
    appearance: 'dark',
    definition: clickHouseTheme,
    expected: outline('rgb(250, 255, 105)'),
  },
  {
    title:
      'a dark theme that leaves the ring to the default keeps the white focus outline @scenario:focus-outline-ringless-theme-keeps-default',
    appearance: 'dark',
    definition: RINGLESS_THEME,
    expected: outline('rgb(255, 255, 255)'),
  },
  {
    title:
      'high contrast light keeps its heavy text-colored focus outline @scenario:focus-outline-high-contrast-light-unchanged',
    appearance: 'high-contrast-light',
    definition: clickHouseTheme,
    expected: outline('rgb(0, 0, 0)', '3px'),
  },
  {
    title:
      'high contrast dark keeps its heavy text-colored focus outline @scenario:focus-outline-high-contrast-dark-unchanged',
    appearance: 'high-contrast-dark',
    definition: clickHouseTheme,
    expected: outline('rgb(255, 255, 255)', '3px'),
  },
];

test.describe('keyboard focus outline', () => {
  for (const { title, appearance, definition, expected } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, appearance, definition);

      expect(await keyboardFocusOutline(page)).toEqual(expected);
    });
  }

  test('a theme that names the focus roles draws the outline and the control ring in them @scenario:focus-roles-follow-reference-theme', async ({
    page,
  }) => {
    const expected: Record<'light' | 'dark', { outline: string; ring: string }> = {
      light: { outline: 'rgb(180, 0, 110)', ring: 'rgb(0, 90, 160)' },
      dark: { outline: 'rgb(255, 140, 200)', ring: 'rgb(120, 200, 255)' },
    };
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, FOCUS_ROLE_THEME);

      expect(await keyboardFocusOutline(modePage)).toEqual(outline(expected[mode].outline));
      expect(await keyboardFocusRing(modePage)).toBe(expected[mode].ring);
    }
  });

  /** Each tag is written out whole: the runner finds a scenario by its literal tag. */
  const RING_CASES: Array<{
    title: string;
    appearance: Appearance;
    definition?: { name: string };
    ring: string;
  }> = [
    {
      title:
        'the default light theme keeps its primitives ring in the primary ink @scenario:focus-control-default-light-unchanged',
      appearance: 'light',
      ring: 'rgb(33, 33, 33)',
    },
    {
      title:
        'the default dark theme keeps its primitives ring in the primary ink @scenario:focus-control-default-dark-unchanged',
      appearance: 'dark',
      ring: 'rgb(236, 236, 236)',
    },
    {
      title:
        'the ClickHouse light theme rings its primitives in the Click UI outline @scenario:focus-control-clickhouse-light',
      appearance: 'light',
      definition: clickHouseTheme,
      ring: 'rgb(67, 126, 239)',
    },
    {
      title:
        'the ClickHouse dark theme rings its primitives in the Click UI outline @scenario:focus-control-clickhouse-dark',
      appearance: 'dark',
      definition: clickHouseTheme,
      ring: 'rgb(250, 255, 105)',
    },
    {
      title:
        'high contrast dark rings its primitives in its white ink @scenario:focus-control-high-contrast-dark',
      appearance: 'high-contrast-dark',
      definition: clickHouseTheme,
      ring: 'rgb(255, 255, 255)',
    },
  ];

  for (const { title, appearance, definition, ring } of RING_CASES) {
    test(title, async ({ page }) => {
      await openChat(page, appearance, definition);

      expect(await keyboardFocusRing(page)).toBe(ring);
    });
  }

  test('a custom theme draws focus in the ring it defines, in both modes @scenario:focus-outline-follows-custom-theme-ring', async ({
    page,
  }) => {
    const rings: Record<'light' | 'dark', string> = {
      light: 'rgb(10, 20, 30)',
      dark: 'rgb(200, 210, 220)',
    };
    /** One page per mode: a page's init scripts accumulate, and their order is not guaranteed. */
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, CUSTOM_RING_THEME);

      expect(await keyboardFocusOutline(modePage)).toEqual(outline(rings[mode]));
    }
  });
});
