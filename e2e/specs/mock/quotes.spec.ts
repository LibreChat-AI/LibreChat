import { expect, test, devices } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  NEW_CHAT_PATH,
  messagesView,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

type SelectionTarget = {
  /** Needle whose first character begins the range. */
  from: string;
  /** Needle whose last character ends it, when the range spans two messages. */
  to?: string;
  /** Place the range on the document selection rather than only measuring it. */
  select?: boolean;
  /** Dispatch the `mouseup` `QuoteButton` listens for once the range is placed. */
  emitMouseUp?: boolean;
};

/**
 * Resolve a needle — or a pair of them spanning two messages — to a DOM Range
 * inside the most recent `.message-render` containing it, optionally placing it
 * on the document selection, and return the viewport midpoint of its first
 * character.
 *
 * The lookup matches each message's *flattened* text rather than one text node,
 * because a needle is routinely spread over several: while a reply streams, the
 * smooth-streaming fade wraps every word of the animated message in its own
 * `<span>`, so `E2E opening paragraph` lives in three sibling text nodes until
 * the turn settles and the blocks re-render unwrapped. Flattening concatenates
 * exactly what `textContent` reports — the string the host was located by — and
 * the match's offsets are mapped back onto the nodes they came from, so every
 * gesture here works in both DOMs instead of throwing for the entire window in
 * which the reply is fully readable but not yet settled.
 */
function resolveSelection(page: Page, target: SelectionTarget) {
  return page.evaluate(({ from, to, select, emitMouseUp }) => {
    type TextRun = { node: Node; start: number };

    /** Text nodes of `host` in document order, each with its offset into the
     *  host's text — the concatenation is exactly `host.textContent`. */
    const flatten = (host: Element) => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      const runs: TextRun[] = [];
      let text = '';
      for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        if (value === '') {
          continue;
        }
        runs.push({ node, start: text.length });
        text += value;
      }
      return { runs, text };
    };

    /** Range boundary for a flattened offset, by binary search: a streaming
     *  paragraph carries one text node per word, so this is not a short list. */
    const boundaryAt = (runs: TextRun[], offset: number) => {
      let low = 0;
      let high = runs.length - 1;
      let found = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (runs[mid].start <= offset) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return { node: runs[found].node, offset: offset - runs[found].start };
    };

    const locate = (needle: string) => {
      const renders = Array.from(document.querySelectorAll('.message-render'));
      const host = [...renders].reverse().find((el) => (el.textContent ?? '').includes(needle));
      if (!host) {
        throw new Error(`No message contains: ${needle}`);
      }
      const { runs, text } = flatten(host);
      const index = text.indexOf(needle);
      if (index === -1) {
        throw new Error(`No text node contains: ${needle}`);
      }
      return { runs, index };
    };

    const head = locate(from);
    const tail = to == null ? head : locate(to);
    const start = boundaryAt(head.runs, head.index);
    const end = boundaryAt(tail.runs, tail.index + (to ?? from).length);

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    if (select === true) {
      const selection = window.getSelection();
      if (!selection) {
        throw new Error('Selection API unavailable');
      }
      selection.removeAllRanges();
      selection.addRange(range);
      if (emitMouseUp === true) {
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
    }

    const afterFirst = boundaryAt(head.runs, head.index + 1);
    const firstCharacter = document.createRange();
    firstCharacter.setStart(start.node, start.offset);
    firstCharacter.setEnd(afterFirst.node, afterFirst.offset);
    const box = firstCharacter.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, target);
}

/**
 * Place a real DOM Selection over `needle` inside the most recent
 * `.message-render` that contains it, then dispatch `mouseup` so the
 * `QuoteButton` listener fires — the deterministic equivalent of a user
 * drag-selecting that text to summon the "Add to chat" popup.
 *
 * Pass `emitMouseUp: false` to model a touch selection instead: phones deliver
 * a long-press (and every native handle drag) as a bare `selectionchange` with
 * no mouse event anywhere in the sequence, which is the whole reason the popup
 * needs a mouse-less path.
 */
async function selectMessageText(page: Page, needle: string, emitMouseUp = true) {
  await resolveSelection(page, { from: needle, select: true, emitMouseUp });
}

