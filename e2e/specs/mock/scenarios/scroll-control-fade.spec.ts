import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { getE2EUser } from '../../../setup/user';

const TURNS = 24;

type FadeStyle = { property: string; duration: string; transform: string };

async function seedLongChat(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Scroll control fade', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: TURNS }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text: `Turn ${index + 1} of the faded conversation`,
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

/**
 * Resolves with the control's computed transition the first time a phase class lands on it,
 * so the reading is taken while the fade runs, not after it settles.
 */
function readFade(page: Page, phase: string): Promise<FadeStyle> {
  return page.evaluate(
    (className) =>
      new Promise<FadeStyle>((resolve) => {
        const read = () => {
          const node = document.querySelector(`.${className}`);
          if (node == null) {
            return false;
          }
          const style = getComputedStyle(node);
          resolve({
            property: style.transitionProperty,
            duration: style.transitionDuration,
            transform: style.transform,
          });
          return true;
        };
        if (read()) {
          return;
        }
        const observer = new MutationObserver(() => {
          if (read()) {
            observer.disconnect();
          }
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class'],
        });
      }),
    phase,
  );
}

async function openConversation(page: Page, conversationId: string) {
  await page.goto(`/c/${conversationId}`);
  const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
  await expect(thread.locator('.message-render')).toHaveCount(TURNS);
  return thread;
}

const scrollUp = (thread: ReturnType<Page['locator']>) =>
  thread.getByText('Turn 1 of the faded conversation', { exact: true }).scrollIntoViewIfNeeded();

/** The thread's own control, not the navigation rail's end marker, which shares its name. */
const scrollControl = (page: Page) =>
  page.getByRole('button', { name: 'Scroll to bottom' }).and(page.locator(':not([data-msg-id])'));

test.describe('scroll control fade', () => {
  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedLongChat();
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('the scroll control fades and rises in, settles, and fades out on its way down @scenario:scroll-control-fades-in-and-out', async ({
    page,
  }, testInfo) => {
    const thread = await openConversation(page, conversationId);
    const entering = readFade(page, 'scroll-animation-enter-active');
    await scrollUp(thread);

    expect(await entering).toEqual(
      expect.objectContaining({ property: 'opacity, transform', duration: '0.3s, 0.3s' }),
    );
    const control = scrollControl(page);
    await expect(control).toBeEnabled();
    const wrapper = page.locator('.scroll-animation-enter-done');
    await expect(wrapper).toHaveCSS('opacity', '1');
    /** At rest the rise has fully landed: `translateY(0)`, the identity matrix. */
    await expect(wrapper).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await page.screenshot({ path: testInfo.outputPath('scroll-control-settled.png') });
    await control.screenshot({ path: testInfo.outputPath('scroll-control.png') });

    const exiting = readFade(page, 'scroll-animation-exit-active');
    await control.click();
    expect(await exiting).toEqual(
      expect.objectContaining({ property: 'opacity, transform', duration: '0.18s, 0.18s' }),
    );
    await expect(
      thread.getByText(`Turn ${TURNS} of the faded conversation`, { exact: true }),
    ).toBeInViewport();
    await expect(control).toBeHidden();
  });

  test('under reduced motion the scroll control only fades, without rising @scenario:scroll-control-fade-honors-reduced-motion', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const thread = await openConversation(page, conversationId);
    const entering = readFade(page, 'scroll-animation-enter-active');
    await scrollUp(thread);

    expect(await entering).toEqual({ property: 'opacity', duration: '0.15s', transform: 'none' });
    await expect(scrollControl(page)).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('scroll-control-reduced-motion.png') });
  });
});
