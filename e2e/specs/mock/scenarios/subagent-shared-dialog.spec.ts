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

const RESULT_MARKER = 'E2E_SUBAGENT_RESULT:';
const CARD = '[data-subagent-tool-call^="call_e2e_subagent_"]';

/**
 * A public share opens a child run in the read-only activity dialog. The share page gives each
 * message's context the shared conversation id, so the card has the parent it needs to open on, and
 * the dialog draws only from the payload the share route already returned. The reader makes no
 * request for the private child thread, and none keyed by the share's conversation id.
 */
test('a shared link opens a child run in the read-only dialog and reads no private thread @scenario:shared-subagent-card-opens-activity', async ({
  page,
  browser,
  baseURL,
  viewport,
  isMobile,
  hasTouch,
  colorScheme,
}) => {
  test.setTimeout(120_000);
  const label = `shared-${Date.now().toString(36)}`;
  const childName = uniqueAgentName('E2E Shared Child');
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
    const child = await createAgent(childName);
    createdAgentIds.push(child.id);
    const parent = await createAgent(parentName, {
      enabled: true,
      allowSelf: false,
      agent_ids: [child.id],
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
      `${RESULT_MARKER}${child.id}:${label}`,
    );
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
    const conversationId = new URL(page.url()).pathname.split('/').pop();
    await expect(page.locator(CARD)).toHaveCount(1, { timeout: 30_000 });

    const shared = await page.request.post(`/api/share/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(shared.ok()).toBeTruthy();
    const { shareId } = (await shared.json()) as { shareId?: string };
    expect(shareId).toBeTruthy();

    /** The reader takes the project's device and color scheme, but not its login. */
    const reader = await browser.newContext({ baseURL, viewport, isMobile, hasTouch, colorScheme });
    try {
      const readerPage = await reader.newPage();
      const result = `E2E subagent streamed result ${label}`;
      const payload = await readerPage.request.get(`/api/share/${shareId}`);
      expect(payload.ok()).toBeTruthy();
      const shared = (await payload.json()) as { messages?: Array<{ conversationId?: string }> };
      /** What the dialog shows is already in the payload the share route returns to any reader. */
      expect(JSON.stringify(shared)).toContain(result);
      const sharedConversationId = shared.messages?.[0]?.conversationId ?? '';
      expect(sharedConversationId).not.toBe('');

      /** The reader never asks for the private child thread, or for anything under the share's
       *  conversation id. */
      const privateReads: string[] = [];
      readerPage.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (
          /\/api\/convos\/[^/]+\/subagents\//.test(pathname) ||
          pathname.includes(sharedConversationId)
        ) {
          privateReads.push(pathname);
        }
      });
      await readerPage.goto(`/share/${shareId}`);
      const card = readerPage.locator(CARD).first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toBeEnabled();
      await expect(readerPage.getByRole('dialog')).toHaveCount(0);

      await card.click();
      const dialog = readerPage.getByRole('dialog');
      await expect(dialog).toContainText(result);

      await readerPage.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
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
