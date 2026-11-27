import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import { MOCK_ENDPOINTS, fetchJson, getAccessToken, requestJson } from '../helpers';

const SERVER = 'e2e-memory';
/** The fixture registers some tools conditionally, so the seed takes the
 *  server's live list and only relies on these two. */
const REQUIRED_TOOLS = ['recall_fact', 'slow_echo'];
const toolId = (name: string) => `${name}_mcp_${SERVER}`;
const SERVER_TOOL_ID = `sys__server__sys_mcp_${SERVER}`;
/** WCAG 1.4.11 non-text contrast floor the series scale is held to. */
const MARK_MIN = 3;

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

type Paint = { color: string; border: string; background: string; ratio: number };

async function waitForServerTools(page: Page): Promise<string[]> {
  const token = await getAccessToken(page);
  let toolIds: string[] = [];
  await expect
    .poll(
      async () => {
        const tools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
        toolIds = (tools.servers?.[SERVER]?.tools ?? []).map((tool) => tool.pluginKey);
        return toolIds;
      },
      { timeout: 20000 },
    )
    .toEqual(expect.arrayContaining(REQUIRED_TOOLS.map(toolId)));
  return toolIds;
}

/** Every tool is deferred so the bulk Defer toggle restores pressed; only
 *  `slow_echo` runs in the background so bulk and per-tool Background differ. */
async function seedAgent(page: Page, toolIds: string[]): Promise<AgentDetail> {
  const token = await getAccessToken(page);
  const toolOptions = Object.fromEntries(
    toolIds.map((id) => [
      id,
      id === toolId('slow_echo')
        ? { defer_loading: true, run_in_background: true }
        : { defer_loading: true },
    ]),
  );
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Option Colors'),
      instructions: 'Reply through the mock e2e model.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [SERVER_TOOL_ID, ...toolIds],
      tool_options: toolOptions,
    },
  });
}

async function openServerDialog(page: Page, agentName: string): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);

  await form.getByRole('button', { name: 'Add tools' }).click();
  const library = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(library).toBeVisible();
  await library.getByRole('textbox', { name: 'Search tools…' }).fill(SERVER);
  await library.getByRole('button', { name: 'Configure', exact: true }).first().click();

  const dialog = page.getByRole('dialog', { name: /e2e-memory|E2E Memory/i });
  await expect(dialog.getByRole('button', { name: 'slow_echo', exact: true })).toBeVisible({
    timeout: 20000,
  });
  return dialog;
}

/** The per-tool toggles share the row with the tool's select button. */
function rowToggle(dialog: Locator, tool: string, label: string): Locator {
  return dialog
    .getByRole('button', { name: tool, exact: true })
    .locator('..')
    .getByRole('button', { name: label, exact: true });
}

/** Resolves the icon color, border color, and the first opaque background
 *  under the button, then the contrast between icon and that background. */
function paint(toggle: Locator): Promise<Paint> {
  return toggle.evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const channel = (value: number) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

    const style = getComputedStyle(element);
    let background = 'rgba(0, 0, 0, 0)';
    for (let node: Element | null = element; node; node = node.parentElement) {
      const candidate = getComputedStyle(node).backgroundColor;
      const alpha = parse(candidate)[3];
      if (alpha === undefined || alpha > 0) {
        background = candidate;
        break;
      }
    }
    const [light, dark] = [luminance(parse(style.color)), luminance(parse(background))].sort(
      (a, b) => b - a,
    );
    return {
      color: style.color,
      border: style.borderTopColor,
      background: style.backgroundColor,
      ratio: (light + 0.05) / (dark + 0.05),
    };
  });
}

const isTransparent = (value: string) => /rgba\(.*,\s*0\)$/.test(value) || value === 'transparent';

async function expectPressed(toggle: Locator) {
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  /** Colors transition on toggle, so wait for the border to settle on the icon color. */
  await expect
    .poll(async () => {
      const { border, color } = await paint(toggle);
      return !isTransparent(border) && border === color;
    })
    .toBe(true);
  const result = await paint(toggle);
  expect(isTransparent(result.background)).toBe(true);
  expect(result.ratio).toBeGreaterThanOrEqual(MARK_MIN);
}

async function expectUnpressed(toggle: Locator, pressedColor: string) {
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => isTransparent((await paint(toggle)).border)).toBe(true);
  const result = await paint(toggle);
  expect(result.color).not.toBe(pressedColor);
  expect(isTransparent(result.background)).toBe(true);
}

test.describe('MCP tool option colors', () => {
  let agent: AgentDetail | undefined;

  test.beforeEach(async ({ page }) => {
    await page.goto('/c/new', { timeout: 10000 });
    agent = await seedAgent(page, await waitForServerTools(page));
  });

  test.afterEach(async ({ page }) => {
    await cleanupAgent(page, agent?.id);
  });

  test('saved options open pressed in their series color @scenario:saved-mcp-options-open-pressed-in-series-color', async ({
    page,
  }) => {
    const dialog = await openServerDialog(page, agent!.name!);

    await expectPressed(dialog.getByRole('button', { name: 'Undefer all tools', exact: true }));
    await expectPressed(rowToggle(dialog, 'slow_echo', 'Defer loading'));
    await expectPressed(rowToggle(dialog, 'slow_echo', 'Background'));

    const defer = await paint(rowToggle(dialog, 'slow_echo', 'Defer loading'));
    const background = await paint(rowToggle(dialog, 'slow_echo', 'Background'));
    expect(defer.color).not.toBe(background.color);
  });

  test('an option left off stays neutral @scenario:unpressed-mcp-option-stays-neutral', async ({
    page,
  }) => {
    const dialog = await openServerDialog(page, agent!.name!);
    const pressed = await paint(rowToggle(dialog, 'slow_echo', 'Background'));

    await expectUnpressed(rowToggle(dialog, 'recall_fact', 'Background'), pressed.color);
    await expectUnpressed(
      dialog.getByRole('button', { name: 'Mark all as background', exact: true }),
      pressed.color,
    );
  });

  test('hovering a pressed option keeps its icon contrast @scenario:pressed-mcp-option-hover-keeps-contrast', async ({
    page,
  }) => {
    const dialog = await openServerDialog(page, agent!.name!);

    for (const toggle of [
      rowToggle(dialog, 'slow_echo', 'Defer loading'),
      rowToggle(dialog, 'slow_echo', 'Background'),
      dialog.getByRole('button', { name: 'Undefer all tools', exact: true }),
    ]) {
      const rest = await paint(toggle);
      await toggle.hover();
      await expect.poll(async () => (await paint(toggle)).background).not.toBe(rest.background);
      /** The hover surface fades in; the resting value is what a user sees. */
      await expect
        .poll(async () => (await paint(toggle)).ratio, { timeout: 5000 })
        .toBeGreaterThanOrEqual(MARK_MIN);
      const hovered = await paint(toggle);
      expect(hovered.color).toBe(rest.color);
    }
  });

  test('keyboard toggling flips the option treatment @scenario:keyboard-toggle-flips-mcp-option-treatment', async ({
    page,
  }) => {
    const dialog = await openServerDialog(page, agent!.name!);
    const pressedColor = (await paint(rowToggle(dialog, 'slow_echo', 'Background'))).color;
    const toggle = rowToggle(dialog, 'recall_fact', 'Background');

    await toggle.focus();
    await page.keyboard.press('Space');
    await expectPressed(toggle);
    await expect.poll(async () => (await paint(toggle)).color).toBe(pressedColor);

    await page.keyboard.press('Space');
    await expectUnpressed(toggle, pressedColor);
  });
});
