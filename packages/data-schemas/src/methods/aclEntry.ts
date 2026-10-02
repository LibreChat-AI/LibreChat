import { Types } from 'mongoose';
import {
  PrincipalType,
  PrincipalModel,
  PermissionBits,
  permissionWriteAttemptsSchema,
} from 'librechat-data-provider';
import type {
  AnyBulkWriteOperation,
  ClientSession,
  PipelineStage,
  DeleteResult,
  Model,
} from 'mongoose';
import type { IAclEntry } from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { MAX_PERM_BITS } from '~/common/permissions';
import { RoleBits } from '~/common/enum';

/**
 * Empty frozen array shared by every rejection path. Returning a single
 * instance keeps the hot path allocation-free and freezes a known-safe value
 * so it can never mutate into a "match everything" list.
 */
const EMPTY_SUPERSETS: readonly number[] = Object.freeze([]);

const supersetCache = new Map<number, readonly number[]>();

/**
 * Enumerates every `permBits` value (in the range `[0, MAX_PERM_BITS]`) whose
 * set bits include all bits in `requiredBits`. Used with a `$in` filter to push
 * permission-mask matching down to the database without relying on the
 * `$bitsAllSet` query operator, which is not supported by Azure Cosmos DB for
 * MongoDB (see issue #12729).
 *
 * **Invariant:** stored `permBits` values must lie in `[0, MAX_PERM_BITS]`.
 * Values with higher-order bits set would never appear in the emitted `$in`
 * list and would silently produce false permission denials. The aclEntry
 * schema enforces this with a `max` validator; if the `PermissionBits` enum
 * grows, `MAX_PERM_BITS` auto-expands from the new enum values.
 *
 * **Cache safety:** callers sometimes forward user input directly (e.g.
 * `req.query.requiredPermission` is parsed and passed through without a range
 * check). To prevent the process-global cache from growing unboundedly from
 * attacker-supplied integers, any `requiredBits` outside `[0, MAX_PERM_BITS]`
 * or with bits set above the max returns a shared frozen empty array and is
 * NOT added to the cache. An empty `$in` list correctly matches zero rows,
 * which is the right behavior for a request asking for bits the system does
 * not recognize.
 *
 * For the current 5-bit `PermissionBits` enum the worst case is `required = 0`
 * which expands to 32 values; the best case (all bits required) expands to 1.
 * Results are memoized per `requiredBits` so the expansion runs at most once
 * per distinct mask over the process lifetime.
 */
export function permissionBitSupersets(requiredBits: number): readonly number[] {
  if (
    !Number.isInteger(requiredBits) ||
    requiredBits < 0 ||
    requiredBits > MAX_PERM_BITS ||
    (requiredBits & ~MAX_PERM_BITS) !== 0
  ) {
    return EMPTY_SUPERSETS;
  }
  const cached = supersetCache.get(requiredBits);
  if (cached !== undefined) {
    return cached;
  }
  const supersets: number[] = [];
  for (let v = 0; v <= MAX_PERM_BITS; v++) {
    if ((v & requiredBits) === requiredBits) {
      supersets.push(v);
    }
  }
  /**
   * Freeze the cached array so a future caller cannot mutate the shared cache
   * entry. All current callers only forward this to Mongoose's `$in`, which
   * does not mutate — freezing is cheap and prevents silent corruption.
   */
  const frozen = Object.freeze(supersets);
  supersetCache.set(requiredBits, frozen);
  return frozen;
}

/**
 * Attempts for a guarded permission write before it reports failure. Callers
 * may override per call; a conflict is only ever resolved by retrying, never by
 * writing over a value the caller did not observe.
 */
export const PERM_BITS_WRITE_ATTEMPTS: number = permissionWriteAttemptsSchema.parse(undefined);

/** One principal's role replacement, as requested by the caller. */
export type RoleBitsWrite = {
  /** Identity of the principal on the resource; never filters on permissions. */
  filter: Record<string, unknown>;
  /** Identity fields used only when the entry has to be created. */
  insert: Record<string, unknown>;
  /** The requested role's bits; non-role bits are masked off. */
  roleBits: number;
  /** Role metadata that must land in the SAME write as the role bits. */
  metadata: Record<string, unknown>;
};

