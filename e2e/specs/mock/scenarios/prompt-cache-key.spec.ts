import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import type { User } from '../../../types';
import cleanupUser from '../../../setup/cleanupUser';
import { getSecondaryE2EUser } from '../../../setup/users.mock';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

const OPENAI_PROVIDER = 'openAI';
const OPENAI_MODEL = 'gpt-5.6';
const CUSTOM_PROVIDER = 'Mock Provider A';
const CUSTOM_MODEL = 'mock-model-a';
const PROMPT_CACHE_MARKER = 'E2E_ASSERT_PROMPT_CACHE:';

async function getIsolatedStorageState(request: APIRequestContext, user: User) {
  await cleanupUser(user);

  const registerResponse = await request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const loginResponse = await request.post('/api/auth/login', {
    data: {
      email: user.email,
      password: user.password,
    },
  });
  expect(loginResponse.ok()).toBeTruthy();

  return request.storageState();
}

const createdAgentIds: string[] = [];
const cleanupConversationIds: string[] = [];

type CreatedAgent = {
  id: string;
  name: string;
};

async function createAgent(
  page: Page,
  token: string,
  provider: string,
  model: string,
  instructions: string,
  agentName?: string,
): Promise<CreatedAgent> {
  const name = agentName ?? uniqueAgentName('E2E Prompt Cache Agent');
  const agent = await requestJson<CreatedAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Prompt cache key scenario fixture.',
      instructions,
      provider,
      model,
      model_parameters: {},
    },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

/**
 * Reopens the combobox for each attempt. Saving the agent refetches the agent
 * list, and a refetch that lands mid-click re-renders the listbox and detaches
 * the option under the pointer, so retrying the click alone retries against a
 * dead node.
 */
async function selectAgent(page: Page, agentName: string) {
  const form = await openAgentBuilder(page);
  await expect(async () => {
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agentName, exact: true }).click({ timeout: 5000 });
    await expect(form.getByLabel('Agent name')).toHaveValue(agentName, { timeout: 5000 });
  }).toPass({ timeout: 30000 });
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function persistedText(message: TMessage): string {
  if (message.text) {
    return message.text;
  }
  return (message.content ?? [])
    .map((part) => {
      if (part?.type !== 'text') {
        return '';
      }
      const text = (part as { text?: string | { value?: string } }).text;
      return typeof text === 'string' ? text : (text?.value ?? '');
    })
    .join('');
}

/**
 * Without `path` the agent is chosen through the builder; with it, the page
 * opens a route that already names the agent, which is the only way a new
 * chat keeps a `projectId` the builder's navigation would drop.
 */
