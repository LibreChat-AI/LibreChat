import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';
import { CacheKeys, PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { TPrincipalSearchResult } from 'librechat-data-provider';
import type { Model, ClientSession, FilterQuery } from 'mongoose';
import type { CacheStore, IGroup, IRole, IUser } from '~/types';
import { isValidObjectIdString } from '~/utils/objectId';
import { scopedCacheKey } from '~/config/tenantContext';
import { escapeRegExp } from '~/utils/string';

export interface UserGroupDeps {
  /** Returns the USER_PRINCIPALS cache store when principal caching is enabled. From getLogStores. */
  getCache?: (key: string) => CacheStore | undefined;
  /**
   * Notified after membership caches are invalidated so access caches derived from
   * memberships (e.g. prompt group access IDs) drop their stale entries too.
   */
  onMemberGroupsInvalidated?: () => void | Promise<void>;
}

type PendingGroupLookup = { promise: Promise<Types.ObjectId[]>; markStale: () => void };

/** Same-process dedup of concurrent cache builds, keyed by scoped member cache key. */
const pendingGroupLookups = new Map<string, PendingGroupLookup>();
const GROUP_LOCK_POLL_MS = 50;
/** Above this many member keys, invalidation clears the namespace instead of fanning out deletes. */
const INVALIDATION_CLEAR_THRESHOLD = 1000;
/** Fallback delay for the second invalidation pass when the store sets none. */
const DEFAULT_STALE_EVICTION_DELAY_MS = 3000;

const isCachedGroupId = (value: unknown): value is string =>
  typeof value === 'string' && isValidObjectIdString(value);

type DeferredInvalidation = {
  /** ALS snapshot (tenant scoping) captured where the mutation ran. */
  run: (invalidate: () => Promise<void>) => Promise<void>;
  invalidate: () => Promise<void>;
};

/** One queue and one set of lifecycle hooks per session, so many mutations in one
 * transaction cannot trip the emitter's max-listeners warning. */
const sessionInvalidations = new WeakMap<ClientSession, DeferredInvalidation[]>();
const hookedSessions = new WeakSet<ClientSession>();

async function drainSessionInvalidations(session: ClientSession): Promise<void> {
  const queue = sessionInvalidations.get(session);
  if (!queue) {
    return;
  }
  sessionInvalidations.delete(session);
  await Promise.all(queue.map((entry) => entry.run(entry.invalidate).catch(() => undefined)));
}

function hookSessionLifecycle(session: ClientSession): void {
  if (hookedSessions.has(session)) {
    return;
  }
  hookedSessions.add(session);

  const commitTransaction = session.commitTransaction.bind(session);
  session.commitTransaction = async (
    ...args: Parameters<ClientSession['commitTransaction']>
  ): Promise<void> => {
    await commitTransaction(...args);
    await drainSessionInvalidations(session);
  };

  const abortTransaction = session.abortTransaction.bind(session);
  session.abortTransaction = async (
    ...args: Parameters<ClientSession['abortTransaction']>
  ): Promise<void> => {
    try {
      await abortTransaction(...args);
    } finally {
      sessionInvalidations.delete(session);
    }
  };

  session.once('ended', () => {
    sessionInvalidations.delete(session);
  });
}

/**
 * Runs cache invalidation immediately, or defers it to commit for transactional
 * writes. Mid-transaction invalidation would let concurrent readers re-cache pre-commit
 * state with no later correction; deferring keeps the existing entry serving the
 * still-committed old memberships until the transaction commits. Aborts discard the queue.
 */
export function runAfterTransaction(
  session: ClientSession | undefined,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (!session?.inTransaction()) {
    return invalidate();
  }
  const deferred: DeferredInvalidation = { run: AsyncLocalStorage.snapshot(), invalidate };
  const queue = sessionInvalidations.get(session);
  if (queue) {
    queue.push(deferred);
    return Promise.resolve();
  }
  const newQueue: DeferredInvalidation[] = [deferred];
  sessionInvalidations.set(session, newQueue);
  hookSessionLifecycle(session);
  return Promise.resolve();
}

/** Extracts member ids referenced by a group update; indeterminate when they cannot be enumerated. */
function collectMemberIdsFromGroupUpdate(update: Record<string, unknown>): {
  memberIds: string[];
  indeterminate: boolean;
} {
  if (Array.isArray(update)) {
    /** Aggregation-pipeline updates: affected members cannot be statically enumerated. */
    return { memberIds: [], indeterminate: true };
  }
  const memberIds: string[] = [];

  const collect = (value: unknown): boolean => {
    if (typeof value === 'string') {
      memberIds.push(value);
      return true;
    }
    if (value instanceof Types.ObjectId) {
      memberIds.push(value.toString());
      return true;
    }
    if (Array.isArray(value)) {
      return value.every(collect);
    }
    if (value !== null && typeof value === 'object') {
      const modifiers = value as { $each?: unknown; $in?: unknown };
      if (Array.isArray(modifiers.$each)) {
        return modifiers.$each.every(collect);
      }
      if (Array.isArray(modifiers.$in)) {
        return modifiers.$in.every(collect);
      }
    }
    return false;
  };

  let indeterminate = false;
  for (const [operator, operand] of Object.entries(update)) {
    const touchesMembers =
      operator === 'memberIds' ||
      (operand !== null &&
        typeof operand === 'object' &&
        'memberIds' in (operand as Record<string, unknown>));
    if (!touchesMembers) {
      continue;
    }
    if (operator === '$addToSet' || operator === '$push' || operator === '$pull') {
      indeterminate = !collect((operand as Record<string, unknown>).memberIds) || indeterminate;
    } else if (operator === '$pullAll') {
      const values = (operand as Record<string, unknown>).memberIds;
      indeterminate = !Array.isArray(values) || !values.every(collect) || indeterminate;
    } else {
      /** Wholesale replacement ($set, $unset, direct assignment): affected members are unknown. */
      indeterminate = true;
    }
  }

  return { memberIds, indeterminate };
}

export function createUserGroupMethods(
  mongoose: typeof import('mongoose'),
  deps: UserGroupDeps = {},
): {
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupByExternalId: (
    idOnTheSource: string,
    source?: 'entra' | 'local',
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupsByExternalIds: (
    idsOnTheSource: string[],
    source?: 'entra' | 'local',
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupsByNamePattern: (
    namePattern: string,
    source?: 'entra' | 'local' | null,
    limit?: number,
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupsByMemberId: (
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  createGroup: (groupData: Partial<IGroup>, session?: ClientSession) => Promise<IGroup>;
  upsertGroupByExternalId: (
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  addUserToGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeUserFromGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeUserFromAllGroups: (userId: string | Types.ObjectId) => Promise<void>;
  findGroupByQuery: (
    filter: Record<string, unknown>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  updateGroupById: (
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  bulkUpdateGroups: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ) => Promise<import('mongoose').UpdateWriteOpResult>;
  getUserGroups: (userId: string | Types.ObjectId, session?: ClientSession) => Promise<IGroup[]>;
  getUserPrincipals: (
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ) => Promise<Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>>;
  syncUserEntraGroups: (
    userId: string | Types.ObjectId,
    entraGroups: Array<{ id: string; name: string; description?: string; email?: string }>,
    session?: ClientSession,
  ) => Promise<{
    user: IUser;
    addedGroups: IGroup[];
    removedGroups: IGroup[];
  }>;
  searchPrincipals: (
    searchPattern: string,
    limitPerType?: number,
    typeFilter?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null,
    session?: ClientSession,
  ) => Promise<TPrincipalSearchResult[]>;
  calculateRelevanceScore: (item: TPrincipalSearchResult, searchPattern: string) => number;
  sortPrincipalsByRelevance: <
    T extends { _searchScore?: number; type: string; name?: string; email?: string },
  >(
    results: T[],
  ) => T[];
  listGroups: (
    filter?: {
      source?: 'local' | 'entra';
      search?: string;
      limit?: number;
      offset?: number;
    },
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  countGroups: (
    filter?: { source?: 'local' | 'entra'; search?: string },
    session?: ClientSession,
  ) => Promise<number>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  removeMemberById: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
} {
  const getPrincipalsCache = (): CacheStore | undefined =>
    deps.getCache?.(CacheKeys.USER_PRINCIPALS);

  async function queryGroupIds(
    memberId: string,
    session?: ClientSession,
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const groupsQuery = Group.find({ memberIds: memberId }, { _id: 1 });
    if (session) {
      groupsQuery.session(session);
    }
    if (readPrimary && !session) {
      /**
       * Cache builds must not capture a lagging secondary's pre-mutation state for the
       * full TTL (`secondaryPreferred` deployments); uncached reads keep the connection
       * default, where staleness is bounded by replication lag as before.
       */
      groupsQuery.read('primary');
    }
    const groups = await groupsQuery.lean<Array<Pick<IGroup, '_id'>>>();
    return groups.map((group) => group._id);
  }

  async function readCachedGroupIds(
    cache: CacheStore,
    cacheKey: string,
  ): Promise<Types.ObjectId[] | undefined> {
    try {
      const cached = await cache.get(cacheKey);
      if (Array.isArray(cached) && cached.every(isCachedGroupId)) {
        return cached.map((groupId) => new Types.ObjectId(groupId));
      }
    } catch {
      /** Cache failures must not block permission checks. */
    }
    return undefined;
  }

  /**
   * Resolves group ids for a member key (`idOnTheSource` for external users, else the
   * raw user id), cached per member. Concurrent same-process misses share one build;
   * Redis-backed stores also dedupe cross-process builds via a short-lived lock.
   * Session-scoped reads bypass the cache entirely.
   */
  async function getMemberGroupIds(
    memberId: string,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const cache = session ? undefined : getPrincipalsCache();
    if (!cache) {
      return queryGroupIds(memberId, session);
    }

    const cacheKey = scopedCacheKey(memberId);
    const fastPath = await readCachedGroupIds(cache, cacheKey);
    if (fastPath) {
      return fastPath;
    }

    const pending = pendingGroupLookups.get(cacheKey);
    if (pending) {
      return pending.promise;
    }

    /** Invalidation flips this so an in-flight build skips its now-stale cache write. */
    let stale = false;
    /**
     * The `_LOCK` prefix keeps raw lock keys disjoint from Keyv data keys
     * (always `USER_PRINCIPALS:<key>`), even for member ids ending in `:lock`.
     */
    const lockKey = `${CacheKeys.USER_PRINCIPALS}_LOCK:${cacheKey}`;
    const lookup = (async (): Promise<Types.ObjectId[]> => {
      let lockToken: string | null | undefined;
      try {
        if (cache.acquireLock) {
          let lockFailed = false;
          try {
            lockToken = await cache.acquireLock(lockKey);
          } catch {
            lockFailed = true;
          }
          if (!lockToken && !lockFailed) {
            const waitUntil = Date.now() + Math.max(cache.lockWaitMs ?? 0, 0);
            while (Date.now() < waitUntil) {
              await new Promise((resolve) => setTimeout(resolve, GROUP_LOCK_POLL_MS));
              const cached = await readCachedGroupIds(cache, cacheKey);
              if (cached) {
                return cached;
              }
              /**
               * Re-attempt the lock each tick: a holder whose write was invalidated away
               * (or that crashed) never fills the key, so take over the build as soon as
               * the lock frees instead of sleeping out the full wait budget.
               */
              try {
                lockToken = await cache.acquireLock(lockKey);
              } catch {
                break;
              }
              if (lockToken) {
                break;
              }
            }
          }
          if (lockToken) {
            /** Another process may have filled the key between the fast-path miss and the lock. */
            const cached = await readCachedGroupIds(cache, cacheKey);
            if (cached) {
              return cached;
            }
          }
        }

        const groupIds = await queryGroupIds(memberId, undefined, true);
        if (!stale) {
          try {
            await cache.set(
              cacheKey,
              groupIds.map((groupId) => groupId.toString()),
            );
          } catch {
            /** Cache failures must not block permission checks. */
          }
        }
        return groupIds;
      } finally {
        if (lockToken) {
          try {
            await cache.releaseLock?.(lockKey, lockToken);
          } catch {
            /** Lock cleanup failures expire via the lock TTL. */
          }
        }
      }
    })();

    /**
     * Registered synchronously (no await between the pending check and this set) so every
     * concurrent same-process caller attaches to this single flow instead of starting its own.
     */
    pendingGroupLookups.set(cacheKey, {
      promise: lookup,
      markStale: () => {
        stale = true;
      },
    });
    try {
      return await lookup;
    } finally {
      if (pendingGroupLookups.get(cacheKey)?.promise === lookup) {
        pendingGroupLookups.delete(cacheKey);
      }
    }
  }

  async function dropMemberKeys(cache: CacheStore, cacheKeys: Set<string>): Promise<void> {
    for (const cacheKey of cacheKeys) {
      const pending = pendingGroupLookups.get(cacheKey);
      if (pending) {
        pending.markStale();
        pendingGroupLookups.delete(cacheKey);
      }
    }
    try {
      await Promise.all([...cacheKeys].map((cacheKey) => cache.delete?.(cacheKey)));
    } catch {
      /** Cache failures must not block membership updates. */
    }
  }

  /**
   * Cross-process builds cannot see this process's stale flags, so a build in another
   * container that read pre-mutation state can re-cache it after the first delete.
   * A delayed second pass evicts such rewrites on stores shared across processes,
   * independent of build locking; the store supplies the delay budget.
   */
  function scheduleSecondInvalidation(cache: CacheStore, secondPass: () => Promise<void>): void {
    if (!cache.crossProcess) {
      return;
    }
    const graceMs = Math.max(cache.staleEvictionDelayMs ?? DEFAULT_STALE_EVICTION_DELAY_MS, 0);
    const timer = setTimeout(() => {
      secondPass().catch(() => undefined);
    }, graceMs);
    timer.unref?.();
  }

  /**
   * Drops cached group memberships for the given member keys (both base and
   * tenant-scoped variants) after a membership mutation. In-flight builds are
   * marked stale (skipping their cache write) and unregistered so later reads
   * start a fresh build instead of joining a pre-mutation one. Failures are
   * non-fatal; the cache TTL bounds any residual staleness (e.g. mutations
   * running under a different tenant context than the member's reads).
   */
  /**
   * Notifies dependent access caches after memberships have been evicted, never
   * before: a dependent rebuild that runs first would read the stale membership
   * and cache its derived IDs under the freshly bumped generation, surviving
   * the membership eviction that should have prevented them.
   */
  const notifyMemberGroupsInvalidated = async (): Promise<void> => {
    try {
      await deps.onMemberGroupsInvalidated?.();
    } catch {
      /** Dependent cache invalidation must not block membership updates. */
    }
  };

  async function invalidateMemberGroupsCache(
    memberIds: Array<string | Types.ObjectId | undefined | null>,
  ): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.delete) {
      await notifyMemberGroupsInvalidated();
      return;
    }
    const cacheKeys = new Set<string>();
    for (const memberId of memberIds) {
      if (!memberId) {
        continue;
      }
      const baseKey = memberId.toString();
      cacheKeys.add(baseKey);
      cacheKeys.add(scopedCacheKey(baseKey));
    }
    if (cacheKeys.size === 0) {
      return;
    }
    if (cacheKeys.size > INVALIDATION_CLEAR_THRESHOLD && cache.clear) {
      return clearMemberGroupsCache();
    }
    const evict = async (): Promise<void> => {
      await dropMemberKeys(cache, cacheKeys);
      await notifyMemberGroupsInvalidated();
    };
    await evict();
    scheduleSecondInvalidation(cache, evict);
  }

  /** Clears the whole membership cache when affected members cannot be enumerated. */
  async function clearMemberGroupsCache(): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.clear) {
      await notifyMemberGroupsInvalidated();
      return;
    }
    const clearAll = async (): Promise<void> => {
      for (const pending of pendingGroupLookups.values()) {
        pending.markStale();
      }
      pendingGroupLookups.clear();
      try {
        await cache.clear?.();
      } catch {
        /** Cache failures must not block membership updates. */
      }
      await notifyMemberGroupsInvalidated();
    };
    await clearAll();
    scheduleSecondInvalidation(cache, clearAll);
  }

  /**
   * Find a group by its ID
   * @param groupId - The group ID
   * @param projection - Optional projection of fields to return
   * @param session - Optional MongoDB session for transactions
   * @returns The group document or null if not found
   */
  async function findGroupById(
    groupId: string | Types.ObjectId,
    projection: Record<string, 0 | 1> = {},
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne({ _id: groupId }, projection);
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup>();
  }

  /**
   * Find a group by its external ID (e.g., Entra ID)
   * @param idOnTheSource - The external ID
   * @param source - The source ('entra' or 'local')
   * @param projection - Optional projection of fields to return
   * @param session - Optional MongoDB session for transactions
   * @returns The group document or null if not found
   */
  async function findGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local' = 'entra',
    projection: Record<string, 0 | 1> = {},
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne({ idOnTheSource, source }, projection);
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup>();
  }

  /**
   * Find multiple groups by their external IDs (e.g., Entra IDs) in a single query
   * @param idsOnTheSource - Array of external IDs
   * @param source - The source ('entra' or 'local')
   * @param session - Optional MongoDB session for transactions
   * @returns Array of group documents
   */
  async function findGroupsByExternalIds(
    idsOnTheSource: string[],
    source: 'entra' | 'local' = 'entra',
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.find(
      { idOnTheSource: { $in: idsOnTheSource }, source },
      { idOnTheSource: 1, _id: 0 },
    );
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup[]>();
  }

  /**
   * Find groups by name pattern (case-insensitive partial match)
   * @param namePattern - The name pattern to search for
   * @param source - Optional source filter ('entra', 'local', or null for all)
   * @param limit - Maximum number of results to return
   * @param session - Optional MongoDB session for transactions
   * @returns Array of matching groups
   */
  async function findGroupsByNamePattern(
    namePattern: string,
    source: 'entra' | 'local' | null = null,
    limit: number = 20,
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const regex = new RegExp(escapeRegExp(namePattern), 'i');
    const query: Record<string, unknown> = {
      $or: [{ name: regex }, { email: regex }, { description: regex }],
    };

    if (source) {
      query.source = source;
    }

    const dbQuery = Group.find(query).limit(limit);
    if (session) {
      dbQuery.session(session);
    }
    return await dbQuery.lean<IGroup[]>();
  }

  /**
   * Find all groups a user is a member of by their ID or idOnTheSource
   * @param userId - The user ID
   * @param session - Optional MongoDB session for transactions
   * @returns Array of groups the user is a member of
   */
  async function findGroupsByMemberId(
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const userQuery = User.findById(userId, 'idOnTheSource');
    if (session) {
      userQuery.session(session);
    }
    const user = await userQuery.lean<{ idOnTheSource?: string }>();

    if (!user) {
      return [];
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();

    const query = Group.find({ memberIds: userIdOnTheSource });
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup[]>();
  }

  /**
   * Create a new group
   * @param groupData - Group data including name, source, and optional idOnTheSource
   * @param session - Optional MongoDB session for transactions
   * @returns The created group
   */
  async function createGroup(groupData: Partial<IGroup>, session?: ClientSession): Promise<IGroup> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await Group.create([groupData], options).then((groups) => groups[0]);
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache(groupData.memberIds ?? []),
    );
    return group;
  }

  /**
   * Update or create a group by external ID
   * @param idOnTheSource - The external ID
   * @param source - The source ('entra' or 'local')
   * @param updateData - Data to update or set if creating
   * @param session - Optional MongoDB session for transactions
   * @returns The updated or created group
   */
  async function upsertGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = {
      new: true,
      upsert: true,
      ...(session ? { session } : {}),
    };

    if (updateData.memberIds === undefined) {
      return await Group.findOneAndUpdate({ idOnTheSource, source }, { $set: updateData }, options);
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await Group.findOneAndUpdate(
      { idOnTheSource, source },
      { $set: updateData },
      { ...options, new: false },
    ).lean<IGroup>();
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache([
        ...(previous?.memberIds ?? []),
        ...(updateData.memberIds ?? []),
      ]),
    );
    return await findGroupByExternalId(idOnTheSource, source, {}, session);
  }

  /**
   * Add a user to a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to add
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function addUserToGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    const updatedGroup = await Group.findByIdAndUpdate(
      groupId,
      { $addToSet: { memberIds: userIdOnTheSource } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup };
  }

  /**
   * Remove a user from a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to remove
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function removeUserFromGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    const updatedGroup = await Group.findByIdAndUpdate(
      groupId,
      { $pullAll: { memberIds: [userIdOnTheSource] } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup };
  }

  /**
   * Get all groups a user is a member of
   * @param userId - The user ID
   * @param session - Optional MongoDB session for transactions
   * @returns Array of group documents
   */
  async function getUserGroups(
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IGroup[]> {
    return await findGroupsByMemberId(userId, session);
  }

  /**
   * Get a list of all principal identifiers for a user (user ID + group IDs + public).
   * For use in permission checks.
   *
   * Tenant filtering for group memberships is handled automatically by the
   * `applyTenantIsolation` Mongoose plugin on the Group schema. The
   * `tenantContextMiddleware` (chained by `requireJwtAuth` after passport auth)
   * sets the ALS context, so the `memberIds` group query below is scoped to the
   * requesting tenant. No explicit tenantId parameter is needed.
   *
   * IMPORTANT: This relies on the ALS tenant context being active. If this
   * function is called outside a request context (e.g. startup, background jobs),
   * group queries will be unscoped. In strict mode, the Mongoose plugin will
   * reject such queries.
   *
   * Ref: #12091 (resolved by tenant context middleware in requireJwtAuth)
   *
   * Pass `role` and `idOnTheSource` from the already-loaded request user to skip
   * the fallback user lookup entirely, reducing the hot path to a single indexed,
   * `_id`-projected group query. `idOnTheSource: null` means "known to be absent"
   * (local user) and also avoids the lookup; only `undefined` triggers it.
   *
   * Group memberships are additionally cached per member key (USER_PRINCIPALS
   * namespace) when a cache is injected; membership mutations in this module
   * invalidate the affected keys. Role resolution is never cached.
   *
   * @param params - Parameters object
   * @param params.userId - The user ID
   * @param params.role - Optional user role (looked up when `undefined`)
   * @param params.idOnTheSource - Optional external member id (looked up when `undefined`)
   * @param session - Optional MongoDB session for transactions
   * @returns Array of principal objects with type and id
   */
  async function getUserPrincipals(
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ): Promise<Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>> {
    const { userId, role, idOnTheSource } = params;
    /** `userId` must be an `ObjectId` for USER principal since ACL entries store `ObjectId`s */
    const userObjectId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const principals: Array<{
      principalType: PrincipalType;
      principalId?: string | Types.ObjectId;
    }> = [{ principalType: PrincipalType.USER, principalId: userObjectId }];

    let userRole = role;
    let memberIdOnTheSource = idOnTheSource;

    /** Single fallback lookup, only for whichever identity fields the caller omitted. */
    if (userRole === undefined || memberIdOnTheSource === undefined) {
      const User = mongoose.models.User as Model<IUser>;
      const query = User.findById(userId).select('role idOnTheSource');
      if (session) {
        query.session(session);
      }
      const user = await query.lean<Pick<IUser, 'role' | 'idOnTheSource'>>();
      if (userRole === undefined) {
        userRole = user?.role;
      }
      if (memberIdOnTheSource === undefined) {
        memberIdOnTheSource = user?.idOnTheSource ?? null;
      }
    }

    if (userRole && userRole.trim()) {
      principals.push({ principalType: PrincipalType.ROLE, principalId: userRole });
    }

    /** `memberIds` stores `idOnTheSource` for external users, else the raw user id. */
    const memberId = memberIdOnTheSource || userId.toString();
    const groupIds = await getMemberGroupIds(memberId, session);
    for (const groupId of groupIds) {
      principals.push({ principalType: PrincipalType.GROUP, principalId: groupId });
    }

    principals.push({ principalType: PrincipalType.PUBLIC });

    return principals;
  }

  /**
   * Sync a user's Entra ID group memberships
   * @param userId - The user ID
   * @param entraGroups - Array of Entra groups with id and name
   * @param session - Optional MongoDB session for transactions
   * @returns The updated user with new group memberships
   */
  async function syncUserEntraGroups(
    userId: string | Types.ObjectId,
    entraGroups: Array<{ id: string; name: string; description?: string; email?: string }>,
    session?: ClientSession,
  ): Promise<{
    user: IUser;
    addedGroups: IGroup[];
    removedGroups: IGroup[];
  }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const query = User.findById(userId, { idOnTheSource: 1 });
    if (session) {
      query.session(session);
    }
    const user = await query.lean<{ idOnTheSource?: string; _id: Types.ObjectId }>();

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    /** Get user's idOnTheSource for storing in group.memberIds */
    const userIdOnTheSource = user.idOnTheSource || userId.toString();

    const entraIdMap = new Map<string, boolean>();
    const addedGroups: IGroup[] = [];
    const removedGroups: IGroup[] = [];

    for (const entraGroup of entraGroups) {
      entraIdMap.set(entraGroup.id, true);

      let group = await findGroupByExternalId(entraGroup.id, 'entra', {}, session);

      if (!group) {
        group = await createGroup(
          {
            name: entraGroup.name,
            description: entraGroup.description,
            email: entraGroup.email,
            idOnTheSource: entraGroup.id,
            source: 'entra',
            memberIds: [userIdOnTheSource],
          },
          session,
        );

        addedGroups.push(group);
      } else if (!group.memberIds?.includes(userIdOnTheSource)) {
        const { group: updatedGroup } = await addUserToGroup(userId, group._id, session);
        if (updatedGroup) {
          addedGroups.push(updatedGroup);
        }
      }
    }

    const groupsQuery = Group.find(
      { source: 'entra', memberIds: userIdOnTheSource },
      { _id: 1, idOnTheSource: 1 },
    );
    if (session) {
      groupsQuery.session(session);
    }
    const existingGroups = await groupsQuery.lean<
      Array<{
        _id: Types.ObjectId;
        idOnTheSource?: string;
      }>
    >();

    for (const group of existingGroups) {
      if (group.idOnTheSource && !entraIdMap.has(group.idOnTheSource)) {
        const { group: removedGroup } = await removeUserFromGroup(userId, group._id, session);
        if (removedGroup) {
          removedGroups.push(removedGroup);
        }
      }
    }

    const userQuery = User.findById(userId);
    if (session) {
      userQuery.session(session);
    }
    const updatedUser = await userQuery.lean<IUser>();

    if (!updatedUser) {
      throw new Error(`User not found after update: ${userId}`);
    }

    return {
      user: updatedUser,
      addedGroups,
      removedGroups,
    };
  }

  /**
   * Calculate relevance score for a search result
   * @param item - The search result item
   * @param searchPattern - The search pattern
   * @returns Relevance score (0-100)
   */
  function calculateRelevanceScore(item: TPrincipalSearchResult, searchPattern: string): number {
    const normalizedPattern = searchPattern.toLowerCase();

    /** Get searchable text based on type */
    const searchableFields =
      item.type === PrincipalType.USER
        ? [item.name, item.email, item.username].filter(Boolean)
        : [item.name, item.email, item.description].filter(Boolean);

    let maxScore = 0;

    for (const field of searchableFields) {
      if (!field) continue;
      const fieldLower = field.toLowerCase();
      let score = 0;

      /** Exact match gets highest score */
      if (fieldLower === normalizedPattern) {
        score = 100;
      } else if (fieldLower.startsWith(normalizedPattern)) {
        /** Starts with query gets high score */
        score = 80;
      } else if (fieldLower.includes(normalizedPattern)) {
        /** Contains query gets medium score */
        score = 50;
      } else {
        /** Default score for database match */
        score = 10;
      }

      maxScore = Math.max(maxScore, score);
    }

    return maxScore;
  }

  /**
   * Sort principals by relevance score and type priority
   * @param results - Array of results with _searchScore property
   * @returns Sorted array
   */
  function sortPrincipalsByRelevance<
    T extends { _searchScore?: number; type: string; name?: string; email?: string },
  >(results: T[]): T[] {
    return results.sort((a, b) => {
      if (b._searchScore !== a._searchScore) {
        return (b._searchScore || 0) - (a._searchScore || 0);
      }
      if (a.type !== b.type) {
        return a.type === PrincipalType.USER ? -1 : 1;
      }
      const aName = a.name || a.email || '';
      const bName = b.name || b.email || '';
      return aName.localeCompare(bName);
    });
  }

  /**
   * Transform user object to TPrincipalSearchResult format
   * @param user - User object from database
   * @returns Transformed user result
   */
  function transformUserToTPrincipalSearchResult(
    user: Pick<
      IUser,
      'id' | 'name' | 'email' | 'username' | 'avatar' | 'provider' | 'idOnTheSource' | 'role'
    >,
  ): TPrincipalSearchResult {
    return {
      id: user.id,
      type: PrincipalType.USER,
      name: user.name || user.email,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      provider: user.provider,
      source: 'local',
      idOnTheSource: user.idOnTheSource || user.id,
      isAdmin: user.role === SystemRoles.ADMIN,
    };
  }

  /**
   * Transform group object to TPrincipalSearchResult format
   * @param group - Group object from database
   * @returns Transformed group result
   */
  function transformGroupToTPrincipalSearchResult(group: IGroup): TPrincipalSearchResult {
    return {
      id: group._id?.toString(),
      type: PrincipalType.GROUP,
      name: group.name,
      email: group.email,
      avatar: group.avatar,
      description: group.description,
      source: group.source || 'local',
      memberCount: group.memberIds ? group.memberIds.length : 0,
      idOnTheSource: group.idOnTheSource || group._id?.toString(),
    };
  }

  /**
   * Search for principals (users and groups) by pattern matching on name/email
   * Returns combined results in TPrincipalSearchResult format without sorting
   * @param searchPattern - The pattern to search for
   * @param limitPerType - Maximum number of results to return
   * @param typeFilter - Optional array of types to filter by, or null for all types
   * @param session - Optional MongoDB session for transactions
   * @returns Array of principals in TPrincipalSearchResult format
   */
  async function searchPrincipals(
    searchPattern: string,
    limitPerType: number = 10,
    typeFilter: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null = null,
    session?: ClientSession,
  ): Promise<TPrincipalSearchResult[]> {
    if (!searchPattern || searchPattern.trim().length === 0) {
      return [];
    }

    const trimmedPattern = searchPattern.trim();
    const escapedPattern = escapeRegExp(trimmedPattern);
    const promises: Promise<TPrincipalSearchResult[]>[] = [];

    if (!typeFilter || typeFilter.includes(PrincipalType.USER)) {
      /** Note: searchUsers is imported from ~/models and needs to be passed in or implemented */
      const userFields = 'name email username avatar provider idOnTheSource role';
      /** For now, we'll use a direct query instead of searchUsers */
      const User = mongoose.models.User as Model<IUser>;
      const regex = new RegExp(escapedPattern, 'i');
      const userQuery = User.find({
        $or: [{ name: regex }, { email: regex }, { username: regex }],
      })
        .select(userFields)
        .limit(limitPerType);

      if (session) {
        userQuery.session(session);
      }

      promises.push(
        userQuery.lean<IUser[]>().then((users) =>
          users.map((user) =>
            transformUserToTPrincipalSearchResult({
              id: user._id?.toString() || '',
              name: user.name,
              email: user.email,
              username: user.username,
              avatar: user.avatar,
              provider: user.provider,
              idOnTheSource: user.idOnTheSource,
              role: user.role,
            }),
          ),
        ),
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    if (!typeFilter || typeFilter.includes(PrincipalType.GROUP)) {
      promises.push(
        findGroupsByNamePattern(trimmedPattern, null, limitPerType, session).then((groups) =>
          groups.map(transformGroupToTPrincipalSearchResult),
        ),
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    if (!typeFilter || typeFilter.includes(PrincipalType.ROLE)) {
      const Role = mongoose.models.Role as Model<IRole>;
      if (Role) {
        const regex = new RegExp(escapedPattern, 'i');
        const roleQuery = Role.find({ name: regex }).select('name').limit(limitPerType);

        if (session) {
          roleQuery.session(session);
        }

        promises.push(
          roleQuery.lean<Array<{ name: string }>>().then((roles) =>
            roles.map((role) => ({
              /** Role name as ID */
              id: role.name,
              type: PrincipalType.ROLE,
              name: role.name,
              source: 'local' as const,
              idOnTheSource: role.name,
              isAdmin: role.name === SystemRoles.ADMIN,
            })),
          ),
        );
      }
    } else {
      promises.push(Promise.resolve([]));
    }

    const results = await Promise.all(promises);
    const combined = results.flat();
    return combined;
  }

  /**
   * Removes a user from all groups they belong to.
   * @param userId - The user ID (or ObjectId) of the member to remove
   */
  async function removeUserFromAllGroups(userId: string | Types.ObjectId): Promise<void> {
    const Group = mongoose.models.Group as Model<IGroup>;
    await Group.updateMany({ memberIds: userId }, { $pullAll: { memberIds: [userId] } });
    await invalidateMemberGroupsCache([userId]);
  }

  /**
   * Finds a single group matching the given filter.
   * @param filter - MongoDB filter query
   */
  async function findGroupByQuery(
    filter: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne(filter);
    if (session) {
      query.session(session);
    }
    return query.lean<IGroup>();
  }

  /**
   * Updates a group by its ID.
   * @param groupId - The group's ObjectId
   * @param data - Fields to set via $set
   */
  async function updateGroupById(
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    if (data.memberIds === undefined) {
      return Group.findByIdAndUpdate(groupId, { $set: data }, options).lean<IGroup>();
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await Group.findByIdAndUpdate(
      groupId,
      { $set: data },
      {
        ...options,
        new: false,
      },
    ).lean<IGroup>();
    const nextMemberIds = Array.isArray(data.memberIds)
      ? data.memberIds.filter(
          (memberId): memberId is string | Types.ObjectId =>
            typeof memberId === 'string' || memberId instanceof Types.ObjectId,
        )
      : [];
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache([...(previous?.memberIds ?? []), ...nextMemberIds]),
    );
    return previous ? await findGroupById(groupId, {}, session) : null;
  }

  /**
   * Bulk-updates groups matching a filter.
   * @param filter - MongoDB filter query
   * @param update - Update operations
   * @param options - Optional query options (e.g., { session })
   */
  async function bulkUpdateGroups(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<import('mongoose').UpdateWriteOpResult> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const result = await Group.updateMany(filter, update, options || {});
    if (result.modifiedCount === 0 && result.upsertedCount === 0) {
      return result;
    }
    const { memberIds, indeterminate } = collectMemberIdsFromGroupUpdate(update);
    if (indeterminate) {
      await runAfterTransaction(options?.session, () => clearMemberGroupsCache());
    } else if (memberIds.length > 0) {
      await runAfterTransaction(options?.session, () => invalidateMemberGroupsCache(memberIds));
    }
    return result;
  }

  function buildGroupQuery(filter: {
    source?: 'local' | 'entra';
    search?: string;
  }): FilterQuery<IGroup> {
    const query: FilterQuery<IGroup> = {};
    if (filter.source) {
      query.source = filter.source;
    }
    if (filter.search) {
      const regex = new RegExp(escapeRegExp(filter.search), 'i');
      query.$or = [{ name: regex }, { email: regex }, { description: regex }];
    }
    return query;
  }

  /**
   * List groups with optional source, search, and pagination filters.
   * Results are sorted by name.
   * @param filter - Optional filter with source, search, limit, and offset fields
   * @param session - Optional MongoDB session for transactions
   */
  async function listGroups(
    filter: {
      source?: 'local' | 'entra';
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = buildGroupQuery(filter);
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    return await Group.find(query)
      .sort({ name: 1 })
      .skip(offset)
      .limit(limit)
      .session(session ?? null)
      .lean<IGroup[]>();
  }

  /**
   * Count groups matching optional source and search filters.
   * @param filter - Optional filter with source and search fields
   * @param session - Optional MongoDB session for transactions
   */
  async function countGroups(
    filter: { source?: 'local' | 'entra'; search?: string } = {},
    session?: ClientSession,
  ): Promise<number> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = buildGroupQuery(filter);
    return await Group.countDocuments(query).session(session ?? null);
  }

  /**
   * Delete a group by its ID.
   * @param groupId - The group's ObjectId
   * @param session - Optional MongoDB session for transactions
   */
  async function deleteGroup(
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await Group.findByIdAndDelete(groupId, options).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache(group?.memberIds ?? []));
    return group;
  }

  /**
   * Remove a member from a group by raw memberId string ($pull from memberIds).
   * Unlike removeUserFromGroup, this does not look up the user first.
   * @param groupId - The group's ObjectId
   * @param memberId - The raw memberId string to remove (ObjectId or idOnTheSource)
   * @param session - Optional MongoDB session for transactions
   */
  async function removeMemberById(
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    const group = await Group.findByIdAndUpdate(
      groupId,
      { $pull: { memberIds: memberId } },
      options,
    ).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([memberId]));
    return group;
  }

  return {
    findGroupById,
    findGroupByExternalId,
    findGroupsByExternalIds,
    findGroupsByNamePattern,
    findGroupsByMemberId,
    createGroup,
    upsertGroupByExternalId,
    addUserToGroup,
    removeUserFromGroup,
    removeUserFromAllGroups,
    findGroupByQuery,
    updateGroupById,
    bulkUpdateGroups,
    getUserGroups,
    getUserPrincipals,
    syncUserEntraGroups,
    searchPrincipals,
    calculateRelevanceScore,
    sortPrincipalsByRelevance,
    listGroups,
    countGroups,
    deleteGroup,
    removeMemberById,
  };
}

export type UserGroupMethods = ReturnType<typeof createUserGroupMethods>;
