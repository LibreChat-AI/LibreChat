import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * The thread rows the message list renders from `@librechat/chat`: the sibling switch of a
 * branched reply, the subagent activity group anchored after the reply that launched it, and the
 * group stepping aside while its turn is edited. The sibling switch runs through both renderers.
 */

const ROOT = '00000000-0000-0000-0000-000000000000';
const SUBAGENT_ACTIVITY_MARKER = 'E2E_SUBAGENT_ACTIVITY:';

const messageRow = (page: Page, text: string): Locator =>
  messagesView(page).locator('.message-render').filter({ hasText: text }).last();

const siblingCounter = (row: Locator): Locator => row.locator('nav [role="status"]');

async function clickSibling(row: Locator, direction: 'Previous' | 'Next') {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole('button', { name: `${direction} sibling message` }).click();
}

/** A question with two replies, the newer one last. */
async function seedBranchedChat(label: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: `Branched ${label}`, updatedAt: new Date() },
  ]);
  const question = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: question,
      parentMessageId: ROOT,
      text: `Question ${label}`,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: question,
      text: `Older reply ${label}`,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
    {
      messageId: randomUUID(),
      parentMessageId: question,
      text: `Newer reply ${label}`,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

async function expectSiblingSwitch(page: Page, label: string) {
  const newer = messageRow(page, `Newer reply ${label}`);
  await expect(newer).toBeVisible({ timeout: 15_000 });
  await expect(siblingCounter(newer)).toHaveText('2 / 2');
  await expect(messagesView(page).getByText(`Older reply ${label}`)).toHaveCount(0);

  await clickSibling(newer, 'Previous');
  const older = messageRow(page, `Older reply ${label}`);
  await expect(older).toBeVisible();
  await expect(siblingCounter(older)).toHaveText('1 / 2');
  await expect(messagesView(page).getByText(`Newer reply ${label}`)).toHaveCount(0);
  await expect(older.getByRole('button', { name: 'Previous sibling message' })).toBeDisabled();

  await clickSibling(older, 'Next');
  await expect(messageRow(page, `Newer reply ${label}`)).toBeVisible();
  await expect(siblingCounter(messageRow(page, `Newer reply ${label}`))).toHaveText('2 / 2');
  await expect(messagesView(page).getByText(`Question ${label}`)).toBeVisible();
}

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of the thread rows.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      subagents,
    },
  });
}

/** Runs a turn on a parent agent that launches two detached children, and returns the agents to clean up. */
async function runActivityTurn(page: Page, label: string): Promise<string[]> {
  const createdAgentIds: string[] = [];
  await page.goto('/c/new', { timeout: 10_000 });
  const token = await getAccessToken(page);
  const children: AgentDetail[] = [];
  for (const childName of [
    uniqueAgentName('E2E Rows Child A'),
    uniqueAgentName('E2E Rows Child B'),
  ]) {
    const child = await createAgent(page, token, childName);
    children.push(child);
    createdAgentIds.push(child.id);
  }
  const parentName = uniqueAgentName('E2E Rows Parent');
  const parent = await createAgent(page, token, parentName, {
    enabled: true,
    allowSelf: false,
    agent_ids: children.map((child) => child.id),
  });
  createdAgentIds.push(parent.id);

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: parentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(parentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();

  const response = await sendMessageAndWaitForCompletion(
    page,
    `${SUBAGENT_ACTIVITY_MARKER}${children.map((child) => child.id).join(',')}:${label}`,
  );
  expect(response.ok()).toBeTruthy();
  await expect(activityGroup(page)).toBeVisible({ timeout: 30_000 });
  return createdAgentIds;
}

const activityGroup = (page: Page): Locator =>
  messagesView(page).getByRole('button', { name: 'Ran 2 agents' });

async function cleanupAgents(page: Page, agentIds: string[]) {
  for (const agentId of agentIds) {
    await cleanupAgent(page, agentId);
  }
}

test.describe('thread rows', () => {
  let conversationId: string | undefined;

  test.afterEach(async () => {
    if (!conversationId) {
      return;
    }
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
    conversationId = undefined;
  });

  test('a branched reply switches siblings with both arrows and the counter @scenario:thread-sibling-switch', async ({
    page,
  }) => {
    const label = `siblings-${Date.now().toString(36)}`;
    conversationId = await seedBranchedChat(label);
    await page.goto(`/c/${conversationId}`, { timeout: 15_000 });
    await expectSiblingSwitch(page, label);
  });

  test('the recursive renderer switches siblings the same way @scenario:thread-sibling-switch-recursive', async ({
    page,
  }) => {
    const label = `siblings-tree-${Date.now().toString(36)}`;
    conversationId = await seedBranchedChat(label);
    await page.addInitScript(() => {
      localStorage.setItem('LC_FLAT_THREAD', 'false');
    });
    await page.goto(`/c/${conversationId}`, { timeout: 15_000 });
    await expectSiblingSwitch(page, label);
  });

  test('subagent activity sits after the reply that launched it, ahead of the next turn @scenario:thread-activity-under-parent', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = `rows-anchor-${Date.now().toString(36)}`;
    const agentIds = await runActivityTurn(page, label);
    try {
      const next = `next-${label}`;
      const response = await sendMessageAndWaitForCompletion(page, replyPrompt(next));
      expect(response.ok()).toBeTruthy();
      await expect(messagesView(page).getByText(replyText(next))).toBeVisible({ timeout: 30_000 });
      await expect(activityGroup(page)).toHaveCount(1);

      const order = await page.evaluate((nextPrompt) => {
        const view = document.querySelector('[data-testid="messages-view"]');
        const rows = Array.from(view?.querySelectorAll('.message-render') ?? []);
        const group = Array.from(view?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent?.trim() === 'Ran 2 agents',
        );
        const nextUser = rows.find((row) => row.textContent?.includes(nextPrompt));
        if (!group || !nextUser) {
          return null;
        }
        const before = rows.filter(
          (row) => row.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).length;
        return {
          rowsBefore: before,
          precedesNextTurn: Boolean(
            group.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        };
      }, replyPrompt(next));
      expect(order).toEqual({ rowsBefore: 2, precedesNextTurn: true });
    } finally {
      await cleanupAgents(page, agentIds);
    }
  });

  test('editing the turn hides its activity group and cancelling restores it @scenario:thread-edit-hides-activity', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = `rows-edit-${Date.now().toString(36)}`;
    const agentIds = await runActivityTurn(page, label);
    try {
      const question = messageRow(page, SUBAGENT_ACTIVITY_MARKER);
      await question.scrollIntoViewIfNeeded();
      await question.hover();
      await question.getByRole('button', { name: 'Edit', exact: true }).last().click();
      const editor = messagesView(page).getByRole('region', { name: 'Edit message' });
      await expect(editor).toBeVisible();
      await expect(activityGroup(page)).toHaveCount(0);

      await editor.getByRole('button', { name: 'Cancel' }).click();
      await expect(editor).toHaveCount(0);
      await expect(activityGroup(page)).toBeVisible();
    } finally {
      await cleanupAgents(page, agentIds);
    }
  });
});
