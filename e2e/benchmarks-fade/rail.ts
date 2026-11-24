import type { Page } from '@playwright/test';
import type { BenchChat, ExportedMessage } from './chats';
import { MOCK_ENDPOINTS, getAccessToken, requestJson } from '../specs/mock/helpers';
import { withMongo } from '../specs/mock/db';

/**
 * Background work for the session rail to list, without running any: the seeded conversation
 * becomes an agent's, and its task and subagent indexes are answered from here. The running
 * tools are tool calls the thread already holds, so the rail titles them from the loaded
 * messages, which is the pass it makes on every update of a streaming thread.
 */

const RUNNING_TOOLS = 6;
const FINISHED_TOOLS = 4;
const RAIL_TOGGLE = 'header-background-tasks-button';

type Call = { messageId: string; id: string; name: string };

function toolCalls(messages: ExportedMessage[]): Call[] {
  const calls: Call[] = [];
  for (const message of messages) {
    for (const part of message.content ?? []) {
      const call = part.tool_call as { id?: string; name?: string } | undefined;
      if (part.type === 'tool_call' && call?.id != null) {
        calls.push({ messageId: message.messageId, id: call.id, name: call.name ?? 'tool' });
      }
    }
  }
  return calls;
}

/** Returns the conversation fields a run's final frame must keep, so the rail keeps its rows. */
export async function stageBackgroundWork(
  page: Page,
  chat: BenchChat,
  messages: ExportedMessage[],
): Promise<Record<string, unknown>> {
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: `Rail bench ${chat.id.slice(0, 8)}`,
      description: 'Session rail benchmark.',
      instructions: 'Follow the request.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
  await withMongo((db) =>
    db
      .collection('conversations')
      .updateOne(
        { conversationId: chat.id },
        { $set: { endpoint: 'agents', agent_id: agent.id }, $unset: { endpointType: '' } },
      ),
  );

  const now = Date.now();
  const calls = toolCalls(messages).slice(-(RUNNING_TOOLS + FINISHED_TOOLS));
  const tasks = calls.map((call, index) => {
    const running = index >= calls.length - RUNNING_TOOLS;
    return {
      taskId: `task-${index}`,
      toolName: call.name,
      toolCallId: call.id,
      messageId: call.messageId,
      status: running ? 'running' : 'completed',
      cancellationRequested: false,
      startedAt: new Date(now - 90_000 - index * 1_000).toISOString(),
      ...(running ? {} : { settledAt: new Date(now - 30_000).toISOString() }),
    };
  });
  const children = [
    'Audit the cache paths',
    'Draft the changelog',
    'Find the open pull requests',
  ].map((title, index) => ({
    threadId: `thread-${index}`,
    parentMessageId: messages[messages.length - 1].messageId,
    parentToolCallId: `call-child-${index}`,
    subagentType: 'researcher',
    subagentKind: 'agent',
    title,
    origin: 'tool',
    status: 'completed',
    updatedAt: new Date(now - 20_000).toISOString(),
    latestTaskId: `child-task-${index}`,
    tasks: [
      {
        taskId: `child-task-${index}`,
        status: 'completed',
        createdAt: new Date(now - 200_000).toISOString(),
      },
    ],
    tasksTruncated: false,
  }));
  const id = encodeURIComponent(chat.id);
  await page.route(
    (url) => url.pathname.endsWith(`/api/convos/${id}/background-tasks`),
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ conversationId: chat.id, cancellable: true, complete: true, tasks }),
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith(`/api/convos/${id}/subagents`),
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          parentConversationId: chat.id,
          children,
          childrenTruncated: false,
        }),
      }),
  );
  return { endpoint: 'agents', agent_id: agent.id };
}

/** Waits until the header's control has counted the staged work, then leaves the rail as asked. */
export async function setRail(page: Page, open: boolean): Promise<number> {
  await page.waitForFunction(
    (testId) =>
      /running/.test(
        document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-label') ?? '',
      ),
    RAIL_TOGGLE,
    { timeout: 30_000 },
  );
  const isOpen = () =>
    page.evaluate(() => document.querySelector('[data-testid="session-rail"]') != null);
  if ((await isOpen()) !== open) {
    await page.evaluate((testId) => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
    }, RAIL_TOGGLE);
  }
  await page.waitForTimeout(1_500);
  return page.evaluate(() => document.querySelectorAll('[data-testid="session-row"]').length);
}
