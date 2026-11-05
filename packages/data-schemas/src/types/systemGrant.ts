import type { PrincipalType } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';
import type { SystemCapability } from '~/types/admin';

export type SystemGrant = {
  /** The type of principal — matches PrincipalType enum values */
  principalType: PrincipalType;
  /** ObjectId string for user/group, role name string for role */
  principalId: string | Types.ObjectId;
  /** The capability being granted */
  capability: SystemCapability;
  /** Absent = platform-operator, present = tenant-scoped */
  tenantId?: string;
  /** ID of the user who granted this capability */
  grantedBy?: Types.ObjectId;
  /** When this capability was granted */
  grantedAt?: Date;
  /** Reserved for future TTL enforcement — time-bounded / temporary grants. */
  expiresAt?: Date;
};

export type ISystemGrant = SystemGrant &
  Document & {
    _id: Types.ObjectId;
  };

/**
 * What `moveGrantsToPrincipal` changed, as the grants were before it: the grants it re-keyed to
 * the new principal, and the ones it removed because the new principal already held the same
 * capability in the same tenant scope. `restoreMovedGrants` undoes exactly these.
 */
export type SystemGrantMove = {
  moved: ISystemGrant[];
  superseded: ISystemGrant[];
};
