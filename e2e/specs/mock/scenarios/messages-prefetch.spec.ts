import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { ensureSidebarOnScreen } from './pinned.helpers';
import { messagesView } from '../helpers';
import { unroute } from '../fixtures';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
/** Holds the conversation record long enough that a messages load gated on it would start late. */
const RECORD_DELAY_MS = 1500;

async function seedConversation(title: string, text: string): Promise<string> {
  const conversationId = randomUUID();
  const email = getE2EUser().email;
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(email, conversationId, [
    {
      messageId: randomUUID(),
      parentMessageId: ROOT_PARENT,
      text,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    },
  ]);
  return conversationId;
}

/** Every `GET /api/messages/:id` the page sends for one conversation, in order. */
function trackMessageLoads(page: Page, conversationId: string): Request[] {
  const loads: Request[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && pathname === `/api/messages/${conversationId}`) {
      loads.push(request);
    }
  });
  return loads;
}

/**
 * The view asks for the conversation's generation status once it has mounted, so by the time that
 * request is sent a load the mount would start has already gone out. The page keeps a stream open,
 * so network idle never arrives.
 */
function viewMounted(page: Page, conversationId: string) {
  return page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/agents/chat/status/${conversationId}`,
    { timeout: 20000 },
  );
}

test.describe('conversation messages load with the route', () => {
  test('a cold load starts the transcript before the conversation record arrives and loads it once @scenario:messages-prefetch-cold-load-loads-once', async ({
    page,
  }) => {
    const marker = `Prefetched transcript ${randomUUID().slice(0, 8)}`;
    const conversationId = await seedConversation('Prefetch cold load', marker);
    try {
      let recordReleasedAt = 0;
      await page.route(`**/api/convos/${conversationId}`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, RECORD_DELAY_MS));
        recordReleasedAt = Date.now();
        await route.continue();
      });
      const loads = trackMessageLoads(page, conversationId);
      const startedAt: number[] = [];
      page.on('request', (request) => {
        if (loads.includes(request)) {
          startedAt.push(Date.now());
        }
      });

      const mounted = viewMounted(page, conversationId);
      await page.goto(`/c/${conversationId}`, { timeout: 20000 });
      await expect(messagesView(page).getByText(marker)).toBeVisible({ timeout: 20000 });
      await mounted;

      expect(loads).toHaveLength(1);
      expect(recordReleasedAt).toBeGreaterThan(0);
      expect(startedAt[0]).toBeLessThan(recordReleasedAt);
    } finally {
      await unroute(page, `**/api/convos/${conversationId}`);
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('switching conversations from the sidebar shows each transcript @scenario:messages-prefetch-sidebar-switch-shows-each-transcript', async ({
    page,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const firstText = `First transcript ${suffix}`;
    const secondText = `Second transcript ${suffix}`;
    const firstId = await seedConversation(`Prefetch first ${suffix}`, firstText);
    const secondId = await seedConversation(`Prefetch second ${suffix}`, secondText);
    try {
      const secondLoads = trackMessageLoads(page, secondId);
      await page.goto(`/c/${firstId}`, { timeout: 20000 });
      await expect(messagesView(page).getByText(firstText)).toBeVisible({ timeout: 20000 });

      await ensureSidebarOnScreen(page);
      const secondMounted = viewMounted(page, secondId);
      await page
        .getByTestId('convo-item')
        .filter({ hasText: `Prefetch second ${suffix}` })
        .first()
        .click();
      await expect(page).toHaveURL(new RegExp(`/c/${secondId}`));
      await expect(messagesView(page).getByText(secondText)).toBeVisible({ timeout: 20000 });
      await expect(messagesView(page).getByText(firstText)).toHaveCount(0);
      await secondMounted;
      expect(secondLoads).toHaveLength(1);

      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/c/${firstId}`));
      await expect(messagesView(page).getByText(firstText)).toBeVisible({ timeout: 20000 });
    } finally {
      await deleteMessagesByConversation([firstId, secondId]);
      await deleteConversations([firstId, secondId]);
    }
  });

  test('a link to a conversation that does not exist still reports it and opens a new chat @scenario:messages-prefetch-missing-conversation-reports-not-found', async ({
    page,
  }) => {
    const missingId = randomUUID();
    const loads = trackMessageLoads(page, missingId);

    await page.goto(`/c/${missingId}`, { timeout: 20000 });

    await expect(page.getByText('Conversation not found', { exact: true }).first()).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page).toHaveURL(/\/c\/new/);
    expect(loads).toHaveLength(1);
  });
});
