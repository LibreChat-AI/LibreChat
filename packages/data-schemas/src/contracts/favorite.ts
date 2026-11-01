/* eslint-disable jest/no-export -- Shared behavioral suite, invoked by each engine's spec. */
import type { ToolFavoriteMethods } from '~/methods/favorite';
import type { ToolFavoriteParams } from '~/types/favorite';

type FavoriteParams = Omit<ToolFavoriteParams, 'userId'> & { userId: string };

/** The application-facing subset: no documents, queries, sessions, or engine IDs. */
export interface FavoriteContract {
  getToolFavorites(userId: string): ReturnType<ToolFavoriteMethods['getToolFavorites']>;
  addToolFavorite(params: FavoriteParams): ReturnType<ToolFavoriteMethods['addToolFavorite']>;
  removeToolFavorite(params: FavoriteParams): ReturnType<ToolFavoriteMethods['removeToolFavorite']>;
  deleteUserToolFavorites(userId: string): Promise<number>;
}

export interface FavoriteHarness {
  readonly name: string;
  readonly users: readonly [string, string];
  setup(): Promise<FavoriteContract>;
  teardown(): Promise<void>;
  reset(): Promise<void>;
  /** Seed timestamps without depending on the clock or the database's insertion order. */
  seed(favorites: readonly (FavoriteParams & { createdAt?: Date })[]): Promise<void>;
  inTenant<T>(tenantId: string, operation: () => Promise<T>): Promise<T>;
  /** Fail the next persistence operation, not the public method under test. */
  failNext(operation: 'read' | 'insert' | 'remove' | 'erase', error: Error): void;
}

