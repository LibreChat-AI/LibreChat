import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, uniqueAgentName, waitForPersistedAgent } from '../agents.helpers';
import { getAccessToken, MOCK_ENDPOINTS, NEW_CHAT_PATH, requestJson } from '../helpers';

/**
 * The open agent dialog revalidates its agent when the window regains focus. When the fresh
 * record drops the conversation starter the reader is on, the dialog hands focus to its title
 * instead of letting it fall to the page behind the modal.
 */
const STARTERS = ['Summarize the latest release', 'Draft a changelog entry'];

async function createAgent(page: Page, token: string) {
  const name = uniqueAgentName('E2E Focus Handoff');
  const description = 'An agent whose conversation starters change while its dialog is open.';
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description,
      instructions: 'Use the mock model and answer deterministically for this scenario.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
      conversation_starters: STARTERS,
      category: 'general',
    },
  });
  await waitForPersistedAgent(page, name, description);
  return { id: agent.id, name };
}

/** What a reader switching back to the window does: the query client revalidates on focus. */
async function returnToWindow(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

test.describe('agent detail focus handoff', () => {
  test('a refresh that removes the focused starter hands focus to the dialog title @scenario:agent-detail-refresh-hands-focus-to-title', async ({
    page,
  }) => {
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      const agent = await createAgent(page, token);
      agentId = agent.id;

      await page.goto(`/agents/all?q=${encodeURIComponent(agent.name)}`, { timeout: 10000 });
      const trigger = page.getByRole('button', { name: agent.name, exact: true });
      await expect(trigger).toBeVisible({ timeout: 30000 });
      await trigger.focus();
      await trigger.press('Enter');

      const dialog = page.getByRole('dialog');
      const title = dialog.getByRole('heading', { name: agent.name, exact: true });
      await expect(title).toBeFocused();

      const starter = dialog.getByRole('button', { name: STARTERS[0] });
      await expect(starter).toBeVisible();
      for (let step = 0; step < 20; step++) {
        if (await starter.evaluate((node) => node === document.activeElement)) {
          break;
        }
        await page.keyboard.press('Tab');
      }
      await expect(starter).toBeFocused();

      const refreshed = page.waitForResponse(async (response) => {
        if (
          response.request().method() !== 'GET' ||
          !response.url().includes(`/api/agents/${agent.id}`) ||
          !response.ok()
        ) {
          return false;
        }
        const body = (await response.json()) as { conversation_starters?: string[] };
        return (body.conversation_starters ?? []).length === 0;
      });
      await requestJson(page, {
        path: `/api/agents/${encodeURIComponent(agent.id)}`,
        token,
        method: 'PATCH',
        body: { conversation_starters: [] },
      });
      await returnToWindow(page);
      await refreshed;

      await expect(dialog.getByRole('button', { name: STARTERS[0] })).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(title).toBeFocused();
      await expect(title).toBeVisible();
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

      /* Keyboard navigation continues from the title into the dialog's remaining controls. */
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
