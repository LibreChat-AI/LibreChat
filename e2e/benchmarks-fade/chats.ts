import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../specs/mock/db';
import { MOCK_ENDPOINTS, messagesView } from '../specs/mock/helpers';
import { getE2EUser } from '../setup/user';

/**
 * Exported conversations (the chat Export action's JSON) as benchmark fixtures.
 * `FADE_PERF_CHATS` is a comma-separated list of their paths; nothing in the
 * repository stands in for them, because the point is a transcript of the size
 * and shape a reader actually has.
 */

export type ExportedMessage = Record<string, unknown> & {
  messageId: string;
  isCreatedByUser?: boolean;
  content?: Array<Record<string, unknown> & { type?: string }>;
  children?: ExportedMessage[];
};

export type BenchChat = { file: string; id: string; title: string };

export const ENDPOINT = MOCK_ENDPOINTS[0];

export const CONVOS: BenchChat[] = (process.env.FADE_PERF_CHATS ?? '')
  .split(',')
  .filter(Boolean)
  .map((file, index) => ({ file, id: randomUUID(), title: `Fade bench ${index + 1}` }));

export const chatName = (chat: BenchChat): string => chat.file.split('/').pop() ?? chat.id;

function flatten(messages: ExportedMessage[], out: ExportedMessage[] = []): ExportedMessage[] {
  for (const message of messages) {
    /** The export nests replies and annotates the nesting; a stored message has neither. */
    const { children, ...stored } = message;
    delete stored.depth;
    delete stored.siblingIndex;
    out.push(stored);
    flatten(children ?? [], out);
  }
  return out;
}

/** Inserts the export under a fresh conversation id and returns its messages, flattened. */
export async function seedChat(chat: BenchChat): Promise<ExportedMessage[]> {
  const exported = JSON.parse(fs.readFileSync(chat.file, 'utf8')) as {
    messages: ExportedMessage[];
  };
  const messages = flatten(exported.messages);
  const userEmail = getE2EUser().email;
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
    }
    const userId = user._id.toString();
    const now = new Date();
    await db.collection('conversations').insertOne({
      conversationId: chat.id,
      title: chat.title,
      user: userId,
      endpoint: ENDPOINT.label,
      endpointType: 'custom',
      model: ENDPOINT.model,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    const docs = messages.map((message) => ({
      ...message,
      conversationId: chat.id,
      user: userId,
      endpoint: ENDPOINT.label,
      model: ENDPOINT.model,
      createdAt: new Date(String(message.createdAt ?? now.toISOString())),
      updatedAt: new Date(String(message.updatedAt ?? now.toISOString())),
      __v: 0,
    }));
    await db.collection('messages').insertMany(docs);
  });
  return messages;
}

export async function removeChats(): Promise<void> {
  const ids = CONVOS.map((chat) => chat.id);
  await deleteMessagesByConversation(ids);
  await deleteConversations(ids);
}

/**
 * Opens the chat and waits for the document to stop growing: rows keep
 * mounting in transition-wrapped chunks after the first commit.
 */
export async function openChat(
  page: Page,
  chat: BenchChat,
): Promise<{ nodes: number; rows: number }> {
  await page.addInitScript(() => localStorage.setItem('textToSpeech', 'false'));
  await page.goto(`/c/${chat.id}`, { timeout: 180_000 });
  await expect(messagesView(page).locator('.message-render').first()).toBeAttached({
    timeout: 180_000,
  });
  let previous = -1;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    if (nodes === previous) {
      break;
    }
    previous = nodes;
    await page.waitForTimeout(750);
  }
  return page.evaluate(() => ({
    nodes: document.getElementsByTagName('*').length,
    rows: document.querySelectorAll('.message-render').length,
  }));
}

/**
 * Types `text` and waits for the composer to accept it, without sending. Role
 * locators compute accessible names across the whole transcript on every poll,
 * so the draft goes in before a measurement starts, never during one.
 */
export async function draft(page: Page, text: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(text);
  await expect(page.getByTestId('send-button')).toBeEnabled({ timeout: 30_000 });
}

/**
 * Resolves in the page once a run has started and then stopped. Pass
 * `started` when the run is already under way: a short one can end before the
 * first poll, and waiting to see it start would then never return.
 */
export async function awaitRunEnd(page: Page, started = false): Promise<void> {
  await page.evaluate(
    (alreadyStarted) =>
      new Promise<void>((resolve) => {
        let seen = alreadyStarted;
        const timer = window.setInterval(() => {
          const running = document.querySelector('[data-testid="stop-generation-button"]') != null;
          if (running) {
            seen = true;
          } else if (seen) {
            window.clearInterval(timer);
            resolve();
          }
        }, 100);
      }),
    started,
  );
}
