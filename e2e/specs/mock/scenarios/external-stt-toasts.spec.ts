import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The external speech-to-text engine reports what went wrong in the UI language. A failed
 * transcription names no cause: the server answers a provider failure, an empty transcript and
 * audio too short to transcribe with the same bare 500, so the toast that guessed the audio was
 * too short was wrong whenever the provider was down.
 *
 * The microphone is the one device the harness lacks, so `getUserMedia` hands the page a
 * generated tone (or refuses) and the browser's own MediaRecorder records it. The upload is
 * answered in the page: the harness caps `/api/files/speech/stt` at two requests a minute per
 * user (`yaml-rate-limits.spec.ts`), and every project here signs in as the same user.
 */

const FAILED = 'Speech could not be transcribed. Please try again.';
const TOO_SHORT_GUESS = 'maybe the audio was too short';
const TRANSCRIPT = 'dictated through the external engine';

type Options = { refuse?: boolean; lang?: string };

async function openComposer(page: Page, { refuse = false, lang }: Options = {}) {
  await page.route('**/api/files/speech/config/get', (route) =>
    route.fulfill({ json: { sttExternal: true, engineSTT: 'external', speechToText: true } }),
  );
  await page.addInitScript(
    ({ refused, language }) => {
      const settings: Record<string, unknown> = {
        engineSTT: 'external',
        speechToText: true,
        autoTranscribeAudio: false,
        autoSendText: -1,
      };
      if (language != null) {
        settings.lang = language;
      }
      for (const [key, value] of Object.entries(settings)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          if (refused) {
            throw new DOMException('Permission denied', 'NotAllowedError');
          }
          const context = new AudioContext();
          const output = context.createMediaStreamDestination();
          const tone = context.createOscillator();
          tone.connect(output);
          tone.start();
          return output.stream;
        },
      });
    },
    { refused: refuse, language: lang ?? null },
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
}

/** Answers every transcription upload with `reply` and counts the uploads. */
async function answerUploads(page: Page, reply: { status: number; json?: unknown }) {
  const uploads: string[] = [];
  await page.route('**/api/files/speech/stt', (route) => {
    uploads.push(route.request().headers()['content-type'] ?? '');
    if (reply.json !== undefined) {
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    return route.fulfill({ status: reply.status, contentType: 'text/plain', body: 'Error' });
  });
  return uploads;
}

const composer = (page: Page) => page.locator('form:has(#prompt-textarea)');
const openToasts = (page: Page) => page.locator('.toast-root[data-state="open"]');

async function recordTake(page: Page) {
  await composer(page).getByRole('button', { name: 'Use microphone', exact: true }).click();
  await composer(page).getByRole('button', { name: 'Stop', exact: true }).click();
}

test.describe('external speech-to-text toasts', () => {
  test('a failed transcription says the speech could not be transcribed @scenario:external-stt-failure-names-no-cause', async ({
    page,
  }) => {
    const uploads = await answerUploads(page, { status: 500 });
    await openComposer(page);

    await recordTake(page);

    await expect(openToasts(page)).toContainText(FAILED);
    await expect(openToasts(page)).not.toContainText(TOO_SHORT_GUESS);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('multipart/form-data');
    /* The failed take is settled, so the microphone is offered for another try. */
    await expect(
      composer(page).getByRole('button', { name: 'Use microphone', exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId('text-input')).toHaveValue('');
  });

  test('a transcription lands in the message box without a toast @scenario:external-stt-success-fills-composer', async ({
    page,
  }) => {
    const uploads = await answerUploads(page, { status: 200, json: { text: TRANSCRIPT } });
    await openComposer(page);

    await recordTake(page);

    await expect(page.getByTestId('text-input')).toHaveValue(TRANSCRIPT);
    expect(uploads).toHaveLength(1);
    await expect(openToasts(page)).toHaveCount(0);
  });

  test('a refused microphone is reported in the UI language @scenario:external-stt-toasts-follow-ui-language', async ({
    page,
  }) => {
    const uploads = await answerUploads(page, { status: 500 });
    await openComposer(page, { refuse: true, lang: 'de-DE' });

    await composer(page).getByRole('button', { name: 'Mikrofon verwenden', exact: true }).click();

    await expect(openToasts(page)).toContainText('Mikrofon ist nicht verfügbar');
    await expect(openToasts(page)).not.toContainText('Microphone permission not granted');
    expect(uploads).toHaveLength(0);
  });
});
