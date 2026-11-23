import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { formatFrameCost, profileScript, traceFrames } from './trace';
import { CONVOS, awaitRunEnd, chatName, draft, openChat, removeChats, seedChat } from './chats';

/**
 * What one frame of an animated label costs as the transcript grows.
 *
 * `FADE_PERF_CHATS` is a comma-separated list of exported conversations
 * (the chat Export action's JSON). Each is seeded as-is, opened at its tail,
 * and traced idle and with a `.shimmer` label on screen.
 */

const TRACE_MS = Number(process.env.FADE_PERF_TRACE_MS) || 4000;
/** The fake model's scripted reply for the live run. */
const PROMPT = process.env.FADE_PERF_PROMPT ?? 'E2E_SLOW_THINK_REPLY:fade';
/** `FADE_PERF_CPU=4` slows the renderer fourfold, the way DevTools throttling does. */
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
const WITH_PROFILE = process.env.FADE_PERF_PROFILE === '1';
/** A directory that receives the raw traces and CPU profiles. */
const DUMP_DIR = process.env.FADE_PERF_DUMP;

const LABEL =
  'Meanwhile, I wonder if Option 3 might work, utilizing a provider with a separate root';

/**
 * Adds a sweeping label to the newest row, built as `Shimmer` in
 * `@librechat/client` builds it, so the frames measured are the ones the
 * shipped stylesheet produces for the shipped markup.
 */
async function addLabel(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const rows = document.querySelectorAll('.message-render');
    const host = rows[rows.length - 1];
    const line = document.createElement('div');
    line.id = 'fade-bench-label';
    line.className = 'tool-status-text';
    const label = document.createElement('span');
    label.className = 'shimmer';
    label.textContent = text;
    const clip = document.createElement('span');
    clip.className = 'shimmer-clip';
    clip.setAttribute('aria-hidden', 'true');
    const band = document.createElement('span');
    band.className = 'shimmer-band';
    const copy = document.createElement('span');
    copy.className = 'shimmer-copy';
    copy.dataset.text = text;
    band.appendChild(copy);
    clip.appendChild(band);
    label.appendChild(clip);
    line.appendChild(label);
    host.appendChild(line);
    line.scrollIntoView({ block: 'end' });
  }, LABEL);
}

/** A stylesheet laid over the shipped one for every measurement, to try a remedy. */
const EXTRA_CSS = process.env.FADE_PERF_CSS;

async function removeLabel(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('fade-bench-label')?.remove());
}

/** Playwright's own trace injects a DOM snapshotter that would dominate the profile. */
test.use({ trace: 'off', video: 'off' });

test.describe('animated label frame cost', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');

  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`frames beside ${chatName(convo)}`, async ({ page, browser }) => {
      const seeded = await seedChat(convo);
      const size = await openChat(page, convo);
      console.log(
        `\n##### ${chatName(convo)}: ${seeded.length} messages, ` +
          `${size.rows} rows mounted, ${size.nodes} elements`,
      );

      if (EXTRA_CSS) {
        await page.addStyleTag({ content: EXTRA_CSS });
      }
      const idle = await traceFrames(browser, page, () => page.waitForTimeout(TRACE_MS));
      console.log(formatFrameCost('idle', idle));

      await addLabel(page);
      await page.waitForTimeout(500);
      const shimmer = await traceFrames(
        browser,
        page,
        () => page.waitForTimeout(TRACE_MS),
        DUMP_DIR ? `${DUMP_DIR}/${chatName(convo)}.shimmer.trace.json` : undefined,
      );
      console.log(formatFrameCost('sweeping label', shimmer));
      await removeLabel(page);
      expect(shimmer.frames).toBeGreaterThan(0);

      if (process.env.FADE_PERF_SKIP_LIVE === '1') {
        return;
      }

      const session = await page.context().newCDPSession(page);
      if (CPU_RATE > 1) {
        await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
      }
      await draft(page, PROMPT);
      const run = async () => {
        await page.keyboard.press('Enter');
        await awaitRunEnd(page);
        await page.waitForTimeout(500);
      };
      const dump = (suffix: string) =>
        DUMP_DIR ? `${DUMP_DIR}/${chatName(convo)}.${suffix}` : undefined;
      const live = await traceFrames(browser, page, run, dump('live.trace.json'));
      console.log(formatFrameCost(`live run cpu x${CPU_RATE}`, live));
      if (WITH_PROFILE) {
        await draft(page, PROMPT);
        const top = await profileScript(session, run, 30, dump('live.cpuprofile'));
        console.log(`live run (${PROMPT}) script self-time, cpu x${CPU_RATE}:`);
        for (const line of top) {
          console.log(`    ${line}`);
        }
      }
    });
  }
});
