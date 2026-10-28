import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';

/** Tool folds keep their results and pointer shortcuts without drawing tree markers. */
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

test.describe('tool fold tree (pointer)', () => {
  test.use(DESKTOP);

  test('an open tool fold keeps rows without visible branches @scenario:open-tool-fold-branches-into-each-row', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    await expect(rowsOf(panel)).toHaveCount(4);
    await expect(railOf(panel).locator('svg')).toBeHidden();
  });

  test('hovering a row keeps the tree hidden @scenario:hovered-tool-row-lights-route-from-header', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    await rowsOf(panel).nth(2).hover();
    await expect(railOf(panel).locator('svg')).toBeHidden();
  });

  test('nested folds keep both trees hidden @scenario:nested-fold-row-lights-each-level', async ({
    page,
  }) => {
    await openConversation(page, PHASE_CONTENT);
    await messagesView(page).getByRole('button', { name: 'Investigated the build' }).click();
    const panel = await openGroup(page, /^Ran the test suite/);
    await rowsOf(panel).first().hover();
    for (const rail of await messagesView(page).getByTestId('fold-rail').all()) {
      await expect(rail.locator('svg')).toBeHidden();
    }
  });

  test('moving between rows never shows a route @scenario:lit-route-travels-tree-between-rows', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    await rowsOf(panel).nth(2).hover();
    await rowsOf(panel).nth(1).hover();
    await expect(railOf(panel).locator('svg')).toBeHidden();
  });

  test('a row still unfolds without a visible route @scenario:lit-route-stays-after-click-folds-rows', async ({
    page,
  }) => {
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    const row = rowsOf(panel).nth(1);
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(railOf(panel).locator('svg')).toBeHidden();
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  test('reduced motion keeps the tree hidden @scenario:reduced-motion-places-lit-route-at-once', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openConversation(page, GROUP_CONTENT);
    const panel = await openGroup(page, /^Ran 4 actions/);
    await rowsOf(panel).first().hover();
    await expect(railOf(panel).locator('svg')).toBeHidden();
  });

  test('RTL keeps the tree hidden @scenario:rtl-tool-tree-mirrors-branches', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lang', JSON.stringify('ar')));
    await openConversation(page, GROUP_CONTENT);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const panel = messagesView(page).getByTestId('tool-call-group-panel').last();
    await panel.locator('xpath=preceding-sibling::div[1]').getByRole('button').first().click();
    await expect(railOf(panel).locator('svg')).toBeHidden();
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
