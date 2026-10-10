import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { getSecondaryE2EUser } from '../../../setup/users.mock';
import { openAgentBuilder, uniqueAgentName, cleanupAgent } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson, uniqueName } from '../helpers';
import { getE2EUser } from '../../../setup/user';
import { withMongo } from '../db';

/**
 * The principal type badge (User / Group / Role) on each people-search result
 * inside the agent share dialog used to paint its label text in a categorical
 * series color (`text-series-N` over `bg-series-N/10`), which fails WCAG
 * 4.5:1 for text this small. The label now stays on `text-text-secondary` and
 * the series hue rides on a leading decorative dot held to the 3:1 mark floor
 * instead (`PeoplePickerSearchItem.tsx`). These scenarios drive a real search
 * through `UnifiedPeopleSearch` -> `SearchPicker` and read what the browser
 * actually paints, at rest (popover `bg-surface-secondary`) and while the
 * option is active (`bg-surface-tertiary`), in light, dark, and the ClickHouse
 * reference theme (the theme the original report measured failing).
 *
 * The primary e2e user is the first user ever registered in this run's fresh
 * database (`e2e/setup/global-setup.ts` -> `authenticate`), so
 * `AuthService.js` auto-promotes it to ADMIN. The default ADMIN role already
 * grants `PEOPLE_PICKER` view access and bypasses the agent `SHARE`
 * permission check (`roleDefaults` in `packages/data-provider/src/roles.ts`,
 * the admin shortcut in `packages/api/src/acl/search.ts`, and the `isAdmin`
 * clauses in `AgentFooter.tsx`), so no role permissions need seeding here.
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
const SEARCH_LABEL = 'Search for people or groups by name or email';

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

function assertBadgePaint(paint: BadgePaint, context: string) {
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

async function openShareDialog(page: Page, agentName: string): Promise<Locator> {
  await selectAgentInBuilder(page, agentName);
  await page.getByRole('button', { name: `Share ${agentName}` }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${agentName}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A minimal local group: `source: 'local'` needs no `idOnTheSource`
 *  (`packages/data-schemas/src/schema/group.ts`), and the search matches on
 *  `name` alone (`findGroupsByNamePattern`). */
async function seedGroup(name: string): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('groups').insertOne({
      name,
      source: 'local',
      memberIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

async function deleteGroup(name: string): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('groups').deleteOne({ name });
  });
}

/** The primary e2e user is registered by global setup, but the secondary one
 *  is not guaranteed to exist yet in this run's database: mirrors the same
 *  defensive insert `marketplace-mine.spec.ts` uses so the principal search
 *  has a "user" result to find regardless of spec run order. Left in place
 *  afterward, as that spec does, since it is a shared fixture. */
async function ensureSecondaryUser(): Promise<{ name: string; email: string }> {
  const secondary = getSecondaryE2EUser();
  await withMongo(async (db) => {
    const users = db.collection('users');
    const existing = await users.findOne({ email: secondary.email });
    if (existing) {
      return;
    }
    const primaryUser = await users.findOne({ email: getE2EUser().email });
    const now = new Date();
    await users.insertOne({
      _id: new ObjectId(),
      email: secondary.email,
      name: secondary.name,
      tenantId: primaryUser?.tenantId,
      role: primaryUser?.role,
      createdAt: now,
      updatedAt: now,
    });
  });
  return secondary;
}

/** Makes the sole rendered option the active descendant (`data-active-item`),
 *  the same roving-focus mechanism `model-selector-search.spec.ts` drives with
 *  repeated `ArrowDown` presses from the search box. */
async function activateOnlyOption(search: Locator, option: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await option.getAttribute('data-active-item')) !== null) {
      return;
    }
    await search.press('ArrowDown');
  }
}

test.describe('people picker principal type badges', () => {
  test('@scenario:principal-type-labels-meet-text-contrast principal type labels (User/Group/Role) stay text-secondary while the series hue rides the leading dot', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const agentName = uniqueAgentName('E2E Principal Badge Contrast');
    const groupName = uniqueName('E2E Principal Badge Group');
    let agentId: string | undefined;
    let groupSeeded = false;

    await installThemeBridge(page, clickHouseTheme);

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      agentId = await createAgent(page, agentName);
      await seedGroup(groupName);
      groupSeeded = true;

      const secondaryUser = await ensureSecondaryUser();
      /** Each query isolates exactly one result: the secondary user's full
       *  name, the unique seeded group's name, and "admin", which matches only
       *  the ADMIN system role (no seeded user, group, or email contains it). */
      const queries: ReadonlyArray<{ type: string; label: string; query: string }> = [
        { type: 'user', label: 'User', query: secondaryUser.name },
        { type: 'group', label: 'Group', query: groupName },
        { type: 'role', label: 'Role', query: 'admin' },
      ];

      for (const variant of VARIANTS) {
        for (const mode of MODES) {
          await page.goto(`${NEW_CHAT_PATH}?${MODE_PARAM}=${mode}&${VARIANT_PARAM}=${variant}`, {
            timeout: 10000,
          });
          const dialog = await openShareDialog(page, agentName);
          const search = dialog.getByRole('combobox', { name: SEARCH_LABEL });
          await expect(search).toBeVisible();

          for (const { type, label, query } of queries) {
            await search.fill(query);
            /** The picker debounces the query and keeps the previous result on
             *  screen until the new one lands, so wait for this query's own
             *  option (its name and its type label) before reading any paint. */
            const option = dialog
              .getByRole('option')
              .filter({ hasText: query })
              .filter({ hasText: label });
            await expect(option).toBeVisible({ timeout: 10000 });
            await expect(dialog.getByRole('option')).toHaveCount(1);

            const context = `type=${type} variant=${variant} mode=${mode}`;
            assertBadgePaint(await readBadgePaint(option), `resting, ${context}`);

            await activateOnlyOption(search, option);
            await expect(
              option,
              `option should become the active descendant (${context})`,
            ).toHaveAttribute('data-active-item', /.*/);
            assertBadgePaint(await readBadgePaint(option), `active, ${context}`);
          }
        }
      }
    } finally {
      await cleanupAgent(page, agentId);
      if (groupSeeded) {
        await deleteGroup(groupName);
      }
    }
  });
});
