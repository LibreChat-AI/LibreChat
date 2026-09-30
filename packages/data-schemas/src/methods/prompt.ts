import { randomUUID } from 'crypto';
import {
  CacheKeys,
  PermissionBits,
  ResourceType,
  SystemCategories,
  Time,
  promptCategoryValueSchema,
} from 'librechat-data-provider';
import type { Model, Types } from 'mongoose';
import type { IAclEntry, CacheStore, IPrompt, IPromptGroup, IPromptGroupDocument } from '~/types';
import { getTenantId, scopedCacheKey, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { isValidObjectIdString } from '~/utils/objectId';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

export interface PromptDeps {
  /** Removes all ACL permissions for a resource. Injected from PermissionService. */
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
  /** Returns a cache store for the given key. Injected from getLogStores. */
  getCache?: (key: string) => CacheStore | undefined;
  /** Resolves ACL principals for a user. From createUserGroupMethods. */
  getUserPrincipals: (params: {
    userId: string | Types.ObjectId;
    role?: string | null;
  }) => Promise<Array<{ principalType: string; principalId?: string | Types.ObjectId }>>;
  /** Finds resource IDs accessible to a set of principals. From createAclEntryMethods. */
  findAccessibleResources: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
  /** Finds publicly accessible resource IDs. From createAclEntryMethods. */
  findPublicResourceIds: (
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
}

/** In-flight access ID builds, so concurrent same-process misses share one resolution. */
const pendingAccessLookups = new Map<
  string,
  { generationKey: string; promise: Promise<string[]>; markStale: () => void }
>();
/** Tenant generation markers whose failed invalidation makes cache reads unsafe. */
const bypassedAccessGenerationKeys = new Set<string>();

const ACCESS_GENERATION_KEY = 'access:generation';

function isCachedIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((id) => typeof id === 'string' && isValidObjectIdString(id))
  );
}

/**
 * Reads the tenant's invalidation generation. Cached entries are keyed by it, so a
 * bump orphans every previous entry for this tenant without touching other tenants.
 * A missing marker (fresh tenant, or evicted under a Redis eviction policy) is
 * reinitialized to a fresh never-before-used value rather than falling back to
 * zero, where an evicted era's orphaned entry could still be read. Resolves
 * undefined when the marker cannot be read: guessing a generation then could
 * serve an orphaned entry, so callers must bypass the cache.
 */
async function readAccessGeneration(cache: CacheStore): Promise<string | undefined> {
  const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
  if (bypassedAccessGenerationKeys.has(generationKey)) {
    return undefined;
  }
  try {
    const value = await cache.get(generationKey);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value.toString();
    }
    const initialized = randomUUID();
    await cache.set(generationKey, initialized, Time.ONE_DAY);
    return initialized;
  } catch {
    return undefined;
  }
}

const MAX_CUSTOM_PROMPT_CATEGORIES = 200;

