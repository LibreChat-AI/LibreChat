import { expect, test } from '@playwright/test';
import type { Page, Response, Route } from '@playwright/test';
import {
  isAgentGenerationStart,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

type TextContentPart = {
  type?: string;
  text?: string | { value?: string };
  error?: string;
};

type E2EMessage = {
  messageId: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  text?: string;
  content?: TextContentPart[];
  isCreatedByUser?: boolean;
  error?: boolean;
  unfinished?: boolean;
};

type ForkResponse = {
  conversation: {
    conversationId?: string;
  };
  messages: E2EMessage[];
};

type JsonResponse = {
  ok: boolean;
  status: number;
  text: string;
  json: unknown;
};

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const replyPrompt = (label: string) => `E2E_REPLY:${label}`;
const replyText = (label: string) => `E2E reply ${label}`;
const countedPrompt = (label: string) => `E2E_COUNTED_REPLY:${label}`;
const countedReplyText = (label: string, count: number) => `E2E counted reply ${label} #${count}`;
const slowPrompt = (label: string) => `E2E_SLOW_REPLY:${label}`;
const slowReplyPrefix = (label: string) => `E2E slow reply ${label}`;
const slowCountedPrompt = (label: string) => `E2E_SLOW_COUNTED_REPLY:${label}`;
const slowCountedReplyText = (label: string, count: number) =>
  `E2E slow counted reply ${label} #${count}`;

const messagesView = (page: Page) => page.getByTestId('messages-view');
const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();
const conversationPath = (conversationId: string) => `/c/${encodeURIComponent(conversationId)}`;

function contentText(part: TextContentPart): string {
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (part.text?.value) {
    return part.text.value;
  }
  return part.error ?? '';
}

function messageText(message: E2EMessage): string {
  if (message.text) {
    return message.text;
  }
  return message.content?.map(contentText).filter(Boolean).join('\n') ?? '';
}

function sseMessage(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function findMessage(messages: E2EMessage[], text: string, isCreatedByUser?: boolean): E2EMessage {
  const message = messages.find((candidate) => {
    const roleMatches =
      isCreatedByUser === undefined || candidate.isCreatedByUser === isCreatedByUser;
    return roleMatches && messageText(candidate).includes(text);
  });
  if (!message) {
    throw new Error(
      `Expected message containing "${text}". Saw:\n${messages.map(messageText).join('\n---\n')}`,
    );
  }
  return message;
}

function expectParent(
  messages: E2EMessage[],
  childText: string,
  parentText: string,
  childIsUser?: boolean,
) {
  const child = findMessage(messages, childText, childIsUser);
  const parent = findMessage(messages, parentText);
  expect(child.parentMessageId, `${childText} should be a child of ${parentText}`).toBe(
    parent.messageId,
  );
}

function expectNoFoldedMessages(messages: E2EMessage[]) {
  const ids = new Set(messages.map((message) => message.messageId));
  const folded = messages.filter((message) => {
    const parentId = message.parentMessageId;
    return parentId != null && parentId !== '' && parentId !== NO_PARENT && !ids.has(parentId);
  });
  expect(
    folded.map((message) => ({
      text: messageText(message),
      messageId: message.messageId,
      parentMessageId: message.parentMessageId,
    })),
    'messages must not render as parent-less folded children',
  ).toEqual([]);

  const roots = messages.filter((message) => {
    const parentId = message.parentMessageId;
    return parentId == null || parentId === '' || parentId === NO_PARENT;
  });
  expect(
    roots.map((message) => ({
      text: messageText(message),
      isCreatedByUser: message.isCreatedByUser,
    })),
    'only user messages should be roots',
  ).toEqual(roots.map(() => expect.objectContaining({ isCreatedByUser: true })));
}

async function expectVisibleMessages(page: Page, texts: string[]) {
  for (const text of texts) {
    await expect(messagesView(page).getByText(text)).toBeVisible({ timeout: 30000 });
  }
}

async function reloadAndExpectMessages(page: Page, texts: string[]) {
  await page.reload({ timeout: 10000 });
  await expectVisibleMessages(page, texts);
}

async function revisitConversationAndExpectMessages(
  page: Page,
  conversationId: string,
  texts: string[],
) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await page.goto(conversationPath(conversationId), { timeout: 10000 });
  await expectVisibleMessages(page, texts);
}

async function mockActiveOAuthResumeStream({
  page,
  authUrl,
  conversationId,
  parentMessageId,
  pendingPrompt,
  pendingUserMessageId,
  postAuthRunId,
  postAuthText,
}: {
  page: Page;
  authUrl: string;
  conversationId: string;
  parentMessageId: string;
  pendingPrompt: string;
  pendingUserMessageId: string;
  postAuthRunId?: string;
  postAuthText?: string;
}) {
  const pendingResponseMessageId = `${pendingUserMessageId}_`;
  const toolCallId = `${pendingUserMessageId}:Google-Workspace`;
  const stepId = 'step_oauth_login_Google-Workspace';
  const messageStepId = 'step_post_auth_message';
  const resumeState = {
    runSteps: [],
    aggregatedContent: [],
    responseMessageId: pendingResponseMessageId,
    conversationId,
    userMessage: {
      messageId: pendingUserMessageId,
      parentMessageId,
      conversationId,
      text: pendingPrompt,
    },
    replayEvents: [
      {
        event: 'on_run_step',
        data: {
          runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
          id: stepId,
          type: 'tool_calls',
          index: 0,
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [
              {
                id: toolCallId,
                name: 'oauth_mcp_Google-Workspace',
                type: 'tool_call_chunk',
              },
            ],
          },
        },
      },
      {
        event: 'on_run_step_delta',
        data: {
          id: stepId,
          delta: {
            type: 'tool_calls',
            tool_calls: [
              {
                id: toolCallId,
                name: 'oauth_mcp_Google-Workspace',
                type: 'tool_call_chunk',
                args: '',
              },
            ],
            auth: authUrl,
            expires_at: Date.now() + 120000,
          },
        },
      },
    ],
  };
  const streamPayloads: unknown[] = [
    {
      sync: true,
      resumeState,
      pendingEvents: [],
    },
  ];

  if (postAuthText) {
    streamPayloads.push(
      {
        event: 'on_run_step',
        data: {
          runId: postAuthRunId ?? 'USE_PRELIM_RESPONSE_MESSAGE_ID',
          id: messageStepId,
          type: 'message_creation',
          index: 0,
          stepDetails: {
            type: 'message_creation',
            message_creation: {
              message_id: `${pendingResponseMessageId}-post-auth`,
            },
          },
          usage: null,
        },
      },
      {
        event: 'on_message_delta',
        data: {
          id: messageStepId,
          delta: {
            content: [
              {
                type: 'text',
                text: postAuthText,
              },
            ],
          },
        },
      },
    );
  }

  await page.route(`**/api/agents/chat/status/${conversationId}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        active: true,
        streamId: conversationId,
        status: 'running',
        aggregatedContent: [],
        createdAt: Date.now(),
        resumeState,
      }),
    }),
  );

  await page.route(`**/api/agents/chat/stream/${conversationId}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: streamPayloads.map(sseMessage).join(''),
    }),
  );
}