/**
 * Viewport coordinates of the first character of `needle` inside the most
 * recent message containing it. Measuring the `needle` text itself (not the
 * first text node in `.message-render`, which may be a `select-none`
 * screen-reader/model-label header) keeps the gesture on the actual reply word,
 * not metadata or whitespace.
 */
function measureNeedle(page: Page, needle: string) {
  return resolveSelection(page, { from: needle });
}

/**
 * Double-click the first word of `needle` using native mouse events. Unlike
 * `selectMessageText` (a programmatic Range), this exercises the browser's own
 * double-click word selection — the path the `dblclick` listener guards.
 */
async function doubleClickWord(page: Page, needle: string) {
  const point = await measureNeedle(page, needle);
  await page.mouse.dblclick(point.x, point.y);
}

/**
 * Wait for the reply to stop re-rendering before selecting text inside it.
 *
 * Distinct from the settle window `QuoteButton` applies to a *selection*: this
 * is the reply itself still streaming. A markdown re-render swaps out the text
 * node the selection points at, which collapses it — so a double-click landing
 * mid-stream loses its selection before the popup can be clicked, and every
 * `toPass` retry loses the same race rather than recovering from it.
 *
 * `sendMessage` resolves on the stream *response*, not on the final render, so
 * the wait has to be explicit.
 */
async function waitForReplyToSettle(page: Page, needle: string) {
  const readReply = () =>
    page.evaluate((text) => {
      const renders = Array.from(document.querySelectorAll('.message-render'));
      const host = [...renders].reverse().find((el) => (el.textContent ?? '').includes(text));
      return host?.textContent ?? '';
    }, needle);

  await expect(async () => {
    const before = await readReply();
    await page.waitForTimeout(250);
    expect(await readReply()).toBe(before);
  }).toPass({ timeout: 20000 });
}

/**
 * Triple-click the block containing `needle` with native mouse events, which
 * makes Chromium select that whole block and park the selection's far boundary
 * at the start of the *next* one. For a message's closing block that boundary
 * lands outside `.message-render`, on the composer wrapper — the case that used
 * to suppress the popup even though no text outside the message was selected.
 */
async function tripleClickText(page: Page, needle: string) {
  const point = await measureNeedle(page, needle);
  await page.mouse.click(point.x, point.y, { clickCount: 3 });
}

/**
 * Select from inside one message through into the next, then `mouseup`. This is
 * a genuine cross-message drag — text outside the message really is selected —
 * and must never produce a quote, however the boundary clamping treats the
 * block-overhang cases around it.
 */
async function selectAcrossMessages(page: Page, fromNeedle: string, toNeedle: string) {
  await resolveSelection(page, { from: fromNeedle, to: toNeedle, select: true, emitMouseUp: true });
}

/**
 * How many messages the live selection actually covers.
 *
 * "No popup for a cross-message selection" only means anything while the
 * selection is still crossing messages: a re-render that swaps out the nodes a
 * range points at collapses it, and a collapsed selection keeps the popup away
 * for a reason that has nothing to do with the boundary clamping under test.
 */
function selectedMessageCount(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return 0;
    }
    const range = selection.getRangeAt(0);
    return Array.from(document.querySelectorAll('.message-render')).filter((element) =>
      range.intersectsNode(element),
    ).length;
  });
}

/** Viewport-relative bottom edge of the live selection. */
function selectionBottom(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    return selection.getRangeAt(0).getBoundingClientRect().bottom;
  });
}

/**
 * Scroll the message list so the block containing `needle` sits at `fraction` of
 * the visible height, returning the signed distance moved.
 *
 * Specs move the selection between two *visible* positions rather than nudging
 * blindly by a pixel count. Blind nudges kept scrolling the selection under the
 * composer, where the popup correctly hides — real behaviour, but the opposite
 * of what a "popup follows the scroll" spec means to assert, and the chat's own
 * auto-scroll made where it landed unpredictable.
 *
 * The scroller is reached from the message itself rather than by querying
 * `.scrollbar-gutter-stable` directly: the nav and side panels carry that class
 * too, so a document-wide query can return a sidebar list that never scrolls —
 * which is exactly how these specs passed locally and moved 0px in CI. This
 * mirrors how the app resolves the same container (`MessageNav.tsx`).
 */
