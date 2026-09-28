import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const userEmail = getE2EUser().email;
const cleanupConversationIds: string[] = [];

async function insertConversation(
  conversationId: string,
  title: string,
  messages: Record<string, unknown>[],
): Promise<void> {
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
    }

    const now = new Date();
    await db.collection('conversations').insertOne({
      conversationId,
      title,
      user: user._id.toString(),
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      maxContextTokens: 300,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    await db.collection('messages').insertMany(
      messages.map((message, index) => ({
        ...message,
        conversationId,
        user: user._id.toString(),
        endpoint: 'Mock Provider A',
        model: 'mock-model-a',
        error: false,
        unfinished: false,
        isTemporary: false,
        createdAt: new Date(now.getTime() + index * 1000),
        updatedAt: new Date(now.getTime() + index * 1000),
        __v: 0,
      })),
    );
  });
}

test.afterEach(async () => {
  const conversationIds = cleanupConversationIds.splice(0);
  if (conversationIds.length === 0) {
    return;
  }

  try {
    await deleteMessagesByConversation(conversationIds);
  } finally {
    await deleteConversations(conversationIds);
  }
});

test.describe('persisted context usage', () => {
  /** A snapshot persisted before `remainingContextTokens` existed carries only a
   *  budget and a breakdown. Reading the absent remaining count as zero scored
   *  such a snapshot as having spent its whole window, so an old conversation
   *  opened to a full meter. The used figure has to come from the breakdown
   *  instead: instructions + messages of the deepest snapshot on the branch. */
  test('reads used context from a legacy snapshot’s breakdown @scenario:legacy-snapshot-shows-derived-used-context', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const conversationId = randomUUID();
    cleanupConversationIds.push(conversationId);

    await insertConversation(conversationId, 'Legacy context runway fixture', [
      {
        messageId: 'legacy-user-1',
        parentMessageId: NO_PARENT,
        text: 'First legacy prompt',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'legacy-assistant-1',
        parentMessageId: 'legacy-user-1',
        text: 'First legacy reply',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 4,
        metadata: {
          usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
          contextUsage: {
            runId: 'legacy-run-1',
            contextBudget: 300,
            breakdown: {
              maxContextTokens: 300,
              instructionTokens: 20,
              systemMessageTokens: 0,
              dynamicInstructionTokens: 0,
              toolSchemaTokens: 0,
              summaryTokens: 0,
              toolCount: 0,
              messageCount: 2,
              messageTokens: 100,
              availableForMessages: 280,
            },
          },
        },
      },
      {
        messageId: 'legacy-user-2',
        parentMessageId: 'legacy-assistant-1',
        text: 'Second legacy prompt',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'legacy-assistant-2',
        parentMessageId: 'legacy-user-2',
        text: 'Second legacy reply',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 4,
        metadata: {
          usage: { input: 14, output: 5, cacheRead: 0, cacheWrite: 0 },
          contextUsage: {
            runId: 'legacy-run-2',
            contextBudget: 300,
            breakdown: {
              maxContextTokens: 300,
              instructionTokens: 20,
              systemMessageTokens: 0,
              dynamicInstructionTokens: 0,
              toolSchemaTokens: 0,
              summaryTokens: 0,
              toolCount: 0,
              messageCount: 4,
              messageTokens: 160,
              availableForMessages: 280,
            },
          },
        },
      },
    ]);

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    await expect(page.getByText('Second legacy reply')).toBeVisible({ timeout: 30000 });

    const gauge = page.getByTestId('token-usage');
    await expect(gauge).toBeVisible({ timeout: 30000 });
    await gauge.click();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });

    const breakdownToggle = popover.getByTestId('context-breakdown-toggle');
    if ((await breakdownToggle.getAttribute('aria-expanded')) === 'false') {
      await breakdownToggle.click();
    }
    await expect(breakdownToggle).toHaveAttribute('aria-expanded', 'true');

    /** 20 instruction + 160 message tokens of the 300-token budget: the deepest
     *  legacy snapshot on the branch, derived from its breakdown. Scoring the
     *  missing remaining count as zero would read 300 / 300 (100%) here. */
    await expect(breakdownToggle).toContainText('180 / 300 (60%)');
    await expect(popover.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');

    /** The snapshot path renders, so the reading really is the persisted
     *  snapshot and not the client-side estimate, and the untouched remainder
     *  is the budget minus that derived total. */
    const breakdown = popover.getByTestId('context-breakdown');
    await expect(breakdown).toBeVisible({ timeout: 10000 });
    await expect(popover.getByTestId('context-estimate')).toHaveCount(0);
    const freeSpace = breakdown.locator('div.flex', { hasText: 'Free space' }).first();
    await expect(freeSpace).toContainText('120');
  });

  test('nests estimated tool traffic beneath message totals @scenario:estimate-path-nests-the-tool-share', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const conversationId = randomUUID();
    cleanupConversationIds.push(conversationId);

    await insertConversation(conversationId, 'Estimated tool share fixture', [
      {
        messageId: 'estimate-user-1',
        parentMessageId: NO_PARENT,
        text: 'Estimate prompt',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'estimate-assistant-1',
        parentMessageId: 'estimate-user-1',
        text: 'Tool result',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 20,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'estimate-call-1',
              name: 'lookup',
              args: '{"q":"x"}',
              output: 'result value',
            },
          },
        ],
        metadata: {
          usage: { input: 7, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]);

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    await expect(page.getByText('Estimate prompt')).toBeVisible({ timeout: 30000 });

    const gauge = page.getByTestId('token-usage');
    await expect(gauge).toBeVisible({ timeout: 30000 });
    await gauge.click();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });

    const breakdownToggle = popover.getByTestId('context-breakdown-toggle');
    if ((await breakdownToggle.getAttribute('aria-expanded')) === 'false') {
      await breakdownToggle.click();
    }
    await expect(breakdownToggle).toHaveAttribute('aria-expanded', 'true');

    const estimate = popover.getByTestId('context-estimate');
    await expect(estimate).toBeVisible({ timeout: 10000 });
    const toolRow = estimate.locator('div.pl-6').getByText('Tool calls', { exact: true });
    await expect(toolRow).toBeVisible();

    // Tool traffic is already included in the counted assistant total, so the Tool calls subtotal must be nested rather than a peer that would double-count the meter.
    const peerRows = estimate.locator(':scope > div.flex');
    await expect(peerRows).toHaveCount(2);
    const peerText = await peerRows.allTextContents();
    expect(peerText.some((text) => text.includes('Tool calls'))).toBe(false);

    // All fixture values stay below 1000, so the compact formatter leaves each peer value parseable and their sum can be compared with the gauge readout.
    const peerSum = await peerRows.evaluateAll((rows) =>
      rows.reduce((sum, row) => {
        const value = row.lastElementChild?.textContent?.match(/\d+/)?.[0];
        return sum + (value == null ? 0 : Number(value));
      }, 0),
    );
    const readout = await breakdownToggle.textContent();
    const used = readout?.match(/Context window\s*(\d+)/)?.[1];
    expect(used).toBeDefined();
    expect(peerSum).toBe(Number(used));
  });
});
