import { expect, test } from '@playwright/test';
import type { Page, Response, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { deleteConversations, deleteMessagesByConversation } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/** The client's 15 s status-read deadline, then the fenced re-attach and a fresh status read. */
const RECOVERY_TIMEOUT_MS = 35_000;

/**
 * Holds every generation status read while holding is on, without answering it: to the page it
 * looks like a request the browser never sends. Reads made after `release()` reach the server,
 * while the held ones stay unanswered.
 */
async function controlStatusReads(page: Page) {
  const held: Route[] = [];
  let holding = false;
  await page.route('**/api/agents/chat/status/**', async (route) => {
    if (holding) {
      held.push(route);
      return;
    }
    await route.continue();
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
    },
    held: () => held.length,
    drop: () => Promise.all(held.map((route) => route.abort().catch(() => undefined))),
  };
}

function isGenerationStream(response: Response) {
  return new URL(response.url()).pathname.startsWith('/api/agents/chat/stream/');
}

function conversationIdOf(page: Page) {
  return /\/c\/([^/?#]+)/.exec(page.url())?.[1] ?? '';
}

/** Sends a prompt and waits until the server has written the whole stream and closed it. */
async function sendAndAwaitStreamEnd(page: Page, prompt: string) {
  const streamEnd = page
    .waitForResponse(isGenerationStream, { timeout: 30_000 })
    .then((response) => response.finished());
  const start = await sendMessage(page, prompt);
  expect(start.ok()).toBeTruthy();
  await streamEnd;
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15_000 });
}

/** The turn's stream has ended, yet the pane is still generating: its teardown waits on a held read. */
async function expectStrandedOnHeldRead(page: Page, statusReads: { held: () => number }) {
  await expect.poll(statusReads.held, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
}

async function expectComposerIdle(page: Page, timeout: number) {
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
}

async function cleanup(conversationId: string) {
  if (!conversationId) {
    return;
  }
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test.describe('status reads that never answer', () => {
  test('a new chat whose status check never answers releases the composer without a reload @scenario:silent-status-check-releases-new-chat', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `silent-status-new-${randomUUID().slice(0, 8)}`;
    const statusReads = await controlStatusReads(page);
    let conversationId = '';
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      statusReads.hold();
      await sendAndAwaitStreamEnd(page, `E2E_REPLY:${label}`);
      conversationId = conversationIdOf(page);
      await expect(
        messagesView(page).getByText(`E2E reply ${label}`, { exact: true }),
      ).toBeVisible();
      await expectStrandedOnHeldRead(page, statusReads);

      statusReads.release();
      await expectComposerIdle(page, RECOVERY_TIMEOUT_MS);
      await expect(
        messagesView(page).getByText(`E2E reply ${label}`, { exact: true }),
      ).toBeVisible();

      /* The pane is usable again: the next turn sends and finishes on its own. */
      const start = await sendMessage(page, `E2E_REPLY:${label}-next`);
      expect(start.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(`E2E reply ${label}-next`, { exact: true }),
      ).toBeVisible({
        timeout: 20_000,
      });
      await expectComposerIdle(page, 20_000);

      await page.reload();
      await expect(messagesView(page).getByText(`E2E reply ${label}`, { exact: true })).toBeVisible(
        {
          timeout: 20_000,
        },
      );
      await expect(
        messagesView(page).getByText(`E2E reply ${label}-next`, { exact: true }),
      ).toBeVisible();
    } finally {
      await statusReads.drop();
      await cleanup(conversationId);
    }
  });

  test('a follow-up turn whose status check never answers releases the composer without a reload @scenario:silent-status-check-releases-follow-up', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `silent-status-follow-${randomUUID().slice(0, 8)}`;
    const statusReads = await controlStatusReads(page);
    let conversationId = '';
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      await sendAndAwaitStreamEnd(page, `E2E_REPLY:${label}-first`);
      conversationId = conversationIdOf(page);
      await expect(
        messagesView(page).getByText(`E2E reply ${label}-first`, { exact: true }),
      ).toBeVisible();
      await expectComposerIdle(page, 20_000);

      statusReads.hold();
      await sendAndAwaitStreamEnd(page, `E2E_REPLY:${label}`);
      await expect(
        messagesView(page).getByText(`E2E reply ${label}`, { exact: true }),
      ).toBeVisible();
      await expectStrandedOnHeldRead(page, statusReads);

      statusReads.release();
      await expectComposerIdle(page, RECOVERY_TIMEOUT_MS);

      await page.reload();
      await expect(
        messagesView(page).getByText(`E2E reply ${label}-first`, { exact: true }),
      ).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        messagesView(page).getByText(`E2E reply ${label}`, { exact: true }),
      ).toBeVisible();
    } finally {
      await statusReads.drop();
      await cleanup(conversationId);
    }
  });

  test('a failed turn whose status check never answers shows its error and releases the composer @scenario:silent-status-check-releases-failed-turn', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `silent-status-error-${randomUUID().slice(0, 8)}`;
    const providerError = `E2E forced stream error ${label}`;
    const statusReads = await controlStatusReads(page);
    let conversationId = '';
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      statusReads.hold();
      await sendAndAwaitStreamEnd(page, `E2E_FORCED_ERROR:${label}`);
      conversationId = conversationIdOf(page);
      await expectStrandedOnHeldRead(page, statusReads);

      statusReads.release();
      await expect(messagesView(page).getByText(providerError)).toBeVisible({
        timeout: RECOVERY_TIMEOUT_MS,
      });
      await expectComposerIdle(page, 10_000);

      await page.reload();
      await expect(messagesView(page).getByText(providerError)).toBeVisible({ timeout: 20_000 });
    } finally {
      await statusReads.drop();
      await cleanup(conversationId);
    }
  });
});
