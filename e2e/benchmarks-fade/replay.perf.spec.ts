import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ExportedMessage } from './chats';
import type { WindowCost } from './trace';
import type { Part } from './replay';
import {
  CONVOS,
  ENDPOINT,
  awaitRunEnd,
  chatName,
  draft,
  openChat,
  removeChats,
  seedChat,
} from './chats';
import { buildFrames, startReplayServer } from './replay';
import { formatFrameCost, profileScript, traceFrames, traceWindows } from './trace';

/**
 * What each kind of stream event costs the main thread.
 *
 * One assistant message from the exported chat is streamed back into the
 * client at the tail of that same chat, a frame at a time with a pause between
 * frames, so the work each frame causes lands in its own window: a tool call
 * starting, its arguments, its result, a label filling, a reasoning delta.
 * Windows with no frame give the floor the run's animations set on their own.
 */

/** Pause after each frame; long enough for the commit, its effects and its frames. */
const GAP_MS = Number(process.env.FADE_PERF_GAP_MS) || 150;
/** Frames per trace. A trace is parsed whole, so the run is recorded in pieces. */
const SEGMENT = 48;
/** An idle window after every this many frames. */
const IDLE_EVERY = 8;
/** How long the run is held mid-stream to read the cost of its animations alone. */
const QUIET_MS = 3000;
/** Position of the assistant message to replay; the most varied one by default. */
const REPLAY_INDEX = process.env.FADE_PERF_REPLAY_INDEX;
const MAX_PARTS = Number(process.env.FADE_PERF_REPLAY_PARTS) || Number.POSITIVE_INFINITY;
const CPU_RATE = Number(process.env.FADE_PERF_CPU) || 1;
const DUMP_DIR = process.env.FADE_PERF_DUMP;
/** `1` samples the page's JavaScript across the replay instead of tracing it. */
const WITH_PROFILE = process.env.FADE_PERF_PROFILE === '1';
/** A stylesheet laid over the shipped one, to try a remedy. */
const EXTRA_CSS = process.env.FADE_PERF_CSS;
/** `1` prints what is animating after each idle window, and on which properties. */
const LIST_ANIMATIONS = process.env.FADE_PERF_ANIMATIONS === '1';
const MARK = 'fade:';

function variety(message: ExportedMessage): number {
  const kinds = new Set<string>();
  for (const part of message.content ?? []) {
    const toolCall = part.tool_call as { name?: string } | undefined;
    kinds.add(part.type === 'tool_call' ? `tool:${toolCall?.name}` : String(part.type));
  }
  return kinds.size;
}

function pickSource(messages: ExportedMessage[]): ExportedMessage {
  if (REPLAY_INDEX != null) {
    return messages[Number(REPLAY_INDEX)];
  }
  return messages
    .filter((message) => !message.isCreatedByUser && Array.isArray(message.content))
    .reduce((best, message) => (variety(message) > variety(best) ? message : best));
}

/** What is animating right now, and which properties: anything other than
 *  `opacity` or `transform` is driven from the main thread, frame by frame. */
function runningAnimations(page: Page): Promise<string> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        const target = effect?.target;
        const properties = new Set<string>();
        for (const keyframe of effect?.getKeyframes() ?? []) {
          for (const key of Object.keys(keyframe)) {
            if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key)) {
              properties.add(key);
            }
          }
        }
        const name = 'animationName' in animation ? animation.animationName : 'transition';
        const where = target
          ? `${target.tagName.toLowerCase()}.${String(target.getAttribute('class')).slice(0, 60)}`
          : '?';
        return `${name}[${Array.from(properties).join(',')}]@${where}`;
      })
      .join(' | '),
  );
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

type Row = { kind: string; count: number } & Record<
  'task' | 'worst' | 'script' | 'layout' | 'style' | 'paint' | 'gc',
  number
>;

