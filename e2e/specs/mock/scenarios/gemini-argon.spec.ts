import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  escapeRegExp,
  messagesView,
  modelSelectorTrigger,
  NEW_CHAT_PATH,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { withMongo } from '../db';
import { closeMobileDrawer } from '../agents.helpers';
import { openPanel } from './panels';

const ARGON = 'gemini-4-argon';
const PRE_ARGON = 'gemini-2.5-pro';

/** The shared helper treats the model submenu as optional; here the model is the subject. */
async function selectGeminiModel(page: Page, model: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: 'Mock Gemini' }).click();
  /** On mobile the option's accessible name also carries its pin button. */
  const option = page.getByRole('option', { name: new RegExp(`^${escapeRegExp(model)}( Pin)?$`) });
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
}

type LlmConfigReport = {
  model: string | null;
  sampling: string[];
  reasoningEffort: string | null;
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

/** Moves the Parameters panel's Thinking Level slider to its last step, High, as a keyboard user does. */
async function chooseHighThinkingLevel(page: Page) {
  await openPanel(page, 'parameters', 'Parameters');
  const reasoning = page.getByRole('region', { name: 'Reasoning' });
  const slider = reasoning.getByRole('slider', { name: 'Thinking Level' });
  await slider.focus();
  await slider.press('End');
  await expect(reasoning.getByRole('textbox', { name: 'Thinking Level' })).toHaveValue('High');
  await closeMobileDrawer(page);
}

function conversationIdOf(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/c\/([^/]+)\/?$/);
  expect(match?.[1], 'conversation should have a persisted id').toBeTruthy();
  return decodeURIComponent(match![1]);
}

test('Gemini 4 Argon on a Gemini gateway sends no ignored sampling params @scenario:argon-on-a-gemini-gateway-sends-no-ignored-sampling-params', async ({
  page,
}) => {
  await selectGeminiModel(page, PRE_ARGON);
  const control = await reportLlmConfig(page);
  /** The endpoint's addParams reach older Gemini models, so an empty list for Argon is the rule. */
  expect(control.model).toBe('gemini-2.5-pro');
  expect(control.sampling).toEqual(
    expect.arrayContaining(['temperature', 'topP', 'presencePenalty']),
  );

  await selectGeminiModel(page, ARGON);
  const argon = await reportLlmConfig(page);
  expect(argon.model).toBe('gemini-4-argon');
  expect(argon.sampling).toEqual([]);
  expect(argon.maxContextTokens ?? 0).toBeGreaterThan(0);
});

test('A thinking level chosen for Gemini 4 Argon reaches the gateway as reasoning_effort @scenario:argon-gateway-receives-the-chosen-thinking-level', async ({
  page,
}) => {
  await selectGeminiModel(page, ARGON);
  await chooseHighThinkingLevel(page);
  const argon = await reportLlmConfig(page);

  expect(argon.model).toBe('gemini-4-argon');
  expect(argon.reasoningEffort).toBe('high');
});

test('A Gemini 4 Argon turn left on Auto thinking sends no reasoning_effort @scenario:argon-gateway-sends-no-effort-on-auto-thinking', async ({
  page,
}) => {
  await selectGeminiModel(page, ARGON);
  const argon = await reportLlmConfig(page);

  /** Argon fills in its own default level for the request; the gateway should still pick its default. */
  expect(argon.model).toBe('gemini-4-argon');
  expect(argon.reasoningEffort).toBeNull();
});

test('A Gemini 4 Argon turn is billed at Argon rates @scenario:an-argon-turn-is-billed-at-argon-rates', async ({
  page,
}) => {
  await selectGeminiModel(page, ARGON);
  await sendMessageAndWaitForCompletion(page, `Argon billing ${Date.now()}`);
  const conversationId = conversationIdOf(page);

  await expect
    .poll(
      () =>
        withMongo(async (db) => {
          const rows = await db
            .collection('transactions')
            .find({ conversationId })
            .project({ model: 1, tokenType: 1, rate: 1, _id: 0 })
            .toArray();
          /** Keyed by model so a turn billed under another model fails with its name. */
          const rates: Record<string, number> = {};
          for (const row of rows) {
            rates[`${row.model}:${row.tokenType}`] = row.rate as number;
          }
          return rates;
        }),
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toEqual({ 'gemini-4-argon:prompt': 2, 'gemini-4-argon:completion': 10 });
});
