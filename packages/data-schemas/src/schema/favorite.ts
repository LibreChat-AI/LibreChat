import { Schema } from 'mongoose';
import type { IToolFavorite } from '~/types/favorite';
import { FAVORITE_ITEM_TYPES } from '~/types/favorite';

const toolFavoriteSchema: Schema<IToolFavorite> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    itemType: {
      type: String,
      required: true,
      enum: FAVORITE_ITEM_TYPES,
    },
    itemId: {
      type: String,
      required: true,
      maxlength: 256,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

/**
 * One doc per (user, itemType, itemId): the unique index makes favorite/unfavorite
 * idempotent and race-free under concurrent toggles. It deliberately excludes
 * `tenantId` — user ObjectIds are globally unique, so the triple can never
 * legitimately collide across tenants, and tenant-scoped reads are still served
 * by this user-prefixed index.
 */
toolFavoriteSchema.index({ user: 1, itemType: 1, itemId: 1 }, { unique: true });

export default toolFavoriteSchema;
