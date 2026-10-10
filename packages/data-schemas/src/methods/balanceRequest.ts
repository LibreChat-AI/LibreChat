import type { FilterQuery, Model } from 'mongoose';
import type { IBalanceRequest, PendingBalanceRequestWithUser } from '~/types';
import logger from '~/config/winston';

/** Mongo duplicate-key error code, thrown when the partial unique
 * `{ user, tenantId, status: 'pending' }` index is violated. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

interface PopulatedRequestUser {
  _id: { toString(): string };
  name?: string;
  email?: string;
  avatar?: string;
  role?: string;
  tenantId?: string;
}

export function createBalanceRequestMethods(mongoose: typeof import('mongoose')): {
  createBalanceRequest: (userId: string, reason?: string) => Promise<IBalanceRequest>;
  findPendingBalanceRequestByUser: (userId: string) => Promise<IBalanceRequest | null>;
  findPendingBalanceRequestsByUsers: (userIds: string[]) => Promise<IBalanceRequest[]>;
  findAllPendingBalanceRequests: () => Promise<PendingBalanceRequestWithUser[]>;
  countPendingBalanceRequests: () => Promise<number>;
  claimBalanceRequestResolution: (
    requestId: string,
    userId: string,
    leaseMs?: number,
  ) => Promise<boolean>;
  releaseBalanceRequestResolutionLease: (requestId: string) => Promise<void>;
  resolveBalanceRequestIfPending: (
    requestId: string,
    userId: string,
    fields: { resolvedBy?: string; resolvedAmount: number },
  ) => Promise<IBalanceRequest | null>;
  deleteBalanceRequests: (
    filter: FilterQuery<IBalanceRequest>,
  ) => Promise<import('mongodb').DeleteResult>;
  ensureBalanceRequestIndexes: () => Promise<void>;
} {
  function model(): Model<IBalanceRequest> {
    return mongoose.models.BalanceRequest as Model<IBalanceRequest>;
  }

  /**
   * Creates a pending balance request for a user. If one is already pending
   * (guarded by the partial unique `{ user, tenantId, status: 'pending' }`
   * index), returns the existing request instead of throwing — safe for a
   * double-click or a client retry to call redundantly.
   */
  async function createBalanceRequest(userId: string, reason?: string): Promise<IBalanceRequest> {
    try {
      const created = await model().create({
        user: userId,
        reason,
        status: 'pending',
        requestedAt: new Date(),
      });
      return created.toObject();
    } catch (error) {
      const mongoError = error as { code?: number };
      if (mongoError?.code === DUPLICATE_KEY_ERROR_CODE) {
        const existing = await findPendingBalanceRequestByUser(userId);
        if (existing) {
          return existing;
        }
      }
      logger.error('[createBalanceRequest] Failed to create balance request:', error);
      throw error;
    }
  }

  async function findPendingBalanceRequestByUser(userId: string): Promise<IBalanceRequest | null> {
    return model().findOne({ user: userId, status: 'pending' }).lean<IBalanceRequest>();
  }

  async function findPendingBalanceRequestsByUsers(userIds: string[]): Promise<IBalanceRequest[]> {
    if (userIds.length === 0) {
      return [];
    }
    return model()
      .find({ user: { $in: userIds }, status: 'pending' })
      .lean<IBalanceRequest[]>();
  }

  /**
   * All pending requests, globally, newest first, with their requester
   * resolved — the admin "Requests" view's entire dataset. Pending requests
   * are a small, human-moderated queue (bounded by how many users are
   * actively waiting on an admin), not a user-table-sized collection, so
   * fetching the full set and paginating/filtering it in the caller is
   * simpler and just as correct as a DB-level skip/limit — unlike the
   * "all users" list, which paginates in the database because the user base
   * itself can be arbitrarily large.
   */
  async function findAllPendingBalanceRequests(): Promise<PendingBalanceRequestWithUser[]> {
    const requests = await model()
      .find({ status: 'pending' })
      .sort({ requestedAt: -1 })
      .populate<{
        user: PopulatedRequestUser | null;
      }>('user', '_id name email avatar role tenantId')
      .lean();

    return requests
      .filter((r): r is typeof r & { user: PopulatedRequestUser } => r.user != null)
      .map((r) => ({
        requestId: r._id.toString(),
        requestedAt: r.requestedAt,
        reason: r.reason,
        user: {
          id: r.user._id.toString(),
          name: r.user.name,
          email: r.user.email,
          avatar: r.user.avatar,
          role: r.user.role,
          tenantId: r.user.tenantId,
        },
      }));
  }

  /** Global count of pending requests — drives the "Requests (N)" tab badge
   *  regardless of which view or search the admin currently has open. */
  async function countPendingBalanceRequests(): Promise<number> {
    return model().countDocuments({ status: 'pending' });
  }

  const DEFAULT_RESOLUTION_LEASE_MS = 60_000;

  /**
   * Atomically claims the *attempt* to resolve a specific pending request —
   * not completion. Mirrors `claimAuditRecording`'s shape exactly, for the
   * same reason: crediting a user and then resolving their request are two
   * separate operations an admin's request handler can crash between, and
   * naively resolving (or crediting) first and the other second leaves a
   * window where a concurrent duplicate request — a double-click, or a
   * client retry racing the original — can apply credit *twice* before
   * either resolves the request and makes the second one visible as
   * redundant.
   *
   * Returns `true` for exactly one caller at a time: a concurrent racer, or
   * a retry while a prior attempt's lease is still live, both get `false`
   * and must not proceed to credit. Deliberately does not resolve the
   * request itself here — only `resolveBalanceRequestIfPending`, called
   * after the credit has actually landed, does that — so a crash (or a
   * thrown error) between claiming and crediting leaves the request
   * `pending` with just an expired lease, letting a later retry reclaim and
   * complete it, rather than leaving it permanently stuck "resolved" with
   * no credit behind it.
   */
  async function claimBalanceRequestResolution(
    requestId: string,
    userId: string,
    leaseMs: number = DEFAULT_RESOLUTION_LEASE_MS,
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await model().findOneAndUpdate(
      {
        _id: requestId,
        user: userId,
        status: 'pending',
        $or: [
          { resolutionLeaseExpiresAt: { $exists: false } },
          { resolutionLeaseExpiresAt: { $lte: now } },
        ],
      },
      { $set: { resolutionLeaseExpiresAt: new Date(now.getTime() + leaseMs) } },
    );
    return claimed != null;
  }

  /**
   * Releases a claimed resolution lease without resolving the request, so a
   * confirmed-failed credit attempt can be retried immediately instead of
   * waiting out the full lease window.
   */
  async function releaseBalanceRequestResolutionLease(requestId: string): Promise<void> {
    await model().updateOne({ _id: requestId }, { $unset: { resolutionLeaseExpiresAt: 1 } });
  }

  /**
   * Resolves a specific pending request by id (and user, as a belt-and-suspenders
   * check) — never "whatever happens to be pending right now" for that user.
   * Returns `null` if it didn't match (already resolved, wrong id, or a race
   * with another admin) — always safe to call again, this step is naturally
   * idempotent.
   *
   * Deliberately does not re-check the resolution lease: callers reach this
   * only after already winning `claimBalanceRequestResolution` for this
   * exact `requestId`, so by the time this runs they're the sole holder and
   * don't need to re-prove it against a
   * lease that's indistinguishable "held by me" vs. "held by someone else"
   * from a timestamp alone. `resolvedBy` remains optional at the data layer
   * so retries can complete records created by older callers.
   */
  async function resolveBalanceRequestIfPending(
    requestId: string,
    userId: string,
    { resolvedBy, resolvedAmount }: { resolvedBy?: string; resolvedAmount: number },
  ): Promise<IBalanceRequest | null> {
    return model()
      .findOneAndUpdate(
        { _id: requestId, user: userId, status: 'pending' },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedAmount,
            ...(resolvedBy != null && { resolvedBy }),
          },
          $unset: { resolutionLeaseExpiresAt: 1 },
        },
        { new: true },
      )
      .lean<IBalanceRequest>();
  }

  /** Deletes balance request records matching a filter (cascade cleanup). */
  async function deleteBalanceRequests(
    filter: FilterQuery<IBalanceRequest>,
  ): Promise<import('mongodb').DeleteResult> {
    return model().deleteMany(filter);
  }

  /**
   * Explicitly provisions this model's indexes at startup, rather than relying
   * on Mongoose's implicit auto-index behavior — `MONGO_AUTO_INDEX` can disable
   * that for the whole connection, which would silently drop the partial unique
   * (dedup) and TTL (retention) guarantees this collection depends on.
   */
  async function ensureBalanceRequestIndexes(): Promise<void> {
    await model().createIndexes();
  }

  return {
    createBalanceRequest,
    findPendingBalanceRequestByUser,
    findPendingBalanceRequestsByUsers,
    findAllPendingBalanceRequests,
    countPendingBalanceRequests,
    claimBalanceRequestResolution,
    releaseBalanceRequestResolutionLease,
    resolveBalanceRequestIfPending,
    deleteBalanceRequests,
    ensureBalanceRequestIndexes,
  };
}

export type BalanceRequestMethods = ReturnType<typeof createBalanceRequestMethods>;
