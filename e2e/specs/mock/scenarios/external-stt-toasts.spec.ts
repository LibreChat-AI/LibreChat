import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import de from '../../../../client/src/locales/de/translation.json';
import en from '../../../../client/src/locales/en/translation.json';
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

type Key = keyof typeof en;

/** The German text when that catalog has it, otherwise the English text i18next falls back
 *  to, so the scenario stays right once a translation lands. */
const german = (key: Key): string => (de as Partial<Record<Key, string>>)[key] ?? en[key];

const TOO_SHORT_GUESS = 'maybe the audio was too short';
const TRANSCRIPT = 'dictated through the external engine';

/** `refusals` is how many microphone requests are refused before one is granted. */
type Options = { refusals?: number; lang?: string };

async function openComposer(page: Page, { refusals = 0, lang }: Options = {}) {
  await page.route('**/api/files/speech/config/get', (route) =>
    route.fulfill({ json: { sttExternal: true, engineSTT: 'external', speechToText: true } }),
  );
  await page.addInitScript(
    ({ refuse, language }) => {
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
      let refused = 0;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          if (refused < refuse) {
            refused += 1;
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
    { refuse: refusals, language: lang ?? null },
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
const toastSaying = (page: Page, text: string) => openToasts(page).filter({ hasText: text });

async function recordTake(
  page: Page,
  labels = { start: en.com_ui_use_micrphone, stop: en.com_ui_stop },
) {
  await composer(page).getByRole('button', { name: labels.start, exact: true }).click();
  await composer(page).getByRole('button', { name: labels.stop, exact: true }).click();
}

test.describe('external speech-to-text toasts', () => {
  test('a failed transcription says the speech could not be transcribed @scenario:external-stt-failure-names-no-cause', async ({
    page,
  }) => {
    const uploads = await answerUploads(page, { status: 500 });
    await openComposer(page);

    await recordTake(page);

    await expect(openToasts(page)).toContainText(en.com_ui_speech_transcription_failed);
    await expect(openToasts(page)).not.toContainText(TOO_SHORT_GUESS);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('multipart/form-data');
    /* The failed take is settled, so the microphone is offered for another try. */
    await expect(
      composer(page).getByRole('button', { name: en.com_ui_use_micrphone, exact: true }),
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

  /* A refused microphone uses a key German already translates; a failed transcription uses a
     new key it may not have yet, which must read as English rather than as the raw key. */
  test('toasts read in the UI language, in English where it has no translation yet @scenario:external-stt-toasts-follow-ui-language', async ({
    page,
  }) => {
    expect(de).toHaveProperty('com_ui_microphone_unavailable');
    const uploads = await answerUploads(page, { status: 500 });
    await openComposer(page, { refusals: 1, lang: 'de-DE' });
    const labels = { start: german('com_ui_use_micrphone'), stop: german('com_ui_stop') };

    await composer(page).getByRole('button', { name: labels.start, exact: true }).click();

    await expect(toastSaying(page, german('com_ui_microphone_unavailable'))).toBeVisible();
    await expect(toastSaying(page, 'Microphone permission not granted')).toHaveCount(0);
    expect(uploads).toHaveLength(0);

    await recordTake(page, labels);

    await expect(toastSaying(page, german('com_ui_speech_transcription_failed'))).toBeVisible();
    await expect(toastSaying(page, 'com_ui_speech_transcription_failed')).toHaveCount(0);
    expect(uploads).toHaveLength(1);
  });
});