export interface PromptMethods {
  getPromptGroups(filter: Record<string, unknown>): Promise<
    | {
        promptGroups: Record<string, unknown>[];
        pageNumber: string;
        pageSize: string;
        pages: string;
      }
    | { message: string }
  >;
  deletePromptGroup(params: { _id: string }): Promise<{ message: string }>;
  getAllPromptGroups(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown>[] | { message: string }>;
  getListPromptGroupsByAccess(params: {
    accessibleIds?: Types.ObjectId[];
    otherParams?: Record<string, unknown>;
    limit?: number | null;
    after?: string | null;
  }): Promise<{
    object: 'list';
    data: Record<string, unknown>[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }>;
  getDistinctPromptGroupCategories(accessibleIds: Types.ObjectId[]): Promise<string[]>;
  incrementPromptGroupUsage(groupId: string): Promise<{ numberOfGenerations: number }>;
  createPromptGroup(saveData: {
    prompt: Record<string, unknown>;
    group: Record<string, unknown>;
    author: string;
    authorName: string;
  }): Promise<{ prompt: Record<string, unknown> | null; group: Record<string, unknown> }>;
  savePrompt(saveData: {
    prompt: Record<string, unknown>;
    author: string | Types.ObjectId;
  }): Promise<{ prompt: IPrompt } | { message: string }>;
  getPrompts(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown>[] | { message: string }>;
  getPrompt(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null | { message: string }>;
  getRandomPromptGroups(filter: {
    skip: number | string;
    limit: number | string;
  }): Promise<{ prompts: unknown[] } | { message: string }>;
  getPromptGroupsWithPrompts(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null | { message: string }>;
  getPromptGroup(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  getOwnedPromptGroupIds(author: string, readPrimary?: boolean): Promise<Types.ObjectId[]>;
  getPromptGroupAccessContext(params: { userId: string; role?: string }): Promise<{
    accessibleIds: Types.ObjectId[];
    publiclyAccessibleIds: Types.ObjectId[];
    ownedPromptGroupIds: Types.ObjectId[];
  }>;
  invalidatePromptGroupAccessContext(): Promise<void>;
  deletePrompt(params: {
    promptId: string | Types.ObjectId;
    groupId: string | Types.ObjectId;
  }): Promise<{ prompt: string; promptGroup?: { message: string; id: string | Types.ObjectId } }>;
  deleteUserPrompts(userId: string): Promise<void>;
  updatePromptGroup(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<IPromptGroupDocument | { message: string }>;
  makePromptProduction(promptId: string): Promise<{ message: string }>;
  updatePromptLabels(_id: string, labels: unknown): Promise<{ message: string }>;
}

export function createPromptMethods(
  mongoose: typeof import('mongoose'),
  deps: PromptDeps,
): PromptMethods {
  const { getSoleOwnedResourceIds } = deps;
  const { ObjectId } = mongoose.Types;

  /**
   * Batch-fetches production prompts for an array of prompt groups
   * and attaches them as `productionPrompt` field.
   */
  async function attachProductionPrompts(
    groups: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const Prompt = mongoose.models.Prompt as Model<IPrompt>;
    const uniqueIds = [
      ...new Set(groups.map((g) => (g.productionId as Types.ObjectId)?.toString()).filter(Boolean)),
    ];
    if (uniqueIds.length === 0) {
      return groups.map((g) => ({ ...g, productionPrompt: null }));
    }

    const prompts = await Prompt.find({ _id: { $in: uniqueIds } })
      .select('prompt')
      .lean();
    const promptMap = new Map(prompts.map((p) => [p._id.toString(), p]));

    return groups.map((g) => ({
      ...g,
      productionPrompt: g.productionId
        ? (promptMap.get((g.productionId as Types.ObjectId).toString()) ?? null)
        : null,
    }));
  }

  /**
   * Get all prompt groups with filters (no pagination).
   */
  async function getAllPromptGroups(filter: Record<string, unknown>): Promise<
    | Record<string, unknown>[]
    | {
        message: string;
      }
  > {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const { name, ...query } = filter as {
        name?: string;
        category?: string;
        [key: string]: unknown;
      };

      if (name) {
        (query as Record<string, unknown>).name = new RegExp(escapeRegExp(name), 'i');
      }
      if (!query.category) {
        delete query.category;
      } else if (query.category === SystemCategories.MY_PROMPTS) {
        delete query.category;
      } else if (query.category === SystemCategories.NO_CATEGORY) {
        query.category = '';
      } else if (query.category === SystemCategories.SHARED_PROMPTS) {
        delete query.category;
      }

      const groups = await PromptGroup.find(query)
        .sort({ numberOfGenerations: -1, updatedAt: -1, _id: 1 })
        .select(
          'name numberOfGenerations oneliner category author authorName createdAt updatedAt command productionId',
        )
        .lean();
      return await attachProductionPrompts(groups as unknown as Array<Record<string, unknown>>);
    } catch (error) {
      logger.error('Error getting all prompt groups', error);
      return { message: 'Error getting all prompt groups' };
    }
  }

  /**
   * Get prompt groups with pagination and filters.
   */
  async function getPromptGroups(filter: Record<string, unknown>): Promise<
    | {
        promptGroups: Record<string, unknown>[];
        pageNumber: string;
        pageSize: string;
        pages: string;
        message?: undefined;
      }
    | {
        message: string;
        promptGroups?: undefined;
        pageNumber?: undefined;
        pageSize?: undefined;
        pages?: undefined;
      }
  > {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const {
        pageNumber = 1,
        pageSize = 10,
        name,
        ...query
      } = filter as {
        pageNumber?: number | string;
        pageSize?: number | string;
        name?: string;
        category?: string;
        [key: string]: unknown;
      };

      const validatedPageNumber = Math.max(parseInt(String(pageNumber), 10), 1);
      const validatedPageSize = Math.max(parseInt(String(pageSize), 10), 1);

      if (name) {
        (query as Record<string, unknown>).name = new RegExp(escapeRegExp(name), 'i');
      }
      if (!query.category) {
        delete query.category;
      } else if (query.category === SystemCategories.MY_PROMPTS) {
        delete query.category;
      } else if (query.category === SystemCategories.NO_CATEGORY) {
        query.category = '';
      } else if (query.category === SystemCategories.SHARED_PROMPTS) {
        delete query.category;
      }

      const skip = (validatedPageNumber - 1) * validatedPageSize;
      const limit = validatedPageSize;

      const [groups, totalPromptGroups] = await Promise.all([
        PromptGroup.find(query)
          .sort({ numberOfGenerations: -1, updatedAt: -1, _id: 1 })
          .skip(skip)
          .limit(limit)
          .select(
            'name numberOfGenerations oneliner category productionId author authorName createdAt updatedAt',
          )
          .lean(),
        PromptGroup.countDocuments(query),
      ]);

      const promptGroups = await attachProductionPrompts(
        groups as unknown as Array<Record<string, unknown>>,
      );

      return {
        promptGroups,
        pageNumber: validatedPageNumber.toString(),
        pageSize: validatedPageSize.toString(),
        pages: Math.ceil(totalPromptGroups / validatedPageSize).toString(),
      };
    } catch (error) {
      logger.error('Error getting prompt groups', error);
      return { message: 'Error getting prompt groups' };
    }
  }

  /**
   * Delete a prompt group and its prompts, cleaning up ACL permissions.
   *
   * **Authorization is enforced upstream.** This method performs no ownership
   * check — it deletes any group by ID. Callers must gate access via
   * `canAccessPromptGroupResource` middleware before invoking this.
   */
  async function deletePromptGroup({ _id }: { _id: string }): Promise<{
    message: string;
  }> {
    const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
    const Prompt = mongoose.models.Prompt as Model<IPrompt>;

    const query: Record<string, unknown> = { _id };
    const groupQuery: Record<string, unknown> = { groupId: new ObjectId(_id) };

    const response = await PromptGroup.deleteOne(query);

    if (!response || response.deletedCount === 0) {
      throw new Error('Prompt group not found');
    }

    await Prompt.deleteMany(groupQuery);

    try {
      await deps.removeAllPermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: _id,
      });
    } catch (error) {
      logger.error('Error removing promptGroup permissions:', error);
    }

    await invalidatePromptGroupAccessContext();

    return { message: 'Prompt group deleted successfully' };
  }

  /**
   * Get prompt groups by accessible IDs with optional cursor-based pagination.
   */
  async function getListPromptGroupsByAccess({
    accessibleIds = [],
    otherParams = {},
    limit = null,
    after = null,
  }: {
    accessibleIds?: Types.ObjectId[];
    otherParams?: Record<string, unknown>;
    limit?: number | null;
    after?: string | null;
  }): Promise<{
    object: 'list';
    data: Record<string, unknown>[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }> {
    const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
    const isPaginated = limit !== null && limit !== undefined;
    const normalizedLimit = isPaginated
      ? Math.min(Math.max(1, parseInt(String(limit)) || 20), 100)
      : null;

    const baseQuery: Record<string, unknown> = {
      ...otherParams,
      _id: { $in: accessibleIds },
    };

    let matchQuery: Record<string, unknown> = baseQuery;

    if (after && typeof after === 'string' && after !== 'undefined' && after !== 'null') {
      try {
        const cursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
        const { numberOfGenerations = 0, updatedAt, _id } = cursor;

        if (
          typeof numberOfGenerations !== 'number' ||
          !Number.isFinite(numberOfGenerations) ||
          typeof updatedAt !== 'string' ||
          Number.isNaN(new Date(updatedAt).getTime()) ||
          typeof _id !== 'string' ||
          !isValidObjectIdString(_id)
        ) {
          logger.warn(
            '[getListPromptGroupsByAccess] Invalid cursor fields, skipping cursor condition',
          );
        } else {
          const cursorCondition = {
            $or: [
              { numberOfGenerations: { $lt: numberOfGenerations } },
              {
                numberOfGenerations,
                updatedAt: { $lt: new Date(updatedAt) },
              },
              {
                numberOfGenerations,
                updatedAt: new Date(updatedAt),
                _id: { $gt: new ObjectId(_id) },
              },
            ],
          };

          matchQuery =
            Object.keys(baseQuery).length > 0
              ? { $and: [baseQuery, cursorCondition] }
              : cursorCondition;
        }
      } catch (error) {
        logger.warn('Invalid cursor:', (error as Error).message);
      }
    }

    const findQuery = PromptGroup.find(matchQuery)
      .sort({ numberOfGenerations: -1, updatedAt: -1, _id: 1 })
      .select(
        'name numberOfGenerations oneliner category productionId author authorName createdAt updatedAt',
      );

    if (isPaginated && normalizedLimit) {
      findQuery.limit(normalizedLimit + 1);
    }

    const groups = await findQuery.lean();
    const promptGroups = await attachProductionPrompts(
      groups as unknown as Array<Record<string, unknown>>,
    );

    const hasMore = isPaginated && normalizedLimit ? promptGroups.length > normalizedLimit : false;
    const data = (
      isPaginated && normalizedLimit ? promptGroups.slice(0, normalizedLimit) : promptGroups
    ).map((group) => {
      if (group.author) {
        group.author = (group.author as Types.ObjectId).toString();
      }
      return group;
    });

    let nextCursor: string | null = null;
    if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
      const lastGroup = promptGroups[normalizedLimit - 1] as Record<string, unknown>;
      nextCursor = Buffer.from(
        JSON.stringify({
          numberOfGenerations: lastGroup.numberOfGenerations,
          updatedAt: (lastGroup.updatedAt as Date).toISOString(),
          _id: (lastGroup._id as Types.ObjectId).toString(),
        }),
      ).toString('base64');
    }

    return {
      object: 'list' as const,
      data,
      first_id: data.length > 0 ? (data[0]._id as Types.ObjectId).toString() : null,
      last_id: data.length > 0 ? (data[data.length - 1]._id as Types.ObjectId).toString() : null,
      has_more: hasMore,
      after: nextCursor,
    };
  }

  /**
   * Get the sorted, validated custom category values used by the given prompt groups.
   */
  async function getDistinctPromptGroupCategories(
    accessibleIds: Types.ObjectId[],
  ): Promise<string[]> {
    if (accessibleIds.length === 0) {
      return [];
    }

    const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
    const stored = await PromptGroup.distinct('category', {
      _id: { $in: accessibleIds },
      category: { $nin: ['', null] },
    });

    const values = new Set<string>();
    for (const category of stored) {
      const parsed = promptCategoryValueSchema.safeParse(category);
      if (parsed.success) {
        values.add(parsed.data);
      }
    }

    return [...values]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, MAX_CUSTOM_PROMPT_CATEGORIES);
  }

  /**
   * Increment the numberOfGenerations counter for a prompt group.
   */
  async function incrementPromptGroupUsage(groupId: string): Promise<{
    numberOfGenerations: number;
  }> {
    if (!isValidObjectIdString(groupId)) {
      throw new Error('Invalid groupId');
    }

    const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
    const result = await PromptGroup.findByIdAndUpdate(
      groupId,
      { $inc: { numberOfGenerations: 1 } },
      { new: true, select: 'numberOfGenerations' },
    ).lean();

    if (!result) {
      throw new Error('Prompt group not found');
    }

    return { numberOfGenerations: result.numberOfGenerations };
  }

  /**
   * Create a prompt and its respective group.
   */
  async function createPromptGroup(saveData: {
    prompt: Record<string, unknown>;
    group: Record<string, unknown>;
    author: string;
    authorName: string;
  }) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      const { prompt, group, author, authorName } = saveData;

      let newPromptGroup = await PromptGroup.findOneAndUpdate(
        { ...group, author, authorName, productionId: null },
        { $setOnInsert: { ...group, author, authorName, productionId: null } },
        { new: true, upsert: true },
      )
        .lean()
        .select('-__v')
        .exec();

      const newPrompt = await Prompt.findOneAndUpdate(
        { ...prompt, author, groupId: newPromptGroup!._id },
        { $setOnInsert: { ...prompt, author, groupId: newPromptGroup!._id } },
        { new: true, upsert: true },
      )
        .lean()
        .select('-__v')
        .exec();

      newPromptGroup = (await PromptGroup.findByIdAndUpdate(
        newPromptGroup!._id,
        { productionId: newPrompt!._id },
        { new: true },
      )
        .lean()
        .select('-__v')
        .exec())!;

      await invalidatePromptGroupAccessContext();

      return {
        prompt: newPrompt,
        group: {
          ...newPromptGroup,
          productionPrompt: { prompt: (newPrompt as unknown as IPrompt).prompt },
        },
      };
    } catch (error) {
      logger.error('Error saving prompt group', error);
      throw new Error('Error saving prompt group');
    }
  }

