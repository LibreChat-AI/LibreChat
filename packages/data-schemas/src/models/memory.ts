import { Model } from 'mongoose';
import type { IMemoryEntry } from '~/types/memory';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import memorySchema from '~/schema/memory';

export function createMemoryModel(mongoose: typeof import('mongoose')): Model<IMemoryEntry> {
  applyTenantIsolation(memorySchema);
  return mongoose.models.MemoryEntry || mongoose.model<IMemoryEntry>('MemoryEntry', memorySchema);
}