function scrollSelectionTo(page: Page, needle: string, fraction: number) {
  return page.evaluate(
    ({ text, at }) => {
      const renders = Array.from(document.querySelectorAll('.message-render'));
      const host = [...renders].reverse().find((el) => (el.textContent ?? '').includes(text));
      if (!host) {
        throw new Error(`No message contains: ${text}`);
      }
      const scroller = host.closest('.scrollbar-gutter-stable');
      if (!scroller) {
        throw new Error('Message is not inside a scroll container');
      }
      const room = scroller.scrollHeight - scroller.clientHeight;
      if (room <= 0) {
        throw new Error(
          `Message list does not overflow (scrollHeight ${scroller.scrollHeight}, clientHeight ${scroller.clientHeight})`,
        );
      }
      const blocks = Array.from(host.querySelectorAll('p, li, td, th, pre'));
      const target = blocks.find((el) => (el.textContent ?? '').includes(text)) ?? host;
      const targetBox = target.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      const wanted = scrollerBox.top + scrollerBox.height * at;
      const delta = targetBox.top + targetBox.height / 2 - wanted;
      const start = scroller.scrollTop;
      scroller.scrollTop = Math.min(room, Math.max(0, start + delta));
      return scroller.scrollTop - start;
    },
    { text: needle, at: fraction },
  );
}

const addToChat = (page: Page) => page.getByTestId('add-to-chat-button');
const pendingChips = (page: Page) => page.getByTestId('pending-quote-chips');
const messageQuotes = (page: Page) => messagesView(page).getByTestId('message-quotes');

/** A phone's context options, minus `defaultBrowserType` — Playwright refuses
 *  that one inside a describe group because it would force a separate worker,
 *  and this suite already runs on the Chromium it asks for. */
const PIXEL_5 = {
  userAgent: devices['Pixel 5'].userAgent,
  viewport: devices['Pixel 5'].viewport,
  deviceScaleFactor: devices['Pixel 5'].deviceScaleFactor,
  isMobile: devices['Pixel 5'].isMobile,
  hasTouch: devices['Pixel 5'].hasTouch,
};

/** Prompt whose mock reply renders as several paragraphs, so a spec can act on
 *  the message's *closing* block and can scroll a reply taller than a phone. */
const PARAGRAPHS_PROMPT = 'E2E_PARAGRAPHS_REPLY';
const OPENING_PARAGRAPH = 'E2E opening paragraph';
const CLOSING_PARAGRAPH = 'E2E closing paragraph';
/** Sits inside `.markdown-table-wrapper`, a scroll container nested in the message. */
const TABLE_CELL = 'E2E table cell text';
/** Comfortably longer than the component's 300ms selection-settle interval. */
const SETTLE_OBSERVATION_MS = 1500;

/** Seed a conversation whose latest reply has several paragraphs. */
async function seedParagraphReply(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, PARAGRAPHS_PROMPT);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(CLOSING_PARAGRAPH)).toBeVisible({ timeout: 20000 });
}

/** The mock model echoes this when a blockquote containing the token reached the prompt. */
const QUOTE_ASSERTION_PASSED = 'E2E quote assertion passed: reply';

/**
 * Select `needle` inside a message and add it as a quote, asserting the pending
 * chip count reaches `expectedCount`. Retried as a unit: a pending selection is
 * dismissed on any scroll/layout shift (e.g. auto-scroll after a new message),
 * which is correct UX but races with a scripted select+click — `toPass` re-runs
 * the select+click until the chip commits. Dedup keeps re-runs idempotent.
 */
async function addQuote(page: Page, needle: string, expectedCount: number) {
  await expect(async () => {
    await selectMessageText(page, needle);
    const button = addToChat(page);
    await expect(button).toBeVisible({ timeout: 3000 });
    await button.click();
    await expect(pendingChips(page)).toHaveAttribute('data-quote-count', String(expectedCount));
  }).toPass({ timeout: 30000 });
}

