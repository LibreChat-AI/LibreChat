import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';

/**
 * Opening a conversation from the welcome screen moves the composer down by the
 * disclaimer's clearance and must not move it sideways at all. The sideways
 * offset came from the scrollbar band the message column holds back: the
 * conversation reserved it and the welcome screen did not, so the composer
 * stepped 4px left on the way in. Where scrollbars overlay, the band is zero and
 * nothing may be reserved on either side of the navigation.
 *
 * The composer is full-bleed below `sm` with no clearance to travel, so these
 * run on the desktop projects.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const CONVERSATION_TITLE = 'Composer position';

type Box = { left: number; right: number; width: number; centre: number };

const skipBelowSm = (page: Page) => {
  const width = page.viewportSize()?.width ?? 0;
  test.skip(width < 640, 'the composer is full-bleed below the sm breakpoint');
};

async function seedThread() {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: CONVERSATION_TITLE, updatedAt: new Date() },
  ]);
  const userMessageId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Where does the composer sit?',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: 'Exactly where it sat on the welcome screen.',
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

async function dropThread(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

const boxOf = (page: Page, selector: string): Promise<Box> =>
  page.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) {
      throw new Error(`${target} is not rendered`);
    }
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      centre: Math.round((rect.left + rect.width / 2) * 100) / 100,
    };
  }, selector);

/** Navigate the way a user does — the sidebar row — so the app keeps the composer
 *  node it already rendered instead of mounting a new one. */
async function openSeededConversation(page: Page) {
  const row = page.getByTestId('convo-item').filter({ hasText: CONVERSATION_TITLE }).first();
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.click();
  await expect(page.locator('.message-render').first()).toBeVisible({ timeout: 20000 });
}

async function settleComposer(page: Page) {
  /** The clearance transitions for 300ms; wait for the box to stop moving. */
  let previous = await boxOf(page, COMPOSER);
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(200);
    const next = await boxOf(page, COMPOSER);
    if (Math.abs(next.left - previous.left) < 0.5 && Math.abs(next.width - previous.width) < 0.5) {
      return next;
    }
    previous = next;
  }
  throw new Error(`the composer never settled: ${JSON.stringify(previous)}`);
}

declare global {
  interface Window {
    /** Filled by the in-page sampler below; read back after the navigation. */
    __composerTransitions?: string[];
  }
}

/** Records every CSS transition the composer's own form runs, for the whole
 *  window, so a navigation that jumps records nothing. */
async function watchComposerTransitions(page: Page) {
  await page.evaluate((selector) => {
    const form = document.querySelector(selector)?.closest('form');
    if (!form) {
      throw new Error('the composer form is not rendered');
    }
    const seen: string[] = [];
    window.__composerTransitions = seen;
    const started = performance.now();
    const sample = () => {
      for (const animation of form.getAnimations()) {
        if (animation instanceof CSSTransition && !seen.includes(animation.transitionProperty)) {
          seen.push(animation.transitionProperty);
        }
      }
      if (performance.now() - started < 3000) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  }, COMPOSER);
}

/** A platform whose scrollbars reserve nothing — macOS and iOS by default.
 *  The rule has to be in the document's own stylesheet before the app's scripts
 *  run, so it is served with the HTML rather than injected afterwards: a style
 *  appended from an init script can land after React has already measured. */
async function serveWithOverlayScrollbars(page: Page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      return route.fallback();
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(
      '<head>',
      '<head><style>::-webkit-scrollbar { width: 0 !important; height: 0 !important; } * { scrollbar-width: none !important; }</style>',
    );
    await route.fulfill({ response, body });
  });
}

/** The band the message column actually holds back, as the app measures it. */
const measuredGutter = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const column = document.querySelector('.scrollbar-gutter-stable');
    if (!column) {
      throw new Error('the message column is not rendered');
    }
    return Math.max(0, column.getBoundingClientRect().width - column.clientWidth);
  });

const recordedTransitions = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__composerTransitions ?? []);

test.describe('composer position across the welcome screen', () => {
  test('the composer keeps its horizontal position and width into a conversation @scenario:composer-holds-position-into-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    skipBelowSm(page);
    const conversationId = await seedThread();

    try {
      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      const onWelcome = await settleComposer(page);

      await openSeededConversation(page);
      const inConversation = await settleComposer(page);

      expect(inConversation.left).toBeCloseTo(onWelcome.left, 0);
      expect(inConversation.width).toBeCloseTo(onWelcome.width, 0);

      /** The conversation composer is the anchored one: it lines up with the
       *  message column, which is what the welcome screen now matches. */
      const messageRow = await boxOf(page, '.message-render');
      expect(Math.abs(inConversation.centre - messageRow.centre)).toBeLessThanOrEqual(1);
    } finally {
      await dropThread(conversationId);
    }
  });

  test('the composer keeps its position where scrollbars overlay @scenario:composer-holds-position-with-overlay-scrollbars', async ({
    page,
  }) => {
    test.setTimeout(60000);
    skipBelowSm(page);
    const conversationId = await seedThread();

    try {
      await serveWithOverlayScrollbars(page);

      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      const onWelcome = await settleComposer(page);

      await openSeededConversation(page);
      const inConversation = await settleComposer(page);

      /** The emulation is the whole point of this scenario: if the platform still
       *  reserves a band, the run proves nothing and has to say so. */
      expect(await measuredGutter(page)).toBe(0);

      expect(inConversation.left).toBeCloseTo(onWelcome.left, 0);
      expect(inConversation.width).toBeCloseTo(onWelcome.width, 0);

      const messageRow = await boxOf(page, '.message-render');
      expect(Math.abs(inConversation.centre - messageRow.centre)).toBeLessThanOrEqual(1);
    } finally {
      await dropThread(conversationId);
    }
  });

  test('the composer slides down when a conversation opens @scenario:composer-slides-down-into-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    skipBelowSm(page);
    const conversationId = await seedThread();

    try {
      /** The reported case: the welcome composer already sits at the bottom, so
       *  the clearance change is the whole movement. */
      await page.addInitScript(() => {
        window.localStorage.setItem('centerFormOnLanding', 'false');
      });
      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      const onWelcome = await settleComposer(page);

      await watchComposerTransitions(page);
      await openSeededConversation(page);
      const inConversation = await settleComposer(page);

      expect(inConversation.left).toBeCloseTo(onWelcome.left, 0);
      expect(await recordedTransitions(page)).toContain('margin-bottom');
    } finally {
      await dropThread(conversationId);
    }
  });

  test('the composer settles without motion when the reader asked for less @scenario:composer-settles-instantly-under-reduced-motion', async ({
    page,
  }) => {
    test.setTimeout(60000);
    skipBelowSm(page);
    const conversationId = await seedThread();

    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        window.localStorage.setItem('centerFormOnLanding', 'false');
      });
      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      const onWelcome = await settleComposer(page);

      await watchComposerTransitions(page);
      await openSeededConversation(page);
      const inConversation = await settleComposer(page);

      expect(await recordedTransitions(page)).toEqual([]);
      /** No motion is not no move: the conversation clearance still applies. */
      expect(inConversation.right).toBeGreaterThan(0);
      expect(inConversation.left).toBeCloseTo(onWelcome.left, 0);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
      await dropThread(conversationId);
    }
  });
});
