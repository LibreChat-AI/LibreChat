import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { buildStressMessages, ROWS } from '../../../benchmarks-mobile-chat/payload';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';

test.use({ viewport: { width: 390, height: 844 } });

for (const { strip, direction } of [
  { strip: false, direction: 'ltr' },
  { strip: true, direction: 'ltr' },
  { strip: true, direction: 'rtl' },
] as const) {
  test(`drawer overlays a long stationary chat (${direction}, strip=${strip})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = randomUUID();
    const email = getE2EUser().email;
    try {
      await seedConversations(email, [{ conversationId: id, title: 'Long drawer regression' }]);
      await seedMessages(email, id, buildStressMessages(id));
      await page.addInitScript((withStrip) => {
        localStorage.setItem('mobileDrawerStrip', JSON.stringify(withStrip));
      }, strip);
      await page.goto(`/c/${id}`);
      await expect(page.locator('.message-render')).toHaveCount(ROWS, { timeout: 60_000 });
      await page.evaluate((dir) => document.documentElement.setAttribute('dir', dir), direction);
      const opener = page.getByTestId('header-open-sidebar-button');
      const pane = page.getByTestId('app-pane');
      await expect(pane).toBeVisible();
      const monitor = await pane.evaluateHandle((element) => {
        const firstRow = element.querySelector('.message-render');
        const scroller = element.querySelector<HTMLElement>('.scrollbar-gutter-stable');
        if (!firstRow || !scroller) {
          throw new Error('Transcript is not mounted');
        }
        scroller.scrollTop = scroller.scrollHeight;
        const scrollTop = scroller.scrollTop;
        const initial = element.getBoundingClientRect().x;
        const changes: Array<{ transform: string; willChange: string; x: number }> = [];
        const observer = new MutationObserver(() => {
          changes.push({
            transform: (element as HTMLElement).style.transform,
            willChange: (element as HTMLElement).style.willChange,
            x: element.getBoundingClientRect().x,
          });
        });
        observer.observe(element, { attributes: true });
        return {
          finish() {
            observer.disconnect();
            return {
              changes,
              initial,
              sameRow: firstRow === element.querySelector('.message-render'),
              scrollTop,
              finalScrollTop: scroller.scrollTop,
            };
          },
        };
      });
      await pane.evaluate((element) => {
        // Model an in-pane Versions panel at the drawer's z-index.
        const panel = document.createElement('div');
        panel.dataset.testid = 'pane-overlay';
        Object.assign(panel.style, {
          position: 'absolute',
          zIndex: '110',
          top: '100px',
          bottom: '100px',
          insetInline: '0',
        });
        element.append(panel);
      });
      await opener.click();
      const drawer = page.locator('#mobile-drawer');
      await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
      await expect(drawer).not.toHaveAttribute('inert');
      await expect(pane).toHaveAttribute('inert');
      const coveredByDrawer = await drawer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(box.x + box.width / 2, box.y + 200)
            ?.closest('#mobile-drawer') != null
        );
      });
      expect(coveredByDrawer).toBe(true);
      await expect(pane).toHaveCSS('isolation', 'isolate');
      await pane.getByTestId('pane-overlay').evaluate((element) => element.remove());
      await drawer.getByTestId('close-sidebar-button').click();
      await expect(drawer).toHaveCSS('visibility', 'hidden');
      await expect(pane).not.toHaveAttribute('inert');
      const result = await monitor.evaluate((value) => value.finish());
      await monitor.dispose();
      expect(result.changes.length).toBeGreaterThan(0);
      expect(
        result.changes.every((change) => change.transform === '' || change.transform === 'none'),
      ).toBe(true);
      expect(result.changes.every((change) => !change.willChange.includes('transform'))).toBe(true);
      expect(result.changes.every((change) => Math.abs(change.x - result.initial) < 1)).toBe(true);
      expect(result.sameRow).toBe(true);
      expect(result.finalScrollTop).toBeCloseTo(result.scrollTop, 0);
      await expect(page.locator('.message-render')).toHaveCount(ROWS);
      await expect(opener).toBeFocused();
    } finally {
      await deleteMessagesByConversation([id]);
      await deleteConversations([id]);
    }
  });
}
