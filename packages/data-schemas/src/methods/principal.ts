import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { isCanonicalObjectIdString } from '~/utils/objectId';

const systemRoleNames: ReadonlySet<string> = new Set(Object.values(SystemRoles));

/**
 * What principal resolution reads of a user (their role and external identity), and the tenant
 * that holds them (absent for a platform-level user).
 */
export interface PrincipalUser {
  id: string;
  role?: string;
  idOnTheSource?: string | null;
  tenantId?: string;
}

export interface PrincipalMethods {
  principalExists: (principalType: PrincipalType, principalId: string) => Promise<boolean>;
  findPrincipalUser: (userId: string) => Promise<PrincipalUser | null>;
}

/** Principal lookups for the admin API, in the caller's tenant partition or by id. */
export function createPrincipalMethods(mongoose: typeof import('mongoose')): PrincipalMethods {
  async function existsInPartition(
    modelName: 'Role' | 'Group' | 'User',
    filter: { name: string } | { _id: string },
  ): Promise<boolean> {
    const model = mongoose.models[modelName] as Model<{ name?: string; tenantId?: string }>;
    const found = await model
      .findOne({ ...filter, ...tenantPartitionFilter('principalExists') })
      .select('_id')
      .lean();
    return found != null;
  }

  /**
   * Whether a role (by its exact name), group or user (by ObjectId) exists in the caller's
   * tenant partition (`tenantPartitionFilter`): the active tenant's principals, or outside a
   * tenant only platform-level ones, never one that only some tenant holds. The system roles
   * always exist, since `getRoleByName` creates them on first use; this lookup creates nothing
   * and reads no cache. Any other type, or an id that cannot name a group or user, is `false`:
   * a group or user id must be canonical (lowercase hex, as `ObjectId#toString()` writes it),
   * because config documents and merges match the id as a string, and an uppercase spelling
   * that the database would still cast to the same ObjectId names a profile that never applies.
   */
  async function principalExists(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<boolean> {
    switch (principalType) {
      case PrincipalType.ROLE:
        return systemRoleNames.has(principalId) || existsInPartition('Role', { name: principalId });
      case PrincipalType.GROUP:
        return (
          isCanonicalObjectIdString(principalId) && existsInPartition('Group', { _id: principalId })
        );
      case PrincipalType.USER:
        return (
          isCanonicalObjectIdString(principalId) && existsInPartition('User', { _id: principalId })
        );
      default:
        return false;
    }
  }

  /**
   * A user the caller addresses by canonical ObjectId, with the fields principal resolution reads
   * (`getUserPrincipals`) and the tenant that holds them. Users are addressed by id the way their
   * config documents are: inside a tenant only that tenant's (the tenant plugin scopes the read),
   * and outside one any tenant's, so their profile resolves in their own tenant. Strict mode
   * refuses the read without a tenant context, as every query does. `null` when the caller sees
   * no such user, as for a user of another tenant inside a tenant.
   */
  async function findPrincipalUser(userId: string): Promise<PrincipalUser | null> {
    if (!isCanonicalObjectIdString(userId)) {
      return null;
    }
    const model = mongoose.models.User as Model<{
      role?: string;
      idOnTheSource?: string | null;
      tenantId?: string | null;
    }>;
    const user = await model.findOne({ _id: userId }).select('role idOnTheSource tenantId').lean();
    if (user == null) {
      return null;
    }
    return {
      id: userId,
      role: user.role,
      idOnTheSource: user.idOnTheSource ?? null,
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    };
  }

  return { principalExists, findPrincipalUser };
}
