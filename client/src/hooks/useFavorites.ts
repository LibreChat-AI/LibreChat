import { useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { useToastContext } from '@librechat/client';
import { useIsMutating } from '@tanstack/react-query';
import { MutationKeys } from 'librechat-data-provider';
import type { Favorite } from '~/store/favorites';
import { useGetFavoritesQuery, useUpdateFavoritesMutation } from '~/data-provider';
import { favoritesAtom } from '~/store';
import { useLocalize } from '~/hooks';
import { logger } from '~/utils';

/** Maximum number of favorites allowed (must match backend MAX_FAVORITES) */
const MAX_FAVORITES = 50;

/**
 * Hook for managing user favorites (pinned agents, models, and model specs).
 *
 * Favorites are synchronized with the server via `/api/user/settings/favorites`.
 * Each favorite is either:
 * - An agent: `{ agentId: string }`
 * - A model: `{ model: string, endpoint: string }`
 * - A model spec: `{ spec: string }`
 *
 * @returns Object containing favorites state and helper methods for
 * adding, removing, toggling, reordering, and checking favorites.
 */

/**
 * Cleans favorites array to only include canonical shapes (agentId, model+endpoint, or spec).
 */
const cleanFavorites = (favorites: Favorite[]): Favorite[] => {
  if (!Array.isArray(favorites)) {
    return [];
  }
  return favorites
    .map((f) => {
      if (f.agentId) {
        return { agentId: f.agentId };
      }
      if (f.model && f.endpoint) {
        return { model: f.model, endpoint: f.endpoint };
      }
      if (f.spec) {
        return { spec: f.spec };
      }
      return null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
};

export default function useFavorites() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [favorites, setFavorites] = useAtom(favoritesAtom);
  const getFavoritesQuery = useGetFavoritesQuery();
  const updateFavoritesMutation = useUpdateFavoritesMutation();

  const writesInFlight = useIsMutating([MutationKeys.updateFavorites]);

  useEffect(() => {
    if (writesInFlight > 0) {
      return;
    }
    if (getFavoritesQuery.data) {
      if (Array.isArray(getFavoritesQuery.data)) {
        setFavorites(getFavoritesQuery.data);
      } else {
        setFavorites([]);
      }
    }
  }, [getFavoritesQuery.data, setFavorites, writesInFlight]);

  const getErrorMessage = useCallback(
    (error: unknown): string => {
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response?: { data?: { code?: string; limit?: number } };
        };
        const { code, limit } = axiosError.response?.data ?? {};

        if (code === 'MAX_FAVORITES_EXCEEDED') {
          return localize('com_ui_max_favorites_reached', { 0: String(limit ?? MAX_FAVORITES) });
        }
      }
      return localize('com_ui_error');
    },
    [localize],
  );

  const saveFavorites = useCallback(
    async (newFavorites: typeof favorites) => {
      const cleaned = cleanFavorites(newFavorites);
      setFavorites(cleaned);
      try {
        await updateFavoritesMutation.mutateAsync(cleaned);
      } catch (error) {
        logger.error('Error updating favorites:', error);
        showToast({ message: getErrorMessage(error), status: 'error' });
        void getFavoritesQuery.refetch();
      }
    },
    [setFavorites, updateFavoritesMutation, showToast, getErrorMessage, getFavoritesQuery],
  );

  const addFavoriteAgent = (agentId: string) => {
    if (favorites.some((f) => f.agentId === agentId)) return;
    const newFavorites = [...favorites, { agentId }];
    saveFavorites(newFavorites);
  };

  const removeFavoriteAgent = (agentId: string) => {
    const newFavorites = favorites.filter((f) => f.agentId !== agentId);
    saveFavorites(newFavorites);
  };

  const addFavoriteModel = (model: { model: string; endpoint: string }) => {
    if (favorites.some((f) => f.model === model.model && f.endpoint === model.endpoint)) return;
    const newFavorites = [...favorites, { model: model.model, endpoint: model.endpoint }];
    saveFavorites(newFavorites);
  };

  const removeFavoriteModel = (model: string, endpoint: string) => {
    const newFavorites = favorites.filter((f) => !(f.model === model && f.endpoint === endpoint));
    saveFavorites(newFavorites);
  };

  const isFavoriteAgent = (agentId: string | undefined | null) => {
    if (!agentId) {
      return false;
    }
    return favorites.some((f) => f.agentId === agentId);
  };

  const isFavoriteModel = (model: string, endpoint: string) => {
    return favorites.some((f) => f.model === model && f.endpoint === endpoint);
  };

  const addFavoriteSpec = (spec: string) => {
    if (favorites.some((f) => f.spec === spec)) {
      return;
    }
    const newFavorites = [...favorites, { spec }];
    saveFavorites(newFavorites);
  };

  const removeFavoriteSpec = (spec: string) => {
    const newFavorites = favorites.filter((f) => f.spec !== spec);
    saveFavorites(newFavorites);
  };

  const isFavoriteSpec = (spec: string | undefined | null) => {
    if (!spec) {
      return false;
    }
    return favorites.some((f) => f.spec === spec);
  };

  const toggleFavoriteSpec = (spec: string) => {
    if (isFavoriteSpec(spec)) {
      removeFavoriteSpec(spec);
    } else {
      addFavoriteSpec(spec);
    }
  };

  const toggleFavoriteAgent = (agentId: string) => {
    if (isFavoriteAgent(agentId)) {
      removeFavoriteAgent(agentId);
    } else {
      addFavoriteAgent(agentId);
    }
  };

  const toggleFavoriteModel = (model: { model: string; endpoint: string }) => {
    if (isFavoriteModel(model.model, model.endpoint)) {
      removeFavoriteModel(model.model, model.endpoint);
    } else {
      addFavoriteModel(model);
    }
  };

  /**
   * Reorder favorites and optionally persist the new order to the server.
   * This combines state update and persistence to avoid race conditions
   * where the closure captures stale state.
   */
  const reorderFavorites = useCallback(
    async (newFavorites: typeof favorites, persist = false) => {
      if (persist) {
        await saveFavorites(newFavorites);
      } else {
        setFavorites(cleanFavorites(newFavorites));
      }
    },
    [setFavorites, saveFavorites],
  );

  return {
    favorites,
    addFavoriteAgent,
    removeFavoriteAgent,
    addFavoriteModel,
    removeFavoriteModel,
    addFavoriteSpec,
    removeFavoriteSpec,
    isFavoriteAgent,
    isFavoriteModel,
    isFavoriteSpec,
    toggleFavoriteAgent,
    toggleFavoriteModel,
    toggleFavoriteSpec,
    reorderFavorites,
    /** Whether the favorites query is currently loading */
    isLoading: getFavoritesQuery.isLoading,
    /** Whether the favorites list was actually retrieved. Not the inverse of
     *  `isLoading`: an exhausted retry leaves loading false with no data. */
    isSuccess: getFavoritesQuery.isSuccess,
    /** Ready for membership-based pruning only after the atom absorbs the
     *  settled query value, including a rollback with structurally shared data. */
    isLoaded:
      getFavoritesQuery.isSuccess &&
      writesInFlight === 0 &&
      !getFavoritesQuery.isFetching &&
      favorites === getFavoritesQuery.data,
    /** True while the list is being refetched, including the refetch that
     *  recovers from a failed write. */
    isFetching: getFavoritesQuery.isFetching,
    dataUpdatedAt: getFavoritesQuery.dataUpdatedAt,
    /** Whether there was an error fetching favorites */
    isError: getFavoritesQuery.isError,
    /** Whether the update mutation is in progress */
    isUpdating: updateFavoritesMutation.isLoading,
    /** Error from fetching favorites, if any */
    fetchError: getFavoritesQuery.error,
    /** Error from updating favorites, if any */
    updateError: updateFavoritesMutation.error,
  };
}
