import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import type { Browser, CDPSession, Page } from '@playwright/test';
import type { BenchChat } from './chats';
import { CONVOS, awaitRunEnd, chatName, draft, openChat, removeChats, seedChat } from './chats';
import { formatFrameCost, profileScript, traceFrames } from './trace';

test.use({ trace: 'off', video: 'off' });

/** `FADE_PERF_CPU=4` slows the renderer fourfold, the way DevTools throttling does. */
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
const ROUNDS = Number(process.env.FADE_PERF_ROUNDS) || 4;
/** `1` samples the page's JavaScript across one more open; `FADE_PERF_DUMP` keeps the profile. */
const WITH_PROFILE = process.env.FADE_PERF_PROFILE === '1';
const DUMP_DIR = process.env.FADE_PERF_DUMP;
/**
 * Ten seconds pass before the fake model's first token: a run in flight for a whole switch,
 * with nothing arriving. `FADE_PERF_PROMPT=E2E_SLOW_REPLY:open` streams instead, so the thread
 * mounts beside a reply that is being written.
 */
const RUNNING_PROMPT = process.env.FADE_PERF_PROMPT ?? 'E2E_PRE_TOKEN_REPLY:open';

type Opened = { page: Page; browser: Browser; session: CDPSession; convo: BenchChat; rows: number };

async function open(page: Page, browser: Browser, convo: BenchChat): Promise<Opened> {
  await seedChat(convo);
  const size = await openChat(page, convo);
  console.log(`\n${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements`);
  const session = await page.context().newCDPSession(page);
  if (CPU_RATE > 1) {
    await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }
  if (DUMP_DIR) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
  }
  return { page, browser, session, convo, rows: size.rows };
}

/**
 * Waits in the page for every row, by class through a live collection: a role locator polled
 * here would add its own accessible-name pass over the transcript to the page's work, and a
 * selector query walks the whole document on every poll.
 */
const everyRow = (page: Page, rows: number) =>
  page
    .waitForFunction(
      (count) =>
        document.getElementsByClassName('message-render').length >= count ? performance.now() : 0,
      rows,
      { polling: 100, timeout: 180_000 },
    )
    .then((handle) => handle.jsonValue());

/** Leaves for a new chat, then comes back through the sidebar with the trace running. */
async function switchOnce(
  { page, browser, convo, rows }: Opened,
  label: string,
  dump?: string,
): Promise<void> {
  await page.locator('[data-testid="new-chat-button"]').first().click();
  await page.waitForFunction(() => document.querySelector('.message-render') == null);
  await page.waitForTimeout(1_000);
  const link = page.locator('[data-testid="convo-item"]', { hasText: convo.title }).first();

  let steps: number[] = [];
  const cost = await traceFrames(
    browser,
    page,
    async () => {
      /** Rows in the document at each frame: one step from none to all is a thread mounted
       *  in a single commit. */
      await page.evaluate(() => {
        const seen: number[] = [];
        (window as unknown as { __rows: number[] }).__rows = seen;
        const mounted = document.getElementsByClassName('message-render');
        const sample = () => {
          if (seen[seen.length - 1] !== mounted.length) {
            seen.push(mounted.length);
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await link.click();
      await everyRow(page, rows);
      await page.waitForTimeout(1_500);
      steps = await page.evaluate(() => (window as unknown as { __rows: number[] }).__rows);
    },
    dump,
  );
  console.log(
    formatFrameCost(`switch (${label}) cpu x${CPU_RATE}`, cost) +
      `\n    rows by frame: ${steps.join(' ')}`,
  );
}

test.describe('open a long thread', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  /** Each test seeds the conversation again, under the same id. */
  test.afterEach(removeChats);

  for (const convo of CONVOS) {
    test(`reload ${chatName(convo)}`, async ({ page, browser }) => {
      const opened = await open(page, browser, convo);
      for (let round = 1; round <= ROUNDS; round += 1) {
        let firstRow = 0;
        let allRows = 0;
        const cost = await traceFrames(browser, page, async () => {
          await page.reload({ timeout: 180_000 });
          firstRow = await everyRow(page, 1);
          allRows = await everyRow(page, opened.rows);
          await page.waitForTimeout(1_500);
        });
        console.log(
          formatFrameCost(`reload (round ${round}) cpu x${CPU_RATE}`, cost) +
            `\n    first row at ${firstRow.toFixed(0)}ms, every row at ${allRows.toFixed(0)}ms`,
        );
      }
    });

    test(`switch to ${chatName(convo)}`, async ({ page, browser }) => {
      const opened = await open(page, browser, convo);
      for (let round = 1; round <= ROUNDS; round += 1) {
        await switchOnce(opened, `round ${round}`);
      }

      /** One more switch, traced and sampled together: the two share a clock, so a dump's
       *  samples can be read task by task. */
      if (WITH_PROFILE && DUMP_DIR) {
        const name = path.join(DUMP_DIR, `${chatName(convo)}.switch`);
        const top = await profileScript(
          opened.session,
          () => switchOnce(opened, 'profiled', `${name}.trace.json`),
          40,
          `${name}.cpuprofile`,
        );
        console.log(`switch script self-time, cpu x${CPU_RATE}:\n${top.join('\n')}`);
      }
    });

    /** A thread with a run in flight is the one a reader is most likely to come back to. */
    test(`switch to ${chatName(convo)} while it replies`, async ({ page, browser }) => {
      const opened = await open(page, browser, convo);
      for (let round = 1; round <= ROUNDS; round += 1) {
        await draft(page, RUNNING_PROMPT);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="stop-generation-button"]') != null,
        );
        await switchOnce(opened, `replying, round ${round}`);
        await awaitRunEnd(page, true);
        /** The turn just added is part of the thread the next round comes back to. */
        opened.rows = await page.evaluate(
          () => document.getElementsByClassName('message-render').length,
        );
      }
    });
  }
});
