import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  replyPrompt,
  replyText,
  sendMessageAndWaitForCompletion,
  messagesView,
} from '../helpers';

/**
 * Every action's domain is checked against the admin allow list when an agent
 * loads its tools. Those checks now run together instead of one after another;
 * this proves an agent holding several allowed actions still loads all of them
 * and answers.
 */

const DOMAINS = ['https://example.com', 'https://example.org'];

const specFor = (domain: string, operationId: string) =>
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: `E2E ${operationId}`, version: '1.0.0' },
    servers: [{ url: domain }],
    paths: {
      '/widgets': {
        get: { operationId, responses: { '200': { description: 'ok' } } },
      },
    },
  });

type CreatedAgent = { id: string };
type StoredAgent = { tools?: string[] };

async function addAction(page: Page, agentId: string, domain: string, operationId: string) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/agents/actions/${encodeURIComponent(agentId)}`,
    token,
    method: 'POST',
    body: {
      functions: [
        { type: 'function', function: { name: operationId, parameters: { type: 'object' } } },
      ],
      metadata: { domain, raw_spec: specFor(domain, operationId) },
    },
  });
}

test.describe('agent actions domain checks', () => {
  test('an agent with several allowed actions loads them all and answers @scenario:agent-with-several-actions-still-runs-allowed-actions', async ({
    page,
  }) => {
    test.setTimeout(120000);
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);
      const agent = await requestJson<CreatedAgent>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: uniqueAgentName('E2E Actions Domains'),
          instructions: 'Answer with the mock model.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
        },
      });
      agentId = agent.id;
      await addAction(page, agentId, DOMAINS[0], 'e2eDomainsListA');
      await addAction(page, agentId, DOMAINS[1], 'e2eDomainsListB');

      const stored = await fetchJson<StoredAgent>(
        page,
        `/api/agents/${encodeURIComponent(agentId)}/expanded`,
        token,
      );
      expect(stored.tools?.filter((name) => name.includes('_action_'))).toHaveLength(2);

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      await sendMessageAndWaitForCompletion(page, replyPrompt('actions-domains'));
      await expect(messagesView(page).getByText(replyText('actions-domains'))).toBeVisible();

      /** The model must be offered both actions, not just a reply from an agent that lost them. */
      await sendMessageAndWaitForCompletion(page, `E2E_REPORT_TOOLS ${Date.now()}`);
      const report = messagesView(page)
        .getByText(/E2E tools: /)
        .last();
      await expect(report).toBeVisible({ timeout: 15000 });
      const text = (await report.textContent()) ?? '';
      const offered = JSON.parse(text.slice(text.indexOf('['))) as string[];
      for (const operationId of ['e2eDomainsListA', 'e2eDomainsListB']) {
        expect(offered.filter((name) => name.startsWith(`${operationId}_action_`))).toHaveLength(1);
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
