import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { SeedMessage } from '../db';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getE2EUser } from '../../../setup/user';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
/** 8x8 opaque PNG, enough for the browser to decode the image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=',
  'base64',
);

const imageAttachment = (conversationId: string, messageId: string, toolCallId: string) => ({
  file_id: `${toolCallId}-file`,
  filename: `${toolCallId}.png`,
  filepath: `/images/e2e-subagent/${toolCallId}.png`,
  type: 'image/png',
  source: 'local',
  bytes: PNG.length,
  width: 8,
  height: 8,
  messageId,
  conversationId,
  toolCallId,
});

const imageToolCall = (id: string) => ({
  type: 'tool_call',
  tool_call: { id, name: 'image_gen_oai', args: '{}', output: 'Image generated', progress: 1 },
});

/** The subagent's own tool calls exist only inside `subagent_content`, the shape
 *  the backend persists at save time, so the turn is seeded in that stored shape
 *  and read back through the messages route, whose previews leave the
 *  transcript out of settled subagent calls. */
test('an image a subagent tool saved renders once under the subagent after reload @scenario:subagent-nested-tool-images-render', async ({
  page,
}) => {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const childCall = `child-image-${conversationId.slice(0, 8)}`;
  const grandchildCall = `grandchild-image-${conversationId.slice(0, 8)}`;
  const directCall = `direct-image-${conversationId.slice(0, 8)}`;
  const messages = [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Ask the illustrator for a red cat.',
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
            id: `subagent-${conversationId.slice(0, 8)}`,
            name: 'subagent',
            args: JSON.stringify({ subagent_type: 'self', description: 'Draw a red cat' }),
            output: 'The illustrator drew a red cat.',
            progress: 1,
            subagent_content: [
              imageToolCall(childCall),
              {
                type: 'tool_call',
                tool_call: {
                  id: `nested-subagent-${conversationId.slice(0, 8)}`,
                  name: 'subagent',
                  args: JSON.stringify({ subagent_type: 'self', description: 'Add a hat' }),
                  output: 'Added a hat.',
                  progress: 1,
                  subagent_content: [imageToolCall(grandchildCall)],
                },
              },
            ],
          },
        },
        imageToolCall(directCall),
        { type: 'text', text: 'Here is the red cat.' },
      ],
      attachments: [
        imageAttachment(conversationId, messageId, childCall),
        imageAttachment(conversationId, messageId, grandchildCall),
        imageAttachment(conversationId, messageId, directCall),
      ],
    },
  ] as SeedMessage[];

  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Subagent images', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, messages);
  await page.route('**/images/e2e-subagent/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );

  try {
    const loaded = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/messages/${conversationId}`) && response.status() === 200,
    );
    await page.goto(`/c/${conversationId}`);
    /** The scenario is only meaningful while the route sends the subagent call
     *  as a preview: that is the default load, and the shape that omits the
     *  transcript the child tool calls live in. */
    expect(JSON.stringify(await (await loaded).json())).toContain('"subagentContentOmitted":true');

    const message = page.locator(`[id="${messageId}"]`);
    await expect(message.getByText('Here is the red cat.')).toBeVisible();
    for (const id of [childCall, grandchildCall, directCall]) {
      const image = message.getByRole('img', { name: `${id}.png`, exact: true });
      await expect(image).toHaveCount(1);
      await expect(image).toBeVisible();
    }

    await page.reload();
    await expect(message.getByRole('img', { name: `${childCall}.png`, exact: true })).toHaveCount(
      1,
    );
    await expect(
      message.getByRole('img', { name: `${grandchildCall}.png`, exact: true }),
    ).toHaveCount(1);
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});
