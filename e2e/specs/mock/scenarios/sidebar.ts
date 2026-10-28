import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** The first candidate that is actually painted, since the rail and the drawer publish the
 *  same controls and the off-canvas copy answers a plain locator first. */
async function firstVisible(candidates: Locator): Promise<Locator | null> {
  const count = await candidates.count();
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Mobile keeps the conversation list in a drawer; desktop has it expanded already.
 *
 * Settled on the close control being painted, by its accessible name rather than a test id.
 * The mobile drawer stays mounted and slides, so a test id read reports the off-canvas copy as
 * present before the expanded state commits, and both earlier readings sent this helper back
 * with the list still hidden behind the pane.
 */
export async function openSidebar(page: Page) {
  const isOpen = async () =>
    (await firstVisible(page.getByRole('button', { name: 'Close sidebar' }))) !== null;
  const settles = async (budgetMs: number) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await isOpen()) {
        return true;
      }
      await page.waitForTimeout(100);
    }
    return isOpen();
  };

  /* One click is one toggle, and the opener sits in the pane the drawer marks inert for the
     whole of its travel: clicking again before that travel finishes either lands on an inert
     pane and is swallowed, or closes the drawer that was just opening. So each attempt gets the
     transition to itself, and a second one exists only because the very first click of a run
     can arrive while the shell is still settling. */
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isOpen()) {
      return;
    }
    const opener = await firstVisible(page.getByRole('button', { name: 'Open sidebar' }));
    await opener?.click({ timeout: 2_000 }).catch(() => undefined);
    if (await settles(5_000)) {
      return;
    }
  }
  await expect.poll(isOpen, { timeout: 5_000 }).toBe(true);
}

/** The row mounts its real menu on the first mouse enter (`Convo.tsx`). Hovering is what a
 * pointer device does, but the mobile drawer cannot always offer a hoverable row, and a real
 * `hover()` then waits out the whole budget. The fallback dispatches `mouseover`, which is the
 * native event React derives `onMouseEnter` from, and needs the row only to be attached. */
export async function openConversationMenu(row: Locator) {
  const menu = row.getByRole('button', { name: 'Conversation Menu Options' });
  if (!(await menu.isVisible().catch(() => false))) {
    await row.hover({ timeout: 5_000 }).catch(() => undefined);
  }
  if (!(await menu.isVisible().catch(() => false))) {
    await row.dispatchEvent('mouseover');
  }
  await expect(menu).toBeAttached();
  await menu.dispatchEvent('click');
}
