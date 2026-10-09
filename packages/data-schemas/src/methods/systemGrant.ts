import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { Types, Model, ClientSession, FilterQuery } from 'mongoose';
import type { SystemCapability } from '~/types/admin';
import type { ISystemGrant } from '~/types';
import { SystemCapabilities, CapabilityImplications } from '~/admin/capabilities';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { normalizePrincipalId } from '~/utils/principal';
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
} {
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
   * When `tenantId` is provided, only grants scoped to **exactly** that
   * tenant are removed — platform-level grants (no tenantId) are left
   * intact so they continue to serve other tenants.
   * When `tenantId` is omitted, ALL grants for the principal are removed
   * regardless of tenant scope.
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
      ...(options?.tenantId != null && { tenantId: options.tenantId }),
    };
    const queryOptions = options?.session ? { session: options.session } : {};
    /** Read the matching grants before deleting so cascade callers (e.g. role
     * deletion) can emit a `grant.removed` audit entry for each one. */
    const removed = await SystemGrant.find(filter, null, queryOptions).lean<ISystemGrant[]>();
    await SystemGrant.deleteMany(filter, queryOptions);
    return removed;
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
  };
}

export type SystemGrantMethods = ReturnType<typeof createSystemGrantMethods>;