  /**
   * Save a prompt.
   */
  async function savePrompt(saveData: {
    prompt: Record<string, unknown>;
    author: string | Types.ObjectId;
  }) {
    try {
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      const { prompt, author } = saveData;
      const newPromptData = { ...prompt, author };

      let newPrompt;
      try {
        newPrompt = await Prompt.create(newPromptData);
      } catch (error: unknown) {
        if ((error as Error)?.message?.includes('groupId_1_version_1')) {
          await Prompt.db.collection('prompts').dropIndex('groupId_1_version_1');
        } else {
          throw error;
        }
        newPrompt = await Prompt.create(newPromptData);
      }

      return { prompt: newPrompt };
    } catch (error) {
      logger.error('Error saving prompt', error);
      return { message: 'Error saving prompt' };
    }
  }

  /**
   * Get prompts by filter.
   */
  async function getPrompts(filter: Record<string, unknown>) {
    try {
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      return await Prompt.find(filter).sort({ createdAt: -1 }).lean();
    } catch (error) {
      logger.error('Error getting prompts', error);
      return { message: 'Error getting prompts' };
    }
  }

  /**
   * Get a single prompt by filter.
   */
  async function getPrompt(filter: Record<string, unknown>) {
    try {
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      if (filter.groupId) {
        filter.groupId = new ObjectId(filter.groupId as string);
      }
      return await Prompt.findOne(filter).lean();
    } catch (error) {
      logger.error('Error getting prompt', error);
      return { message: 'Error getting prompt' };
    }
  }

