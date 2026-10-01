import { devices, expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';
import { NEW_CHAT_PATH, fetchJson, getAccessToken } from '../helpers';

const MCP_SERVER_NAME = 'e2e-memory';
const MCP_TOOL_ID = `remember_fact_mcp_${MCP_SERVER_NAME}`;
/** WCAG 1.4.11: a graphical object owes 3:1 against what it sits on. */
const MARK_FLOOR = 3;

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

type Paint = { color: string; badgeStroke: string; checkStroke: string };

function channels(cssColor: string): [number, number, number] {
  const match = cssColor.match(/rgba?\(([^)]+)\)/);
  expect(match, `expected an rgb color, received ${cssColor}`).not.toBeNull();
  const parts = match![1].split(',').map((part) => Number.parseFloat(part.trim()));
  return [parts[0], parts[1], parts[2]];
}

function relativeLuminance(cssColor: string): number {
  const [r, g, b] = channels(cssColor).map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

async function openToolLibrary(page: Page): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('button', { name: 'Add tools' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(dialog).toBeVisible();
  return dialog;
}

function verifiedMark(dialog: Locator): Locator {
  return dialog.locator('svg[aria-label="Native"]').first();
}

/** The badge is the first path and the check the second, so a stroke leaking
 *  onto the badge is visible here as a color instead of `none`. */
async function paintOf(mark: Locator): Promise<Paint> {
  return mark.evaluate((element) => {
    const [badge, check] = Array.from(element.children) as SVGElement[];
    return {
      color: getComputedStyle(element).color,
      badgeStroke: getComputedStyle(badge).stroke,
      checkStroke: getComputedStyle(check).stroke,
    };
  });
}

/** The wrapper carries the card's background; the button inside stays
 *  transparent, so the wrapper is what repaints on hover. */
const CARD_FROM_MARK = 'xpath=ancestor::button[1]/..';

async function useTheme(page: Page, theme: 'light' | 'dark', colors?: Record<string, string>) {
  await page.addInitScript(
    ([selected, legacyColors]: [string, string | null]) => {
      localStorage.setItem('color-theme', selected);
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
      if (legacyColors === null) {
        localStorage.removeItem('theme-colors');
        localStorage.removeItem('theme-name');
        return;
      }
      localStorage.setItem('theme-colors', legacyColors);
      localStorage.setItem('theme-name', 'e2e-legacy');
    },
    [theme, colors ? JSON.stringify(colors) : null] as [string, string | null],
  );
}

test.describe('native tool verified mark', () => {
  test('@scenario:native-tool-card-shows-verified-mark a native tool wears a painted mark beside its name', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);
    const mark = verifiedMark(dialog);
    await expect(mark).toBeVisible();

    const paint = await paintOf(mark);
    expect(paint.badgeStroke).toBe('none');
    expect(channels(paint.color)).not.toEqual(channels(paint.checkStroke));
    expect(contrast(paint.color, paint.checkStroke)).toBeGreaterThanOrEqual(MARK_FLOOR);

    const card = mark.locator(CARD_FROM_MARK);
    const resting = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
    /** A resting card is transparent, so what sits behind the mark is the panel. */
    const behind = resting.endsWith(', 0)')
      ? await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)
      : resting;
    expect(contrast(paint.color, behind)).toBeGreaterThanOrEqual(MARK_FLOOR);
  });

  test('@scenario:verified-mark-holds-silhouette-on-dark-hover hovering a native card in dark mode keeps the mark legible', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await useTheme(page, 'dark');

    const dialog = await openToolLibrary(page);
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);

    const mark = verifiedMark(dialog);
    await expect(mark).toBeVisible();
    const card = mark.locator(CARD_FROM_MARK);

    const panel = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
    /** A touch viewport has no hover state to lose, so there the card keeps its
     *  resting background and that is what the mark has to survive. */
    const hoverable = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    if (hoverable) {
      await card.hover();
    }
    const painted = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
    /** A resting card is transparent, so what sits behind the mark is the panel. */
    const background = painted.endsWith(', 0)') ? panel : painted;
    if (hoverable) {
      /** The repaint has to have happened, or the assertion below would measure
       *  the resting card and pass for the wrong reason. */
      expect(background).not.toBe(panel);
    }

    const paint = await paintOf(mark);
    expect(paint.badgeStroke).toBe('none');
    expect(contrast(paint.color, background)).toBeGreaterThanOrEqual(MARK_FLOOR);
    expect(contrast(paint.color, paint.checkStroke)).toBeGreaterThanOrEqual(MARK_FLOOR);
  });

  test('@scenario:legacy-custom-theme-keeps-verified-mark-on-its-palette a theme that predates the token paints the mark with its own success fill', async ({
    page,
  }) => {
    test.setTimeout(120000);
    /** A deployment palette from before `status-verified` existed: it names the
     *  fill the mark used to wear and nothing about the mark itself. */
    await useTheme(page, 'light', {
      'rgb-status-success-strong': '124 45 18',
      'rgb-text-on-status': '255 255 255',
    });

    const dialog = await openToolLibrary(page);
    const mark = verifiedMark(dialog);
    await expect(mark).toBeVisible();
    await expect(mark).toHaveCSS('color', 'rgb(124, 45, 18)');
  });

  test('@scenario:mcp-server-card-shows-no-verified-mark a third-party server carries no mark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    /** The token is minted from the page session, so the app has to be loaded
     *  before the request has an origin to resolve against. */
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    await expect
      .poll(
        async () => {
          const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
          return (tools.servers?.[MCP_SERVER_NAME]?.tools ?? []).some(
            (tool) => tool.pluginKey === MCP_TOOL_ID,
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);

    const dialog = await openToolLibrary(page);
    await dialog.getByRole('textbox', { name: 'Search tools…' }).fill(MCP_SERVER_NAME);

    const serverCard = dialog.getByRole('button', { name: new RegExp(MCP_SERVER_NAME) }).first();
    await expect(serverCard).toBeVisible();
    await expect(serverCard.locator('svg[aria-label="Native"]')).toHaveCount(0);
  });
});

/** The mock project is Desktop Chrome, so the touch layout — the sidebar
 *  switcher that replaces the rail, and a card that never receives hover —
 *  only gets exercised if a test asks for it. */
test.describe('native tool verified mark on a touch viewport', () => {
  /** Only the context knobs: spreading the whole device descriptor would carry
   *  `defaultBrowserType`, which Playwright refuses inside a describe. */
  test.use({ viewport: devices['Pixel 7'].viewport, hasTouch: true });

  test('@scenario:verified-mark-survives-a-touch-viewport a native tool keeps its mark where there is no hover', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const dialog = await openToolLibrary(page);

    const mark = verifiedMark(dialog);
    await expect(mark).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);

    const paint = await paintOf(mark);
    expect(paint.badgeStroke).toBe('none');
    expect(contrast(paint.color, paint.checkStroke)).toBeGreaterThanOrEqual(MARK_FLOOR);

    const card = mark.locator(CARD_FROM_MARK);
    const resting = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
    const behind = resting.endsWith(', 0)')
      ? await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)
      : resting;
    expect(contrast(paint.color, behind)).toBeGreaterThanOrEqual(MARK_FLOOR);
  });
});
