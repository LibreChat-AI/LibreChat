import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import {
  clearUserConversations,
  deleteMessagesByConversation,
  deleteConversations,
  seedConversations,
  seedMessages,
} from '../specs/mock/db';
import { messagesView } from '../specs/mock/helpers';
import { getE2EUser } from '../setup/user';
import {
  attachSnapshot,
  installReactScan,
  longTaskStats,
  resetPerf,
  snapshotPerf,
  topComponents,
  totals,
} from '../perf/scan';
import {
  ROWS_PER_CONVO,
  TURNS_PER_CONVO,
  buildConversationMessages,
  convoMarker,
  turnHeading,
} from './payload';

/**
 * Conversation-switch perf benchmark (react-scan).
 *
 * Guards the single most-used navigation in the app: picking another
 * conversation from the sidebar. The regression this exists to catch is a
 * *stale* switch — the URL becomes `/c/<next>` while the previous
 * conversation is still the thing painted on screen.
 *
 * Two things made that happen, and this guards both. `RouterProvider` commits
 * location updates inside `React.startTransition` by default in react-router
 * v7, which keeps the OUTGOING tree painted until the incoming one has fully
 * rendered — so every millisecond the next thread takes to render was spent
 * showing the previous one (`App.jsx` now opts out). And navigation used to
 * await a conversation refetch before changing the route at all, spending a
 * server round trip on the departing conversation.
 *
 * The in-page sampler measures exactly that window, so either regression —
 * route updates back on the transition lane, or navigation gated behind a
 * request — shows up here as frames of the wrong conversation.
 */

type NavSample = { t: number; path: string; marker: string };

type NavGlobal = {
  samples: NavSample[];
  markers: string[];
  rafId: number;
  clickedAt: number;
  begin(markers: string[]): void;
  mark(): void;
  end(): NavSample[];
};

declare global {
  interface Window {
    __NAV__: NavGlobal;
  }
}

/**
 * Samples once per animation frame: the route the browser is showing and the
 * conversation whose rows are actually mounted. A frame that reports the next
 * conversation's path alongside the previous conversation's marker is a frame
 * the user spent looking at stale content.
 *
 * Reading only the FIRST `.message-render` row keeps the per-frame cost to one
 * row's text; every seeded row carries its conversation's marker, so whichever
 * slice the progressive mount window admitted identifies the tree either way.
 * When the main thread blocks, frames simply stop firing — the gap is the
 * stall, and the next sample reports the state the user actually saw next.
 */
const NAV_SAMPLER = `(() => {
  const nav = {
    samples: [],
    markers: [],
    rafId: 0,
    clickedAt: 0,
    begin(markers) {
      this.markers = markers;
      this.samples = [];
      this.clickedAt = 0;
      const tick = () => {
        const row = document.querySelector('.message-render');
        const text = row ? row.textContent || '' : '';
        let marker = '';
        for (const candidate of this.markers) {
          if (text.indexOf(candidate) !== -1) {
            marker = candidate;
            break;
          }
        }
        this.samples.push({ t: performance.now(), path: location.pathname, marker });
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    },
    mark() {
      this.clickedAt = performance.now();
    },
    end() {
      cancelAnimationFrame(this.rafId);
      const clickedAt = this.clickedAt;
      return this.samples.map((sample) => ({ ...sample, t: sample.t - clickedAt }));
    },
  };
  window.__NAV__ = nav;
})();`;

type SwitchTiming = {
  /** Click → the address bar showing the next conversation. */
  clickToUrlMs: number;
  /** Click → the next conversation's rows painted. */
  clickToPaintMs: number;
  /**
   * How long the PREVIOUS conversation stayed painted after the URL already
   * named the next one. Frames showing neither transcript (a spinner on a cold
   * switch) are not stale — only the wrong conversation is.
   */
  staleAfterUrlMs: number;
  /** Frames observed showing the next path over the previous transcript. */
  staleFrames: number;
  samples: number;
};

