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

interface BillingTransaction {
  tokenType: string;
  rate: number;
  rawAmount: number;
  tokenValue: number;
  inputTokens: number;
  writeTokens: number;
  readTokens: number;
}

async function expectConfiguredBilling(page: Page) {
  await sendMessageAndWaitForCompletion(page, 'E2E_CACHE_USAGE: 5m');
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  expect(conversationId).toBeTruthy();
  let transactions: BillingTransaction[] = [];
  await expect
    .poll(
      async () => {
        transactions = await withMongo((db) =>
          db
            .collection<BillingTransaction>('transactions')
            .find({ conversationId, model })
            .toArray(),
        );
        return transactions.map(({ tokenType }) => tokenType).sort();
      },
      { timeout: 30000 },
    )
    .toEqual(['completion', 'prompt']);

  const prompt = transactions.find(({ tokenType }) => tokenType === 'prompt');
  const completion = transactions.find(({ tokenType }) => tokenType === 'completion');
  if (!prompt || !completion) {
    throw new Error('Billing transactions missing');
  }
  expect(prompt).toMatchObject({ writeTokens: -3000, readTokens: -500 });
  expect(prompt.inputTokens).toBeLessThan(0);
  const expectedPromptValue =
    (prompt.inputTokens + prompt.writeTokens) * 1.23 + prompt.readTokens * 0.09;
  expect(prompt.tokenValue).toBeCloseTo(expectedPromptValue);
  expect(prompt.rate).toBeCloseTo(expectedPromptValue / prompt.rawAmount);
  expect(completion.rate).toBe(4.56);
  expect(completion.tokenValue).toBeCloseTo(completion.rawAmount * 4.56);
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
