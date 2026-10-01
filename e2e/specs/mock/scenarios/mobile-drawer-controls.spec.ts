import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The mobile drawer keeps one place for each control: new chat sits in the header strip beside
 * the panel switcher, the marketplace is a labelled row above the panel content, and the footer
 * holds search alone. The drawer also has to read as a surface of its own over the conversation
 * it covers, in every bundled palette: the scrim separates it in light, and in dark (where the
 * scrim and the drawer are both near-black) the drawer draws its own edge.
 *
 * Every scenario loads at phone width rather than resizing into it: a desktop-to-phone resize
 * leaves the drawer on the desktop toggle path (berry-13/LibreChat#205).
 */

const DRAWER = '#mobile-drawer';
const SCRIM = '#mobile-drawer-scrim';
/** The layer inside the scrim button that paints the theme's scrim role. */
const SCRIM_FILL = `${SCRIM} > span:first-child`;
/** WCAG 1.4.11: a boundary that carries meaning needs 3:1 against its surround. */
const BOUNDARY_CONTRAST = 3;
/** WCAG 1.4.3: body text needs 4.5:1 against its background. */
const TEXT_CONTRAST = 4.5;

type Mode = 'light' | 'dark';
type Rgb = [number, number, number];

test.use({ viewport: { width: 390, height: 844 } });

/**
 * `strip` turns on the setting that leaves a strip of conversation beside the drawer. Only then is
 * there a scrim, and something for the drawer to stand apart from: by default it covers the
 * whole width.
 */
async function openDrawer(
  page: Page,
  mode: Mode = 'light',
  definition?: { name: string },
  strip = false,
) {
  await page.addInitScript(
    ([appearance, stored, withStrip]) => {
      localStorage.setItem('mobileDrawerStrip', JSON.stringify(withStrip));
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
    [mode, definition ?? null, strip] as [string, unknown, boolean],
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  const root = page.locator('html');
  await expect(root).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  }

  const drawer = page.locator(DRAWER);
  if (!(await drawer.getByTestId('close-sidebar-button').isVisible())) {
    await page.getByTestId('header-open-sidebar-button').click();
  }
  await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
  await expect(drawer).not.toHaveAttribute('inert');
  /** The slide has to land before anything is measured against the viewport. */
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1, { timeout: 5000 }).toBe(0);
  return drawer;
}

function parseRgb(color: string): { rgb: Rgb; alpha: number } {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 };
}

function luminance([r, g, b]: Rgb) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function over(top: string, bottom: string): Rgb {
  const { rgb, alpha } = parseRgb(top);
  const base = parseRgb(bottom).rgb;
  return rgb.map((value, i) => value * alpha + base[i] * (1 - alpha)) as Rgb;
}

/**
 * The drawer against the conversation it covers, read from the computed styles: the drawer's
 * own fill, the page under the scrim with the scrim composited on top, and the drawer's
 * trailing edge if it draws one.
 */
async function readBoundary(page: Page) {
  const styles = await page.evaluate(
    ([drawerSelector, scrimSelector]) => {
      const drawer = document.querySelector(drawerSelector) as HTMLElement;
      const scrim = document.querySelector(scrimSelector) as HTMLElement;
      const drawerStyle = getComputedStyle(drawer);
      /** The scrim sits over the chat pane, whose surface is the body's. */
      const pageFill = getComputedStyle(document.body).backgroundColor;
      return {
        drawer: drawerStyle.backgroundColor,
        edgeWidth: parseFloat(drawerStyle.borderRightWidth),
        edgeColor: drawerStyle.borderRightColor,
        scrim: getComputedStyle(scrim).backgroundColor,
        page: pageFill,
      };
    },
    [DRAWER, SCRIM_FILL],
  );
  const drawer = parseRgb(styles.drawer).rgb;
  const dimmed = over(styles.scrim, styles.page);
  const fill = contrast(drawer, dimmed);
  const edge =
    styles.edgeWidth >= 1
      ? Math.max(
          contrast(over(styles.edgeColor, styles.drawer), drawer),
          contrast(over(styles.edgeColor, styles.drawer), dimmed),
        )
      : 0;
  return { fill, edge, scrim: styles.scrim };
}

