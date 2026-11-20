import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import { APPROVAL_PROMPT_MARKER, createApprovalAgent } from '../approvals.helpers';

/**
 * A generation that pauses for the reader inside a side chat: the conversation a finished
 * subagent's thread is continued as, open beside the one it ran under. The pause is the
 * production one (the fake model stops a real agent run at the tool), and so are the card, the
 * resume request and the stream the rest of the reply arrives on.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const DISPATCH_MARKER = 'E2E_SUBAGENT_ACTIVITY:';
const ASK_MARKER = 'E2E_ASK_USER_QUESTION:';
const ASK_TOOL_ID = 'ask_user_question';

type ResumeBody = {
  conversationId?: string;
  actionId?: string;
  answers?: Record<string, string>;
  decisions?: Array<{ tool_call_id?: string; decision?: string }>;
};

const isResumeRequest = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/chat/resume';

async function createAgent(page: Page, name: string, extra: object = {}): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token: await getAccessToken(page),
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of a pause inside a side chat.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      ...extra,
    },
  });
}

/**
 * Runs a parent that dispatches `child` (and a second child the fixture requires), waits for
 * `child` to finish, and continues it from its panel with `text`. Returns the side chat it
 * opens as, and the conversation that side chat holds.
 */
async function continueBeside(
  page: Page,
  child: AgentDetail,
  label: string,
  text: string,
  createdAgentIds: string[],
): Promise<{ sideChat: Locator; conversationId: string }> {
  const other = await createAgent(page, uniqueAgentName('E2E Side Pause Other Child'));
  createdAgentIds.push(other.id);
  const parentName = uniqueAgentName('E2E Side Pause Parent');
  const parent = await createAgent(page, parentName, {
    subagents: { enabled: true, allowSelf: false, agent_ids: [child.id, other.id] },
  });
  createdAgentIds.push(parent.id);

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: parentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(parentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();

  const response = await sendMessageAndWaitForCompletion(
    page,
    `${DISPATCH_MARKER}${child.id},${other.id}:${label}`,
  );
  expect(response.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Ran 2 agents' }).click();
  const cards = page.locator('[data-subagent-tool-call^="call_e2e_subagent_activity_"]');
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(cards.first()).toContainText('Completed', { timeout: 60_000 });
  await cards.first().click();
  const panel = page.getByRole('region', { name: 'Child agent activity' });
  await expect(panel).toContainText(`E2E detached child 1 complete ${label}`, { timeout: 30_000 });

  await panel.getByRole('textbox', { name: 'Message input' }).fill(text);
  await panel.getByRole('button', { name: 'Continue in a new chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toBeVisible({ timeout: 30_000 });
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  expect(conversationId).not.toBe('');
  return { sideChat, conversationId };
}

test.describe('a pause inside a side chat', () => {
  test('a question the agent asks is answered in the side chat, and the reply continues there @scenario:side-chat-answers-ask-user-question', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = `side-ask-${Date.now().toString(36)}`;
    const createdAgentIds: string[] = [];
    try {
      await page.goto('/c/new');
      const child = await createAgent(page, uniqueAgentName('E2E Side Ask Child'), {
        tools: [ASK_TOOL_ID],
      });
      createdAgentIds.push(child.id);
      const { sideChat, conversationId } = await continueBeside(
        page,
        child,
        label,
        `${ASK_MARKER}${label}`,
        createdAgentIds,
      );
      const parentPath = new URL(page.url()).pathname;

      /** The question is drawn in the side chat, where its conversation is. */
      const question = `Which environment should Bombadil use for ${label}?`;
      await expect(sideChat).toContainText(question, { timeout: 30_000 });
      /** No hand-off to the main chat's message box is offered from here. */
      await expect(
        sideChat.getByRole('button', { name: 'Answer from the message box' }),
      ).toHaveCount(0);

      await sideChat.getByRole('button', { name: /Staging/ }).click();
      const [resume] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        sideChat.getByRole('button', { name: 'Submit', exact: true }).click(),
      ]);

      /** The answer goes to the side conversation, not the one beside it. */
      const body = resume.postDataJSON() as ResumeBody;
      expect(body.conversationId).toBe(conversationId);
      expect(body.answers).toEqual({ environment: 'staging' });

      /** The run carries on in the side chat, on the stream it was already reading. */
      await expect(sideChat).toContainText('You answered:', { timeout: 30_000 });
      await expect(sideChat).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
      await expect(sideChat.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(new URL(page.url()).pathname).toBe(parentPath);
      await expect(page.getByRole('main')).not.toContainText(question);
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });

  test('a tool waiting for approval is approved in the side chat, and runs there @scenario:side-chat-approves-tool-call', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = `side-approval-${Date.now().toString(36)}`;
    const createdAgentIds: string[] = [];
    try {
      const child = await createApprovalAgent(page);
      createdAgentIds.push(child.id);
      const { sideChat, conversationId } = await continueBeside(
        page,
        child,
        label,
        `${APPROVAL_PROMPT_MARKER}${label}`,
        createdAgentIds,
      );

      /** The request is drawn on the tool call in the side chat, with its decision controls. */
      const approve = sideChat.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeVisible({ timeout: 30_000 });
      await expect(sideChat).toContainText('E2E approval required before running');

      await approve.click();
      const [resume] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        sideChat.getByRole('button', { name: 'Submit', exact: true }).click(),
      ]);

      const body = resume.postDataJSON() as ResumeBody;
      expect(body.conversationId).toBe(conversationId);
      expect(body.decisions).toEqual([
        { tool_call_id: `call_e2e_approval_${label}`, decision: 'approve' },
      ]);

      /** The tool runs and its result is reported in the side chat. */
      await expect(sideChat).toContainText(`E2E approval probe executed: original-${label}`, {
        timeout: 30_000,
      });
      await expect(approve).toHaveCount(0);
      await expect(sideChat.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 30_000,
      });
    } finally {
      for (const agentId of createdAgentIds.reverse()) {
        await cleanupAgent(page, agentId);
      }
    }
  });
});
