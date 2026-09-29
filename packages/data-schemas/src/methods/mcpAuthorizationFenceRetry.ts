import type { Collection } from 'mongodb';
import { runAsSystem } from '~/config/tenantContext';
import { buildIndexWithRetry } from '~/utils/retry';

const COLLECTION_NAME = 'mcp_authorization_fence_retries';
const UPDATED_AT_INDEX = 'updatedAt_1';

export interface MCPAuthorizationFenceRetryScope {
  userId: string;
  serverName: string;
}

export interface MCPAuthorizationFenceRetryRecord extends MCPAuthorizationFenceRetryScope {
  _id: string;
  tenantId?: string | null;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RetryVersionInput {
  scope: MCPAuthorizationFenceRetryScope;
  tenantId?: string | null;
  version: string;
}

interface RetryUpsertInput extends RetryVersionInput {
  now: Date;
}

interface RetryDeferInput extends RetryVersionInput {
  updatedAt: Date;
}

function retryId(
  scope: MCPAuthorizationFenceRetryScope,
  tenantId: string | null | undefined,
  version: string,
): string {
  return JSON.stringify([tenantId ?? '', String(scope.userId), scope.serverName, version]);
}

/** Owns the raw collection and guarded index lifecycle used by durable MCP fence replay. */
export function createMCPAuthorizationFenceRetryStorage(mongoose: typeof import('mongoose')) {
  let indexPromise: Promise<unknown> | undefined;
  const collection = (): Collection<MCPAuthorizationFenceRetryRecord> =>
    mongoose.connection.collection<MCPAuthorizationFenceRetryRecord>(COLLECTION_NAME);

  const ensureIndex = (): Promise<unknown> => {
    indexPromise ??= buildIndexWithRetry(
      () => collection().createIndex({ updatedAt: 1 }, { name: UPDATED_AT_INDEX }),
      `${COLLECTION_NAME}.${UPDATED_AT_INDEX}`,
    ).catch((error) => {
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  };

  return {
    async upsert({ scope, tenantId, version, now }: RetryUpsertInput): Promise<void> {
      await collection().updateOne(
        { _id: retryId(scope, tenantId, version) },
        {
          $set: {
            userId: String(scope.userId),
            serverName: scope.serverName,
            tenantId: tenantId ?? null,
            version,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    },
    async deleteVersion({ scope, tenantId, version }: RetryVersionInput): Promise<void> {
      await collection().deleteOne({ _id: retryId(scope, tenantId, version), version });
    },
    async deferVersion({ scope, tenantId, version, updatedAt }: RetryDeferInput): Promise<void> {
      await collection().updateOne(
        { _id: retryId(scope, tenantId, version), version },
        { $max: { updatedAt } },
      );
    },
    async list(limit: number): Promise<MCPAuthorizationFenceRetryRecord[]> {
      await ensureIndex();
      return runAsSystem(async () =>
        collection().find({}).sort({ updatedAt: 1 }).limit(limit).toArray(),
      );
    },
  };
}

export type MCPAuthorizationFenceRetryStorage = ReturnType<
  typeof createMCPAuthorizationFenceRetryStorage
>;
