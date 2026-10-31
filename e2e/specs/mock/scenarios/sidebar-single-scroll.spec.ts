import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { clearUserConversations, seedConversations, withMongo } from '../db';
import type { SeedConvo } from '../db';

/* Seeding a list long enough to scroll, then loading the app against a database
 * that may be a network hop away, is the slow part of every test here and it
 * runs in hooks, which do not read a `test.setTimeout` made in a test body. */
test.describe.configure({ timeout: 120_000 });

const userEmail = getE2EUser().email;

/** `aria-label` of the sidebar's chat-history region (`com_ui_chat_history`). */
const HISTORY_REGION = 'Chat History';
/** `aria-label` of the Pinned section's region (`com_ui_pinned`). */
const PINNED_REGION = 'Pinned';

const historyRegion = (page: Page): Locator => page.getByRole('region', { name: HISTORY_REGION });
const pinnedRegion = (page: Page): Locator => page.getByRole('region', { name: PINNED_REGION });

type Seeded = { conversationId: string; title: string };

const titleOf = (prefix: string, index: number) => `${prefix} ${String(index).padStart(3, '0')}`;

/** Chats, newest first: index 0 is the top row, the last index the oldest. */
async function seedChats(prefix: string, count: number): Promise<Seeded[]> {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const base = noon.getTime();
  const convos: SeedConvo[] = Array.from({ length: count }, (_, index) => ({
    conversationId: randomUUID(),
    title: titleOf(prefix, index),
    updatedAt: new Date(base - index * 1000),
  }));
  await seedConversations(userEmail, convos);
  return convos.map(({ conversationId, title }) => ({ conversationId, title }));
}

/** Pinned chats are ordinary conversations carrying `pinned: true`; the sidebar
 *  lifts them out of the date groups into the Pinned section. `ageDays` backs
 *  them out of the recent window, for a spec that needs the first page of the
 *  chats query to be chats rather than the pins it strips back out. */
async function seedPins(prefix: string, count: number, ageDays = 0): Promise<Seeded[]> {
  const now = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  const pins: Seeded[] = Array.from({ length: count }, (_, index) => ({
    conversationId: randomUUID(),
    title: titleOf(prefix, index),
  }));
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
        createdAt: new Date(now - index * 1000),
        updatedAt: new Date(now - index * 1000),
        __v: 0,
      })),
    );
  });
  return pins;
}

/**
 * Brings the sidebar on screen. A narrow viewport keeps the drawer mounted and
 * slides it out of view instead of unmounting it, so every row still answers a
 * query while nothing on it can be scrolled — the wheel would land on the page
 * beside the drawer. The chat header's opener is what a person reaches for
 * there, and it only exists once that header has rendered, so the click is
 * retried rather than taken once. Desktop renders no opener at all, where a
 * box still left of the origin is a panel mid-layout, not a closed drawer.
 */
async function openSidebar(page: Page): Promise<void> {
  await expect(historyRegion(page)).toBeVisible({ timeout: 30_000 });
  const placement = async () => {
    const box = await historyRegion(page).boundingBox();
    if (box === null) {
      return 'unlaid';
    }
    return box.x >= 0 ? 'on-screen' : 'off-screen';
  };
  await expect.poll(placement, { timeout: 30_000 }).not.toBe('unlaid');
  for (let attempt = 0; attempt < 3 && (await placement()) === 'off-screen'; attempt++) {
    const opener = page.getByRole('button', { name: 'Open sidebar' }).first();
    if (await opener.isVisible().catch(() => false)) {
      await opener.click();
    }
    await expect
      .poll(placement, { timeout: 10_000 })
      .toBe('on-screen')
      .catch(() => undefined);
  }
  await expect.poll(placement, { timeout: 15_000 }).toBe('on-screen');
}

type Surface = { top: number; height: number; scrollTop: number; scrollHeight: number };

/**
 * Every descendant of the chat-history region that actually scrolls. The whole
 * point of the single surface is that this is one element: the sections above
 * the chats no longer keep scrollable boxes of their own.
 */