test.describe('quote references', () => {
  test('merges a quoted excerpt into the model turn, pins it to the message, and persists across reload', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // Seed an assistant reply to quote.
    let response = await sendMessage(page, 'seed for quote');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });

    // Select the reply text -> popup -> chip above the composer.
    await addQuote(page, MOCK_REPLY_TEXT, 1);
    await expect(pendingChips(page)).toContainText(MOCK_REPLY_TEXT);

    // Send a turn that asks the mock model to confirm the quote reached the prompt.
    response = await sendMessage(page, 'E2E_ASSERT_QUOTE:reply');
    expect(response.ok()).toBeTruthy();

    // The model received the merged blockquote (verified server-side by the mock).
    await expect(messagesView(page).getByText(QUOTE_ASSERTION_PASSED)).toBeVisible({
      timeout: 20000,
    });
    // Pending chips drained; the reference is pinned to the sent user message.
    await expect(pendingChips(page)).toHaveCount(0);
    await expect(messageQuotes(page)).toContainText(MOCK_REPLY_TEXT);

    // Round-trips through the DB: still pinned after reload.
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
    const conversationUrl = page.url();
    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);
    await expect(messageQuotes(page)).toContainText(MOCK_REPLY_TEXT);
  });

  test('summons the popup from a native double-click word selection', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'seed for dblclick');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await waitForReplyToSettle(page, MOCK_REPLY_TEXT);

    // A real double-click selects the word under the cursor. Chromium commits
    // that selection on `dblclick`, AFTER `mouseup` fires, so only a `dblclick`
    // listener catches it — a programmatic Range (the other tests) would bypass
    // this path entirely. Retried as a unit: auto-scroll can clear a fresh
    // selection, which races the scripted double-click.
    await expect(async () => {
      await doubleClickWord(page, MOCK_REPLY_TEXT);
      const button = addToChat(page);
      await expect(button).toBeVisible({ timeout: 3000 });
      await button.click();
      await expect(pendingChips(page)).toHaveAttribute('data-quote-count', '1');
    }).toPass({ timeout: 30000 });

    // The quoted excerpt is a word from the reply, not empty.
    await expect(pendingChips(page)).toContainText(/E2E|mock|reply/i);
  });

  test("summons the popup from a triple-click on the reply's closing paragraph", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    // Triple-clicking any *earlier* paragraph always worked, because the
    // selection's far boundary landed on the next paragraph — still inside the
    // message. On the closing paragraph that boundary escapes `.message-render`
    // and used to suppress the popup entirely, even though the user selected
    // nothing outside the message.
    await messagesView(page).getByText(CLOSING_PARAGRAPH).scrollIntoViewIfNeeded();
    await expect(async () => {
      await tripleClickText(page, CLOSING_PARAGRAPH);
      const button = addToChat(page);
      await expect(button).toBeVisible({ timeout: 3000 });
      await button.click();
      await expect(pendingChips(page)).toHaveAttribute('data-quote-count', '1');
    }).toPass({ timeout: 30000 });

    // The excerpt is the closing paragraph itself, not the overhang.
    await expect(pendingChips(page)).toContainText(CLOSING_PARAGRAPH);
  });

  test('still refuses a selection that really spans two messages', async ({ page }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    // Clamping the block-boundary overhang must not soften this: here visible
    // text from both the user's message and the reply is selected.
    //
    // Retried as a unit, and re-checked at the end: the reply's blocks
    // re-render when the turn settles (the streaming fade unwraps its per-word
    // spans), which swaps out the nodes the range points at and collapses it.
    // An attempt only counts once the selection the popup judged was still the
    // cross-message one, so a collapse cannot pass this test by default.
    await expect(async () => {
      await selectAcrossMessages(page, PARAGRAPHS_PROMPT, OPENING_PARAGRAPH);

      // Sit out the settle interval before asserting. `toBeHidden` is satisfied
      // by an element that has not been created *yet*, so checking straight away
      // would pass before the timer had a chance to publish anything.
      await page.waitForTimeout(SETTLE_OBSERVATION_MS);
      expect(
        await selectedMessageCount(page),
        'the selection must outlive the settle wait, still crossing two messages',
      ).toBeGreaterThan(1);
      await expect(addToChat(page)).toBeHidden();
      await expect(pendingChips(page)).toHaveCount(0);
    }).toPass({ timeout: 30000 });
  });

  test('keeps the popup pinned to the selection while the chat scrolls', async ({ page }) => {
    test.setTimeout(120000);
    // A short viewport guarantees the reply overflows and can actually scroll.
    await page.setViewportSize({ width: 900, height: 500 });
    await seedParagraphReply(page);

    await expect(async () => {
      await scrollSelectionTo(page, OPENING_PARAGRAPH, 0.75);
      await selectMessageText(page, OPENING_PARAGRAPH);
      await expect(addToChat(page)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });

    const before = await addToChat(page).boundingBox();
    expect(before).not.toBeNull();

    // Scrolling used to dismiss the popup on the first event, which the chat's
    // own auto-scroll fires constantly while streaming. It now follows instead.
    const moved = await scrollSelectionTo(page, OPENING_PARAGRAPH, 0.25);
    expect(Math.abs(moved)).toBeGreaterThan(0);

    await expect(addToChat(page)).toBeVisible();
    await expect(async () => {
      const after = await addToChat(page).boundingBox();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.y - before!.y)).toBeGreaterThan(Math.abs(moved) / 2);
    }).toPass({ timeout: 5000 });

    // Still the right excerpt after travelling with the text.
    await addToChat(page).click();
    await expect(pendingChips(page)).toContainText(OPENING_PARAGRAPH);
  });

  test('hides the popup when a selection inside a table scrolls out of the chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 900, height: 500 });
    await seedParagraphReply(page);

    // Table cells live in `.markdown-table-wrapper`, a scroll container nested
    // inside the message. Honouring only the nearest clipper would let the outer
    // list carry the whole table under the header while the wrapper still
    // reported the selection visible, stranding the popup over the composer.
    await expect(async () => {
      await scrollSelectionTo(page, TABLE_CELL, 0.5);
      await selectMessageText(page, TABLE_CELL);
      await expect(addToChat(page)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });

    const scrolledAway = await page.evaluate(() => {
      const message = document.querySelector('.message-render');
      const scroller = message?.closest('.scrollbar-gutter-stable');
      if (!scroller) {
        throw new Error('No message scroll container');
      }
      const start = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop - start;
    });
    expect(Math.abs(scrolledAway)).toBeGreaterThan(0);

    await expect(addToChat(page)).toBeHidden({ timeout: 5000 });
  });

  test('hides the popup when a table is scrolled sideways past the selection', async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 900, height: 500 });
    await seedParagraphReply(page);

    // A wide table scrolls inside the message, so the selected cell can leave
    // view without the message moving at all. Judging visibility from the
    // message's ancestors, or on the vertical axis alone, would miss this
    // entirely and leave the popup pinned beside a cell that is no longer there.
    await expect(async () => {
      await scrollSelectionTo(page, TABLE_CELL, 0.5);
      await selectMessageText(page, TABLE_CELL);
      await expect(addToChat(page)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });

    const scrolledSideways = await page.evaluate(() => {
      const wrapper = document.querySelector('.markdown-table-wrapper');
      if (!wrapper) {
        throw new Error('No table wrapper');
      }
      const room = wrapper.scrollWidth - wrapper.clientWidth;
      if (room <= 0) {
        throw new Error(
          `Table does not overflow sideways (scrollWidth ${wrapper.scrollWidth}, clientWidth ${wrapper.clientWidth})`,
        );
      }
      wrapper.scrollLeft = room;
      return wrapper.scrollLeft;
    });
    expect(scrolledSideways).toBeGreaterThan(0);

    await expect(addToChat(page)).toBeHidden({ timeout: 5000 });
  });

  test('hides the popup when the selection collapses without a mouse event', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'seed for collapse');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });

    await expect(async () => {
      await doubleClickWord(page, MOCK_REPLY_TEXT);
      await expect(addToChat(page)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });

    // Collapse the selection the way a streaming markdown re-render does —
    // dropping the selected text node fires only `selectionchange`, not a
    // mouse/key event. The popup must not linger over the now-empty caret.
    await page.evaluate(() => window.getSelection()?.collapseToEnd());
    await expect(addToChat(page)).toBeHidden({ timeout: 5000 });
  });

  test('collapses multiple selections into one chip with a hover popup, and removes one', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const firstMessage = 'quote target alpha';
    const popup = page.getByTestId('quote-selections-popup');

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, firstMessage);
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });

    // First the assistant reply, then the user's own message.
    await addQuote(page, MOCK_REPLY_TEXT, 1);
    await addQuote(page, firstMessage, 2);

    // Composer shows a single collapsed "2 selections" chip, not a row of two.
    await expect(pendingChips(page)).toContainText('2 selections');

    // Hovering the collapsed chip reveals a popup listing every excerpt.
    await pendingChips(page).getByRole('listitem').hover();
    await expect(popup).toBeVisible({ timeout: 5000 });
    await expect(popup).toContainText(MOCK_REPLY_TEXT);
    await expect(popup).toContainText(firstMessage);

    // Remove the reply from the popup; one selection remains and collapses back
    // to its excerpt text.
    await popup
      .getByRole('listitem')
      .filter({ hasText: MOCK_REPLY_TEXT })
      .getByRole('button', { name: /remove quote/i })
      .click();
    await expect(pendingChips(page)).toHaveAttribute('data-quote-count', '1');
    await expect(pendingChips(page)).toContainText(firstMessage);
    await expect(pendingChips(page)).not.toContainText(MOCK_REPLY_TEXT);

    // Send; only the remaining quote pins to the new user message.
    const followUp = await sendMessage(page, 'expand on this');
    expect(followUp.ok()).toBeTruthy();
    await expect(messageQuotes(page)).toContainText(firstMessage);
    await expect(messageQuotes(page)).not.toContainText(MOCK_REPLY_TEXT);
  });

  test('opens the selections popup via keyboard and closes on Escape', async ({ page }) => {
    test.setTimeout(120000);
    const firstMessage = 'quote target beta';
    const popup = page.getByTestId('quote-selections-popup');

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, firstMessage);
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await addQuote(page, MOCK_REPLY_TEXT, 1);
    await addQuote(page, firstMessage, 2);

    // The collapsed pill is a focusable disclosure: focus + Enter opens it.
    const trigger = pendingChips(page).getByRole('button', { name: '2 selections' });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popup).toBeVisible({ timeout: 5000 });
    await expect(popup).toContainText(MOCK_REPLY_TEXT);
    await expect(popup).toContainText(firstMessage);

    // Opening via keyboard moves focus into the popup (first excerpt's remove ×).
    await expect(popup.getByRole('button').first()).toBeFocused();

    // Escape closes it and returns focus to the pill that opened it (NOT the
    // page top, the bug this guards against). `document.activeElement` must be
    // a real control.
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
    const focusTag = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
    expect(focusTag).not.toBe('BODY');
  });

  test('re-merges a persisted quote into later-turn history (durable)', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // Turn 1: quote the assistant reply and send a (labeled) message carrying it.
    let response = await sendMessage(page, 'seed for durable');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await addQuote(page, MOCK_REPLY_TEXT, 1);
    response = await sendMessage(page, 'E2E_REPLY:carryquote');
    expect(response.ok()).toBeTruthy();
    // Wait for turn 1's generation to fully finish before sending again — a new
    // submit is blocked while the prior turn is still streaming.
    await expect(messagesView(page).getByText('E2E reply carryquote')).toBeVisible({
      timeout: 20000,
    });
    await expect(messageQuotes(page)).toContainText(MOCK_REPLY_TEXT);

    // Turn 2: no new quote. The prior quoted turn must be re-merged into history,
    // so the model still receives the blockquote on this later turn.
    response = await sendMessage(page, 'E2E_ASSERT_QUOTE:reply');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(QUOTE_ASSERTION_PASSED)).toBeVisible({
      timeout: 20000,
    });
  });
});

