import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import type { SeedMessage } from '../db';
import { getAccessToken, messagesView, requestJson } from '../helpers';

/**
 * The attachment row and the file search row live in `@librechat/chat` and read download,
 * preview, known files and artifact viewers from the files host the app mounts. Each scenario
 * drives a row where the host members it reads must resolve: the chat route and a public shared
 * link, which sits outside the chat shell.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const REPORT = 'quarterly-report.pdf';
const EXCERPT = 'Revenue grew twelve percent over the prior quarter.';
const ARCHIVE = 'results.zip';
const SECOND_ARCHIVE = 'raw-data.zip';
const DASHBOARD = 'dashboard.html';
const CODE_DOWNLOAD_BASE = '/api/files/code/download/e2e-session';

function searchMessages(conversationId: string): SeedMessage[] {
  const askId = randomUUID();
  const replyId = randomUUID();
  const toolCallId = `${replyId}-search`;
  return [
    {
      messageId: askId,
      parentMessageId: NO_PARENT,
      text: 'What does the report say about revenue?',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: replyId,
      parentMessageId: askId,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'file_search',
            args: JSON.stringify({ query: 'revenue' }),
            output: [`File: ${REPORT}`, 'Relevance: 0.92', `Content: ${EXCERPT}`].join('\n'),
            progress: 1,
          },
        },
        { type: 'text', text: 'Revenue grew twelve percent.' },
      ],
      attachments: [
        {
          type: 'file_search',
          messageId: replyId,
          conversationId,
          toolCallId,
          file_search: {
            sources: [
              {
                fileId: randomUUID(),
                fileName: REPORT,
                relevance: 0.92,
                content: EXCERPT,
                pages: [2, 5],
                pageRelevance: { 2: 0.92, 5: 0.71 },
                metadata: { fileType: 'application/pdf', storageType: 'local' },
              },
            ],
          },
        },
      ],
    },
  ];
}

function fileRecord(conversationId: string, messageId: string, toolCallId: string, name: string) {
  const fileId = randomUUID();
  return {
    file_id: fileId,
    filename: name,
    filepath: `${CODE_DOWNLOAD_BASE}/${fileId}`,
    type: 'execute_code',
    source: 'local',
    bytes: 2048,
    messageId,
    conversationId,
    toolCallId,
    status: 'ready',
  };
}

function codeMessages(conversationId: string, names: string[], html = false): SeedMessage[] {
  const askId = randomUUID();
  const replyId = randomUUID();
  const toolCallId = `${replyId}-code`;
  const attachments: Record<string, unknown>[] = names.map((name) =>
    fileRecord(conversationId, replyId, toolCallId, name),
  );
  if (html) {
    attachments.push({
      ...fileRecord(conversationId, replyId, toolCallId, DASHBOARD),
      text: '<h1>Dashboard</h1>',
      textFormat: 'html',
    });
  }
  return [
    {
      messageId: askId,
      parentMessageId: NO_PARENT,
      text: 'Run the analysis.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: replyId,
      parentMessageId: askId,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'execute_code',
            args: '{}',
            output: 'ok',
            progress: 1,
          },
        },
        { type: 'text', text: 'The analysis finished.' },
      ],
      attachments,
    },
  ];
}

async function seed(title: string, build: (conversationId: string) => SeedMessage[]) {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  const messages = build(conversationId);
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(email, conversationId, messages);
  return { conversationId, messages };
}

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

async function share(page: Page, conversationId: string): Promise<string> {
  const token = await getAccessToken(page);
  const { shareId } = await requestJson<{ shareId?: string }>(page, {
    path: `/api/share/${conversationId}`,
    token,
    method: 'POST',
    body: {},
  });
  if (!shareId) {
    throw new Error('Expected the share response to include a shareId');
  }
  return shareId;
}

const searchRow = (page: Page) =>
  messagesView(page).getByRole('button', { name: 'Searched your files' });

/** Opens a disclosure row unless the tools-open preference already did. */
async function ensureExpanded(row: Locator) {
  await expect(row).toBeVisible({ timeout: 15000 });
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

test.describe('attachment and file search rows', () => {
  test('a file search row lists its matched files and opens the preview @scenario:file-search-row-lists-matched-files-and-opens-preview', async ({
    page,
  }) => {
    const { conversationId } = await seed('File search row', searchMessages);
    try {
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await ensureExpanded(searchRow(page));

      const view = messagesView(page);
      const open = view.getByRole('button', { name: `Preview: ${REPORT}` });
      await expect(open).toBeVisible();
      await expect(view.getByText('92%', { exact: true })).toBeVisible();
      await expect(view.getByText(EXCERPT)).toBeVisible();

      await open.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(REPORT).first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a file attachment row downloads its file through the app @scenario:file-attachment-row-downloads-its-file', async ({
    page,
  }) => {
    const { conversationId } = await seed('Attachment download', (id) =>
      codeMessages(id, [ARCHIVE, SECOND_ARCHIVE]),
    );
    let requests = 0;
    await page.route(`**${CODE_DOWNLOAD_BASE}/**`, (route) => {
      requests += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'archive bytes',
      });
    });
    try {
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      const view = messagesView(page);
      const toggle = view.getByRole('button', { name: /^(Show|Hide) 2 files$/ });
      await expect(toggle).toBeVisible({ timeout: 15000 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(view.getByText(`${ARCHIVE}, ${SECOND_ARCHIVE}`)).toBeVisible();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const row = view.getByRole('button', { name: ARCHIVE });
      await expect(row).toBeVisible();

      const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
      expect(download.suggestedFilename()).toBe(ARCHIVE);
      expect(requests).toBeGreaterThan(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a shared link renders its file search and attachment rows @scenario:shared-link-renders-file-search-and-attachment-rows', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const search = await seed('Shared file search', searchMessages);
    const artifact = await seed('Shared artifact', (id) => codeMessages(id, [], true));
    try {
      await page.goto(`/c/${search.conversationId}`, { timeout: 15000 });
      await expect(searchRow(page)).toBeVisible({ timeout: 15000 });
      const searchShare = await share(page, search.conversationId);
      const artifactShare = await share(page, artifact.conversationId);

      await page.goto(`/share/${searchShare}`, { timeout: 15000 });
      await ensureExpanded(searchRow(page));
      await expect(
        messagesView(page).getByRole('button', { name: `Preview: ${REPORT}` }),
      ).toBeVisible();
      await expect(messagesView(page).getByText(EXCERPT)).toBeVisible();

      await page.goto(`/share/${artifactShare}`, { timeout: 15000 });
      await expect(
        messagesView(page).getByRole('button', {
          name: new RegExp(`^${DASHBOARD.replace('.', '\\.')}`),
        }),
      ).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanup(search.conversationId);
      await cleanup(artifact.conversationId);
    }
  });
});
