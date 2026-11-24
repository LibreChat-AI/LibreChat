import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { expectNoScrollAnchoring, withoutScrollAnchoring } from '../anchoring';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessage } from '../helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * A long thread mounts in steps, so for a moment after it opens some of its rows are not in the
 * document, and the copy-last-code shortcut reads the document. Opened at its end, a thread is
 * missing its oldest rows: with its only code block in one of those the shortcut found
 * nothing, copied nothing and let the key press through. Opened at its start (auto-scroll off),
 * it is missing its latest rows, and the shortcut copied an older block than the last one.
 */

const TURNS = 800;
const CODE = 'const only = "block";';
const LATEST = 'const latest = "block";';

/** A user turn long enough to be collapsed to a preview once it has measured itself. */
const LONG_TURN = Array.from({ length: 60 }, (_, line) => `A long turn, line ${line + 1}.`).join(
  '\n\n',
);

const fenced = (code: string) => `Some code:\n\n\`\`\`js\n${code}\n\`\`\`\n`;

type Thread = {
  /** Code for a block in the last reply. */
  latest?: string;
  /** Makes every user turn this many rows apart a long one. */
  longEvery?: number;
};

/** A thread with a code block in its first reply and, when given one, another in its last. */
async function seedThread(thread: Thread = {}): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Code far back', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: TURNS }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text: textAt(index, thread),
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

function textAt(index: number, { latest, longEvery = 0 }: Thread): string {
  if (index === 1) {
    return fenced(CODE);
  }
  if (latest != null && index === TURNS - 1) {
    return fenced(latest);
  }
  const isLong = longEvery > 0 && index % 2 === 0 && index % longEvery === 0;
  return isLong ? LONG_TURN : `Turn ${index + 1} of the thread`;
}

/**
 * The shortcut is one the composer keeps to itself while it has focus, and the composer takes
 * focus as a chat opens: press it as a reader who is in the thread, not typing.
 */
async function copyLastCode(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+Shift+K');
}

const mountedRows = (page: Page) =>
  page.evaluate(() => document.getElementsByClassName('message-render').length);

/** Mounting, and landed on its end: the open's own scroll there is not the reader's. */
const landed = (page: Page) =>
  page.waitForFunction(() => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    return (
      scroller != null &&
      document.getElementsByClassName('message-render').length >= 40 &&
      scroller.scrollTop > 0 &&
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
    );
  });

test.describe('copy last code in a long thread', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test.setTimeout(120_000);

  let conversationId: string;

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('copies a block from a row the thread had not mounted yet @scenario:copy-last-code-while-thread-mounts', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    /** The thread has opened on its latest rows and is still bringing in the rest. */
    await page.waitForFunction(
      () => document.getElementsByClassName('message-render').length >= 16,
    );
    const before = await mountedRows(page);
    await copyLastCode(page);
    const after = await mountedRows(page);
    info.annotations.push({ type: 'rows at the key press', description: `${before} of ${TURNS}` });

    /** The press copied the block, having brought the rest of the thread in to find it. */
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    expect(after).toBe(TURNS);
    /** The reader is still where the thread opened: on its latest turn. */
    await expect(page.locator('.message-render').last()).toBeInViewport();
  });

  test('keeps a reader who scrolled up beside a reply where they were @scenario:copy-last-code-holds-the-reader-beside-a-reply', async ({
    page,
  }) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    const rows = page.locator('.message-render');
    await expect(rows).toHaveCount(TURNS, { timeout: 60_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    /** Ten seconds pass before each of this reply's tokens: the run is in flight throughout. */
    await sendMessage(page, `E2E_PRE_TOKEN_REPLY:${randomUUID().slice(0, 8)}`);
    const stop = page.getByTestId('stop-generation-button');
    await expect(stop).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    await landed(page);
    const view = await page.getByTestId('messages-view').boundingBox();
    await page.mouse.move((view?.x ?? 0) + (view?.width ?? 800) / 2, (view?.y ?? 0) + 300);
    await page.mouse.wheel(0, -1200);
    /** A wheel scroll is animated: let it land before reading where it left the reader. */
    await page.waitForTimeout(400);
    const top = () =>
      page.evaluate(() => {
        const marked =
          document.querySelector('[data-reading]') ??
          Array.from(document.getElementsByClassName('message-render')).find(
            (row) => row.getBoundingClientRect().top > 80,
          );
        marked?.setAttribute('data-reading', '');
        return marked?.getBoundingClientRect().top ?? Number.NaN;
      });
    const before = await top();
    await copyLastCode(page);
    const after = await top();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    await expect(rows).toHaveCount(TURNS + 2);
    /** Hundreds of rows landed above the row they were reading, tens of thousands of pixels
     *  of them. Stepping beside a reply lets a row slip a few pixels between the two
     *  readings; a reader who lost their place is a screen or more away. */
    expect(Math.abs(after - before)).toBeLessThanOrEqual(60);
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 30_000 });
  });

  test('copies the latest block of a thread opened at its start, not an older one @scenario:copy-last-code-while-thread-mounts-from-its-start', async ({
    page,
  }) => {
    /** With auto-scroll off a thread opens on its first turn and mounts towards its end. */
    await page.addInitScript(() => window.localStorage.setItem('autoScroll', 'false'));
    conversationId = await seedThread({ latest: LATEST });
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    const rows = page.locator('.message-render');
    await page.waitForFunction(
      () => document.getElementsByClassName('message-render').length >= 16,
    );
    /** The first reply and its block are in from the first step; the last reply is not. */
    await expect(rows.first()).toBeInViewport();
    await copyLastCode(page);

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LATEST);
    expect(await mountedRows(page)).toBe(TURNS);
    /** The latest rows landed below the reader, who is still on the first turn. */
    await expect(rows.first()).toBeInViewport();
  });
});

