import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';

/**
 * Regression for issue #13916: hard-refreshing a conversation that
 * contains a large (>1MB) code-execution office file crashed the whole
 * app with React error #185 ("Maximum update depth exceeded").
 *
 * Root cause (client-only): on a loaded conversation the message's
 * attachment is frozen at the immediate-persist snapshot
 * `status: 'pending'`. `useAttachmentPreviewSync` polls the preview
 * endpoint, and once it resolves it writes the record back into
 * `messageAttachmentsMap`. `useAttachments` re-derives the attachment
 * with a fresh identity on every such write, and that attachment is in
 * the effect's dependency array — so the write-back ping-ponged forever.
 *
 * This spec reconstructs that exact load: it intercepts the
 * conversation, messages, and preview endpoints to serve a code-exec
 * tool call carrying a still-`pending` office attachment whose preview
 * resolves to `ready`. With the bug present the page throws #185 and the
 * route's error boundary replaces the chat; with the fix it settles and
 * the conversation renders normally.
 *
 * It uses network interception (not the fake model) because the trigger
 * is the persisted deferred-preview lifecycle, which the mock LLM does
 * not produce.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('issue #13916 — code-exec attachment preview', () => {
  test('loading a conversation with a pending >1MB doc attachment does not crash (React #185)', async ({
    page,
  }) => {
    test.setTimeout(120000);

    const conversationId = unique('e2e-13916');
    const messageId = `${conversationId}-msg`;
    const fileId = `${conversationId}-file`;
    const filename = 'repro-13916-large.docx';
    const now = new Date(0).toISOString();

    /** DB-frozen, immediate-persist snapshot: pending, no resolved text. */
    const attachment = {
      file_id: fileId,
      filename,
      filepath: `/uploads/682f49b90f07376815c38ef2/${fileId}__${filename}`,
      type: 'execute_code',
      source: 'local',
      bytes: 1256732,
      messageId,
      conversationId,
      toolCallId: 'tc-13916',
      status: 'pending',
      metadata: {
        codeEnvRef: { kind: 'user', id: '682f49b90f07376815c38ef2', storage_session_id: 'sess' },
      },
    };

    const message = {
      messageId,
      conversationId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: false,
      sender: 'Assistant',
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      text: '',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: 'tc-13916',
            name: 'execute_code',
            args: '{"lang":"py","code":"# edit the document"}',
            output: 'edited 1 paragraph',
            progress: 1,
          },
        },
      ],
      attachments: [attachment],
      createdAt: now,
      updatedAt: now,
    };

    const conversation = {
      conversationId,
      title: 'File Editing Request',
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
      createdAt: now,
      updatedAt: now,
    };

    /* The preview poll resolves immediately to `ready`; this terminal
     * response is the edge that kicks off the (formerly infinite) write-back. */
    const previewReady = {
      file_id: fileId,
      status: 'ready',
      text: '<p>edited paragraph added</p>',
      textFormat: 'html',
    };

    const convoIdRe = escapeRe(conversationId);
    await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversation),
      }),
    );
    await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([message]),
      }),
    );
    await page.route(/\/api\/files\/[^/]+\/preview(?:\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(previewReady),
      }),
    );

    /* The exact failure signature from the issue. Capture both the
     * uncaught throw and the console error React logs alongside it. */
    const maxDepth = /Maximum update depth exceeded/i;
    const fatalErrors: string[] = [];
    page.on('pageerror', (err) => {
      if (maxDepth.test(err.message)) {
        fatalErrors.push(err.message);
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && maxDepth.test(msg.text())) {
        fatalErrors.push(msg.text());
      }
    });

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });

    /* Anti-false-pass: the attachment path must actually execute, else
     * the buggy build would never loop and this test would guard nothing.
     * The filename renders only once the code-exec attachment mounts. */
    await expect(page.getByText(new RegExp(escapeRe('repro-13916'))).first()).toBeVisible({
      timeout: 30000,
    });

    /* Let the preview poll + any re-render storm play out. */
    await page.waitForTimeout(3000);

    expect(
      fatalErrors,
      `React #185 fired during conversation load:\n${fatalErrors.join('\n---\n')}`,
    ).toHaveLength(0);

    /* The route's error boundary replaces the composer on crash, so its
     * presence is an independent "the app survived" signal. */
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 10000,
    });
  });
});
