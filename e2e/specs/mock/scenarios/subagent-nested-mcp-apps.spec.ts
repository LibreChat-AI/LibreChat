import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getE2EUser } from '../../../setup/user';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

const appAttachment = (
  conversationId: string,
  messageId: string,
  toolCallId: string,
  toolName = toolCallId,
) => ({
  type: 'ui_resources',
  messageId,
  conversationId,
  toolCallId,
  ui_resources: [
    {
      uri: `ui://e2e-app/${toolCallId}`,
      mimeType: 'text/html;profile=mcp-app',
      text: '<p>app</p>',
      toolName,
      serverName: 'e2e-app',
    },
  ],
});

const appToolCall = (id: string) => ({
  type: 'tool_call',
  tool_call: { id, name: 'show_app_mcp_e2e-app', args: '{}', output: 'Shown', progress: 1 },
});

/** The harness enables MCP Apps only in its dedicated fixture profile, so each test sets
 *  the deployment policy in the startup config the client reads. */
async function setMCPAppsPolicy(page: Page, enabled: boolean) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as { mcpApps?: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { ...config, mcpApps: { ...config.mcpApps, enabled, legacyHtmlEnabled: true } },
    });
  });
}

async function seedTurn() {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const suffix = conversationId.slice(0, 8);
  const calls = {
    child: `child-app-${suffix}`,
    grandchild: `grandchild-app-${suffix}`,
    direct: `direct-app-${suffix}`,
  };
  const messages = [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Ask the helper to open the dashboard.',
    },
    {
      messageId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: `subagent-${suffix}`,
            name: 'subagent',
            args: JSON.stringify({ subagent_type: 'self', description: 'Open the dashboard' }),
            output: 'The helper opened the dashboard.',
            progress: 1,
            subagent_content: [
              appToolCall(calls.child),
              {
                type: 'tool_call',
                tool_call: {
                  id: `nested-subagent-${suffix}`,
                  name: 'subagent',
                  args: JSON.stringify({ subagent_type: 'self', description: 'Open the chart' }),
                  output: 'Opened the chart.',
                  progress: 1,
                  subagent_content: [appToolCall(calls.grandchild)],
                },
              },
            ],
          },
        },
        { type: 'text', text: 'The helper is done.' },
        appToolCall(calls.direct),
        { type: 'text', text: 'Here is the dashboard.' },
      ],
      attachments: Object.values(calls).map((id) => appAttachment(conversationId, messageId, id)),
    },
  ] as SeedMessage[];

  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Subagent MCP Apps', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, messages);
  return { conversationId, messageId, calls };
}

/** Two standalone subagent runs, kept apart by prose, whose tools each open the same App. */
async function seedSeparateRuns() {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const suffix = conversationId.slice(0, 8);
  const children = [`first-app-${suffix}`, `second-app-${suffix}`];
  const run = (index: number) => ({
    type: 'tool_call',
    tool_call: {
      id: `subagent-${index}-${suffix}`,
      name: 'subagent',
      args: JSON.stringify({ subagent_type: 'self', description: `Open dashboard ${index}` }),
      output: `Opened dashboard ${index}.`,
      progress: 1,
      subagent_content: [appToolCall(children[index])],
    },
  });
  const messages = [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Open both dashboards.',
    },
    {
      messageId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: [
        run(0),
        { type: 'text', text: 'The first dashboard is open.' },
        run(1),
        { type: 'text', text: 'Both dashboards are open.' },
      ],
      attachments: children.map((id) =>
        appAttachment(conversationId, messageId, id, 'show_dashboard'),
      ),
    },
  ] as SeedMessage[];

  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Separate subagent Apps', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, messages);
  return { conversationId, messageId };
}

async function openTurn(page: Page, conversationId: string) {
  const loaded = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/messages/${conversationId}`) && response.status() === 200,
  );
  await page.goto(`/c/${conversationId}`);
  /** Only meaningful while the route sends the subagent call as a preview, the
   *  default load, which omits the transcript the child tool calls live in. */
  expect(JSON.stringify(await (await loaded).json())).toContain('"subagentContentOmitted":true');
}

/** The subagent's own tool calls exist only inside `subagent_content`, the shape the
 *  backend persists at save time, so the turn is seeded in that stored shape and read
 *  back through the messages route. */
test('an MCP App a subagent tool produced renders once under the standalone subagent @scenario:subagent-nested-mcp-apps-render', async ({
  page,
}) => {
  const { conversationId, messageId, calls } = await seedTurn();
  await setMCPAppsPolicy(page, true);

  try {
    await openTurn(page, conversationId);
    const message = page.locator(`[id="${messageId}"]`);
    await expect(message.getByText('Here is the dashboard.')).toBeVisible();
    for (const id of Object.values(calls)) {
      const view = message.locator(`[data-mcp-app-view="${id}"]`);
      await expect(view).toHaveCount(1);
      await expect(view.getByRole('button', { name: new RegExp(id) })).toBeVisible();
    }

    await page.reload();
    for (const id of [calls.child, calls.grandchild]) {
      await expect(message.locator(`[data-mcp-app-view="${id}"]`)).toHaveCount(1);
    }
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});

test('a subagent MCP App stays hidden while the deployment disables MCP Apps @scenario:subagent-nested-mcp-apps-policy-off', async ({
  page,
}) => {
  const { conversationId, messageId } = await seedTurn();
  await setMCPAppsPolicy(page, false);

  try {
    await openTurn(page, conversationId);
    const message = page.locator(`[id="${messageId}"]`);
    await expect(message.getByText('Here is the dashboard.')).toBeVisible();
    await expect(message.getByText('The helper is done.')).toBeVisible();
    await expect(message.locator('[data-mcp-app-view]')).toHaveCount(0);
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});

test('the same App opened by two separate subagent runs gets a distinct control name for each @scenario:subagent-nested-mcp-apps-distinct-names', async ({
  page,
}) => {
  const { conversationId, messageId } = await seedSeparateRuns();
  await setMCPAppsPolicy(page, true);

  try {
    await openTurn(page, conversationId);
    const message = page.locator(`[id="${messageId}"]`);
    await expect(message.getByText('Both dashboards are open.')).toBeVisible();
    await expect(message.locator('[data-mcp-app-view="show_dashboard"]')).toHaveCount(2);
    for (const ordinal of [1, 2]) {
      await expect(
        message.getByRole('button', {
          name: `Open app: show_dashboard (${ordinal})`,
          exact: true,
        }),
      ).toBeVisible();
    }
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});
