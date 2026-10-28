import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { Types, Model, ClientSession, FilterQuery } from 'mongoose';
import type { ISystemGrant, SystemGrantMove } from '~/types';
import type { SystemCapability } from '~/types/admin';
import { SystemCapabilities, CapabilityImplications } from '~/admin/capabilities';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { normalizePrincipalId } from '~/utils/principal';
import { getSafeErrorFields } from '~/utils/errors';
import logger from '~/config/winston';

/**
 * Precomputed reverse map: for each capability, which broader capabilities imply it.
 * Built once at module load so `hasCapabilityForPrincipals` avoids O(N×M) per call.
 */
type BaseSystemCapability = (typeof SystemCapabilities)[keyof typeof SystemCapabilities];
const reverseImplications: Partial<Record<BaseSystemCapability, BaseSystemCapability[]>> = {};
for (const [broad, implied] of Object.entries(CapabilityImplications)) {
  for (const cap of implied as BaseSystemCapability[]) {
    (reverseImplications[cap] ??= []).push(broad as BaseSystemCapability);
  }
}

const baseCapabilityValues = new Set<string>(Object.values(SystemCapabilities));

/**
 * For a section/assignment capability like `manage:configs:endpoints` or
 * `assign:configs:user`, returns all capabilities that subsume it:
 * the direct parent (`manage:configs`), any base capability that implies
 * the parent via `reverseImplications` (`read:configs` is implied by
 * `manage:configs`, so `read:configs:endpoints` is satisfied by holding
 * `manage:configs`), and, for a `read:configs:<section>` capability, the
 * same-section `manage:configs:<section>` grant (manage implies read at
 * the section level too, mirroring the broad-level implication).
 */
function getParentCapabilities(capability: string): string[] {
  const lastColon = capability.lastIndexOf(':');
  if (lastColon === -1) {
    return [];
  }
  const parent = capability.slice(0, lastColon);
  const parents: string[] = [];
  if (baseCapabilityValues.has(parent)) {
    parents.push(parent);
    const implied = reverseImplications[parent as keyof typeof reverseImplications];
    if (implied) {
      parents.push(...implied);
    }
  }
  if (parent === SystemCapabilities.READ_CONFIGS) {
    parents.push(`manage:configs:${capability.slice(lastColon + 1)}`);
  }
  return parents;
}

