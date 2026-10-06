import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import { withMongo } from './db';
import {
  loginAdmin,
  setRuntimeFilters,
  restoreRuntimeFilters,
  requestResult,
} from './content-filters.helpers';
import {
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
  messagesView,
  fetchJson,
} from './helpers';

const original = 'E2E_PRIVATE_TEXT: alice@example.com';

test('owner sees original after reload while provider, sharing, and canonical reads stay filtered', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const token = await loginAdmin(request);
  await setRuntimeFilters(request, token, {
    messages: {
      pii: {
        action: 'redact',
        fields: ['text'],
        starterPatterns: [],
        customPatterns: [
          { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
          { id: 'hex', label: 'Credential', regex: '[a-f0-9]{32}', category: 'credential' },
        ],
      },
    },
  });
  let conversationId: string | undefined;
  try {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, original);
    conversationId = (await response.json()).conversationId as string;
    expect(conversationId).toBeTruthy();
    await expect(
      messagesView(page).getByText('E2E private model input verified', { exact: true }),
    ).toBeVisible();
    const ownerText = messagesView(page).getByText(original, { exact: true });
    await expect(ownerText).toBeVisible();
    const standardContainer = ownerText.locator(
      'xpath=ancestor::div[contains(@class,"text-message")][1]',
    );
    await expect(standardContainer).toHaveAttribute('dir', 'auto');
    await expect(
      messagesView(page).getByText('Private details hidden from the model', { exact: true }),
    ).toBeVisible();

    const replay = await requestResult(request, {
      path: new URL(response.url()).pathname,
      token,
      method: 'POST',
      data: response.request().postDataJSON(),
    });
    expect(replay.ok).toBe(true);
    expect((replay.body as { conversationId: string }).conversationId).toBe(conversationId);

    const canonical = await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
    expect(JSON.stringify(canonical)).not.toContain('alice@example.com');
    expect(JSON.stringify(canonical)).not.toContain('privateText');
    const user = canonical.find((message) => message.isCreatedByUser)!;
    expect(user.text).toMatch(/\[EMAIL_1_[a-f0-9]{32}\]/);
    await withMongo(async (db) => {
      const row = await db
        .collection('messages')
        .findOne({ conversationId, messageId: user.messageId });
      expect(row?.privateText).toMatch(/^v1:/);
      expect(JSON.stringify(row)).not.toContain('alice@example.com');
    });

    await page.reload();
    await expect(messagesView(page).getByText(original, { exact: true })).toBeVisible();
    await expect(
      ownerText.locator('xpath=ancestor::div[contains(@class,"text-message")][1]'),
    ).toHaveAttribute('dir', 'auto');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.screenshot({
        path: testInfo.outputPath(`owner-text-${theme}.png`),
        fullPage: true,
      });
    }
    const share = await requestResult(request, {
      path: `/api/share/${conversationId}`,
      token,
      method: 'POST',
      data: {},
    });
    expect(share.ok).toBe(true);
    const shared = await requestResult(request, {
      path: `/api/share/${(share.body as { shareId: string }).shareId}`,
      token,
    });
    expect(shared.ok).toBe(true);
    expect(shared.text).not.toContain('alice@example.com');
    expect(shared.text).not.toContain('privateText');
    expect(shared.text).toContain('EMAIL_1_');

    const openExport = async () => {
      await page.getByRole('button', { name: 'Chat options' }).click();
      await page.getByRole('menuitem', { name: 'Export' }).click();
      return page.getByRole('dialog', { name: 'Export conversation' });
    };
    const selectType = async (label: string) => {
      const dialog = page.getByRole('dialog', { name: 'Export conversation' });
      await dialog.getByTestId('dropdown-menu').click();
      await page.getByRole('option', { name: label }).click();
      return dialog;
    };
    let exportDialog = await openExport();
    exportDialog = await selectType('json (.json)');
    const [canonicalDownload] = await Promise.all([
      page.waitForEvent('download'),
      exportDialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    const exported = await readFile(await canonicalDownload.path(), 'utf8');
    expect(exported).not.toContain('alice@example.com');
    expect(exported).toContain('EMAIL_1_');

    exportDialog = await selectType('screenshot (.png)');
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(
      page
        .getByText("Screenshots can't be exported while a chat contains protected or unsent text.")
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exportDialog).toBeHidden();

    const pending = 'Unacknowledged private export: alice@example.com';
    const delayedPath = '**/api/agents/chat/**';
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    await page.route(delayedPath, async (route) => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.text !== pending) {
        await route.continue();
        return;
      }
      await pendingGate;
      await route.continue();
    });
    const pendingRequest = (requestToCheck: {
      method(): string;
      url(): string;
      postDataJSON(): { text?: string };
    }) =>
      requestToCheck.method() === 'POST' &&
      new URL(requestToCheck.url()).pathname.startsWith('/api/agents/chat/') &&
      requestToCheck.postDataJSON()?.text === pending;
    const requestSeen = page.waitForRequest(pendingRequest);
    const pendingResponse = page.waitForResponse((result) => pendingRequest(result.request()));
    try {
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(pending);
      await input.press('Enter');
      await requestSeen;
      exportDialog = await openExport();
      exportDialog = await selectType('json (.json)');
      const [pendingDownload] = await Promise.all([
        page.waitForEvent('download'),
        exportDialog.getByRole('button', { name: 'Export', exact: true }).click(),
      ]);
      const pendingExport = await readFile(await pendingDownload.path(), 'utf8');
      expect(pendingExport).not.toContain(pending);
      expect(pendingExport).not.toContain('alice@example.com');
      expect(pendingExport).toContain('EMAIL_1_');
    } finally {
      releasePending();
      await pendingResponse.catch(() => undefined);
      await page.unroute(delayedPath);
    }
    expect((await pendingResponse).ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token)).length,
      )
      .toBeGreaterThanOrEqual(4);

    const unauthorized = await request.post(`/api/messages/${conversationId}/owner-text`, {
      data: { messageIds: [user.messageId] },
    });
    expect(unauthorized.status()).toBe(401);
  } finally {
    await restoreRuntimeFilters(request, token);
    if (conversationId) {
      await requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      });
      await withMongo(async (db) => {
        expect(await db.collection('messages').countDocuments({ conversationId })).toBe(0);
      });
    }
  }
});

