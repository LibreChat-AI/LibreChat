import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { openAgentBuilder, uniqueAgentName, cleanupAgent } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * A modal OGDialog parks `pointer-events: none` on the body, so a menu portaled out of it inherits
 * `none` unless it turns pointer events back on for itself. DropdownPopup does that with a class,
 * not an inline style, and its menu must still take a real mouse pick while the dialog is open.
 * A field Dropdown's check glyph draws at the icon size role, so a theme that resizes icons resizes
 * the check. The Dropdown under test is the agent code tool's execution environment picker, which
 * renders inside the tool's modal dialog.
 */

/** Names an icon size apart from the default, so a box still drawn at a fixed size shows. */
const REFERENCE_ICON_THEME = {
  version: 1,
  name: 'e2e-icon-reference',
  modes: {
    light: { appearance: { iconSize: '1.25rem' } },
    dark: { appearance: { iconSize: '1.25rem' } },
  },
} as const;

/** Leaves the color mode to the project (light, dark or mobile), so every scenario runs in each. */
async function useTheme(page: Page, definition?: { name: string }) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

/** The stateful workspace Dropdown only renders when the agents endpoint offers stateful sessions,
 *  and the execution environment Select only when it also lists environments; a pick's save is
 *  answered here so it stands without a configured code environment. */
async function offerStatefulSessions(page: Page) {
  await page.route('**/api/user/preferences', async (route) => {
    if (route.request().method() === 'GET') {
      return route.continue();
    }
    await route.fulfill({ json: { preferences: route.request().postDataJSON() } });
  });
  await page.route('**/api/endpoints', async (route) => {
    const response = await route.fetch();
    const endpoints = await response.json();
    const agents = endpoints.agents ?? {};
    agents.capabilities = [
      ...new Set([...(agents.capabilities ?? []), 'execute_code', 'stateful_code_sessions']),
    ];
    agents.statefulCodeSessions = {
      ...agents.statefulCodeSessions,
      environments: [{ id: 'e2e-managed', name: 'E2E managed runtime', type: 'managed' }],
    };
    endpoints.agents = agents;
    await route.fulfill({ response, json: endpoints });
  });
}

/** Opens the stateful workspace Dropdown's list in the Settings dialog. */
async function openWorkspaceDropdown(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  /** Mobile keeps the account menu in the drawer. */
  await openSidebar(page);
  await page.getByTestId('nav-user').locator('visible=true').first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: /data/i }).click();
  const trigger = dialog.getByTestId('default-stateful-workspace');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
}

let agentId: string | undefined;

/** Opens the execution environment Select's list in the code tool's dialog of a fresh agent. */
async function openEnvironmentSelect(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const name = uniqueAgentName('Select Fixture');
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: ['execute_code'],
    },
  });
  agentId = agent.id;

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);

  const row = form
    .getByText('Run Code', { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"group")][1]');
  await row.hover();
  await row.getByRole('button', { name: 'Configure' }).click();
  const dialog = page.getByRole('dialog');
  const stateful = dialog.getByTestId('stateful-code-sessions');
  await expect(stateful).toBeVisible({ timeout: 15000 });
  if ((await stateful.getAttribute('aria-checked')) !== 'true') {
    await stateful.click();
  }
  const trigger = dialog.getByTestId('code-environment-id');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  /** The list zooms in from 0.95, so a box read before the transition settles is scaled. The
   *  transition only starts once Ariakit marks the list entered, so wait for that first. */
  await expect(listbox).toHaveAttribute('data-enter');
  await expect
    .poll(() => listbox.evaluate((element) => getComputedStyle(element).scale))
    .toMatch(/^(1|none)$/);
}

test.afterEach(async ({ page }) => {
  await cleanupAgent(page, agentId);
  agentId = undefined;
});

/** The checked option's check glyph is `expected` square, so it follows the icon size role. */
async function expectIndicator(page: Page, expected: string) {
  const checked = page.getByRole('option', { selected: true });
  const glyph = checked.locator('svg');
  await expect(glyph).toBeVisible();
  const glyphRect = await glyph.boundingBox();
  expect(glyphRect).not.toBeNull();
  expect(`${glyphRect?.width}px`).toBe(expected);
  expect(`${glyphRect?.height}px`).toBe(expected);
}

