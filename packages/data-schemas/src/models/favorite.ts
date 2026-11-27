import { Model } from 'mongoose';
import type { IToolFavorite } from '~/types/favorite';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import toolFavoriteSchema from '~/schema/favorite';

export function createToolFavoriteModel(mongoose: typeof import('mongoose')): Model<IToolFavorite> {
  applyTenantIsolation(toolFavoriteSchema);
  return (
    mongoose.models.ToolFavorite ||
    mongoose.model<IToolFavorite>('ToolFavorite', toolFavoriteSchema)
  );
}
