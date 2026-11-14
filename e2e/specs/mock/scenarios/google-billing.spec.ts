import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  fetchJson,
  getAccessToken,
  NEW_CHAT_PATH,
  requestJson,
  selectModelSpec,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import { withMongo } from '../db';

const model = 'gemini-2.5-flash';

async function expectConfiguredBilling(page: Page) {
  await sendMessageAndWaitForCompletion(page, 'E2E_CACHE_USAGE: 5m');
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  expect(conversationId).toBeTruthy();
  await expect
    .poll(
      () =>
        withMongo(async (db) => {
          const rows = await db
            .collection('transactions')
            .find({ conversationId, model })
            .toArray();
          return rows.map(({ tokenType, rate, rateDetail }) => ({ tokenType, rate, rateDetail }));
        }),
      { timeout: 30000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tokenType: 'prompt',
          rateDetail: expect.objectContaining({ input: 1.23, read: 0.09 }),
        }),
        expect.objectContaining({ tokenType: 'completion', rate: 4.56 }),
      ]),
    );
}

test('Native Google chat uses configured billing rates @scenario:google-chat-configured-billing', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const config = await fetchJson<Record<string, Record<string, object>>>(
    page,
    '/api/endpoints/token-config',
    token,
  );
  expect(config.google[model]).toMatchObject({ prompt: 1.23, completion: 4.56, cacheRead: 0.09 });
  await selectModelSpec(page, 'Google Billing Fixture');
  await expectConfiguredBilling(page);
});

test('Saved Google Agents use configured billing rates @scenario:google-agent-configured-billing', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('Google billing'),
      provider: 'google',
      model,
      instructions: 'Respond briefly.',
      model_parameters: {},
    },
  });
  try {
    await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agent.id)}`);
    await expectConfiguredBilling(page);
  } finally {
    await cleanupAgent(page, agent.id);
  }
});
