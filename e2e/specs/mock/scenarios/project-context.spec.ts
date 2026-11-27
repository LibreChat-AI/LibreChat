import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  getAccessToken,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

type ProjectResponse = {
  _id?: string;
};

type ConversationResponse = {
  chatProjectId?: string | null;
};

type ConversationListResponse = {
  conversations?: Array<{ conversationId?: string }>;
};

type AssistantResponse = {
  id?: string;
};

type ProviderRequest = {
  path: string;
  body: {
    assistant_id?: string;
    additional_instructions?: string;
  };
};

type ProviderRequestLog = {
  requests: ProviderRequest[];
};

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Expected ${label} in API response`);
  }
  return value;
}

function conversationIdFromUrl(url: string): string {
  const conversationId = new URL(url).pathname.match(/^\/c\/([^/]+)\/?$/)?.[1];
  if (!conversationId || conversationId === 'new') {
    throw new Error(`Expected a persisted conversation URL, got ${url}`);
  }
  return decodeURIComponent(conversationId);
}

test.describe('project context scenarios', () => {
  test('project instructions reach the model on the first and a later turn @scenario:project-instructions-apply-to-first-and-later-turns', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let projectId: string | undefined;
    let conversationId: string | undefined;
    const projectName = uniqueName('Project Context');
    const guidanceToken = `E2E_PROJECT_GUIDANCE_${randomUUID()}`;

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const headers = () => ({ Authorization: `Bearer ${requireString(token, 'access token')}` });
    const transcript = page.getByTestId('screenshot-target');
    const projectAssertionFailure = transcript.getByText(/E2E project context assertion failed:/);

    try {
      const created = await request.post('/api/projects', {
        headers: headers(),
        data: {
          name: projectName,
          instructions: `Always follow ${guidanceToken} when answering project questions.`,
        },
      });
      expect(created.status()).toBe(201);
      const project = (await created.json()) as ProjectResponse;
      projectId = requireString(project._id, 'project id');

      await page.goto(`/c/new?projectId=${encodeURIComponent(projectId)}`, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_PROJECT_CONTEXT:${guidanceToken}`);
      await expect(
        transcript.getByText(`E2E project context assertion passed: ${guidanceToken}`),
      ).toBeVisible({ timeout: 20000 });
      await expect(projectAssertionFailure).toHaveCount(0);

      conversationId = conversationIdFromUrl(page.url());

      await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_PROJECT_CONTEXT:${guidanceToken}`);
      await expect(
        transcript.getByText(`E2E project context assertion passed: ${guidanceToken}`),
      ).toHaveCount(2, { timeout: 20000 });
      await expect(projectAssertionFailure).toHaveCount(0);

      const stored = await request.get(`/api/convos/${encodeURIComponent(conversationId)}`, {
        headers: headers(),
      });
      expect(stored.status()).toBe(200);
      const conversation = (await stored.json()) as ConversationResponse;
      expect(conversation.chatProjectId).toBe(projectId);

      const conversationUrl = page.url();
      await page.reload({ timeout: 10000 });
      await expect(page).toHaveURL(conversationUrl);
      const reloaded = await request.get(`/api/convos/${encodeURIComponent(conversationId)}`, {
        headers: headers(),
      });
      expect(reloaded.status()).toBe(200);
      expect(((await reloaded.json()) as ConversationResponse).chatProjectId).toBe(projectId);
    } finally {
      const cleanup: Promise<unknown>[] = [];
      if (token && conversationId) {
        cleanup.push(
          request.delete('/api/convos', {
            headers: headers(),
            data: { arg: { conversationId } },
          }),
        );
      }
      if (token && projectId) {
        cleanup.push(
          request.delete(`/api/projects/${encodeURIComponent(projectId)}`, {
            headers: headers(),
          }),
        );
      }
      await Promise.allSettled(cleanup);
    }
  });

  test('a project chat keeps its project on a hosted Assistant across turns @scenario:project-chat-stays-in-project-on-hosted-assistant', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let projectId: string | undefined;
    let assistantId: string | undefined;
    let conversationId: string | undefined;
    const firstGuidance = 'Use the original project policy.';
    const revisedGuidance = 'Use the revised project policy.';

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const headers = () => ({ Authorization: `Bearer ${requireString(token, 'access token')}` });

    try {
      const projectResponse = await request.post('/api/projects', {
        headers: headers(),
        data: { name: uniqueName('Hosted Project'), instructions: firstGuidance },
      });
      expect(projectResponse.status()).toBe(201);
      projectId = requireString(
        ((await projectResponse.json()) as ProjectResponse)._id,
        'project id',
      );

      const assistantResponse = await request.post('/api/assistants/v2', {
        headers: headers(),
        data: {
          endpoint: 'assistants',
          model: 'gpt-4o-mini',
          name: uniqueName('Project Assistant'),
          tools: [],
        },
      });
      expect(assistantResponse.status()).toBe(201);
      assistantId = requireString(
        ((await assistantResponse.json()) as AssistantResponse).id,
        'assistant id',
      );

      const sendTurn = async (
        currentConversationId: string | null = null,
        parentMessageId = '00000000-0000-0000-0000-000000000000',
        threadId?: string,
      ): Promise<string> => {
        const messageId = randomUUID();
        const response = await request.post('/api/assistants/v2/chat', {
          headers: headers(),
          data: {
            text: 'Apply the project policy.',
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId,
            conversationId: currentConversationId,
            messageId,
            responseMessageId: `${messageId}_response`,
            endpoint: 'assistants',
            endpointType: 'assistants',
            model: 'gpt-4o-mini',
            assistant_id: assistantId,
            thread_id: threadId,
            chatProjectId: currentConversationId ? undefined : projectId,
            files: [],
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        expect(response.status()).toBe(200);
        const text = await response.text();
        expect(text).toContain('"final":true');
        return text;
      };

      const firstTurn = await sendTurn();
      conversationId = requireString(
        firstTurn.match(/"conversationId":"([^"]+)"/)?.[1],
        'conversation id',
      );

      const listed = await request.get(`/api/convos?projectId=${encodeURIComponent(projectId)}`, {
        headers: headers(),
      });
      expect(listed.status()).toBe(200);
      const listedConversations = (await listed.json()) as ConversationListResponse;
      expect(
        listedConversations.conversations?.some(
          (conversation) => conversation.conversationId === conversationId,
        ),
      ).toBe(true);
      const stored = await request.get(`/api/convos/${encodeURIComponent(conversationId)}`, {
        headers: headers(),
      });
      expect(stored.status()).toBe(200);
      expect(((await stored.json()) as ConversationResponse).chatProjectId).toBe(projectId);

      const messagesResponse = await request.get(
        `/api/messages/${encodeURIComponent(conversationId)}`,
        { headers: headers() },
      );
      expect(messagesResponse.status()).toBe(200);
      const messages = (await messagesResponse.json()) as TMessage[];
      const userMessage = messages.find((message) => message.isCreatedByUser);
      const reply = messages.find((message) => !message.isCreatedByUser);
      const threadId = requireString(userMessage?.thread_id, 'assistant thread id');
      const replyMessageId = requireString(reply?.messageId, 'assistant reply message id');

      const revised = await request.patch(`/api/projects/${encodeURIComponent(projectId)}`, {
        headers: headers(),
        data: { instructions: revisedGuidance },
      });
      expect(revised.status()).toBe(200);
      await sendTurn(conversationId, replyMessageId, threadId);

      const provider = `http://127.0.0.1:${process.env.E2E_ASSISTANTS_PORT || '8890'}`;
      const recorded = await request.get(`${provider}/__e2e/requests`);
      expect(recorded.status()).toBe(200);
      const history = (await recorded.json()) as ProviderRequestLog;
      const runs = history.requests.filter(
        (entry) => entry.path.endsWith('/runs') && entry.body.assistant_id === assistantId,
      );
      expect(runs).toHaveLength(2);
      expect(runs[0].body.additional_instructions).toContain(firstGuidance);
      expect(runs[1].body.additional_instructions).toContain(revisedGuidance);
      expect(runs[1].body.additional_instructions).not.toContain(firstGuidance);
    } finally {
      const cleanup: Promise<unknown>[] = [];
      if (token && conversationId) {
        cleanup.push(
          request.delete('/api/convos', {
            headers: headers(),
            data: { arg: { conversationId } },
          }),
        );
      }
      if (token && assistantId) {
        cleanup.push(
          request.delete(
            `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
            { headers: headers(), data: { endpoint: 'assistants' } },
          ),
        );
      }
      if (token && projectId) {
        cleanup.push(
          request.delete(`/api/projects/${encodeURIComponent(projectId)}`, {
            headers: headers(),
          }),
        );
      }
      await Promise.allSettled(cleanup);
    }
  });
});
