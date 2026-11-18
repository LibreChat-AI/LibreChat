import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations } from '../db';

const createdConversationIds: string[] = [];
const recording = readFileSync(join(__dirname, 'tts-streaming.mp3')).toString('base64');

test.afterAll(async () => {
  await deleteConversations(createdConversationIds);
});

test('manual read aloud plays before the response ends and Stop aborts it @scenario:manual-tts-streams-and-cancels', async ({
  page,
}) => {
  await page.route('**/api/files/speech/config/get', (route) =>
    route.fulfill({
      json: { textToSpeech: true, engineTTS: 'external', cacheTTS: false, ttsExternal: true },
    }),
  );
  await page.route('**/api/files/speech/tts/voices', (route) => route.fulfill({ json: ['alloy'] }));
  await page.addInitScript((base64) => {
    localStorage.setItem('engineTTS', JSON.stringify('external'));
    localStorage.setItem('voice', JSON.stringify('alloy'));
    localStorage.setItem('cacheTTS', 'false');
    const state = {
      requested: false,
      aborted: false,
      audio: null as HTMLMediaElement | null,
    };
    Object.assign(window, { ttsStreaming: state });
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      state.audio = this;
      return originalPlay.call(this);
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/api/files/speech/tts/manual')) {
        return originalFetch(input, options);
      }
      state.requested = true;
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          // Keep EOF pending: actual browser playback must start from these bytes alone.
          const signal = options?.signal ?? (input instanceof Request ? input.signal : null);
          signal?.addEventListener(
            'abort',
            () => {
              state.aborted = true;
              controller.error(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } });
    };
  }, recording);
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const label = `tts-stream-${randomUUID().slice(0, 8)}`;
  await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  await expect(page.getByText(replyText(label)).first()).toBeVisible({ timeout: 20000 });
  const conversationId = new URL(page.url()).pathname.split('/c/')[1];
  if (conversationId) {
    createdConversationIds.push(conversationId);
  }
  await page.getByRole('button', { name: 'Read aloud', exact: true }).last().click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & {
            ttsStreaming: { requested: boolean; aborted: boolean; audio: HTMLMediaElement | null };
          }
        ).ttsStreaming;
        return (
          state.requested &&
          !state.aborted &&
          state.audio != null &&
          !state.audio.paused &&
          state.audio.currentTime > 0.1
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).last().click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as typeof window & {
            ttsStreaming: { aborted: boolean; audio: HTMLMediaElement | null };
          }
        ).ttsStreaming;
        return state.aborted && state.audio?.paused;
      }),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Read aloud', exact: true }).last()).toBeVisible();
});
