import { randomUUID } from 'crypto';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { getAccessToken, requestJson } from '../helpers';
import { deleteConversations, withMongo } from '../db';

/** `aria-label` of the Pinned section's region (`com_ui_pinned`). */
export const PINNED_REGION = 'Pinned';

const userEmail = getE2EUser().email;

export type SeededPin = { conversationId: string; title: string };

/**
 * A pinned chat is an ordinary conversation carrying `pinned: true`; the sidebar
 * reads that flag to move the row out of the date groups and into the Pinned
 * section. Inserted directly, the way `seedConversations` does, so a spec can
 * choose the row's title and its position in the natural order without driving
 * the pin menu first.
 */
export async function seedPinnedConversations(titles: string[]): Promise<SeededPin[]> {
  const now = Date.now();
  const pins: SeededPin[] = titles.map((title) => ({ conversationId: randomUUID(), title }));
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
    }
    await db.collection('conversations').insertMany(
      pins.map((pin, index) => ({
        conversationId: pin.conversationId,
        title: pin.title,
        user: String(user._id),
        endpoint: 'openAI',
        isArchived: false,
        pinned: true,
        /** Descending by `updatedAt` is the natural order of the section, so the
         *  first title given is the first row rendered. */
        createdAt: new Date(now - index * 1000),
        updatedAt: new Date(now - index * 1000),
        __v: 0,
      })),
    );
  });
  return pins;
}

/** Whether the stored conversation is still pinned, for the drop that unpins. */
export async function isConversationPinned(conversationId: string): Promise<boolean> {
  return withMongo(async (db) => {
    const convo = await db.collection('conversations').findOne({ conversationId });
    return convo?.pinned === true;
  });
}

export type ModelFavorite = { endpoint: string; model: string };

/**
 * The key a favorite model takes in the stored pinned order. The endpoint is
 * length-prefixed so that an endpoint or model containing `:` cannot collide
 * with another pair — the encoding the section itself uses.
 */
export const favoriteEntryKey = ({ endpoint, model }: ModelFavorite): string =>
  `model:${endpoint.length}:${endpoint}:${model}`;

/** The key a pinned chat takes in the stored pinned order. */
export const convoEntryKey = (conversationId: string): string => `convo:${conversationId}`;

/** Pinned models/agents are the signed-in user's favorites, written through the
 *  same route the star does, so the server's cache invalidation runs too. */
export async function setFavorites(page: Page, favorites: ModelFavorite[]): Promise<void> {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: '/api/user/settings/favorites',
    token,
    method: 'POST',
    body: { favorites },
  });
}

/** The per-user display order of the Pinned section. */
export async function setPinnedOrder(page: Page, keys: string[]): Promise<void> {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: '/api/user/settings/pinned-order',
    token,
    method: 'POST',
    body: { pinnedOrder: keys },
  });
}

/** Leaves the account with no favorites and no saved order, so one spec's
 *  arrangement cannot decide another's. Requires a loaded page for its token. */
export async function resetPinnedState(page: Page): Promise<void> {
  await setFavorites(page, []);
  await setPinnedOrder(page, []);
}

/** Removes the seeded pinned chats. */
export async function removePins(pins: SeededPin[]): Promise<void> {
  if (pins.length === 0) {
    return;
  }
  await deleteConversations(pins.map((pin) => pin.conversationId));
}

/**
 * Drags one row onto a point inside another and releases there.
 *
 * The list reorders on `dragover`, and only once the pointer has crossed the
 * hovered row's midpoint, so a drag that jumps straight to its destination in a
 * single move delivers too few events to reach that threshold and the list
 * never shifts. The pointer therefore steps: one short move to start the drag,
 * then a stepped traverse into the target.
 *
 * `fraction` is where inside the target row the pointer lands, measured from
 * its top — below 0.5 to move a row upwards, above 0.5 to move it down.
 */
