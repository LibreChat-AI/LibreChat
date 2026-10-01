import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { messagesView } from '../helpers';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';

/**
 * The chat header is a gradient that fades to nothing, and the conversation
 * scrolls underneath it rather than stopping at its lower edge. Every control
 * in that row therefore has to carry its own opaque fill: a see-through one
 * has message text and avatars moving through it.
 *
 * The row only exists below `md`, so these declare the viewport they describe
 * rather than depending on a runner's project matrix.
 */

const TOGGLE = '[data-testid="header-open-sidebar-button"]';
const NEW_CHAT = '[data-testid="header-new-chat-button"]';
const OVERFLOW = '[data-testid="header-overflow-menu"]';
const CLOSE = '[data-testid="close-sidebar-button"]';

test.use({ viewport: { width: 390, height: 844 } });

/** The root marker the message tree builder expects. */
const ROOT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

/** A conversation long enough to scroll, with text wide enough that whatever
 *  lands under the header is opaque ink rather than empty margin. */
async function seedScrollableConversation(conversationId: string) {
  const email = getE2EUser().email;
  await seedConversations(email, [
    { conversationId, title: 'Header control surface', updatedAt: new Date() },
  ]);
  const messages = Array.from({ length: 24 }, (_, index) => {
    const isUser = index % 2 === 0;
    return {
      messageId: `hdr-${index}`,
      parentMessageId: index === 0 ? ROOT_MESSAGE_ID : `hdr-${index - 1}`,
      text: `${isUser ? 'Turn' : 'Reply'} ${index}: ${'the conversation scrolls under the header '.repeat(6)}`,
      isCreatedByUser: isUser,
      sender: isUser ? 'User' : 'Assistant',
    };
  });
  await seedMessages(email, conversationId, messages);
}

async function openSeededConversation(page: Page, conversationId: string) {
  await page.goto(`/c/${conversationId}`, { timeout: 20000 });
  await expect(messagesView(page).locator('.message-render').first()).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator(TOGGLE)).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** The hover fill is a different colour from the resting one, so a surface is
 *  only comparable together with whether the pointer is on it. */
const surfaceOf = (page: Page, selector: string) =>
  page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element == null) {
      throw new Error(`${target} is not rendered`);
    }
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      opacity: style.opacity,
      hovered: element.matches(':hover'),
    };
  }, selector);

/** `rgb(...)` and `rgba(..., 1)` are opaque; anything else lets the
 *  conversation through. Only a four-component colour carries an alpha, so the
 *  third channel of an `rgb()` triple is never read as one. */
const isOpaque = (background: string) => {
  const channels = /^rgba?\(([^)]*)\)$/.exec(background)?.[1].split(',');
  if (channels == null) {
    return false;
  }
  return channels.length < 4 || Number(channels[3]) === 1;
};