test.describe('popovers inside a modal dialog', () => {
  test('the role menu inside Admin Settings takes a mouse pick @scenario:menu-in-dialog-takes-pointer', async ({
    page,
  }) => {
    await useTheme(page);
    await page.goto('/agents/all', { timeout: 15000 });
    await page.getByRole('button', { name: 'Admin Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    const trigger = dialog.locator('button[aria-haspopup="menu"]');
    const before = (await trigger.innerText()).trim();
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('none');
    expect(await menu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');

    const items = menu.getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    const labels = (await items.allInnerTexts()).map((label) => label.trim());
    const next = labels.find((label) => label !== before);
    expect(next).toBeTruthy();
    await items
      .filter({ hasText: next as string })
      .first()
      .click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveText(next as string);
  });

  test('the Select check indicator box takes the default icon size @scenario:select-indicator-icon-role-default', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await openEnvironmentSelect(page);
    await expectIndicator(page, '16px');
  });

  test('the Select check indicator box follows a theme icon size @scenario:select-indicator-icon-role-reference', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, REFERENCE_ICON_THEME);
    await openEnvironmentSelect(page);
    await expectIndicator(page, '20px');
  });

  /** The dialog traps focus in its own DOM, so a list portaled out of it could not take the
   *  keyboard. The list renders inside the dialog and the arrow keys and Enter pick from it. */
  test('the execution environment Dropdown takes a keyboard pick inside the tool dialog @scenario:code-environment-keyboard-pick', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await openEnvironmentSelect(page);

    const dialog = page.getByRole('dialog');
    const listbox = page.getByRole('listbox');
    await expect(dialog).toContainText('E2E managed runtime');
    expect(await listbox.evaluate((element) => element.closest('[role="dialog"]') != null)).toBe(
      true,
    );
    await expect(listbox).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(listbox).toBeHidden();
    const trigger = dialog.getByTestId('code-environment-id');
    await expect(trigger).toHaveText('E2E managed runtime');
    await expect(trigger).toBeFocused();
    await expect(dialog).toBeVisible();
  });

  /** The Settings dialog is a Headless UI panel, not an OGDialog; before it declared a dialog
   *  level its popover lists painted behind it (berry-13/LibreChat#249). Hit testing alone cannot
   *  show that: the open list sets `pointer-events: none` on the body, so the panel is skipped and
   *  a click falls through to a list nobody can see. The probe turns pointer events back on
   *  everywhere so `elementFromPoint` reports what is painted on top. */
  test('a dropdown in the Settings dialog opens on top of it and takes a pick @scenario:settings-select-opens-on-top', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await openWorkspaceDropdown(page);

    const option = page.getByRole('option', { name: 'Conversation workspace' });
    const box = await option.boundingBox();
    expect(box).not.toBeNull();
    const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    const painted = await page.evaluate(
      ([px, py]) => {
        const probe = document.createElement('style');
        probe.textContent = '* { pointer-events: auto !important; }';
        document.head.append(probe);
        const top = document.elementFromPoint(px, py);
        probe.remove();
        return top?.closest('[role="listbox"]') != null;
      },
      [x, y],
    );
    expect(painted).toBe(true);

    await page.mouse.click(x, y);
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(page.getByTestId('default-stateful-workspace')).toHaveText(
      'Conversation workspace',
    );
    /** Mobile shows the open section's title in place of "Settings", so the control staying on
     *  screen is what shows the dialog stayed open. */
    await expect(page.getByTestId('default-stateful-workspace')).toBeVisible();
  });
});

/** Sets both list roles apart from their defaults, so a list still drawing a fixed size shows. */
const REFERENCE_LIST_THEME = {
  version: 1,
  name: 'e2e-list-reference',
  modes: {
    light: { appearance: { listMinWidth: '12rem', listMaxHeight: '20rem' } },
    dark: { appearance: { listMinWidth: '12rem', listMaxHeight: '20rem' } },
  },
} as const;