function firstSampleTime(samples: NavSample[], predicate: (sample: NavSample) => boolean): number {
  const found = samples.find(predicate);
  if (!found) {
    throw new Error('navigation sampler never observed the expected frame');
  }
  return found.t;
}

function summarize(samples: NavSample[], nextPath: string, nextMarker: string): SwitchTiming {
  const clickToUrlMs = firstSampleTime(samples, (sample) => sample.path === nextPath);
  const clickToPaintMs = firstSampleTime(
    samples,
    (sample) => sample.path === nextPath && sample.marker === nextMarker,
  );
  const staleSamples = samples.filter(
    (sample) => sample.path === nextPath && sample.marker !== '' && sample.marker !== nextMarker,
  );
  const lastStale = staleSamples[staleSamples.length - 1];
  return {
    clickToUrlMs: Math.round(clickToUrlMs),
    clickToPaintMs: Math.round(clickToPaintMs),
    staleAfterUrlMs: lastStale ? Math.round(lastStale.t - clickToUrlMs) : 0,
    staleFrames: staleSamples.length,
    samples: samples.length,
  };
}

const userEmail = getE2EUser().email;
const CONVO_A = { id: randomUUID(), label: 'A', title: 'Navigation bench alpha' };
const CONVO_B = { id: randomUUID(), label: 'B', title: 'Navigation bench bravo' };
const CONVOS = [CONVO_A, CONVO_B];

/** Conversation row in the sidebar; `Convo` labels rows "<title> conversation". */
function sidebarRow(page: Page, title: string) {
  return page.getByRole('button', { name: `${title} conversation`, exact: true });
}

/** A heading only the given conversation renders, used to confirm its paint. */
function threadHeading(page: Page, label: string, turn: number) {
  return messagesView(page)
    .getByRole('heading', { name: turnHeading(label, turn), exact: true })
    .first();
}

/**
 * Clicks the row from inside the page so the click timestamp shares the page's
 * clock with the sampler — driving it over the wire would fold the Playwright
 * round trip into every measured interval. Resolving the row by attribute here
 * rather than through a locator also keeps the click out of Playwright's
 * element-stability wait, which never settles while the thread is mid-switch.
 *
 * The accessible name sits on the inner button `ConvoLink` renders, while the
 * click handler sits on the `convo-item` container around it — so match on
 * whichever node inside a row carries the label and let the click bubble.
 */
async function clickConversation(page: Page, title: string): Promise<void> {
  await sidebarRow(page, title).waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate((label) => {
    const rows = document.querySelectorAll('[data-testid="convo-item"]');
    const row = Array.from(rows)
      .flatMap((element) => [element, ...Array.from(element.querySelectorAll('[aria-label]'))])
      .find((element) => element.getAttribute('aria-label') === label);
    if (!row) {
      throw new Error(`conversation row not found: ${label}`);
    }
    window.__NAV__.mark();
    (row as HTMLElement).click();
  }, `${title} conversation`);
}

/**
 * Holds `GET /api/convos/:id` open for one conversation and resolves to a
 * release function returning how many requests were held. Anything that awaits
 * that record before moving the route therefore cannot complete the switch
 * while the hold is in place, which is what makes the assertion independent of
 * how fast the database answers.
 */
async function holdConversationRecord(page: Page, conversationId: string) {
  const pattern = `**/api/convos/${conversationId}`;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldRequests = 0;

  await page.route(pattern, async (route) => {
    heldRequests += 1;
    await held;
    await route.continue();
  });

  return async () => {
    release();
    await page.unroute(pattern);
    return heldRequests;
  };
}

async function switchTo(
  page: Page,
  target: { id: string; label: string; title: string },
): Promise<SwitchTiming> {
  await page.evaluate(
    (markers) => {
      window.__NAV__.begin(markers);
    },
    CONVOS.map((convo) => convoMarker(convo.label)),
  );
  await clickConversation(page, target.title);
  await expect(threadHeading(page, target.label, 1)).toBeAttached({ timeout: 60_000 });
  const samples = await page.evaluate(() => window.__NAV__.end());
  return summarize(samples, `/c/${target.id}`, convoMarker(target.label));
}