function summarize(windows: WindowCost[], kindOf: (name: string) => string): Row[] {
  const groups = new Map<string, WindowCost[]>();
  for (const window of windows) {
    const kind = kindOf(window.name);
    groups.set(kind, [...(groups.get(kind) ?? []), window]);
  }
  return Array.from(groups.entries())
    .map(([kind, group]) => ({
      kind,
      count: group.length,
      task: median(group.map((window) => window.taskMs)),
      worst: Math.max(...group.map((window) => window.worstTaskMs)),
      script: median(group.map((window) => window.scriptMs)),
      layout: median(group.map((window) => window.layoutMs)),
      style: median(group.map((window) => window.styleMs)),
      paint: median(group.map((window) => window.paintMs)),
      gc: median(group.map((window) => window.gcMs)),
    }))
    .sort((a, b) => b.task - a.task);
}

function print(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log(
    `${'event'.padEnd(46)}${'n'.padStart(4)}${'task'.padStart(8)}${'worst'.padStart(8)}` +
      `${'script'.padStart(8)}${'layout'.padStart(8)}${'style'.padStart(7)}${'paint'.padStart(7)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.kind.padEnd(46)}${String(row.count).padStart(4)}${row.task.toFixed(1).padStart(8)}` +
        `${row.worst.toFixed(1).padStart(8)}${row.script.toFixed(1).padStart(8)}` +
        `${row.layout.toFixed(1).padStart(8)}${row.style.toFixed(1).padStart(7)}` +
        `${row.paint.toFixed(1).padStart(7)}`,
    );
  }
}

test.use({ trace: 'off', video: 'off' });

