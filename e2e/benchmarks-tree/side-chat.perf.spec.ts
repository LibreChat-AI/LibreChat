import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../specs/mock/helpers';
import { createBrowserProbe, formatBrowserPhase, installBrowserPerf } from '../perf/browser';
import { openChatHistory } from '../specs/mock/scenarios/sidebar';

/**
 * Side-chat benchmark: what a conversation open beside the chat costs the chat on screen.
 *
 * The same main conversation is typed in and streamed into with the panel closed, with it open
 * and idle, and with it open and streaming a reply of its own. Each phase prints the browser's
 * main-thread time and the components React rendered, counted by where on the page they are:
 * the main chat (its thread, navigation rail and composer), the side chat, the sidebar, and the
 * shell around them. A side chat that leaves the main chat alone shows the main counts
 * unchanged from the closed phases, and next to nothing rendered in main while only the side
 * chat is busy.
 *
 * Built client (production timings; the render counts need no names):
 *   npx playwright test -c e2e/playwright.config.tree-perf-prod.ts side-chat
 *
 * `SIDE_CHAT_PERF_TURNS` sizes the main conversation. `SIDE_CHAT_PERF_NAMES=<n>` also prints the
 * `n` components rendered most in each part of the page, which reads best against a client
 * built with its names kept (`npx vite build --minify false` in `client`). The numbers are
 * printed; nothing is asserted.
 */

const TURNS = Number(process.env.SIDE_CHAT_PERF_TURNS) || 12;
const NAMES = Number(process.env.SIDE_CHAT_PERF_NAMES) || 0;
const TYPED = 'The quick brown fox jumps over the lazy dog again';
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';
const ZONES = ['main', 'side', 'nav', 'shell'] as const;

type Zone = (typeof ZONES)[number];
type Renders = {
  commits: number;
  zones: Record<Zone, number>;
  keys: number[];
  names: Record<string, number>;
};

declare global {
  interface Window {
    __SIDE_CHAT_PERF__: Renders;
  }
}

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
  trace: 'off',
  video: 'off',
  screenshot: 'off',
});

/**
 * Counts the components each commit rendered, by the part of the page they are in, through the
 * hook React offers its DevTools; it works on the built client. A fiber rendered when it is
 * new or did work, and a subtree whose child pointer did not move is skipped, as React skipped
 * it. The counts are of components that ran, not of distinct names: two components can share
 * one (the app's `Markdown` and the library's), and a count that looks like a double render
 * is to be checked against a single commit before it is believed. Also keeps the duration of
 * every keystroke the browser reports as slower than a frame.
 */
function installRenderProbe(): void {
  type Fiber = {
    tag: number;
    flags: number;
    alternate: Fiber | null;
    child: Fiber | null;
    sibling: Fiber | null;
    stateNode: unknown;
    type: unknown;
    elementType: unknown;
  };
  type Named = { displayName?: string; name?: string; render?: Named; type?: Named };
  /**
   * Function, class, forwardRef and plain-memo fibers: the ones a component's own code runs
   * for. A `memo` with a comparator is two fibers, a wrapper (tag 14) around the component it
   * wraps, and counting the wrapper would count every such component twice.
   */
  const COMPONENT_TAGS = new Set([0, 1, 11, 15]);
  const HOST = 5;
  const PERFORMED_WORK = 1;
  const state: Renders = {
    commits: 0,
    zones: { main: 0, side: 0, nav: 0, shell: 0 },
    keys: [],
    names: {},
  };
  /** What the component is called, where the build kept its name. */
  const nameOf = (fiber: Fiber): string => {
    const type = (fiber.elementType ?? fiber.type) as Named | null;
    const inner = type?.render ?? type?.type;
    return (
      type?.displayName ??
      type?.name ??
      inner?.displayName ??
      inner?.name ??
      inner?.render?.name ??
      '?'
    );
  };

  const zoneOf = (element: Element, zone: Zone): Zone => {
    if (element.getAttribute('aria-label') === 'Side chat') {
      return 'side';
    }
    /** What is inside a chat is that chat's, its own navigation rail included. */
    if (zone === 'side' || zone === 'main') {
      return zone;
    }
    if (element.tagName === 'MAIN') {
      return 'main';
    }
    if (element.tagName === 'NAV') {
      return 'nav';
    }
    return zone;
  };

  const walk = (first: Fiber | null, zone: Zone): void => {
    for (let fiber = first; fiber != null; fiber = fiber.sibling) {
      const here =
        fiber.tag === HOST && fiber.stateNode instanceof Element
          ? zoneOf(fiber.stateNode, zone)
          : zone;
      const rendered = fiber.alternate == null || (fiber.flags & PERFORMED_WORK) !== 0;
      if (rendered && COMPONENT_TAGS.has(fiber.tag)) {
        state.zones[here] += 1;
        const key = `${here}:${nameOf(fiber)}`;
        state.names[key] = (state.names[key] ?? 0) + 1;
      }
      if (fiber.alternate == null || fiber.child !== fiber.alternate.child) {
        walk(fiber.child, here);
      }
    }
  };

  const renderers = new Map<number, unknown>();
  Object.assign(window, {
    __SIDE_CHAT_PERF__: state,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers,
      supportsFiber: true,
      isDisabled: false,
      checkDCE: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      inject(renderer: unknown) {
        renderers.set(renderers.size + 1, renderer);
        return renderers.size;
      },
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        state.commits += 1;
        try {
          walk(root.current, 'shell');
        } catch {
          /* A count lost to a fiber shape this probe does not know is not worth a failed run. */
        }
      },
    },
  });

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'keydown') {
          state.keys.push(entry.duration);
        }
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  } catch {
    /* Event timing unsupported: the keystroke columns stay empty. */
  }
}

