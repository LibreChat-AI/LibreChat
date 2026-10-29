import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';

/**
 * An open tool fold draws its rail as a tree: a trunk under the header's glyph with a
 * curved branch into each of its rows. Hovering a row lights the route along that tree,
 * from the header into the row, and the route only ever travels the drawn branches.
 * Conversations are routed fixtures, so every run sees the same rows.
 */
test.describe.configure({ timeout: 120_000 });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const DESKTOP = { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false };
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Part = Record<string, unknown>;

const call = (id: string, name: string, args: Record<string, string>, output: string): Part => ({
  type: 'tool_call',
  tool_call: { id, name, args: JSON.stringify(args), output, progress: 1, type: 'tool_call' },
});

/** Four finished calls in one batch: a single tool group with four rows. */
const GROUP_CONTENT: Part[] = [
  call('g1', 'edit_file_mcp_filesystem', { path: 'src/config.ts' }, 'Edited src/config.ts'),
  call('g2', 'run_command_mcp_shell', { command: 'npm test -- config' }, 'PASS config.test.ts'),
  call('g3', 'run_command_mcp_shell', { command: 'npm test' }, 'Tests: 148 passed'),
  call('g4', 'run_command_mcp_shell', { command: 'git diff --stat' }, '1 file changed'),
  { type: 'text', text: 'Fold tree fixture done.' },
];

/** A phase over two labeled batches: tool groups nested inside an activity phase. */
const PHASE_CONTENT: Part[] = [
  call('p1', 'read_file_mcp_filesystem', { path: 'ci.yml' }, 'name: CI'),
  call('p2', 'read_file_mcp_filesystem', { path: 'package.json' }, '{ "name": "app" }'),
  call('p3', 'list_directory_mcp_filesystem', { path: 'src' }, 'index.ts'),
  {
    type: 'activity_label',
    activity_label: 'Read the build config',
    tool_call_ids: ['p1', 'p2', 'p3'],
    status: 'ok',
  },
  call('p4', 'run_command_mcp_shell', { command: 'npm test' }, 'PASS'),
  call('p5', 'read_file_mcp_filesystem', { path: 'src/config.ts' }, 'export const PORT = 3080;'),
  {
    type: 'activity_label',
    activity_label: 'Ran the test suite',
    tool_call_ids: ['p4', 'p5'],
    status: 'ok',
  },
  {
    type: 'activity_label',
    activity_label: 'Investigated the build',
    activity_label_type: 'phase',
    activity_start_index: 0,
    activity_end_index: 7,
    activity_count: 5,
    status: 'ok',
    pending: false,
  },
  { type: 'text', text: 'Fold tree fixture done.' },
];

async function routeConversation(page: Page, content: Part[]): Promise<string> {
  const conversationId = unique('e2e-fold-tree');
  const now = new Date(0).toISOString();
  const message = {
    messageId: `${conversationId}-msg`,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content,
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Fold tree',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  return conversationId;
}

async function openConversation(page: Page, content: Part[]) {
  const conversationId = await routeConversation(page, content);
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  await expect(messagesView(page).getByText('Fold tree fixture done.')).toBeVisible({
    timeout: 20000,
  });
}

/** The panel of the tool group whose header reads `name`, opened if it is folded. */
async function openGroup(page: Page, name: RegExp): Promise<Locator> {
  const header = messagesView(page).getByRole('button', { name }).first();
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click();
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  return messagesView(page)
    .getByTestId('tool-call-group-panel')
    .filter({ has: page.getByRole('button', { name: /^Ran / }) })
    .last();
}

const railOf = (panel: Locator) => panel.locator('> div > [data-testid="fold-rail"]');
const traceOf = (rail: Locator) => rail.locator('[data-fold-trace]');
const branchesOf = (rail: Locator) => rail.locator('[data-testid="fold-rail-tree"] > g > path');
const rowsOf = (panel: Locator) => panel.getByRole('button', { name: /^Ran / });

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, box: box! };
}

/** The lit route ends in `row`: the bottom of its bounding box sits on the row glyph's center. */
async function expectRouteEndsAt(rail: Locator, row: Locator) {
  const trace = traceOf(rail);
  await expect(trace).toHaveAttribute('data-lit', '');
  await expect
    .poll(async () => {
      const [path, glyph] = await Promise.all([
        trace.boundingBox(),
        row.locator('.fold-glyph').first().boundingBox(),
      ]);
      return path == null || glyph == null
        ? Infinity
        : Math.abs(path.y + path.height - (glyph.y + glyph.height / 2));
    })
    .toBeLessThan(2);
}

