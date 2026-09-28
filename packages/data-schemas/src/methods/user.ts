import mongoose, { FilterQuery } from 'mongoose';
import {
  AUTH_USER_DOC_BY_ID_PREFIX,
  CacheKeys,
  type RefillIntervalUnit,
  type StatefulCodeEnvironment,
} from 'librechat-data-provider';
import type { IUser, BalanceConfig, CreateUserRequest, UserDeleteResult } from '~/types';
import type { CacheStore } from '~/types';
import { escapeRegExp } from '~/utils/string';
import { signPayload } from '~/crypto';

/** Default JWT session expiry: 15 minutes in milliseconds */
export const DEFAULT_SESSION_EXPIRY: number = 1000 * 60 * 15;
/** Minimum age before an explicitly offline operator may recover an abandoned deletion fence. */
export const USER_DELETION_FENCE_STALE_MS: number = 15 * 60_000;
/** Bounds concurrent bulk deletions held for one owner at any moment. */
const MAX_SUBAGENT_ADMISSION_FENCES = 32;

interface UserMethodDeps {
  getCache?: (key: string) => CacheStore | undefined;
}

function isAuthUserDocCacheEnabled(): boolean {
  return process.env.AUTH_USER_CACHE_MODE === 'on';
}

/** Factory function that takes mongoose instance and returns the methods */
export function createUserMethods(
  mongoose: typeof import('mongoose'),
  deps: UserMethodDeps = {},
): {
  findUser: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IUser | null>;
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  createUser: (
    data: CreateUserRequest,
    balanceConfig?: BalanceConfig,
    disableTTL?: boolean,
    returnUser?: boolean,
  ) => Promise<mongoose.Types.ObjectId | Partial<IUser>>;
  updateUser: (userId: string, updateData: Partial<IUser>) => Promise<IUser | null>;
  claimSamlIdentity: (
    userId: string,
    samlId: string,
    profileData: Pick<Partial<IUser>, 'username' | 'name'>,
  ) => Promise<IUser | null>;
  acceptTerms: (userId: string) => Promise<IUser | null>;
  searchUsers: ({
    searchPattern,
    limit,
    fieldsToSelect,
  }: {
    searchPattern: string;
    limit?: number;
    fieldsToSelect?: string | string[] | null;
  }) => Promise<
    {
      _id: mongoose.Types.ObjectId;
      id: string;
      name?: string;
      username?: string;
      email: string;
      emailVerified: boolean;
      password?: string;
      avatar?: string;
      provider: string;
      role?: string;
      googleId?: string;
      facebookId?: string;
      openidId?: string;
      samlId?: string;
      ldapId?: string;
      githubId?: string;
      discordId?: string;
      appleId?: string;
      plugins?: string[];
      openidIssuer?: string;
      twoFactorEnabled?: boolean;
      totpSecret?: string;
      backupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      pendingTotpSecret?: string;
      pendingBackupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      refreshToken?: Array<{
        refreshToken: string;
      }>;
      expiresAt?: Date;
      termsAccepted?: boolean;
      personalization?: {
        memories?: boolean;
        statefulCodeEnvironment?: import('librechat-data-provider').StatefulCodeEnvironment;
      };
      favorites?: import('librechat-data-provider').TUserFavorite[];
      skillStates?: Record<string, boolean>;
      createdAt?: Date;
      updatedAt?: Date;
      idOnTheSource?: string;
      tenantId?: string;
      federatedTokens?: import('~/types').OIDCTokens;
      openidTokens?: import('~/types').OIDCTokens;
      $locals: Record<string, unknown>;
      $op: 'save' | 'validate' | 'remove' | null;
      $where: Record<string, unknown>;
      baseModelName?: string;
      collection: mongoose.Collection;
      db: mongoose.Connection;
      errors?: mongoose.Error.ValidationError;
      isNew: boolean;
      schema: mongoose.Schema;
    }[]
  >;
  getUserById: (userId: string, fieldsToSelect?: string | string[] | null) => Promise<IUser | null>;
  generateToken: (user: IUser, expiresIn?: number) => Promise<string>;
  beginAgentTriggerUserDeletion: (
    userId: string,
    startedAt: Date,
  ) => Promise<'acquired' | 'in_progress' | 'missing'>;
  recoverStaleAgentTriggerUserDeletion: (
    userId: string,
    recoveredAt: Date,
  ) => Promise<'acquired' | 'in_progress' | 'missing'>;
  cancelAgentTriggerUserDeletion: (userId: string, startedAt: Date) => Promise<boolean>;
  isAgentTriggerPrincipalActive: (userId: string) => Promise<boolean>;
  fenceSubagentAdmission: (userId: string, token: string, fencedUntil: Date) => Promise<void>;
  renewSubagentAdmission: (userId: string, token: string, fencedUntil: Date) => Promise<boolean>;
  releaseSubagentAdmission: (userId: string, token: string) => Promise<void>;
  isSubagentOwnerAdmissible: (userId: string) => Promise<boolean>;
  deleteUserById: (userId: string) => Promise<UserDeleteResult>;
  updateUserPlugins: (
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ) => Promise<IUser | null>;
  toggleUserMemories: (userId: string, memoriesEnabled: boolean) => Promise<IUser | null>;
  updateUserStatefulCodeEnvironment: (
    userId: string,
    environment: StatefulCodeEnvironment,
  ) => Promise<IUser | null>;
} {
  /**
   * Normalizes email fields in search criteria to lowercase and trimmed.
   * Handles both direct email fields and $or arrays containing email conditions.
   */
  function normalizeEmailInCriteria<T extends FilterQuery<IUser>>(criteria: T): T {
    const normalized = { ...criteria };
    if (typeof normalized.email === 'string') {
      normalized.email = normalized.email.trim().toLowerCase();
    }
    if (Array.isArray(normalized.$or)) {
      normalized.$or = normalized.$or.map((condition) => {
        if (typeof condition.email === 'string') {
          return { ...condition, email: condition.email.trim().toLowerCase() };
        }
        return condition;
      });
    }
    return normalized;
  }

  /**
   * Search for a single user based on partial data and return matching user document as plain object.
   * Email fields in searchCriteria are automatically normalized to lowercase for case-insensitive matching.
   */
  async function findUser(
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ): Promise<IUser | null> {
    const User = mongoose.models.User as mongoose.Model<IUser>;
    const normalizedCriteria = normalizeEmailInCriteria(searchCriteria);
    const query = User.findOne(normalizedCriteria);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    return await query.lean<IUser>();
  }

  async function findUsers(
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ): Promise<IUser[]> {
    const User = mongoose.models.User as mongoose.Model<IUser>;
    const normalizedCriteria = normalizeEmailInCriteria(searchCriteria);
    const query = User.find(normalizedCriteria);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    if (options?.sort != null) {
      query.sort(options.sort);
    }
    if (options?.offset != null) {
      query.skip(options.offset);
    }
    if (options?.limit != null && options.limit > 0) {
      query.limit(options.limit);
    }
    return await query.lean<IUser[]>();
  }

  /**
   * Count the number of user documents in the collection based on the provided filter.
   */
  async function countUsers(filter: FilterQuery<IUser> = {}): Promise<number> {
    const User = mongoose.models.User;
    return await User.countDocuments(filter);
  }

  /**
   * Creates a new user, optionally with a TTL of 1 week.
   */
  async function createUser(
    data: CreateUserRequest,
    balanceConfig?: BalanceConfig,
    disableTTL: boolean = true,
    returnUser: boolean = false,
  ): Promise<mongoose.Types.ObjectId | Partial<IUser>> {
    const User = mongoose.models.User;
    const Balance = mongoose.models.Balance;

    const userData: Partial<IUser> = {
      ...data,
      expiresAt: disableTTL ? undefined : new Date(Date.now() + 604800 * 1000), // 1 week in milliseconds
    };

    if (disableTTL) {
      delete userData.expiresAt;
    }

    const user = await User.create(userData);

    // If balance is enabled, create or update a balance record for the user
    if (balanceConfig?.enabled && balanceConfig?.startBalance) {
      const update: {
        $inc: { tokenCredits: number };
        $set?: {
          autoRefillEnabled: boolean;
          refillIntervalValue: number;
          refillIntervalUnit: RefillIntervalUnit;
          refillAmount: number;
        };
      } = {
        $inc: { tokenCredits: balanceConfig.startBalance },
      };

      if (
        balanceConfig.autoRefillEnabled &&
        balanceConfig.refillIntervalValue != null &&
        balanceConfig.refillIntervalUnit != null &&
        balanceConfig.refillAmount != null
      ) {
        update.$set = {
          autoRefillEnabled: true,
          refillIntervalValue: balanceConfig.refillIntervalValue,
          refillIntervalUnit: balanceConfig.refillIntervalUnit,
          refillAmount: balanceConfig.refillAmount,
        };
      }

      await Balance.findOneAndUpdate(
        { _id: user._id },
        { ...update, $setOnInsert: { user: user._id } },
        { upsert: true, new: true },
      ).lean();
    }

    if (returnUser) {
      return user.toObject() as Partial<IUser>;
    }
    return user._id as mongoose.Types.ObjectId;
  }

  /**
   * Update a user with new data without overwriting existing properties.
   */
  async function updateUser(userId: string, updateData: Partial<IUser>): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updateOperation = {
      $set: updateData,
      $unset: { expiresAt: '' }, // Remove the expiresAt field to prevent TTL
    };
    const updated = await User.findByIdAndUpdate(userId, updateOperation, {
      new: true,
      runValidators: true,
    }).lean<IUser>();
    await invalidateAuthUserDocCache(userId);
    return updated;
  }

  /** Atomically updates a SAML user only when the incoming identity can claim the document. */
  async function claimSamlIdentity(
    userId: string,
    samlId: string,
    profileData: Pick<Partial<IUser>, 'username' | 'name'>,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updated = await User.findOneAndUpdate(
      {
        _id: userId,
        provider: 'saml',
        $or: [{ samlId }, { samlId: { $exists: false } }, { samlId: null }, { samlId: '' }],
      },
      {
        $set: { ...profileData, samlId },
        $unset: { expiresAt: '' },
      },
      { new: true, runValidators: true },
    ).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  async function invalidateAuthUserDocCache(userId: string): Promise<void> {
    if (!isAuthUserDocCacheEnabled()) {
      return;
    }
    const cache = deps.getCache?.(CacheKeys.AUTH_USER_DOC);
    if (!cache?.get || !cache?.delete) {
      return;
    }
    try {
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      const cachedKeys = await cache.get(indexKey);
      if (Array.isArray(cachedKeys)) {
        await Promise.all(
          cachedKeys.map((key) => (typeof key === 'string' ? cache.delete?.(key) : undefined)),
        );
      }
      await cache.delete(indexKey);
    } catch {
      // Cache invalidation must not make a user update fail.
    }
  }

  /**
   * Atomically records terms acceptance for a user.
   * A null-guarded claim stamps termsAcceptedAt only when no timestamp is
   * already stored (explicit null from the schema default, a missing legacy
   * field, or a terms reset), so the first acceptance within a terms cycle is
   * preserved across concurrent or repeated requests. The repeat-acceptance
   * fallback is guarded by the exact complement (a non-null timestamp) so it
   * can never resurrect termsAccepted into a cycle that config/reset-terms.js
   * started between the two updates; when both guards miss because a reset
   * raced in, the claim retries and records a fresh stamped acceptance. Plain
   * updates are used instead of an aggregation pipeline with $$NOW, which
   * Amazon DocumentDB rejects.
   */
  async function acceptTerms(userId: string): Promise<IUser | null> {
    const User = mongoose.models.User;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const firstAcceptance = await User.findOneAndUpdate(
        { _id: userId, termsAcceptedAt: null },
        { $set: { termsAccepted: true, termsAcceptedAt: new Date() } },
        { new: true, runValidators: true },
      ).lean<IUser>();
      if (firstAcceptance) {
        await invalidateAuthUserDocCache(userId);
        return firstAcceptance;
      }
      const reacceptance = await User.findOneAndUpdate(
        { _id: userId, termsAcceptedAt: { $ne: null } },
        { $set: { termsAccepted: true } },
        { new: true, runValidators: true },
      ).lean<IUser>();
      if (reacceptance) {
        await invalidateAuthUserDocCache(userId);
        return reacceptance;
      }
      const exists = await User.exists({ _id: userId });
      if (!exists) {
        return null;
      }
    }
    return null;
  }

  /**
   * Retrieve a user by ID and convert the found user document to a plain object.
   */
  async function getUserById(
    userId: string,
    fieldsToSelect?: string | string[] | null,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const query = User.findById(userId);
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    return await query.lean<IUser>();
  }

  /**
   * Delete a user by their unique ID.
   */
  async function deleteUserById(userId: string): Promise<UserDeleteResult> {
    try {
      const User = mongoose.models.User;
      const result = await User.deleteOne({ _id: userId });
      if (result.deletedCount === 0) {
        return { deletedCount: 0, message: 'No user found with that ID.' };
      }
      await invalidateAuthUserDocCache(userId);
      return { deletedCount: result.deletedCount, message: 'User was deleted successfully.' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error('Error deleting user: ' + errorMessage);
    }
  }

  /** Establishes the durable admission fence used while account deletion drains triggers. */
  async function beginAgentTriggerUserDeletion(
    userId: string,
    startedAt: Date,
  ): Promise<'acquired' | 'in_progress' | 'missing'> {
    if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
      throw new TypeError('startedAt must be a valid Date');
    }
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, agentTriggerDeletionStartedAt: { $exists: false } },
      { $set: { agentTriggerDeletionStartedAt: startedAt } },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return 'acquired';
    }
    return (await User.exists({ _id: userId })) == null ? 'missing' : 'in_progress';
  }

  /** Replaces an abandoned fence only for an operator-confirmed offline deployment.
   * Normal request paths must never call this: age alone cannot prove the prior owner died. */
  async function recoverStaleAgentTriggerUserDeletion(
    userId: string,
    recoveredAt: Date,
  ): Promise<'acquired' | 'in_progress' | 'missing'> {
    if (!(recoveredAt instanceof Date) || !Number.isFinite(recoveredAt.getTime())) {
      throw new TypeError('recoveredAt must be a valid Date');
    }
    const User = mongoose.models.User;
    const staleBefore = new Date(recoveredAt.getTime() - USER_DELETION_FENCE_STALE_MS);
    const result = await User.updateOne(
      { _id: userId, agentTriggerDeletionStartedAt: { $lte: staleBefore } },
      { $set: { agentTriggerDeletionStartedAt: recoveredAt } },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return 'acquired';
    }
    return (await User.exists({ _id: userId })) == null ? 'missing' : 'in_progress';
  }

  /** Releases only the account-deletion attempt that owns this exact fence. */
  async function cancelAgentTriggerUserDeletion(userId: string, startedAt: Date): Promise<boolean> {
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, agentTriggerDeletionStartedAt: startedAt },
      { $unset: { agentTriggerDeletionStartedAt: 1 } },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
      return true;
    }
    return false;
  }

  async function isAgentTriggerPrincipalActive(userId: string): Promise<boolean> {
    const User = mongoose.models.User;
    return (
      (await User.exists({ _id: userId, agentTriggerDeletionStartedAt: { $exists: false } })) !=
      null
    );
  }

  /**
   * Closes subagent admission for one owner while a bulk conversation deletion drains
   * its live children. Every concurrent deletion holds its own fence, so admission
   * reopens only once the last one finishes, in whatever order they complete. Each
   * fence expires on its own, so a process that dies mid-delete cannot lock the
   * account out of running subagents, and expired fences are pruned as new ones
   * arrive rather than accumulating.
   */
  async function fenceSubagentAdmission(
    userId: string,
    token: string,
    fencedUntil: Date,
  ): Promise<void> {
    if (!(fencedUntil instanceof Date) || !Number.isFinite(fencedUntil.getTime())) {
      throw new TypeError('fencedUntil must be a valid Date');
    }
    if (token.length === 0 || token.length > 128) {
      throw new TypeError('A subagent admission fence needs a bounded owner token');
    }
    const User = mongoose.models.User;
    /** Plain update operators only: DocumentDB rejects pipeline-form updates, and
     * this runs before any deletion, so using one would fail the whole endpoint. */
    await User.updateOne(
      { _id: userId },
      { $pull: { subagentAdmissionFences: { expiresAt: { $lte: new Date() } } } },
      { timestamps: false },
    );
    try {
      /** Admitted only while the owner is under the concurrent-deletion cap. Dropping
       * an active fence to make room would reopen admission for a deletion that is
       * still running, so an excess deletion is refused instead. */
      const fenced = await User.updateOne(
        {
          _id: userId,
          [`subagentAdmissionFences.${MAX_SUBAGENT_ADMISSION_FENCES - 1}`]: { $exists: false },
        },
        { $push: { subagentAdmissionFences: { token, expiresAt: fencedUntil } } },
        { timestamps: false },
      );
      if (fenced.matchedCount !== 1) {
        throw new Error('Too many concurrent bulk deletions are already fencing this owner.');
      }
    } finally {
      /** The prune above commits on its own, so a refused or failed fence still leaves
       * the cached document describing entries the collection no longer holds. */
      await invalidateAuthUserDocCache(userId);
    }
  }

  /** Extends only this deletion's own fence while its work is still running. */
  async function renewSubagentAdmission(
    userId: string,
    token: string,
    fencedUntil: Date,
  ): Promise<boolean> {
    if (!(fencedUntil instanceof Date) || !Number.isFinite(fencedUntil.getTime())) {
      throw new TypeError('fencedUntil must be a valid Date');
    }
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId, 'subagentAdmissionFences.token': token },
      { $set: { 'subagentAdmissionFences.$.expiresAt': fencedUntil } },
      { timestamps: false },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
    }
    return result.matchedCount === 1;
  }

  /** Lifts only this deletion's fence, so an overlapping one keeps admission closed. */
  async function releaseSubagentAdmission(userId: string, token: string): Promise<void> {
    const User = mongoose.models.User;
    const result = await User.updateOne(
      { _id: userId },
      { $pull: { subagentAdmissionFences: { token } } },
      { timestamps: false },
    );
    if (result.modifiedCount === 1) {
      await invalidateAuthUserDocCache(userId);
    }
  }

  /** True while this owner may admit a new child: no account deletion, no live fence. */
  async function isSubagentOwnerAdmissible(userId: string): Promise<boolean> {
    const User = mongoose.models.User;
    return (
      (await User.exists({
        _id: userId,
        agentTriggerDeletionStartedAt: { $exists: false },
        subagentAdmissionFences: { $not: { $elemMatch: { expiresAt: { $gt: new Date() } } } },
      })) != null
    );
  }

  /**
   * Generates a JWT token for a given user.
   * @param user - The user object
   * @param expiresIn - Optional expiry time in milliseconds. Default: 15 minutes
   */
  async function generateToken(user: IUser, expiresIn?: number): Promise<string> {
    if (!user) {
      throw new Error('No user provided');
    }

    const expires = expiresIn ?? DEFAULT_SESSION_EXPIRY;

    return await signPayload({
      payload: {
        id: user._id,
        username: user.username,
        provider: user.provider,
        email: user.email,
      },
      secret: process.env.JWT_SECRET,
      expirationTime: expires / 1000,
    });
  }

  /**
   * Update a user's personalization memories setting.
   * Handles the edge case where the personalization object doesn't exist.
   */
  async function toggleUserMemories(
    userId: string,
    memoriesEnabled: boolean,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;

    // First, ensure the personalization object exists
    const user = await User.findById(userId);
    if (!user) {
      return null;
    }

    // Use $set to update the nested field, which will create the personalization object if it doesn't exist
    const updateOperation = {
      $set: {
        'personalization.memories': memoriesEnabled,
      },
    };

    const updated = await User.findByIdAndUpdate(userId, updateOperation, {
      new: true,
      runValidators: true,
    }).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  async function updateUserStatefulCodeEnvironment(
    userId: string,
    environment: StatefulCodeEnvironment,
  ): Promise<IUser | null> {
    const User = mongoose.models.User;
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { 'personalization.statefulCodeEnvironment': environment } },
      { new: true, runValidators: true },
    ).lean<IUser>();
    if (updated) {
      await invalidateAuthUserDocCache(userId);
    }
    return updated;
  }

  /**
   * Search for users by pattern matching on name, email, or username (case-insensitive)
   * @param searchPattern - The pattern to search for
   * @param limit - Maximum number of results to return
   * @param fieldsToSelect - The fields to include or exclude in the returned documents
   * @returns Array of matching user documents
   */
  const searchUsers = async function ({
    searchPattern,
    limit = 20,
    fieldsToSelect = null,
  }: {
    searchPattern: string;
    limit?: number;
    fieldsToSelect?: string | string[] | null;
  }): Promise<
    {
      _id: mongoose.Types.ObjectId;
      id: string;
      name?: string;
      username?: string;
      email: string;
      emailVerified: boolean;
      password?: string;
      avatar?: string;
      provider: string;
      role?: string;
      googleId?: string;
      facebookId?: string;
      openidId?: string;
      samlId?: string;
      ldapId?: string;
      githubId?: string;
      discordId?: string;
      appleId?: string;
      plugins?: string[];
      openidIssuer?: string;
      twoFactorEnabled?: boolean;
      totpSecret?: string;
      backupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      pendingTotpSecret?: string;
      pendingBackupCodes?: Array<{
        codeHash: string;
        used: boolean;
        usedAt?: Date | null;
      }>;
      refreshToken?: Array<{
        refreshToken: string;
      }>;
      expiresAt?: Date;
      termsAccepted?: boolean;
      personalization?: {
        memories?: boolean;
        statefulCodeEnvironment?: import('librechat-data-provider').StatefulCodeEnvironment;
      };
      favorites?: import('librechat-data-provider').TUserFavorite[];
      skillStates?: Record<string, boolean>;
      createdAt?: Date;
      updatedAt?: Date;
      idOnTheSource?: string;
      tenantId?: string;
      federatedTokens?: import('~/types').OIDCTokens;
      openidTokens?: import('~/types').OIDCTokens;
      $locals: Record<string, unknown>;
      $op: 'save' | 'validate' | 'remove' | null;
      $where: Record<string, unknown>;
      baseModelName?: string;
      collection: mongoose.Collection;
      db: mongoose.Connection;
      errors?: mongoose.Error.ValidationError;
      isNew: boolean;
      schema: mongoose.Schema;
    }[]
  > {
    if (!searchPattern || searchPattern.trim().length === 0) {
      return [];
    }

    const trimmedPattern = searchPattern.trim();
    const regex = new RegExp(escapeRegExp(trimmedPattern), 'i');
    const User = mongoose.models.User;

    const query = User.find({
      $or: [{ email: regex }, { name: regex }, { username: regex }],
    }).limit(limit * 2); // Get more results to allow for relevance sorting

    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }

    const users = await query.lean<IUser[]>();

    // Score results by relevance
    const startsWithPattern = trimmedPattern.toLowerCase();

    const scoredUsers = users.map((user) => {
      const searchableFields = [user.name, user.email, user.username].filter(
        (field): field is string => typeof field === 'string' && field.length > 0,
      );
      let maxScore = 0;

      for (const field of searchableFields) {
        const fieldLower = field.toLowerCase();
        let score = 0;

        // Exact match gets highest score
        if (fieldLower === startsWithPattern) {
          score = 100;
        }
        // Starts with query gets high score
        else if (fieldLower.startsWith(startsWithPattern)) {
          score = 80;
        }
        // Contains query gets medium score
        else if (fieldLower.includes(startsWithPattern)) {
          score = 50;
        }
        // Default score for database match
        else {
          score = 10;
        }

        maxScore = Math.max(maxScore, score);
      }

      return { ...user, _searchScore: maxScore };
    });

    /** Top results sorted by relevance */
    return scoredUsers
      .sort((a, b) => b._searchScore - a._searchScore)
      .slice(0, limit)
      .map((user) => {
        const { _searchScore, ...userWithoutScore } = user;
        return userWithoutScore;
      });
  };

  /**
   * Updates the plugins for a user based on the action specified (install/uninstall).
   * @param userId - The user ID whose plugins are to be updated
   * @param plugins - The current plugins array
   * @param pluginKey - The key of the plugin to install or uninstall
   * @param action - The action to perform, 'install' or 'uninstall'
   * @returns The result of the update operation or null if action is invalid
   */
  async function updateUserPlugins(
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ): Promise<IUser | null> {
    const userPlugins = plugins ?? [];
    if (action === 'install') {
      return updateUser(userId, { plugins: [...userPlugins, pluginKey] });
    }
    if (action === 'uninstall') {
      return updateUser(userId, {
        plugins: userPlugins.filter((plugin) => plugin !== pluginKey),
      });
    }
    return null;
  }

  return {
    findUser,
    findUsers,
    countUsers,
    createUser,
    updateUser,
    claimSamlIdentity,
    acceptTerms,
    searchUsers,
    getUserById,
    generateToken,
    beginAgentTriggerUserDeletion,
    recoverStaleAgentTriggerUserDeletion,
    cancelAgentTriggerUserDeletion,
    isAgentTriggerPrincipalActive,
    fenceSubagentAdmission,
    renewSubagentAdmission,
    releaseSubagentAdmission,
    isSubagentOwnerAdmissible,
    deleteUserById,
    updateUserPlugins,
    toggleUserMemories,
    updateUserStatefulCodeEnvironment,
  };
}

export type UserMethods = ReturnType<typeof createUserMethods>;
