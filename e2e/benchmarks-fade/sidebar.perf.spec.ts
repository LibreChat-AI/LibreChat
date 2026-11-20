import { test } from '@playwright/test';
import { formatFrameCost, profileScript, traceFrames } from './trace';
import { CONVOS, chatName, openChat, removeChats, seedChat } from './chats';
import { installRenderProbe } from './why';

/**
 * What opening and closing the sidebar costs a long thread.
 *
 * The sidebar sits beside the chat, so anything that changes its width changes the width the
 * thread is laid out in. Collapsing it and expanding it are each traced on their own, from the
 * click to a second after, with the long thread open: layout time and the longest task say
 * whether the thread was laid out once or once per frame of the slide.
 */

test.use({ trace: 'off', video: 'off' });

const SETTLE_MS = 1_000;
/** `FADE_PERF_CPU=4` slows the renderer fourfold, the way DevTools throttling does. */
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
const PROFILE = process.env.FADE_PERF_PROFILE === '1';
/** A stylesheet laid over the shipped one, to try a remedy on the same build. */
const EXTRA_CSS = process.env.FADE_PERF_CSS;
/** `FADE_PERF_WHY=1` counts the components that render for each toggle, with their causes. */
const WHY = process.env.FADE_PERF_WHY === '1';

test.describe('sidebar toggle beside a long thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`toggle the sidebar beside ${chatName(convo)}`, async ({ page, browser }) => {
      await seedChat(convo);
      const probe = WHY ? await installRenderProbe(page) : null;
      const size = await openChat(page, convo);
      const skipped = await page.evaluate(
        () => document.querySelectorAll('[data-offscreen]').length,
      );
      console.log(
        `\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements, ${skipped} rows skipped`,
      );

      const toggle = (testId: string) => async () => {
        await page.evaluate((id) => {
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
        }, testId);
        await page.waitForTimeout(SETTLE_MS);
      };
      const expanded = await page.evaluate(
        () => document.querySelector('[data-testid="close-sidebar-button"]') != null,
      );
      const order = expanded
        ? (['close-sidebar-button', 'open-sidebar-button'] as const)
        : (['open-sidebar-button', 'close-sidebar-button'] as const);

      if (EXTRA_CSS) {
        await page.addStyleTag({ content: EXTRA_CSS });
      }
      const session = await page.context().newCDPSession(page);
      if (CPU_RATE > 1) {
        await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
      }

      for (let round = 1; round <= 2; round += 1) {
        for (const testId of order) {
          const cost = await traceFrames(browser, page, toggle(testId));
          const name = testId.startsWith('close') ? 'collapse' : 'expand';
          console.log(formatFrameCost(`${name} (round ${round}) cpu x${CPU_RATE}`, cost));
        }
      }

      if (probe) {
        for (const testId of order) {
          const name = testId.startsWith('close') ? 'collapse' : 'expand';
          await probe.start();
          await toggle(testId)();
          const { commits, lines } = await probe.finish(
            Number(process.env.FADE_PERF_WHY_LIMIT) || 40,
          );
          console.log(`${name}: ${commits} commits\n${lines.join('\n')}`);
        }
      }

      if (PROFILE) {
        for (const testId of order) {
          const name = testId.startsWith('close') ? 'collapse' : 'expand';
          const top = await profileScript(session, toggle(testId), 25);
          console.log(`${name} script self-time, cpu x${CPU_RATE}:\n${top.join('\n')}`);
        }
      }
    });
  }
});