async function resetRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__SIDE_CHAT_PERF__;
    state.commits = 0;
    state.keys.length = 0;
    state.names = {};
    for (const zone of Object.keys(state.zones) as Array<keyof typeof state.zones>) {
      state.zones[zone] = 0;
    }
  });
}

const readRenders = (page: Page): Promise<Renders> =>
  page.evaluate(() => ({
    commits: window.__SIDE_CHAT_PERF__.commits,
    zones: { ...window.__SIDE_CHAT_PERF__.zones },
    keys: [...window.__SIDE_CHAT_PERF__.keys],
    names: { ...window.__SIDE_CHAT_PERF__.names },
  }));

/** The components rendered most in each part of the page, for a build that kept their names. */
function formatNames({ names }: Renders): string[] {
  return ZONES.map((zone) => {
    const top = Object.entries(names)
      .filter(([key]) => key.startsWith(`${zone}:`))
      .sort((a, b) => b[1] - a[1])
      .slice(0, NAMES)
      .map(([key, count]) => `${key.slice(zone.length + 1)}×${count}`);
    return `${''.padEnd(34)} ${zone.padEnd(5)} ${top.join(' ')}`;
  }).filter((line) => line.trim().includes(' '));
}

function formatRenders({ commits, zones, keys }: Renders): string {
  const sorted = [...keys].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return (
    `commits=${String(commits).padStart(4)} ` +
    ZONES.map((zone) => `${zone}=${String(zones[zone]).padStart(6)}`).join(' ') +
    (sorted.length > 0 ? ` keydown p50/p95/max=${at(0.5)}/${at(0.95)}/${at(1)}ms` : '')
  );
}

test('what a conversation open beside the chat costs the chat on screen', async ({ page }) => {
  await installBrowserPerf(page);
  await page.addInitScript(installRenderProbe);
  const probe = await createBrowserProbe(page);
  const label = `side-perf-${Date.now().toString(36)}`;

  const measure = async (name: string, run: () => Promise<void>): Promise<void> => {
    await resetRenders(page);
    await probe.start();
    await run();
    const phase = await probe.finish();
    console.log(formatBrowserPhase(name.padEnd(34), phase));
    const renders = await readRenders(page);
    console.log(`${''.padEnd(34)} ${formatRenders(renders)}`);
    if (NAMES > 0) {
      console.log(formatNames(renders).join('\n'));
    }
  };

  /** The conversation that opens beside, then the main one with some history. */
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, replyPrompt(`${label}-beside`));
  await expect(messagesView(page).getByText(replyText(`${label}-beside`))).toBeVisible();
  const besideUrl = page.url();
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  for (let turn = 0; turn < TURNS; turn++) {
    await sendMessageAndWaitForCompletion(page, replyPrompt(`${label}-${turn}`));
  }
  const mainForm = page.locator('main form').first();
  const mainBox = mainForm.getByRole('textbox', { name: 'Message input' });
  const mainRows = messagesView(page).locator('.message-render');
  await expect(mainRows).toHaveCount(TURNS * 2, { timeout: 30_000 });

  const idle = () => page.waitForTimeout(8_000);
  const typeIn = (box: typeof mainBox) => async () => {
    await box.click();
    await page.keyboard.type(TYPED, { delay: 25 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
  };
  const typeInMain = typeIn(mainBox);
  let sent = 0;
  /** Starts a slow reply from a composer and resolves once its first words are on screen. */
  const startStream = async (box: typeof mainBox, rows: typeof mainRows) => {
    const before = await rows.count();
    await box.click();
    await page.keyboard.type(`E2E_SLOW_REPLY:${label}-slow-${++sent}`);
    await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(before + 2, { timeout: 30_000 });
    await expect(rows.last()).toContainText('chunk-010', { timeout: 30_000 });
  };
  const endStream = async (form: typeof mainForm, rows: typeof mainRows) => {
    await expect(rows.last()).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
    await expect(form.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
      timeout: 30_000,
    });
    await page.waitForTimeout(500);
  };
  const streamInMain = async () => {
    await startStream(mainBox, mainRows);
    await endStream(mainForm, mainRows);
  };
  const mainPhases = async (panel: string) => {
    await measure(`${panel}: idle 8s`, idle);
    await measure(`${panel}: typing in main`, typeInMain);
    await measure(`${panel}: main streams`, streamInMain);
  };

  console.log(`\nSide-chat benchmark: ${TURNS * 2} rows in the main conversation\n`);
  await mainPhases('closed');

  await openChatHistory(page);
  const row = conversationRow(page, besideUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await measure('opening the panel', async () => {
    await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
    await expect(sideChat).toContainText(replyText(`${label}-beside`), { timeout: 30_000 });
    await page.waitForTimeout(1_500);
  });
  const sideForm = sideChat.locator('form');
  const sideBox = sideChat.getByRole('textbox', { name: 'Message input' });
  const sideRows = sideChat.locator('.message-render');

  await mainPhases('open');
  await measure('open: typing in side', typeIn(sideBox));

  await measure('open: side streams, main idle', async () => {
    await startStream(sideBox, sideRows);
    await endStream(sideForm, sideRows);
  });
  await startStream(sideBox, sideRows);
  await measure('open: typing in main, side streams', typeInMain);
  await endStream(sideForm, sideRows);
  await measure('open: both stream', async () => {
    await startStream(sideBox, sideRows);
    await streamInMain();
    await endStream(sideForm, sideRows);
  });

  await sideChat.getByRole('button', { name: 'Close' }).click();
  await expect(sideChat).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await mainPhases('closed again');
});
