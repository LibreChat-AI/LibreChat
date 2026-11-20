import { useMemo, useCallback } from 'react';
import type { TToolFavoriteType } from 'librechat-data-provider';
import useMarketplaceFavorites from '~/hooks/useToolFavorites';

export interface ToolFavorites {
  /** `${itemType}:${itemId}` keys, for O(1) membership tests while building
   *  the palette instead of scanning the favourites array per row. */
  keys: Set<string>;
  isFavorite: (itemType: TToolFavoriteType, itemId: string) => boolean;
  toggleFavorite: (itemType: TToolFavoriteType, itemId: string) => void;
}

export const favoriteKey = (itemType: TToolFavoriteType, itemId: string) => `${itemType}:${itemId}`;

/**
 * Server-persisted favourites for anything the composer palette can list:
 * built-in tools, plugin tools, MCP servers and skills.
 *
 * A shape adapter over the marketplace's own hook rather than a second copy of
 * it: the palette addresses items by type and id where the marketplace uses
 * `{ kind, id }`, and that was the whole difference. Going through it also
 * carries its error handling, so starring past the server's cap says so here
 * too instead of failing silently with the star left where it was.
 */
export default function useToolFavorites(): ToolFavorites {
  const { favoriteKeys, toggle } = useMarketplaceFavorites();

  const isFavorite = useCallback(
    (itemType: TToolFavoriteType, itemId: string) =>
      favoriteKeys.has(favoriteKey(itemType, itemId)),
    [favoriteKeys],
  );

  const toggleFavorite = useCallback(
    (itemType: TToolFavoriteType, itemId: string) => {
      void toggle({ kind: itemType, id: itemId });
    },
    [toggle],
  );

  return useMemo(
    () => ({ keys: favoriteKeys, isFavorite, toggleFavorite }),
    [favoriteKeys, isFavorite, toggleFavorite],
  );
}
