import type { Model } from 'mongoose';
import type { IResourceLock, ResourceLockAcquireData, ResourceLockReleaseData } from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';

/** A stuck index build must surface as an error instead of hanging the request. */
const INDEX_BUILD_WAIT_MS = 2_000;

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === 11000;
}

export function createResourceLockMethods(mongoose: typeof import('mongoose')): {
  acquireResourceLock: (data: ResourceLockAcquireData) => Promise<boolean>;
  renewResourceLock: (data: ResourceLockAcquireData) => Promise<boolean>;
  releaseResourceLock: (data: ResourceLockReleaseData) => Promise<boolean>;
} {
  let indexesPromise: Promise<void> | null = null;

  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      const ResourceLock = mongoose.models.ResourceLock as Model<IResourceLock>;
      indexesPromise = createIndexesWithRetry(ResourceLock, {
        peerBuildDeadlineMs: INDEX_BUILD_WAIT_MS,
      }).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  /** Resolves false instead of waiting past the deadline on a stuck index build. */
  async function indexesReady(maxWaitMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), maxWaitMs);
    });
    try {
      return await Promise.race([ensureIndexes().then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Expiry is computed on the application clock ($$NOW pipelines are avoided for DocumentDB
   * compatibility). Clock skew between instances only affects liveness: every write is fenced by
   * `renewResourceLock`, which succeeds only for the current owner token, so a skew-induced early
   * takeover changes the owner and the previous holder's next renewal fails and aborts with a 409
   * instead of writing. Exclusivity therefore holds; the delay a skew can cause is bounded by the
   * skew relative to the TTL. Tracked as a liveness improvement in berry-13/LibreChat#354.
   *
   * Takes the lease for `key`, or takes over one whose holder let it expire.
   * Returns false while another owner holds a live lease.
   */
  async function acquireResourceLock({
    key,
    ownerId,
    ttlMs,
    readyWaitMs,
  }: ResourceLockAcquireData): Promise<boolean> {
    const ResourceLock = mongoose.models.ResourceLock as Model<IResourceLock>;
    if (!(await indexesReady(Math.min(readyWaitMs ?? INDEX_BUILD_WAIT_MS, INDEX_BUILD_WAIT_MS)))) {
      return false;
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    try {
      await ResourceLock.create({ key, ownerId, expiresAt });
      return true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
    const taken = await ResourceLock.findOneAndUpdate(
      { key, expiresAt: { $lte: now } },
      { $set: { ownerId, expiresAt } },
      { new: true },
    ).lean();
    return taken != null;
  }

  /**
   * Extends the lease only while `ownerId` still holds it unexpired. A false result
   * means it was lost (expired or taken over) and the holder must not proceed.
   */
  async function renewResourceLock({
    key,
    ownerId,
    ttlMs,
  }: ResourceLockAcquireData): Promise<boolean> {
    const ResourceLock = mongoose.models.ResourceLock as Model<IResourceLock>;
    const now = new Date();
    const renewed = await ResourceLock.findOneAndUpdate(
      { key, ownerId, expiresAt: { $gt: now } },
      /** $max keeps overlapping renewals from moving the expiry backwards. */
      { $max: { expiresAt: new Date(now.getTime() + ttlMs) } },
      { new: true },
    ).lean();
    return renewed != null;
  }

  /** Releases the lease only for the owner that holds it; anyone else is a no-op. */
  async function releaseResourceLock({ key, ownerId }: ResourceLockReleaseData): Promise<boolean> {
    const ResourceLock = mongoose.models.ResourceLock as Model<IResourceLock>;
    const result = await ResourceLock.deleteOne({ key, ownerId });
    return result.deletedCount > 0;
  }

  return { acquireResourceLock, renewResourceLock, releaseResourceLock };
}

export type ResourceLockMethods = ReturnType<typeof createResourceLockMethods>;
