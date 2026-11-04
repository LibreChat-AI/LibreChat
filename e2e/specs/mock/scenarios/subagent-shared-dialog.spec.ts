import { expect, test } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  cleanupAgent,
  uniqueAgentName,
  openAgentBuilder,
  closeMobileDrawer,
} from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  requestJson,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
const CARD = '[data-subagent-tool-call^="call_e2e_subagent_activity_"]';

/**
 * A public share has no panel and no access to the child thread, so the reader opens a child's
 * activity in a dialog, drawn from what the shared message already carries. This runs the real
 * chain: a real child run, a real link through the share API, and a reader in a browser context
 * of its own, with none of the owner's session.
 */
test('a shared link opens a child run in its activity dialog @scenario:shared-subagent-activity-opens-in-dialog', async ({
  page,
  browser,
  baseURL,
  viewport,
}) => {
  test.setTimeout(120_000);
  const label = `shared-${Date.now().toString(36)}`;
  const childNames = [uniqueAgentName('E2E Shared Child A'), uniqueAgentName('E2E Shared Child B')];
  const parentName = uniqueAgentName('E2E Shared Parent');
  const createdAgentIds: string[] = [];

  try {
    await page.goto('/c/new');
    const token = await getAccessToken(page);
    const createAgent = (name: string, subagents?: AgentDetail['subagents']) =>
      requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name,
          description: 'Playwright verification of shared child activity.',
          instructions: 'Follow the deterministic end-to-end request exactly.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          subagents,
        },
      });
    const children: AgentDetail[] = [];
    for (const name of childNames) {
      const child = await createAgent(name);
      children.push(child);
      createdAgentIds.push(child.id);
    }
    const parent = await createAgent(parentName, {
      enabled: true,
      allowSelf: false,
      agent_ids: children.map((child) => child.id),
    });
    createdAgentIds.push(parent.id);

    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parentName }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(parentName);
    await form.getByRole('button', { name: 'Select Agent' }).click();
    await closeMobileDrawer(page);

    const response = await sendMessageAndWaitForCompletion(
      page,
      `${ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
    );
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
    const conversationId = new URL(page.url()).pathname.split('/').pop();
    await page.getByRole('button', { name: 'Ran 2 agents' }).click();
    await expect(page.locator(CARD)).toHaveCount(2, { timeout: 30_000 });

    const shared = await page.request.post(`/api/share/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(shared.ok()).toBeTruthy();
    const { shareId } = (await shared.json()) as { shareId?: string };
    expect(shareId).toBeTruthy();

    const reader = await browser.newContext({ baseURL, viewport });
    try {
      const readerPage = await reader.newPage();
      /** The dialog reads the shared payload, never the private child thread. */
      const privateReads: string[] = [];
      readerPage.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (/\/api\/convos\/[^/]+\/subagents\//.test(pathname)) privateReads.push(pathname);
      });
      await readerPage.goto(`/share/${shareId}`);
      await readerPage.getByRole('button', { name: 'Ran 2 agents' }).click();
      const card = readerPage.locator(CARD).first();
      await expect(card).toBeEnabled();
      await card.click();

      const dialog = readerPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: childNames[0] })).toBeVisible();
      await expect(dialog).toContainText(`E2E detached child 1 complete ${label}`);

      await readerPage.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(card).toBeFocused();
      expect(privateReads).toEqual([]);
    } finally {
      await reader.close();
    }
  } finally {
    for (const agentId of createdAgentIds.reverse()) {
      await cleanupAgent(page, agentId);
    }
  }
});