export function createAclEntryMethods(mongoose: typeof import('mongoose')): {
  findEntriesByPrincipal: (
    principalType: string,
    principalId: string | Types.ObjectId,
    resourceType?: string,
  ) => Promise<IAclEntry[]>;
  findEntriesByResource: (
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IAclEntry[]>;
  findEntriesByPrincipalsAndResource: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ) => Promise<IAclEntry[]>;
  hasPermission: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permissionBit: number,
  ) => Promise<boolean>;
  getEffectivePermissions: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ) => Promise<number>;
  getEffectivePermissionsForResources: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ) => Promise<Map<string, number>>;
  grantPermission: (
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permBits: number,
    grantedBy?: string | Types.ObjectId,
    session?: ClientSession,
    roleId?: string | Types.ObjectId,
    expiredAt?: Date,
  ) => Promise<IAclEntry | null>;
  revokePermission: (
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<DeleteResult>;
  modifyPermissionBits: (
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    addBits?: number | null,
    removeBits?: number | null,
    session?: ClientSession,
    maxAttempts?: number,
  ) => Promise<IAclEntry | null>;
  findAccessibleResources: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
  deleteAclEntries: (
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ) => Promise<DeleteResult>;
  replaceRoleBits: (
    writes: RoleBitsWrite[],
    options?: { session?: ClientSession; maxAttempts?: number },
  ) => Promise<{ upsertedWrites: Set<number> }>;
  bulkWriteAclEntries: (
    ops: AnyBulkWriteOperation[],
    options?: { session?: ClientSession },
  ) => Promise<import('mongodb').BulkWriteResult>;
  findPublicResourceIds: (
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
  aggregateAclEntries: (pipeline: PipelineStage[]) => Promise<unknown[]>;
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
} {
  /**
   * Find ACL entries for a specific principal (user or group)
   * @param principalType - The type of principal ('user', 'group')
   * @param principalId - The ID of the principal
   * @param resourceType - Optional filter by resource type
   * @returns Array of ACL entries
   */
  async function findEntriesByPrincipal(
    principalType: string,
    principalId: string | Types.ObjectId,
    resourceType?: string,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query: Record<string, unknown> = { principalType, principalId };
    if (resourceType) {
      query.resourceType = resourceType;
    }
    return await AclEntry.find(query).lean<IAclEntry[]>();
  }

  /**
   * Find ACL entries for a specific resource
   * @param resourceType - The type of resource ('agent', 'project', 'file')
   * @param resourceId - The ID of the resource
   * @returns Array of ACL entries
   */
  async function findEntriesByResource(
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find({ resourceType, resourceId });
    if (session) {
      query.session(session);
    }
    return await query.lean<IAclEntry[]>();
  }

  /**
   * Find all ACL entries for a set of principals (including public)
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @returns Array of matching ACL entries
   */
  async function findEntriesByPrincipalsAndResource(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = principalsList.map((p) => ({
      principalType: p.principalType,
      ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
    }));

    return await AclEntry.find({
      $or: principalsQuery,
      resourceType,
      resourceId,
    }).lean<IAclEntry[]>();
  }

  /**
   * Check if a set of principals has a specific permission on a resource.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param permissionBit - The permission bit to check (use PermissionBits enum)
   * @returns Whether any of the principals has the permission
   */
  async function hasPermission(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permissionBit: number,
  ): Promise<boolean> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = principalsList.map((p) => ({
      principalType: p.principalType,
      ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
    }));

    const entry = await AclEntry.findOne({
      $or: principalsQuery,
      resourceType,
      resourceId,
      permBits: { $in: permissionBitSupersets(permissionBit) },
    })
      .select('_id')
      .lean();

    return !!entry;
  }

  /**
   * Get the combined effective permissions for a set of principals on a resource
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @returns {Promise<number>} Effective permission bitmask
   */
  async function getEffectivePermissions(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ): Promise<number> {
    const aclEntries = await findEntriesByPrincipalsAndResource(
      principalsList,
      resourceType,
      resourceId,
    );

    let effectiveBits = 0;
    for (const entry of aclEntries) {
      effectiveBits |= entry.permBits;
    }
    return effectiveBits;
  }

  /**
   * Get effective permissions for multiple resources in a single query (BATCH)
   * Returns a map of resourceId → effectivePermissionBits
   *
   * @param principalsList - List of principals (user + groups + public)
   * @param resourceType - The type of resource ('MCPSERVER', 'AGENT', etc.)
   * @param resourceIds - Array of resource IDs to check
   * @returns {Promise<Map<string, number>>} Map of resourceId → permission bits
   *
   * @example
   * const principals = await getUserPrincipals({ userId, role });
   * const serverIds = [id1, id2, id3];
   * const permMap = await getEffectivePermissionsForResources(
   *   principals,
   *   ResourceType.MCPSERVER,
   *   serverIds
   * );
   * // permMap.get(id1.toString()) → 7 (VIEW|EDIT|DELETE)
   */
  async function getEffectivePermissionsForResources(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ): Promise<Map<string, number>> {
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
      return new Map();
    }

    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = principalsList.map((p) => ({
      principalType: p.principalType,
      ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
    }));

    // Batch query for all resources at once
    const aclEntries = await AclEntry.find({
      $or: principalsQuery,
      resourceType,
      resourceId: { $in: resourceIds },
    }).lean();

    // Compute effective permissions per resource
    const permissionsMap = new Map<string, number>();
    for (const entry of aclEntries) {
      const rid = entry.resourceId.toString();
      const currentBits = permissionsMap.get(rid) || 0;
      permissionsMap.set(rid, currentBits | entry.permBits);
    }

    return permissionsMap;
  }

  /**
   * Grant permission to a principal for a resource
   * @param principalType - The type of principal ('user', 'group', 'public')
   * @param principalId - The ID of the principal (null for 'public')
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param permBits - The permission bits to grant
   * @param grantedBy - The ID of the user granting the permission
   * @param session - Optional MongoDB session for transactions
   * @param roleId - Optional role ID to associate with this permission
   * @returns The created or updated ACL entry
   */
  async function grantPermission(
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permBits: number,
    grantedBy?: string | Types.ObjectId,
    session?: ClientSession,
    roleId?: string | Types.ObjectId,
    expiredAt?: Date,
  ): Promise<IAclEntry | null> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query: Record<string, unknown> = {
      principalType,
      resourceType,
      resourceId,
    };

    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? new Types.ObjectId(principalId)
          : principalId;
      if (principalType === PrincipalType.USER) {
        query.principalModel = PrincipalModel.USER;
      } else if (principalType === PrincipalType.GROUP) {
        query.principalModel = PrincipalModel.GROUP;
      } else if (principalType === PrincipalType.ROLE) {
        query.principalModel = PrincipalModel.ROLE;
      }
    }

    const update = {
      $set: {
        permBits,
        grantedAt: new Date(),
        ...(grantedBy && { grantedBy }),
        ...(roleId && { roleId }),
        ...(expiredAt && { expiredAt }),
      },
    };

    const options = {
      upsert: true,
      new: true,
      ...(session ? { session } : {}),
    };

    return await AclEntry.findOneAndUpdate(query, update, options);
  }

  /**
   * Revoke permissions from a principal for a resource
   * @param principalType - The type of principal ('user', 'group', 'public')
   * @param principalId - The ID of the principal (null for 'public')
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param session - Optional MongoDB session for transactions
   * @returns The result of the delete operation
   */
  async function revokePermission(
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<DeleteResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query: Record<string, unknown> = {
      principalType,
      resourceType,
      resourceId,
    };

    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? new Types.ObjectId(principalId)
          : principalId;
    }

    const options = session ? { session } : {};

    return await AclEntry.deleteOne(query, options);
  }

  /**
   * Modify existing permission bits for a principal on a resource
   * @param principalType - The type of principal ('user', 'group', 'public')
   * @param principalId - The ID of the principal (null for 'public')
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param addBits - Permission bits to add
   * @param removeBits - Permission bits to remove
   * @param session - Optional MongoDB session for transactions
   * @returns The updated ACL entry
   */
  async function modifyPermissionBits(
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    addBits?: number | null,
    removeBits?: number | null,
    session?: ClientSession,
    maxAttempts?: number,
  ): Promise<IAclEntry | null> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query: Record<string, unknown> = {
      principalType,
      resourceType,
      resourceId,
    };

    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? new Types.ObjectId(principalId)
          : principalId;
    }

    const addMask = permissionMask(addBits ?? 0);
    const removeMask = permissionMask(removeBits ?? 0);
    const attempts = permissionWriteAttemptsSchema.parse(maxAttempts);
    const [entry] = await readPermissionEntries(query, session);
    if (entry == null) return null;
    if (addMask === 0 && removeMask === 0) return AclEntry.hydrate(entry);
    return mutatePermissionEntry(
      entry,
      query,
      (bits) => (bits | addMask) & ~removeMask,
      {},
      attempts,
      session,
    );
  }

  /**
   * Find all resources of a specific type that a set of principals has access to.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param requiredPermBit - Required permission bit (use PermissionBits enum)
   * @param resourceIds - Optional candidate bound. When provided, only these
   *   resources are considered, so the query cost scales with the candidate set
   *   instead of every accessible resource of the type. An empty array matches
   *   nothing rather than lifting the bound.
   * @param readPrimary - Read from the primary so a lagging secondary cannot
   *   pin pre-mutation IDs into a caller's cache.
   * @returns Array of resource IDs
   */
  async function findAccessibleResources(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: Types.ObjectId[],
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = principalsList.map((p) => ({
      principalType: p.principalType,
      ...(p.principalType !== PrincipalType.PUBLIC && { principalId: p.principalId }),
    }));

    const query = AclEntry.find({
      $or: principalsQuery,
      ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
      resourceType,
      permBits: { $in: permissionBitSupersets(requiredPermBit) },
    });
    if (readPrimary) {
      /** Cache builds must not capture a lagging secondary's pre-mutation state */
      query.read('primary');
    }
    return await query.distinct('resourceId');
  }

  /**
   * Deletes ACL entries matching the given filter.
   * @param filter - MongoDB filter query
   * @param options - Optional query options (e.g., { session })
   */
  async function deleteAclEntries(
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<DeleteResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.deleteMany(filter, options || {});
  }

  /** Reject values JavaScript bit operations would truncate. Missing legacy fields mean zero. */
  function permissionMask(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      throw new Error('Invalid permBits: expected a nonnegative 31-bit integer');
    }
    return value;
  }

  /** Pin nontransactional reads to the write authority, including explicit sessions. */
  async function readPermissionEntries(filter: Record<string, unknown>, session?: ClientSession) {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find(filter, null, session ? { session } : {}).sort({ _id: 1 });
    if (!session?.inTransaction()) query.read('primary');
    return query.lean();
  }

  /**
   * The single permission mutation primitive. One CAS changes bits and metadata
   * together. Retry only THIS document, never documents that already completed.
   * Deletion wins over a pending mutation: never retarget it to a replacement ACL.
   * Transaction conflicts and ambiguous write failures propagate to the caller;
   * only a definite zero-match result is retried here.
   */
  async function mutatePermissionEntry(
    initial: Awaited<ReturnType<typeof readPermissionEntries>>[number],
    identity: Record<string, unknown>,
    transform: (bits: number) => number,
    metadata: Record<string, unknown>,
    maxAttempts: number,
    session?: ClientSession,
  ): Promise<IAclEntry | null> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    let current: typeof initial | undefined = initial;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (current == null) return null;
      const observed = current.permBits;
      const permBits = permissionMask(transform(permissionMask(observed)));
      const guard: Record<string, unknown> = { ...identity, _id: current._id };
      // Bind the guard to the snapshot's role/audit state as well as its bits.
      for (const key of ['permBits', 'roleId', 'grantedBy', 'grantedAt']) {
        const value = (current as unknown as Record<string, unknown>)[key];
        guard[key] = value === undefined ? { $exists: false } : value;
      }
      const result = await bulkWriteAclEntries(
        [{ updateOne: { filter: guard, update: { $set: { ...metadata, permBits } } } }],
        session ? { session } : {},
      );
      if (result.matchedCount === 1) {
        return AclEntry.hydrate({ ...current, ...metadata, permBits });
      }
      [current] = await readPermissionEntries({ ...identity, _id: initial._id }, session);
    }
    if (current == null) return null;
    throw new Error(
      `Permission write conflict: permBits guard did not hold after ${maxAttempts} attempts`,
    );
  }

  /**
   * Process each observed ACL once, including duplicates. Completion is tracked
   * per document; a later failure may leave earlier writes committed on standalone
   * databases and reports that fact without replaying them. This is not a batch transaction.
   */
  async function replaceRoleBits(
    writes: RoleBitsWrite[],
    options?: { session?: ClientSession; maxAttempts?: number },
  ): Promise<{ upsertedWrites: Set<number> }> {
    const maxAttempts = permissionWriteAttemptsSchema.parse(options?.maxAttempts);
    const session = options?.session;
    const upsertedWrites = new Set<number>();
    let completedEntries = 0;
    try {
      for (const [index, write] of writes.entries()) {
        const roleOnly = permissionMask(write.roleBits) & RoleBits.OWNER;
        let existing = await readPermissionEntries(write.filter, session);
        if (existing.length === 0) {
          const result = await bulkWriteAclEntries(
            [
              {
                updateOne: {
                  filter: write.filter,
                  update: {
                    $setOnInsert: { ...write.insert, ...write.metadata, permBits: roleOnly },
                  },
                  upsert: true,
                },
              },
            ],
            session ? { session } : {},
          );
          if (result.upsertedCount === 1) {
            upsertedWrites.add(index);
            completedEntries++;
            continue;
          }
          // Another writer created this identity first. Read and mutate that row,
          // rather than claiming that a no-op identity upsert applied our role.
          existing = await readPermissionEntries(write.filter, session);
          if (existing.length === 0) throw new Error('ACL disappeared during role insertion');
        }
        for (const entry of existing) {
          const updated = await mutatePermissionEntry(
            entry,
            write.filter,
            (bits) => (bits & ~RoleBits.OWNER) | roleOnly,
            write.metadata,
            maxAttempts,
            session,
          );
          if (updated == null)
            throw new Error('ACL deleted during role update; permission was not recreated');
          completedEntries++;
        }
      }
      return { upsertedWrites };
    } catch (error) {
      // Preserve MongoDB error labels so the owner can retry/abort its transaction.
      if (error instanceof Error) {
        Object.assign(error, {
          completedEntries,
          transactional: session?.inTransaction() === true,
        });
        error.message += ` (${completedEntries} ACL writes completed before failure; transaction may roll back)`;
      }
      throw error;
    }
  }

  /**
   * Performs a bulk write operation on ACL entries.
   * @param ops - Array of bulk write operations
   * @param options - Optional query options (e.g., { session })
   */
  async function bulkWriteAclEntries(
    ops: AnyBulkWriteOperation[],
    options?: { session?: ClientSession },
  ): Promise<import('mongodb').BulkWriteResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return tenantSafeBulkWrite(AclEntry, ops as AnyBulkWriteOperation[], options || {});
  }

  /**
   * Finds all publicly accessible resource IDs for a given resource type.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param resourceType - The type of resource
   * @param requiredPermissions - Required permission bits
   * @param resourceIds - Optional candidate bound; see {@link findAccessibleResources}
   * @param readPrimary - Read from the primary; see {@link findAccessibleResources}
   */
  async function findPublicResourceIds(
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find({
      principalType: PrincipalType.PUBLIC,
      ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
      resourceType,
      permBits: { $in: permissionBitSupersets(requiredPermissions) },
    });
    if (readPrimary) {
      /** Cache builds must not capture a lagging secondary's pre-mutation state */
      query.read('primary');
    }
    return await query.distinct('resourceId');
  }

  /**
   * Runs an aggregation pipeline on the AclEntry collection.
   * @param pipeline - MongoDB aggregation pipeline stages
   */
  async function aggregateAclEntries(pipeline: PipelineStage[]): Promise<unknown[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.aggregate(pipeline);
  }

  /**
   * Returns resource IDs solely owned by the given user (no other principals
   * hold DELETE on the same resource). Handles both single and array resource types.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   */
  async function getSoleOwnedResourceIds(
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const types = Array.isArray(resourceTypes) ? resourceTypes : [resourceTypes];
    const deleteSupersets = permissionBitSupersets(PermissionBits.DELETE);

    const ownedEntries = await AclEntry.find({
      principalType: PrincipalType.USER,
      principalId: userObjectId,
      resourceType: { $in: types },
      permBits: { $in: deleteSupersets },
    })
      .select('resourceId')
      .lean();

    if (ownedEntries.length === 0) {
      return [];
    }

    const ownedIds = ownedEntries.map((e) => e.resourceId);

    const otherOwners = await AclEntry.aggregate([
      {
        $match: {
          resourceType: { $in: types },
          resourceId: { $in: ownedIds },
          permBits: { $in: deleteSupersets },
          $or: [
            { principalId: { $ne: userObjectId } },
            { principalType: { $ne: PrincipalType.USER } },
          ],
        },
      },
      { $group: { _id: '$resourceId' } },
    ]);

    const multiOwnerIds = new Set(
      otherOwners.map((doc: { _id: Types.ObjectId }) => doc._id.toString()),
    );
    return ownedIds.filter((id) => !multiOwnerIds.has(id.toString()));
  }

  return {
    findEntriesByPrincipal,
    findEntriesByResource,
    findEntriesByPrincipalsAndResource,
    hasPermission,
    getEffectivePermissions,
    getEffectivePermissionsForResources,
    grantPermission,
    revokePermission,
    modifyPermissionBits,
    findAccessibleResources,
    deleteAclEntries,
    replaceRoleBits,
    bulkWriteAclEntries,
    findPublicResourceIds,
    aggregateAclEntries,
    getSoleOwnedResourceIds,
  };
}

export type AclEntryMethods = ReturnType<typeof createAclEntryMethods>;