/** A row that is held moves by less than a pixel; one that is lost, by a screen or more. */
const HELD = 2;
/** Tens of thousands of pixels of rows land above a reader near the end of this thread. */
const LANDED_ABOVE = 10_000;
/** How far above the thread's end a reader has to be to count as up the thread. */
const UP_THE_THREAD = 600;

type Place = { top: number; scrollTop: number; fromEnd: number; rows: number };
type Press = { before: Place; after: Place };
type Reader = { __place?: () => Place; __pressed?: Place };

const fromEnd = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    return scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0;
  });

/** Wheels up the thread and marks the row the reader then has at the top of their screen. */
async function scrollUp(page: Page): Promise<void> {
  const view = await page.getByTestId('messages-view').boundingBox();
  await page.mouse.move((view?.x ?? 0) + (view?.width ?? 800) / 2, (view?.y ?? 0) + 300);
  /** Tick by tick, as a wheel gives them, until they are there: a step already under way when
   *  a tick arrives can cancel the scroll it started, and the steps after it wait for the wheel
   *  to rest. */
  for (let tick = 0; tick < 20 && (await fromEnd(page)) < UP_THE_THREAD + 300; tick++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(40);
  }
  /** A wheel scroll is animated: let it land before marking where it left the reader. */
  await page.waitForTimeout(400);
  await page.evaluate(() =>
    Array.from(document.getElementsByClassName('message-render'))
      .find((row) => row.getBoundingClientRect().top > 80)
      ?.setAttribute('data-reading', ''),
  );
}

/**
 * Presses the shortcut and reads where the marked row and the scroller were as the key went
 * down, ahead of the app hearing of it, and where they are once the press has been handled and
 * painted. The thread is still stepping until the press, so a reading taken any earlier would
 * count what the steps did.
 *
 * `atOrigin` puts the reader at the very top of the scroller as the key goes down, on the first
 * of the rows mounted so far. They cannot be found resting there: each step moves a reader at
 * the top down by what it adds, so they are there only between reaching it and the next step.
 */
async function press(page: Page, info: TestInfo, atOrigin = false): Promise<Press> {
  await page.evaluate((origin) => {
    const reader = window as unknown as Reader;
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    const place = (): Place => ({
      top: document.querySelector('[data-reading]')?.getBoundingClientRect().top ?? Number.NaN,
      scrollTop: scroller?.scrollTop ?? Number.NaN,
      fromEnd: scroller
        ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        : Number.NaN,
      rows: document.getElementsByClassName('message-render').length,
    });
    reader.__place = place;
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key.toLowerCase() !== 'k') {
          return;
        }
        if (origin && scroller) {
          scroller.scrollTop = 0;
          document.getElementsByClassName('message-render')[0]?.setAttribute('data-reading', '');
        }
        reader.__pressed = place();
      },
      { capture: true },
    );
  }, atOrigin);
  await copyLastCode(page);
  const reading = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const reader = window as unknown as Required<Reader>;
    return { before: reader.__pressed, after: reader.__place() };
  });
  info.annotations.push({ type: 'reader', description: JSON.stringify(reading) });
  return reading;
}

/** Opens the thread beside a reply in flight, scrolls the reader up it while it mounts, and
 *  presses the shortcut. */
