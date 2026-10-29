import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';
import {
  withMongo,
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessage } from '../helpers';
import { getE2EUser } from '../../../setup/user';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const STREAM_ROUTE = /\/api\/agents\/chat\/stream\//;
/** 8x8 opaque PNG, enough for the browser to decode the image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=',
  'base64',
);

type LateFile = {
  /** The child call of the subagent run the file was saved under. */
  childCall: string;
  /** The agent the subagent run belongs to, stamped on its part and on the file. */
  childAgent?: string;
  /** Whether a top-level call of the response reuses the child's provider id. */
  reused?: boolean;
  /** Whether the file is saved on the message before it streams; a harvest can stream it first. */
  saved?: boolean;
};

/** A subagent's background tool can deliver its file after the conversation was loaded: the
 *  load previewed the settled subagent call before any file existed, so the preview names no
 *  child call to route it to, and only the stored transcript holds that call. The file is
 *  persisted onto the original message (as the harvest does, unless `saved` is false) and
 *  re-emitted on a later turn's live stream, the way a `check_background_task` poll delivers it. */
async function deliverLateFile(
  page: Page,
  { childCall, childAgent, reused, saved = true }: LateFile,
) {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const suffix = conversationId.slice(0, 8);
  const attachment = {
    file_id: `${childCall}-${suffix}-file`,
    filename: `${childCall}-${suffix}.png`,
    filepath: `/images/e2e-subagent-late/${childCall}-${suffix}.png`,
    type: 'image/png',
    source: 'local',
    bytes: PNG.length,
    width: 8,
    height: 8,
    messageId,
    conversationId,
    toolCallId: childCall,
    ...(childAgent != null ? { agentId: childAgent } : {}),
  };
  const codeCall = (output: string) => ({
    id: childCall,
    name: 'execute_code',
    args: '{}',
    output,
    progress: 1,
  });
  const messages = [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Ask the illustrator for a chart in the background.',
    },
    {
      messageId,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: [
        ...(reused === true
          ? [
              { type: 'tool_call', tool_call: codeCall('Loaded the data.') },
              { type: 'text', text: 'Data loaded.' },
            ]
          : []),
        {
          type: 'tool_call',
          tool_call: {
            id: `subagent-${suffix}`,
            name: 'subagent',
            args: JSON.stringify({ subagent_type: 'self', description: 'Draw a chart' }),
            output: 'The chart is rendering in the background.',
            progress: 1,
            subagent_content: [
              {
                type: 'tool_call',
                ...(childAgent != null ? { agentId: childAgent } : {}),
                tool_call: codeCall('Started background task bg_1.'),
              },
            ],
          },
        },
        { type: 'text', text: 'The chart is on its way.' },
      ],
    },
  ] as SeedMessage[];

  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Subagent late file', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, messages);
  await page.route('**/images/e2e-subagent-late/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
  /** Every read of this conversation's single messages or parts the client makes. */
  const reads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/messages/${conversationId}/`)) {
      reads.push(request.url());
    }
  });
  const cleanup = async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  };

  try {
    const loaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/messages/${conversationId}` &&
        response.status() === 200,
    );
    await page.goto(`/c/${conversationId}`);
    /** The load previews the subagent call with no file to hint: the shape this covers. */
    const preview = JSON.stringify(await (await loaded).json());
    expect(preview).toContain('"subagentContentOmitted":true');
    expect(preview).not.toContain('subagentAttachmentCalls');

    const message = page.locator(`[id="${messageId}"]`);
    await expect(message.getByText('The chart is on its way.')).toBeVisible();
    const image = message.getByRole('img', { name: attachment.filename, exact: true });
    await expect(image).toHaveCount(0);

    /** The background task finished: its file is saved onto the original message. */
    if (saved) {
      await withMongo((db) =>
        db.collection('messages').updateOne({ messageId }, { $set: { attachments: [attachment] } }),
      );
    }

    /** The next turn's stream re-emits that file for the original message, as a poll does. */
    let injected = false;
    await page.route(STREAM_ROUTE, async (route) => {
      if (injected) {
        await route.continue();
        return;
      }
      injected = true;
      const response = await route.fetch();
      const body = await response.text();
      const frame = `event: message\ndata: ${JSON.stringify({ event: 'attachment', data: attachment })}\n\n`;
      const firstFrameEnd = body.indexOf('\n\n');
      await route.fulfill({
        response,
        body:
          firstFrameEnd < 0
            ? frame + body
            : body.slice(0, firstFrameEnd + 2) + frame + body.slice(firstFrameEnd + 2),
      });
    });

    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, `E2E_REPLY:late-file-${suffix}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 60_000,
    });
    expect(injected).toBe(true);

    return { message, image, reads, messageId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test('a file a subagent background tool delivers after the load renders under the subagent @scenario:subagent-late-background-file-renders', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { image, reads, messageId, cleanup } = await deliverLateFile(page, {
    childCall: 'background-child',
  });
  try {
    await expect(image).toHaveCount(1);
    await expect(image).toBeVisible();
    /** One owner lookup places the file; no omitted transcript is loaded. */
    expect(reads.filter((url) => url.includes('/parts/'))).toEqual([]);
    expect(reads.filter((url) => url.includes(`/${messageId}/subagent-calls?`))).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test('a late subagent file whose id an earlier top-level call reuses renders under the subagent, even before it is saved @scenario:subagent-late-file-reused-id-routes-to-subagent', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { message, image, cleanup } = await deliverLateFile(page, {
    childCall: 'call_0',
    childAgent: 'e2e-illustrator',
    reused: true,
    saved: false,
  });
  try {
    await expect(image).toHaveCount(1);
    await expect(image).toBeVisible();
    /** The reusing call renders above "Data loaded."; the subagent's files render below it. */
    const between = await message.getByText('Data loaded.').boundingBox();
    const imageBox = await image.boundingBox();
    expect(between != null && imageBox != null && imageBox.y > between.y).toBe(true);
  } finally {
    await cleanup();
  }
});
