import { randomBytes } from 'node:crypto';
import type mongoose from 'mongoose';
import type { FavoriteSnapshotRow, FavoriteSnapshotSource } from './import';
import { buildIndexWithRetry } from '~/utils/retry';
import toolFavoriteSchema from '~/schema/favorite';

export interface MongoFavoriteStaging {
  source: FavoriteSnapshotSource;
  insert(rows: FavoriteSnapshotRow[]): Promise<void>;
  replace(): Promise<void>;
  discard(): Promise<void>;
}

export interface MongoFavoriteStore {
  source: FavoriteSnapshotSource;
  stage(): Promise<MongoFavoriteStaging>;
}

/** Never register application models on the connected CLI instance. */
export function createMongoFavoriteStore(database: typeof mongoose): MongoFavoriteStore {
  const metadata = new database.Mongoose();
  const schema = toolFavoriteSchema.clone();
  schema.set('autoCreate', false);
  schema.set('autoIndex', false);
  schema.set('autoSearchIndex', false);
  // eslint-disable-next-line no-restricted-syntax -- Collection name metadata only, no raw driver operations.
  const name = metadata.model('ToolFavorite', schema).collection.name;
  const collection = database.connection.collection(name);
  const snapshot = (target: typeof collection): FavoriteSnapshotSource =>
    async function* () {
      const cursor = target.find({}).sort({ _id: 1 }).batchSize(250);
      try {
        for await (const row of cursor) {
          yield {
            id: String(row._id),
            userId: String(row.user),
            tenantId: row.tenantId ?? null,
            itemType: row.itemType,
            itemId: row.itemId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }
      } finally {
        await cursor.close();
      }
    };
  return {
    source: snapshot(collection),
    async stage() {
      const stagingName = `${name}_reconcile_${randomBytes(6).toString('hex')}`;
      const staging = database.connection.collection(stagingName);
      const discard = async () => {
        await staging.drop().catch(() => undefined);
      };
      try {
        await database.connection.createCollection(stagingName);
        const exists = await database.connection.db!.listCollections({ name }).hasNext();
        for (const index of exists ? await collection.indexes() : []) {
          if (index.name === '_id_') continue;
          const options = Object.fromEntries(
            Object.entries(index).filter(([key]) => !['key', 'v', 'ns'].includes(key)),
          );
          await buildIndexWithRetry(
            () => staging.createIndex(index.key, options),
            'favorites_reconciliation_index',
          );
        }
      } catch (error) {
        await discard();
        throw error;
      }
      return {
        source: snapshot(staging),
        async insert(rows) {
          await staging.insertMany(
            rows.map((row) => ({
              _id: new database.Types.ObjectId(row.id),
              user: new database.Types.ObjectId(row.userId),
              tenantId: row.tenantId,
              itemType: row.itemType,
              itemId: row.itemId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            })),
          );
        },
        async replace() {
          await staging.rename(name, { dropTarget: true });
        },
        discard,
      };
    },
  };
}