test.describe('stream event cost', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`events replayed into ${chatName(convo)}`, async ({ page, browser }) => {
      const messages = await seedChat(convo);
      const source = pickSource(messages);
      const content = (source.content ?? []).slice(0, MAX_PARTS) as Part[];
      const runId = randomUUID();
      const frames = buildFrames(content, runId);
      const size = await openChat(page, convo);
      console.log(
        `\n##### ${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements; ` +
          `replaying ${content.length} parts as ${frames.length} frames, ${GAP_MS}ms apart, cpu x${CPU_RATE}`,
      );

      if (EXTRA_CSS) {
        await page.addStyleTag({ content: EXTRA_CSS });
      }
      const server = await startReplayServer();
      let sent: Record<string, unknown> = {};
      await page.route(/\/api\/agents\/chat\/stream\//, (route) =>
        route.continue({ url: server.url }),
      );
      await page.route(/\/api\/agents\/chat\/[^/]+$/, async (route) => {
        const request = route.request();
        if (request.method() !== 'POST' || request.url().endsWith('/abort')) {
          await route.fallback();
          return;
        }
        sent = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          contentType: 'application/json',
          headers: { 'X-LibreChat-Generation-Protocol': '2' },
          body: JSON.stringify({
            streamId: convo.id,
            conversationId: convo.id,
            generationCreatedAt: Date.now(),
            status: 'started',
            generationProtocolVersion: 2,
          }),
        });
      });
      if (CPU_RATE > 1) {
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
      }

      await draft(page, 'Replay the recorded run.');
      await page.keyboard.press('Enter');
      await Promise.race([
        server.connected,
        page.waitForTimeout(30_000).then(() => {
          throw new Error('The client never opened the replayed stream');
        }),
      ]);
      const requestMessage = {
        messageId: sent.messageId,
        parentMessageId: sent.parentMessageId,
        conversationId: convo.id,
        text: sent.text,
        sender: 'User',
        isCreatedByUser: true,
      };
      server.send({ created: true, message: requestMessage, streamId: convo.id });
      await page.waitForTimeout(1500);

      const windows: WindowCost[] = [];
      const mark = (name: string) =>
        page.evaluate((value) => {
          performance.mark(value);
        }, `${MARK}${name}`);
      if (WITH_PROFILE) {
        const session = await page.context().newCDPSession(page);
        const top = await profileScript(
          session,
          async () => {
            for (const frame of frames) {
              server.send(frame.payload);
              await page.waitForTimeout(GAP_MS);
            }
          },
          40,
          DUMP_DIR ? `${DUMP_DIR}/${chatName(convo)}.replay.cpuprofile` : undefined,
        );
        console.log('script self time across the replay:');
        for (const line of top) {
          console.log(`    ${line}`);
        }
      }
      for (let offset = 0; !WITH_PROFILE && offset < frames.length; offset += SEGMENT) {
        const segment = frames.slice(offset, offset + SEGMENT);
        if (offset > 0 && offset <= SEGMENT) {
          /** The run held still: no frame arrives, so whatever the main thread
           *  does here it does for the run's animations alone. */
          await page.waitForTimeout(1500);
          const quiet = await traceFrames(browser, page, () => page.waitForTimeout(QUIET_MS));
          console.log(formatFrameCost(`run held still for ${QUIET_MS}ms`, quiet));
          if (DUMP_DIR) {
            /** Every sweep frozen at one instant, so two builds can be compared by eye. */
            await page.evaluate(() => {
              for (const animation of document.getAnimations()) {
                animation.pause();
                animation.currentTime = 1250;
              }
            });
            await page.waitForTimeout(300);
            await page
              .locator(`[id="${runId}"]`)
              .screenshot({ path: `${DUMP_DIR}/${chatName(convo)}.held.png` });
            await page.evaluate(() => {
              for (const animation of document.getAnimations()) {
                animation.play();
              }
            });
          }
        }
        const traced = await traceWindows(browser, page, MARK, async () => {
          for (const [position, frame] of segment.entries()) {
            await mark(`${frame.kind}|${frame.index}`);
            server.send(frame.payload);
            await page.waitForTimeout(GAP_MS);
            if ((position + 1) % IDLE_EVERY === 0) {
              await mark(`idle|${frame.index}`);
              await page.waitForTimeout(GAP_MS);
              if (LIST_ANIMATIONS) {
                console.log(`animating after ${frame.kind}: ${await runningAnimations(page)}`);
              }
            }
          }
          await mark('end|0');
        });
        windows.push(...traced.filter((window) => !window.name.startsWith('end|')));
      }

      const finalWindows = await traceWindows(browser, page, MARK, async () => {
        await mark('final|0');
        server.send({
          final: true,
          conversation: {
            conversationId: convo.id,
            title: convo.title,
            endpoint: ENDPOINT.label,
            endpointType: 'custom',
            model: ENDPOINT.model,
          },
          title: convo.title,
          requestMessage,
          responseMessage: {
            messageId: runId,
            parentMessageId: sent.messageId,
            conversationId: convo.id,
            isCreatedByUser: false,
            sender: 'Assistant',
            content,
            text: '',
            endpoint: ENDPOINT.label,
            model: ENDPOINT.model,
          },
          generationProtocolVersion: 2,
        });
        server.end();
        await awaitRunEnd(page, true);
        await page.waitForTimeout(500);
      });
      windows.push(...finalWindows);
      await server.close();

      const kindOf = (name: string) => name.split('|')[0];
      print('per event kind (median ms per window)', summarize(windows, kindOf));
      print(
        'per event family',
        summarize(windows, (name) => kindOf(name).split(':')[0]),
      );
      /** The same events early and late in the run: a cost that grows with the
       *  parts already streamed shows up as the gap between these. */
      const third = Math.ceil(content.length / 3);
      print(
        'per event family, by position in the run',
        summarize(windows, (name) => {
          const [kind, index] = name.split('|');
          const position = Number(index);
          const band = ['first', 'middle', 'last'][Math.min(2, Math.floor(position / third))];
          return `${kind.split(':')[0]} (${band} third)`;
        }).sort((a, b) => a.kind.localeCompare(b.kind)),
      );
      if (DUMP_DIR) {
        fs.writeFileSync(
          `${DUMP_DIR}/${chatName(convo)}.replay.windows.json`,
          JSON.stringify(windows),
        );
      }
      const rendered = await page.evaluate(
        (id) => document.getElementById(id)?.querySelectorAll('*').length ?? 0,
        runId,
      );
      console.log(`\nreplayed row holds ${rendered} elements after the run`);
      expect(rendered).toBeGreaterThan(0);
    });
  }
});
