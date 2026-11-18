import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  selectModelSpec,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, closeMobileDrawer, uniqueAgentName } from '../agents.helpers';
import { openPanel } from './panels';

async function expectHydrogenConfig(page: Page, thinkingLevel: string) {
  await sendMessageAndWaitForCompletion(page, `E2E_REPORT_LLM_CONFIG ${Date.now()}`);
  const reply = messagesView(page)
    .getByText(/E2E llm config: /)
    .last();
  await expect(reply).toBeVisible();
  const text = (await reply.textContent()) ?? '';
  const config = JSON.parse(text.slice(text.indexOf('{')));
  expect(config).toMatchObject({
    model: 'gemini-4-hydrogen',
    thinkingLevel,
    maxOutputTokens: 65536,
    sampling: [],
  });
  expect(config.maxContextTokens).toBeGreaterThan(32000);
  expect(config.maxContextTokens).toBeLessThanOrEqual(1048576 - 65536);
}

test('Hydrogen chat offers Extra High thinking and retains it after reload @scenario:hydrogen-chat-thinking-reload', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  await selectModelSpec(page, 'Hydrogen Fixture');
  await openPanel(page, 'parameters', 'Parameters');
  const reasoning = page.getByRole('region', { name: 'Reasoning' });
  const slider = reasoning.getByRole('slider', { name: 'Thinking Level' });
  await slider.focus();
  await slider.press('End');
  await expect(reasoning.getByRole('textbox', { name: 'Thinking Level' })).toHaveValue(
    'Extra High',
  );
  await closeMobileDrawer(page);
  await expectHydrogenConfig(page, 'XHIGH');
  await page.reload();
  await expectHydrogenConfig(page, 'XHIGH');
});

test('Saved Hydrogen Agents normalize legacy controls and preserve the shared context limit @scenario:hydrogen-agent-legacy-controls', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('Hydrogen'),
      provider: 'google',
      model: 'gemini-4-hydrogen',
      instructions: 'Respond briefly.',
      model_parameters: {
        thinkingLevel: 'minimal',
        thinkingBudget: 4096,
        temperature: 0.5,
        topP: 0.4,
        maxOutputTokens: 100000,
        maxContextTokens: 2000000,
      },
    },
  });
  try {
    await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agent.id)}`);
    await expectHydrogenConfig(page, 'LOW');
    await page.reload();
    await expectHydrogenConfig(page, 'LOW');
  } finally {
    await cleanupAgent(page, agent.id);
  }
});