export async function dragRowOnto(
  page: Page,
  source: Locator,
  target: Locator,
  fraction: number,
): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) {
    throw new Error('drag source and target must both be laid out');
  }
  /* The list disconnects its drag sources while the saved order reconciles, and
   * react-dnd marks a connected one `draggable`. Pressing on a row that is not
   * yet connected does not start a drag at all: the press and release become a
   * click, and the row navigates instead of moving. */
  await expect.poll(() => source.getAttribute('draggable'), { timeout: 15_000 }).toBe('true');
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height * fraction;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  /** The first move is what the browser turns into `dragstart`. */
  await page.mouse.move(startX, startY - 8, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 24 });
  /** The list shifts rows under the pointer as it reorders, and the hover that
   *  decides a swap reads the offset at the moment it fires. A pointer that
   *  arrived in one last jump gets a single reading, taken while React may still
   *  be rendering the previous one; a real hand keeps sending events. These
   *  repeats are that, bounded. */
  for (let settle = 0; settle < 3; settle += 1) {
    await page.mouse.move(endX, endY + settle - 1, { steps: 2 });
  }
  await page.mouse.up();
}

export const pinnedSection = (page: Page): Locator =>
  page.getByRole('region', { name: PINNED_REGION });

/** Every row of the Pinned section, in rendered order. */
export const pinnedRows = (page: Page): Locator => pinnedSection(page).locator('ul > li');

export const pinnedConvoRow = (page: Page, title: string): Locator =>
  pinnedSection(page).getByTestId('convo-item').filter({ hasText: title });

export const favoriteRowByName = (page: Page, name: string): Locator =>
  pinnedSection(page).getByTestId('favorite-item').filter({ hasText: name });

/** The chats list below the Pinned section, where an unpinned chat reappears. */
export const chatsListRow = (page: Page, title: string): Locator =>
  page.getByTestId('convo-item').filter({ hasText: title }).first();

/** Where the Pinned section sits: on screen, slid out of view, or not laid out
 *  yet — three states, because the third one is not the second one. */
type SidebarPlacement = 'on-screen' | 'off-screen' | 'unlaid';

const sidebarPlacement = async (page: Page): Promise<SidebarPlacement> => {
  const box = await pinnedSection(page).boundingBox();
  if (!box) {
    return 'unlaid';
  }
  return box.x >= 0 ? 'on-screen' : 'off-screen';
};

/**
 * Brings the sidebar on screen. A narrow viewport keeps the drawer mounted and
 * slides it out of view instead of unmounting it, so every row still answers a
 * query while nothing on it can be tapped — the tap would land on the page
 * beside the drawer. The chat header's opener is what a person reaches for
 * there; no such control exists at desktop widths, where the panel is already
 * open, so a section that has merely not been laid out yet is waited for rather
 * than answered with a click that would never resolve.
 */
export async function ensureSidebarOnScreen(page: Page): Promise<void> {
  const drawer = page.locator('#mobile-drawer');
  /* A closed drawer stays mounted and keeps its layout box, so geometry cannot
     tell it from an open one; `inert` is the state the component actually sets
     and the reason every control inside answers a query while none of them can
     be tapped. Open it before anything below measures. */
  if ((await drawer.count()) > 0 && (await drawer.getAttribute('inert')) != null) {
    const opener = page.getByRole('button', { name: 'Open sidebar' });
    if ((await opener.count()) > 0) {
      await opener.first().click();
      await expect.poll(() => drawer.getAttribute('inert'), { timeout: 15_000 }).toBeNull();
    }
  }
  if ((await pinnedSection(page).count()) === 0) {
    /* Empty sidebars have no Pinned region to measure, but the mobile drawer
       is still mounted while its transform keeps it outside the viewport.
       Desktop renders no drawer at all, and `boundingBox()` on a locator that
       matches nothing waits for it until the test times out, so the absence
       has to be checked rather than measured. */
    if ((await drawer.count()) === 0) {
      return;
    }
    const drawerBox = await drawer.boundingBox();
    if (drawerBox != null && drawerBox.x < 0) {
      const opener = page.getByRole('button', { name: 'Open sidebar' });
      if ((await opener.count()) > 0) {
        await opener.first().click();
        await expect
          .poll(async () => (await drawer.boundingBox())?.x ?? Number.NEGATIVE_INFINITY, {
            timeout: 15_000,
          })
          .toBeGreaterThanOrEqual(0);
      }
    }
    return;
  }
  await expect.poll(() => sidebarPlacement(page), { timeout: 15_000 }).not.toBe('unlaid');
  if ((await sidebarPlacement(page)) === 'on-screen') {
    return;
  }
  const opener = page.getByRole('button', { name: 'Open sidebar' });
  /* Desktop keeps the panel open and renders no opener at all, so an x that is
   * still negative there is a panel mid-layout, not a closed drawer. */
  if ((await opener.count()) > 0) {
    await opener.first().click();
  }
  await expect.poll(() => sidebarPlacement(page), { timeout: 15_000 }).toBe('on-screen');
}

