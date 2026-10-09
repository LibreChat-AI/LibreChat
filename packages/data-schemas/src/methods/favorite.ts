import type * as t from '~/types';

export const MAX_TOOL_FAVORITES = 100;

const DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY_ERROR
  );
}

function capError(): Error {
  const error = new Error(`Maximum of ${MAX_TOOL_FAVORITES} favorites reached`);
  (error as Error & { code: string; limit: number }).code = 'MAX_FAVORITES_EXCEEDED';
  (error as Error & { code: string; limit: number }).limit = MAX_TOOL_FAVORITES;
  return error;
}

export function createToolFavoriteMethods(mongoose: typeof import('mongoose')): {
  getToolFavorites: (userId: string) => Promise<t.IToolFavoriteLean[]>;
  addToolFavorite: (params: t.ToolFavoriteParams) => Promise<t.AddToolFavoriteResult>;
  removeToolFavorite: (params: t.ToolFavoriteParams) => Promise<t.RemoveToolFavoriteResult>;
} {
  async function getToolFavorites(userId: string): Promise<t.IToolFavoriteLean[]> {
    const ToolFavorite = mongoose.models.ToolFavorite;
    return ToolFavorite.find({ user: userId })
      .select('itemType itemId -_id')
      .sort({ createdAt: 1 })
      .lean<t.IToolFavoriteLean[]>();
  }

  /**
   * Idempotent add. The unique `{ user, itemType, itemId }` index is the
   * concurrency backstop: a duplicate-key rejection from a racing insert is
   * treated as success. The cap check is read-then-write and may transiently
   * overshoot by one or two under concurrency — acceptable for a soft UX cap.
   */
  async function addToolFavorite({
    userId,
    itemType,
    itemId,
  }: t.ToolFavoriteParams): Promise<t.AddToolFavoriteResult> {
    const ToolFavorite = mongoose.models.ToolFavorite;
    const filter = { user: userId, itemType, itemId };

    const existing = await ToolFavorite.exists(filter);
    if (existing != null) {
      return { ok: true, added: false };
    }

    const count = await ToolFavorite.countDocuments({ user: userId });
    if (count >= MAX_TOOL_FAVORITES) {
      throw capError();
    }

    try {
      await ToolFavorite.updateOne(
        filter,
        { $setOnInsert: filter },
        { upsert: true, runValidators: true },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
    return { ok: true, added: true };
  }

  async function removeToolFavorite({
    userId,
    itemType,
    itemId,
  }: t.ToolFavoriteParams): Promise<t.RemoveToolFavoriteResult> {
    const ToolFavorite = mongoose.models.ToolFavorite;
    const result = await ToolFavorite.deleteOne({ user: userId, itemType, itemId });
    return { ok: true, removed: result.deletedCount > 0 };
  }

  return {
    getToolFavorites,
    addToolFavorite,
    removeToolFavorite,
  };
}

export type ToolFavoriteMethods = ReturnType<typeof createToolFavoriteMethods>;
