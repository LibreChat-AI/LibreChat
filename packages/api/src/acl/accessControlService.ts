import { Types } from 'mongoose';
import {
  createMethods,
  getTransactionSupport,
  logger,
  runAfterTransaction,
} from '@librechat/data-schemas';
import {
  CacheKeys,
  AccessRoleIds,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { AllMethods, IAclEntry } from '@librechat/data-schemas';
import type { ClientSession, DeleteResult } from 'mongoose';
import type { TPrincipal } from 'librechat-data-provider';
import type { PermissionChange, PermissionSnapshot } from './types';
import type { ResolvedPrincipal } from '~/types/principal';
import type { PermissionPlan } from './audit';
import { PERMISSION_AUDIT_UNAVAILABLE, RESOURCE_PERMISSIONS_UNAVAILABLE } from './codes';
import { getSafeErrorMetadata } from '~/utils/errors';
import { userPrincipalsCache } from '~/cache';

type BulkPrincipal = Omit<TPrincipal, 'id'> & {
  id?: string | Types.ObjectId;
  memberIds?: string[];
};

const ROLE_MASK =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

/**
 * One key for a principal, shared by the audit snapshot and the write filter so
 * both see the same row: ObjectId hex is case-folded and the public principal
 * has no id.
 */
const principalIdentity = (type: string, id: unknown): string => {
  if (type === PrincipalType.PUBLIC) {
    return `${type}:null`;
  }
  const raw = id == null ? '' : id.toString();
  const normalized =
    type !== PrincipalType.ROLE && Types.ObjectId.isValid(raw)
      ? new Types.ObjectId(raw).toString()
      : raw;
  return `${type}:${normalized}`;
};

/** A holder that crashes frees its lock after this long. */
const RESOURCE_LOCK_TTL_MS = 30_000;
const RESOURCE_LOCK_WAIT_MS = 3_000;
const RESOURCE_LOCK_POLL_MS = 50;

/** The lock store failed; a safe, retryable 503 instead of a raw driver error. */
export class ResourcePermissionsUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code: string = RESOURCE_PERMISSIONS_UNAVAILABLE;

  constructor() {
    super('Permissions for this resource cannot be updated right now, try again');
  }
}

export class ResourcePermissionsBusyError extends Error {
  readonly statusCode = 409;
  readonly code = 'RESOURCE_PERMISSIONS_BUSY';

  constructor() {
    super('Permissions for this resource are being updated, try again');
  }
}

const APPROVED_ERROR_CODES = new Set([
  'RESOURCE_PERMISSIONS_BUSY',
  PERMISSION_AUDIT_UNAVAILABLE,
  RESOURCE_PERMISSIONS_UNAVAILABLE,
]);

/** The approved machine-readable code of a failed permission update, for the HTTP error body. */
export const permissionErrorCode = (error: unknown): { code: string } | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && APPROVED_ERROR_CODES.has(code) ? { code } : undefined;
};

const snapshotOf = (
  entry?: Pick<IAclEntry, 'permBits' | 'roleId'> | null,
): PermissionSnapshot | null =>
  entry ? { permBits: entry.permBits, roleId: entry.roleId?.toString() ?? '' } : null;

export type BulkPermissionUpdateResult = {
  granted: BulkPrincipal[];
  updated: BulkPrincipal[];
  revoked: BulkPrincipal[];
  insightsChanges: PermissionChange[];
  /** Every grant, update and revoke, as the state before and after the write. */
  aclChanges: PermissionChange[];
  errors: Array<{ principal: BulkPrincipal; error: string }>;
};

export class AccessControlService {
  private _dbMethods: AllMethods;
  private _mongoose: typeof import('mongoose');
  private _transactionSupportCache: boolean | null = null;

  constructor(mongoose: typeof import('mongoose'), dbMethods?: AllMethods) {
    this._mongoose = mongoose;
    this._dbMethods =
      dbMethods ??
      createMethods(mongoose, {
        getCache: (key) => (key === CacheKeys.USER_PRINCIPALS ? userPrincipalsCache() : undefined),
      });
  }