  /**
   * Get random prompt groups from distinct categories.
   */
  async function getRandomPromptGroups(filter: { skip: number | string; limit: number | string }) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const categories = await PromptGroup.distinct('category', { category: { $ne: '' } });

      for (let i = categories.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [categories[i], categories[j]] = [categories[j], categories[i]];
      }

      const skip = +filter.skip;
      const limit = +filter.limit;
      const selectedCategories = categories.slice(skip, skip + limit);

      if (selectedCategories.length === 0) {
        return { prompts: [] };
      }

      const groups = await PromptGroup.find({ category: { $in: selectedCategories } }).lean();

      const groupByCategory = new Map<string, unknown>();
      for (const group of groups) {
        if (!groupByCategory.has(group.category)) {
          groupByCategory.set(group.category, group);
        }
      }

      const prompts = selectedCategories
        .map((cat: string) => groupByCategory.get(cat))
        .filter(Boolean);

      return { prompts };
    } catch (error) {
      logger.error('Error getting prompt groups', error);
      return { message: 'Error getting prompt groups' };
    }
  }

  /**
   * Get prompt groups with populated prompts.
   */
  async function getPromptGroupsWithPrompts(filter: Record<string, unknown>) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      return await PromptGroup.findOne(filter)
        .populate({
          path: 'prompts',
          select: '-_id -__v -user',
        })
        .select('-_id -__v -user')
        .lean();
    } catch (error) {
      logger.error('Error getting prompt groups', error);
      return { message: 'Error getting prompt groups' };
    }
  }

  /**
   * Get a single prompt group by filter, with productionPrompt populated via $lookup.
   */
  async function getPromptGroup(filter: Record<string, unknown>) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      // Cast string _id to ObjectId for aggregation (findOne auto-casts, aggregate does not)
      const matchFilter = { ...filter };
      if (typeof matchFilter._id === 'string') {
        matchFilter._id = new ObjectId(matchFilter._id);
      }
      const tenantId = getTenantId();
      const useTenantFilter = tenantId && tenantId !== SYSTEM_TENANT_ID;

      const result = await PromptGroup.aggregate([
        { $match: matchFilter },
        {
          $lookup: {
            from: 'prompts',
            localField: 'productionId',
            foreignField: '_id',
            as: 'productionPrompt',
          },
        },
        { $unwind: { path: '$productionPrompt', preserveNullAndEmptyArrays: true } },
      ]);
      const group = result[0] || null;
      if (
        group?.productionPrompt &&
        useTenantFilter &&
        group.productionPrompt.tenantId !== tenantId
      ) {
        group.productionPrompt = null;
      }
      if (group?.author) {
        group.author = group.author.toString();
      }
      return group;
    } catch (error) {
      logger.error('Error getting prompt group', error);
      return null;
    }
  }

  /**
   * Returns the _id values of all prompt groups authored by the given user.
   * Used by the "Shared Prompts" and "My Prompts" filters to distinguish
   * owned prompts from prompts shared with the user.
   */
  async function getOwnedPromptGroupIds(author: string, readPrimary = false) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      if (!author || !ObjectId.isValid(author)) {
        logger.warn('getOwnedPromptGroupIds called with invalid author', { author });
        return [];
      }
      const groupsQuery = PromptGroup.find({ author: new ObjectId(author) }, { _id: 1 });
      if (readPrimary) {
        /**
         * Cache builds must not capture a lagging secondary's pre-mutation state
         * for the full TTL (`secondaryPreferred` deployments).
         */
        groupsQuery.read('primary');
      }
      const groups = await groupsQuery.lean();
      return groups.map((g) => g._id);
    } catch (error) {
      logger.error('Error getting owned prompt group IDs', error);
      /** A failed lookup must not be cached as an empty ownership set */
      throw error;
    }
  }

  /**
   * Resolves one prompt group ID set from the PROMPT_GROUPS_ACCESS cache, building
   * it on miss. Entries are stored as hex strings and revived to ObjectIds on read;
   * concurrent same-process misses share a single build, which invalidation marks
   * stale so a pre-mutation build never writes its IDs back into the cache.
   */
  async function resolveCachedIds(
    cacheKey: string,
    generationKey: string,
    build: () => Promise<Types.ObjectId[]>,
  ): Promise<Types.ObjectId[]> {
    const cache = deps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    if (!cache) {
      return build();
    }

    try {
      const cached = await cache.get(cacheKey);
      if (isCachedIdArray(cached)) {
        return cached.map((id) => new ObjectId(id));
      }
    } catch {
      /** Cache failures must not block access resolution. */
    }

    const pending = pendingAccessLookups.get(cacheKey);
    if (pending) {
      const ids = await pending.promise;
      return ids.map((id) => new ObjectId(id));
    }

    let stale = false;
    const lookup = (async () => {
      const ids = await build();
      if (!stale) {
        try {
          await cache.set(
            cacheKey,
            ids.map((id) => id.toString()),
          );
        } catch {
          /** Cache write failures only cost a rebuild on the next request. */
        }
      }
      return ids.map((id) => id.toString());
    })();

    pendingAccessLookups.set(cacheKey, {
      generationKey,
      promise: lookup,
      markStale: () => {
        stale = true;
      },
    });
    try {
      const ids = await lookup;
      return ids.map((id) => new ObjectId(id));
    } finally {
      if (pendingAccessLookups.get(cacheKey)?.promise === lookup) {
        pendingAccessLookups.delete(cacheKey);
      }
    }
  }

  /**
   * Resolves the prompt group access ID sets shared by the list endpoints:
   * user-accessible, publicly accessible, and user-owned group IDs.
   *
   * The public set is identical for every user of a tenant and the per-user sets
   * only change on prompt or permission mutations. Hosts may cache all three in
   * the PROMPT_GROUPS_ACCESS namespace to spare overlapping requests the repeated
   * ACL queries. Hosts that cannot guarantee shared invalidation can use a no-op
   * store so authorization IDs are always rebuilt.
   */
  async function getPromptGroupAccessContext({
    userId,
    role,
  }: {
    userId: string;
    role?: string;
  }): Promise<{
    accessibleIds: Types.ObjectId[];
    publiclyAccessibleIds: Types.ObjectId[];
    ownedPromptGroupIds: Types.ObjectId[];
  }> {
    const cache = deps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    /**
     * Keys carry the tenant's invalidation generation, so a bump orphans every
     * cached set for this tenant, including late writes from in-flight builds,
     * without clearing other tenants' entries in the shared namespace. Builds
     * read the primary so a lagging secondary cannot pin pre-mutation IDs for
     * the full TTL.
     */
    const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
    const generation = cache ? await readAccessGeneration(cache) : '0';
    const buildAccessible = async (): Promise<Types.ObjectId[]> => {
      const principalsList = await deps.getUserPrincipals({ userId, role });
      if (principalsList.length === 0) {
        return [];
      }
      return deps.findAccessibleResources(
        principalsList,
        ResourceType.PROMPTGROUP,
        PermissionBits.VIEW,
        undefined,
        true,
      );
    };
    const buildPublic = () =>
      deps.findPublicResourceIds(ResourceType.PROMPTGROUP, PermissionBits.VIEW, undefined, true);
    const buildOwned = () => getOwnedPromptGroupIds(userId, true);

    if (generation === undefined) {
      /** The marker could not be read; guessing a generation could serve an orphaned entry */
      const [accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
        buildAccessible(),
        buildPublic(),
        buildOwned(),
      ]);
      return { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds };
    }

    const scopedKey = (key: string) => scopedCacheKey(`access:${generation}:${key}`);

    const accessibleIds = await resolveCachedIds(
      scopedKey(`user:${userId}:${role ?? ''}`),
      generationKey,
      buildAccessible,
    );

    const [publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
      resolveCachedIds(scopedKey('public'), generationKey, buildPublic),
      resolveCachedIds(scopedKey(`owned:${userId}`), generationKey, buildOwned),
    ]);

    return { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds };
  }

  /**
   * Invalidates all cached prompt group access ID sets for the active tenant after
   * a mutation that can change them (group create/delete, permission grants/revokes,
   * membership changes). Bumping the generation orphans cached entries and any
   * writes still in flight from pre-mutation builds, including in other processes
   * sharing the store, while other tenants' entries stay intact. In-flight builds
   * in this process are additionally marked stale so they skip their cache write.
   * The old generation marker is removed before its replacement is written. If
   * neither operation succeeds, reads bypass this tenant's cache and the mutation
   * rejects instead of allowing the old authorization era to remain authoritative.
   */
  async function invalidatePromptGroupAccessContext(): Promise<void> {
    const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
    for (const [cacheKey, pending] of pendingAccessLookups) {
      if (pending.generationKey !== generationKey) {
        continue;
      }
      pending.markStale();
      pendingAccessLookups.delete(cacheKey);
    }
    const cache = deps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    if (!cache) {
      return;
    }
    let markerRemoved = false;
    if (cache.delete) {
      try {
        const deleteResult = await cache.delete(generationKey);
        markerRemoved = deleteResult !== false;
        if (!markerRemoved) {
          logger.warn('The previous prompt group access generation was not removed');
        }
      } catch (error) {
        logger.warn('Failed to remove the previous prompt group access generation', error);
      }
    }
    try {
      /**
       * A collision-resistant token cannot repeat an evicted era or be restored
       * by a delayed initializer that selected a different token before this write.
       */
      /**
       * Keep the marker longer than derived entries so normal expiry does not
       * orphan a warm cache era and force avoidable access-query rebuilds.
       */
      const setResult = await cache.set(generationKey, randomUUID(), Time.ONE_DAY);
      if (setResult === false) {
        throw new Error('Prompt group access generation write failed');
      }
      bypassedAccessGenerationKeys.delete(generationKey);
    } catch (error) {
      if (markerRemoved) {
        bypassedAccessGenerationKeys.delete(generationKey);
        logger.warn('Failed to restore the removed prompt group access generation', error);
        return;
      }
      bypassedAccessGenerationKeys.add(generationKey);
      logger.warn('Failed to invalidate prompt group access cache', error);
      throw error;
    }
  }

  /**
   * Delete a prompt, potentially removing the group if it's the last prompt.
   *
   * **Authorization is enforced upstream.** This method performs no ownership
   * check — it deletes any prompt by ID. Callers must gate access via
   * `canAccessPromptViaGroup` middleware before invoking this.
   */
  async function deletePrompt({
    promptId,
    groupId,
  }: {
    promptId: string | Types.ObjectId;
    groupId: string | Types.ObjectId;
  }) {
    const Prompt = mongoose.models.Prompt as Model<IPrompt>;
    const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;

    const query: Record<string, unknown> = { _id: promptId, groupId };
    const { deletedCount } = await Prompt.deleteOne(query);
    if (deletedCount === 0) {
      throw new Error('Failed to delete the prompt');
    }

    const remainingPrompts = await Prompt.find({ groupId })
      .select('_id')
      .sort({ createdAt: 1 })
      .lean();

    if (remainingPrompts.length === 0) {
      try {
        await deps.removeAllPermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: groupId,
        });
      } catch (error) {
        logger.error('Error removing promptGroup permissions:', error);
      }

      await PromptGroup.deleteOne({ _id: groupId });

      await invalidatePromptGroupAccessContext();

      return {
        prompt: 'Prompt deleted successfully',
        promptGroup: {
          message: 'Prompt group deleted successfully',
          id: groupId,
        },
      };
    } else {
      const promptGroup = (await PromptGroup.findById(
        groupId,
      ).lean()) as unknown as IPromptGroup | null;
      if (promptGroup && promptGroup.productionId?.toString() === promptId.toString()) {
        await PromptGroup.updateOne(
          { _id: groupId },
          { productionId: remainingPrompts[remainingPrompts.length - 1]._id },
        );
      }

      return { prompt: 'Prompt deleted successfully' };
    }
  }

  /**
   * Delete all prompts and prompt groups created by a specific user.
   */
  /**
   * Deletes prompt groups solely owned by the user and cleans up their prompts/ACLs.
   * Groups with other owners are left intact; the caller is responsible for
   * removing the user's own ACL principal entries separately.
   *
   * Also handles legacy (pre-ACL) prompt groups that only have the author field set,
   * ensuring they are not orphaned if the permission migration has not been run.
   */
  async function deleteUserPrompts(userId: string) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;

      const userObjectId = new ObjectId(userId);
      const soleOwnedIds = await getSoleOwnedResourceIds(userObjectId, ResourceType.PROMPTGROUP);

      const authoredGroups = await PromptGroup.find({ author: userObjectId }).select('_id').lean();
      const authoredGroupIds = authoredGroups.map((g) => g._id);

      const migratedEntries =
        authoredGroupIds.length > 0
          ? await AclEntry.find({
              resourceType: ResourceType.PROMPTGROUP,
              resourceId: { $in: authoredGroupIds },
            })
              .select('resourceId')
              .lean()
          : [];
      const migratedIds = new Set(migratedEntries.map((e) => e.resourceId.toString()));
      const legacyGroupIds = authoredGroupIds.filter((id) => !migratedIds.has(id.toString()));

      const allGroupIdsToDelete = [...soleOwnedIds, ...legacyGroupIds];

      if (allGroupIdsToDelete.length === 0) {
        return;
      }

      await AclEntry.deleteMany({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: { $in: allGroupIdsToDelete },
      });

      await PromptGroup.deleteMany({ _id: { $in: allGroupIdsToDelete } });
      await Prompt.deleteMany({ groupId: { $in: allGroupIdsToDelete } });
      await invalidatePromptGroupAccessContext();
    } catch (error) {
      logger.error('[deleteUserPrompts] General error:', error);
    }
  }

  /**
   * Update a prompt group.
   */
  async function updatePromptGroup(filter: Record<string, unknown>, data: Record<string, unknown>) {
    try {
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
      const updateOps = {};
      const updateData = { ...data, ...updateOps };
      const updatedDoc = await PromptGroup.findOneAndUpdate(filter, updateData, {
        new: true,
        upsert: false,
      });

      if (!updatedDoc) {
        throw new Error('Prompt group not found');
      }

      return updatedDoc;
    } catch (error) {
      logger.error('Error updating prompt group', error);
      return { message: 'Error updating prompt group' };
    }
  }

  /**
   * Make a prompt the production prompt for its group.
   */
  async function makePromptProduction(promptId: string) {
    try {
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      const PromptGroup = mongoose.models.PromptGroup as Model<IPromptGroupDocument>;

      const prompt = await Prompt.findById(promptId).lean();

      if (!prompt) {
        throw new Error('Prompt not found');
      }

      await PromptGroup.findByIdAndUpdate(
        prompt.groupId,
        { productionId: prompt._id },
        { new: true },
      )
        .lean()
        .exec();

      return { message: 'Prompt production made successfully' };
    } catch (error) {
      logger.error('Error making prompt production', error);
      return { message: 'Error making prompt production' };
    }
  }

  /**
   * Update prompt labels.
   */
  async function updatePromptLabels(
    _id: string,
    labels: unknown,
  ): Promise<{
    message: string;
  }> {
    try {
      const Prompt = mongoose.models.Prompt as Model<IPrompt>;
      const response = await Prompt.updateOne({ _id }, { $set: { labels } });
      if (response.matchedCount === 0) {
        return { message: 'Prompt not found' };
      }
      return { message: 'Prompt labels updated successfully' };
    } catch (error) {
      logger.error('Error updating prompt labels', error);
      return { message: 'Error updating prompt labels' };
    }
  }

  return {
    getPromptGroups,
    deletePromptGroup,
    getAllPromptGroups,
    getListPromptGroupsByAccess,
    getDistinctPromptGroupCategories,
    incrementPromptGroupUsage,
    createPromptGroup,
    savePrompt,
    getPrompts,
    getPrompt,
    getRandomPromptGroups,
    getPromptGroupsWithPrompts,
    getPromptGroup,
    getOwnedPromptGroupIds,
    getPromptGroupAccessContext,
    invalidatePromptGroupAccessContext,
    deletePrompt,
    deleteUserPrompts,
    updatePromptGroup,
    makePromptProduction,
    updatePromptLabels,
  };
}
