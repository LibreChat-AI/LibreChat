import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName, waitForPersistedAgent } from '../agents.helpers';

/**
 * Under a right-to-left interface the split views mirror: the panel that sits at the
 * inline start in LTR moves to the right, and dragging a separator still moves it with
 * the pointer. react-resizable-panels measures drags physically, so these pages keep the
 * group LTR and render the panels in reverse; the separator would otherwise drag backwards.
 */

const VIEWPORT = { width: 1280, height: 800 };
const DRAG = 80;

/** The resizable split views only render at desktop widths. */
test.use({ viewport: VIEWPORT });

async function setDirection(page: Page, dir: 'ltr' | 'rtl') {
  await page.evaluate((value) => {
    document.documentElement.dir = value;
  }, dir);
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (rect == null) {
    throw new Error('expected a laid out element');
  }
  return rect;
}

/** Drags a separator horizontally by `dx` pixels with the pointer. */
async function dragSeparator(page: Page, separator: Locator, dx: number) {
  const rect = await box(separator);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  /* react-resizable-panels captures the pointer on the first move, so that move has to
   * stay on the separator the way a real pointer's would; a coarse first step can land
   * inside an artifact iframe, which swallows the rest of the drag. */
  const steps = Math.abs(dx);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  await page.mouse.up();
}

