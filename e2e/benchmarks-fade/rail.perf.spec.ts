import { test } from '@playwright/test';
import { CONVOS, chatName, openChat, removeChats, seedChat } from './chats';
import { formatFrameCost, traceFrames } from './trace';
import { setRail, stageBackgroundWork } from './rail';
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

      /**
       * Dragging the rail's handle changes the thread's width on every frame of the drag, as
       * the sidebar's slide does, so it is traced the same way: a hundred pixels each way over
       * twenty pointer moves a frame apart.
       */
      const drag = (distance: number) => async () => {
        const handle = page.getByRole('separator', { name: 'Resize the session panel' });
        const box = await handle.boundingBox();
        if (box == null) {
          return;
        }
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let step = 1; step <= 20; step += 1) {
          await page.mouse.move(x + (distance * step) / 20, y);
          await page.waitForTimeout(16);
        }
        await page.mouse.up();
        await page.waitForTimeout(SETTLE_MS);
      };
      if (!(await railOpen())) {
        await click(RAIL_TOGGLE)();
      }
      const resizable = (await page.getByRole('separator').count()) > 0;
      for (let round = 1; resizable && round <= 3; round += 1) {
        for (const [name, distance] of [
          ['wider', -100],
          ['narrower', 100],
        ] as const) {
          const cost = await traceFrames(browser, page, drag(distance));
          console.log(formatFrameCost(`rail drag ${name} (round ${round}) cpu x${CPU_RATE}`, cost));
        }
      }
      await click(RAIL_TOGGLE)();

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
        if (resizable) {
          await count('rail drag wider', drag(-100));
          await count('rail drag narrower', drag(100));
        }
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

/**
 * What an open rail adds to each frame of a thread that is streaming.
 *
 * The rail's rows do nothing while the thread streams, but anything in them that animates is a
 * compositor layer, and a frame's style, layerize and commit steps grow with the layers on the
 * page. The last reply is grown by a few words every 50 ms for three seconds, with the rail
 * closed and then open and listing running work; the layer count says where a difference is from.
 */
test.describe('session rail beside a streaming thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`grow the last reply of ${chatName(convo)} beside the rail`, async ({ page, browser }) => {
      const messages = await seedChat(convo);
      await stageBackgroundWork(page, convo, messages);
      const size = await openChat(page, convo);
      console.log(`\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements`);
      const session = await page.context().newCDPSession(page);
      await session.send('LayerTree.enable');
      let layers = 0;
      session.on('LayerTree.layerTreeDidChange', (event) => {
        layers = event.layers?.length ?? layers;
      });

      const grow = () =>
        page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const rows = document.querySelectorAll('.message-render');
              const target = rows[rows.length - 1].querySelector('p');
              const node = document.createTextNode('');
              target?.appendChild(node);
              let count = 0;
              const timer = setInterval(() => {
                node.data += ' streaming words here';
                count += 1;
                if (count === 60) {
                  clearInterval(timer);
                  node.remove();
                  resolve();
                }
              }, 50);
            }),
        );

      for (let round = 1; round <= 3; round += 1) {
        for (const open of [false, true]) {
          const listed = await setRail(page, open);
          const cost = await traceFrames(browser, page, grow);
          console.log(
            formatFrameCost(
              `rail ${open ? `open, ${listed} rows` : 'closed'} (round ${round}), ${layers} layers`,
              cost,
            ),
          );
        }
      }
    });
  }
});