function reportTiming(name: string, timing: SwitchTiming): void {
  console.log(
    `${name.padEnd(22)} click→url=${String(timing.clickToUrlMs).padStart(5)}ms ` +
      `click→paint=${String(timing.clickToPaintMs).padStart(5)}ms ` +
      `stale-after-url=${String(timing.staleAfterUrlMs).padStart(5)}ms ` +
      `stale-frames=${timing.staleFrames}`,
  );
}

async function attachTiming(testInfo: TestInfo, name: string, timing: SwitchTiming): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(timing, null, 2),
    contentType: 'application/json',
  });
}

test.describe('conversation navigation perf (react-scan)', () => {
  test.beforeAll(async () => {
    await clearUserConversations(userEmail);
    await seedConversations(
      userEmail,
      CONVOS.map((convo, index) => ({
        conversationId: convo.id,
        title: convo.title,
        updatedAt: new Date(Date.now() - index * 60_000),
      })),
    );
    for (const convo of CONVOS) {
      await seedMessages(userEmail, convo.id, buildConversationMessages(convo.label));
    }
  });

  test.afterAll(async () => {
    const ids = CONVOS.map((convo) => convo.id);
    await deleteMessagesByConversation(ids);
    await deleteConversations(ids);
  });

  test('switching between long conversations swaps the transcript with the URL', async ({
    page,
  }, testInfo) => {
    test.setTimeout(6 * 60 * 1000);

    await installReactScan(page);
    await page.addInitScript({ content: NAV_SAMPLER });

    await page.goto(`/c/${CONVO_A.id}`, { timeout: 120_000 });
    await expect(threadHeading(page, CONVO_A.label, 1)).toBeAttached({ timeout: 120_000 });
    await expect(sidebarRow(page, CONVO_B.title)).toBeVisible({ timeout: 30_000 });

    /**
     * The cold switch is the first visit to B: its messages are not cached, so
     * the incoming tree is a spinner. Frames showing that spinner are not
     * stale — only frames showing conversation A are.
     */
    await resetPerf(page);
    const cold = await switchTo(page, CONVO_B);
    const coldPerf = await snapshotPerf(page);

    /**
     * The warm switch is the case users hit constantly — bouncing between two
     * conversations they have both already opened. Both message caches are
     * populated, so the incoming tree renders a full transcript rather than a
     * spinner; this is the switch that went stale.
     *
     * The conversation record request is held open across it. A wall-clock
     * bound could not tell the two implementations apart — against a local
     * Mongo an implementation that awaits the record still answers well inside
     * any threshold — so this asserts the property directly: the switch
     * completes while the request is still unresolved.
     */
    await switchTo(page, CONVO_A);
    await expect(threadHeading(page, CONVO_A.label, 1)).toBeAttached({ timeout: 60_000 });
    await resetPerf(page);
    const releaseRecord = await holdConversationRecord(page, CONVO_B.id);
    const warm = await switchTo(page, CONVO_B);
    const heldRequests = await releaseRecord();
    const warmPerf = await snapshotPerf(page);

    const coldTotals = totals(coldPerf);
    const warmTotals = totals(warmPerf);
    const coldTasks = longTaskStats(coldPerf);
    const warmTasks = longTaskStats(warmPerf);

    console.log(
      `\n=== Conversation switch (${TURNS_PER_CONVO} turns / ${ROWS_PER_CONVO} rows each) ===`,
    );
    reportTiming('cold (uncached)', cold);
    reportTiming('warm (cached)', warm);
    console.log(
      `cold renders=${coldTotals.renders} render-time=${coldTotals.time.toFixed(0)}ms ` +
        `longtask-total=${coldTasks.total.toFixed(0)}ms worst=${coldTasks.worst.toFixed(0)}ms`,
    );
    for (const line of topComponents(coldPerf, 12)) {
      console.log(`  ${line}`);
    }
    console.log(
      `warm renders=${warmTotals.renders} render-time=${warmTotals.time.toFixed(0)}ms ` +
        `longtask-total=${warmTasks.total.toFixed(0)}ms worst=${warmTasks.worst.toFixed(0)}ms`,
    );
    for (const line of topComponents(warmPerf, 12)) {
      console.log(`  ${line}`);
    }

    await attachTiming(testInfo, 'cold-switch.json', cold);
    await attachTiming(testInfo, 'warm-switch.json', warm);
    await attachSnapshot(testInfo, 'cold-switch-renders.json', coldPerf, {
      clickToPaintMs: cold.clickToPaintMs,
      staleAfterUrlMs: cold.staleAfterUrlMs,
    });
    await attachSnapshot(testInfo, 'warm-switch-renders.json', warmPerf, {
      clickToPaintMs: warm.clickToPaintMs,
      staleAfterUrlMs: warm.staleAfterUrlMs,
    });

    /**
     * The sampler must have actually run: a zero-sample phase would satisfy
     * every upper bound below without observing anything.
     */
    expect(cold.samples).toBeGreaterThan(1);
    expect(warm.samples).toBeGreaterThan(1);

    /**
     * THE core guard: once the URL names the next conversation, the previous
     * transcript must not still be what is painted. Both fixes this benchmark
     * was written for converge here — the route now commits in the click's own
     * task with the conversation state, so the swap is atomic and no frame
     * shows the wrong pairing.
     *
     * Measured against the production build with a 250ms conversation-fetch
     * latency: before, the outgoing transcript held for 12-14 frames
     * (~280-300ms) on every switch; after, zero frames. A couple of frames of
     * slack absorbs scheduler noise; anything more means the swap stopped
     * being atomic — most likely a route update back on React's transition
     * lane, which paints the outgoing tree until the incoming one is ready.
     *
     * This holds for the cold switch too: waiting for the record there delays
     * the URL, it does not desynchronise it from the transcript.
     */
    expect(cold.staleFrames).toBeLessThanOrEqual(2);
    expect(warm.staleFrames).toBeLessThanOrEqual(2);
    expect(cold.staleAfterUrlMs).toBeLessThan(120);
    expect(warm.staleAfterUrlMs).toBeLessThan(120);

    /**
     * A warm switch must not wait on the conversation record: the whole switch
     * above completed while that request was held open. The hold must have
     * actually engaged — zero held requests would mean the route pattern
     * stopped matching and the assertion proved nothing.
     *
     * The cold switch is deliberately NOT bounded this way. A conversation
     * with no cached record still waits for it, because the sidebar row is a
     * projection without the prompt prefix, sampling params, tools and files a
     * send needs; landing the route on that would expose a composer whose
     * sends silently carry defaults.
     */
    expect(heldRequests).toBeGreaterThan(0);
    expect(warm.clickToUrlMs).toBeLessThan(400);

    /** End to end, both switches stay inside a responsive budget
     *  (measured after: ~250ms warm, ~450ms cold). */
    expect(cold.clickToPaintMs).toBeLessThan(900);
    expect(warm.clickToPaintMs).toBeLessThan(900);

    /**
     * The commit that swaps the transcript is now synchronous, so it must stay
     * small enough not to read as a freeze — a single stall past this bound
     * means the incoming thread's first commit stopped being windowed
     * (measured after: 285-356ms worst).
     */
    expect(warmTasks.worst).toBeLessThan(600);

    /**
     * Component names are mangled in the built client, so the per-component
     * tally above is diagnostic only; the TOTAL is still comparable and is
     * what catches a subscription regression that re-renders the app on every
     * route change (measured after: ~2.8k warm, ~3.4k cold, dominated by the
     * per-row hover-button chrome each message mounts).
     */
    expect(warmTotals.renders).toBeGreaterThan(100);
    expect(warmTotals.renders).toBeLessThan(9000);
  });
});