async function sendAssertion(
  page: Page,
  agentName: string,
  distinctText: string,
  path?: string,
): Promise<string> {
  if (path == null) {
    await selectAgent(page, agentName);
  } else {
    await page.goto(path, { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 30000,
    });
  }
  const response = await sendMessageAndWaitForCompletion(
    page,
    `${PROMPT_CACHE_MARKER}${distinctText}\n${distinctText}`,
    { timeout: 60000 },
  );
  expect(response.ok()).toBeTruthy();

  const conversationId = /\/c\/([^/?#]+)/.exec(page.url())?.[1];
  expect(conversationId, 'conversation should have a persisted id').toBeTruthy();
  cleanupConversationIds.push(conversationId as string);

  const token = await getAccessToken(page);
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId as string)}`,
    token,
  );
  const assistantText = messages
    .filter((message) => message.isCreatedByUser === false)
    .map(persistedText)
    .join('\n');
  const key = /PROMPT_CACHE_KEY=([^\r\n]*)/.exec(assistantText)?.[1];
  expect(key, 'assistant reply should report a prompt cache key').toBeDefined();
  return key as string;
}

test.afterEach(async ({ page }) => {
  const conversationIds = cleanupConversationIds.splice(0);
  if (conversationIds.length > 0) {
    try {
      await deleteMessagesByConversation(conversationIds);
    } finally {
      await deleteConversations(conversationIds);
    }
  }

  const agentIds = createdAgentIds.splice(0).reverse();
  await Promise.all(agentIds.map((agentId) => cleanupAgent(page, agentId)));
});

test.describe('prompt cache key', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'Prompt cache key scenarios require desktop Agent Builder',
  );
  test('shares one cache key for a stable agent prefix across conversations @scenario:stable-prefix-shares-one-cache-key-across-conversations', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const instructions = 'Always answer this deterministic prompt-cache scenario briefly.';
    const agent = await createAgent(page, token, OPENAI_PROVIDER, OPENAI_MODEL, instructions);

    const firstKey = await sendAssertion(page, agent.name, 'first distinct user message');
    const secondKey = await sendAssertion(page, agent.name, 'second distinct user message');
    expect(firstKey).not.toBe('');
    expect(firstKey).not.toBe('none');
    expect(secondKey).not.toBe('');
    expect(secondKey).not.toBe('none');
    expect(secondKey).toBe(firstKey);
  });

  test('retires the cache key when agent instructions change @scenario:changed-agent-instructions-retire-the-cache-key', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const initialInstructions = 'Use the initial stable instructions for this cache scenario.';
    const agent = await createAgent(
      page,
      token,
      OPENAI_PROVIDER,
      OPENAI_MODEL,
      initialInstructions,
    );

    const firstKey = await sendAssertion(page, agent.name, 'before instruction change');
    expect(firstKey).not.toBe('');
    expect(firstKey).not.toBe('none');

    await requestJson(page, {
      path: `/api/agents/${encodeURIComponent(agent.id)}`,
      token,
      method: 'PATCH',
      body: { instructions: 'Use materially different instructions after the update.' },
    });

    const secondKey = await sendAssertion(page, agent.name, 'after instruction change');
    expect(secondKey).not.toBe('');
    expect(secondKey).not.toBe('none');
    expect(secondKey).not.toBe(firstKey);
  });

  test('keys project guidance into the cache identity and shares it within the project @scenario:project-guidance-retires-the-cache-key', async ({
    page,
    request,
  }) => {
    test.setTimeout(180000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const agent = await createAgent(
      page,
      token,
      OPENAI_PROVIDER,
      OPENAI_MODEL,
      'Use the stable instructions for this project cache scenario.',
    );
    let projectId: string | undefined;

    try {
      const plainKey = await sendAssertion(page, agent.name, 'outside any project');
      expect(plainKey).not.toBe('');
      expect(plainKey).not.toBe('none');

      const created = await request.post('/api/projects', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          name: uniqueAgentName('E2E Prompt Cache Project'),
          instructions: 'Answer every question in this project with a short summary first.',
        },
      });
      expect(created.status()).toBe(201);
      projectId = ((await created.json()) as { _id?: string })._id;
      expect(projectId, 'project should have an id').toBeTruthy();

      const projectPath = `${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(
        agent.id,
      )}&projectId=${encodeURIComponent(projectId as string)}`;
      const firstProjectKey = await sendAssertion(
        page,
        agent.name,
        'first chat in the project',
        projectPath,
      );
      const secondProjectKey = await sendAssertion(
        page,
        agent.name,
        'second chat in the project',
        projectPath,
      );

      expect(firstProjectKey).not.toBe('');
      expect(firstProjectKey).not.toBe('none');
      expect(firstProjectKey).not.toBe(plainKey);
      expect(secondProjectKey).toBe(firstProjectKey);
    } finally {
      if (projectId != null) {
        await request.delete(`/api/projects/${encodeURIComponent(projectId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  });

  test('sends no cache key for a gateway endpoint @scenario:gateway-endpoint-sends-no-cache-key', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const agent = await createAgent(
      page,
      token,
      CUSTOM_PROVIDER,
      CUSTOM_MODEL,
      'Use the custom gateway endpoint for this scenario.',
    );

    const key = await sendAssertion(page, agent.name, 'custom gateway request');
    expect(key).toBe('none');
  });
  test('retires the cache key when switching from Chat Completions to Responses API @scenario:responses-api-switch-retires-the-cache-key', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const agent = await createAgent(
      page,
      token,
      OPENAI_PROVIDER,
      OPENAI_MODEL,
      'Use the stable instructions for this Responses API cache scenario.',
    );

    const chatCompletionsKey = await sendAssertion(page, agent.name, 'before Responses API switch');
    expect(chatCompletionsKey).not.toBe('');
    expect(chatCompletionsKey).not.toBe('none');

    /**
     * Verified Chat Completions -> Responses for gpt-5.6: with no reasoning
     * parameters, the default gate stays off because
     * requiresResponsesApiForReasoning requires a non-empty effort (llm.ts:180-195,
     * 923-930); the patched true value is honored by OpenAI routing (llm.ts:510-514).
     */
    await requestJson(page, {
      path: `/api/agents/${encodeURIComponent(agent.id)}`,
      token,
      method: 'PATCH',
      body: { model_parameters: { useResponsesApi: true } },
    });

    const responsesKey = await sendAssertion(page, agent.name, 'after Responses API switch');
    expect(responsesKey).not.toBe('');
    expect(responsesKey).not.toBe('none');
    expect(responsesKey).not.toBe(chatCompletionsKey);
  });

  test('separates cache keys for identical agents owned by different users @scenario:two-users-of-one-agent-get-separate-cache-keys', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    test.setTimeout(120000);
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock prompt cache tests');
    }

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const primaryToken = await getAccessToken(page);
    const instructions =
      'Use the same byte-identical instructions for this user isolation scenario.';
    const sharedAgentName = uniqueAgentName('E2E Prompt Cache Shared Agent');
    const primaryAgent = await createAgent(
      page,
      primaryToken,
      OPENAI_PROVIDER,
      OPENAI_MODEL,
      instructions,
      sharedAgentName,
    );
    const primaryKey = await sendAssertion(page, primaryAgent.name, 'primary user prompt');
    expect(primaryKey).not.toBe('');
    expect(primaryKey).not.toBe('none');

    const secondaryUser = getSecondaryE2EUser();
    const secondaryConversationStart = cleanupConversationIds.length;
    let secondaryContext: BrowserContext | undefined;
    let secondaryPage: Page | undefined;
    let secondaryAgent: CreatedAgent | undefined;

    try {
      secondaryContext = await browser.newContext({
        storageState: await getIsolatedStorageState(request, secondaryUser),
        baseURL,
      });
      secondaryPage = await secondaryContext.newPage();
      await secondaryPage.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const secondaryToken = await getAccessToken(secondaryPage);
      secondaryAgent = await createAgent(
        secondaryPage,
        secondaryToken,
        OPENAI_PROVIDER,
        OPENAI_MODEL,
        instructions,
        sharedAgentName,
      );

      const secondaryKey = await sendAssertion(
        secondaryPage,
        secondaryAgent.name,
        'secondary user prompt',
      );
      expect(secondaryKey).not.toBe('');
      expect(secondaryKey).not.toBe('none');
      expect(secondaryKey).not.toBe(primaryKey);
    } finally {
      const secondaryConversationIds = cleanupConversationIds.splice(secondaryConversationStart);
      try {
        if (secondaryConversationIds.length > 0) {
          try {
            await deleteMessagesByConversation(secondaryConversationIds);
          } finally {
            await deleteConversations(secondaryConversationIds);
          }
        }
      } finally {
        try {
          if (secondaryAgent && secondaryPage) {
            const createdAgentIndex = createdAgentIds.indexOf(secondaryAgent.id);
            if (createdAgentIndex >= 0) {
              createdAgentIds.splice(createdAgentIndex, 1);
            }
            await cleanupAgent(secondaryPage, secondaryAgent.id);
          }
        } finally {
          if (secondaryContext) {
            await secondaryContext.close().catch(() => undefined);
          }
          await cleanupUser(secondaryUser);
        }
      }
    }
  });
});
