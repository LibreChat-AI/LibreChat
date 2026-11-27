import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, Response } from '@playwright/test';
import type { User } from '../../../types';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import cleanupUser from '../../../setup/cleanupUser';
import { withMongo } from '../db';

/**
 * A chat whose agent the user may not view, or whose agent was deleted, is refused by the server.
 * The user is told why: in the composer while the agent cannot be loaded, and in the transcript
 * when the refusal only arrives with the send, instead of a model provider failure that reads
 * "Forbidden" or "Not Found".
 */

const ACCESS_REFUSED = 'You do not have access to this agent.';
const AGENT_GONE = 'This agent is no longer available.';
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

const isChatStart = (response: Response) =>
  response.request().method() === 'POST' &&
  new URL(response.url()).pathname.startsWith('/api/agents/chat');

/** Sends what the composer holds and returns the chat route's answer to the start. */
async function send(page: Page) {
  const [start] = await Promise.all([
    page.waitForResponse(isChatStart, { timeout: 30000 }),
    page.getByRole('textbox', { name: 'Message input' }).press('Enter'),
  ]);
  return start;
}

/** The composer names a refused or deleted agent beside Retry and keeps the next send held. */
async function expectComposerHolds(page: Page, copy: string) {
  const composer = page
    .getByRole('alert')
    .filter({ hasText: copy })
    .filter({ has: page.getByRole('button', { name: 'Retry' }) });
  await expect(composer).toBeVisible({ timeout: 30000 });
  await page.getByRole('textbox', { name: 'Message input' }).fill('hello again');
  await expect(page.getByTestId('send-button')).toBeDisabled();
}

/** Once the refusal refetches the agent, the composer's alert, with its Retry, can sit in the
 *  messages view beside the turn's card, so the card is the alert without one. */
async function expectTurnSays(page: Page, copy: string, detail: string) {
  const turn = messagesView(page).getByRole('alert').filter({ hasNotText: 'Retry' });
  await expect(turn).toHaveText(copy, { timeout: 30000 });
  await expect(page.getByText(PROVIDER_FAILURE)).toHaveCount(0);
  await expect(page.getByText(detail, { exact: true })).toHaveCount(0);
}

/** Deletes the agent the way its owner would; a test that already deleted it cleans up quietly. */
const deleteAgent = (page: Page, agent: Agent) =>
  cleanupAgent(page, agent.id).catch(() => undefined);

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
      await expectComposerHolds(member.page, ACCESS_REFUSED);
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
      await member.page.getByRole('textbox', { name: 'Message input' }).fill('hello');
      await expect(member.page.getByTestId('send-button')).toBeEnabled({ timeout: 30000 });

      /* The chat loaded its agent while the share stood; the owner withdraws it before the send. */
      await share(page, agent, member, false);
      const start = await send(member.page);
      expect(start.status()).toBe(403);

      await expectTurnSays(member.page, ACCESS_REFUSED, 'Forbidden');
      /* The refusal also reaches the composer, which holds the next send instead of offering it. */
      await expectComposerHolds(member.page, ACCESS_REFUSED);
    } finally {
      await member.context.close().catch(() => undefined);
      await cleanupUser(member.user);
      await cleanupAgent(page, agent.id);
    }
  });
});

test.describe('deleted agent', () => {
  /* Signing a member up and removing their account afterwards takes most of the default budget. */
  test.describe.configure({ timeout: 90000 });

  test('a chat whose agent was deleted says the agent is gone and does not send @scenario:deleted-agent-is-named-in-the-composer', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page);

    try {
      await openAgentChat(page, agent.id);
      await sendMessageAndWaitForCompletion(page, 'hello');
      await expect(page).toHaveURL(/\/c\/(?!new)/);

      /* Deleted outside this page, so only opening the chat again reads the agent's details. */
      await deleteAgent(page, agent);
      await page.reload();
      await expectComposerHolds(page, AGENT_GONE);
      await expect(page.getByText('Unable to load this chat’s model or agent.')).toHaveCount(0);
    } finally {
      await deleteAgent(page, agent);
    }
  });

  test('a send refused because the agent was deleted says so, not a provider failure @scenario:deleted-agent-turn-says-the-agent-is-gone', async ({
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
      await member.page.getByRole('textbox', { name: 'Message input' }).fill('hello');
      await expect(member.page.getByTestId('send-button')).toBeEnabled({ timeout: 30000 });

      /* The chat loaded its agent; the owner deletes it before the member sends. */
      await deleteAgent(page, agent);
      const start = await send(member.page);
      expect(start.status()).toBe(404);

      await expectTurnSays(member.page, AGENT_GONE, 'Not Found');
      await expectComposerHolds(member.page, AGENT_GONE);
    } finally {
      await member.context.close().catch(() => undefined);
      await cleanupUser(member.user);
      await deleteAgent(page, agent);
    }
  });

  test('a run started for a deleted agent by an agent manager says the agent is gone @scenario:deleted-agent-turn-says-the-agent-is-gone-for-an-agent-manager', async ({
    page,
  }) => {
    /* The primary account is an admin, whose agent rights skip the chat route's agent check, so the
     * deleted agent is only found missing once the run starts. */
    await page.goto(NEW_CHAT_PATH);
    const agent = await createAgent(page);

    try {
      await openAgentChat(page, agent.id);
      await page.getByRole('textbox', { name: 'Message input' }).fill('hello');
      await expect(page.getByTestId('send-button')).toBeEnabled({ timeout: 30000 });

      await deleteAgent(page, agent);
      const start = await send(page);
      expect(start.status()).toBe(200);

      await expectTurnSays(page, AGENT_GONE, 'Agent not found');
      await expectComposerHolds(page, AGENT_GONE);
    } finally {
      await deleteAgent(page, agent);
    }
  });
});
