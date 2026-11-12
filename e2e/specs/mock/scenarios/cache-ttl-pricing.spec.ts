import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/** `mock-model-a` has no price table, so its prompt costs the default rate (6 per
 *  million), its 5-minute writes fall back to that input rate, and its 1-hour writes
 *  cost twice the prompt rate, as Anthropic bills them. */
const DEFAULT_RATE = 6;
const WRITE_5M = DEFAULT_RATE;
const WRITE_1H = DEFAULT_RATE * 2;
/** The fake model reports 2000 of its cache writes as 1-hour for `E2E_CACHE_USAGE: 1h` */
const ONE_HOUR_WRITES = 2000;

/** The persisted cost of the reply to `text`, sent in a new chat */
async function replyCost(page: Page, text: string): Promise<number> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, text);
  const { conversationId } = (await response.json()) as { conversationId: string };
  const token = await getAccessToken(page);
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  );
  const reply = messages.find((message) => !message.isCreatedByUser);
  const usage = (reply?.metadata as { usage?: { cost?: number; cacheWrite?: number } } | undefined)
    ?.usage;
  expect(usage?.cacheWrite).toBe(3000);
  expect(typeof usage?.cost).toBe('number');
  return usage?.cost as number;
}

test.describe('Prompt cache write pricing', () => {
  test('1-hour cache writes cost the 1-hour rate, the rest of the call unchanged @scenario:cache-1h-writes-priced-at-1h-rate', async ({
    page,
  }) => {
    const fiveMinute = await replyCost(page, 'E2E_CACHE_USAGE: 5m price check');
    const oneHour = await replyCost(page, 'E2E_CACHE_USAGE: 1h price check');

    expect(oneHour - fiveMinute).toBeCloseTo((ONE_HOUR_WRITES * (WRITE_1H - WRITE_5M)) / 1e6, 9);
  });
});
