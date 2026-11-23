import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getAccessToken, isTransparentColor } from '../helpers';
import { getE2EUser } from '../../../setup/user';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const RESULT = 'Child result from the stored run.';

/** The panel is a region beside the chat on wide screens and a dialog on narrow ones. */
const childActivityPanel = (page: Page) =>
  page
    .getByRole('region', { name: 'Child agent activity' })
    .or(page.getByRole('dialog', { name: 'Child agent activity' }));

/** `stored` is whether the run kept its child activity; without it there is nothing to open. */
const subagentCall = (
  id: string,
  { stored = true, ...call }: { stored?: boolean } & Record<string, unknown> = {},
) => ({
  type: 'tool_call',
  tool_call: {
    id,
    name: 'subagent',
    args: JSON.stringify({ subagent_type: 'self', description: 'Check the numbers.' }),
    output: RESULT,
    progress: 1,
    ...(stored ? { subagent_content: [{ type: 'text', text: RESULT }] } : {}),
    ...call,
  },
});

/** A settled reply holding the given subagent cards, with prose between so each renders inline. */
async function seedSubagentChat(calls: Record<string, unknown>[]) {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const userEmail = getE2EUser().email;
  const content = calls.flatMap((call, index) => [
    call,
    { type: 'text', text: `Step ${index + 1} is checked.` },
  ]);
  await seedConversations(userEmail, [
    { conversationId, title: 'Subagent card states', updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Check the numbers.',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content,
    },
  ]);
  return {
    conversationId,
    cleanup: async () => {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    },
  };
}

const cardFor = (page: Page, toolCallId: string) =>
  page.locator(`[data-subagent-tool-call="${toolCallId}"]`);

/**
 * The card is a native button, so it keeps the app's own focus outline instead of a ring of its
 * own. A keyboard user tabs onto it, sees that outline, and opens the child run with Enter.
 */
test('a subagent card shows a visible focus outline to keyboard users and opens its panel on Enter @scenario:subagent-card-keyboard-focus-opens-panel', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const chat = await seedSubagentChat([subagentCall('call_focus')]);
  try {
    await page.goto(`/c/${chat.conversationId}`);
    const card = cardFor(page, 'call_focus');
    await expect(card).toBeVisible();
    await expect(card).toBeEnabled();

    /** Step away and tab back, so focus arrives by keyboard as it does for a keyboard user. */
    await card.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(card).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card).toBeFocused();

    expect(await card.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    const outline = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style).toBe('solid');
    expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
    /**
     * The card eases its colors, the outline's among them, so the outline starts at the card's
     * text color and takes a moment to reach the theme's. Read at once it is still on its way:
     * wait for it to settle on the color the app gives every focus outline.
     */
    const themeOutline = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'rgb(var(--focus-outline))';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    /** A transparent outline is the hidden state a control draws when it owns its own ring. */
    expect(isTransparentColor(themeOutline)).toBe(false);
    await expect(card).toHaveCSS('outline-color', themeOutline);

    await page.keyboard.press('Enter');
    const panel = childActivityPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(RESULT, { timeout: 30_000 });
  } finally {
    await chat.cleanup();
  }
});

const GLYPH = '.fold-glyph';

/**
 * A running subagent card pulses slowly, and so do the glyph of an agent with no saved name and the
 * animated search field. All three hold still for a viewer who prefers reduced motion. The mock model
 * cannot hold a child run open, so a settled card is marked the way a streaming one is (its
 * `data-running` attribute and its glyph's pulse classes, both unit tested on the component), and a
 * probe outside the page tree carries the class the search field pulses with. What this reads is the
 * real stylesheet cascade under the browser's own `prefers-reduced-motion` emulation. It does not
 * exercise a live stream.
 */