test.describe('mobile drawer controls', () => {
  test('new chat sits beside the panel switcher and starts a chat from the drawer @scenario:mobile-drawer-new-chat-in-header', async ({
    page,
  }) => {
    const drawer = await openDrawer(page);
    const newChat = drawer.getByRole('link', { name: 'New chat' });
    await expect(newChat).toHaveCount(1);
    await expect(newChat).toBeVisible();

    const switcher = await drawer.getByTestId('panel-switcher-button').boundingBox();
    const button = await newChat.boundingBox();
    const close = await drawer.getByTestId('close-sidebar-button').boundingBox();
    expect(switcher && button && close).toBeTruthy();
    /** Same strip as the switcher and the close toggle: their vertical centers line up. */
    const center = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(center(button!) - center(switcher!))).toBeLessThanOrEqual(2);
    expect(Math.abs(center(button!) - center(close!))).toBeLessThanOrEqual(2);
    expect(button!.x).toBeGreaterThanOrEqual(switcher!.x + switcher!.width - 1);

    await page.keyboard.press('Shift');
    await newChat.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(drawer).toHaveAttribute('inert', '');
  });

  test('the marketplace is a labelled row above the panels that stays while they change @scenario:mobile-drawer-marketplace-row', async ({
    page,
  }) => {
    const drawer = await openDrawer(page);
    const marketplace = drawer.getByRole('link', { name: 'Agent Marketplace' });
    await expect(marketplace).toBeVisible();
    await expect(marketplace).toHaveText('Agent Marketplace');

    const nav = drawer.locator('#chat-history-nav');
    const before = await marketplace.boundingBox();
    const navBox = await nav.boundingBox();
    expect(before && navBox).toBeTruthy();
    expect(before!.y + before!.height).toBeLessThanOrEqual(navBox!.y + 1);
    /** A full-width row, not an icon in the header strip. */
    expect(before!.width).toBeGreaterThan(200);

    await drawer.getByTestId('panel-switcher-button').click();
    const panels = page.getByRole('menuitemcheckbox');
    await expect(panels.first()).toBeVisible();
    const choices = await panels.count();
    expect(choices).toBeGreaterThan(1);
    await panels.nth(1).click();
    await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0);

    const after = await marketplace.boundingBox();
    expect(after).toEqual(before);

    await marketplace.click();
    await expect(page).toHaveURL(/\/agents/);
    await expect(drawer).toHaveAttribute('inert', '');
  });

  test('without the marketplace the panels start right under the header strip @scenario:mobile-drawer-no-marketplace-no-gap', async ({
    page,
  }) => {
    /** The role this page reads, with the marketplace permission off; nothing shared changes. */
    await page.route('**/api/roles/*', async (route) => {
      const response = await route.fetch();
      const role = await response.json();
      role.permissions = {
        ...role.permissions,
        MARKETPLACE: { ...role.permissions?.MARKETPLACE, USE: false },
      };
      await route.fulfill({ response, json: role });
    });
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('nav-agents-marketplace-button')).toHaveCount(0);

    const header = await drawer.getByTestId('close-sidebar-button').locator('..').boundingBox();
    const nav = await drawer.locator('#chat-history-nav').boundingBox();
    expect(header && nav).toBeTruthy();
    expect(Math.abs(nav!.y - (header!.y + header!.height))).toBeLessThanOrEqual(1);
  });

  test('the drawer footer holds only search and stands down where there is nothing to search @scenario:mobile-drawer-footer-search-only', async ({
    page,
  }) => {
    const drawer = await openDrawer(page);
    /** New chat left the footer for the header strip: one copy in the drawer, not two. */
    await expect(drawer.getByRole('link', { name: 'New chat' })).toHaveCount(1);
    await expect(drawer.getByTestId('nav-new-chat-fab')).toHaveCount(1);

    await drawer.getByTestId('panel-switcher-button').click();
    const panels = page.getByRole('menuitemcheckbox');
    await expect(panels.first()).toBeVisible();
    await panels.nth(1).click();
    await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0);

    /** No footer beyond the safe-area inset (zero here): the panel runs to the drawer's bottom. */
    await expect(drawer.getByRole('searchbox')).toHaveCount(0);
    const nav = await drawer.locator('#chat-history-nav').boundingBox();
    const box = await drawer.boundingBox();
    expect(nav && box).toBeTruthy();
    expect(box!.y + box!.height - (nav!.y + nav!.height)).toBeLessThanOrEqual(1);
  });

  /** Each tag is written out whole: the runner finds a scenario by its literal tag. */
  const DARK_TEXT_CASES: Array<{ title: string; definition?: { name: string } }> = [
    {
      title:
        'the drawer header and marketplace row read in the default dark theme @scenario:mobile-drawer-text-readable-dark-default',
    },
    {
      title:
        'the drawer header and marketplace row read in the ClickHouse dark theme @scenario:mobile-drawer-text-readable-dark-clickhouse',
      definition: clickHouseTheme,
    },
  ];

  for (const { title, definition } of DARK_TEXT_CASES) {
    test(title, async ({ page }) => {
      const drawer = await openDrawer(page, 'dark', definition);
      const colors = await drawer.evaluate((node) => {
        const label = Array.from(
          node.querySelectorAll('a[data-testid="nav-agents-marketplace-button"] span'),
        )[0];
        return {
          surface: getComputedStyle(node).backgroundColor,
          drawerText: getComputedStyle(node).color,
          label: label ? getComputedStyle(label).color : null,
        };
      });
      expect(colors.label).not.toBeNull();
      const surface = parseRgb(colors.surface).rgb;
      expect(contrast(parseRgb(colors.drawerText).rgb, surface)).toBeGreaterThanOrEqual(
        TEXT_CONTRAST,
      );
      expect(contrast(parseRgb(colors.label!).rgb, surface)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    });
  }

  /** Each tag is written out whole: the runner finds a scenario by its literal tag. */
  const BOUNDARY_CASES: Array<{ title: string; mode: Mode; definition?: { name: string } }> = [
    {
      title:
        'the drawer stands apart from the dimmed chat in the default light theme @scenario:mobile-drawer-boundary-default-light',
      mode: 'light',
    },
    {
      title:
        'the drawer stands apart from the dimmed chat in the default dark theme @scenario:mobile-drawer-boundary-default-dark',
      mode: 'dark',
    },
    {
      title:
        'the drawer stands apart from the dimmed chat in the ClickHouse light theme @scenario:mobile-drawer-boundary-clickhouse-light',
      mode: 'light',
      definition: clickHouseTheme,
    },
    {
      title:
        'the drawer stands apart from the dimmed chat in the ClickHouse dark theme @scenario:mobile-drawer-boundary-clickhouse-dark',
      mode: 'dark',
      definition: clickHouseTheme,
    },
  ];

  for (const { title, mode, definition } of BOUNDARY_CASES) {
    test(title, async ({ page }) => {
      await openDrawer(page, mode, definition, true);
      await expect(page.locator(SCRIM)).toBeVisible();
      const { fill, edge } = await readBoundary(page);
      /** Either the fill against the scrim or the drawer's own edge has to carry it. */
      expect(Math.max(fill, edge)).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST);
      if (mode === 'light') {
        /** The scrim does the work in light: no extra line on a surface that already reads. */
        expect(fill).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST);
        expect(edge).toBe(0);
      }
    });
  }

  /** Each tag is written out whole: the runner finds a scenario by its literal tag. */
  const FOCUS_CASES: Array<{ title: string; mode: Mode; definition?: { name: string } }> = [
    {
      title:
        'the scrim follows the theme scrim role and shows its focus in the default light theme @scenario:mobile-drawer-scrim-focus-default-light',
      mode: 'light',
    },
    {
      title:
        'the scrim follows the theme scrim role and shows its focus in the default dark theme @scenario:mobile-drawer-scrim-focus-default-dark',
      mode: 'dark',
    },
    {
      title:
        'the scrim follows the theme scrim role and shows its focus in the ClickHouse light theme @scenario:mobile-drawer-scrim-focus-clickhouse-light',
      mode: 'light',
      definition: clickHouseTheme,
    },
    {
      title:
        'the scrim follows the theme scrim role and shows its focus in the ClickHouse dark theme @scenario:mobile-drawer-scrim-focus-clickhouse-dark',
      mode: 'dark',
      definition: clickHouseTheme,
    },
  ];

  for (const { title, mode, definition } of FOCUS_CASES) {
    test(title, async ({ page }) => {
      await openDrawer(page, mode, definition, true);
      const scrim = page.locator(SCRIM);
      /** The dialogs' theme-owned role: surface-overlay at the theme's scrim opacity. */
      const role = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'bg-scrim';
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      await expect(page.locator(SCRIM_FILL)).toHaveCSS('background-color', role);

      /** Keyboard modality, so `:focus-visible` matches as it does for a Tab. */
      await page.keyboard.press('Shift');
      await scrim.focus();
      await expect(scrim).toBeFocused();
      /**
       * The shell is overflow-hidden, so only an inset indicator shows, and it has to paint above
       * the fill. Hit-testing follows paint order, so the topmost layer just inside the scrim's
       * edge must be the one drawing the inset indicator, and one of its tones has to stand out
       * from the fill.
       */
      const top = await scrim.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementsFromPoint(box.right - 1, box.top + box.height / 2)[0];
        const fill = node.querySelector(':scope > span:first-child');
        return {
          inside: node.contains(hit),
          shadow: hit ? getComputedStyle(hit).boxShadow : '',
          fill: fill ? getComputedStyle(fill).backgroundColor : '',
          page: getComputedStyle(document.body).backgroundColor,
        };
      });
      expect(top.inside).toBe(true);
      expect(top.shadow).toContain('inset');
      const tones = top.shadow.match(/rgba?\([^)]*\)/g) ?? [];
      expect(tones.length).toBeGreaterThan(0);
      const dimmed = over(top.fill, top.page);
      const best = Math.max(...tones.map((tone) => contrast(parseRgb(tone).rgb, dimmed)));
      expect(best).toBeGreaterThanOrEqual(BOUNDARY_CONTRAST);
    });
  }
});
