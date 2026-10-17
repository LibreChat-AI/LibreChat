import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  messagesView,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { withMongo } from '../db';

const ARGON = { label: 'Mock Gemini', model: 'gemini-4-argon' };
const PRE_ARGON = { label: 'Mock Gemini', model: 'gemini-2.5-pro' };

type LlmConfigReport = {
  model: string | null;
  sampling: string[];
  maxContextTokens: number | null;
};

async function reportLlmConfig(page: Page): Promise<LlmConfigReport> {
  await sendMessageAndWaitForCompletion(page, `E2E_REPORT_LLM_CONFIG ${Date.now()}`);
  const reply = messagesView(page)
    .getByText(/E2E llm config: /)
    .last();
  await expect(reply).toBeVisible({ timeout: 15000 });
  const text = (await reply.textContent()) ?? '';
  return JSON.parse(text.slice(text.indexOf('{'))) as LlmConfigReport;
}

function conversationIdOf(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/c\/([^/]+)\/?$/);
  expect(match?.[1], 'conversation should have a persisted id').toBeTruthy();
  return decodeURIComponent(match![1]);
}

test('Gemini 4 Argon on a Gemini gateway sends no ignored sampling params @scenario:argon-on-a-gemini-gateway-sends-no-ignored-sampling-params', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, PRE_ARGON);
  const control = await reportLlmConfig(page);
  /** The endpoint's addParams reach older Gemini models, so an empty list for Argon is the rule. */
  expect(control.model).toBe('gemini-2.5-pro');
  expect(control.sampling).toEqual(
    expect.arrayContaining(['temperature', 'topP', 'presencePenalty']),
  );

  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, ARGON);
  const argon = await reportLlmConfig(page);
  expect(argon.model).toBe('gemini-4-argon');
  expect(argon.sampling).toEqual([]);
  expect(argon.maxContextTokens ?? 0).toBeGreaterThan(0);
});

test('A Gemini 4 Argon turn is billed at Argon rates @scenario:an-argon-turn-is-billed-at-argon-rates', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, ARGON);
  await sendMessageAndWaitForCompletion(page, `Argon billing ${Date.now()}`);
  const conversationId = conversationIdOf(page);

  await expect
    .poll(
      () =>
        withMongo(async (db) => {
          const rows = await db
            .collection('transactions')
            .find({ conversationId, model: 'gemini-4-argon' })
            .project({ tokenType: 1, rate: 1, _id: 0 })
            .toArray();
          const rates: Record<string, number> = {};
          for (const row of rows) {
            rates[row.tokenType as string] = row.rate as number;
          }
          return rates;
        }),
      { timeout: 15000, intervals: [250, 500, 1000] },
    )
    .toEqual({ prompt: 2, completion: 10 });
});
