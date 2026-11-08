import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  replyPrompt,
  replyText,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';

/**
 * The chat chrome a deployment review asked for: what a response repeats from the header, what the
 * streaming dot says it is, and how the sidebar sits. The sidebar's rail and the hover tooltip are
 * desktop surfaces, so this runs on the desktop viewport it describes.
 */

test.use({ viewport: { width: 1280, height: 800 } });

async function createAgent(page: Page, name: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Launch QA acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
}

async function serveInterface(page: Page, overrides: Record<string, unknown>) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, interface: { ...config.interface, ...overrides } },
    });
  });
}

/** Sends a turn to the agent and returns its finished response row. */
async function replyFromAgent(page: Page, agentId: string, label: string) {
  await page.goto(`${NEW_CHAT_PATH}?agent_id=${agentId}`, { timeout: 15000 });
  await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  const row = page.locator('.agent-turn').last();
  await expect(row.getByText(replyText(label))).toBeVisible();
  return row;
}

const sectionHeading = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first();

const textLeft = (page: Page, selector: string, text: string) =>
  page.evaluate(
    ([sel, wanted]) => {
      const element = [...document.querySelectorAll(sel)].find(
        (candidate) => candidate.textContent?.trim() === wanted,
      );
      if (!element) {
        return null;
      }
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left;
    },
    [selector, text],
  );

test.describe('response author', () => {
  test('a response shows its author by default @scenario:response-shows-its-author-by-default', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Author Default');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      const row = await replyFromAgent(page, agentId, 'author-default');
      await expect(row.getByRole('heading', { name })).toBeVisible();
      await expect(row.getByRole('heading', { name })).not.toHaveClass(/sr-only/);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an opted-in deployment drops the avatar and name the selector shows @scenario:response-drops-the-author-the-selector-shows', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Author Hidden');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await serveInterface(page, { messageAuthor: 'whenDifferent' });
      const row = await replyFromAgent(page, agentId, 'author-hidden');
      /** Still announced, no longer drawn: the row holds only assistive technology text. */
      await expect(row.locator('h2')).toHaveClass(/sr-only/);
      await expect(row.locator('h2')).toContainText(name);
      await expect(page.locator('button, [role="combobox"]').getByText(name)).toBeVisible();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a response by another agent keeps its author @scenario:response-by-another-agent-keeps-its-author', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Author Selected');
    const otherName = uniqueAgentName('E2E Author Other');
    let agentId: string | undefined;
    let otherId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      otherId = (await createAgent(page, otherName)).id;
      await serveInterface(page, { messageAuthor: 'whenDifferent' });
      await replyFromAgent(page, agentId, 'author-other');

      /** The selector stays on the first agent while the stored response came from the second. */
      const authoredBy = otherId;
      await page.route(/\/api\/messages\/[^/?]+(\?|$)/, async (route) => {
        const response = await route.fetch();
        const messages = (await response.json()) as Array<Record<string, unknown>>;
        await route.fulfill({
          response,
          json: messages.map((message) =>
            message.isCreatedByUser === true ? message : { ...message, model: authoredBy },
          ),
        });
      });
      await page.reload();

      const heading = page.locator('.agent-turn').last().getByRole('heading', { name: otherName });
      await expect(heading).toBeVisible();
      await expect(heading).not.toHaveClass(/sr-only/);
    } finally {
      await cleanupAgent(page, agentId);
      await cleanupAgent(page, otherId);
    }
  });
});

test('the streaming dot explains itself on hover and to assistive technology @scenario:streaming-dot-explains-itself', async ({
  page,
}) => {
  test.setTimeout(120000);
  const name = uniqueAgentName('E2E Streaming Dot');
  let agentId: string | undefined;

  try {
    agentId = (await createAgent(page, name)).id;
    await page.goto(`${NEW_CHAT_PATH}?agent_id=${agentId}`, { timeout: 15000 });
    /** Held open, so the placeholder stays up long enough to read. */
    await page.route(/\/api\/agents\/chat/, () => {});
    await page.locator('#prompt-textarea').fill('Hold this turn open');
    await page.keyboard.press('Enter');

    const dot = page.getByRole('img', { name: 'Thinking...' }).first();
    await expect(dot).toBeVisible();
    await expect(dot).not.toHaveAttribute('tabindex');

    const box = await page.locator('.result-thinking').first().boundingBox();
    await page.mouse.move(box!.x + 6, box!.y - 5);
    await expect(page.getByRole('tooltip').first()).toHaveText('Thinking...');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanupAgent(page, agentId);
  }
});

test.describe('sidebar', () => {
  test('the projects section starts expanded for an account with none @scenario:projects-section-starts-expanded', async ({
    page,
  }) => {
    await page.route(/\/api\/projects(\?|$)/, (route) =>
      route.fulfill({ json: { projects: [], nextCursor: null } }),
    );
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await page.evaluate(() => {
      localStorage.removeItem('projectsSectionExpanded');
      localStorage.removeItem('projectsSectionToggled');
    });
    await page.reload();

    const heading = sectionHeading(page, 'Projects');
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();

    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(sectionHeading(page, 'Projects')).toHaveAttribute('aria-expanded', 'false');
    await sectionHeading(page, 'Projects').click();
  });

  test('section headings line up with the date labels @scenario:sidebar-headings-align-with-date-labels', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Sidebar Align');
    let agentId: string | undefined;

    try {
      agentId = (await createAgent(page, name)).id;
      await replyFromAgent(page, agentId, 'sidebar-align');
      await expect(page.getByRole('heading', { name: /Today/ }).first()).toBeVisible();

      /** The list is virtualized, so its rows only hold their position once they are measured. */
      const dateLeft = () =>
        page
          .locator('aside h2')
          .filter({ hasText: 'Today' })
          .first()
          .evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getBoundingClientRect().left;
          });
      for (const heading of ['Projects', 'Chats']) {
        await expect
          .poll(async () => {
            const left = await textLeft(page, 'button > span', heading);
            return Math.abs((left ?? 0) - (await dateLeft()));
          })
          .toBeLessThan(1);
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('the memories panel stays off the agents route and returns to the chat @scenario:memories-panel-stays-off-the-agents-route', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const rail = page.getByTestId('nav-panel-memories');
    await rail.click();
    await expect(rail).toHaveAttribute('aria-pressed', 'true');
    const filter = page
      .getByPlaceholder('Filter memories...')
      .or(page.getByLabel('Filter memories...'));
    await expect(filter.first()).toBeVisible();

    await page.getByTestId('nav-agents-marketplace-button').click();
    await page.waitForURL(/\/agents/);
    await expect(filter).toHaveCount(0);
    await expect(rail).toHaveCount(0);
    await expect(page.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.goBack();
    await page.waitForURL(/\/c\//);
    await expect(rail).toHaveAttribute('aria-pressed', 'true');
    await expect(filter.first()).toBeVisible();
  });
});