export function describeFavoriteConformance(harness: FavoriteHarness): void {
  describe(`favorites contract: ${harness.name}`, () => {
    let methods: FavoriteContract;
    const [userA, userB] = harness.users;
    const favorite: FavoriteParams = { userId: userA, itemType: 'tool', itemId: 'shared' };

    beforeAll(async () => {
      methods = await harness.setup();
    });
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    it('returns an empty list for a user without favorites', async () => {
      expect(await methods.getToolFavorites(userA)).toEqual([]);
    });

    it.each(['builtin', 'tool', 'mcp', 'skill'] as const)(
      'persists a %s favorite and returns only its public fields',
      async (itemType) => {
        expect(await methods.addToolFavorite({ ...favorite, itemType })).toEqual({
          ok: true,
          added: true,
        });
        expect(await methods.getToolFavorites(userA)).toEqual([{ itemType, itemId: 'shared' }]);
      },
    );

    it('re-adding a favorite is a no-op', async () => {
      await methods.addToolFavorite(favorite);
      expect(await methods.addToolFavorite(favorite)).toEqual({ ok: true, added: false });
      expect(await methods.getToolFavorites(userA)).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
    });

    it('identifies favorites by user, kind, and item ID', async () => {
      await methods.addToolFavorite(favorite);
      await methods.addToolFavorite({ ...favorite, itemType: 'skill' });
      await methods.addToolFavorite({ ...favorite, itemId: 'other' });
      await methods.addToolFavorite({ ...favorite, userId: userB });

      expect(await methods.getToolFavorites(userB)).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
      const found = await methods.getToolFavorites(userA);
      expect(found).toHaveLength(3);
      expect(found).toEqual(
        expect.arrayContaining([
          { itemType: 'tool', itemId: 'shared' },
          { itemType: 'skill', itemId: 'shared' },
          { itemType: 'tool', itemId: 'other' },
        ]),
      );
    });

    it('lists by creation time, not insertion order, without reordering a re-add', async () => {
      await harness.seed([
        { ...favorite, itemId: 'newer', createdAt: new Date('2026-02-02T00:00:00Z') },
        { ...favorite, itemId: 'older', createdAt: new Date('2026-02-01T00:00:00Z') },
      ]);
      await methods.addToolFavorite({ ...favorite, itemId: 'older' });
      expect(await methods.getToolFavorites(userA)).toEqual([
        { itemType: 'tool', itemId: 'older' },
        { itemType: 'tool', itemId: 'newer' },
      ]);
    });

    it('accepts an item ID at the maximum length', async () => {
      const itemId = 'x'.repeat(256);
      expect(await methods.addToolFavorite({ ...favorite, itemId })).toEqual({
        ok: true,
        added: true,
      });
      expect(await methods.getToolFavorites(userA)).toEqual([{ itemType: 'tool', itemId }]);
    });

    it.each([
      { itemType: 'agent' as never, itemId: 'invalid-kind' },
      { itemType: 'tool' as const, itemId: '' },
      { itemType: 'tool' as const, itemId: 'x'.repeat(257) },
    ])('rejects invalid input without persisting it: %j', async (input) => {
      await expect(methods.addToolFavorite({ ...favorite, ...input })).rejects.toThrow();
      expect(await methods.getToolFavorites(userA)).toEqual([]);
    });

    it('allows the last slot, rejects beyond 100, and permits re-adds at the cap', async () => {
      await harness.seed(
        Array.from({ length: 99 }, (_, i) => ({ ...favorite, itemId: `tool-${i}` })),
      );
      await harness.seed(
        Array.from({ length: 100 }, (_, i) => ({
          ...favorite,
          userId: userB,
          itemId: `other-${i}`,
        })),
      );
      expect(await methods.addToolFavorite(favorite)).toEqual({ ok: true, added: true });
      await expect(
        methods.addToolFavorite({ ...favorite, itemId: 'overflow' }),
      ).rejects.toMatchObject({
        code: 'MAX_FAVORITES_EXCEEDED',
        message: 'Maximum of 100 favorites reached',
        limit: 100,
      });
      expect(await methods.addToolFavorite(favorite)).toEqual({ ok: true, added: false });
      expect(await methods.getToolFavorites(userA)).toHaveLength(100);
    });

    it('concurrent duplicate adds succeed and persist a single favorite', async () => {
      const results = await Promise.all(
        Array.from({ length: 3 }, () => methods.addToolFavorite(favorite)),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      // Concurrent callers need not agree on `added`; only the persisted identity is unique.
      expect(await methods.getToolFavorites(userA)).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
    });

    it('removes only the requested user, kind, and item, and reports a repeat as a no-op', async () => {
      await harness.seed([
        favorite,
        { ...favorite, itemType: 'skill' },
        { ...favorite, itemId: 'other' },
        { ...favorite, userId: userB },
      ]);
      expect(await methods.removeToolFavorite(favorite)).toEqual({ ok: true, removed: true });
      expect(await methods.removeToolFavorite(favorite)).toEqual({ ok: true, removed: false });
      expect(await methods.getToolFavorites(userB)).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
      const remaining = await methods.getToolFavorites(userA);
      expect(remaining).toHaveLength(2);
      expect(remaining).toEqual(
        expect.arrayContaining([
          { itemType: 'skill', itemId: 'shared' },
          { itemType: 'tool', itemId: 'other' },
        ]),
      );
    });

    it('erases all favorites for one user and returns the deletion count', async () => {
      await harness.seed([
        favorite,
        { ...favorite, itemType: 'skill' },
        { ...favorite, userId: userB },
      ]);
      expect(await methods.deleteUserToolFavorites(userA)).toBe(2);
      expect(await methods.deleteUserToolFavorites(userA)).toBe(0);
      expect(await methods.getToolFavorites(userA)).toEqual([]);
      expect(await methods.getToolFavorites(userB)).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
    });

    it('cannot read, remove, or erase another tenant’s favorites', async () => {
      await harness.inTenant('tenant-a', () => methods.addToolFavorite(favorite));
      await harness.inTenant('tenant-b', async () => {
        expect(await methods.getToolFavorites(userA)).toEqual([]);
        expect(await methods.removeToolFavorite(favorite)).toEqual({ ok: true, removed: false });
        expect(await methods.deleteUserToolFavorites(userA)).toBe(0);
      });
      expect(await harness.inTenant('tenant-a', () => methods.getToolFavorites(userA))).toEqual([
        { itemType: 'tool', itemId: 'shared' },
      ]);
    });

    it.each(['read', 'insert', 'remove', 'erase'] as const)(
      'propagates an operational %s failure instead of reporting success or absence',
      async (operation) => {
        const failure = new Error('persistence unavailable');
        harness.failNext(operation, failure);
        const action = {
          read: () => methods.getToolFavorites(userA),
          insert: () => methods.addToolFavorite(favorite),
          remove: () => methods.removeToolFavorite(favorite),
          erase: () => methods.deleteUserToolFavorites(userA),
        }[operation];
        await expect(action()).rejects.toBe(failure);
        expect(await methods.getToolFavorites(userA)).toEqual([]);
      },
    );
  });
}
