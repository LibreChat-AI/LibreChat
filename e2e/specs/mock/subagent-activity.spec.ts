import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from './helpers';

const DETACHED_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
/** The activity hook's first reconnect is scheduled after 500 ms. */
const ACTIVITY_RECONNECT_GUARD_MS = 1_000;
const ACTIVITY_PATH = /\/api\/convos\/[^/]+\/subagents\/[^/]+\/tasks\/[^/]+\/activity$/;

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of detached child activity.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      subagents,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test.describe('detached subagent activity', () => {
  test('streams two child runs into the shared panel and restores terminal activity', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `activity-${Date.now().toString(36)}`;
    const childNames = [
      uniqueAgentName('E2E Activity Child A'),
      uniqueAgentName('E2E Activity Child B'),
    ];
    const parentName = uniqueAgentName('E2E Activity Parent');
    const createdAgentIds: string[] = [];
    const activityRequests: string[] = [];
    const finishedActivityRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (ACTIVITY_PATH.test(url.pathname)) {
        activityRequests.push(url.pathname);
      }
    });
    page.on('requestfinished', (request) => {
      const url = new URL(request.url());
      if (ACTIVITY_PATH.test(url.pathname)) {
        finishedActivityRequests.push(url.pathname);
      }
    });

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const children: AgentDetail[] = [];
      for (const childName of childNames) {
        const child = await createAgent(page, token, childName);
        children.push(child);
        createdAgentIds.push(child.id);
      }
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      });
      createdAgentIds.push(parent.id);

      await selectAgent(page, parentName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `${DETACHED_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
      await expect(cards).toHaveCount(2, { timeout: 30_000 });
      await expect(cards.first()).toHaveAttribute('data-subagent-thread', /.+/);
      const activityResponsePromise = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return ACTIVITY_PATH.test(url.pathname);
      });
      await cards.first().click();

      const panel = page.getByRole('region', { name: 'Child agent activity' });
      const activityResponse = await activityResponsePromise;
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('child-1-phase-10');
      await expect(panel.getByText('Running', { exact: true })).toHaveCount(0);
      await expect.poll(() => activityRequests.length).toBe(1);

      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);
      await expect.poll(() => finishedActivityRequests.length).toBe(1);
      const activityStreamBody = await activityResponse.text();
      expect(activityStreamBody).toContain('"event":"on_subagent_update"');
      expect(activityStreamBody).toContain('"phase":"message_delta"');
      await page.waitForTimeout(ACTIVITY_RECONNECT_GUARD_MS);
      expect(activityRequests).toHaveLength(1);

      await panel.getByRole('button', { name: 'Close' }).click();
      await expect(panel).not.toBeVisible();
      await cards.nth(1).click();
      await expect(panel).toContainText(`E2E detached child 2 complete ${label}`, {
        timeout: 30_000,
      });
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Close' }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Ran 2 agents' }).click();
      const restoredCards = page.locator(
        '[data-subagent-tool-call^="call_e2e_subagent_activity_"]',
      );
      await expect(restoredCards).toHaveCount(2);
      await restoredCards.first().click();
      await expect(panel).toContainText(`E2E detached child 1 complete ${label}`);
      await expect(panel.getByText('Completed', { exact: true })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Chat History' }).click();
      const conversationRows = page.getByTestId('convo-item');
      await expect(conversationRows.locator('button[aria-current="page"]')).toBeVisible();
      for (const child of children) {
        await expect(conversationRows.filter({ hasText: `Subagent: ${child.id}` })).toHaveCount(0);
      }
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });
});
