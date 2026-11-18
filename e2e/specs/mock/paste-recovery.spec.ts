import { test, expect } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  messagesView,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';
for (const { failCorrection, failBeforeSave } of [
  { failCorrection: false, failBeforeSave: false },
  { failCorrection: true, failBeforeSave: false },
  { failCorrection: false, failBeforeSave: true },
]) {
  test(`original upload failure cannot revive superseded text (correction fails: ${failCorrection}, before save: ${failBeforeSave})`, async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    let failOriginal = () => {};
    let releaseCorrection = () => {};
    const originalGate = new Promise<void>((resolve) => {
      failOriginal = resolve;
    });
    const correctionGate = new Promise<void>((resolve) => {
      releaseCorrection = resolve;
    });
    let requests = 0;
    await page.route('**/api/files', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const request = ++requests;
      await (request === 1 ? originalGate : correctionGate);
      return route.fulfill({ status: 500, json: { message: 'com_error_files_upload' } });
    });
    try {
      const input = page.getByTestId('text-input');
      const original = 'Original clipboard text.\n'.repeat(120);
      const correction = 'Only the latest correction belongs in this message.\n'.repeat(80);
      await input.fill('Review this');
      await input.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      }, original);
      await expect.poll(() => requests).toBe(1);
      await page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }).click();
      const failSource = async () => {
        const response = page.waitForResponse(
          (response) => response.url().endsWith('/api/files') && response.status() === 500,
        );
        failOriginal();
        await response;
        await expect(input).toHaveValue('Review this');
      };
      if (failBeforeSave) await failSource();
      await page.getByRole('textbox', { name: 'Edit pasted text' }).fill(correction);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => requests).toBe(2);
      if (!failBeforeSave) await failSource();
      await expect(
        page.getByRole('button', { name: 'Edit pasted text, pasted-text-2.txt' }),
      ).toBeVisible();
      if (failCorrection) {
        releaseCorrection();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Edit pasted text' })).toHaveValue(
          correction,
        );
        await expect(input).toHaveValue('Review this');
      } else {
        const sent = page.waitForRequest(
          (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
        );
        await input.press('Enter');
        const payload = (await sent).postDataJSON();
        expect(payload.files ?? []).toHaveLength(0);
        expect(payload.text).toBe(`Review this\n\n\`\`\`text\n${correction}\n\`\`\``);
        await expect(page.getByTestId('composer-tray')).toHaveCount(0);
      }
    } finally {
      failOriginal();
      releaseCorrection();
    }
  });
}

test('sent paste previews survive a reload without full text in the file list', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  const input = page.getByTestId('text-input');
  const paste = 'Persisted preview of the exact clipboard content.\n'.repeat(100);
  const upload = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/files') &&
      response.ok(),
  );
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, paste);
  await upload;
  await expect(page.getByTestId('send-button')).toBeEnabled();
  await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:paste preview persisted');
  const sentFile = page.getByRole('button', { name: 'pasted-text.txt', exact: true });
  await expect(sentFile).toContainText('Persisted preview of the exact clipboard content.');
  const history = page.waitForResponse(
    (response) => response.url().includes('/api/messages/') && response.ok(),
  );
  await page.reload();
  const messages = await (await history).json();
  const user = messages.find(
    (message: { isCreatedByUser?: boolean; files?: unknown[] }) =>
      message.isCreatedByUser && message.files?.length,
  );
  expect(user.files[0].text).toBeUndefined();
  expect(user.files[0].textPreview).toBe(paste.slice(0, 240));
  await expect(sentFile).toContainText('Persisted preview of the exact clipboard content.');
});

