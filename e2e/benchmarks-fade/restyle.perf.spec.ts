import { expect, test } from '@playwright/test';
import { CONVOS, chatName, openChat, removeChats, seedChat } from './chats';

/**
 * What a change inside every row costs the stylesheet.
 *
 * A run starting or ending changes one small thing in each row of the thread at once. Whether
 * that is cheap depends on the selectors in the stylesheet, not on the change: one `:has()`
 * whose subject the browser cannot narrow makes each of those changes re-style its whole row.
 * This makes the same change on every row by hand and times the style and layout pass that
 * follows, so a rule of that kind shows up as tens of milliseconds where there should be few.
 */

test.use({ trace: 'off', video: 'off' });

test.describe('restyle cost of a change in every row', () => {
  test.skip(CONVOS.length === 0, 'FADE_PERF_CHATS names no exported conversation');
  test.afterAll(removeChats);

  for (const convo of CONVOS) {
    test(`a change in every row of ${chatName(convo)}`, async ({ page }) => {
      await seedChat(convo);
      const size = await openChat(page, convo);
      const lines = await page.evaluate(() => {
        const flush = () => document.body.offsetHeight;
        const timed = (change: () => void): number => {
          flush();
          change();
          const start = performance.now();
          flush();
          return performance.now() - start;
        };
        const toolbars = Array.from(
          document.querySelectorAll<HTMLElement>('.message-render .hover-button'),
        )
          .map((button) => button.parentElement)
          .filter(
            (bar, index, all): bar is HTMLElement => bar != null && all.indexOf(bar) === index,
          );
        const buttons = toolbars
          .map((bar) => bar.querySelector<HTMLElement>('button:last-of-type'))
          .filter((button): button is HTMLElement => button != null);
        const report: string[] = [`${buttons.length} rows with a toolbar`];
        const row = (name: string, on: number, off: number) =>
          report.push(
            `${name.padEnd(34)} ${on.toFixed(1).padStart(7)}ms  then ${off.toFixed(1).padStart(7)}ms back`,
          );

        row(
          'a class on one button per row',
          timed(() => buttons.forEach((button) => button.classList.add('lg:invisible'))),
          timed(() => buttons.forEach((button) => button.classList.remove('lg:invisible'))),
        );
        row(
          'disabled on one button per row',
          timed(() => buttons.forEach((button) => button.setAttribute('disabled', ''))),
          timed(() => buttons.forEach((button) => button.removeAttribute('disabled'))),
        );
        const added: HTMLElement[] = [];
        row(
          'a button mounted in each row',
          timed(() => {
            for (const bar of toolbars) {
              const button = document.createElement('button');
              button.textContent = 'x';
              bar.appendChild(button);
              added.push(button);
            }
          }),
          timed(() => added.forEach((button) => button.remove())),
        );
        return report;
      });
      console.log(`\n##### ${chatName(convo)}: ${size.rows} rows, ${size.nodes} elements`);
      for (const line of lines) {
        console.log(line);
      }
      expect(lines.length).toBeGreaterThan(1);
    });
  }
});
