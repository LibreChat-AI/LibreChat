import { test } from '@playwright/test';
import { formatFrameCost, traceFrames } from './trace';
import { CONVOS, awaitRunEnd, chatName, draft, openChat, removeChats, seedChat } from './chats';

/**
 * What the read-aloud control costs a long thread.
 *
 * Every assistant row carries a hidden `<audio>` element for its read-aloud button. Nothing is
 * meant to load into it until the button is pressed, so it should cost the page nothing: no
 * media error, no request, and no main-thread time after the thread has mounted or a run has
 * started. `FADE_PERF_TTS=0` turns read-aloud off, for a thread without the elements.
 */

test.use({ trace: 'off', video: 'off' });

const PROMPT = process.env.FADE_PERF_PROMPT ?? 'say hello';
const SETTLE_MS = 12_000;

declare global {
  interface Window {
    __AUDIO_ERRORS__?: number[];
  }
}

test.describe('read-aloud elements in a long thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`audio elements of ${chatName(convo)}`, async ({ page, browser }) => {
      await seedChat(convo);
      await page.addInitScript(() => {
        window.__AUDIO_ERRORS__ = [];
        document.addEventListener(
          'error',
          (event) => {
            if (event.target instanceof HTMLAudioElement) {
              window.__AUDIO_ERRORS__?.push(Math.round(performance.now()));
            }
          },
          true,
        );
      });
      const media: string[] = [];
      page.on('request', (request) => {
        if (request.resourceType() === 'media') {
          media.push(new URL(request.url()).pathname);
        }
      });
      const read = () =>
        page.evaluate(() => ({
          audio: document.querySelectorAll('audio').length,
          withSrc: document.querySelectorAll('audio[src]').length,
          errors: window.__AUDIO_ERRORS__?.length ?? 0,
          last: window.__AUDIO_ERRORS__?.at(-1) ?? 0,
          first: window.__AUDIO_ERRORS__?.[0] ?? 0,
        }));
      const report = async (name: string) => {
        const now = await read();
        console.log(
          `${name.padEnd(28)} audio=${now.audio} withSrc=${now.withSrc} errors=${now.errors} ` +
            `(first ${now.first}ms, last ${now.last}ms) mediaRequests=${media.length}`,
        );
      };

      const size = await openChat(page, convo);
      console.log(`\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements`);
      await report('after the thread mounted');

      const settled = await traceFrames(browser, page, () => page.waitForTimeout(SETTLE_MS));
      console.log(formatFrameCost('open thread, held still', settled));
      await report('after holding still');

      await draft(page, PROMPT);
      const run = await traceFrames(browser, page, async () => {
        await page.keyboard.press('Enter');
        await awaitRunEnd(page);
        await page.waitForTimeout(SETTLE_MS);
      });
      console.log(formatFrameCost('one short run, then held still', run));
      await report('after one run');

      await draft(page, PROMPT);
      const second = await traceFrames(browser, page, async () => {
        await page.keyboard.press('Enter');
        await awaitRunEnd(page);
        await page.waitForTimeout(SETTLE_MS);
      });
      console.log(formatFrameCost('a second run, then held still', second));
      await report('after a second run');
      console.log(`media request paths: ${JSON.stringify([...new Set(media)])}`);
    });
  }
});
