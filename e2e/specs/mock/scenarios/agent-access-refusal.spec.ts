import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { User } from '../../../types';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  getAccessToken,
  requestJson,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import cleanupUser from '../../../setup/cleanupUser';
import { withMongo } from '../db';

/**
 * A chat whose agent the user may not view is refused by the server. The user is told it is an
 * access problem: in the composer while the agent cannot be loaded, and in the transcript when the
 * refusal only arrives with the send, instead of a model provider failure that reads "Forbidden".
 */

const ACCESS_REFUSED = 'You do not have access to this agent.';
const PROVIDER_FAILURE = 'The model provider could not complete this request.';

type Member = { user: User; id: string; context: BrowserContext; page: Page };
/** `id` names the agent in a chat; `_id` is the resource the sharing routes take. */
type Agent = { id: string; _id: string };

async function createAgent(page: Page): Promise<Agent> {
  const token = await getAccessToken(page);
  const agent = await requestJson<Partial<Agent>>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Access Refusal'),
      instructions: 'Answer with the mock model.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
  expect(agent.id).toMatch(/^agent_/);
  const record = await withMongo((db) => db.collection('agents').findOne({ id: agent.id }));
  if (!record) {
    throw new Error(`E2E seed: agent "${agent.id}" not found`);
  }
  return { id: agent.id ?? '', _id: record._id.toString() };
}

/** The primary account is the deployment's first, an admin whose rights pass every agent check,
 *  so the refusal needs an ordinary member signed in through the login form. */
async function signInMember(browser: Browser, baseURL: string): Promise<Member> {
  const user: User = {
    name: 'Agent Access Member',
    email: `agent-access-${randomUUID().slice(0, 8)}@example.com`,
    password: `Pw-${randomUUID()}`,
  };
  const context = await browser.newContext({ storageState: undefined, baseURL });
  const registered = await context.request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registered.ok()).toBeTruthy();
  const page = await context.newPage();
  await page.goto('/login', { timeout: 10000 });
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\/new/, { timeout: 10000 });
  const record = await withMongo((db) => db.collection('users').findOne({ email: user.email }));
  if (!record) {
    throw new Error(`E2E seed: member "${user.email}" not found`);
  }
  return { user, id: record._id.toString(), context, page };
}

/** Grants or revokes the member's view of the agent the way its owner would, through sharing. */
async function share(page: Page, agent: Agent, member: Member, grant: boolean) {
  const token = await getAccessToken(page);
  const principal = {
    type: 'user',
    id: member.id,
    name: member.user.name,
    email: member.user.email,
    source: 'local',
  };
  await requestJson<unknown>(page, {
    path: `/api/permissions/agent/${agent._id}`,
    token,
    method: 'PUT',
    body: grant
      ? { updated: [{ ...principal, accessRoleId: 'agent_viewer' }], removed: [] }
      : { updated: [], removed: [principal] },
  });
}

const openAgentChat = (page: Page, agentId: string) =>
  page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, { timeout: 10000 });

test.describe('agent access refusal', () => {
  /* Signing a member up and removing their account afterwards takes most of the default budget. */
  test.describe.configure({ timeout: 90000 });

  test('a chat with an agent the member may not view says so and does not send @scenario:refused-agent-is-named-in-the-composer', async ({
    page,
    browser,
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock scenarios');
    }
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page);
    const member = await signInMember(browser, baseURL);

    try {
      await openAgentChat(member.page, agent.id);
      const alert = member.page.getByRole('alert').filter({ hasText: ACCESS_REFUSED });
      await expect(alert).toBeVisible({ timeout: 30000 });
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();

      await member.page.getByRole('textbox', { name: 'Message input' }).fill('hello');
      await expect(member.page.getByTestId('send-button')).toBeDisabled();
    } finally {
      await member.context.close().catch(() => undefined);
      await cleanupUser(member.user);
      await cleanupAgent(page, agent.id);
    }
  });

  test('a send refused after access was revoked states the refusal, not a provider failure @scenario:revoked-agent-turn-states-the-access-refusal', async ({
    page,
    browser,
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock scenarios');
    }
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page);
    const member = await signInMember(browser, baseURL);

    try {
      await share(page, agent, member, true);
      await openAgentChat(member.page, agent.id);
      const input = member.page.getByRole('textbox', { name: 'Message input' });
      await input.fill('hello');
      await expect(member.page.getByTestId('send-button')).toBeEnabled({ timeout: 30000 });

      /* The chat loaded its agent while the share stood; the owner withdraws it before the send. */
      await share(page, agent, member, false);
      const [start] = await Promise.all([
        member.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.startsWith('/api/agents/chat'),
          { timeout: 30000 },
        ),
        input.press('Enter'),
      ]);
      expect(start.status()).toBe(403);

      const turn = messagesView(member.page).getByRole('alert');
      await expect(turn).toContainText(ACCESS_REFUSED, { timeout: 30000 });
      await expect(member.page.getByText(PROVIDER_FAILURE)).toHaveCount(0);
      await expect(member.page.getByText('Forbidden', { exact: true })).toHaveCount(0);

      /* The refusal also reaches the composer, which holds the next send instead of offering it. */
      const composer = member.page
        .getByRole('alert')
        .filter({ hasText: ACCESS_REFUSED })
        .filter({ has: member.page.getByRole('button', { name: 'Retry' }) });
      await expect(composer).toBeVisible({ timeout: 30000 });
      await input.fill('hello again');
      await expect(member.page.getByTestId('send-button')).toBeDisabled();
    } finally {
      await member.context.close().catch(() => undefined);
      await cleanupUser(member.user);
      await cleanupAgent(page, agent.id);
    }
  });
});