export function createSystemGrantMethods(mongoose: typeof import('mongoose')): {
  grantCapability: (
    {
      principalType,
      principalId,
      capability,
      tenantId,
      grantedBy,
    }: {
      principalType: PrincipalType;
      principalId: string | Types.ObjectId;
      capability: SystemCapability;
      tenantId?: string;
      grantedBy?: string | Types.ObjectId;
    },
    session?: ClientSession,
  ) => Promise<{ grant: ISystemGrant | null; created: boolean }>;
  seedSystemGrants: () => Promise<void>;
  revokeCapability: (
    {
      principalType,
      principalId,
      capability,
      tenantId,
    }: {
      principalType: PrincipalType;
      principalId: string | Types.ObjectId;
      capability: SystemCapability;
      tenantId?: string;
    },
    session?: ClientSession,
  ) => Promise<{ deletedCount: number }>;
  hasCapabilityForPrincipals: ({
    principals,
    capability,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    capability: SystemCapability;
    tenantId?: string;
  }) => Promise<boolean>;
  hasAnyConfigReadAccess: ({
    principals,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    tenantId?: string;
  }) => Promise<boolean>;
  getHeldCapabilities: ({
    principals,
    capabilities,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    capabilities: SystemCapability[];
    tenantId?: string;
  }) => Promise<Set<SystemCapability>>;
  listGrants: (options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
    limit?: number;
    offset?: number;
  }) => Promise<ISystemGrant[]>;
  countGrants: (options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
  }) => Promise<number>;
  getCapabilitiesForPrincipal: ({
    principalType,
    principalId,
    tenantId,
  }: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
    tenantId?: string;
  }) => Promise<ISystemGrant[]>;
  getCapabilitiesForPrincipals: ({
    principals,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId: string | Types.ObjectId }>;
    tenantId?: string;
  }) => Promise<ISystemGrant[]>;
  deleteGrantsForPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { tenantId?: string; session?: ClientSession },
  ) => Promise<ISystemGrant[]>;
  findGrantsForPrincipal: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { tenantId?: string },
  ) => Promise<ISystemGrant[]>;
  moveGrantsToPrincipal: (
    principalType: PrincipalType,
    fromPrincipalId: string | Types.ObjectId,
    toPrincipalId: string | Types.ObjectId,
    options?: { tenantId?: string },
  ) => Promise<SystemGrantMove>;
  restoreMovedGrants: (
    principalType: PrincipalType,
    fromPrincipalId: string | Types.ObjectId,
    toPrincipalId: string | Types.ObjectId,
    move: SystemGrantMove,
  ) => Promise<void>;
} {
  /** The grants of exactly one scope: `tenantId`'s, or the platform-level ones without it. */
  function grantScope(tenantId?: string): FilterQuery<ISystemGrant> {
    return tenantId != null ? { tenantId } : { tenantId: { $exists: false } };
  }

  function tenantCondition(tenantId?: string): FilterQuery<ISystemGrant> {
    return tenantId != null
      ? { $and: [{ $or: [{ tenantId }, { tenantId: { $exists: false } }] }] }
      : { tenantId: { $exists: false } };
  }

  const CONFIG_READ_ACCESS_PATTERN = /^(?:read|manage):configs(?::\w+)?$/;

  /**
   * Whether any of the given principals holds *some* config-read
   * capability: the broad `read:configs`/`manage:configs` (manage implies
   * read) or any `read:configs:<section>`/`manage:configs:<section>`,
   * without needing to know which sections in advance. Used to gate a
   * cheap pre-flight 403 before fetching a config document, so a caller
   * with zero read access never triggers a DB lookup, while a
   * section-scoped-only caller still passes through to have the response
   * filtered to what they actually hold.
   *
   * @param principals - Resolved principal list from getUserPrincipals
   * @param tenantId - If present, checks tenant-scoped grant; if absent, checks platform-level
   */
  async function hasAnyConfigReadAccess({
    principals,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    tenantId?: string;
  }): Promise<boolean> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const principalsQuery = principals
      .filter(
        (p): p is typeof p & { principalId: string | Types.ObjectId } =>
          p.principalType !== PrincipalType.PUBLIC && p.principalId != null,
      )
      .map((p) => ({
        principalType: p.principalType,
        principalId: normalizePrincipalId(p.principalId, p.principalType),
      }));

    if (!principalsQuery.length) {
      return false;
    }

    const query: FilterQuery<ISystemGrant> = {
      $and: [
        { $or: principalsQuery },
        { capability: CONFIG_READ_ACCESS_PATTERN },
        tenantCondition(tenantId),
      ],
    };

    const doc = await SystemGrant.exists(query);
    return doc != null;
  }

  /**
   * Check if any of the given principals holds a specific capability.
   * Follows the same principal-resolution pattern as AclEntry:
   * getUserPrincipals → $or query.
   *
   * @param principals - Resolved principal list from getUserPrincipals
   * @param capability - The capability to check
   * @param tenantId  - If present, checks tenant-scoped grant; if absent, checks platform-level
   */
  async function hasCapabilityForPrincipals({
    principals,
    capability,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    capability: SystemCapability;
    tenantId?: string;
  }): Promise<boolean> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const principalsQuery = principals
      .filter(
        (p): p is typeof p & { principalId: string | Types.ObjectId } =>
          p.principalType !== PrincipalType.PUBLIC && p.principalId != null,
      )
      .map((p) => ({
        principalType: p.principalType,
        principalId: normalizePrincipalId(p.principalId, p.principalType),
      }));

    if (!principalsQuery.length) {
      return false;
    }

    const impliedBy = reverseImplications[capability as keyof typeof reverseImplications] ?? [];
    const parents = getParentCapabilities(capability);
    const allMatches = [capability, ...impliedBy, ...parents];
    const capabilityQuery = allMatches.length > 1 ? { $in: allMatches } : capability;

    const query: FilterQuery<ISystemGrant> = {
      $or: principalsQuery,
      capability: capabilityQuery,
      ...tenantCondition(tenantId),
    };

    const doc = await SystemGrant.exists(query);
    return doc != null;
  }

  /**
   * Returns the subset of `capabilities` that any of the given principals hold.
   * Single DB round-trip — replaces N parallel `hasCapabilityForPrincipals` calls.
   */
  async function getHeldCapabilities({
    principals,
    capabilities,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>;
    capabilities: SystemCapability[];
    tenantId?: string;
  }): Promise<Set<SystemCapability>> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const principalsQuery = principals
      .filter(
        (p): p is typeof p & { principalId: string | Types.ObjectId } =>
          p.principalType !== PrincipalType.PUBLIC && p.principalId != null,
      )
      .map((p) => ({
        principalType: p.principalType,
        principalId: normalizePrincipalId(p.principalId, p.principalType as PrincipalType),
      }));

    if (!principalsQuery.length || !capabilities.length) {
      return new Set();
    }

    const allCaps = new Set<string>([
      ...capabilities,
      ...capabilities.flatMap(
        (cap) => reverseImplications[cap as keyof typeof reverseImplications] ?? [],
      ),
      ...capabilities.flatMap(getParentCapabilities),
    ]);

    const docs = await SystemGrant.find(
      {
        $or: principalsQuery,
        capability: { $in: [...allCaps] },
        ...tenantCondition(tenantId),
      },
      { capability: 1, _id: 0 },
    ).lean();

    const held = new Set<string>(docs.map((d) => d.capability));
    const result = new Set<SystemCapability>();
    for (const cap of capabilities) {
      if (held.has(cap)) {
        result.add(cap);
        continue;
      }
      const implied = reverseImplications[cap as keyof typeof reverseImplications];
      if (implied?.some((imp) => held.has(imp))) {
        result.add(cap);
        continue;
      }
      if (getParentCapabilities(cap).some((p) => held.has(p))) {
        result.add(cap);
      }
    }

    return result;
  }

  /**
   * Grant a capability to a principal. Upsert — idempotent.
   */
  async function grantCapability(
    {
      principalType,
      principalId,
      capability,
      tenantId,
      grantedBy,
    }: {
      principalType: PrincipalType;
      principalId: string | Types.ObjectId;
      capability: SystemCapability;
      tenantId?: string;
      grantedBy?: string | Types.ObjectId;
    },
    session?: ClientSession,
  ): Promise<{ grant: ISystemGrant | null; created: boolean }> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;

    const normalizedPrincipalId = normalizePrincipalId(principalId, principalType);

    const filter: FilterQuery<ISystemGrant> = {
      principalType,
      principalId: normalizedPrincipalId,
      capability,
      tenantId: tenantId != null ? tenantId : { $exists: false },
    };

    /**
     * Insert-only: re-asserting an existing grant is a true no-op (no field is
     * mutated), so `created === false` reliably means "nothing changed" and the
     * caller can safely skip audit emission. `grantedAt`/`grantedBy` therefore
     * record the original grant, not the last re-assert.
     */
    const update = {
      $setOnInsert: {
        principalType,
        principalId: normalizedPrincipalId,
        capability,
        grantedAt: new Date(),
        ...(grantedBy != null && { grantedBy }),
        ...(tenantId != null && { tenantId }),
      },
    };

    try {
      /** `includeResultMetadata` surfaces `lastErrorObject.upserted` so callers
       * (audit emission) can tell a brand-new grant from an idempotent re-assert
       * atomically, without a racy pre-read. Passed inline so the metadata
       * overload is selected. */
      const result = await SystemGrant.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        includeResultMetadata: true,
        session,
      });
      return { grant: result.value, created: result.lastErrorObject?.upserted != null };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        /** A concurrent insert won the race: the row exists and we did not create
         * it, so this is not an auditable change. */
        const grant = (await SystemGrant.findOne(filter).lean()) as ISystemGrant | null;
        return { grant, created: false };
      }
      throw err;
    }
  }

  /**
   * Revoke a capability from a principal. Returns the deletion result so
   * callers (e.g. audit emission) can distinguish a real revoke from a
   * no-op against a grant that didn't exist.
   */
  async function revokeCapability(
    {
      principalType,
      principalId,
      capability,
      tenantId,
    }: {
      principalType: PrincipalType;
      principalId: string | Types.ObjectId;
      capability: SystemCapability;
      tenantId?: string;
    },
    session?: ClientSession,
  ): Promise<{ deletedCount: number }> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;

    const normalizedPrincipalId = normalizePrincipalId(principalId, principalType);

    const filter: FilterQuery<ISystemGrant> = {
      principalType,
      principalId: normalizedPrincipalId,
      capability,
      tenantId: tenantId != null ? tenantId : { $exists: false },
    };

    const options = session ? { session } : {};
    const result = await SystemGrant.deleteOne(filter, options);
    return { deletedCount: result.deletedCount ?? 0 };
  }

  /**
   * List all capabilities held by a principal — used by the capabilities
   * introspection endpoint.
   */
  async function getCapabilitiesForPrincipal({
    principalType,
    principalId,
    tenantId,
  }: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
    tenantId?: string;
  }): Promise<ISystemGrant[]> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;

    const filter: FilterQuery<ISystemGrant> = {
      principalType,
      principalId: normalizePrincipalId(principalId, principalType),
      ...tenantCondition(tenantId),
    };

    return await SystemGrant.find(filter).lean<ISystemGrant[]>();
  }

  const GRANTS_DEFAULT_LIMIT = 50;
  const GRANTS_MAX_LIMIT = 200;

  async function listGrants(options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
    limit?: number;
    offset?: number;
  }): Promise<ISystemGrant[]> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const limit = Math.min(GRANTS_MAX_LIMIT, Math.max(1, options?.limit ?? GRANTS_DEFAULT_LIMIT));
    const offset = options?.offset ?? 0;
    const filter: FilterQuery<ISystemGrant> = {
      ...(options?.principalTypes?.length && { principalType: { $in: options.principalTypes } }),
      ...tenantCondition(options?.tenantId),
    };

    return SystemGrant.find(filter)
      .sort({ principalType: 1, capability: 1 })
      .skip(offset)
      .limit(limit)
      .lean<ISystemGrant[]>();
  }

  async function countGrants(options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
  }): Promise<number> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const filter: FilterQuery<ISystemGrant> = {
      ...(options?.principalTypes?.length && { principalType: { $in: options.principalTypes } }),
      ...tenantCondition(options?.tenantId),
    };

    return SystemGrant.countDocuments(filter);
  }

  async function getCapabilitiesForPrincipals({
    principals,
    tenantId,
  }: {
    principals: Array<{ principalType: PrincipalType; principalId: string | Types.ObjectId }>;
    tenantId?: string;
  }): Promise<ISystemGrant[]> {
    if (!principals.length) {
      return [];
    }

    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const principalsQuery = principals
      .filter((p) => p.principalType !== PrincipalType.PUBLIC)
      .map((p) => ({
        principalType: p.principalType,
        principalId: normalizePrincipalId(p.principalId, p.principalType),
      }));

    if (!principalsQuery.length) {
      return [];
    }

    const filter: FilterQuery<ISystemGrant> = {
      $or: principalsQuery,
      ...tenantCondition(tenantId),
    };

    return await SystemGrant.find(filter).lean<ISystemGrant[]>();
  }

  /**
   * Seed the ADMIN role with all system capabilities.
   * Context-agnostic: caller provides tenant context (e.g., `runAsSystem()` for
   * startup, `tenantStorage.run()` for future per-tenant provisioning).
   * Idempotent and concurrency-safe: uses bulkWrite with ordered:false so parallel
   * server instances (K8s rolling deploy, PM2 cluster) do not race on E11000.
   * Retries up to 3 times with exponential backoff on transient failures.
   */
  async function seedSystemGrants(): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
        const now = new Date();
        const ops = Object.values(SystemCapabilities).map((capability) => ({
          updateOne: {
            filter: {
              principalType: PrincipalType.ROLE,
              principalId: SystemRoles.ADMIN,
              capability,
              tenantId: { $exists: false },
            },
            update: {
              $setOnInsert: {
                principalType: PrincipalType.ROLE,
                principalId: SystemRoles.ADMIN,
                capability,
                grantedAt: now,
              },
            },
            upsert: true,
          },
        }));
        await tenantSafeBulkWrite(SystemGrant, ops, { ordered: false });
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt - 1);
          logger.warn(
            `[seedSystemGrants] Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms: ${(err as Error).message ?? String(err)}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error(
            '[seedSystemGrants] Failed to seed capabilities after all retries. ' +
              'Admin panel access requires these grants. Manual recovery: ' +
              'db.systemgrants.insertMany([...]) with ADMIN role grants for each capability.',
            err,
          );
        }
      }
    }
  }

  /**
   * Delete system grants for a principal.
   * Used for cascade cleanup when a principal (group, role) is deleted.
   *
   * Only the grants of one scope go, as `moveGrantsToPrincipal` moves them on a rename: with
   * `tenantId`, those scoped to **exactly** that tenant (platform-level grants, with no
   * tenantId, are left intact so they continue to serve other tenants); without it, only the
   * platform-level ones. A role is keyed by a name every tenant reuses, so deleting the
   * platform's role never removes the grants a tenant's own role of that name holds.
   */
  async function deleteGrantsForPrincipal(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { tenantId?: string; session?: ClientSession },
  ): Promise<ISystemGrant[]> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const normalizedPrincipalId = normalizePrincipalId(principalId, principalType);

    const filter: FilterQuery<ISystemGrant> = {
      principalType,
      principalId: normalizedPrincipalId,
      ...grantScope(options?.tenantId),
    };
    const queryOptions = options?.session ? { session: options.session } : {};
    /** Read the matching grants before deleting so cascade callers (e.g. role
     * deletion) can emit a `grant.removed` audit entry for each one. */
    const removed = await SystemGrant.find(filter, null, queryOptions).lean<ISystemGrant[]>();
    await SystemGrant.deleteMany(filter, queryOptions);
    return removed;
  }

  /** Reads the grants {@link deleteGrantsForPrincipal} would remove, without removing them. */
  async function findGrantsForPrincipal(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    options?: { tenantId?: string },
  ): Promise<ISystemGrant[]> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    return SystemGrant.find({
      principalType,
      principalId: normalizePrincipalId(principalId, principalType),
      ...grantScope(options?.tenantId),
    }).lean<ISystemGrant[]>();
  }

  /** One grant per principal, capability and tenant scope (the unique index); platform-level is ''. */
  function grantScopeKey(grant: Pick<ISystemGrant, 'capability' | 'tenantId'>): string {
    return `${grant.tenantId ?? ''}\u0000${grant.capability}`;
  }

  /** The capability scopes (`grantScopeKey`) among `grants` that `principalId` holds now. */
  async function findHeldScopes(
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
    grants: readonly Pick<ISystemGrant, 'capability' | 'tenantId'>[],
  ): Promise<Set<string>> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const held = await SystemGrant.find({
      principalType,
      principalId,
      capability: { $in: [...new Set(grants.map((grant) => grant.capability))] },
    })
      .select('capability tenantId')
      .lean<Array<Pick<ISystemGrant, 'capability' | 'tenantId'>>>();
    return new Set(held.map(grantScopeKey));
  }

  /**
   * Re-keys a principal's grants to another id of the same type (a role rename), in one tenant
   * scope: exactly `tenantId` when given, platform-level grants (no `tenantId`) otherwise, as
   * {@link deleteGrantsForPrincipal} removes them. A rename re-keys one role, so a caller without
   * a tenant never re-keys the grants of each tenant's own role that shares the name. Each grant
   * keeps its identity and history. One the target already holds in the same scope is removed
   * from the source instead, since the unique index allows one.
   *
   * Returns what it changed, to audit the move or undo it with {@link restoreMovedGrants}: the
   * grants it re-keyed, and only the superseded grants whose removal it confirmed (a grant
   * revoked by someone else meanwhile is not among them). A move that fails part-way is undone
   * the same way before it rethrows; an undo that fails too, or a removal that cannot be
   * confirmed, is logged with the grant ids.
   */
  async function moveGrantsToPrincipal(
    principalType: PrincipalType,
    fromPrincipalId: string | Types.ObjectId,
    toPrincipalId: string | Types.ObjectId,
    options?: { tenantId?: string },
  ): Promise<SystemGrantMove> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const source = normalizePrincipalId(fromPrincipalId, principalType);
    const grants = await SystemGrant.find({
      principalType,
      principalId: source,
      ...grantScope(options?.tenantId),
    }).lean<ISystemGrant[]>();
    if (grants.length === 0) {
      return { moved: [], superseded: [] };
    }
    const target = normalizePrincipalId(toPrincipalId, principalType);
    const heldKeys = await findHeldScopes(principalType, target, grants);
    const moved: ISystemGrant[] = [];
    const supersedable: ISystemGrant[] = [];
    for (const grant of grants) {
      (heldKeys.has(grantScopeKey(grant)) ? supersedable : moved).push(grant);
    }
    const superseded: ISystemGrant[] = [];
    try {
      const removals = await Promise.allSettled(
        supersedable.map((grant) =>
          SystemGrant.findOneAndDelete({ _id: grant._id, principalType, principalId: source })
            .lean<ISystemGrant>()
            .exec(),
        ),
      );
      const unconfirmed: string[] = [];
      let failure: unknown;
      removals.forEach((removal, index) => {
        if (removal.status === 'fulfilled') {
          if (removal.value) {
            superseded.push(removal.value);
          }
          return;
        }
        failure ??= removal.reason;
        unconfirmed.push(supersedable[index]._id.toString());
      });
      if (unconfirmed.length > 0) {
        logger.error('[moveGrantsToPrincipal] removal of superseded grants not confirmed', {
          principalType,
          fromPrincipalId: fromPrincipalId.toString(),
          toPrincipalId: toPrincipalId.toString(),
          grantIds: unconfirmed.join(','),
        });
        throw failure;
      }
      if (moved.length > 0) {
        await SystemGrant.updateMany(
          { _id: { $in: moved.map((grant) => grant._id) }, principalType, principalId: source },
          { $set: { principalId: target } },
        );
      }
    } catch (error) {
      const undo = { moved, superseded };
      await restoreMovedGrants(principalType, fromPrincipalId, toPrincipalId, undo).catch(
        (restoreError: unknown) =>
          logger.error('[moveGrantsToPrincipal] undo after a failed move failed', {
            principalType,
            fromPrincipalId: fromPrincipalId.toString(),
            toPrincipalId: toPrincipalId.toString(),
            grantIds: [...moved, ...superseded].map((grant) => grant._id.toString()).join(','),
            ...getSafeErrorFields(restoreError),
          }),
      );
      throw error;
    }
    return { moved, superseded };
  }

  /**
   * Undoes {@link moveGrantsToPrincipal}, and only what it changed: each grant it re-keyed goes
   * back to `fromPrincipalId` by identity while it is still at `toPrincipalId`, and each grant
   * it removed as superseded is re-created as it was while the target still holds the grant
   * that superseded it. A grant revoked meanwhile, from either name, stays revoked, and a grant
   * on the target that the move did not bring is left alone.
   */
  async function restoreMovedGrants(
    principalType: PrincipalType,
    fromPrincipalId: string | Types.ObjectId,
    toPrincipalId: string | Types.ObjectId,
    move: SystemGrantMove,
  ): Promise<void> {
    const SystemGrant = mongoose.models.SystemGrant as Model<ISystemGrant>;
    const source = normalizePrincipalId(fromPrincipalId, principalType);
    const target = normalizePrincipalId(toPrincipalId, principalType);
    if (move.moved.length > 0) {
      await SystemGrant.updateMany(
        { _id: { $in: move.moved.map((grant) => grant._id) }, principalType, principalId: target },
        { $set: { principalId: source } },
      );
    }
    if (move.superseded.length === 0) {
      return;
    }
    const heldKeys = await findHeldScopes(principalType, target, move.superseded);
    await Promise.all(
      move.superseded
        .filter((grant) => heldKeys.has(grantScopeKey(grant)))
        .map((grant) =>
          SystemGrant.updateOne(
            {
              principalType,
              principalId: source,
              capability: grant.capability,
              tenantId: grant.tenantId != null ? grant.tenantId : { $exists: false },
            },
            { $setOnInsert: { ...grant, principalId: source } },
            { upsert: true, timestamps: false },
          ),
        ),
    );
  }

  return {
    grantCapability,
    seedSystemGrants,
    revokeCapability,
    hasCapabilityForPrincipals,
    hasAnyConfigReadAccess,
    getHeldCapabilities,
    listGrants,
    countGrants,
    getCapabilitiesForPrincipal,
    getCapabilitiesForPrincipals,
    deleteGrantsForPrincipal,
    findGrantsForPrincipal,
    moveGrantsToPrincipal,
    restoreMovedGrants,
  };
}

export type SystemGrantMethods = ReturnType<typeof createSystemGrantMethods>;