  /**
   * Grant a permission to a principal for a resource using a role
   * @param {Object} params - Parameters for granting role-based permission
   * @param {string} params.principalType - PrincipalType.USER, PrincipalType.GROUP, or PrincipalType.PUBLIC
   * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for PrincipalType.PUBLIC)
   * @param {string} params.resourceType - Type of resource (e.g., 'agent')
   * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
   * @param {string} params.accessRoleId - The ID of the role (e.g., AccessRoleIds.AGENT_VIEWER, AccessRoleIds.AGENT_EDITOR)
   * @param {Types.ObjectId} params.grantedBy - User ID granting the permission
   * @param {ClientSession} [params.session] - Optional MongoDB session for transactions
   * @param {Date} [params.expiredAt] - Optional expiration for resource-tied permissions
   * @returns {Promise<IAclEntry>} The created or updated ACL entry
   */
  public async grantPermission(args: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId | null;
    resourceType: string;
    resourceId: string | Types.ObjectId;
    accessRoleId: AccessRoleIds;

    grantedBy?: string | Types.ObjectId;
    session?: ClientSession;
    roleId?: string | Types.ObjectId;
    expiredAt?: Date;
  }): Promise<IAclEntry | null> {
    const {
      principalType,
      principalId,
      resourceType,
      resourceId,
      accessRoleId,
      grantedBy,
      session,
      expiredAt,
    } = args;
    try {
      if (!Object.values(PrincipalType).includes(principalType)) {
        throw new Error(`Invalid principal type: ${principalType}`);
      }

      if (principalType !== PrincipalType.PUBLIC && !principalId) {
        throw new Error('Principal ID is required for user, group, and role principals');
      }

      // Validate principalId based on type
      if (principalId && principalType === PrincipalType.ROLE) {
        // Role IDs are strings (role names)
        if (typeof principalId !== 'string' || principalId.trim().length === 0) {
          throw new Error(`Invalid role ID: ${principalId}`);
        }
      } else if (
        principalType &&
        principalType !== PrincipalType.PUBLIC &&
        (!principalId || !Types.ObjectId.isValid(principalId))
      ) {
        // User and Group IDs must be valid ObjectIds
        throw new Error(`Invalid principal ID: ${principalId}`);
      }

      if (!resourceId || !Types.ObjectId.isValid(resourceId)) {
        throw new Error(`Invalid resource ID: ${resourceId}`);
      }

      this.validateResourceType(resourceType as ResourceType);

      // Get the role to determine permission bits
      const role = await this._dbMethods.findRoleByIdentifier(accessRoleId);
      if (!role) {
        throw new Error(`Role ${accessRoleId} not found`);
      }

      // Ensure the role is for the correct resource type
      if (role.resourceType !== resourceType) {
        throw new Error(
          `Role ${accessRoleId} is for ${role.resourceType} resources, not ${resourceType}`,
        );
      }
      return await this._dbMethods.grantPermission(
        principalType,
        principalId,
        resourceType,
        resourceId,
        role.permBits,
        grantedBy,
        session,
        role._id,
        expiredAt,
      );
    } catch (error) {
      logger.error(
        `[PermissionService.grantPermission] Error: ${error instanceof Error ? error.message : ''}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Find all resources of a specific type that a user has access to with specific permission bits
   * @param {Object} params - Parameters for finding accessible resources
   * @param {string | Types.ObjectId} params.userId - The ID of the user
   * @param {string} [params.role] - Optional user role (if not provided, will query from DB)
   * @param {string} params.resourceType - Type of resource (e.g., 'agent')
   * @param {number} params.requiredPermissions - The minimum permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
   * @param {Types.ObjectId[]} [params.resourceIds] - Optional candidate bound; only these
   *   resources are considered, so the query cost scales with the candidate set
   * @returns {Promise<Array>} Array of resource IDs
   */
  public async findAccessibleResources({
    userId,
    role,
    resourceType,
    requiredPermissions,
    resourceIds,
  }: {
    userId: string | Types.ObjectId;
    role?: string;
    resourceType: string;
    requiredPermissions: number;
    resourceIds?: Types.ObjectId[];
  }): Promise<Types.ObjectId[]> {
    try {
      const principalsList = await this.getUserPrincipals({ userId, role });
      return await this.findAccessibleResourcesForPrincipals({
        principalsList,
        resourceType,
        requiredPermissions,
        resourceIds,
      });
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PermissionService.findAccessibleResources] Error: ${error.message}`);
        // Re-throw validation errors
        if (error.message.includes('requiredPermissions must be')) {
          throw error;
        }
      }
      return [];
    }
  }

  public async getUserPrincipals({
    userId,
    role,
  }: {
    userId: string | Types.ObjectId;
    role?: string;
  }): Promise<ResolvedPrincipal[]> {
    return await this._dbMethods.getUserPrincipals({ userId, role });
  }

  public async findAccessibleResourcesForPrincipals({
    principalsList,
    resourceType,
    requiredPermissions,
    resourceIds,
  }: {
    principalsList: ResolvedPrincipal[];
    resourceType: string;
    requiredPermissions: number;
    resourceIds?: Types.ObjectId[];
  }): Promise<Types.ObjectId[]> {
    try {
      if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
        throw new Error('requiredPermissions must be a positive number');
      }

      this.validateResourceType(resourceType as ResourceType);

      if (principalsList.length === 0) {
        return [];
      }

      return await this._dbMethods.findAccessibleResources(
        principalsList,
        resourceType,
        requiredPermissions,
        resourceIds,
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error(
          `[PermissionService.findAccessibleResourcesForPrincipals] Error: ${error.message}`,
        );
        if (error.message.includes('requiredPermissions must be')) {
          throw error;
        }
      }
      return [];
    }
  }

  /**
   * Find all publicly accessible resources of a specific type
   * @param {Object} params - Parameters for finding publicly accessible resources
   * @param {ResourceType} params.resourceType - Type of resource (e.g., 'agent')
   * @param {number} params.requiredPermissions - The minimum permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
   * @param {Types.ObjectId[]} [params.resourceIds] - Optional candidate bound; only these
   *   resources are considered, so the query cost scales with the candidate set
   * @returns {Promise<Types.ObjectId[]>} Array of resource IDs
   */
  public async findPubliclyAccessibleResources({
    resourceType,
    requiredPermissions,
    resourceIds,
  }: {
    resourceType: ResourceType;
    requiredPermissions: number;
    resourceIds?: Types.ObjectId[];
  }): Promise<Types.ObjectId[]> {
    try {
      if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
        throw new Error('requiredPermissions must be a positive number');
      }

      this.validateResourceType(resourceType);

      return await this._dbMethods.findPublicResourceIds(
        resourceType,
        requiredPermissions,
        resourceIds,
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PermissionService.findPubliclyAccessibleResources] Error: ${error.message}`);
        // Re-throw validation errors
        if (error.message.includes('requiredPermissions must be')) {
          throw error;
        }
      }
      return [];
    }
  }

  /**
   * Get effective permissions for multiple resources in a batch operation
   * Returns map of resourceId → effectivePermissionBits
   *
   * @param {Object} params - Parameters
   * @param {string|mongoose.Types.ObjectId} params.userId - User ID
   * @param {string} [params.role] - User role (for group membership)
   * @param {string} params.resourceType - Resource type (must be valid ResourceType)
   * @param {Array<mongoose.Types.ObjectId>} params.resourceIds - Array of resource IDs
   * @returns {Promise<Map<string, number>>} Map of resourceId string → permission bits
   * @throws {Error} If resourceType is invalid
   */
  public async getResourcePermissionsMap({
    userId,
    role,
    resourceType,
    resourceIds,
  }: {
    userId: string | Types.ObjectId;
    role: string;
    resourceType: ResourceType;
    resourceIds: (string | Types.ObjectId)[];
  }): Promise<Map<string, number>> {
    // Validate resource type - throw on invalid type
    this.validateResourceType(resourceType);

    // Handle empty input
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
      return new Map();
    }

    let principals: ResolvedPrincipal[];
    try {
      principals = await this._dbMethods.getUserPrincipals({ userId, role });
    } catch (error) {
      if (error instanceof Error) {
        logger.error(
          `[PermissionService.getResourcePermissionsMap] Error resolving principals: ${error.message}`,
          error,
        );
      }
      throw error;
    }
    return await this.getResourcePermissionsMapForPrincipals({
      principalsList: principals,
      resourceType,
      resourceIds,
    });
  }

  public async getResourcePermissionsMapForPrincipals({
    principalsList,
    resourceType,
    resourceIds,
  }: {
    principalsList: ResolvedPrincipal[];
    resourceType: ResourceType;
    resourceIds: (string | Types.ObjectId)[];
  }): Promise<Map<string, number>> {
    this.validateResourceType(resourceType);
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
      return new Map();
    }

    try {
      const permissionsMap = await this._dbMethods.getEffectivePermissionsForResources(
        principalsList,
        resourceType,
        resourceIds,
      );

      logger.debug(
        `[PermissionService.getResourcePermissionsMapForPrincipals] Computed permissions for ${resourceIds.length} resources, ${permissionsMap.size} have permissions`,
      );

      return permissionsMap;
    } catch (error) {
      if (error instanceof Error) {
        logger.error(
          `[PermissionService.getResourcePermissionsMapForPrincipals] Error: ${error.message}`,
          error,
        );
      }
      throw error;
    }
  }

  /**
   * Remove all permissions for a resource (cleanup when resource is deleted)
   * @param {Object} params - Parameters for removing all permissions
   * @param {string} params.resourceType - Type of resource (e.g., 'agent', 'prompt')
   * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
   * @returns {Promise<DeleteResult>} Result of the deletion operation
   */
  public async removeAllPermissions({
    resourceType,
    resourceId,
  }: {
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }): Promise<DeleteResult> {
    try {
      this.validateResourceType(resourceType);

      if (!resourceId || !Types.ObjectId.isValid(resourceId)) {
        throw new Error(`Invalid resource ID: ${resourceId}`);
      }

      const result = await this._dbMethods.deleteAclEntries({
        resourceType,
        resourceId,
      });

      return result;
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PermissionService.removeAllPermissions] Error: ${error.message}`);
      }
      throw error;
    }
  }

  public async bulkUpdateResourcePermissions({
    resourceType,
    resourceId,
    updatedPrincipals = [],
    revokedPrincipals = [],
    grantedBy,
    session,
    maxWriteAttempts,
    leaseTtlMs = RESOURCE_LOCK_TTL_MS,
    leaseWaitMs = RESOURCE_LOCK_WAIT_MS,
    beforeWrite,
    afterWrite,
  }: {
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    updatedPrincipals?: BulkPrincipal[];
    revokedPrincipals?: BulkPrincipal[];
    grantedBy: string | Types.ObjectId;
    session?: ClientSession;
    maxWriteAttempts?: number;
    /** Per-resource lease lifetime between renewals, from `permissions.leaseTtlMs`. */
    leaseTtlMs?: number;
    /** Longest wait for a contended lease, from `permissions.leaseWaitMs`. */
    leaseWaitMs?: number;
    /** Called with the computed changes before any ACL write; a throw leaves the ACL untouched. */
    beforeWrite?: (plan: PermissionPlan) => Promise<void>;
    /** Runs after the write while the resource lease is still held; its failure never fails the update. */
    afterWrite?: () => Promise<void>;
  }): Promise<BulkPermissionUpdateResult> {
    const supportsTransactions = await getTransactionSupport(
      this._mongoose,
      this._transactionSupportCache,
    );
    this._transactionSupportCache = supportsTransactions;
    let localSession = session;
    let shouldEndSession = false;
    const rawResourceId = resourceId.toString();
    const lock = {
      key: `acl:${String(resourceType).toLowerCase()}:${
        Types.ObjectId.isValid(rawResourceId)
          ? new Types.ObjectId(rawResourceId).toString()
          : rawResourceId.toLowerCase()
      }`,
      ownerId: new Types.ObjectId().toString(),
    };
    let lockHeld = false;
    /** Keeps the lease alive through slow audit writes between fences. */
    let heartbeat: NodeJS.Timeout | undefined;

    try {
      if (!Array.isArray(updatedPrincipals)) {
        throw new Error('updatedPrincipals must be an array');
      }
      if (!Array.isArray(revokedPrincipals)) {
        throw new Error('revokedPrincipals must be an array');
      }
      if (!resourceId || !Types.ObjectId.isValid(resourceId)) {
        throw new Error(`Invalid resource ID: ${resourceId}`);
      }

      if (!supportsTransactions || (localSession && !localSession.inTransaction())) {
        /**
         * Without a transaction nothing else orders the audited read and the write, so a
         * per-resource lease serializes concurrent updates of the same resource.
         */
        const deadline = Date.now() + leaseWaitMs;
        const tryAcquire = () =>
          this._dbMethods
            .acquireResourceLock({
              ...lock,
              ttlMs: leaseTtlMs,
              readyWaitMs: Math.max(0, deadline - Date.now()),
            })
            .catch((error) => {
              logger.error('[AccessControlService.bulkUpdateResourcePermissions] Lock failed', {
                ...getSafeErrorMetadata(error),
              });
              throw new ResourcePermissionsUnavailableError();
            });
        while (!(lockHeld = await tryAcquire())) {
          if (Date.now() >= deadline) {
            throw new ResourcePermissionsBusyError();
          }
          await new Promise((resolve) => setTimeout(resolve, RESOURCE_LOCK_POLL_MS));
        }
      }
      if (lockHeld) {
        heartbeat = setInterval(
          () =>
            void this._dbMethods
              .renewResourceLock({ ...lock, ttlMs: leaseTtlMs })
              .catch(() => undefined),
          leaseTtlMs / 3,
        );
      }
      if (!localSession && supportsTransactions) {
        localSession = await this._mongoose.startSession();
        localSession.startTransaction();
        shouldEndSession = true;
      }
      const sessionOptions = localSession ? { session: localSession } : {};
      const queryPrincipalId = (principal: BulkPrincipal) => {
        if (principal.type === PrincipalType.ROLE) {
          if (typeof principal.id !== 'string' || principal.id.trim().length === 0) {
            throw new Error(`Invalid role ID: ${principal.id}`);
          }
          return principal.id;
        }
        const id = principal.id?.toString();
        if (!id || !Types.ObjectId.isValid(id)) {
          throw new Error(`Invalid principal ID: ${principal.id}`);
        }
        return new Types.ObjectId(id);
      };
      const affectedPrincipals: Array<{
        principalType: string;
        principalId?: string | Types.ObjectId;
      }> = [];
      for (const principal of [...updatedPrincipals, ...revokedPrincipals]) {
        if (!principal?.type) continue;
        try {
          affectedPrincipals.push({
            principalType: principal.type,
            ...(principal.type !== PrincipalType.PUBLIC && {
              principalId: queryPrincipalId(principal),
            }),
          });
        } catch {
          /** An invalid id is reported per principal below. */
        }
      }
      const [roles, currentEntries] = await Promise.all([
        this._dbMethods.findRolesByResourceType(resourceType),
        affectedPrincipals.length > 0
          ? this._dbMethods.findEntriesByPrincipalsAndResource(
              affectedPrincipals,
              resourceType,
              resourceId,
              localSession,
              true,
            )
          : Promise.resolve([]),
      ]);
      const rolesMap = new Map(roles.map((role) => [role.accessRoleId, role]));
      const results: BulkPermissionUpdateResult = {
        granted: [],
        updated: [],
        revoked: [],
        insightsChanges: [],
        aclChanges: [],
        errors: [],
      };
      const bulkWrites: Parameters<AllMethods['bulkWriteAclEntries']>[0] = [];
      /** Role-only edits go through the atomic guarded write, not this batch. */
      const roleBitsWrites: Parameters<AllMethods['replaceRoleBits']>[0] = [];

      const updatedPrincipalKey = (principal: BulkPrincipal | null | undefined) => {
        if (!principal?.type) return null;
        if (principal.type === PrincipalType.PUBLIC) return principalIdentity(principal.type, null);
        return principal.id == null ? null : principalIdentity(principal.type, principal.id);
      };
      const lastUpdateIndexByPrincipal = new Map<string, number>();
      updatedPrincipals.forEach((principal, index) => {
        const key = updatedPrincipalKey(principal);
        if (key != null) lastUpdateIndexByPrincipal.set(key, index);
      });
      /** An explicit public disable wins over a public update in the same request. */
      const revokesPublic = revokedPrincipals.some(
        (principal) => principal?.type === PrincipalType.PUBLIC,
      );
      const effectiveUpdatedPrincipals = updatedPrincipals.filter((principal, index) => {
        if (revokesPublic && principal?.type === PrincipalType.PUBLIC) {
          return false;
        }
        const key = updatedPrincipalKey(principal);
        return key == null || lastUpdateIndexByPrincipal.get(key) === index;
      });

      /**
       * A grant wins when the same non-public principal is also in the revoke list. The client can
       * produce both forms when `id` and `idOnTheSource` differ, and applying the revoke would remove
       * the permission just written. Public access is excluded because an explicit disable must win.
       */
      const grantedPrincipalKeys = new Set<string>();
      const principalKey = (principal: BulkPrincipal) =>
        principalIdentity(principal.type, principal.id);
      const currentEntriesByPrincipal = new Map<string, Pick<IAclEntry, 'permBits' | 'roleId'>>();
      for (const entry of currentEntries) {
        const key = principalIdentity(entry.principalType, entry.principalId);
        const current = currentEntriesByPrincipal.get(key);
        const entryHasInsights =
          (entry.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS;
        const currentHasInsights =
          current != null &&
          (current.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS;
        /** Duplicate rows are audited as their combined permissions. */
        const combinedBits = (current?.permBits ?? 0) | entry.permBits;
        if (!current || (entryHasInsights && !currentHasInsights)) {
          currentEntriesByPrincipal.set(key, { roleId: entry.roleId, permBits: combinedBits });
        } else {
          currentEntriesByPrincipal.set(key, { roleId: current.roleId, permBits: combinedBits });
        }
      }

      for (const principal of effectiveUpdatedPrincipals) {
        try {
          if (!principal?.accessRoleId) {
            results.errors.push({
              principal,
              error: 'accessRoleId is required for updated principals',
            });
            continue;
          }
          const role = rolesMap.get(principal.accessRoleId);
          if (!role) {
            results.errors.push({
              principal,
              error: `Role ${principal.accessRoleId} not found`,
            });
            continue;
          }

          const query: Record<string, unknown> = {
            principalType: principal.type,
            resourceType,
            resourceId,
          };
          if (principal.type !== PrincipalType.PUBLIC) {
            query.principalId = queryPrincipalId(principal);
          }

          const existingEntry = currentEntriesByPrincipal.get(
            principalIdentity(principal.type, principal.id),
          );
          const hadInsights =
            resourceType === ResourceType.AGENT &&
            ((existingEntry?.permBits ?? 0) & PermissionBits.VIEW_INSIGHTS) ===
              PermissionBits.VIEW_INSIGHTS;
          const roleCanView = (role.permBits & PermissionBits.VIEW) === PermissionBits.VIEW;
          const requestedInsights =
            typeof principal.viewInsights === 'boolean' ? principal.viewInsights : undefined;
          const preserveInsights =
            resourceType === ResourceType.AGENT &&
            principal.type !== PrincipalType.PUBLIC &&
            roleCanView &&
            requestedInsights === undefined;
          const wantsInsights =
            resourceType === ResourceType.AGENT &&
            principal.type !== PrincipalType.PUBLIC &&
            roleCanView &&
            (requestedInsights === undefined ? hadInsights : requestedInsights);
          const permBits = wantsInsights
            ? role.permBits | PermissionBits.VIEW_INSIGHTS
            : role.permBits & ~PermissionBits.VIEW_INSIGHTS;
          const grantedAt = new Date();
          const principalModelMap: Partial<Record<PrincipalType, PrincipalModel>> = {
            [PrincipalType.USER]: PrincipalModel.USER,
            [PrincipalType.GROUP]: PrincipalModel.GROUP,
            [PrincipalType.ROLE]: PrincipalModel.ROLE,
          };
          const update = {
            $set: {
              ...(!preserveInsights && { permBits }),
              roleId: role._id,
              grantedBy,
              grantedAt,
            },
            $setOnInsert: {
              principalType: principal.type,
              resourceType,
              resourceId,
              ...(principal.type !== PrincipalType.PUBLIC && {
                principalId: queryPrincipalId(principal),
                principalModel: principalModelMap[principal.type],
              }),
            },
          };
          /** `replaceRoleBits` swaps only the role mask and keeps every other stored bit. */
          const writtenBits = preserveInsights
            ? ((existingEntry?.permBits ?? 0) & ~ROLE_MASK) | (role.permBits & ROLE_MASK)
            : permBits;
          if (preserveInsights) {
            roleBitsWrites.push({
              filter: query,
              insert: update.$setOnInsert,
              roleBits: role.permBits,
              metadata: update.$set,
            });
          } else {
            bulkWrites.push({
              updateMany: { filter: query, update, upsert: true },
            });
          }
          results.granted.push({
            type: principal.type,
            id: principal.id,
            name: principal.name,
            email: principal.email,
            source: principal.source,
            avatar: principal.avatar,
            description: principal.description,
            idOnTheSource: principal.idOnTheSource,
            accessRoleId: principal.accessRoleId,
            memberCount: principal.memberCount,
            memberIds: principal.memberIds,
            ...(resourceType === ResourceType.AGENT ? { viewInsights: wantsInsights } : {}),
          });
          const aclChange: PermissionChange = {
            action: 'assigned',
            principal: { type: principal.type, id: principal.id?.toString() ?? null },
            previous: snapshotOf(existingEntry),
            written: { permBits: writtenBits, roleId: role._id.toString() },
          };
          results.aclChanges.push(aclChange);
          if (hadInsights !== wantsInsights) {
            results.insightsChanges.push({
              ...aclChange,
              action: wantsInsights ? 'assigned' : 'removed',
            });
          }
          if (principal.type !== PrincipalType.PUBLIC) {
            grantedPrincipalKeys.add(principalKey(principal));
          }
        } catch (error) {
          results.errors.push({
            principal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const revokeQueries: Array<{
        principal: BulkPrincipal;
        query: Record<string, unknown> | null;
      }> = [];
      const plannedRevokes = new Set<string>();
      for (const principal of revokedPrincipals) {
        try {
          if (principal?.type) {
            const identity = principalIdentity(principal.type, principal.id);
            if (plannedRevokes.has(identity)) {
              continue;
            }
            plannedRevokes.add(identity);
          }
          if (
            principal?.type !== PrincipalType.PUBLIC &&
            principal != null &&
            grantedPrincipalKeys.has(principalKey(principal))
          ) {
            continue;
          }
          const query: Record<string, unknown> = {
            principalType: principal.type,
            resourceType,
            resourceId,
          };
          if (principal.type !== PrincipalType.PUBLIC) {
            query.principalId = queryPrincipalId(principal);
          }
          const existingEntry = currentEntriesByPrincipal.get(
            principalIdentity(principal.type, principal.id),
          );
          if (!existingEntry) {
            /** Nothing was audited for it; deleting a row that appeared since the read would be unaudited. */
            revokeQueries.push({ principal, query: null });
            continue;
          }
          revokeQueries.push({ principal, query });
          const change: PermissionChange = {
            action: 'removed',
            principal: { type: principal.type, id: principal.id?.toString() ?? null },
            previous: snapshotOf(existingEntry),
            written: null,
          };
          results.aclChanges.push(change);
          if (
            resourceType === ResourceType.AGENT &&
            (existingEntry.permBits & PermissionBits.VIEW_INSIGHTS) === PermissionBits.VIEW_INSIGHTS
          ) {
            results.insightsChanges.push(change);
          }
        } catch (error) {
          results.errors.push({
            principal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (beforeWrite && (results.aclChanges.length > 0 || results.insightsChanges.length > 0)) {
        await beforeWrite({
          aclChanges: results.aclChanges,
          insightsChanges: results.insightsChanges,
        });
      }

      /** Re-validates and extends the lease before each write; a lost lease writes nothing more. */
      const fence = async () => {
        if (!lockHeld) {
          return;
        }
        const renewed = await this._dbMethods
          .renewResourceLock({ ...lock, ttlMs: leaseTtlMs })
          .catch((error) => {
            logger.error('[AccessControlService.bulkUpdateResourcePermissions] Renewal failed', {
              ...getSafeErrorMetadata(error),
            });
            throw new ResourcePermissionsUnavailableError();
          });
        if (!renewed) {
          throw new ResourcePermissionsBusyError();
        }
      };

      await fence();
      if (roleBitsWrites.length > 0) {
        await this._dbMethods.replaceRoleBits(roleBitsWrites, {
          ...sessionOptions,
          maxAttempts: maxWriteAttempts,
        });
      }

      if (bulkWrites.length > 0) {
        await fence();
        await this._dbMethods.bulkWriteAclEntries(bulkWrites, sessionOptions);
      }

      for (const { principal, query } of revokeQueries) {
        if (query) {
          await fence();
          await this._dbMethods.deleteAclEntries(query, sessionOptions);
        }
        results.revoked.push({
          type: principal.type,
          id: principal.id,
          name: principal.name,
          email: principal.email,
          source: principal.source,
          avatar: principal.avatar,
          description: principal.description,
          idOnTheSource: principal.idOnTheSource,
          memberCount: principal.memberCount,
        });
      }

      if (shouldEndSession && supportsTransactions) {
        await localSession?.commitTransaction();
      }
      /** A caller-owned transaction may still abort, so only a durable write is finalized. */
      if (!localSession?.inTransaction()) {
        await afterWrite?.().catch((error) =>
          logger.error('[AccessControlService.bulkUpdateResourcePermissions] afterWrite failed', {
            ...getSafeErrorMetadata(error),
          }),
        );
      }
      if (resourceType === ResourceType.PROMPTGROUP) {
        await runAfterTransaction(localSession, () =>
          this._dbMethods.invalidatePromptGroupAccessContext(),
        );
      }
      return results;
    } catch (error) {
      if (shouldEndSession && supportsTransactions) {
        try {
          await localSession?.abortTransaction();
        } catch (transactionError) {
          logger.error(
            '[AccessControlService.bulkUpdateResourcePermissions] Error aborting transaction:',
            transactionError,
          );
        }
      }
      logger.error(
        `[AccessControlService.bulkUpdateResourcePermissions] Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      if (shouldEndSession && localSession) {
        await localSession.endSession();
      }
      clearInterval(heartbeat);
      if (lockHeld) {
        await this._dbMethods.releaseResourceLock(lock).catch((error) =>
          logger.error('[AccessControlService.bulkUpdateResourcePermissions] Lock release failed', {
            ...getSafeErrorMetadata(error),
          }),
        );
      }
    }
  }

  /**
   * Check if a user has specific permission bits on a resource
   * @param {Object} params - Parameters for checking permissions
   * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
   * @param {string} [params.role] - Optional user role (if not provided, will query from DB)
   * @param {string} params.resourceType - Type of resource (e.g., 'agent')
   * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
   * @param {number} params.requiredPermissions - The permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
   * @returns {Promise<boolean>} Whether the user has the required permission bits
   */
  public async checkPermission({
    userId,
    role,
    resourceType,
    resourceId,
    requiredPermission,
  }: {
    userId: string;
    role?: string | null;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    requiredPermission: number;
  }): Promise<boolean> {
    try {
      if (typeof requiredPermission !== 'number' || requiredPermission < 1) {
        throw new Error('requiredPermission must be a positive number');
      }

      this.validateResourceType(resourceType);

      // Get all principals for the user (user + groups + public)
      const principals = await this._dbMethods.getUserPrincipals({ userId, role });

      if (principals.length === 0) {
        return false;
      }

      return await this._dbMethods.hasPermission(
        principals,
        resourceType,
        resourceId,
        requiredPermission,
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PermissionService.checkPermission] Error: ${error.message}`);
        // Re-throw validation errors
        if (error.message.includes('requiredPermission must be')) {
          throw error;
        }
      }
      return false;
    }
  }

  /**
   * Check if a resource has a PUBLIC AclEntry (accessible to everyone).
   * Unlike checkPermission, this does not require a user context.
   */
  public async hasPublicAccess({
    resourceType,
    resourceId,
  }: {
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }): Promise<boolean> {
    try {
      this.validateResourceType(resourceType);
      return await this._dbMethods.hasPermission(
        [{ principalType: PrincipalType.PUBLIC }],
        resourceType,
        resourceId,
        PermissionBits.VIEW,
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`[PermissionService.hasPublicAccess] Error: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Validates that the resourceType is one of the supported enum values
   * @param {string} resourceType - The resource type to validate
   * @throws {Error} If resourceType is not valid
   */
  private validateResourceType(resourceType: ResourceType): void {
    const validTypes = Object.values(ResourceType);
    if (!validTypes.includes(resourceType)) {
      throw new Error(
        `Invalid resourceType: ${resourceType}. Valid types: ${validTypes.join(', ')}`,
      );
    }
  }
}
