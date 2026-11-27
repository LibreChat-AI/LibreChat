import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { withMongo, deleteConversations, deleteMessagesByConversation } from '../db';
import { childActivityPanel } from '../subagents.helpers';
import { getE2EUser } from '../../../setup/user';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
/** Past the server's partial-capture grace (`contentRecoveryGraceMs`, 30 s by default), so the
 *  panel stops polling the capture on its own and only the reader's reread can extend it. */
const SETTLED_AGO_MS = 10 * 60_000;
const EARLY = 'Early findings from the capture.';
const LATE = 'Late findings the capture missed.';
const UNAVAILABLE = 'Additional activity details are unavailable.';

type Scope = { user: string; parentConversationId: string; conversationId: string; taskId: string };
type ContentEvent = { sequence: number; frame: { event: string; data: Record<string, unknown> } };

const textDelta = (sequence: number, text: string): ContentEvent => ({
  sequence,
  frame: {
    event: 'on_message_delta',
    data: { id: 'text-step', delta: { content: [{ type: 'text', text }] } },
  },
});

/** One committed content batch, laid out as `appendSubagentContentBatch` writes it: the payload
 *  fragment, and the commit record that publishes it. */
function contentBatch(scope: Scope, revision: number, events: ContentEvent[]) {
  const eventsJson = JSON.stringify(events);
  const batch = {
    ...scope,
    revision,
    fromSequence: events[0].sequence,
    throughSequence: events[events.length - 1].sequence,
    digest: createHash('sha256').update(eventsJson).digest('hex'),
    fragments: 1,
  };
  return [
    { _id: `${scope.taskId}:${revision}:0`, ...batch, fragment: 0, payload: eventsJson },
    { _id: `${scope.taskId}:${revision}:commit`, ...batch, fragment: -1 },
  ];
}

/**
 * A chat whose background child finished minutes ago with its content capture one batch short:
 * the run emitted three content events, its stored reply expects all three, and the journal
 * committed two. The reply keeps only its text, so the panel reads the child through the durable
 * thread view, where the turn itself is complete and the recovered content is what fell short.
 */
async function seedPartialCapture() {
  const label = randomUUID().slice(0, 8);
  const parentConversationId = randomUUID();
  const conversationId = randomUUID();
  const taskId = `task-${randomUUID()}`;
  const toolCallId = `call_partial_capture_${label}`;
  const requestId = randomUUID();
  const replyId = randomUUID();
  const settledAt = new Date(Date.now() - SETTLED_AGO_MS);
  const { email } = getE2EUser();
  const scope = await withMongo(async (db) => {
    const owner = await db.collection('users').findOne({ email });
    if (!owner) {
      throw new Error(`E2E seed: user "${email}" not found`);
    }
    const user = owner._id.toString();
    const handle = {
      background_task_id: taskId,
      subagent_thread_id: conversationId,
      tool: 'subagent',
      subagent_type: 'self',
      status: 'running',
      message: `Running in the background; check it with background_task_id ${taskId}.`,
    };
    const message = (fields: Record<string, unknown>) => ({
      user,
      endpoint: 'agents',
      error: false,
      unfinished: false,
      createdAt: settledAt,
      updatedAt: settledAt,
      __v: 0,
      ...fields,
    });
    await db.collection('conversations').insertMany([
      {
        conversationId: parentConversationId,
        title: `Partial capture ${label}`,
        user,
        endpoint: 'agents',
        isArchived: false,
        createdAt: settledAt,
        updatedAt: new Date(),
        __v: 0,
      },
      {
        conversationId,
        title: 'Subagent: self',
        user,
        endpoint: 'agents',
        isArchived: false,
        subagentThread: {
          rootConversationId: parentConversationId,
          parentConversationId,
          parentMessageId: replyId,
          parentToolCallId: toolCallId,
          subagentType: 'self',
          subagentKind: 'agent',
          depth: 1,
        },
        createdAt: settledAt,
        updatedAt: settledAt,
        __v: 0,
      },
    ]);
    await db.collection('messages').insertMany([
      message({
        messageId: requestId,
        parentMessageId: NO_PARENT,
        conversationId: parentConversationId,
        isCreatedByUser: true,
        sender: 'User',
        text: 'Research the release in the background.',
      }),
      message({
        messageId: replyId,
        parentMessageId: requestId,
        conversationId: parentConversationId,
        isCreatedByUser: false,
        sender: 'Assistant',
        text: '',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: toolCallId,
              name: 'subagent',
              args: JSON.stringify({
                subagent_type: 'self',
                description: 'Research the release.',
                run_in_background: true,
              }),
              output: JSON.stringify(handle),
              progress: 1,
            },
          },
          { type: 'text', text: 'The research is running in the background.' },
        ],
      }),
      message({
        messageId: `${taskId}:user`,
        parentMessageId: NO_PARENT,
        conversationId,
        isCreatedByUser: true,
        sender: 'User',
        text: 'Research the release.',
        subagentContent: { version: 1 },
      }),
      message({
        messageId: `${taskId}:assistant`,
        parentMessageId: `${taskId}:user`,
        conversationId,
        isCreatedByUser: false,
        sender: 'self',
        text: 'The release is ready to ship.',
        subagentTask: { attemptKey: `attempt-${label}`, status: 'completed' },
        subagentContent: { version: 1, throughSequence: 2 },
      }),
    ]);
    const scope: Scope = { user, parentConversationId, conversationId, taskId };
    await db.collection('subagentcontents').insertMany(
      contentBatch(scope, 1, [
        {
          sequence: 0,
          frame: {
            event: 'on_run_step',
            data: {
              id: 'text-step',
              index: 0,
              type: 'message_creation',
              stepDetails: {
                type: 'message_creation',
                message_creation: { message_id: 'child-text' },
              },
            },
          },
        },
        textDelta(1, `${EARLY} `),
      ]),
    );
    return scope;
  });
  return {
    parentConversationId,
    taskId,
    toolCallId,
    /** The journal's missing batch lands after the run, as a retried append does. */
    commitLate: () =>
      withMongo((db) =>
        db.collection('subagentcontents').insertMany(contentBatch(scope, 2, [textDelta(2, LATE)])),
      ),
    cleanup: async () => {
      await withMongo((db) => db.collection('subagentcontents').deleteMany({ conversationId }));
      await deleteMessagesByConversation([parentConversationId, conversationId]);
      await deleteConversations([parentConversationId, conversationId]);
    },
  };
}

