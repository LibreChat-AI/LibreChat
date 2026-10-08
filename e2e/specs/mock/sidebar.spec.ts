import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../setup/user';
import { clearUserConversations, deleteConversations, seedConversations } from './db';
import type { SeedConvo } from './db';

/**
 * Width of the virtualized chat list grid vs. its measured container. The list
 * no longer owns a scroll pane: it renders at its natural height inside the
 * sidebar's single scroll surface, so its height follows the rows it holds and
 * only its width has to track the box it is measured against.
 */
const widths = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('aside .ReactVirtualized__Grid');
    const wrap = grid?.parentElement ?? null;
    const gridRect = grid?.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    return {
      grid: gridRect ? gridRect.width : -1,
      wrap: wrapRect ? wrapRect.width : -1,
      gridH: gridRect ? gridRect.height : -1,
    };
  });

/**
 * Polls until the grid matches its container AND the width has stopped changing
 * between samples — the sidebar expand/collapse animation runs for 300ms, and a
 * tracking-only check can match mid-animation on slow CI machines.
 */
const settledWidths = async (page: Page) => {
  let prev = await widths(page);
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(350);
    const next = await widths(page);
    const tracked = next.wrap > 0 && next.gridH > 0 && Math.abs(next.grid - next.wrap) <= 1;
    const stable = Math.abs(next.grid - prev.grid) <= 1;
    if (tracked && stable) {
      return next;
    }
    prev = next;
  }
  throw new Error(`Sidebar chat list never settled: ${JSON.stringify(prev)}`);
};

test.describe('sidebar chat list', () => {
  let sized: SeedConvo[] = [];

  test.afterEach(async () => {
    if (sized.length) {
      await deleteConversations(sized.map((convo) => convo.conversationId));
      sized = [];
    }
  });

  test('chat list width tracks the sidebar through resize and collapse cycles', async ({
    page,
  }) => {
    test.setTimeout(60000);
    /* The grid is as tall as the rows it renders, so a list with nothing in it
     * has no box to measure: seed the rows this test measures against. */
    sized = buildSeed();
    await seedConversations(getE2EUser().email, sized);

    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.locator('aside .ReactVirtualized__Grid').first()).toBeVisible({
      timeout: 20000,
    });

    const initial = await settledWidths(page);

    const separator = page.locator('[role="separator"][aria-label="Resize sidebar"]');
    const sepBox = await separator.boundingBox();
    expect(sepBox).not.toBeNull();
    const startX = (sepBox?.x ?? 0) + (sepBox?.width ?? 0) / 2;
    const y = (sepBox?.y ?? 0) + (sepBox?.height ?? 0) / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(startX + i * 20, y);
      await page.waitForTimeout(50);
    }
    await page.mouse.up();

    const widened = await settledWidths(page);
    expect(widened.grid).toBeGreaterThan(initial.grid);

    await page.locator('aside').getByTestId('close-sidebar-button').click();
    await page.locator('aside').getByTestId('open-sidebar-button').click();

    const reopened = await settledWidths(page);
    expect(reopened.grid).toBeGreaterThan(initial.grid);

    /* A shorter viewport changes how much of the list is on screen, never how
     * wide its rows are measured. */
    await page.setViewportSize({ width: 1280, height: 540 });
    const shrunken = await settledWidths(page);
    expect(Math.abs(shrunken.grid - reopened.grid)).toBeLessThanOrEqual(1);
  });
});

/**
 * Regression: expanding the sidebar from a collapsed reload first measured the
 * virtualized conversation rows mid-animation (narrow width), so date-group headers
 * ("Previous 7 days", ...) wrapped and cached oversized heights. With `fixedWidth`
 * the cache never re-measured at full width, leaving a gap between each header's
 * text and the row beneath it.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const userEmail = getE2EUser().email;

/**
 * The header `<h2>` is single-line; its row wrapper should hug it (just the small
 * top margin). A stale wrapped measurement inflates the wrapper well past this.
 */
const MAX_HEADER_PADDING = 24;

const GROUPS = [
  { label: 'Today', offsetDays: 0 },
  { label: 'Previous 7 days', offsetDays: 3 },
  { label: 'Previous 30 days', offsetDays: 15 },
] as const;

function buildSeed(): SeedConvo[] {
  // Anchor on local noon so the zero-day group stays inside "today" even when the
  // spec runs right after midnight; second-level offsets keep ordering within a day.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const base = noon.getTime();
  return GROUPS.flatMap((group, groupIndex) =>
    [0, 1].map((n) => ({
      conversationId: randomUUID(),
      title: `E2E ${group.label} #${n}`,
      updatedAt: new Date(base - group.offsetDays * DAY_MS - (groupIndex + n) * 1000),
    })),
  );
}

// The DateLabel <h2> exposes an aria-label ("Chats from {date}"), so its accessible
// name is the full phrase, not the visible group label.
const heading = (page: Page, label: string) =>
  page.getByRole('heading', { name: `Chats from ${label}`, exact: true });

const headerRow = (page: Page, label: string) =>
  page.getByTestId('convo-list-row').filter({ has: heading(page, label) });

test.describe('sidebar conversation grouping', () => {
  let seeded: SeedConvo[] = [];

  test.afterEach(async () => {
    if (seeded.length) {
      await deleteConversations(seeded.map((c) => c.conversationId));
      seeded = [];
    }
  });

  test('keeps date-group spacing tight after expanding from a collapsed reload', async ({
    page,
  }) => {
    test.setTimeout(60000);
    // Isolate from rows other specs leave on the shared user, which could otherwise
    // push the later date-group headers below the virtualized viewport.
    await clearUserConversations(userEmail);
    seeded = buildSeed();
    await seedConversations(userEmail, seeded);

    // Default load is expanded: confirm the seeded conversations render at all.
    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.getByTestId('convo-item').first()).toBeVisible({ timeout: 15000 });

    // Force the collapsed start state, then reload so the list mounts collapsed.
    await page.evaluate(() =>
      localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(false)),
    );
    await page.reload({ timeout: 10000 });
    // The chat header keeps its own mobile toggle mounted and hides it with CSS, so this
    // testid belongs to the rail alone — a second holder makes the click below strict-mode
    // flaky rather than failing outright.
    await expect(page.getByTestId('open-sidebar-button')).toHaveCount(1);
    await expect(page.getByTestId('open-sidebar-button')).toBeVisible();

    // Expand: rows first measure during the width animation — the regression window.
    await page.getByTestId('open-sidebar-button').click();
    await expect(page.getByTestId('close-sidebar-button')).toBeVisible();
    await expect(page.getByTestId('convo-item').first()).toBeVisible({ timeout: 15000 });

    // Each header row must hug its single-line text, not retain an inflated height.
    for (const { label } of GROUPS) {
      const row = headerRow(page, label);
      await expect(row).toBeVisible({ timeout: 10000 });
      const rowBox = await row.boundingBox();
      const textBox = await heading(page, label).boundingBox();
      expect(rowBox, `row "${label}" should have a bounding box`).not.toBeNull();
      expect(textBox, `heading "${label}" should have a bounding box`).not.toBeNull();
      const padding = rowBox!.height - textBox!.height;
      expect(
        padding,
        `header "${label}" row (${rowBox!.height}px) should hug its text (${textBox!.height}px)`,
      ).toBeLessThan(MAX_HEADER_PADDING);
    }
  });
});
