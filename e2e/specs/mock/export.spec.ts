import fs from 'fs';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Download, Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../setup/user';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  NEW_CHAT_PATH,
  messagesView,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from './db';
import type { SeedMessage } from './db';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Mirrors MAX_CAPTURE_AREA in client/src/hooks/ScreenshotContext.tsx. */
const MAX_CAPTURE_AREA = 16_777_216;
/** The capture aborts once the CSS area needs a pixel ratio below 0.5, i.e. above 4× the max area. */
const ABORT_CSS_AREA = 4 * MAX_CAPTURE_AREA;

const OVERSIZED_TITLE = 'Oversized export fixture';
const OVERSIZED_PARAGRAPH = 'Oversized export fixture paragraph';
const OVERSIZED_MESSAGES = 80;
const OVERSIZED_PARAGRAPHS_PER_MESSAGE = 50;

const userEmail = getE2EUser().email;
const cleanupConversationIds: string[] = [];

async function startMockConversation(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessage(page, 'Export fixture prompt');
  await expect(mockReply(page).first()).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/c\/(?!new$)[\w-]+/, { timeout: 15000 });
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  if (!conversationId) {
    throw new Error(`Could not parse conversation id from ${page.url()}`);
  }
  cleanupConversationIds.push(conversationId);
  return conversationId;
}

async function openExportModal(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('menuitem', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export conversation' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const typeDropdown = (dialog: Locator) => dialog.getByTestId('dropdown-menu');

async function selectExportType(page: Page, dialog: Locator, label: string) {
  await typeDropdown(dialog).click();
  await page.getByRole('option', { name: label }).click();
  await expect(typeDropdown(dialog)).toContainText(label);
}

/** The modal stays open after exporting, so consecutive exports reuse one dialog. */
async function exportCurrentType(page: Page, dialog: Locator): Promise<Download> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    dialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  return download;
}

async function downloadText(download: Download): Promise<string> {
  return fs.promises.readFile(await download.path(), 'utf8');
}

function buildOversizedMessages(): SeedMessage[] {
  const text = Array.from(
    { length: OVERSIZED_PARAGRAPHS_PER_MESSAGE },
    (_, index) => `${OVERSIZED_PARAGRAPH} ${index}.`,
  ).join('\n\n');
  const messages: SeedMessage[] = [];
  let parentMessageId = NO_PARENT;
  for (let i = 0; i < OVERSIZED_MESSAGES; i++) {
    const messageId = randomUUID();
    messages.push({
      messageId,
      parentMessageId,
      text,
      isCreatedByUser: i % 2 === 0,
      sender: i % 2 === 0 ? 'User' : 'Assistant',
    });
    parentMessageId = messageId;
  }
  return messages;
}

test.afterAll(async () => {
  if (cleanupConversationIds.length === 0) {
    return;
  }
  await deleteMessagesByConversation(cleanupConversationIds);
  await deleteConversations(cleanupConversationIds);
});

test.describe('conversation export', () => {
  test('defaults to markdown with screenshot demoted to the last option', async ({ page }) => {
    await startMockConversation(page);
    const dialog = await openExportModal(page);

    await expect(typeDropdown(dialog)).toContainText('markdown (.md)');

    await typeDropdown(dialog).click();
    const options = page.getByRole('option');
    await expect(options.first()).toContainText('markdown (.md)');
    await expect(options.last()).toContainText('screenshot (.png)');
  });

  test('exports the conversation in every format', async ({ page }) => {
    test.setTimeout(120_000);
    await startMockConversation(page);
    const dialog = await openExportModal(page);

    const markdownDownload = await exportCurrentType(page, dialog);
    expect(markdownDownload.suggestedFilename()).toMatch(/\.md$/);
    const markdown = await downloadText(markdownDownload);
    expect(markdown).toContain('# Conversation');
    expect(markdown).toContain(MOCK_REPLY_TEXT);

    await selectExportType(page, dialog, 'text (.txt)');
    const textDownload = await exportCurrentType(page, dialog);
    expect(textDownload.suggestedFilename()).toMatch(/\.txt$/);
    expect(await downloadText(textDownload)).toContain(MOCK_REPLY_TEXT);

    await selectExportType(page, dialog, 'json (.json)');
    const jsonDownload = await exportCurrentType(page, dialog);
    expect(jsonDownload.suggestedFilename()).toMatch(/\.json$/);
    const parsed = JSON.parse(await downloadText(jsonDownload)) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain(MOCK_REPLY_TEXT);

    await selectExportType(page, dialog, 'csv (.csv)');
    const csvDownload = await exportCurrentType(page, dialog);
    expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/);
    const csv = await downloadText(csvDownload);
    expect(csv).toContain('sender');
    /** CSV export maps only the legacy `text` field, which is empty for the mock
     *  model's content-parts reply — assert on the user message instead. */
    expect(csv).toContain('Export fixture prompt');

    await selectExportType(page, dialog, 'screenshot (.png)');
    const screenshotDownload = await exportCurrentType(page, dialog);
    expect(screenshotDownload.suggestedFilename()).toMatch(/\.png$/);
    const png = await fs.promises.readFile(await screenshotDownload.path());
    expect(png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
    expect(png.byteLength).toBeGreaterThan(1000);
  });

  test('aborts screenshot export of an oversized conversation with an error toast', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const conversationId = randomUUID();
    cleanupConversationIds.push(conversationId);
    await seedConversations(userEmail, [
      { conversationId, title: OVERSIZED_TITLE, updatedAt: new Date() },
    ]);
    await seedMessages(userEmail, conversationId, buildOversizedMessages());

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    await expect(messagesView(page).getByText(`${OVERSIZED_PARAGRAPH} 0.`).first()).toBeVisible({
      timeout: 60000,
    });

    const target = page.getByTestId('screenshot-target');
    /** Long threads mount progressively from the scroll anchor, so the full
     *  area lands a few frames after first paint — poll until it converges.
     *  (The capture path itself force-completes the mount; this precondition
     *  samples the DOM directly and must wait on its own.) */
    await expect
      .poll(() => target.evaluate((node) => node.scrollWidth * node.scrollHeight), {
        timeout: 60_000,
      })
      .toBeGreaterThan(ABORT_CSS_AREA * 1.15);

    const dialog = await openExportModal(page);
    await selectExportType(page, dialog, 'screenshot (.png)');

    let downloadFired = false;
    page.on('download', () => {
      downloadFired = true;
    });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    await expect(page.getByText('too large to export as a screenshot').first()).toBeVisible({
      timeout: 15000,
    });
    expect(downloadFired).toBe(false);

    await selectExportType(page, dialog, 'markdown (.md)');
    const fallbackDownload = await exportCurrentType(page, dialog);
    expect(fallbackDownload.suggestedFilename()).toMatch(/\.md$/);
    expect(await downloadText(fallbackDownload)).toContain(`${OVERSIZED_PARAGRAPH} 0.`);
  });
});
