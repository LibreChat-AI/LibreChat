import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  chatsListRow,
  convoEntryKey,
  dragRowOnto,
  favoriteEntryKey,
  favoriteRowByName,
  isConversationPinned,
  openWithPinnedSection,
  pinnedConvoRow,
  pinnedRowKinds,
  pinnedRowNames,
  pinnedRows,
  pinnedSection,
  reloadWithPinnedSection,
  removePins,
  resetPinnedState,
  seedPinnedConversations,
  setFavorites,
  setPinnedOrder,
} from './pinned.helpers';
import type { SeededPin } from './pinned.helpers';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, seedConversations } from '../db';

/* Seeding a pinned list and reloading is the slow part of every test here, and it
 * runs in hooks, which do not read a `test.setTimeout` call made inside a test
 * body: a loaded machine timed the `beforeEach` out at the default 30s while the
 * test itself was allowed 60. Configured once for the file instead, with room
 * for the first test of a run, which also pays the app's cold start against a
 * database that may be a network hop away. */
test.describe.configure({ timeout: 120_000 });

const MOCK_FAVORITE_A = { endpoint: 'Mock Provider A', model: 'mock-model-a' } as const;
const MOCK_FAVORITE_B = { endpoint: 'Mock Provider B', model: 'mock-model-b' } as const;

let seededPins: SeededPin[] = [];
/** Chats seeded unpinned, which a test may leave pinned on purpose. */
const unpinnedConversationIds: string[] = [];

test.afterEach(async ({ page }) => {
  const pins = seededPins.splice(0);
  const plain = unpinnedConversationIds.splice(0);
  /* A test that skipped on a pointer without hover seeded nothing and left no
   * page to read a token from: reaching for one here is what turns a skip into
   * a failure. */
  if (pins.length === 0 && plain.length === 0) {
    return;
  }
  try {
    await resetPinnedState(page);
  } finally {
    await removePins(pins);
    if (plain.length > 0) {
      await deleteConversations(plain);
    }
  }
});

