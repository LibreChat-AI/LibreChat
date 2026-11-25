import { test } from '@playwright/test';
import { formatFrameCost, traceFrames } from './trace';
import { CONVOS, chatName, openChat, removeChats, seedChat } from './chats';

/**
 * What reading back through a long thread costs.
 *
 * Rows far from the viewport are skipped by the browser and laid out again as a scroll brings
 * them near. That work used to happen once, when the thread opened; this traces a page-by-page
 * sweep from the latest turn towards the first to show what it costs spread across the scroll.
 */

test.use({ trace: 'off', video: 'off' });

/** `FADE_PERF_CPU=4` slows the renderer fourfold, the way DevTools throttling does. */
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
/** A stylesheet laid over the shipped one, to try a remedy on the same build. */
const EXTRA_CSS = process.env.FADE_PERF_CSS;
const PAGES = 30;
const PAGE_MS = 120;

test.describe('scrolling back through a long thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`page up through ${chatName(convo)}`, async ({ page, browser }) => {
      await seedChat(convo);
      const size = await openChat(page, convo);
      if (EXTRA_CSS) {
        await page.addStyleTag({ content: EXTRA_CSS });
      }
      const session = await page.context().newCDPSession(page);
      if (CPU_RATE > 1) {
        await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
      }
      const skipped = () =>
        page.evaluate(() => document.querySelectorAll('.message-render[data-offscreen]').length);
      console.log(
        `\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements, ${await skipped()} rows skipped`,
      );

      const sweep = (direction: 1 | -1) => async () => {
        await page.evaluate(
          ([pages, wait, sign]) =>
            new Promise<void>((resolve) => {
              const scroller = document.getElementById('messages-end')?.parentElement
                ?.parentElement as HTMLElement;
              let step = 0;
              const timer = window.setInterval(() => {
                scroller.scrollBy(0, sign * scroller.clientHeight * 0.9);
                step += 1;
                if (step >= pages) {
                  window.clearInterval(timer);
                  resolve();
                }
              }, wait);
            }),
          [PAGES, PAGE_MS, direction] as const,
        );
      };

      const up = await traceFrames(browser, page, sweep(-1));
      console.log(formatFrameCost(`${PAGES} pages up, cpu x${CPU_RATE}`, up));
      const down = await traceFrames(browser, page, sweep(1));
      console.log(formatFrameCost(`${PAGES} pages down, cpu x${CPU_RATE}`, down));
    });
  }
});
