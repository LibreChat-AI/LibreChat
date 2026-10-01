import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
  withMongo,
} from '../db';
import type { SeedMessage } from '../db';
import { messagesView, sendMessageAndWaitForCompletion } from '../helpers';

const userEmail = getE2EUser().email;
const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const ARTIFACT_TEXT =
  ':::artifact{identifier="compaction-demo" type="text/html" title="Demo"}\n```html\n<div>demo</div>\n```\n:::';

type Part = Record<string, unknown>;

const summaryPart = (text: string, extra: Part = {}): Part => ({
  type: 'summary',
  content: [{ type: 'text', text }],
  ...extra,
});

/** A branch, seeded straight into Mongo: these turn shapes (a compaction's
 *  summary, a persisted error part, a reply chained onto a reply) cannot be
 *  produced through the composer against the mock model. */
async function seedBranch(messages: SeedMessage[]) {
  const conversationId = randomUUID();
  await seedConversations(userEmail, [
    { conversationId, title: `Compaction ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, messages);
  return conversationId;
}

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

/** The hover actions fade in with the row on pointer devices, so bring the
 *  pointer onto the turn under test before reading its controls. */
async function openRow(page: Page, conversationId: string, messageId: string) {
  await page.goto(`/c/${conversationId}`);
  const row = page.locator(`[id="${messageId}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  return row;
}

/** A user turn and the answer a compaction would summarize. */
function precedingTurns(label: string) {
  const userMessageId = randomUUID();
  const answerId = randomUUID();
  return {
    userMessageId,
    answerId,
    messages: [
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: `Tell me about ${label}`,
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: answerId,
        parentMessageId: userMessageId,
        text: `The long answer about ${label}`,
        isCreatedByUser: false,
        sender: 'OpenAI',
      },
    ] satisfies SeedMessage[],
  };
}

/** The summarizer the mock deployment's endpoints call. */
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;

/**
 * A real conversation whose manual compaction produces nothing: the summarizer
 * is switched to blank output for the compaction run, which is what a model
 * returning no checkpoint looks like. Seeding cannot stand in for this — the
 * point is what a compaction run records when it has neither a summary nor an
 * explanation to carry, and only a real run reaches that path.
 *
 * Returns the conversation and the turn the compaction produced.
 */
async function compactWithEmptySummarizer(page: Page, request: APIRequestContext, label: string) {
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, `tell me about ${label}`);
  const conversationId = new URL(page.url()).pathname.replace('/c/', '');
  expect(conversationId).not.toBe('new');

  const behavior = await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
    data: { mode: 'blank' },
  });
  expect(behavior.ok()).toBeTruthy();

  await page.getByTestId('token-usage').click();
  await page.getByRole('button', { name: 'Compact context' }).click();
  await expect(
    messagesView(page).getByText('Could not compact the context', { exact: false }),
  ).toBeVisible({ timeout: 60_000 });

  const compactionId = await withMongo(async (db) => {
    const row = await db
      .collection('messages')
      .findOne({ conversationId, 'content.type': 'error' });
    return row?.messageId as string | undefined;
  });
  expect(compactionId).toBeTruthy();
  return { conversationId, compactionId: compactionId as string };
}