/** The open list's width floor and scroll cap, as the browser computed them, with the trigger's
 *  width and the room the popover leaves between its trigger and its boundary, and the list's
 *  drawn box. Inside a dialog that boundary is the dialog, since the list renders in it. */
async function listBounds(page: Page) {
  return page.getByRole('listbox').evaluate((element) => {
    const style = getComputedStyle(element);
    const { top, bottom, width } = element.getBoundingClientRect();
    return {
      width,
      minWidth: style.minWidth,
      maxHeight: style.maxHeight,
      anchor: parseFloat(style.getPropertyValue('--popover-anchor-width')),
      available: parseFloat(style.getPropertyValue('--popover-available-height')),
      top,
      bottom,
    };
  });
}

/** The list takes the `roleMinWidth` floor and is at least its trigger wide, and caps at `roleMaxHeight` or the
 *  room it has, whichever is smaller. A `none` role leaves only the room. */
function expectListRoles(
  bounds: Awaited<ReturnType<typeof listBounds>>,
  roleMinWidth: number,
  roleMaxHeight: number | 'none',
) {
  expect(bounds.anchor).toBeGreaterThan(0);
  expect(bounds.minWidth).toBe(`${roleMinWidth}px`);
  expect(bounds.width).toBeGreaterThanOrEqual(Math.max(roleMinWidth, bounds.anchor) - 0.5);
  const cap =
    roleMaxHeight === 'none' ? bounds.available : Math.min(roleMaxHeight, bounds.available);
  expect(bounds.maxHeight).toBe(`${cap}px`);
}

/** Tall enough that the list's own cap, not the viewport, decides its height. */
async function useTallWindow(page: Page) {
  const { width } = page.viewportSize() ?? { width: 1280 };
  await page.setViewportSize({ width, height: 1100 });
}

const SHORT_PHONE = { width: 375, height: 480 };
const SHORT_WINDOW = { width: 1024, height: 420 };

/** In a viewport too short for the list's own cap, the list scrolls inside the room the popper
 *  leaves rather than running past the viewport's edge. */
async function expectListFits(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await openEnvironmentSelect(page);
  const bounds = await listBounds(page);
  expect(bounds.available).toBeLessThan(384);
  expect(parseFloat(bounds.maxHeight)).toBeLessThanOrEqual(bounds.available);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
}

test.describe('Select list size roles', () => {
  test('the default theme keeps the list at 8rem wide and 24rem tall at most @scenario:select-list-size-default', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await useTallWindow(page);
    await openEnvironmentSelect(page);
    expectListRoles(await listBounds(page), 128, 384);
  });

  test('the ClickHouse theme sizes the list by its trigger and caps it at the available height @scenario:select-list-size-clickhouse', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, clickHouseTheme);
    await useTallWindow(page);
    await openEnvironmentSelect(page);
    expectListRoles(await listBounds(page), 0, 'none');
  });

  test('a theme that sets both list roles resizes the list @scenario:select-list-size-reference', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, REFERENCE_LIST_THEME);
    await useTallWindow(page);
    await openEnvironmentSelect(page);
    expectListRoles(await listBounds(page), 192, 320);
  });

  test('the default list never grows past a short phone screen @scenario:select-list-fits-short-phone', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await expectListFits(page, SHORT_PHONE);
  });

  test('the ClickHouse list never grows past a short phone screen @scenario:select-list-fits-short-phone-clickhouse', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, clickHouseTheme);
    await expectListFits(page, SHORT_PHONE);
  });

  test('the default list never grows past a small desktop window @scenario:select-list-fits-short-window', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page);
    await expectListFits(page, SHORT_WINDOW);
  });

  test('the ClickHouse list never grows past a small desktop window @scenario:select-list-fits-short-window-clickhouse', async ({
    page,
  }) => {
    await offerStatefulSessions(page);
    await useTheme(page, clickHouseTheme);
    await expectListFits(page, SHORT_WINDOW);
  });
});
