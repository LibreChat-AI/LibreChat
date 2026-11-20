import { expect, test } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';

/** Twelve own agents reproduces the design review's fixture: the cap lists ten
 * and the cut hides two. The first-created name carries the oldest updatedAt,
 * so it is the one that ranks past the cut. */
const AGENT_COUNT = 12;

const createAgent = async (page: Parameters<typeof getAccessToken>[0], name: string) => {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Agent selector cap acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
};

async function createCappedAgents(page: Parameters<typeof getAccessToken>[0]) {
  const stamp = uniqueAgentName('E2E SelCap');
  const names = Array.from(
    { length: AGENT_COUNT },
    (_, index) => `${stamp} ${String(index + 1).padStart(2, '0')}`,
  );
  const created: AgentDetail[] = [];
  for (const name of names) {
    created.push(await createAgent(page, name));
  }
  return { names, created };
}

async function openSelector(page: Parameters<typeof openAgentBuilder>[0]) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('agent selector caps', () => {
  test('selector lists at most ten own agents unsearched @scenario:agent-selector-caps-unsearched-list', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const ids: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const { names, created } = await createCappedAgents(page);
      ids.push(...created.map((agent) => agent.id));

      await openSelector(page);
      await expect(page.getByRole('option').first()).toHaveAttribute('aria-setsize', '10');
      await expect(page.getByRole('option')).toHaveCount(10);
      await expect(page.getByRole('option', { name: names[0], exact: true })).toBeHidden();
    } finally {
      for (const id of ids) {
        await cleanupAgent(page, id);
      }
    }
  });

  test('searching reaches an agent past the cut and selects it @scenario:agent-selector-search-reaches-agents-past-cut', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const ids: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const { names, created } = await createCappedAgents(page);
      ids.push(...created.map((agent) => agent.id));

      const dialog = await openSelector(page);
      await dialog.getByRole('combobox', { name: 'Search agents by name' }).fill(names[0]);
      const pastCut = page.getByRole('option', { name: names[0], exact: true });
      await expect(pastCut).toBeVisible();
      await pastCut.click();
      await expect(page.getByLabel('Agent name')).toHaveValue(names[0]);
    } finally {
      for (const id of ids) {
        await cleanupAgent(page, id);
      }
    }
  });

  test('a selected agent past the cut stays listed and marked selected @scenario:agent-selector-keeps-selected-agent-past-cut', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const ids: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const { names, created } = await createCappedAgents(page);
      ids.push(...created.map((agent) => agent.id));

      const dialog = await openSelector(page);
      await dialog.getByRole('combobox', { name: 'Search agents by name' }).fill(names[0]);
      await page.getByRole('option', { name: names[0], exact: true }).click();
      await expect(page.getByLabel('Agent name')).toHaveValue(names[0]);

      /** Reopening resets the search, so the capped list is back: the selected
       * agent must have taken a slot instead of vanishing behind the cut. */
      const form = page.getByRole('form', { name: 'Agent configuration form' });
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      const reopened = page.getByRole('dialog', { name: 'Agent', exact: true });
      await expect(reopened).toBeVisible();
      await expect(page.getByRole('option').first()).toHaveAttribute('aria-setsize', '10');
      const selected = page.getByRole('option', { name: names[0], exact: true });
      await expect(selected).toBeVisible();
      await expect(selected).toHaveAttribute('aria-selected', 'true');
    } finally {
      for (const id of ids) {
        await cleanupAgent(page, id);
      }
    }
  });

  test('popover never exceeds the viewport on a short screen @scenario:agent-selector-popover-fits-short-viewport', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const ids: string[] = [];
    try {
      await page.setViewportSize({ width: 1280, height: 420 });
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const { created } = await createCappedAgents(page);
      ids.push(...created.map((agent) => agent.id));

      const dialog = await openSelector(page);
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      /** 480px of popover cannot fit 420px of viewport; the cap must yield to
       * the available height instead of pushing lower options offscreen. */
      expect(box!.y + box!.height).toBeLessThanOrEqual(421);
      await expect(page.getByRole('option').first()).toBeVisible();
    } finally {
      for (const id of ids) {
        await cleanupAgent(page, id);
      }
    }
  });
});