/**
 * A phone reaches this feature through a completely different event path than a
 * desktop: there is no `mouseup` to hang the popup off, and the tap that would
 * accept it is also the gesture that dismisses the selection. Both halves are
 * covered here on an emulated Pixel 5 with a real touchscreen.
 *
 * Headless Chromium has no Android/iOS long-press-to-select gesture, so each
 * test presses with the touchscreen (which is what marks the selection as
 * touch-driven, and is the only pointer event a long-press delivers) and then
 * places the selection directly. What reaches the component is exactly what a
 * real phone leaves behind: a selection announced by `selectionchange` alone,
 * with no mouse event anywhere in the sequence.
 */
test.describe('quote references on touch devices', () => {
  test.use(PIXEL_5);

  /** Long-press equivalent: touch the text, then select it without any mouse event. */
  async function touchSelect(page: Page, needle: string) {
    await messagesView(page).getByText(needle).scrollIntoViewIfNeeded();
    const point = await measureNeedle(page, needle);
    /** Drop any earlier selection *before* the press. Chromium answers a
     *  synthetic tap with compatibility mouse events, and a leftover selection
     *  would let that `mouseup` summon the popup down the desktop path —
     *  passing this spec for a reason no phone ever reproduces. Cleared first,
     *  the press carries only its touch pointer, and the selection that follows
     *  is announced by `selectionchange` alone. */
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.touchscreen.tap(point.x, point.y);
    await selectMessageText(page, needle, false);
  }

  test('summons the popup from a mouse-less touch selection and adds it by tap', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    await expect(async () => {
      await touchSelect(page, CLOSING_PARAGRAPH);
      await expect(addToChat(page)).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // The OS callout (Copy/Share/Look Up) claims the space directly above a
    // touch selection, so the popup takes the space below it.
    const popup = await addToChat(page).boundingBox();
    const bottom = await selectionBottom(page);
    expect(popup).not.toBeNull();
    expect(bottom).not.toBeNull();
    expect(popup!.y).toBeGreaterThanOrEqual(bottom!);

    // Comfortable tap target, not the compact desktop pill.
    expect(popup!.height).toBeGreaterThanOrEqual(44);

    // Tapping has to commit before the tap dismisses the selection out from
    // under the click — the second reason this was unusable on a phone.
    await addToChat(page).tap();
    await expect(pendingChips(page)).toHaveAttribute('data-quote-count', '1');
    await expect(pendingChips(page)).toContainText(CLOSING_PARAGRAPH);
  });

  test('carries a touch-selected excerpt through to the model', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const seeded = await sendMessage(page, 'seed for touch quote');
    expect(seeded.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });

    await expect(async () => {
      await touchSelect(page, MOCK_REPLY_TEXT);
      const button = addToChat(page);
      await expect(button).toBeVisible({ timeout: 5000 });
      await button.tap();
      await expect(pendingChips(page)).toHaveAttribute('data-quote-count', '1');
    }).toPass({ timeout: 30000 });

    // End to end from a finger: the mock model confirms the blockquote arrived.
    const response = await sendMessage(page, 'E2E_ASSERT_QUOTE:reply');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(QUOTE_ASSERTION_PASSED)).toBeVisible({
      timeout: 20000,
    });
    await expect(messageQuotes(page)).toContainText(MOCK_REPLY_TEXT);
  });

  test('adds nothing when a press on the popup is dragged away and released', async ({ page }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    await expect(async () => {
      await touchSelect(page, CLOSING_PARAGRAPH);
      await expect(addToChat(page)).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Committing on the press would make this gesture — starting a scroll on
    // the button, or touching it and thinking better of it — add the quote
    // anyway. A button has to stay cancellable.
    const popup = await addToChat(page).boundingBox();
    expect(popup).not.toBeNull();
    const centre = { x: popup!.x + popup!.width / 2, y: popup!.y + popup!.height / 2 };
    await page.evaluate(
      ({ x, y }) => {
        const button = document.querySelector('[data-testid="add-to-chat-button"]');
        if (!button) {
          throw new Error('Popup is not mounted');
        }
        const options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' };
        button.dispatchEvent(
          new PointerEvent('pointerdown', { ...options, clientX: x, clientY: y }),
        );
        /** Released far from the button, the way a drag-away cancel ends. */
        button.dispatchEvent(
          new PointerEvent('pointerup', { ...options, clientX: x, clientY: y + 400 }),
        );
      },
      { x: centre.x, y: centre.y },
    );

    await expect(pendingChips(page)).toHaveCount(0);
  });

  test('dismisses the popup when a cancelled press took the selection with it', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    await expect(async () => {
      await touchSelect(page, CLOSING_PARAGRAPH);
      await expect(addToChat(page)).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    const popup = await addToChat(page).boundingBox();
    expect(popup).not.toBeNull();

    // A press keeps the button alive through a collapsing selection so the
    // release has something to land on. When that press is then cancelled, the
    // collapse it masked still has to be honoured — otherwise the popup lingers
    // over a selection that no longer exists and a later tap adds a dead quote.
    //
    // The three steps are deliberately separate. `selectionchange` is delivered
    // asynchronously, so collapsing and cancelling in one synchronous block lets
    // the event arrive *after* the press has already ended — the ordinary path,
    // which passes with or without the fix. Waiting for delivery in between is
    // what reproduces a real press: long enough for the collapse to land while
    // the press is still masking it.
    const press = { x: popup!.x + popup!.width / 2, y: popup!.y + popup!.height / 2 };
    await page.evaluate(({ x, y }) => {
      const button = document.querySelector('[data-testid="add-to-chat-button"]');
      if (!button) {
        throw new Error('Popup is not mounted');
      }
      button.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
        }),
      );
    }, press);

    const collapseDelivered = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          document.addEventListener(
            'selectionchange',
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true },
          );
          window.getSelection()?.removeAllRanges();
        }),
    );
    expect(collapseDelivered, 'the masked collapse must reach the component').toBe(true);

    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="add-to-chat-button"]');
      if (!button) {
        throw new Error('Popup was dismissed before the press ended');
      }
      button.dispatchEvent(
        new PointerEvent('pointercancel', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
        }),
      );
    });

    await expect(addToChat(page)).toBeHidden({ timeout: 5000 });
    await expect(pendingChips(page)).toHaveCount(0);
  });

  test('never shows a popup for a selection scrolled away during the settle wait', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    // A mouse-less selection is only published once it has been quiet for the
    // settle interval, and nothing is tracked until then — so a scroll inside
    // that window is invisible to the re-anchoring path. Publishing without
    // re-checking would clamp an off-screen reading into view and strand the
    // popup over the composer.
    await scrollSelectionTo(page, OPENING_PARAGRAPH, 0.5);
    await selectMessageText(page, OPENING_PARAGRAPH, false);
    // Just past the top edge, not all the way to the end of the conversation:
    // a violent scroll re-renders the messages and drops the selection outright,
    // which would hide the popup for a reason that has nothing to do with this.
    const scrolledAway = await scrollSelectionTo(page, OPENING_PARAGRAPH, -0.4);
    expect(Math.abs(scrolledAway)).toBeGreaterThan(0);

    // The selection has to survive, or this proves nothing.
    const stillSelected = await page.evaluate(() => {
      const selection = window.getSelection();
      return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
    });
    expect(stillSelected, 'the selection must outlive the scroll').toBe(true);

    // Sit out the settle interval before asserting. `toBeHidden` is satisfied by
    // an element that has not been created *yet*, so checking straight away
    // would pass before the timer had a chance to publish anything.
    await page.waitForTimeout(SETTLE_OBSERVATION_MS);
    await expect(addToChat(page)).toBeHidden();
    await expect(pendingChips(page)).toHaveCount(0);
  });

  test('survives the scroll a phone fires while selecting', async ({ page }) => {
    test.setTimeout(120000);
    await seedParagraphReply(page);

    await expect(async () => {
      await scrollSelectionTo(page, OPENING_PARAGRAPH, 0.75);
      await touchSelect(page, OPENING_PARAGRAPH);
      await expect(addToChat(page)).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });

    // Nudging the list (the URL bar collapsing does the same via `resize`) used
    // to throw the selection away before the user could reach the button.
    const moved = await scrollSelectionTo(page, OPENING_PARAGRAPH, 0.25);
    expect(Math.abs(moved)).toBeGreaterThan(0);

    await expect(addToChat(page)).toBeVisible();
    await addToChat(page).tap();
    await expect(pendingChips(page)).toContainText(OPENING_PARAGRAPH);
  });
});