const scrollingSurfaces = (page: Page): Promise<Surface[]> =>
  historyRegion(page).evaluate((region) =>
    Array.from(region.querySelectorAll('*'))
      .filter((node) => {
        const style = getComputedStyle(node);
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        return scrolls && node.scrollHeight > node.clientHeight + 1;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top,
          height: rect.height,
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
        };
      }),
  );

const sidebarScrollTop = async (page: Page): Promise<number> => {
  const [surface] = await scrollingSurfaces(page);
  return surface?.scrollTop ?? 0;
};

/** Moves the sidebar's own scroll surface, for the emulated touch devices
 *  where a wheel gesture is not what a person would produce. */
const dragSurface = (page: Page, deltaY: number) =>
  historyRegion(page).evaluate((region, delta) => {
    const surface = Array.from(region.querySelectorAll('*')).find((node) => {
      const style = getComputedStyle(node);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1
      );
    });
    surface?.scrollBy(0, delta);
  }, deltaY);

/**
 * Scrolls the sidebar the way a person does: the wheel turns over a point
 * inside it and whatever surface is under the pointer takes the gesture. The
 * pointer is deliberately placed over the rows rather than over some scrollbar,
 * because "one scroll" is a claim about what happens under the content. Touch
 * emulation produces no wheel, so there the same surface is driven directly.
 */
async function scrollSidebar(page: Page, deltaY: number): Promise<number> {
  const box = await historyRegion(page).boundingBox();
  expect(box, 'the chat-history region should be laid out').not.toBeNull();
  const before = await sidebarScrollTop(page);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, deltaY);
  await expect
    .poll(() => sidebarScrollTop(page), { timeout: 3_000 })
    .not.toBe(before)
    .catch(() => undefined);
  if ((await sidebarScrollTop(page)) === before) {
    await dragSurface(page, deltaY);
  }
  await expect.poll(() => sidebarScrollTop(page), { timeout: 10_000 }).not.toBe(before);
  return sidebarScrollTop(page);
}

/** Scrolls to the end of the sidebar, following the list as later pages load. */
async function scrollToBottom(page: Page, turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    const box = await historyRegion(page).boundingBox();
    if (!box) {
      return;
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 2000);
    await dragSurface(page, 2000);
    await page.waitForTimeout(400);
  }
}

/**
 * Samples the visible band of the chats list for painted rows. A list windowed
 * against a stale offset renders the wrong slice, which shows up as points
 * inside the band that land on no row at all.
 */
const bandSample = (page: Page) =>
  historyRegion(page).evaluate((region) => {
    const grid = region.querySelector('.ReactVirtualized__Grid');
    const surface = Array.from(region.querySelectorAll('*')).find((node) => {
      const style = getComputedStyle(node);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1
      );
    });
    if (!grid || !surface) {
      return { rows: [] as string[], holes: [] as number[] };
    }
    const gridRect = grid.getBoundingClientRect();
    const viewRect = surface.getBoundingClientRect();
    const top = Math.max(gridRect.top, viewRect.top) + 6;
    const bottom = Math.min(gridRect.bottom, viewRect.bottom) - 6;
    const x = viewRect.left + viewRect.width / 2;
    const rows: string[] = [];
    const holes: number[] = [];
    for (let y = top; y < bottom; y += 16) {
      const node = document.elementFromPoint(x, y);
      const row = node?.closest('[data-testid="convo-item"], [data-testid="convo-list-row"]');
      if (row) {
        const title = (row.textContent ?? '').trim().split('\n')[0];
        if (title && rows[rows.length - 1] !== title) {
          rows.push(title);
        }
      } else {
        holes.push(Math.round(y - viewRect.top));
      }
    }
    return { rows, holes };
  });

/** Every page the chats list asks the server for, as it asks for it. The pinned
 *  query rides the same route and is left out: it is not the list's paging. */