test('the first protected owner view loads from its server ID while generation is streaming', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const token = await loginAdmin(request);
  await setRuntimeFilters(request, token, {
    messages: {
      pii: {
        action: 'redact',
        fields: ['text'],
        starterPatterns: [],
        customPatterns: [
          { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
        ],
      },
    },
  });
  let conversationId: string | undefined;
  const text = 'E2E_SLOW_REPLY:owner-stream alice@example.com';
  try {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const ownerRead = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/messages\/[^/]+\/owner-text$/.test(new URL(response.url()).pathname),
    );
    const started = await sendMessage(page, text);
    conversationId = (await started.json()).conversationId as string;
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    const owner = await ownerRead;
    expect(owner.status()).toBe(200);
    expect(new URL(owner.url()).pathname).toBe(`/api/messages/${conversationId}/owner-text`);
    expect((await owner.json()).messages[0].text).toBe(text);
    await expect(
      messagesView(page).getByText('Private details hidden from the model'),
    ).toBeVisible();
    await expect(messagesView(page).getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByTestId('stop-generation-button')).toBeVisible();
    await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 60000 });
  } finally {
    await restoreRuntimeFilters(request, token);
    if (conversationId) {
      await requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      });
    }
  }
});

test('an unchanged unprotected transcript still downloads a PNG screenshot', async ({
  page,
  request,
}) => {
  const token = await loginAdmin(request);
  let conversationId: string | undefined;
  try {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, 'Ordinary screenshot capture');
    conversationId = (await response.json()).conversationId as string;
    await expect(page.getByTestId('screenshot-target')).toHaveAttribute(
      'data-conversation-id',
      conversationId!,
    );
    await page.getByRole('button', { name: 'Chat options' }).click();
    await page.getByRole('menuitem', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export conversation' });
    await dialog.getByTestId('dropdown-menu').click();
    await page.getByRole('option', { name: 'screenshot (.png)' }).click();
    const [image] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    expect(image.suggestedFilename()).toMatch(/\.png$/);
    const bytes = await readFile(await image.path());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    if (conversationId) {
      await requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      });
    }
  }
});