type Chat = Awaited<ReturnType<typeof seedPartialCapture>>;

/** Opens the child from its card and returns its turn once the recovered content is on screen. */
async function openChildTurn(page: Page, chat: Chat): Promise<Locator> {
  await page.goto(`/c/${chat.parentConversationId}`);
  const card = page.locator(`[data-subagent-tool-call="${chat.toolCallId}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  const panel = childActivityPanel(page);
  await expect(panel).toBeVisible();
  const turn = panel.locator(`[data-subagent-thread-turn="${chat.taskId}"]`);
  await expect(turn).toContainText(EARLY, { timeout: 30_000 });
  return turn;
}

/** Reads of the task's recovered content, the only source that can extend a short capture. */
function recordContentReads(page: Page, chat: Chat): string[] {
  const reads: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith(`/tasks/${encodeURIComponent(chat.taskId)}/content`)) {
      reads.push(request.url());
    }
  });
  return reads;
}

test.describe('subagent partial content capture', () => {
  test('a finished child whose content capture fell short offers to load more and shows what the journal committed since @scenario:subagent-partial-capture-loads-late-details', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const chat = await seedPartialCapture();
    try {
      const turn = await openChildTurn(page, chat);
      const load = turn.getByRole('button', { name: 'Load more' });
      await expect(load).toBeVisible();
      await expect(turn.getByText(UNAVAILABLE)).toHaveCount(0);
      await expect(turn).not.toContainText(LATE);

      await chat.commitLate();
      await load.click();
      await expect(turn).toContainText(LATE, { timeout: 30_000 });
      await expect(turn.getByRole('button', { name: 'Load more' })).toHaveCount(0);
      await expect(turn.getByText(UNAVAILABLE)).toHaveCount(0);
    } finally {
      await chat.cleanup();
    }
  });

  test('loading more for a capture the journal cannot extend reads it again, then says the details are unavailable @scenario:subagent-partial-capture-reread-finds-nothing-more', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const chat = await seedPartialCapture();
    const reads = recordContentReads(page, chat);
    try {
      const turn = await openChildTurn(page, chat);
      const load = turn.getByRole('button', { name: 'Load more' });
      await expect(load).toBeVisible();
      const before = reads.length;

      await load.click();
      await expect(turn.getByText(UNAVAILABLE)).toBeVisible({ timeout: 30_000 });
      await expect(turn.getByRole('button', { name: 'Load more' })).toHaveCount(0);
      await expect(turn).toContainText(EARLY);
      expect(reads.length).toBeGreaterThan(before);
    } finally {
      await chat.cleanup();
    }
  });
});
