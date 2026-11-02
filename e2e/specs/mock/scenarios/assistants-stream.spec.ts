import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { replyPrompt, messagesView, requestJson, getAccessToken } from '../helpers';

type CreatedAssistant = { id: string };

const MODEL = 'gpt-4o-mini';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function createAssistant(page: Page, name: string): Promise<CreatedAssistant> {
  await page.goto('/c/new', { timeout: 10000 });
  const token = await getAccessToken(page);
  return requestJson<CreatedAssistant>(page, {
    path: '/api/assistants/v2',
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: MODEL, name },
  });
}

async function deleteAssistant(page: Page, assistantId: string) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=${MODEL}`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

/** Opens a new chat with the assistant selected and sends `text` through the Assistants stream. */
async function sendToAssistant(page: Page, assistantId: string, text: string) {
  await page.goto(
    `/c/new?endpoint=assistants&model=${MODEL}&assistant_id=${encodeURIComponent(assistantId)}`,
    { timeout: 15000 },
  );
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(text);
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.startsWith('/api/assistants/v2/chat'),
      { timeout: 30000 },
    ),
    input.press('Enter'),
  ]);
}

/** Assistants turns carry their own response and stream through the legacy (non-resumable)
 *  path; these follow a send and a stop on the running app. */
test.describe('assistants stream', () => {
  test('an assistant reply streams in and the chat moves to its saved route @scenario:assistants-send-streams-reply', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = uniqueLabel('assistant-send');
    const assistant = await createAssistant(page, `E2E stream ${label}`);
    try {
      await sendToAssistant(page, assistant.id, replyPrompt(label));
      await expect(messagesView(page).getByText(`E2E assistant reply ${label}`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);

      await page.reload();
      await expect(messagesView(page).getByText(replyPrompt(label))).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('stopping an assistant run keeps what streamed and re-enables sending @scenario:assistants-stop-keeps-streamed-text', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop');
    const assistant = await createAssistant(page, `E2E stop ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `E2E_ASSISTANT_SLOW:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      await page.getByRole('button', { name: 'Stop generating' }).click();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible();
      await expect(messagesView(page).getByText(/achunk-120/)).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });
});
