import { useMemo, useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import type { TToolFavorite, TToolFavoriteType } from 'librechat-data-provider';
import {
  useGetToolFavoritesQuery,
  useAddToolFavoriteMutation,
  useRemoveToolFavoriteMutation,
} from '~/data-provider';
import { getFavoritesErrorMessage, logger } from '~/utils';
import useLocalize from './useLocalize';

export const MAX_TOOL_FAVORITES = 100;

const EMPTY_FAVORITES: TToolFavorite[] = [];

interface FavoritableItem {
  kind: string;
  id: string;
}

const toFavorite = (item: FavoritableItem): TToolFavorite => ({
  itemType: item.kind as TToolFavoriteType,
  itemId: item.id,
});

/**
 * Favorites for marketplace items (built-in capabilities, plugin tools, MCP
 * servers, skills), persisted per user server-side. React Query is the source
 * of truth; `favoriteKeys` uses the marketplace `itemKey` format
 * (`kind:id`), so it plugs directly into the catalog filter context. Actions
 * are per-agent and not favoritable — `isFavorite`/`toggle` guard them.
 */
export default function useToolFavorites() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const getQuery = useGetToolFavoritesQuery();
  const addMutation = useAddToolFavoriteMutation();
  const removeMutation = useRemoveToolFavoriteMutation();

  const favorites = useMemo(
    () => (Array.isArray(getQuery.data) ? getQuery.data : EMPTY_FAVORITES),
    [getQuery.data],
  );

  const favoriteKeys = useMemo(
    () => new Set(favorites.map((f) => `${f.itemType}:${f.itemId}`)),
    [favorites],
  );

  const isFavorite = useCallback(
    (item: FavoritableItem): boolean =>
      item.kind !== 'action' && favoriteKeys.has(`${item.kind}:${item.id}`),
    [favoriteKeys],
  );

  const toggle = useCallback(
    async (item: FavoritableItem) => {
      if (item.kind === 'action') {
        return;
      }
      const favorite = toFavorite(item);
      const mutation = favoriteKeys.has(`${item.kind}:${item.id}`) ? removeMutation : addMutation;
      try {
        await mutation.mutateAsync(favorite);
      } catch (error) {
        logger.error('Error updating tool favorites:', error);
        showToast({
          message: getFavoritesErrorMessage(
            error,
            localize,
            MAX_TOOL_FAVORITES,
            'com_ui_max_favorites_reached_items',
          ),
          status: 'error',
        });
      }
    },
    [favoriteKeys, addMutation, removeMutation, showToast, localize],
  );

  return {
    favorites,
    favoriteKeys,
    isFavorite,
    toggle,
    isLoading: getQuery.isLoading,
    isError: getQuery.isError,
    isUpdating: addMutation.isLoading || removeMutation.isLoading,
  };
}