async function mockPreCreatedOAuthStream({
  page,
  authUrl,
  conversationId,
  parentMessageId,
  prompt,
  serverUserMessageId,
  responseMessageId,
  postAuthText,
}: {
  page: Page;
  authUrl: string;
  conversationId: string;
  parentMessageId: string;
  prompt: string;
  serverUserMessageId: string;
  responseMessageId: string;
  postAuthText: string;
}) {
  const toolCallId = `${serverUserMessageId}:Google-Workspace`;
  const oauthStepId = 'step_oauth_login_Google-Workspace';
  const reasoningStepId = 'step_post_auth_reasoning';
  const messageStepId = 'step_post_auth_message';
  const payloads = [
    {
      event: 'on_run_step',
      data: {
        runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
        id: oauthStepId,
        type: 'tool_calls',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [
            {
              id: toolCallId,
              name: 'oauth_mcp_Google-Workspace',
              type: 'tool_call_chunk',
            },
          ],
        },
      },
    },
    {
      event: 'on_run_step_delta',
      data: {
        id: oauthStepId,
        delta: {
          type: 'tool_calls',
          tool_calls: [
            {
              id: toolCallId,
              name: 'oauth_mcp_Google-Workspace',
              type: 'tool_call_chunk',
              args: '',
            },
          ],
          auth: authUrl,
          expires_at: Date.now() + 120000,
        },
      },
    },
    {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: oauthStepId,
          index: 0,
          tool_call: {
            id: toolCallId,
            name: 'oauth_mcp_Google-Workspace',
            args: '',
            output: 'OAuth authentication completed',
            type: 'tool_call',
          },
        },
      },
    },
    {
      created: true,
      message: {
        messageId: serverUserMessageId,
        parentMessageId,
        conversationId,
        sender: 'User',
        text: prompt,
        isCreatedByUser: true,
      },
      streamId: conversationId,
    },
    {
      event: 'on_run_step',
      data: {
        runId: responseMessageId,
        id: reasoningStepId,
        type: 'message_creation',
        index: 0,
        stepDetails: {
          type: 'message_creation',
          message_creation: {
            message_id: `${responseMessageId}-reasoning`,
          },
        },
        usage: null,
      },
    },
    {
      event: 'on_reasoning_delta',
      data: {
        id: reasoningStepId,
        delta: {
          content: [
            {
              type: 'think',
              think: 'The user completed OAuth.',
            },
          ],
        },
      },
    },
    {
      event: 'on_run_step',
      data: {
        runId: responseMessageId,
        id: messageStepId,
        type: 'message_creation',
        index: 1,
        stepDetails: {
          type: 'message_creation',
          message_creation: {
            message_id: `${responseMessageId}-message`,
          },
        },
        usage: null,
      },
    },
    {
      event: 'on_message_delta',
      data: {
        id: messageStepId,
        delta: {
          content: [
            {
              type: 'text',
              text: postAuthText,
              index: 1,
            },
          ],
        },
      },
    },
  ];

  await page.route(`**/api/agents/chat/stream/${conversationId}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: payloads.map(sseMessage).join(''),
    }),
  );
}

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

function isAgentGenerationResponse(response: Response, expectedStatus: number) {
  const { pathname } = new URL(response.url());
  const isAgentsChat = pathname === '/api/agents/chat' || pathname.startsWith('/api/agents/chat/');
  return (
    response.request().method() === 'POST' &&
    isAgentsChat &&
    !pathname.endsWith('/abort') &&
    response.status() === expectedStatus
  );
}

async function waitForGenerationStart(page: Page, action: () => Promise<void>): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(isAgentGenerationStart, { timeout: 30000 }),
    action(),
  ]);
  expect(response.ok()).toBeTruthy();
  return response;
}

async function sendAndExpectReply(page: Page, prompt: string, expectedReply: string) {
  const response = await sendMessage(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(expectedReply)).toBeVisible({ timeout: 30000 });
}

async function submitMessageExpectingGenerationFailure(
  page: Page,
  prompt: string,
  expectedStatus: number,
) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.click();
  await input.fill(prompt);
  const [response] = await Promise.all([
    page.waitForResponse((res) => isAgentGenerationResponse(res, expectedStatus), {
      timeout: 30000,
    }),
    input.press('Enter'),
  ]);
  return response;
}

async function conversationIdFromPage(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop();
  if (!id) {
    throw new Error(`Could not parse conversation id from ${page.url()}`);
  }
  return id;
}

async function fetchMessages(
  page: Page,
  conversationId: string,
  accessToken?: string,
): Promise<E2EMessage[]> {
  const token = accessToken ?? (await getAccessToken(page));
  return fetchJson<E2EMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  );
}

async function postJsonWithStatus(page: Page, path: string, token: string, body: unknown) {
  return page.evaluate(
    async ({ accessToken, requestBody, urlPath }): Promise<JsonResponse> => {
      const response = await fetch(urlPath, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, text, json };
    },
    { accessToken: token, requestBody: body, urlPath: path },
  );
}

async function waitForMessages(
  page: Page,
  conversationId: string,
  predicate: (messages: E2EMessage[]) => boolean,
  description: string,
): Promise<E2EMessage[]> {
  let latest: E2EMessage[] = [];
  const token = await getAccessToken(page);
  for (let attempt = 0; attempt < 80; attempt++) {
    latest = await fetchMessages(page, conversationId, token);
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${description}. Latest messages:\n${latest
      .map(
        (message) => `${message.messageId} <- ${message.parentMessageId}: ${messageText(message)}`,
      )
      .join('\n')}`,
  );
}

