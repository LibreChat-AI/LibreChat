import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

for (const strip of [false, true]) {
  test(`the current chat dismisses the mobile drawer without reloading (strip=${strip})`, async ({
    page,
  }) => {
    const id = randomUUID();
    const email = getE2EUser().email;
    const title = 'Current mobile chat';
    const now = Date.now();
    const olderChats = Array.from({ length: 30 }, (_, index) => ({
      conversationId: randomUUID(),
      title: `Older mobile chat ${index}`,
      updatedAt: new Date(now - (index + 1) * 60_000),
    }));
    const fixtureIds = [id, ...olderChats.map((chat) => chat.conversationId)];
    try {
      await seedConversations(email, [
        { conversationId: id, title, updatedAt: new Date(now) },
        ...olderChats,
      ]);
      await seedMessages(email, id, [
        {
          messageId: `${id}-user`,
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          text: 'Keep this conversation open.',
          sender: 'User',
          isCreatedByUser: true,
        },
        {
          messageId: `${id}-reply`,
          parentMessageId: `${id}-user`,
          text: 'The current chat stays mounted.',
          sender: 'Assistant',
          isCreatedByUser: false,
        },
      ]);
      await page.addInitScript((withStrip) => {
        localStorage.setItem('mobileDrawerStrip', JSON.stringify(withStrip));
      }, strip);
      await page.goto(`/c/${id}`);
      await expect(page.locator('.message-render')).toHaveCount(2);
      const draft = page.getByRole('textbox', { name: 'Message input' });
      await draft.fill('Unsent draft');
      const firstRow = await page.locator('.message-render').first().elementHandle();
      const initialHistoryLength = await page.evaluate(() => history.length);
      const historyReads: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === `/api/messages/${id}` || pathname === `/api/convos/${id}`) {
          historyReads.push(pathname);
        }
      });
      const opener = page.getByTestId('header-open-sidebar-button');
      const drawer = page.locator('#mobile-drawer');
      for (const activation of ['tap', 'Enter', 'Space']) {
        await opener.click();
        await expect(drawer).not.toHaveAttribute('inert');
        const currentChat = drawer.getByRole('button', {
          name: `${title} conversation`,
          exact: true,
        });
        await expect(currentChat).toHaveAttribute('aria-current', 'page');
        if (activation === 'tap') {
          await currentChat.tap();
        } else {
          await currentChat.focus();
          await currentChat.press(activation);
        }
        await expect(drawer).toHaveCSS('visibility', 'hidden');
        await expect(page.getByTestId('app-pane')).not.toHaveAttribute('inert');
        await expect(page).toHaveURL(new RegExp(`/c/${id}$`));
        await expect(draft).toHaveValue('Unsent draft');
        expect(await firstRow?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength);
        expect(historyReads).toEqual([]);
        await expect(opener).toBeFocused();
      }
      await firstRow?.dispose();
    } finally {
      await deleteMessagesByConversation([id]);
      await deleteConversations(fixtureIds);
    }
  });
}
