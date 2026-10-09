import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../mock/agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../mock/agents.helpers';
import { fetchJson, getAccessToken, messagesView, requestJson, sendMessage } from '../mock/helpers';

const REAL_MODEL = process.env.E2E_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

type PersistedMessage = {
  content?: Array<{
    type?: string;
    tool_call?: { name?: string };
  }>;
};

async function createAgent(
  page: Page,
  token: string,
  body: {
    name: string;
    description: string;
    instructions: string;
    subagents?: AgentDetail['subagents'];
  },
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      ...body,
      provider: 'anthropic',
      model: REAL_MODEL,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function readMessages(page: Page, conversationId: string): Promise<PersistedMessage[]> {
  const token = await getAccessToken(page);
  return fetchJson<PersistedMessage[]>(page, `/api/messages/${conversationId}`, token);
}

test.describe('isolated subagent results with a real provider', () => {
  test('delegates and renders the child final answer', async ({ page }) => {
    test.setTimeout(240_000);
    const leftOperand = 48_723;
    const rightOperand = 19_642;
    const expectedResult = String(leftOperand + rightOperand);
    const childName = uniqueAgentName('Real Child');
    const parentName = uniqueAgentName('Real Parent');
    let childId: string | undefined;
    let parentId: string | undefined;

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, {
        name: childName,
        description: 'Solves arithmetic requests delegated by a parent agent.',
        instructions:
          'You are an arithmetic specialist. Add the requested integers and reply with only the ' +
          'decimal result, without punctuation or explanation.',
      });
      childId = child.id;
      const parent = await createAgent(page, token, {
        name: parentName,
        description: 'Delegates arithmetic requests to one isolated child.',
        instructions:
          'Always use the subagent tool for every user request. Never answer from your own ' +
          'knowledge. After the child finishes, return its answer verbatim with no added text.',
        subagents: {
          enabled: true,
          allowSelf: false,
          agent_ids: [child.id],
        },
      });
      parentId = parent.id;

      await selectAgent(page, parentName);
      const response = await sendMessage(
        page,
        `Ask the configured child to calculate ${leftOperand} + ${rightOperand}. Return only the ` +
          'integer it provides.',
      );
      expect(response.ok()).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 180_000,
      });
      const finalAnswer = messagesView(page)
        .locator('.message-render')
        .last()
        .getByRole('paragraph')
        .filter({ hasText: expectedResult });
      await expect(finalAnswer).toHaveText(expectedResult, { timeout: 30_000 });
      await expect(messagesView(page).getByText('Task completed', { exact: true })).toHaveCount(0);

      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 30_000 });
      const conversationId = new URL(page.url()).pathname.split('/c/')[1];
      expect(conversationId).toBeTruthy();
      let messages: PersistedMessage[] = [];
      await expect
        .poll(
          async () => {
            messages = await readMessages(page, conversationId);
            return messages.some((message) =>
              (message.content ?? []).some(
                (part) => part.type === 'tool_call' && part.tool_call?.name === 'subagent',
              ),
            );
          },
          { timeout: 30_000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);
    } finally {
      await cleanupAgent(page, parentId);
      await cleanupAgent(page, childId);
    }
  });
});