/**
 * Records the lit path's shape on every animation frame while `act` runs, in the rail's
 * own coordinates, alongside the branch points the rail drew (one radius above each
 * row center).
 */
async function sampleRoute(rail: Locator, act: () => Promise<void>, ms = 900) {
  await rail.evaluate((element, duration) => {
    const path = element.querySelector('[data-fold-trace]')!;
    const samples: string[] = [];
    (window as unknown as { __foldSamples: string[] }).__foldSamples = samples;
    const until = performance.now() + duration;
    const step = () => {
      samples.push(path.getAttribute('d') ?? '');
      if (performance.now() < until) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }, ms);
  await act();
  await rail.page().waitForTimeout(ms + 100);
  return rail.evaluate((element) => ({
    samples: (window as unknown as { __foldSamples: string[] }).__foldSamples,
    centers: (element.getAttribute('data-centers') ?? '').split(',').map(Number),
  }));
}

const tipOf = (d: string) => Number(/V ([\d.]+)/.exec(d)?.[1]);
const hasBranch = (d: string) => d.includes(' A ');

test.describe('tool fold tree (pointer)', () => {
  test.use(DESKTOP);

  test('an open tool fold draws a branch into each of its rows @scenario:open-tool-fold-branches-into-each-row', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const rail = railOf(panel);
    const rows = rowsOf(panel);
    await expect(rows).toHaveCount(4);
    /** The trunk, then one branch per row. */
    await expect(branchesOf(rail)).toHaveCount(5);
    for (let i = 0; i < 4; i++) {
      const [branch, glyph] = await Promise.all([
        branchesOf(rail)
          .nth(i + 1)
          .boundingBox(),
        rows.nth(i).locator('.fold-glyph').first().boundingBox(),
      ]);
      expect(Math.abs(branch!.y + branch!.height - (glyph!.y + glyph!.height / 2))).toBeLessThan(2);
      /** The branch stops short of the row's icon rather than running under it. */
      expect(branch!.x + branch!.width).toBeLessThanOrEqual(glyph!.x + 2);
    }
    /** The trunk hangs from the header glyph's axis. */
    const header = messagesView(page)
      .getByRole('button', { name: /^Ran 4 actions/ })
      .first();
    const trunk = await center(branchesOf(rail).first());
    const headerGlyph = await center(header.locator('.fold-glyph').first());
    expect(Math.abs(trunk.x - headerGlyph.x)).toBeLessThan(2);
    await expect(rail).toHaveAttribute('aria-hidden', 'true');
    await expect(rail).toHaveAttribute('tabindex', '-1');
  });

  test('hovering a row lights the route from the header into that row @scenario:hovered-tool-row-lights-route-from-header', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const rail = railOf(panel);
    const rows = rowsOf(panel);
    await expect(traceOf(rail)).not.toHaveAttribute('data-lit', '');
    await rows.nth(2).hover();
    await expect(rail).toHaveAttribute('data-fold-lit', '2');
    await expectRouteEndsAt(rail, rows.nth(2));
    /** Leaving the fold fades the route out. */
    await page.mouse.move(5, 5);
    await expect(rail).not.toHaveAttribute('data-fold-lit');
    await expect(traceOf(rail)).not.toHaveAttribute('data-lit', '');
    await expect(traceOf(rail)).toHaveCSS('opacity', '0');
  });

  test('a row in a nested fold lights every level into its own branch @scenario:nested-fold-row-lights-each-level', async ({
    page,
  }) => {
    await openConversation(page, PHASE_CONTENT);
    const phaseHeader = messagesView(page).getByRole('button', { name: 'Investigated the build' });
    await phaseHeader.click();
    await expect(phaseHeader).toHaveAttribute('aria-expanded', 'true');
    const phaseRail = messagesView(page)
      .getByTestId('activity-phase-panel')
      .locator('> div > [data-testid="fold-rail"]');
    const groupHeader = messagesView(page).getByRole('button', { name: /^Ran the test suite/ });
    const panel = await openGroup(page, /^Ran the test suite/);
    const groupRail = railOf(panel);
    const row = rowsOf(panel).first();
    await row.hover();
    await expectRouteEndsAt(groupRail, row);
    /** The phase lights its branch into the group's header, which leads on into the row. */
    await expectRouteEndsAt(phaseRail, groupHeader);
  });

  test('moving between rows travels the tree, never cutting across it @scenario:lit-route-travels-tree-between-rows', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const rail = railOf(panel);
    const rows = rowsOf(panel);
    await rows.nth(2).hover();
    await expectRouteEndsAt(rail, rows.nth(2));

    const { samples, centers } = await sampleRoute(rail, () => rows.nth(1).hover());
    const from = centers[2] - 8;
    const to = centers[1] - 8;
    const moving = samples.filter((d) => d !== '');
    expect(moving.length).toBeGreaterThan(3);
    for (let i = 0; i < moving.length; i++) {
      const tip = tipOf(moving[i]);
      /** Only the trunk between the two rows: never above the new row, never via the top. */
      expect(tip).toBeGreaterThanOrEqual(to - 0.5);
      expect(tip).toBeLessThanOrEqual(from + 0.5);
      if (i > 0) {
        expect(tip).toBeLessThanOrEqual(tipOf(moving[i - 1]) + 0.5);
      }
      /** A branch is drawn only from a branch point, so nothing leaves the tree. */
      if (hasBranch(moving[i])) {
        expect(Math.min(Math.abs(tip - from), Math.abs(tip - to))).toBeLessThan(0.5);
      }
    }
    expect(moving.some((d) => !hasBranch(d) && tipOf(d) > to + 1 && tipOf(d) < from - 1)).toBe(
      true,
    );
    await expectRouteEndsAt(rail, rows.nth(1));
  });

  test('the route stays lit through a click that unfolds the hovered row @scenario:lit-route-stays-after-click-folds-rows', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const rail = railOf(panel);
    const rows = rowsOf(panel);
    await rows.nth(1).hover();
    await expectRouteEndsAt(rail, rows.nth(1));
    /** Click without moving the pointer: the row opens and the rows below it move. */
    await page.mouse.down();
    await page.mouse.up();
    await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(rail).toHaveAttribute('data-fold-lit', '1');
    await expectRouteEndsAt(rail, rows.nth(1));
    /** And again to fold it: still lit, still ending in the same row. */
    await page.mouse.down();
    await page.mouse.up();
    await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');
    await expectRouteEndsAt(rail, rows.nth(1));
  });

  test('with reduced motion the route is placed at once @scenario:reduced-motion-places-lit-route-at-once', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const rail = railOf(panel);
    const rows = rowsOf(panel);
    await rows.nth(0).hover();
    await expectRouteEndsAt(rail, rows.nth(0));
    const { samples } = await sampleRoute(rail, () => rows.nth(3).hover(), 500);
    /** The shape for the first row, then the shape for the last row, and nothing between. */
    expect(new Set(samples.filter((d) => d !== '')).size).toBeLessThanOrEqual(2);
    await expectRouteEndsAt(rail, rows.nth(3));
  });

  test('a right-to-left locale mirrors the tree toward its rows @scenario:rtl-tool-tree-mirrors-branches', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('lang', JSON.stringify('ar')));
    await openConversation(page, GROUP_CONTENT);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl', { timeout: 30000 });
    const panel = messagesView(page).getByTestId('tool-call-group-panel').last();
    /** The copy is Arabic, so the header is found by its place right above the panel. */
    const header = panel.locator('xpath=preceding-sibling::div[1]').getByRole('button').first();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const rail = railOf(panel);
    const row = panel.locator('.fold-glyph').nth(1);
    const branch = branchesOf(rail).nth(2);
    const [path, glyph, trunk] = await Promise.all([
      branch.boundingBox(),
      row.boundingBox(),
      branchesOf(rail).first().boundingBox(),
    ]);
    /** The trunk sits to the row's right, and the branch runs leftward from it to the row. */
    expect(trunk!.x).toBeGreaterThan(glyph!.x + glyph!.width);
    expect(path!.x).toBeGreaterThanOrEqual(glyph!.x + glyph!.width - 2);
    expect(Math.abs(path!.x + path!.width - (trunk!.x + trunk!.width / 2))).toBeLessThan(2);
    expect(Math.abs(path!.y + path!.height - (glyph!.y + glyph!.height / 2))).toBeLessThan(2);
  });
});

test.describe('tool fold tree (touch)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('tapping a row leaves the tree dark @scenario:touch-tap-leaves-tool-tree-dark', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const header = messagesView(page)
      .getByRole('button', { name: /^Ran 4 actions/ })
      .first();
    await header.tap();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const panel = messagesView(page).getByTestId('tool-call-group-panel').last();
    const rail = railOf(panel);
    await expect(branchesOf(rail)).toHaveCount(5);
    await rowsOf(panel).nth(1).tap();
    await expect(rowsOf(panel).nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(rail).not.toHaveAttribute('data-fold-lit');
    await expect(traceOf(rail)).not.toHaveAttribute('data-lit', '');
  });
});
