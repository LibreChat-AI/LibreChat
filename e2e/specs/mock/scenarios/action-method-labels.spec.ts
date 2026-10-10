import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { openAgentBuilder, uniqueAgentName, cleanupAgent } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';

/**
 * The HTTP method badge in the agent builder's action table used to paint its
 * label text in a categorical series color (`text-series-N` over `bg-series-N/10`),
 * which fails WCAG 4.5:1 for text this small. The label now stays on
 * `text-text-secondary` and the series hue rides on a leading decorative dot
 * held to the 3:1 mark floor instead (`ActionsTable/Columns.tsx`). These
 * scenarios drive the real parsed-actions table and read what the browser
 * actually paints, rather than the classes under test, in light, dark, and the
 * ClickHouse reference theme (the theme the original report measured failing).
 */

type Mode = 'light' | 'dark';
type ThemeVariant = 'default' | 'clickhouse';
type Rgb = [number, number, number];

const MODES: Mode[] = ['light', 'dark'];
const VARIANTS: ThemeVariant[] = ['default', 'clickhouse'];
const MODE_PARAM = 'e2eThemeMode';
const VARIANT_PARAM = 'e2eThemeVariant';
const WCAG_AA_NORMAL = 4.5;
/** WCAG 1.4.11: a graphical object (the dot) owes 3:1 against what it sits on. */
const WCAG_MARK_MIN = 3;

const METHOD_OPERATIONS: ReadonlyArray<{ method: string; operationId: string }> = [
  { method: 'get', operationId: 'e2eListWidgets' },
  { method: 'post', operationId: 'e2eCreateWidget' },
  { method: 'put', operationId: 'e2eReplaceWidget' },
  { method: 'patch', operationId: 'e2ePatchWidget' },
  { method: 'delete', operationId: 'e2eDeleteWidget' },
];

const OPENAPI_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'E2E Badge Contrast API', version: '1.0.0' },
  servers: [{ url: 'https://e2e-badge-contrast.example.com' }],
  paths: {
    '/widgets': {
      get: { operationId: 'e2eListWidgets', responses: { '200': { description: 'ok' } } },
      post: { operationId: 'e2eCreateWidget', responses: { '200': { description: 'ok' } } },
      put: { operationId: 'e2eReplaceWidget', responses: { '200': { description: 'ok' } } },
      patch: { operationId: 'e2ePatchWidget', responses: { '200': { description: 'ok' } } },
      delete: { operationId: 'e2eDeleteWidget', responses: { '200': { description: 'ok' } } },
    },
  },
});

/**
 * Mirrors `clickhouse-theme.spec.ts`'s URL-param bridge, extended with a second
 * param for whether the ClickHouse definition is installed. The mode key is
 * only written when the param is present, and the theme keys only change on an
 * explicit `default`/`clickhouse` value: a bare re-navigation (as
 * `openAgentBuilder`'s own internal `page.goto` performs) carries neither param
 * and leaves whatever the test's own prior navigation chose in place.
 */
async function installThemeBridge(page: Page, clickHouseDefinition: unknown) {
  await page.addInitScript(
    ([stored, modeParam, variantParam]) => {
      const params = new URL(location.href).searchParams;
      const mode = params.get(modeParam as string);
      if (mode) {
        localStorage.setItem('color-theme', mode);
      }
      localStorage.setItem('navVisible', 'true');
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      const variant = params.get(variantParam as string);
      if (variant === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(stored));
        localStorage.setItem('theme-source', 'definition');
      } else if (variant === 'default') {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [clickHouseDefinition, MODE_PARAM, VARIANT_PARAM] as [unknown, string, string],
  );
}

function parseRgb(value: string): Rgb {
  const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [channels[0], channels[1], channels[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ([r, g, b]: Rgb) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

type BadgePaint = {
  labelColor: string;
  dotColor: string;
  dotAriaHidden: boolean;
  background: string;
};

/**
 * Reads what the browser actually painted for a badge inside `container`: the
 * dot is found by its `aria-hidden` attribute (not by the color classes under
 * test), the label is the dot's own parent span, and the background is the
 * first non-transparent ancestor of that label, walking up from it.
 */
async function readBadgePaint(container: Locator): Promise<BadgePaint> {
  return container.evaluate((node) => {
    const dot = node.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    const label = dot?.parentElement ?? null;
    if (!dot || !label) {
      throw new Error('Expected a label span holding an aria-hidden leading dot');
    }
    let background = '';
    for (let el: Element | null = label; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        background = bg;
        break;
      }
    }
    return {
      labelColor: getComputedStyle(label).color,
      dotColor: getComputedStyle(dot).backgroundColor,
      dotAriaHidden: dot.getAttribute('aria-hidden') === 'true',
      background,
    };
  });
}

async function createAgent(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
  return agent.id;
}

async function selectAgentInBuilder(page: Page, name: string): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  return form;
}

/** Opens the parsed-actions table for a brand new action on the given agent. */
async function openNewActionTable(page: Page, agentName: string): Promise<Locator> {
  const form = await selectAgentInBuilder(page, agentName);
  await form.getByRole('button', { name: 'Add tools' }).click();
  const toolLibrary = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(toolLibrary).toBeVisible();

  await toolLibrary.getByRole('button', { name: 'Create new…' }).click();
  await page.getByRole('menuitem', { name: 'Actions' }).click();

  const actionDialog = page.getByRole('dialog', { name: 'New action' });
  await expect(actionDialog).toBeVisible();

  await actionDialog.getByRole('textbox', { name: 'Schema' }).fill(OPENAPI_SPEC);
  await expect(actionDialog.getByRole('table')).toBeVisible({ timeout: 20000 });
  return actionDialog;
}

test.describe('agent action method badges', () => {
  test('@scenario:action-method-labels-meet-text-contrast HTTP method labels stay text-secondary while the series hue rides the leading dot', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const agentName = uniqueAgentName('E2E Method Badge Contrast');
    let agentId: string | undefined;

    await installThemeBridge(page, clickHouseTheme);

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      agentId = await createAgent(page, agentName);

      for (const variant of VARIANTS) {
        for (const mode of MODES) {
          await page.goto(`${NEW_CHAT_PATH}?${MODE_PARAM}=${mode}&${VARIANT_PARAM}=${variant}`, {
            timeout: 10000,
          });
          const actionDialog = await openNewActionTable(page, agentName);

          for (const { method, operationId } of METHOD_OPERATIONS) {
            const row = actionDialog.getByRole('row').filter({ hasText: operationId });
            await expect(row).toBeVisible({ timeout: 20000 });

            const paint = await readBadgePaint(row);
            const context = `method=${method} variant=${variant} mode=${mode}`;

            expect(paint.dotAriaHidden, `dot should be aria-hidden (${context})`).toBe(true);
            expect(paint.labelColor, `label should not reuse the dot color (${context})`).not.toBe(
              paint.dotColor,
            );

            const background = parseRgb(paint.background);
            expect(
              contrast(parseRgb(paint.labelColor), background),
              `label contrast (${context})`,
            ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
            expect(
              contrast(parseRgb(paint.dotColor), background),
              `dot contrast (${context})`,
            ).toBeGreaterThanOrEqual(WCAG_MARK_MIN);
          }
        }
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