const uniqueTitles = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1} ${randomUUID()}`);

const dragSource = (row: Locator): Locator => row.locator('xpath=..');

async function skipWithoutHover(page: Page): Promise<void> {
  const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
  test.skip(!hasHover, 'pointer drag requires a hover-capable pointer');
}
test.describe('pinned drag rules', () => {
  test('dropping a pinned chat on Chats unpins it @scenario:dropping-a-pinned-chat-on-chats-unpins-it', async ({
    page,
  }) => {
    await skipWithoutHover(page);
    const [draggedTitle, remainingTitle] = uniqueTitles('drop-to-chats', 2);
    seededPins = await seedPinnedConversations([draggedTitle, remainingTitle]);

    await openWithPinnedSection(page);
    const draggedRow = pinnedConvoRow(page, draggedTitle);
    await expect(draggedRow).toBeVisible();
    await expect(pinnedConvoRow(page, remainingTitle)).toBeVisible();

    /** The old Chats drop filed the chat but left `pinned: true`, so it remained
     * visible in Pinned after the user had dragged it out of that section. */
    await dragRowOnto(
      page,
      dragSource(draggedRow),
      page.getByRole('button', { name: 'Chats', exact: true }),
      0.5,
    );

    await expect(pinnedConvoRow(page, draggedTitle)).toHaveCount(0);
    await expect(chatsListRow(page, draggedTitle)).toBeVisible();
    await expect.poll(() => isConversationPinned(seededPins[0].conversationId)).toBe(false);

    await reloadWithPinnedSection(page);
    await expect(pinnedSection(page)).toBeVisible();
    await expect(pinnedConvoRow(page, draggedTitle)).toHaveCount(0);
    await expect(chatsListRow(page, draggedTitle)).toBeVisible();
  });

  test('dropping an unpinned chat on a pinned row pins it @scenario:dropping-a-chat-on-a-pinned-row-pins-it', async ({
    page,
  }) => {
    await skipWithoutHover(page);
    const [pinnedTitle] = uniqueTitles('pin-on-row', 1);
    const plainTitle = `pin-on-row plain ${randomUUID()}`;
    seededPins = await seedPinnedConversations([pinnedTitle]);
    const plain = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId: plain, title: plainTitle, updatedAt: new Date() },
    ]);
    unpinnedConversationIds.push(plain);

    await openWithPinnedSection(page);
    await expect(pinnedConvoRow(page, pinnedTitle)).toBeVisible();
    const plainRow = chatsListRow(page, plainTitle);
    await expect(plainRow).toBeVisible();

    /** The section takes a chat dropped anywhere on it, and a row is part of the
     *  section: a release that lands on one rather than between two has to pin
     *  the chat, not be swallowed by the row it landed on. */
    await dragRowOnto(page, plainRow, pinnedConvoRow(page, pinnedTitle), 0.5);

    await expect(pinnedConvoRow(page, plainTitle)).toBeVisible();
    await expect.poll(() => isConversationPinned(plain)).toBe(true);
  });

  test('a pinned chat cannot be dragged through a pinned model @scenario:a-pinned-chat-cannot-be-dragged-through-a-pinned-model', async ({
    page,
  }) => {
    await skipWithoutHover(page);
    /** One chat to start with: a second one below it would be a legitimate
     *  same-kind neighbour for the pointer to swap with on its way up, and the
     *  order would change for a reason that has nothing to do with the boundary
     *  being tested. */
    const [draggedTitle] = uniqueTitles('kind-boundary', 1);
    seededPins = await seedPinnedConversations([draggedTitle]);

    await openWithPinnedSection(page);
    await setFavorites(page, [MOCK_FAVORITE_A, MOCK_FAVORITE_B]);
    await reloadWithPinnedSection(page);
    await expect(favoriteRowByName(page, MOCK_FAVORITE_A.model)).toBeVisible();
    await expect(favoriteRowByName(page, MOCK_FAVORITE_B.model)).toBeVisible();
    await expect(pinnedRows(page)).toHaveCount(3);

    const initialNames = await pinnedRowNames(page);
    const dragged = dragSource(pinnedConvoRow(page, draggedTitle));
    const favorite = favoriteRowByName(page, MOCK_FAVORITE_A.model);

    /** Dropped on either half of a pinned model, because the half decides which
     *  way a same-kind row would have been displaced: a chat that could pass
     *  through this row would land above it from the top half and below it from
     *  the bottom half, and the list cannot honour either. */
    await dragRowOnto(page, dragged, favorite, 0.25);
    await expect.poll(() => pinnedRowNames(page)).toEqual(initialNames);
    await dragRowOnto(page, dragged, favorite, 0.75);
    await expect.poll(() => pinnedRowNames(page)).toEqual(initialNames);

    /** The same gesture must still reorder against the chat's own kind, or this
     *  test would pass just as well against a drag source that does nothing. */
    const [neighbourTitle] = uniqueTitles('kind-boundary-neighbour', 1);
    seededPins.push(...(await seedPinnedConversations([neighbourTitle])));
    await reloadWithPinnedSection(page);
    await expect(pinnedRows(page)).toHaveCount(4);
    const withNeighbour = await pinnedRowNames(page);
    const lower = withNeighbour[3];
    const upper = withNeighbour[2];

    await dragRowOnto(
      page,
      dragSource(pinnedConvoRow(page, lower)),
      pinnedConvoRow(page, upper),
      0.25,
    );
    await expect
      .poll(() => pinnedRowNames(page))
      .toEqual([
        `${MOCK_FAVORITE_A.model} (Model)`,
        `${MOCK_FAVORITE_B.model} (Model)`,
        lower,
        upper,
      ]);
  });

  /** A keyboard step at the boundary used to cross into the other row kind,
   * announcing a position from the combined list instead of refusing the move. */
  test('Alt+Arrow stops a pinned row at its kind edge @scenario:alt-arrow-stops-a-pinned-row-at-its-kinds-edge', async ({
    page,
  }) => {
    const [firstTitle] = uniqueTitles('keyboard-kind-edge', 1);
    seededPins = await seedPinnedConversations([firstTitle]);

    await openWithPinnedSection(page);
    await setFavorites(page, [MOCK_FAVORITE_A]);
    await setPinnedOrder(page, [
      favoriteEntryKey(MOCK_FAVORITE_A),
      convoEntryKey(seededPins[0].conversationId),
    ]);
    await reloadWithPinnedSection(page);
    await expect(favoriteRowByName(page, MOCK_FAVORITE_A.model)).toBeVisible();
    await expect(pinnedRows(page)).toHaveCount(2);

    const firstChatFocus = pinnedConvoRow(page, firstTitle).getByRole('button').first();
    await firstChatFocus.focus();
    await firstChatFocus.press('Alt+ArrowUp');
    await expect
      .poll(() => pinnedRowNames(page))
      .toEqual([`${MOCK_FAVORITE_A.model} (Model)`, firstTitle]);
    await expect(pinnedSection(page).getByRole('status')).toHaveText('');

    const [secondTitle] = uniqueTitles('keyboard-kind-edge', 1);
    const secondPins = await seedPinnedConversations([secondTitle]);
    seededPins.push(...secondPins);
    await setPinnedOrder(page, [
      favoriteEntryKey(MOCK_FAVORITE_A),
      convoEntryKey(seededPins[0].conversationId),
      convoEntryKey(secondPins[0].conversationId),
    ]);
    await reloadWithPinnedSection(page);
    await expect(favoriteRowByName(page, MOCK_FAVORITE_A.model)).toBeVisible();
    await expect(pinnedRows(page)).toHaveCount(3);

    const secondChatFocus = pinnedConvoRow(page, secondTitle).getByRole('button').first();
    await secondChatFocus.focus();
    await secondChatFocus.press('Alt+ArrowUp');
    await expect
      .poll(() => pinnedRowNames(page))
      .toEqual([`${MOCK_FAVORITE_A.model} (Model)`, secondTitle, firstTitle]);
    await expect(pinnedSection(page).getByRole('status')).toHaveText('Moved to position 1 of 2');
  });

  test('a stored interleaved pinned order loads grouped @scenario:a-stored-interleaved-pinned-order-loads-grouped', async ({
    page,
  }) => {
    const [firstTitle, secondTitle] = uniqueTitles('stored-interleave', 2);
    seededPins = await seedPinnedConversations([firstTitle, secondTitle]);

    await openWithPinnedSection(page);
    await setFavorites(page, [MOCK_FAVORITE_A]);
    /** A pre-grouping order is the persisted bug: if read literally, each row is
     * walled in by a different kind and can no longer swap with its neighbours. */
    await setPinnedOrder(page, [
      convoEntryKey(seededPins[0].conversationId),
      favoriteEntryKey(MOCK_FAVORITE_A),
      convoEntryKey(seededPins[1].conversationId),
    ]);
    await reloadWithPinnedSection(page);

    await expect(favoriteRowByName(page, MOCK_FAVORITE_A.model)).toBeVisible();
    await expect(pinnedRows(page)).toHaveCount(3);
    expect(await pinnedRowKinds(page)).toEqual(['favorite', 'convo', 'convo']);
    expect(await pinnedRowNames(page)).toEqual([
      `${MOCK_FAVORITE_A.model} (Model)`,
      firstTitle,
      secondTitle,
    ]);
  });
});