/**
 * Waits until the rows will actually accept a move. Reordering is gated on the
 * saved order having arrived — a drag started before that is disconnected and a
 * keystroke is ignored — and the rows say so themselves: each one advertises
 * `Alt+ArrowUp Alt+ArrowDown` once the section is ready to move it. A test that
 * dragged without waiting would pass or fail on how fast the order query came
 * back.
 */
export async function waitForReorderReady(page: Page): Promise<void> {
  const rows = pinnedRows(page);
  if ((await rows.count()) === 0) {
    return;
  }
  await expect
    .poll(
      async () =>
        pinnedSection(page).evaluate(
          (section) =>
            section.querySelectorAll('ul > li').length > 0 &&
            Array.from(section.querySelectorAll('ul > li')).every(
              (row) => row.querySelector('[aria-keyshortcuts]') !== null,
            ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Opens a fresh chat route and waits for the Pinned section to be reachable. */
export async function openWithPinnedSection(page: Page): Promise<void> {
  await page.goto('/c/new', { timeout: 30_000 });
  await expect(pinnedSection(page)).toBeVisible({ timeout: 30_000 });
  await ensureSidebarOnScreen(page);
  await waitForReorderReady(page);
}

/** Reloads and waits for the Pinned section to be reachable again: a reload
 *  puts a narrow viewport's drawer back off screen. */
export async function reloadWithPinnedSection(page: Page): Promise<void> {
  await page.reload({ timeout: 30_000 });
  await expect(pinnedSection(page)).toBeVisible({ timeout: 30_000 });
  await ensureSidebarOnScreen(page);
  await waitForReorderReady(page);
}

/** The rendered order of the Pinned section as row kinds, for the grouping the
 *  section guarantees: `favorite` for a pinned model/agent, `convo` for a chat. */
export async function pinnedRowKinds(page: Page): Promise<string[]> {
  return pinnedSection(page).evaluate((section) =>
    Array.from(section.querySelectorAll('ul > li')).map((row) =>
      row.querySelector('[data-testid="favorite-item"]') ? 'favorite' : 'convo',
    ),
  );
}

/** The accessible names of the Pinned rows, in rendered order. */
export async function pinnedRowNames(page: Page): Promise<string[]> {
  return pinnedSection(page).evaluate((section) =>
    Array.from(section.querySelectorAll('ul > li')).map((row) => {
      const favorite = row.querySelector('[data-testid="favorite-item"]');
      if (favorite) {
        return favorite.getAttribute('aria-label') ?? '';
      }
      return row.querySelector('[data-testid="convo-item"]')?.textContent?.trim() ?? '';
    }),
  );
}

/** The resolved corner radius of an element, in pixels. */
export async function borderRadius(locator: Locator): Promise<number> {
  return locator.evaluate((node) =>
    parseFloat(getComputedStyle(node as HTMLElement).borderTopLeftRadius),
  );
}

/** The painted background of an element, which is `transparent` until a control
 *  actually fills under the pointer. */
export async function backgroundColor(locator: Locator): Promise<string> {
  return locator.evaluate((node) => getComputedStyle(node as HTMLElement).backgroundColor);
}

export const isTransparent = (color: string): boolean =>
  color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