test('native copies retain canonical token trust without copying owner originals', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const token = await loginAdmin(request);
  const copies: string[] = [];
  await setRuntimeFilters(request, token, {
    messages: {
      pii: {
        action: 'redact',
        fields: ['text'],
        starterPatterns: [],
        customPatterns: [
          { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
          { id: 'hex', label: 'Credential', regex: '[a-f0-9]{32}', category: 'credential' },
        ],
      },
    },
  });
  try {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, original);
    const source = (await response.json()).conversationId as string;
    copies.push(source);
    const sourceMessages = await fetchJson<TMessage[]>(page, `/api/messages/${source}`, token);
    const sourceUser = sourceMessages.find((message) => message.isCreatedByUser)!;
    const duplicate = await requestResult(request, {
      path: '/api/convos/duplicate',
      token,
      method: 'POST',
      data: { conversationId: source },
    });
    expect(duplicate.ok).toBe(true);
    const copied = duplicate.body as {
      conversation: { conversationId: string };
      messages: TMessage[];
    };
    const duplicateId = copied.conversation.conversationId;
    copies.push(duplicateId);
    const fork = await requestResult(request, {
      path: '/api/convos/fork',
      token,
      method: 'POST',
      data: { conversationId: source, messageId: sourceMessages.at(-1)!.messageId },
    });
    expect(fork.ok).toBe(true);
    copies.push((fork.body as typeof copied).conversation.conversationId);
    expect(JSON.stringify([duplicate.body, fork.body])).not.toContain('alice@example.com');
    expect(JSON.stringify([duplicate.body, fork.body])).not.toContain('privateText');
    expect(JSON.stringify([duplicate.body, fork.body])).not.toContain('privacyRevision');
    await withMongo(async (db) => {
      const row = await db
        .collection('messages')
        .findOne({ conversationId: duplicateId, isCreatedByUser: true });
      expect(row?.text).toBe(sourceUser.text);
      expect(row?.privateTextTokens).toEqual([
        sourceUser.text.match(/\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_[a-f0-9]{32}\]/)![0],
      ]);
      expect(row?.privacyRevision).toBeUndefined();
      expect(row?.privateText).toBeUndefined();
    });
    await page.goto(`/c/${duplicateId}`);
    await sendMessageAndWaitForCompletion(page, 'Safe copied-history follow-up');
    await expect(
      messagesView(page).getByText('E2E private model input verified', { exact: true }).last(),
    ).toBeVisible();
    const canonical = await fetchJson<TMessage[]>(page, `/api/messages/${duplicateId}`, token);
    expect(JSON.stringify(canonical)).not.toContain('privateText');
    expect(JSON.stringify(canonical)).not.toContain('alice@example.com');
    const share = await requestResult(request, {
      path: `/api/share/${duplicateId}`,
      token,
      method: 'POST',
      data: {},
    });
    expect(share.ok).toBe(true);
    const shareId = (share.body as { shareId: string }).shareId;
    const published = await requestResult(request, { path: `/api/share/${shareId}`, token });
    expect(published.ok).toBe(true);
    expect(published.text).not.toContain('privateText');
    const sharedFork = await requestResult(request, {
      path: `/api/share/${shareId}/fork`,
      token,
      method: 'POST',
      data: {},
    });
    expect(sharedFork.ok).toBe(true);
    copies.push((sharedFork.body as typeof copied).conversation.conversationId);
    expect(sharedFork.text).not.toContain('privateText');
    const repeated = await requestResult(request, {
      path: '/api/convos/duplicate',
      token,
      method: 'POST',
      data: { conversationId: duplicateId },
    });
    expect(repeated.ok).toBe(true);
    copies.push((repeated.body as typeof copied).conversation.conversationId);
  } finally {
    await restoreRuntimeFilters(request, token);
    for (const conversationId of copies) {
      await requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      });
    }
  }
});

test('a later history-policy rejection never persists the transformed protected turn', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const token = await loginAdmin(request);
  let conversationId: string | undefined;
  try {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const seeded = await sendMessageAndWaitForCompletion(page, 'Safe admission-history seed');
    conversationId = (await seeded.json()).conversationId as string;
    const prior = await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
    const user = prior.find((message) => message.isCreatedByUser)!;
    await withMongo(async (db) => {
      await db.collection('messages').updateOne(
        { conversationId, messageId: user.messageId },
        {
          $set: { text: 'FORBIDDEN_HISTORICAL_MARKER' },
        },
      );
    });
    await page.reload();
    await setRuntimeFilters(request, token, {
      messages: {
        pii: {
          action: 'redact',
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [
            { id: 'email', label: 'Email', regex: 'alice@example\\.com', category: 'email' },
            { id: 'history', label: 'Restricted history', regex: 'FORBIDDEN_HISTORICAL_MARKER' },
          ],
        },
      },
    });
    const completion = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== 'GET' ||
        !new URL(response.url()).pathname.includes('/api/agents/chat/stream/')
      ) {
        return false;
      }
      return true;
    });
    const admitted = await sendMessage(page, 'E2E_REJECTED_PRIVATE_TEXT: alice@example.com');
    expect(admitted.ok()).toBe(true);
    const stream = await completion;
    const eventText = await stream.text();
    expect(eventText).toContain('error');
    await withMongo(async (db) => {
      const rows = await db.collection('messages').find({ conversationId }).toArray();
      expect(rows).toHaveLength(prior.length);
      expect(JSON.stringify(rows)).not.toContain('E2E_REJECTED_PRIVATE_TEXT');
      expect(JSON.stringify(rows)).not.toContain('alice@example.com');
      expect(rows.every((row) => row.privateText == null)).toBe(true);
    });
  } finally {
    await restoreRuntimeFilters(request, token);
    if (conversationId) {
      await requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      });
    }
  }
});
