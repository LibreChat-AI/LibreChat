import type { Types, Document } from 'mongoose';

export const FAVORITE_ITEM_TYPES = ['builtin', 'tool', 'mcp', 'skill'] as const;

export type FavoriteItemType = (typeof FAVORITE_ITEM_TYPES)[number];

export interface IToolFavorite extends Document {
  user: Types.ObjectId;
  itemType: FavoriteItemType;
  itemId: string;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IToolFavoriteLean {
  itemType: FavoriteItemType;
  itemId: string;
}

export interface ToolFavoriteParams {
  userId: string | Types.ObjectId;
  itemType: FavoriteItemType;
  itemId: string;
}

export interface AddToolFavoriteResult {
  ok: boolean;
  added: boolean;
}

export interface RemoveToolFavoriteResult {
  ok: boolean;
  removed: boolean;
}