function trackChatPages(page: Page): string[] {
  const pages: string[] = [];
  page.on('request', (request) => {
    const { pathname, searchParams } = new URL(request.url());
    if (request.method() === 'GET' && pathname === '/api/convos' && !searchParams.has('pinned')) {
      pages.push(request.url());
    }
  });
  return pages;
}

/** Waits until the chats list starts past the bottom edge of the surface. */
const waitForChatsBelowTheFold = (page: Page) =>
  expect
    .poll(
      () =>
        historyRegion(page).evaluate((region) => {
          const grid = region.querySelector('.ReactVirtualized__Grid');
          const surface = Array.from(region.querySelectorAll('*')).find((node) => {
            const style = getComputedStyle(node);
            return style.overflowY === 'auto' || style.overflowY === 'scroll';
          });
          if (!grid || !surface) {
            return false;
          }
          return grid.getBoundingClientRect().top >= surface.getBoundingClientRect().bottom;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

const seeded: Seeded[] = [];

const remember = (rows: Seeded[]): Seeded[] => {
  seeded.push(...rows);
  return rows;
};

test.afterEach(async () => {
  seeded.length = 0;
  await clearUserConversations(userEmail);
});

test.describe('sidebar single scroll', () => {
  test('the whole sidebar scrolls as one surface @scenario:sidebar-scrolls-as-one-surface', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    remember(await seedPins('E2E pin', 4));
    remember(await seedChats('E2E chat', 40));

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(pinnedRegion(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('convo-item').first()).toBeVisible({ timeout: 30_000 });

    const surfaces = await scrollingSurfaces(page);
    expect(surfaces, 'the sidebar should present exactly one scrolling surface').toHaveLength(1);

    const pinnedBefore = await pinnedRegion(page).boundingBox();
    expect(pinnedBefore).not.toBeNull();

    const scrolled = await scrollSidebar(page, 400);
    expect(scrolled).toBeGreaterThan(0);

    /* The Pinned section rides the same gesture instead of staying put: it
     * moves up by what the surface scrolled. */
    await expect
      .poll(
        async () => {
          const after = await pinnedRegion(page).boundingBox();
          return after === null ? null : Math.round(pinnedBefore!.y - after.y);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(100);

    const sample = await bandSample(page);
    expect(sample.holes, 'the visible list should be fully painted').toEqual([]);
    expect(sample.rows.length).toBeGreaterThan(0);
  });

  test('older chats load as the sidebar scrolls to its end @scenario:older-chats-load-as-the-sidebar-scrolls', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    const chats = remember(await seedChats('E2E page', 60));
    const oldest = chats[chats.length - 1].title;

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(page.getByTestId('convo-item').first()).toBeVisible({ timeout: 30_000 });

    const oldestRow = page.getByTestId('convo-item').filter({ hasText: oldest });
    expect(await oldestRow.count(), 'the oldest chat should still be beyond the first page').toBe(
      0,
    );

    await scrollToBottom(page, 12);

    await expect(oldestRow.first()).toBeVisible({ timeout: 30_000 });
  });

  test('collapsing a section keeps the visible chats in place @scenario:collapsing-a-section-keeps-the-visible-chats-in-place', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    remember(await seedPins('E2E pin', 6));
    remember(await seedChats('E2E chat', 50));

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(pinnedRegion(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('convo-item').first()).toBeVisible({ timeout: 30_000 });

    await scrollSidebar(page, 600);
    const before = await bandSample(page);
    expect(before.holes).toEqual([]);
    expect(before.rows.length).toBeGreaterThan(1);

    /* Collapsing a section above the chats shortens the surface without
     * resizing either the viewport or the list, which is exactly the change
     * that leaves a windowed list painting the wrong slice. */
    await pinnedRegion(page).getByRole('button', { name: PINNED_REGION }).click();
    await expect(pinnedRegion(page).getByRole('button', { name: PINNED_REGION })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.waitForTimeout(600);

    const after = await bandSample(page);
    expect(after.holes, 'the list should stay painted after the collapse').toEqual([]);
    expect(
      after.rows.some((title) => before.rows.includes(title)),
      `chats on screen before the collapse (${before.rows.join(', ')}) should still be there, got ${after.rows.join(', ')}`,
    ).toBe(true);
  });

  test('a long pinned list scrolls with the sidebar @scenario:pinned-list-scrolls-with-the-sidebar', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    remember(await seedPins('E2E pin', 20));
    remember(await seedChats('E2E chat', 30));

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(pinnedRegion(page)).toBeVisible({ timeout: 30_000 });

    const pinnedScrollers = await pinnedRegion(page).evaluate(
      (region) =>
        Array.from(region.querySelectorAll('*')).filter((node) => {
          const style = getComputedStyle(node);
          return (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 1
          );
        }).length,
    );
    expect(pinnedScrollers, 'the pinned list should not scroll inside its own box').toBe(0);

    const firstPin = pinnedRegion(page).getByTestId('convo-item').first();
    const before = await firstPin.boundingBox();
    expect(before).not.toBeNull();

    await scrollSidebar(page, 300);

    await expect
      .poll(
        async () => {
          const after = await firstPin.boundingBox();
          return after === null ? null : Math.round(before!.y - after.y);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(100);
  });

  test('chats stop fetching pages while they sit below the fold @scenario:chats-page-loads-only-when-chats-come-into-view', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    /* Enough pins to hold the chats list below the fold on both a desktop
     * panel and an emulated handset, and old enough that the first page of the
     * chats query is chats: pins ride that query too, and a page made only of
     * rows the list strips back out has its own reason to fetch another. */
    remember(await seedPins('E2E pin', 24, 400));
    remember(await seedChats('E2E chat', 60));

    const pages = trackChatPages(page);

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(pinnedRegion(page).getByTestId('convo-item').first()).toBeVisible({
      timeout: 30_000,
    });

    /** The pins arrive on their own query, so until they land the chats hold
     *  the sidebar and reading them is exactly what a person does. The claim
     *  is about the settled layout: once the chats sit below a screenful of
     *  pins, nothing keeps asking the server for more of them. */
    await waitForChatsBelowTheFold(page);

    const settled = pages.length;
    await page.waitForTimeout(3_000);
    expect(
      pages.length,
      `no page should be fetched for chats nobody can see, got ${pages.join(', ')}`,
    ).toBe(settled);

    /* Kept scrolling until the list answers, the way a reader does: one burst
     * lands wherever the rows rendered so far end, and the list grows as they
     * are measured. */
    for (let turn = 0; turn < 12 && pages.length === settled; turn++) {
      await scrollToBottom(page, 2);
    }
    await expect.poll(() => pages.length, { timeout: 30_000 }).toBeGreaterThan(settled);
  });

  test('a page whose chats are nearly all pinned waits for the reader too @scenario:mostly-pinned-page-waits-for-the-reader', async ({
    page,
  }) => {
    await clearUserConversations(userEmail);
    /* The pins are the newest conversations, so they fill most of the first
     * page of the chats query and the list is left holding a handful of rows —
     * few enough that its last rendered row is already within the threshold
     * that asks for another page. It still sits below the fold. */
    remember(await seedPins('E2E pin', 20));
    remember(await seedChats('E2E chat', 40));

    const pages = trackChatPages(page);

    await page.goto('/c/new', { timeout: 30_000 });
    await openSidebar(page);
    await expect(pinnedRegion(page).getByTestId('convo-item').first()).toBeVisible({
      timeout: 30_000,
    });
    await waitForChatsBelowTheFold(page);

    const settled = pages.length;
    await page.waitForTimeout(3_000);
    expect(
      pages.length,
      `a short page under the pins should not fetch another, got ${pages.join(', ')}`,
    ).toBe(settled);

    for (let turn = 0; turn < 12 && pages.length === settled; turn++) {
      await scrollToBottom(page, 2);
    }
    await expect.poll(() => pages.length, { timeout: 30_000 }).toBeGreaterThan(settled);
  });
});
