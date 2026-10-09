import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  backgroundColor,
  borderRadius,
  favoriteRowByName,
  isConversationPinned,
  isTransparent,
  openWithPinnedSection,
  pinnedConvoRow,
  reloadWithPinnedSection,
  removePins,
  resetPinnedState,
  seedPinnedConversations,
  setFavorites,
} from './pinned.helpers';
import type { ModelFavorite, SeededPin } from './pinned.helpers';

/* Seeding a pinned list and reloading is the slow part of every test here, and it
 * runs in hooks, which do not read a `test.setTimeout` call made inside a test
 * body: a loaded machine timed the `beforeEach` out at the default 30s while the
 * test itself was allowed 60. Configured once for the file instead, with room
 * for the first test of a run, which also pays the app's cold start against a
 * database that may be a network hop away. */
test.describe.configure({ timeout: 120_000 });

const FAVORITE: ModelFavorite = {
  endpoint: 'Mock Provider A',
  model: 'mock-model-a',
};

const controlState = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element as HTMLElement);
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
    };
  });

const controlAppearance = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element as HTMLElement);
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      color: style.color,
      radius: style.borderTopLeftRadius,
    };
  });

const nextFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );

let seededPins: SeededPin[] = [];

test.describe('pinned row controls', () => {
  test.beforeEach(async ({ page }) => {
    seededPins = await seedPinnedConversations([
      `Pinned controls first ${randomUUID()}`,
      `Pinned controls second ${randomUUID()}`,
    ]);
    await openWithPinnedSection(page);
    await setFavorites(page, [FAVORITE]);
    await reloadWithPinnedSection(page);
  });

  test.afterEach(async ({ page }) => {
    const pins = seededPins;
    seededPins = [];
    await removePins(pins);
    await resetPinnedState(page);
  });

  /** Regression: a control using the row radius filled its rounded corner-to-corner. */
  test('controls draw inside their row @scenario:pinned-row-controls-draw-inside-their-row', async ({
    page,
  }) => {
    const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    test.skip(!hasHover, 'pointer hover is a desktop-only path');
    const row = pinnedConvoRow(page, seededPins[0].title);
    const badge = row.getByTestId('convo-unpin-button');
    const restingRadius = await borderRadius(row);

    await row.hover();
    const trigger = row.getByRole('button', { name: 'Conversation Menu Options' });
    await expect(trigger).toBeVisible();
    await trigger.hover();

    expect(restingRadius).toBe(8);
    expect(await borderRadius(badge)).toBe(6);
    expect(await borderRadius(trigger)).toBe(6);
    expect(await borderRadius(row)).toBe(restingRadius);
    expect(isTransparent(await backgroundColor(trigger))).toBe(false);
  });

  /** Regression: chat and favorite rows used different unpin colours and reveal rules. */
  test('both pinned kinds show the same unpin badge @scenario:both-pinned-kinds-show-the-same-unpin-badge', async ({
    page,
  }) => {
    const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    test.skip(!hasHover, 'badge reveal comparison is a desktop-only path');

    const chatRow = pinnedConvoRow(page, seededPins[0].title);
    const favoriteRow = favoriteRowByName(page, FAVORITE.model);
    const chatBadge = chatRow.getByTestId('convo-unpin-button');
    const favoriteBadge = favoriteRow.getByTestId('favorite-unpin-button');
    const chatAppearance = await controlAppearance(chatBadge);
    const favoriteAppearance = await controlAppearance(favoriteBadge);

    expect(favoriteAppearance).toEqual(chatAppearance);
    await expect
      .poll(() => controlState(chatBadge))
      .toEqual({
        opacity: '0',
        pointerEvents: 'none',
      });
    await expect
      .poll(() => controlState(favoriteBadge))
      .toEqual({
        opacity: '0',
        pointerEvents: 'none',
      });

    await chatRow.hover();
    await expect
      .poll(() => controlState(chatBadge))
      .toEqual({
        opacity: '1',
        pointerEvents: 'auto',
      });

    await favoriteRow.hover();
    await expect
      .poll(() => controlState(favoriteBadge))
      .toEqual({
        opacity: '1',
        pointerEvents: 'auto',
      });
  });

  /** Regression: opening a row menu made its still-needed unpin badge disappear. */
  test('the unpin badge stays while its row menu is open @scenario:the-unpin-badge-stays-while-its-rows-menu-is-open', async ({
    page,
  }) => {
    const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    test.skip(!hasHover, 'pointer hover is a desktop-only path');
    const row = pinnedConvoRow(page, seededPins[0].title);
    const badge = row.getByTestId('convo-unpin-button');
    await row.hover();

    const trigger = row.getByRole('button', { name: 'Conversation Menu Options' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const menu = page.getByRole('menu').last();
    await expect(menu).toBeVisible();
    await menu.hover();

    await expect
      .poll(() => controlState(badge))
      .toEqual({
        opacity: '1',
        pointerEvents: 'auto',
      });
    await badge.click({ trial: true });

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    /** Closing the menu returns focus to the trigger, and a row holding focus
     *  keeps its badge on purpose — the badge withdraws once neither the pointer
     *  nor the keyboard is on the row. */
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(1, 1);
    await expect
      .poll(() => controlState(badge))
      .toEqual({
        opacity: '0',
        pointerEvents: 'none',
      });
  });

  /** Regression: mounting the overflow trigger after hover shifted the badge and caused a flicker. */
  test('hovering a pinned chat row holds its controls still @scenario:hovering-a-pinned-chat-row-holds-its-controls-still', async ({
    page,
  }) => {
    const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    test.skip(!hasHover, 'pointer hover is a desktop-only path');
    const row = pinnedConvoRow(page, seededPins[0].title);
    const badge = row.getByTestId('convo-unpin-button');
    const beforeHover = await badge.boundingBox();
    expect(beforeHover).not.toBeNull();
    const beforeHoverX = beforeHover?.x;
    expect(beforeHoverX).toBeDefined();

    const rowBox = await row.boundingBox();
    expect(rowBox).not.toBeNull();
    await page.mouse.move(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0) / 2,
      (rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2,
    );
    const immediatelyAfterEnter = await badge.boundingBox();
    expect(immediatelyAfterEnter).not.toBeNull();
    const immediatelyAfterEnterX = immediatelyAfterEnter?.x;
    expect(immediatelyAfterEnterX).toBeDefined();

    const trigger = row.getByRole('button', { name: 'Conversation Menu Options' });
    await expect(trigger).toBeVisible();
    await nextFrame(page);
    const afterTriggerMounted = await badge.boundingBox();
    expect(afterTriggerMounted).not.toBeNull();
    expect(
      Math.abs((afterTriggerMounted?.x ?? 0) - (immediatelyAfterEnterX ?? 0)),
    ).toBeLessThanOrEqual(1);

    const firstTriggerHandle = await trigger.elementHandle();
    expect(firstTriggerHandle).not.toBeNull();
    await firstTriggerHandle?.evaluate((element) => {
      element.setAttribute('data-e2e-mounted-once', 'true');
    });

    await page.mouse.move(1, 1);
    await expect(trigger).toBeAttached();
    await row.hover();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('data-e2e-mounted-once', 'true');
  });

  /** Regression: on touch, the first tap only revealed the badge instead of unpinning. */
  test('a touch tap reaches the unpin badge directly @scenario:a-touch-tap-reaches-the-unpin-badge-directly', async ({
    page,
  }) => {
    const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    test.skip(hasHover, 'direct badge tap is a touch-only path');

    const row = pinnedConvoRow(page, seededPins[0].title);
    const badge = row.getByTestId('convo-unpin-button');
    await expect(badge).toBeVisible();
    await expect
      .poll(() => controlState(badge))
      .toEqual({
        opacity: '1',
        pointerEvents: 'auto',
      });

    await badge.tap();
    await expect(row).toHaveCount(0);
    await expect.poll(() => isConversationPinned(seededPins[0].conversationId)).toBe(false);
  });
});
