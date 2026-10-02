import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  escapeRegExp,
  getAccessToken,
  messagesView,
  replyPrompt,
  replyText,
  requestJson,
  selectModelSpec,
  sendMessage,
} from './helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const ENFORCED_SPEC_NAME = 'e2e-mock-provider-a';
const ENFORCED_SPEC_LABEL = 'Mock Provider A';

type AgentStartResponse = {
  conversationId: string;
  streamId: string;
  status: string;
};

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects', { timeout: 10000 });
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name: new RegExp(escapeRegExp(name)) })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/projects/')[1];
  expect(projectId).toBeTruthy();
  return projectId;
}

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function waitForStreamReply(page: Page, token: string, streamId: string, expected: string) {
  await page.evaluate(
    async ({ accessToken, expectedText, currentStreamId }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 60000);
      let buffered = '';

      try {
        const response = await fetch(
          `/api/agents/chat/stream/${encodeURIComponent(currentStreamId)}?resume=true`,
          {
            method: 'GET',
            credentials: 'include',
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error(`Expected stream to return 2xx, got ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffered += decoder.decode(value, { stream: true });
          if (buffered.includes(expectedText)) {
            await reader.cancel();
            return;
          }

          if (buffered.includes('event: error')) {
            await reader.cancel();
            throw new Error(`Stream emitted an error before ${expectedText}:\n${buffered}`);
          }
        }
      } finally {
        window.clearTimeout(timeout);
      }

      throw new Error(`Timed out waiting for ${expectedText}. Latest stream:\n${buffered}`);
    },
    { accessToken: token, currentStreamId: streamId, expectedText: expected },
  );
}

test.describe('enforced model specs', () => {
  test.skip(
    process.env.E2E_MODEL_SPECS_ENFORCE !== 'true',
    'requires E2E_MODEL_SPECS_ENFORCE=true',
  );

  test('rebuilds a valid enforced spec from the backend preset when the request is stale', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueName('reported-spec').replace(/\s+/g, '-');

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const userMessageId = randomUUID();
    const start = await requestJson<AgentStartResponse>(page, {
      path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
      token,
      method: 'POST',
      body: {
        text: replyPrompt(label),
        sender: 'User',
        clientTimestamp: new Date().toLocaleString('sv').replace(' ', 'T'),
        isCreatedByUser: true,
        parentMessageId: NO_PARENT,
        conversationId: 'new',
        messageId: userMessageId,
        responseMessageId: `${userMessageId}_`,
        endpoint: MOCK_ENDPOINTS[0].label,
        endpointType: 'custom',
        model: { stale: 'cached-client-value' },
        agent_id: 'agent_from_cached_client_state',
        spec: ENFORCED_SPEC_NAME,
        isTemporary: false,
        isRegenerate: false,
        error: false,
      },
    });

    expect(start.status).toBe('started');
    expect(start.conversationId).toBeTruthy();

    await waitForStreamReply(page, token, start.streamId, replyText(label));
  });

  test('keeps a project-scoped chat attached when sending with an enforced spec', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueName('E2E Enforced Project');
    const projectId = await createProject(page, name);
    const label = uniqueName('project-spec').replace(/\s+/g, '-');

    await page.goto(`/c/new?projectId=${projectId}`, { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveAttribute(
      'placeholder',
      new RegExp(name),
    );

    await selectModelSpec(page, ENFORCED_SPEC_LABEL);
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();

    const response = await sendMessage(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    const projectRow = page.getByRole('button', { name }).first();
    if ((await projectRow.getAttribute('aria-expanded')) !== 'true') {
      await projectRow.click();
    }
    await expect(
      page.getByTestId(`project-chats-${projectId}`).getByTestId('convo-item').first(),
    ).toBeVisible();
  });
});
