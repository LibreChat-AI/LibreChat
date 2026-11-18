import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
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
  test('separates the selected turn from cumulative cache totals after reload @scenario:last-turn-cache-vs-branch', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const conversationId = randomUUID();
    cleanupConversationIds.push(conversationId);

    await insertConversation(conversationId, 'Latest-turn usage fixture', [
      {
        messageId: 'usage-user-1',
        parentMessageId: NO_PARENT,
        text: 'First request',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'usage-assistant-1',
        parentMessageId: 'usage-user-1',
        text: 'First reply',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 5,
        metadata: { usage: { input: 30, output: 5, cacheRead: 100, cacheWrite: 0, cost: 0.01 } },
      },
      {
        messageId: 'usage-user-2',
        parentMessageId: 'usage-assistant-1',
        text: 'Second request',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'usage-assistant-2',
        parentMessageId: 'usage-user-2',
        text: 'Second reply',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 5,
        metadata: {
          usage: { input: 20, output: 5, cacheRead: 400, cacheWrite: 50, cost: 0.02 },
          contextUsage: {
            runId: 'usage-run-2',
            contextBudget: 300,
            cacheRead: 400,
            cacheWrite: 50,
            breakdown: {
              maxContextTokens: 300,
              instructionTokens: 20,
              messageTokens: 80,
              toolCount: 0,
              messageCount: 4,
            },
          },
        },
      },
    ]);

    const assertUsage = async () => {
      await expect(page.getByTestId('token-usage')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('token-usage').click();
      const popover = page.getByRole('region', { name: 'Context usage' });
      const toggle = popover.getByTestId('context-breakdown-toggle');
      if ((await toggle.getAttribute('aria-expanded')) === 'false') {
        await toggle.click();
      }
      const lastTurn = popover.getByTestId('token-usage-last-turn');
      const branch = popover.getByTestId('token-usage-totals');
      await expect(lastTurn.getByRole('heading', { name: 'Last turn' })).toBeVisible();
      await expect(lastTurn.getByText('Cache read').locator('../..')).toContainText('400');
      await expect(lastTurn.getByText('Cache write').locator('../..')).toContainText('50');
      await expect(branch.getByText('This branch')).toBeVisible();
      await expect(branch.getByText('Cache read').locator('../..')).toContainText('500');
      await expect(lastTurn.getByTestId('usage-cost')).toContainText('Cost (last turn)');
      await expect(popover.getByTestId('token-usage-all-branches')).toHaveCount(0);
      await page.keyboard.press('Escape');
    };

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    await expect(page.getByText('Second reply')).toBeVisible({ timeout: 30000 });
    await assertUsage();
    await page.reload({ timeout: 30000 });
    await expect(page.getByText('Second reply')).toBeVisible({ timeout: 30000 });
    await assertUsage();
  });

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
    const toolRow = estimate.locator('div.ps-6').getByText('Tool calls', { exact: true });
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

  /** The roll is defined in the shared Tailwind preset because the breakdown now ships from
   *  @librechat/chat, so an animation name of `none` here means the keyframes never reached
   *  the app's stylesheet and the panel snaps open. The expanded choice is the host's: the
   *  package only reads it through props, so a reload proves the app still persists it. */
  test('rolls the breakdown open and keeps the choice across a reload @scenario:context-breakdown-rolls-open-and-remembers', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const conversationId = randomUUID();
    cleanupConversationIds.push(conversationId);

    await insertConversation(conversationId, 'Breakdown disclosure fixture', [
      {
        messageId: 'disclosure-user-1',
        parentMessageId: NO_PARENT,
        text: 'Disclosure prompt',
        isCreatedByUser: true,
        sender: 'User',
        tokenCount: 8,
      },
      {
        messageId: 'disclosure-assistant-1',
        parentMessageId: 'disclosure-user-1',
        text: 'Disclosure reply',
        isCreatedByUser: false,
        sender: 'Assistant',
        tokenCount: 5,
        metadata: {
          usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          contextUsage: {
            runId: 'disclosure-run',
            contextBudget: 300,
            breakdown: {
              maxContextTokens: 300,
              instructionTokens: 20,
              messageTokens: 80,
              toolCount: 0,
              messageCount: 2,
            },
          },
        },
      },
    ]);

    const openPopover = async () => {
      await expect(page.getByText('Disclosure reply')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('token-usage')).toBeVisible({ timeout: 30000 });
      await page.getByTestId('token-usage').click();
      const popover = page.getByRole('region', { name: 'Context usage' });
      await expect(popover).toBeVisible({ timeout: 10000 });
      return popover;
    };
    const panelAnimation = (popover: Locator) =>
      popover
        .getByTestId('context-details')
        .locator('..')
        .evaluate((panel) => getComputedStyle(panel).animationName);

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });
    const popover = await openPopover();
    const toggle = popover.getByTestId('context-breakdown-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(popover.getByTestId('context-details')).toHaveCount(0);

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(popover.getByTestId('context-details')).toBeVisible();
    expect(await panelAnimation(popover)).toBe('collapsible-down');
    await page.keyboard.press('Escape');

    await page.reload({ timeout: 30000 });
    const reloaded = await openPopover();
    const reloadedToggle = reloaded.getByTestId('context-breakdown-toggle');
    await expect(reloadedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(reloaded.getByTestId('context-details')).toBeVisible();

    /** Reduced motion skips the roll in both directions and the panel still toggles. */
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await reloadedToggle.click();
    await expect(reloadedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reloaded.getByTestId('context-details')).toHaveCount(0);
    await reloadedToggle.click();
    await expect(reloaded.getByTestId('context-details')).toBeVisible();
    expect(await panelAnimation(reloaded)).toBe('none');
  });
});