for (const action of ['queue', 'steer'] as const) {
  test(`oversized pending pastes retain their upload during ${action}`, async ({ page }) => {
    await page.addInitScript(
      (action) => localStorage.setItem('duringRunDefaultAction', JSON.stringify(action)),
      action,
    );
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, { label: 'Mock Provider C', model: 'mock-model-c' });
    await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:large-paste-setup');
    await sendMessage(page, 'E2E_SLOW_REPLY:large-paste-limit');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/files', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await gate;
      return route.abort();
    });
    try {
      const input = page.getByTestId('text-input');
      const paste = 'Large clipboard document.\n'.repeat(900);
      await input.fill('Review this');
      await input.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      }, paste);
      const chip = page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
      await expect(chip).toHaveAccessibleDescription(/Large clipboard document/);
      await expect(page.getByTestId('during-run-send-button')).toHaveAttribute(
        'data-during-run-action',
        action,
      );
      await input.press('Enter');
      await expect(
        page
          .getByRole('region', { name: 'Notifications (F8)' })
          .getByText(
            'This paste is too long to send inline during a response. Wait for its upload to finish, then try again.',
            { exact: true },
          ),
      ).toBeVisible();
      await expect(chip).toBeVisible();
      await expect(input).toHaveValue('Review this');
      await expect(page.getByTestId('queued-message-row')).toHaveCount(0);
      await expect(page.getByTestId('pending-steers')).toHaveCount(0);
      await chip.click();
      await expect(page.getByRole('textbox', { name: 'Edit pasted text' })).toHaveValue(paste);
    } finally {
      release();
    }
  });
}

test('a text-only user rerun excludes an unrelated paste and preserves its upload', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  const original = 'E2E_REPLY:historical-user-rerun';
  await sendMessageAndWaitForCompletion(page, original);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/files', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    return route.continue();
  });
  try {
    const input = page.getByTestId('text-input');
    const paste = 'Unrelated clipboard text belongs to the next message.\n'.repeat(80);
    await input.fill('Keep this draft');
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    }, paste);
    const chip = page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
    await expect(chip).toBeVisible();
    await expect(input).toHaveValue('Keep this draft');
    const row = messagesView(page)
      .locator('.message-render')
      .filter({ has: page.locator('.user-turn') })
      .first();
    await row.hover();
    await row.locator('button[id^="edit-"]').first().click();
    const editor = page.locator('section[aria-label="Edit message"]');
    await expect(editor).toBeVisible();
    const submitted = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
    );
    await editor.getByRole('button', { name: 'Rerun', exact: true }).click();
    const payload = (await submitted).postDataJSON();
    expect(payload.text).toBe(original);
    expect(payload.files ?? []).toEqual([]);
    await expect(input).toHaveValue('Keep this draft');
    await expect(chip).toHaveAccessibleDescription(/Unrelated clipboard text/);
    const uploadFinished = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/files') &&
        response.ok(),
    );
    release();
    await uploadFinished;
    await expect(page.getByTestId('composer-tray')).toContainText(
      'Unrelated clipboard text belongs to the next message.',
    );
  } finally {
    release();
  }
});

for (const action of ['queue', 'steer'] as const) {
  for (const submit of ['Enter', 'click'] as const) {
    test(`paste-only ${action} submits through ${submit} during a response`, async ({ page }) => {
      await page.addInitScript(
        (action) => localStorage.setItem('duringRunDefaultAction', JSON.stringify(action)),
        action,
      );
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, { label: 'Mock Provider C', model: 'mock-model-c' });
      await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:paste-only-setup');
      await sendMessage(page, 'E2E_SLOW_REPLY:paste-only-active-run');
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/files', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate;
        return route.abort();
      });
      try {
        const input = page.getByTestId('text-input');
        const paste = 'Exact clipboard text without a typed prefix.\n'.repeat(80);
        await input.evaluate((element, text) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', text);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
        }, paste);
        await expect(input).toHaveValue('');
        const button = page.getByTestId('during-run-send-button');
        await expect(button).toHaveAttribute('data-during-run-action', action);
        await expect(button).toBeEnabled();
        const expected = `\`\`\`text\n${paste}\n\`\`\``;
        const sent = page.waitForRequest((request) => {
          if (
            request.method() !== 'POST' ||
            !new URL(request.url()).pathname.startsWith('/api/agents/chat')
          )
            return false;
          return request.postDataJSON()?.text === expected;
        });
        if (submit === 'click') await button.click();
        else await input.press('Enter');
        const payload = (await sent).postDataJSON();
        expect(payload.text).toBe(`\`\`\`text\n${paste}\n\`\`\``);
        expect(payload.files ?? []).toEqual([]);
        await expect(page.getByTestId('composer-tray')).toHaveCount(0);
      } finally {
        release();
      }
    });
  }
}