/** Move the conversation under the header row with a real wheel. */
async function scrollConversation(page: Page, delta: number) {
  await messagesView(page).hover();
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Park the transcript at its top, then bring it down under the header. Where a
 * freshly opened conversation lands is the app's business — the newest message
 * with auto-scroll on, the top of a seeded transcript without it — so this
 * rewinds first and leaves the wheel below a known distance to travel.
 */
async function parkConversationUnderHeader(page: Page) {
  await scrollConversation(page, -6000);
  await scrollConversation(page, 900);
}

test.describe('mobile chat header controls', () => {
  test('the sidebar toggle hides the conversation scrolling under it @scenario:mobile-header-toggle-hides-the-scrolling-conversation', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = randomUUID();
    await seedScrollableConversation(conversationId);

    try {
      await openSeededConversation(page, conversationId);

      await parkConversationUnderHeader(page);
      /** Nothing to hide unless a message really is behind the toggle. */
      const behindHeader = await page.evaluate((target) => {
        const toggle = document.querySelector(target)?.getBoundingClientRect();
        if (toggle == null) {
          throw new Error('the sidebar toggle is not rendered');
        }
        return Array.from(document.querySelectorAll('.message-render')).some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top < toggle.bottom && rect.bottom > toggle.top;
        });
      }, TOGGLE);
      expect(behindHeader, 'no message sits behind the header row').toBe(true);

      /** The element's own box is not the fill: outside the rounded corners,
       *  and through the hairline border, whatever is behind the control is
       *  what gets captured. Sample the interior instead. */
      const interior = await page.evaluate((target) => {
        const rect = document.querySelector(target)?.getBoundingClientRect();
        if (rect == null) {
          throw new Error('the sidebar toggle is not rendered');
        }
        const inset = 6;
        return {
          x: Math.round(rect.left + inset),
          y: Math.round(rect.top + inset),
          width: Math.round(rect.width - inset * 2),
          height: Math.round(rect.height - inset * 2),
        };
      }, TOGGLE);
      /** A band just below the header: what the toggle would be showing if it
       *  were see-through is moving there too. */
      const band = { x: 0, y: 56, width: 390, height: 48 };
      const before = await page.screenshot({ clip: interior });
      const bandBefore = await page.screenshot({ clip: band });

      /** Move the conversation, not the header: whatever was behind the toggle
       *  is replaced by different ink. */
      await scrollConversation(page, 700);

      const bandAfter = await page.screenshot({ clip: band });
      expect(
        bandAfter.equals(bandBefore),
        'the conversation did not move, so nothing was scrolled under the header',
      ).toBe(false);

      const after = await page.screenshot({ clip: interior });
      expect(
        after.equals(before),
        'the toggle changed with the content behind it, so it is see-through',
      ).toBe(true);
      expect(isOpaque((await surfaceOf(page, TOGGLE)).background)).toBe(true);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the sidebar toggle shares one surface with its neighbours @scenario:mobile-header-controls-share-one-surface', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = randomUUID();
    await seedScrollableConversation(conversationId);

    try {
      await openSeededConversation(page, conversationId);
      await expect(page.locator(NEW_CHAT)).toBeVisible();
      await expect(page.locator(OVERFLOW)).toBeVisible();

      const [toggle, newChat, overflow] = await Promise.all([
        surfaceOf(page, TOGGLE),
        surfaceOf(page, NEW_CHAT),
        surfaceOf(page, OVERFLOW),
      ]);
      const theme = await page.locator('html').getAttribute('class');

      expect(isOpaque(toggle.background), `toggle fill ${toggle.background} in ${theme}`).toBe(
        true,
      );
      expect(toggle.background, `theme ${theme}`).toBe(newChat.background);
      expect(toggle.background, `theme ${theme}`).toBe(overflow.background);
      expect(toggle.radius).toBe(newChat.radius);
      expect(toggle.radius).toBe(overflow.radius);
      expect(toggle.opacity).toBe('1');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the drawer close toggle stays the same control @scenario:mobile-drawer-close-toggle-stays-the-same-control', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = randomUUID();
    await seedScrollableConversation(conversationId);

    try {
      await openSeededConversation(page, conversationId);
      await page.locator(TOGGLE).click();

      const close = page.locator(CLOSE);
      await expect(close).toBeVisible();
      await expect(close).toBeFocused();

      /** A click leaves the pointer on the opener's coordinates, and the drawer
       *  slides its own toggle onto them: one of the pair would then be reading
       *  its hover fill. Move off both and let the 300ms slide finish. */
      await page.mouse.move(200, 760);
      await page.waitForTimeout(600);

      /** One control across two views: the drawer's toggle is the header's
       *  toggle, so it carries the same fill, corner and tap target. */
      const [opener, closer, boxes] = await Promise.all([
        surfaceOf(page, TOGGLE),
        surfaceOf(page, CLOSE),
        page.evaluate(
          ([openerTarget, closerTarget]) => {
            const measure = (selector: string) => {
              const rect = document.querySelector(selector)?.getBoundingClientRect();
              if (rect == null) {
                throw new Error(`${selector} is not rendered`);
              }
              return { width: Math.round(rect.width), height: Math.round(rect.height) };
            };
            return { opener: measure(openerTarget), closer: measure(closerTarget) };
          },
          [TOGGLE, CLOSE],
        ),
      ]);

      expect(opener.hovered, 'the pointer is still on the header toggle').toBe(false);
      expect(closer.hovered, 'the pointer is still on the drawer toggle').toBe(false);
      expect(closer.background).toBe(opener.background);
      expect(closer.radius).toBe(opener.radius);
      expect(isOpaque(closer.background)).toBe(true);
      expect(boxes.closer).toEqual(boxes.opener);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