async function clickMessageTitleButton(page: Page, messageTextValue: string, title: string) {
  const render = messageRender(page, messageTextValue);
  await render.scrollIntoViewIfNeeded();
  await render.hover();
  await render.getByRole('button', { name: title, exact: true }).last().click();
}

async function clickSibling(page: Page, messageTextValue: string, direction: 'Previous' | 'Next') {
  const render = messageRender(page, messageTextValue);
  await render.scrollIntoViewIfNeeded();
  await render.hover();
  await render.getByRole('button', { name: `${direction} sibling message` }).click();
}

async function expectCanCycleSiblingTexts(page: Page, previousText: string, nextText: string) {
  const previous = messagesView(page).getByText(previousText);
  const next = messagesView(page).getByText(nextText);
  if (await previous.isVisible()) {
    await clickSibling(page, previousText, 'Next');
    await expect(next).toBeVisible();
    await clickSibling(page, nextText, 'Previous');
    await expect(previous).toBeVisible();
    return;
  }

  if (await next.isVisible()) {
    await clickSibling(page, nextText, 'Previous');
    await expect(previous).toBeVisible();
    await clickSibling(page, previousText, 'Next');
    await expect(next).toBeVisible();
    return;
  }

  throw new Error(`Expected either sibling "${previousText}" or "${nextText}" to be visible`);
}

async function clickForkVisibleMessages(
  page: Page,
  messageTextValue: string,
): Promise<ForkResponse> {
  const render = messageRender(page, messageTextValue);
  await render.scrollIntoViewIfNeeded();
  await render.hover();
  await render.getByRole('button', { name: 'Open Fork Menu' }).click();

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        res.url().includes('/api/convos/fork') &&
        res.status() === 200,
      { timeout: 30000 },
    ),
    page.getByRole('button', { name: 'Visible messages only', exact: true }).click(),
  ]);

  return (await response.json()) as ForkResponse;
}

