import { logger, FAVORITE_ITEM_TYPES } from '@librechat/data-schemas';
import type {
  FavoriteItemType,
  IToolFavoriteLean,
  AddToolFavoriteResult,
  RemoveToolFavoriteResult,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

const MAX_ITEM_ID_LENGTH = 256;

/** Thin error shape `addToolFavorite` throws when the per-user cap is reached. */
type FavoriteCapError = Error & { code?: string; limit?: number };

export interface ToolFavoritesHandlersDeps {
  /** Tool favorite CRUD — from `@librechat/data-schemas` `createMethods` output. */
  getToolFavorites: (userId: string) => Promise<IToolFavoriteLean[]>;
  addToolFavorite: (params: {
    userId: string;
    itemType: FavoriteItemType;
    itemId: string;
  }) => Promise<AddToolFavoriteResult>;
  removeToolFavorite: (params: {
    userId: string;
    itemType: FavoriteItemType;
    itemId: string;
  }) => Promise<RemoveToolFavoriteResult>;
}

interface ValidatedParams {
  itemType: FavoriteItemType;
  itemId: string;
}

function validateParams(req: ServerRequest, res: Response): ValidatedParams | null {
  const { itemType, itemId } = req.params as { itemType?: string; itemId?: string };

  if (!FAVORITE_ITEM_TYPES.includes(itemType as FavoriteItemType)) {
    res.status(400).json({
      code: 'INVALID_ITEM_TYPE',
      message: `itemType must be one of: ${FAVORITE_ITEM_TYPES.join(', ')}`,
    });
    return null;
  }

  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > MAX_ITEM_ID_LENGTH) {
    res.status(400).json({
      code: 'INVALID_ITEM_ID',
      message: `itemId must be a non-empty string of at most ${MAX_ITEM_ID_LENGTH} characters`,
    });
    return null;
  }

  return { itemType: itemType as FavoriteItemType, itemId };
}

export function createToolFavoritesHandlers(deps: ToolFavoritesHandlersDeps): {
  listToolFavorites: (req: ServerRequest, res: Response) => Promise<Response>;
  addToolFavorite: (req: ServerRequest, res: Response) => Promise<Response>;
  removeToolFavorite: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  async function listToolFavorites(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
      const favorites = await deps.getToolFavorites(userId);
      return res.status(200).json(favorites);
    } catch (error) {
      logger.error('[ToolFavorites] Error listing favorites:', error);
      return res.status(500).json({ message: 'Failed to retrieve favorites' });
    }
  }

  async function addToolFavorite(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const params = validateParams(req, res);
    if (params == null) {
      return res;
    }
    try {
      await deps.addToolFavorite({ userId, ...params });
      return res.status(200).json(params);
    } catch (error) {
      const capError = error as FavoriteCapError;
      if (capError.code === 'MAX_FAVORITES_EXCEEDED') {
        return res.status(400).json({
          code: capError.code,
          message: capError.message,
          limit: capError.limit,
        });
      }
      logger.error('[ToolFavorites] Error adding favorite:', error);
      return res.status(500).json({ message: 'Failed to add favorite' });
    }
  }

  async function removeToolFavorite(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const params = validateParams(req, res);
    if (params == null) {
      return res;
    }
    try {
      await deps.removeToolFavorite({ userId, ...params });
      return res.status(200).json({ ok: true });
    } catch (error) {
      logger.error('[ToolFavorites] Error removing favorite:', error);
      return res.status(500).json({ message: 'Failed to remove favorite' });
    }
  }

  return {
    listToolFavorites,
    addToolFavorite,
    removeToolFavorite,
  };
}
