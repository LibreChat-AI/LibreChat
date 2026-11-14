import type { FilterQuery, Model, UpdateQuery } from 'mongoose';
import type {
  IRefreshTokenBridge,
  BridgeRecord,
  RefreshTokenBridgeCreateData,
  RefreshTokenBridgeDeleteData,
  RefreshTokenBridgeQuery,
} from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

function bridgeFilter({
  oldRefreshTokenHash,
  userId,
  tenantId,
}: RefreshTokenBridgeQuery): FilterQuery<IRefreshTokenBridge> {
  return {
    oldRefreshTokenHash,
    userId,
    tenantId: tenantId ?? { $exists: false },
  };
}

export function createRefreshTokenBridgeMethods(mongoose: typeof import('mongoose')): {
  upsertRefreshTokenBridge: (
    bridgeData: RefreshTokenBridgeCreateData,
  ) => Promise<BridgeRecord | null>;
  findRefreshTokenBridge: (query: RefreshTokenBridgeQuery) => Promise<BridgeRecord | null>;
  deleteRefreshTokenBridges: (
    data: RefreshTokenBridgeDeleteData,
  ) => Promise<{ deletedCount: number }>;
} {
  let indexesPromise: Promise<void> | null = null;

  const getRefreshTokenBridgeModel = () =>
    mongoose.models.RefreshTokenBridge as Model<IRefreshTokenBridge>;

  /**
   * A bridge holds an encrypted refresh token, and the TTL index is the only thing that ever
   * deletes one. `MONGO_AUTO_INDEX=false` is a supported deployment setting, and under it Mongoose
   * builds neither that index nor the compound uniqueness the upsert relies on — so bridges would
   * accumulate for the life of the collection and concurrent writes could leave duplicates. The
   * indexes are therefore installed before the first write, and a failed build is retried on the
   * next attempt rather than cached.
   */
  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = createIndexesWithRetry(getRefreshTokenBridgeModel()).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  async function upsertRefreshTokenBridge(
    bridgeData: RefreshTokenBridgeCreateData,
  ): Promise<BridgeRecord | null> {
    try {
      await ensureIndexes();
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      const filter = bridgeFilter(bridgeData);
      const update: UpdateQuery<IRefreshTokenBridge> = {
        $set: {
          encryptedNewRefreshToken: bridgeData.encryptedNewRefreshToken,
          version: bridgeData.version,
          expiresAt: bridgeData.expiresAt,
          ...(bridgeData.openidIssuer != null && { openidIssuer: bridgeData.openidIssuer }),
        },
        $setOnInsert: {
          oldRefreshTokenHash: bridgeData.oldRefreshTokenHash,
          userId: bridgeData.userId,
          ...(bridgeData.tenantId != null && { tenantId: bridgeData.tenantId }),
          createdAt: new Date(),
        },
        ...(bridgeData.openidIssuer == null && { $unset: { openidIssuer: '' } }),
      };
      const found = await RefreshTokenBridge.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
      }).lean<IRefreshTokenBridge>();
      return found ? { ...found, _id: String(found._id) } : null;
    } catch (error) {
      logger.debug('[upsertRefreshTokenBridge] Error storing bridge:', error);
      throw error;
    }
  }

  async function findRefreshTokenBridge(
    query: RefreshTokenBridgeQuery,
  ): Promise<BridgeRecord | null> {
    try {
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      const found = await RefreshTokenBridge.findOne({
        ...bridgeFilter(query),
        expiresAt: { $gt: new Date() },
      }).lean<IRefreshTokenBridge>();
      return found ? { ...found, _id: String(found._id) } : null;
    } catch (error) {
      logger.debug('[findRefreshTokenBridge] Error finding bridge:', error);
      throw error;
    }
  }

  async function deleteRefreshTokenBridges(
    data: RefreshTokenBridgeDeleteData,
  ): Promise<{ deletedCount: number }> {
    try {
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      return await RefreshTokenBridge.deleteMany({
        ...(data.oldRefreshTokenHashes && {
          oldRefreshTokenHash: { $in: data.oldRefreshTokenHashes },
        }),
        ...(data.version && { version: data.version }),
        userId: data.userId,
        tenantId: data.tenantId ?? { $exists: false },
      });
    } catch (error) {
      logger.debug('[deleteRefreshTokenBridges] Error deleting bridges:', error);
      throw error;
    }
  }

  return {
    upsertRefreshTokenBridge,
    findRefreshTokenBridge,
    deleteRefreshTokenBridges,
  };
}

export type RefreshTokenBridgeMethods = ReturnType<typeof createRefreshTokenBridgeMethods>;
