import { Model } from 'mongoose';
import type * as t from '~/types';
import systemGrantSchema from '~/schema/systemGrant';

/**
 * SystemGrant is a cross-tenant control plane — its query logic in systemGrant methods
 * explicitly handles tenantId conditions (platform-level vs tenant-scoped grants).
 * Do NOT apply tenant isolation plugin here; it would inject a hard tenantId equality
 * filter that conflicts with the $and/$or logic in hasCapabilityForPrincipals.
 */
export function createSystemGrantModel(mongoose: typeof import('mongoose')): Model<t.ISystemGrant> {
  return (
    mongoose.models.SystemGrant || mongoose.model<t.ISystemGrant>('SystemGrant', systemGrantSchema)
  );
}
