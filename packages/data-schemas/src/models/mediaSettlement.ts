import type { Model } from 'mongoose';
import type { MediaSettlementRecord } from '~/types/mediaAccounting';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import mediaSettlementSchema from '~/schema/mediaSettlement';

export function createMediaSettlementModel(
  mongoose: typeof import('mongoose'),
): Model<MediaSettlementRecord> {
  applyTenantIsolation(mediaSettlementSchema);
  return (
    mongoose.models.MediaSettlement ||
    mongoose.model<MediaSettlementRecord>('MediaSettlement', mediaSettlementSchema)
  );
}
