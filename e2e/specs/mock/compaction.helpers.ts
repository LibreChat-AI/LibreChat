import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { messagesView, replyPrompt, replyText, sendMessageAndWaitForCompletion } from './helpers';

/** Prepend older exchanges: compaction preserves the last two user-led turns. */
export async function sendCompactionHistory(
  page: Page,
  label: string,
  turns = 2,
): Promise<string[]> {
  const transcript: string[] = [];
  for (let index = 0; index < turns; index++) {
    const turnLabel = `history-${index + 1}-${label}`;
    const prompt = replyPrompt(turnLabel);
    const reply = replyText(turnLabel);
    await sendMessageAndWaitForCompletion(page, prompt);
    await expect(messagesView(page).getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
    transcript.push(prompt, reply);
  }
  return transcript;
}
