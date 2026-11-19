import { test } from '@playwright/test';
import { CONVOS, chatName, openChat, removeChats, seedChat } from './chats';
import { formatFrameCost, traceFrames } from './trace';
import { installRenderProbe } from './why';

/**
 * What opening and closing the session rail costs a long thread.
 *
 * The rail takes a column beside the chat, so opening it narrows the thread and closing it
 * widens it again. Unlike the sidebar it does not slide: the width changes once, so the thread
 * should be laid out once, and nothing in the thread should render, because no state a message
 * row reads changes. Each direction is traced on its own, with the sidebar's toggle traced in
 * the same run as the yardstick, and `FADE_PERF_WHY=1` counts what React rendered.
 */

test.use({ trace: 'off', video: 'off' });

const SETTLE_MS = 1_000;
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
const WHY = process.env.FADE_PERF_WHY === '1';
const RAIL_TOGGLE = 'header-background-tasks-button';

test.describe('session rail toggle beside a long thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`toggle the session rail beside ${chatName(convo)}`, async ({ page, browser }) => {
      await seedChat(convo);
      const probe = WHY ? await installRenderProbe(page) : null;
      const size = await openChat(page, convo);
      console.log(`\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements`);

      const click = (testId: string) => async () => {
        await page.evaluate((id) => {
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
        }, testId);
        await page.waitForTimeout(SETTLE_MS);
      };
      const railOpen = () =>
        page.evaluate(() => document.querySelector('[data-testid="session-rail"]') != null);
      const sidebarExpanded = await page.evaluate(
        () => document.querySelector('[data-testid="close-sidebar-button"]') != null,
      );
      const sidebar = sidebarExpanded
        ? (['close-sidebar-button', 'open-sidebar-button'] as const)
        : (['open-sidebar-button', 'close-sidebar-button'] as const);

      const session = await page.context().newCDPSession(page);
      if (CPU_RATE > 1) {
        await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
      }

      for (let round = 1; round <= 3; round += 1) {
        for (const direction of ['open', 'close'] as const) {
          const cost = await traceFrames(browser, page, click(RAIL_TOGGLE));
          console.log(formatFrameCost(`rail ${direction} (round ${round}) cpu x${CPU_RATE}`, cost));
        }
        for (const testId of sidebar) {
          const cost = await traceFrames(browser, page, click(testId));
          const name = testId.startsWith('close') ? 'collapse' : 'expand';
          console.log(formatFrameCost(`sidebar ${name} (round ${round}) cpu x${CPU_RATE}`, cost));
        }
      }

      if (probe) {
        const SHOWN = Number(process.env.FADE_PERF_WHY_LIMIT) || 14;
        const count = async (name: string, act: () => Promise<void>) => {
          await probe.start();
          await act();
          const { commits, lines } = await probe.finish(400);
          const renders = lines.reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0);
          console.log(
            `${name}: ${commits} commits, ${lines.length} components rendered ${renders} times ` +
              `in all; thread has ${size.rows} rows\n${lines.slice(0, SHOWN).join('\n')}`,
          );
        };
        /** A second with nothing done, for what the page renders by itself. */
        await count('idle', () => page.waitForTimeout(SETTLE_MS));
        await count(`rail open`, click(RAIL_TOGGLE));
        await count(`rail close (rail open before: ${await railOpen()})`, click(RAIL_TOGGLE));
        for (const testId of sidebar) {
          await count(
            `sidebar ${testId.startsWith('close') ? 'collapse' : 'expand'}`,
            click(testId),
          );
        }
      }
    });
  }
});