test.describe('compaction rerun controls', () => {
  /** `compactWithEmptySummarizer` switches the shared fixture summarizer to
   *  blank output before it returns, so a failure inside it would leave every
   *  later mock test summarizing to nothing. Restoring here runs whether the
   *  helper returned, failed, or the test was retried. */
  test.afterEach(async ({ request }) => {
    const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
    expect(response.ok()).toBeTruthy();
  });

  test('a finished compaction offers no rerun controls @scenario:compaction-turn-offers-no-rerun-controls', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('finished compaction');
    const compactionId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: compactionId,
        parentMessageId: answerId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
        content: [summaryPart('Earlier turns, compacted.', { initiatedBy: 'user' })],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, compactionId);

      await expect(row.getByText('You compacted the context')).toBeVisible();
      /* The row itself stays intact — only the rerun shapes are withheld. */
      await expect(row.getByTestId('copy-response-button')).toBeVisible();
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a compaction that failed offers no rerun controls @scenario:failed-compaction-offers-no-rerun-controls', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('failed compaction');
    const compactionId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: compactionId,
        parentMessageId: answerId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
        content: [summaryPart('Partial summary before the failure.', { failed: true })],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, compactionId);

      await expect(row.getByText('Summarization failed')).toBeVisible();
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a compaction hanging off a user turn offers no rerun controls @scenario:compaction-on-user-turn-offers-no-rerun-controls', async ({
    page,
  }) => {
    const userMessageId = randomUUID();
    const compactionId = randomUUID();
    const conversationId = await seedBranch([
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: 'Compact this before I continue',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: compactionId,
        parentMessageId: userMessageId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
        content: [summaryPart('Everything so far, compacted.', { initiatedBy: 'user' })],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, compactionId);

      await expect(row.getByText('You compacted the context')).toBeVisible();
      /* Replaying the user turn behind it would answer that message again rather
         than redo the compaction, so the marker withholds the controls here too. */
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a failed compaction hanging off a user turn offers no rerun controls @scenario:failed-compaction-on-user-turn-offers-no-rerun-controls', async ({
    page,
  }) => {
    const userMessageId = randomUUID();
    const compactionId = randomUUID();
    const conversationId = await seedBranch([
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: 'Compact this before I continue',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: compactionId,
        parentMessageId: userMessageId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        content: [
          {
            type: 'error',
            error: JSON.stringify({ type: 'compaction_skipped', reason: 'nothing_to_summarize' }),
            initiatedBy: 'user',
          },
        ],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, compactionId);

      await expect(row.getByText('Nothing to compact', { exact: false })).toBeVisible();
      /* The compaction marks its failure, so the turn is still a compaction:
         replaying the user message behind it would answer it instead. */
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  /* A real compaction run, not a seeded row: the summarizer returns nothing, so
     the turn has no summary and no explanation of its own and must record the
     marked failure itself. Without that the row is indistinguishable from an
     answer to the message it hangs off. */
  test('a compaction whose summarizer returns nothing offers no rerun controls @scenario:empty-compaction-run-offers-no-rerun-controls', async ({
    page,
    request,
  }) => {
    const { conversationId, compactionId } = await compactWithEmptySummarizer(
      page,
      request,
      'empty-compaction',
    );
    try {
      await page.locator(`[id="${compactionId}"]`).hover();
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
      /* The redo path a compaction keeps is the indicator's own action. */
      await page.getByTestId('token-usage').click();
      await expect(page.getByRole('button', { name: 'Compact context' })).toBeEnabled();
    } finally {
      await cleanup(conversationId);
    }
  });

  /* The same turn read back from storage: a reload rebuilds the row from what
     the server persisted, so the marker has to survive the round trip. */
  test('a compaction that produced nothing stays free of rerun controls after a reload @scenario:empty-compaction-run-survives-reload-without-rerun-controls', async ({
    page,
    request,
  }) => {
    const { conversationId, compactionId } = await compactWithEmptySummarizer(
      page,
      request,
      'reloaded-compaction',
    );
    try {
      const row = await openRow(page, conversationId, compactionId);

      await expect(row.getByText('Could not compact the context', { exact: false })).toBeVisible();
      await expect(page.locator(`[id="edit-${compactionId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a turn that only auto-summarized keeps its rerun controls @scenario:auto-summarized-turn-keeps-rerun-controls', async ({
    page,
  }) => {
    const userMessageId = randomUUID();
    const responseId = randomUUID();
    const conversationId = await seedBranch([
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: 'Answer after summarizing the older turns',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: responseId,
        parentMessageId: userMessageId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
        content: [summaryPart('Older turns were summarized.')],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, responseId);

      await expect(row.getByText('Conversation summarized')).toBeVisible();
      /* Cancelled before its first answer token: this is the turn a rerun is for. */
      await expect(page.locator(`[id="edit-${responseId}"]`)).toBeVisible();
      await expect(page.getByTestId('regenerate-generation-button')).toBeVisible();
      await expect(page.getByTestId('continue-generation-button')).toBeVisible();
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a reply chained onto another reply keeps its editor without a rerun @scenario:chained-reply-keeps-editor-without-rerun', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('an imported thread');
    const chainedId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: chainedId,
        parentMessageId: answerId,
        text: 'The second half of the answer',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
      },
    ]);
    try {
      await openRow(page, conversationId, chainedId);

      /* No user turn to replay, so the rerun shapes go... */
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
      /* ...but the stored content is saved directly, so the editor stays. */
      await page.locator(`[id="edit-${chainedId}"]`).click();
      const editor = page.getByTestId('message-text-editor');
      await expect(editor).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rerun', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Update & rerun' })).toHaveCount(0);
      /* ...and the footer says why the action it usually carries is gone. */
      await expect(
        page.getByText('Rerunning replays the user message before a response', { exact: false }),
      ).toBeVisible();
      await expect(editor).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S Escape');
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a reply left at the root keeps its editor without a rerun @scenario:root-reply-keeps-editor-without-rerun', async ({
    page,
  }) => {
    const rootReplyId = randomUUID();
    const conversationId = await seedBranch([
      {
        messageId: rootReplyId,
        parentMessageId: ROOT_PARENT,
        text: 'An imported reply with nothing before it',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
      },
    ]);
    try {
      await openRow(page, conversationId, rootReplyId);

      /* The importer chains each saved message onto the previous one, so a skipped
         first human message leaves its reply with no parent in the thread at all. */
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
      await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);

      await page.locator(`[id="edit-${rootReplyId}"]`).click();
      const editor = page.getByTestId('message-text-editor');
      await expect(editor).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rerun', exact: true })).toHaveCount(0);
      await expect(
        page.getByText('Rerunning replays the user message before a response', { exact: false }),
      ).toBeVisible();
      await expect(editor).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S Escape');
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a chained reply made only of an artifact offers no editor @scenario:artifact-only-chained-reply-offers-no-editor', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('an artifact');
    const artifactId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: artifactId,
        parentMessageId: answerId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        content: [{ type: 'text', text: ARTIFACT_TEXT }],
      },
    ]);
    try {
      const row = await openRow(page, conversationId, artifactId);

      /* The artifact keeps its read-only renderer, so the editor would open with
         no field and one inert Rerun. */
      await expect(row.getByTestId('copy-response-button')).toBeVisible();
      await expect(page.locator(`[id="edit-${artifactId}"]`)).toHaveCount(0);
      await expect(page.getByTestId('regenerate-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a save-only editor reports unsaved changes @scenario:save-only-editor-reports-unsaved-changes', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('a save-only editor');
    const chainedId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: chainedId,
        parentMessageId: answerId,
        text: 'The second half of the answer',
        isCreatedByUser: false,
        sender: 'OpenAI',
      },
    ]);
    try {
      await openRow(page, conversationId, chainedId);
      await page.locator(`[id="edit-${chainedId}"]`).click();
      const editor = page.getByTestId('message-text-editor');
      await expect(editor).toBeVisible();

      await editor.click();
      await editor.pressSequentially(' and a correction');

      /* The warning about a discarded rerun describes an action this editor does
         not offer. */
      await expect(page.getByText('Unsaved changes')).toBeVisible();
      await expect(
        page.getByText('Rerunning discards these changes and generates a new response.', {
          exact: false,
        }),
      ).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('Compact context stays available after a failed compaction @scenario:compact-action-available-on-failed-compaction', async ({
    page,
  }) => {
    const { answerId, messages } = precedingTurns('a retried compaction');
    const compactionId = randomUUID();
    const conversationId = await seedBranch([
      ...messages,
      {
        messageId: compactionId,
        parentMessageId: answerId,
        text: '',
        isCreatedByUser: false,
        sender: 'OpenAI',
        content: [summaryPart('Partial summary before the failure.', { failed: true })],
      },
    ]);
    try {
      await page.goto(`/c/${conversationId}`);
      await expect(messagesView(page).getByText('Summarization failed')).toBeVisible();

      /* The redo path a compaction turn keeps: the context indicator's action. */
      await page.getByTestId('token-usage').click();
      await expect(page.getByRole('button', { name: 'Compact context' })).toBeEnabled();
    } finally {
      await cleanup(conversationId);
    }
  });
});
