import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';

/**
 * An agent's model is checked against the model list of its own endpoint. The mock endpoints each
 * serve one fixed model, so a model outside that list is the refusal case, and a handoff target on
 * the second endpoint shows each connected agent being checked against its own list.
 */

const [PRIMARY, OTHER] = MOCK_ENDPOINTS;

const handoffMarker = (label: string, routes: unknown[]) =>
  `E2E_HANDOFF:${Buffer.from(JSON.stringify({ label, routes })).toString('base64url')}`;

async function createAgent(
  page: Page,
  token: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Agent model catalog acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: PRIMARY.label,
      model: PRIMARY.model,
      ...overrides,
    },
  });
}

test.describe('agent models', () => {
  test('an agent whose model its endpoint does not serve is refused and named @scenario:agent-on-an-unserved-model-is-refused', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const name = uniqueAgentName('E2E Unserved Model');
    const model = `mock-unserved-${Date.now()}`;
    const label = `unserved-${Date.now()}`;
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      const token = await getAccessToken(page);
      agentId = (await createAgent(page, token, name, { model })).id;

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${agentId}`, { timeout: 15_000 });
      await sendMessage(page, replyPrompt(label));

      await expect(
        messagesView(page).getByText(
          `The model "${model}" is not available for ${PRIMARY.label}. Please select a different model.`,
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(messagesView(page).getByText(replyText(label), { exact: true })).toHaveCount(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a handoff target on another endpoint is checked against its own endpoint and answers @scenario:handoff-target-on-another-endpoint-answers', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const targetName = uniqueAgentName('E2E Other Endpoint Target');
    const routerName = uniqueAgentName('E2E Other Endpoint Router');
    const label = `other-endpoint-${Date.now()}`;
    const payload = `receipt-${Date.now()}`;
    const description = 'Send the request to the specialist on the other endpoint.';
    const prompt = 'Pass the specialist the brief.';
    let targetId: string | undefined;
    let routerId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      const token = await getAccessToken(page);
      const target = await createAgent(page, token, targetName, {
        provider: OTHER.label,
        model: OTHER.model,
      });
      targetId = target.id;
      const router = await createAgent(page, token, routerName, {
        edges: [
          { from: '', to: target.id, edgeType: 'handoff', description, prompt, promptKey: 'brief' },
        ],
      });
      routerId = router.id;

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${router.id}`, { timeout: 15_000 });
      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: target.id,
            description,
            prompt,
            promptKey: 'brief',
            args: { brief: payload },
            receipt: payload,
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();

      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${target.id}; received=${payload}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${targetName}` }),
      ).toBeVisible();
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, targetId);
    }
  });
});
