import type { Model } from 'mongoose';
import type * as t from '~/types';
import auditLogSchema from '~/schema/auditLog';

/**
 * AuditLog is an append-only, hash-chained compliance record.
 *
 * Like SystemGrant, the tenant-isolation plugin is intentionally not applied:
 * every query is scoped by `chainKey` (the JWT-resolved tenantId, or the
 * platform sentinel for admin operations outside any tenant), which is also the
 * serialization key for the per-tenant hash chain.
 */
export function createAuditLogModel(mongoose: typeof import('mongoose')): Model<t.IAuditLog> {
  return mongoose.models.AuditLog || mongoose.model<t.IAuditLog>('AuditLog', auditLogSchema);
}