test.describe('message tree stream operations', () => {
  test.setTimeout(180000);

  test('streams follow-ups and keeps an aborted response as the next parent', async ({ page }) => {
    const label = uniqueLabel('abort');
    const firstPrompt = replyPrompt(`${label}-first`);
    const firstReply = replyText(`${label}-first`);
    const secondPrompt = replyPrompt(`${label}-second`);
    const secondReply = replyText(`${label}-second`);
    const abortPrompt = slowPrompt(`${label}-stop`);
    const abortReply = slowReplyPrefix(`${label}-stop`);
    const afterAbortPrompt = replyPrompt(`${label}-after-stop`);
    const afterAbortReply = replyText(`${label}-after-stop`);

    await openMockChat(page);
    await sendAndExpectReply(page, firstPrompt, firstReply);
    const conversationId = await conversationIdFromPage(page);
    await sendAndExpectReply(page, secondPrompt, secondReply);

    const slowStart = await sendMessage(page, abortPrompt);
    expect(slowStart.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(abortReply)).toBeVisible({ timeout: 30000 });

    const [abortResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/agents/chat/abort'),
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: 'Stop generating' }).click(),
    ]);
    expect(abortResponse.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30000,
    });

    let messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(abortReply)),
      'aborted response to persist',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, secondPrompt, firstReply, true);
    expectParent(messages, abortReply, abortPrompt, false);

    await sendAndExpectReply(page, afterAbortPrompt, afterAbortReply);
    messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(afterAbortReply)),
      'follow-up after abort',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, afterAbortPrompt, abortReply, true);
    expectParent(messages, afterAbortReply, afterAbortPrompt, false);

    await reloadAndExpectMessages(page, [firstReply, secondReply, abortReply, afterAbortReply]);
    await revisitConversationAndExpectMessages(page, conversationId, [
      firstReply,
      secondReply,
      abortReply,
      afterAbortReply,
    ]);
  });

  test('regenerates assistant siblings, cycles branches, follows up, and forks the visible branch', async ({
    page,
  }) => {
    const label = uniqueLabel('regen');
    const prompt = countedPrompt(label);
    const firstReply = countedReplyText(label, 1);
    const regeneratedReply = countedReplyText(label, 2);
    const followPrompt = replyPrompt(`${label}-follow`);
    const followReply = replyText(`${label}-follow`);

    await openMockChat(page);
    await sendAndExpectReply(page, prompt, firstReply);
    const originalConversationId = await conversationIdFromPage(page);

    await waitForGenerationStart(page, () =>
      clickMessageTitleButton(page, firstReply, 'Regenerate'),
    );
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible({ timeout: 30000 });

    await clickSibling(page, regeneratedReply, 'Previous');
    await expect(messagesView(page).getByText(firstReply)).toBeVisible();
    await expect(messagesView(page).getByText(regeneratedReply)).toBeHidden();
    await clickSibling(page, firstReply, 'Next');
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible();

    await sendAndExpectReply(page, followPrompt, followReply);
    let messages = await waitForMessages(
      page,
      originalConversationId,
      (items) => items.some((message) => messageText(message).includes(followReply)),
      'follow-up after regenerate',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, firstReply, prompt, false);
    expectParent(messages, regeneratedReply, prompt, false);
    expectParent(messages, followPrompt, regeneratedReply, true);
    expectParent(messages, followReply, followPrompt, false);

    const userMessage = findMessage(messages, prompt, true);
    const assistantSiblings = messages.filter(
      (message) => message.parentMessageId === userMessage.messageId && !message.isCreatedByUser,
    );
    expect(assistantSiblings.map(messageText).sort()).toEqual(
      [firstReply, regeneratedReply].sort(),
    );

    await reloadAndExpectMessages(page, [regeneratedReply, followReply]);
    await revisitConversationAndExpectMessages(page, originalConversationId, [
      regeneratedReply,
      followReply,
    ]);
    await clickSibling(page, regeneratedReply, 'Previous');
    await expect(messagesView(page).getByText(firstReply)).toBeVisible();
    const fork = await clickForkVisibleMessages(page, firstReply);
    const forkedConversationId = fork.conversation.conversationId;
    if (!forkedConversationId) {
      throw new Error('Expected fork response to include a conversation id');
    }
    await expect(page).toHaveURL(new RegExp(`/c/${forkedConversationId}$`));

    messages = fork.messages;
    expectNoFoldedMessages(messages);
    expect(messages.some((message) => messageText(message).includes(firstReply))).toBe(true);
    expect(messages.some((message) => messageText(message).includes(regeneratedReply))).toBe(false);
    expect(messages.some((message) => messageText(message).includes(followReply))).toBe(false);
  });

  test('shows the regenerating response immediately when regenerating a non-latest sibling', async ({
    page,
  }) => {
    // A parent with multiple siblings, switched to an older one, then
    // regenerated: the optimistic slice drops the target but keeps the other
    // siblings, so the child count is unchanged and MultiMessage's
    // length-change reset never fires. Without an explicit focus the view stays
    // on the kept (newer) sibling and the streaming response is hidden until the
    // server restores the dropped sibling at finalize. A slow reply keeps the
    // stream open long enough to assert the during-stream state.
    const label = uniqueLabel('regen-nonlatest');
    const prompt = slowCountedPrompt(label);
    const reply1 = slowCountedReplyText(label, 1);
    const reply2 = slowCountedReplyText(label, 2);
    const reply3 = slowCountedReplyText(label, 3);
    const stopButton = page.getByRole('button', { name: 'Stop generating' });

    await openMockChat(page);
    await sendMessage(page, prompt);
    await expect(messagesView(page).getByText(reply1)).toBeVisible({ timeout: 30000 });
    await expect(stopButton).toBeHidden({ timeout: 30000 });

    // First regenerate adds a sibling; the parent now has two responses.
    await waitForGenerationStart(page, () => clickMessageTitleButton(page, reply1, 'Regenerate'));
    await expect(messagesView(page).getByText(reply2)).toBeVisible({ timeout: 30000 });
    await expect(stopButton).toBeHidden({ timeout: 30000 });

    // View the older sibling, then regenerate it (the non-latest one).
    await clickSibling(page, reply2, 'Previous');
    await expect(messagesView(page).getByText(reply1)).toBeVisible();
    await expect(messagesView(page).getByText(reply2)).toBeHidden();

    await waitForGenerationStart(page, () => clickMessageTitleButton(page, reply1, 'Regenerate'));
    // Still streaming (slow reply): the regenerating response must be visible
    // now — not the kept sibling — and well before finalize.
    await expect(stopButton).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(reply3)).toBeVisible({ timeout: 4000 });
    await expect(messagesView(page).getByText(reply2)).toBeHidden();

    // It stays put after finalize too.
    await expect(stopButton).toBeHidden({ timeout: 30000 });
    await expect(messagesView(page).getByText(reply3)).toBeVisible();
  });

  test('does not flash the kept sibling before the created event when regenerating a non-latest sibling', async ({
    page,
  }) => {
    // Same hazard at the optimistic (pre-`created`) render: useChatFunctions
    // appends the placeholder and renders it before the request resolves. Gate
    // the regenerate request so only that optimistic frame is on screen — with
    // no `created` event to fall back on — and assert the kept sibling is
    // already gone (the regenerating placeholder took its place). This isolates
    // the optimistic focus; the createdHandler focus cannot mask a regression
    // because `created` never arrives during the assertion.
    const label = uniqueLabel('regen-precreated');
    const prompt = countedPrompt(label);
    const reply1 = countedReplyText(label, 1);
    const reply2 = countedReplyText(label, 2);
    const reply3 = countedReplyText(label, 3);

    await openMockChat(page);
    await sendAndExpectReply(page, prompt, reply1);

    await waitForGenerationStart(page, () => clickMessageTitleButton(page, reply1, 'Regenerate'));
    await expect(messagesView(page).getByText(reply2)).toBeVisible({ timeout: 30000 });

    await clickSibling(page, reply2, 'Previous');
    await expect(messagesView(page).getByText(reply1)).toBeVisible();
    await expect(messagesView(page).getByText(reply2)).toBeHidden();

    // Hold the SSE stream so the `created` event cannot arrive: the optimistic
    // render is all there is. The chat POST returns a stream id; the stream
    // itself is a separate GET (/api/agents/chat/stream/<id>) — gate that one,
    // not the POST, which must complete to hand back the id.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/agents\/chat\/stream\//, async (route: Route) => {
      await gate;
      return route.continue();
    });

    try {
      await clickMessageTitleButton(page, reply1, 'Regenerate');
      // The stream is gated, so the regenerating response has no text yet.
      await expect(messagesView(page).getByText(reply3)).toBeHidden();
      // Pre-`created` window: the kept sibling must not be the one on screen —
      // the regenerating placeholder has already taken its place.
      await expect(messagesView(page).getByText(reply2)).toBeHidden({ timeout: 5000 });
      await expect(messagesView(page).getByText(reply1)).toBeHidden();
    } finally {
      release();
    }

    await expect(messagesView(page).getByText(reply3)).toBeVisible({ timeout: 30000 });
  });

  test('resumes pending OAuth on the selected older branch after reload', async ({ page }) => {
    const label = uniqueLabel('oauth-branch');
    const rootPrompt = countedPrompt(`${label}-root`);
    const firstReply = countedReplyText(`${label}-root`, 1);
    const regeneratedReply = countedReplyText(`${label}-root`, 2);
    const followPrompt = replyPrompt(`${label}-follow`);
    const followReply = replyText(`${label}-follow`);
    const pendingPrompt = replyPrompt(`${label}-oauth`);

    await openMockChat(page);
    await sendAndExpectReply(page, rootPrompt, firstReply);
    const conversationId = await conversationIdFromPage(page);
    await sendAndExpectReply(page, followPrompt, followReply);

    await waitForGenerationStart(page, () =>
      clickMessageTitleButton(page, firstReply, 'Regenerate'),
    );
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible({ timeout: 30000 });

    await clickSibling(page, regeneratedReply, 'Previous');
    await expectVisibleMessages(page, [firstReply, followPrompt, followReply]);
    await expect(messagesView(page).getByText(regeneratedReply)).toBeHidden();

    const messages = await waitForMessages(
      page,
      conversationId,
      (items) =>
        items.some((message) => messageText(message).includes(followReply)) &&
        items.some((message) => messageText(message).includes(regeneratedReply)),
      'two-branch conversation',
    );
    const branchOneTail = findMessage(messages, followReply, false);

    await mockActiveOAuthResumeStream({
      page,
      conversationId,
      parentMessageId: branchOneTail.messageId,
      pendingPrompt,
      pendingUserMessageId: `${label}-pending-user`,
      authUrl: `https://auth.example.test/${label}`,
    });

    await page.reload({ timeout: 10000 });
    await expectVisibleMessages(page, [firstReply, followPrompt, followReply, pendingPrompt]);
    await expect(messagesView(page).getByText(regeneratedReply)).toBeHidden();
  });

  test('keeps existing messages visible when resumed OAuth streams post-auth content', async ({
    page,
  }) => {
    const label = uniqueLabel('oauth-post-auth');
    const rootPrompt = replyPrompt(`${label}-root`);
    const rootReply = replyText(`${label}-root`);
    const pendingPrompt = replyPrompt(`${label}-pending`);
    const postAuthText = `E2E post-auth OAuth reply ${label}`;

    await openMockChat(page);
    await sendAndExpectReply(page, rootPrompt, rootReply);
    const conversationId = await conversationIdFromPage(page);

    const messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(rootReply)),
      'root reply before OAuth resume',
    );
    const branchTail = findMessage(messages, rootReply, false);

    await mockActiveOAuthResumeStream({
      page,
      conversationId,
      parentMessageId: branchTail.messageId,
      pendingPrompt,
      pendingUserMessageId: `${label}-pending-user`,
      authUrl: `https://auth.example.test/${label}`,
      postAuthRunId: `${label}-stable-response`,
      postAuthText,
    });

    await page.reload({ timeout: 10000 });
    await expectVisibleMessages(page, [rootPrompt, rootReply, pendingPrompt, postAuthText]);
  });

  test('keeps existing messages visible when OAuth completes before created', async ({ page }) => {
    const label = uniqueLabel('oauth-pre-created');
    const rootPrompt = replyPrompt(`${label}-root`);
    const rootReply = replyText(`${label}-root`);
    const followPrompt = replyPrompt(`${label}-follow`);
    const postAuthText = `E2E pre-created OAuth reply ${label}`;

    await openMockChat(page);
    await sendAndExpectReply(page, rootPrompt, rootReply);
    const conversationId = await conversationIdFromPage(page);

    const messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(rootReply)),
      'root reply before pre-created OAuth stream',
    );
    const branchTail = findMessage(messages, rootReply, false);

    await mockPreCreatedOAuthStream({
      page,
      conversationId,
      parentMessageId: branchTail.messageId,
      prompt: followPrompt,
      serverUserMessageId: `${label}-server-user`,
      responseMessageId: `${label}-response`,
      authUrl: `https://auth.example.test/${label}`,
      postAuthText,
    });

    const response = await sendMessage(page, followPrompt);
    expect(response.ok()).toBeTruthy();
    await expectVisibleMessages(page, [rootPrompt, rootReply, followPrompt, postAuthText]);
  });

  test('long threads retain regenerated and save-and-submit branches after revisit', async ({
    page,
  }) => {
    const label = uniqueLabel('save-submit');
    const rootPrompt = replyPrompt(`${label}-root`);
    const rootReply = replyText(`${label}-root`);
    const firstPrompt = replyPrompt(`${label}-first`);
    const firstReply = replyText(`${label}-first`);
    const middlePrompt = replyPrompt(`${label}-middle`);
    const middleReply = replyText(`${label}-middle`);
    const fourthPrompt = replyPrompt(`${label}-fourth`);
    const fourthReply = replyText(`${label}-fourth`);
    const tailPrompt = countedPrompt(`${label}-tail`);
    const tailReply = countedReplyText(`${label}-tail`, 1);
    const regeneratedTailReply = countedReplyText(`${label}-tail`, 2);
    const editedMiddlePrompt = replyPrompt(`${label}-middle-edited`);
    const editedMiddleReply = replyText(`${label}-middle-edited`);
    const afterEditPrompt = replyPrompt(`${label}-after-edit`);
    const afterEditReply = replyText(`${label}-after-edit`);

    await openMockChat(page);
    await sendAndExpectReply(page, rootPrompt, rootReply);
    const conversationId = await conversationIdFromPage(page);
    await sendAndExpectReply(page, firstPrompt, firstReply);
    await sendAndExpectReply(page, middlePrompt, middleReply);
    await sendAndExpectReply(page, fourthPrompt, fourthReply);
    await sendAndExpectReply(page, tailPrompt, tailReply);

    await waitForGenerationStart(page, () =>
      clickMessageTitleButton(page, tailReply, 'Regenerate'),
    );
    await expect(messagesView(page).getByText(regeneratedTailReply)).toBeVisible({
      timeout: 30000,
    });

    await clickMessageTitleButton(page, middlePrompt, 'Edit');
    const editor = page.getByTestId('message-text-editor');
    await expect(editor).toBeVisible();
    await editor.fill(editedMiddlePrompt);
    await waitForGenerationStart(page, () =>
      page.getByRole('button', { name: 'Update & rerun' }).click(),
    );
    await expect(messagesView(page).getByText(editedMiddleReply)).toBeVisible({ timeout: 30000 });

    let messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(editedMiddleReply)),
      'save-and-submit edited branch',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, firstPrompt, rootReply, true);
    expectParent(messages, firstReply, firstPrompt, false);
    expectParent(messages, middlePrompt, firstReply, true);
    expectParent(messages, middleReply, middlePrompt, false);
    expectParent(messages, fourthPrompt, middleReply, true);
    expectParent(messages, fourthReply, fourthPrompt, false);
    expectParent(messages, tailPrompt, fourthReply, true);
    expectParent(messages, tailReply, tailPrompt, false);
    expectParent(messages, regeneratedTailReply, tailPrompt, false);
    expectParent(messages, editedMiddlePrompt, firstReply, true);
    expectParent(messages, editedMiddleReply, editedMiddlePrompt, false);

    await clickSibling(page, editedMiddlePrompt, 'Previous');
    await expectVisibleMessages(page, [middlePrompt, fourthReply]);
    await expectCanCycleSiblingTexts(page, tailReply, regeneratedTailReply);
    await clickSibling(page, middlePrompt, 'Next');
    await expectVisibleMessages(page, [editedMiddlePrompt, editedMiddleReply]);

    await sendAndExpectReply(page, afterEditPrompt, afterEditReply);
    messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(afterEditReply)),
      'follow-up after save-and-submit branch',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, afterEditPrompt, editedMiddleReply, true);
    expectParent(messages, afterEditReply, afterEditPrompt, false);
    expect(messages.some((message) => messageText(message).includes(tailReply))).toBe(true);
    expect(messages.some((message) => messageText(message).includes(regeneratedTailReply))).toBe(
      true,
    );

    await reloadAndExpectMessages(page, [rootReply, firstReply, editedMiddleReply, afterEditReply]);
    await revisitConversationAndExpectMessages(page, conversationId, [
      rootReply,
      firstReply,
      editedMiddleReply,
      afterEditReply,
    ]);
    await clickSibling(page, editedMiddlePrompt, 'Previous');
    await expectVisibleMessages(page, [middlePrompt, fourthReply]);
    await expectCanCycleSiblingTexts(page, tailReply, regeneratedTailReply);
    await clickSibling(page, middlePrompt, 'Next');
    await expectVisibleMessages(page, [editedMiddlePrompt, editedMiddleReply, afterEditReply]);
  });

  /** Regression: the editor's submit button was disabled until the draft differed, so
   *  reissuing a cancelled request or one that failed on a since-restarted backend meant
   *  typing a throwaway character first. An untouched draft reruns as-is. */
  test('reruns an untouched user request from the editor', async ({ page }) => {
    const label = uniqueLabel('rerun-untouched');
    const prompt = countedPrompt(label);
    const firstReply = countedReplyText(label, 1);
    const secondReply = countedReplyText(label, 2);

    await openMockChat(page);
    await sendAndExpectReply(page, prompt, firstReply);
    const conversationId = await conversationIdFromPage(page);

    await clickMessageTitleButton(page, prompt, 'Edit');
    const editor = page.getByTestId('message-text-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(prompt);

    const rerun = page.getByRole('button', { name: 'Rerun', exact: true });
    await expect(rerun).toBeEnabled();
    /** Nothing to save, so that button stays out of reach; the rerun does not. */
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await waitForGenerationStart(page, () => rerun.click());

    await expect(messagesView(page).getByText(secondReply)).toBeVisible({ timeout: 30000 });

    const messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(secondReply)),
      'rerun of an untouched request',
    );
    /** Reissued verbatim: a second user turn carrying exactly the original text. */
    const reissued = messages.filter(
      (message) => message.isCreatedByUser === true && messageText(message) === prompt,
    );
    expect(reissued).toHaveLength(2);
  });

  test('error responses remain valid parents for follow-ups', async ({ page }) => {
    const label = uniqueLabel('error');
    const basePrompt = replyPrompt(`${label}-base`);
    const baseReply = replyText(`${label}-base`);
    const errorPrompt = `E2E_FORCED_ERROR:${label}`;
    const providerError = `E2E forced stream error ${label}`;
    const errorText = 'The model provider could not complete this request.';
    /** No content policy is configured here, so the failure keeps the provider's own words. */
    const errorPayload = `${errorText}\n${JSON.stringify({
      type: 'upstream_model_error',
      message: providerError,
    })}`;
    const afterErrorPrompt = replyPrompt(`${label}-after-error`);
    const afterErrorReply = replyText(`${label}-after-error`);

    await openMockChat(page);
    await sendAndExpectReply(page, basePrompt, baseReply);
    const conversationId = await conversationIdFromPage(page);

    await sendAndExpectReply(page, errorPrompt, errorText);
    await expect(messagesView(page).getByText(errorText)).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(providerError)).toBeVisible();

    await sendAndExpectReply(page, afterErrorPrompt, afterErrorReply);
    const messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(afterErrorReply)),
      'follow-up after error',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, errorPrompt, baseReply, true);
    expectParent(messages, errorPayload, errorPrompt, false);
    expectParent(messages, afterErrorPrompt, errorPayload, true);
    expectParent(messages, afterErrorReply, afterErrorPrompt, false);

    await reloadAndExpectMessages(page, [baseReply, errorText, afterErrorReply]);
    await revisitConversationAndExpectMessages(page, conversationId, [
      baseReply,
      errorText,
      afterErrorReply,
    ]);
  });

  test('rejects normal follow-ups whose parent is a preliminary assistant placeholder', async ({
    page,
  }) => {
    const label = uniqueLabel('placeholder-parent');
    const basePrompt = replyPrompt(`${label}-base`);
    const baseReply = replyText(`${label}-base`);
    const followPrompt = replyPrompt(`${label}-follow`);

    await openMockChat(page);
    await sendAndExpectReply(page, basePrompt, baseReply);
    const conversationId = await conversationIdFromPage(page);
    const token = await getAccessToken(page);

    const beforeMessages = await fetchMessages(page, conversationId, token);
    const stableParent = findMessage(beforeMessages, baseReply, false);
    const response = await postJsonWithStatus(
      page,
      `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
      token,
      {
        text: followPrompt,
        sender: 'User',
        clientTimestamp: new Date().toLocaleString('sv').replace(' ', 'T'),
        isCreatedByUser: true,
        parentMessageId: `${stableParent.messageId}_`,
        conversationId,
        messageId: `${label}-user-message`,
        endpoint: MOCK_ENDPOINTS[0].label,
        endpointType: 'custom',
        model: MOCK_ENDPOINTS[0].model,
        spec: 'e2e-mock-provider-a',
        isTemporary: false,
        isRegenerate: false,
        error: false,
      },
    );

    expect(response.status).toBe(409);
    expect(response.json).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('selected parent response is still being saved'),
      }),
    );

    const afterMessages = await fetchMessages(page, conversationId, token);
    expect(afterMessages.map((message) => message.messageId).sort()).toEqual(
      beforeMessages.map((message) => message.messageId).sort(),
    );
    expect(afterMessages.some((message) => messageText(message).includes(followPrompt))).toBe(
      false,
    );
    expectNoFoldedMessages(afterMessages);
  });

  test('generation-start failures recover without folding the next follow-up', async ({ page }) => {
    const label = uniqueLabel('start-error');
    const basePrompt = replyPrompt(`${label}-base`);
    const baseReply = replyText(`${label}-base`);
    const failedPrompt = replyPrompt(`${label}-failed-start`);
    const failedText = `E2E generation start failure ${label}`;
    const afterFailurePrompt = replyPrompt(`${label}-after-start-failure`);
    const afterFailureReply = replyText(`${label}-after-start-failure`);

    await openMockChat(page);
    await sendAndExpectReply(page, basePrompt, baseReply);
    const conversationId = await conversationIdFromPage(page);

    const failGenerationStart = async (route: Route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const isAgentsChat =
        pathname === '/api/agents/chat' || pathname.startsWith('/api/agents/chat/');
      if (
        request.method() !== 'POST' ||
        !isAgentsChat ||
        pathname.endsWith('/abort') ||
        !request.postData()?.includes(failedPrompt)
      ) {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: failedText }),
      });
    };
    await page.route('**/api/agents/chat**', failGenerationStart);

    const failure = await submitMessageExpectingGenerationFailure(page, failedPrompt, 500);
    expect(failure.ok()).toBe(false);
    await expect(messagesView(page).getByText(failedText)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled({
      timeout: 30000,
    });
    await page.unroute('**/api/agents/chat**', failGenerationStart);

    await sendAndExpectReply(page, afterFailurePrompt, afterFailureReply);
    const messages = await waitForMessages(
      page,
      conversationId,
      (items) => items.some((message) => messageText(message).includes(afterFailureReply)),
      'follow-up after generation-start failure',
    );
    expectNoFoldedMessages(messages);
    expectParent(messages, afterFailurePrompt, baseReply, true);
    expectParent(messages, afterFailureReply, afterFailurePrompt, false);
    expect(messages.some((message) => messageText(message).includes(failedPrompt))).toBe(false);
    expect(messages.some((message) => messageText(message).includes(failedText))).toBe(false);

    await reloadAndExpectMessages(page, [baseReply, afterFailureReply]);
    await expect(messagesView(page).getByText(failedText)).toBeHidden();
    await revisitConversationAndExpectMessages(page, conversationId, [
      baseReply,
      afterFailureReply,
    ]);
    await expect(messagesView(page).getByText(failedText)).toBeHidden();
  });
});
