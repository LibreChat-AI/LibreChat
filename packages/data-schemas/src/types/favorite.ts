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

export interface ToolFavoriteMethods {
  getToolFavorites(userId: string): Promise<IToolFavoriteLean[]>;
  addToolFavorite(params: ToolFavoriteParams): Promise<AddToolFavoriteResult>;
  removeToolFavorite(params: ToolFavoriteParams): Promise<RemoveToolFavoriteResult>;
  deleteUserToolFavorites(userId: string, deletionAttemptId?: string): Promise<number>;
  cancelUserToolFavoriteDeletion?(userId: string, deletionAttemptId: string): Promise<void>;
}