test('a running subagent card, its glyph and the search field pulse in normal motion and hold still when the viewer prefers reduced motion @scenario:running-subagent-card-pulse-follows-motion-preference', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const chat = await seedSubagentChat([subagentCall('call_pulse')]);
  try {
    await page.goto(`/c/${chat.conversationId}`);
    const card = cardFor(page, 'call_pulse');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-running', 'false');
    const glyph = card.locator(GLYPH);
    const field = page.locator('#search-pulse-probe');
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'search-pulse-probe';
      probe.className = 'animate-pulse-slow';
      document.body.append(probe);
    });
    await card.evaluate((element, glyphSelector) => {
      element.setAttribute('data-running', 'true');
      element
        .querySelector(glyphSelector)
        ?.classList.add('animate-pulse', 'motion-reduce:animate-none');
    }, GLYPH);

    const pulse = (target: Locator) =>
      target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          name: style.animationName,
          duration: style.animationDuration,
          iterations: style.animationIterationCount,
          easing: style.animationTimingFunction,
          playing: element
            .getAnimations()
            .filter(
              (animation) => animation instanceof CSSAnimation && animation.playState === 'running',
            ).length,
        };
      });
    const pulsing = [
      ['card', card],
      ['glyph', glyph],
      ['search field', field],
    ] as const;

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const slow = {
      name: 'pulse-slow',
      duration: '3s',
      iterations: 'infinite',
      easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
      playing: 1,
    };
    await expect.poll(() => pulse(card), { message: 'card pulse' }).toEqual(slow);
    await expect.poll(() => pulse(field), { message: 'search field pulse' }).toEqual(slow);
    await expect
      .poll(() => pulse(glyph), { message: 'glyph pulse' })
      .toMatchObject({ name: 'pulse', playing: 1 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [label, target] of pulsing) {
      await expect
        .poll(() => pulse(target), { message: `${label} pulse under reduced motion` })
        .toMatchObject({ name: 'none', playing: 0 });
    }

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(async () => (await pulse(card)).name).toBe('pulse-slow');
  } finally {
    await chat.cleanup();
  }
});

const look = (card: Locator) =>
  card.evaluate((element) => {
    const style = getComputedStyle(element);
    const header = element.querySelector('div');
    return {
      opacity: style.opacity,
      cursor: style.cursor,
      background: style.backgroundColor,
      border: style.borderTopColor,
      radius: style.borderTopLeftRadius,
      padding: style.padding,
      headerInk: header == null ? '' : getComputedStyle(header).color,
    };
  });

/**
 * A shared link keeps a card whose child run left nothing to show, and the card reads as unavailable
 * the way it always has: the whole card dims, while its surface, border and text keep the ink of a
 * card that opens.
 */
test('a shared subagent card with nothing to open dims as a whole and keeps its surface and ink @scenario:shared-subagent-card-without-activity-keeps-dimmed-look', async ({
  page,
  browser,
  baseURL,
  viewport,
  isMobile,
  hasTouch,
  colorScheme,
}) => {
  test.setTimeout(120_000);
  const detachedOutput = JSON.stringify({
    background_task_id: 'task-1',
    subagent_thread_id: 'thread-1',
    tool: 'subagent',
    subagent_type: 'researcher',
    status: 'running',
    message: 'Started subagent background task. Poll with background_task_id task-1.',
  });
  const chat = await seedSubagentChat([
    subagentCall('call_opens'),
    subagentCall('call_idle', {
      stored: false,
      args: JSON.stringify({ subagent_type: 'researcher', run_in_background: true }),
      output: detachedOutput,
    }),
  ]);
  try {
    await page.goto('/c/new');
    const token = await getAccessToken(page);
    const shared = await page.request.post(`/api/share/${chat.conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(shared.ok()).toBeTruthy();
    const { shareId } = (await shared.json()) as { shareId?: string };
    expect(shareId).toBeTruthy();

    /** The reader takes the project's device and color scheme, but not its login. */
    const reader = await browser.newContext({ baseURL, viewport, isMobile, hasTouch, colorScheme });
    try {
      const readerPage = await reader.newPage();
      await readerPage.goto(`/share/${shareId}`);
      const opens = cardFor(readerPage, 'call_opens');
      const idle = cardFor(readerPage, 'call_idle');
      await expect(opens).toBeVisible({ timeout: 30_000 });
      await expect(opens).toBeEnabled();
      await expect(idle).toBeVisible();
      await expect(idle).toBeDisabled();

      const [open, dimmed] = [await look(opens), await look(idle)];
      expect(open.opacity).toBe('1');
      expect(dimmed.opacity).toBe('0.8');
      expect(dimmed.cursor).toBe('default');
      expect({ ...dimmed, opacity: open.opacity, cursor: open.cursor }).toEqual(open);
    } finally {
      await reader.close();
    }
  } finally {
    await chat.cleanup();
  }
});