async function pressBesideReply(page: Page, info: TestInfo): Promise<Press> {
  const rows = page.locator('.message-render');
  await expect(rows).toHaveCount(TURNS, { timeout: 60_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  /** Ten seconds pass before each of this reply's tokens: the run is in flight throughout. */
  await sendMessage(page, `E2E_PRE_TOKEN_REPLY:${randomUUID().slice(0, 8)}`);
  const stop = page.getByTestId('stop-generation-button');
  await expect(stop).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
  await landed(page);
  await scrollUp(page);
  const reading = await press(page, info);
  /** The run was under way throughout. */
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  return reading;
}

/** The press copied the block, having brought the rows still to come in above the reader,
 *  and the row they had marked is where it was. */
async function expectHeld(page: Page, { before, after }: Press, rows = TURNS): Promise<void> {
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
  expect(before.rows).toBeLessThan(rows);
  expect(after.rows).toBe(rows);
  expect(after.scrollTop - before.scrollTop).toBeGreaterThan(LANDED_ABOVE);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(HELD);
}

/**
 * Where the browser has no scroll anchoring (Safari) nothing holds a reader in place but the
 * mount itself. The rest of the thread lands above them in the one commit that also ends the
 * mount, so the row they were reading is put back where it was by hand, in that commit.
 */
test.describe('copy last code in a long thread, in a browser without scroll anchoring', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test.setTimeout(120_000);

  let conversationId: string;

  test.beforeEach(async ({ page }) => {
    await withoutScrollAnchoring(page);
  });

  test.afterEach(async ({ page }) => {
    await expectNoScrollAnchoring(page);
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('keeps a reader who scrolled up where they were @scenario:copy-last-code-holds-the-reader-without-scroll-anchoring', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    await landed(page);
    await scrollUp(page);
    const reading = await press(page, info);

    /** They were up the thread, not on its end. */
    expect(reading.before.fromEnd).toBeGreaterThan(UP_THE_THREAD);
    await expectHeld(page, reading);
  });

  /**
   * A long user turn mounts at its full height and collapses to a preview before the frame is
   * painted, after the mount has already counted it. Dozens of them land above the reader.
   */
  test('keeps a reader who scrolled up where they were as turns above them collapse @scenario:copy-last-code-holds-the-reader-as-turns-collapse-without-scroll-anchoring', async ({
    page,
  }, info) => {
    conversationId = await seedThread({ longEvery: 20 });
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    await landed(page);
    await scrollUp(page);
    const reading = await press(page, info);

    expect(reading.before.fromEnd).toBeGreaterThan(UP_THE_THREAD);
    await expectHeld(page, reading);
  });

  test('keeps a reader who scrolled up beside a reply where they were @scenario:copy-last-code-holds-the-reader-beside-a-reply-without-scroll-anchoring', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    const reading = await pressBesideReply(page, info);

    expect(reading.before.fromEnd).toBeGreaterThan(UP_THE_THREAD);
    await expectHeld(page, reading, TURNS + 2);
  });

  /** Turns that collapse above a reader on the end pull the end in under them: the browser
   *  moves the scroll position with it, and they are not to be moved a second time. */
  test('keeps a reader at the end of the thread on its latest turn @scenario:copy-last-code-stays-on-the-latest-turn-without-scroll-anchoring', async ({
    page,
  }, info) => {
    conversationId = await seedThread({ longEvery: 20 });
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    await landed(page);
    const latest = page.locator('.message-render').last();
    await latest.evaluate((row) => row.setAttribute('data-reading', ''));
    const reading = await press(page, info);

    /** On the end, give or take the pixel or two the steps before the press can leave them
     *  short of it, and no further from it afterwards. */
    expect(reading.before.fromEnd).toBeLessThanOrEqual(4);
    await expectHeld(page, reading);
    expect(reading.after.fromEnd).toBeLessThanOrEqual(reading.before.fromEnd + 1);
    await expect(latest).toBeInViewport();
  });

  test('keeps the row a reader reached at the top of the rows mounted so far @scenario:copy-last-code-holds-the-reader-at-the-scroll-origin-without-scroll-anchoring', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    await landed(page);
    const reading = await press(page, info, true);

    expect(reading.before.scrollTop).toBe(0);
    await expectHeld(page, reading);
  });
});

/**
 * A browser can anchor scroll and still hold nobody through the commit that ends the mount.
 * Beside a reply the mount holds the reader itself and the scroller's anchoring is off; it
 * comes back on in the commit the rest of the thread lands in. Chromium and Firefox anchor
 * through that commit. WebKit, where it anchors at all, does not, and the reader was left tens
 * of thousands of pixels from their row.
 */
test.describe('copy last code in a long thread, in a browser whose anchoring misses the last commit', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test.setTimeout(120_000);

  let conversationId: string;

  test.beforeEach(async ({ page }) => {
    await withoutScrollAnchoring(page, { reported: true });
  });

  test.afterEach(async ({ page }) => {
    await expectNoScrollAnchoring(page, { reported: true });
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('keeps a reader who scrolled up beside a reply where they were @scenario:copy-last-code-holds-the-reader-beside-a-reply-when-anchoring-misses-the-last-commit', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
    await page.goto(`/c/${conversationId}`);
    const reading = await pressBesideReply(page, info);

    expect(reading.before.fromEnd).toBeGreaterThan(UP_THE_THREAD);
    await expectHeld(page, reading, TURNS + 2);
  });
});