test('the project workspace mirrors under RTL and its separator follows the pointer @scenario:rtl-project-workspace-mirrors-and-drags', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  const token = await getAccessToken(page);
  const project = await requestJson<{ _id: string }>(page, {
    path: '/api/projects',
    token,
    method: 'POST',
    body: { name: `E2E RTL Workspace ${Date.now()}` },
  });

  try {
    await page.goto(`/projects/${project._id}`, { timeout: 15_000 });
    const details = page.locator('#project-details');
    const chats = page.locator('#project-chats');
    await expect(details).toBeVisible();
    await expect(chats).toBeVisible();

    /* LTR keeps details at the inline start, on the left. */
    expect((await box(details)).x).toBeLessThan((await box(chats)).x);

    await setDirection(page, 'rtl');
    await expect(details).toHaveAttribute('dir', 'rtl');
    await expect(chats).toHaveAttribute('dir', 'rtl');
    const before = { details: await box(details), chats: await box(chats) };
    expect(before.details.x).toBeGreaterThan(before.chats.x);

    /* The separator sits between chats (left) and details (right); dragging it right
     * narrows details and widens chats. */
    const separator = page.locator('[data-group]#project-workspace > [role="separator"]');
    await expect(separator).toHaveCount(1);
    await dragSeparator(page, separator, DRAG);
    await expect
      .poll(async () => (await box(details)).width)
      .toBeLessThan(before.details.width - DRAG / 2);
    expect((await box(chats)).width).toBeGreaterThan(before.chats.width + DRAG / 2);
    expect((await box(details)).x).toBeGreaterThan((await box(chats)).x);

    /* The panels were reordered while mounted; the arrow keys still move the separator
     * the way they point. */
    const dragged = (await box(details)).width;
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await box(details)).width).toBeLessThan(dragged - 4);
  } finally {
    await requestJson(page, {
      path: `/api/projects/${encodeURIComponent(project._id)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
  }
});

test('a shared link mirrors its artifacts pane under RTL and its separator follows the pointer @scenario:rtl-share-artifacts-mirrors-and-drags', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (typeof baseURL !== 'string') {
    throw new Error('baseURL must be configured for shared-link mock e2e tests');
  }

  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, 'E2E_HTML_ARTIFACT_REPLY', { timeout: 60_000 });
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);

  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByTestId('share-conversation-menu-item').click();
  await expect(page.getByRole('dialog', { name: 'Share link to chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a shared link' }).click();
  const sharedLinkInput = page.getByTestId('shared-link-url');
  await expect(sharedLinkInput).toHaveValue(/\/share\//);
  const sharedLinkUrl = (await sharedLinkInput.inputValue()).trim();

  const readerContext = await browser.newContext({ viewport: VIEWPORT });
  try {
    const reader = await readerContext.newPage();
    await reader.goto(new URL(sharedLinkUrl, baseURL).toString(), { timeout: 20_000 });
    const content = reader.locator('#share-content');
    const artifacts = reader.locator('#share-artifacts');
    await expect(artifacts).toBeVisible({ timeout: 20_000 });

    /* LTR docks the pane at the inline end, on the right. */
    expect((await box(artifacts)).x).toBeGreaterThan((await box(content)).x);

    await setDirection(reader, 'rtl');
    await expect(artifacts).toHaveAttribute('dir', 'rtl');
    const before = { content: await box(content), artifacts: await box(artifacts) };
    expect(before.artifacts.x).toBeLessThan(before.content.x);

    /* The pane is now on the left; dragging the separator left narrows it. */
    const separator = reader
      .locator('[data-group]')
      .filter({ has: artifacts })
      .locator(':scope > [role="separator"]');
    await expect(separator).toHaveCount(1);
    await dragSeparator(reader, separator, -DRAG);
    await expect
      .poll(async () => (await box(artifacts)).width)
      .toBeLessThan(before.artifacts.width - DRAG / 2);
    expect((await box(content)).width).toBeGreaterThan(before.content.width + DRAG / 2);
    expect((await box(artifacts)).x).toBeLessThan((await box(content)).x);

    const dragged = (await box(artifacts)).width;
    await separator.focus();
    await reader.keyboard.press('ArrowRight');
    await expect.poll(async () => (await box(artifacts)).width).toBeGreaterThan(dragged + 4);
  } finally {
    await readerContext.close();
  }
});

test('the agent detail close button bleeds past the inline end under RTL @scenario:rtl-agent-detail-close-at-inline-end', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  const token = await getAccessToken(page);
  const name = uniqueAgentName('E2E RTL Detail');
  const description = 'An agent whose detail dialog is opened under RTL.';
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description,
      instructions: 'Use the mock model.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      category: 'general',
    },
  });

  try {
    await waitForPersistedAgent(page, name, description);
    await page.goto(`/agents/all?q=${encodeURIComponent(name)}`, { timeout: 10_000 });
    await setDirection(page, 'rtl');
    await page.getByRole('button', { name, exact: true }).click();

    const dialog = page.getByRole('dialog');
    const close = dialog.getByRole('button', { name: 'Close' }).first();
    await expect(close).toBeVisible();
    /* The negative end margin pulls the button outward, onto the left edge in RTL, so it
     * starts before its wrapper; a margin on the start side would push it into the header. */
    const offset = await close.evaluate((node) => {
      const wrapper = node.parentElement?.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return { start: (wrapper?.left ?? 0) - rect.left, end: rect.right - (wrapper?.right ?? 0) };
    });
    expect(offset.start).toBeGreaterThan(4);
    expect(offset.end).toBeLessThanOrEqual(0.5);
  } finally {
    await cleanupAgent(page, agent.id).catch(() => undefined);
  }
});

test('a prompt command keeps its typed text clear of the counter under RTL @scenario:rtl-prompt-counter-clear-of-text', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  const promptsButton = page.getByRole('button', { name: 'Prompts', exact: true });
  if ((await promptsButton.getAttribute('aria-pressed')) !== 'true') {
    await promptsButton.click();
  }
  await page.getByRole('button', { name: 'Create Prompt' }).click();
  const input = page.getByRole('dialog').getByRole('textbox', {
    name: 'Optional: Enter a command for the prompt or name will be used',
  });
  await expect(input).toBeVisible();
  await input.fill('a'.repeat(40));
  const counter = input.locator('xpath=../..').getByText(/^\d+\/\d+$/);
  await expect(counter).toBeVisible();

  /* LTR: the counter sits after the field, at the right. */
  expect((await box(input)).x + (await box(input)).width).toBeLessThanOrEqual(
    (await box(counter)).x + 1,
  );

  await setDirection(page, 'rtl');
  /* RTL: the counter moves to the left and the field ends before it. */
  await expect.poll(async () => (await box(counter)).x).toBeLessThan((await box(input)).x);
  const field = await box(input);
  const count = await box(counter);
  expect(count.x + count.width).toBeLessThanOrEqual(field.x + 1);
});

test('marketplace category tabs follow the visual arrow direction under RTL @scenario:rtl-category-tabs-arrow-keys', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/agents/all', { timeout: 30_000 });
  const tabs = page.getByRole('tablist').first().getByRole('tab');
  await expect(tabs.nth(1)).toBeVisible();

  await setDirection(page, 'rtl');
  const first = tabs.first();
  const second = tabs.nth(1);
  /* The first tab sits at the inline start, which is now the right. */
  expect((await box(first)).x).toBeGreaterThan((await box(second)).x);

  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(second).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
});
