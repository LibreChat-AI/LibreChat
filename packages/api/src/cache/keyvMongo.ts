import mongoose from 'mongoose';
import { EventEmitter } from 'events';
import { GridFSBucket } from 'mongodb';
import { logger } from '@librechat/data-schemas';
import type { Db, ReadPreference, Collection } from 'mongodb';

interface KeyvMongoOptions {
  url?: string;
  collection?: string;
  useGridFS?: boolean;
  readPreference?: ReadPreference;
}

interface GridFSClient {
  bucket: GridFSBucket;
  store: Collection;
  db: Db;
}

interface CollectionClient {
  store: Collection;
  db: Db;
}

type Client = GridFSClient | CollectionClient;

const storeMap = new Map<string, Client>();

class KeyvMongoCustom extends EventEmitter {
  private opts: KeyvMongoOptions;
  public ttlSupport: boolean;
  public namespace?: string;

  constructor(options: KeyvMongoOptions = {}) {
    super();

    this.opts = {
      url: 'mongodb://127.0.0.1:27017',
      collection: 'keyv',
      ...options,
    };

    this.ttlSupport = false;
  }

  // Helper to access the store WITHOUT storing a promise on the instance
  private async _getClient(): Promise<Client> {
    const storeKey = `${this.opts.collection}:${this.opts.useGridFS ? 'gridfs' : 'collection'}`;

    // If we already have the store initialized, return it directly
    if (storeMap.has(storeKey)) {
      return storeMap.get(storeKey)!;
    }

    // Check mongoose connection state
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Mongoose connection not ready. Ensure connectDb() is called first.');
    }

    try {
      const db = mongoose.connection.db as unknown as Db | undefined;
      if (!db) {
        throw new Error('MongoDB database not available');
      }

      let client: Client;

      if (this.opts.useGridFS) {
        const bucket = new GridFSBucket(db, {
          readPreference: this.opts.readPreference,
          bucketName: this.opts.collection,
        });
        const store = db.collection(`${this.opts.collection}.files`);
        client = { bucket, store, db };
      } else {
        const collection = this.opts.collection || 'keyv';
        const store = db.collection(collection);
        client = { store, db };
      }

      storeMap.set(storeKey, client);
      return client;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async get(key: string): Promise<unknown> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      await client.store.updateOne(
        {
          filename: key,
        },
        {
          $set: {
            'metadata.lastAccessed': new Date(),
          },
        },
      );

      const stream = client.bucket.openDownloadStreamByName(key);

      return new Promise((resolve) => {
        const resp: Uint8Array[] = [];
        stream.on('error', () => {
          resolve(undefined);
        });

        stream.on('end', () => {
          const data = Buffer.concat(resp).toString('utf8');
          resolve(data);
        });

        stream.on('data', (chunk: Uint8Array) => {
          resp.push(chunk);
        });
      });
    }

    const document = await client.store.findOne({ key: { $eq: key } });

    if (!document) {
      return undefined;
    }

    return document.value;
  }

  async getMany(keys: string[]): Promise<unknown[]> {
    const client = await this._getClient();

    if (this.opts.useGridFS) {
      const promises = [];
      for (const key of keys) {
        promises.push(this.get(key));
      }

      const values = await Promise.allSettled(promises);
      const data: unknown[] = [];
      for (const value of values) {
        data.push(value.status === 'fulfilled' ? value.value : undefined);
      }

      return data;
    }

    const values = await client.store
      .find({ key: { $in: keys } })
      .project({ _id: 0, value: 1, key: 1 })
      .toArray();

    const results: unknown[] = [...keys];
    let i = 0;
    for (const key of keys) {
      const rowIndex = values.findIndex((row) => row.key === key);
      results[i] = rowIndex > -1 ? values[rowIndex].value : undefined;
      i++;
    }

    return results;
  }

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    const client = await this._getClient();
    const expiresAt = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      const stream = client.bucket.openUploadStream(key, {
        metadata: {
          expiresAt,
          lastAccessed: new Date(),
        },
      });

      return new Promise((resolve) => {
        stream.on('finish', () => {
          resolve(stream);
        });
        stream.end(value);
      });
    }

    await client.store.updateOne(
      { key: { $eq: key } },
      { $set: { key, value, expiresAt } },
      { upsert: true },
    );
  }

  async delete(key: string): Promise<boolean> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      try {
        const bucket = new GridFSBucket(client.db, {
          bucketName: this.opts.collection,
        });
        const files = await bucket.find({ filename: key }).toArray();
        if (files.length > 0) {
          await client.bucket.delete(files[0]._id);
        }
        return true;
      } catch {
        return false;
      }
    }

    const object = await client.store.deleteOne({ key: { $eq: key } });
    return object.deletedCount > 0;
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      const bucket = new GridFSBucket(client.db, {
        bucketName: this.opts.collection,
      });
      const files = await bucket.find({ filename: { $in: keys } }).toArray();
      if (files.length === 0) {
        return false;
      }

      await Promise.all(files.map(async (file) => client.bucket.delete(file._id)));
      return true;
    }

    const object = await client.store.deleteMany({ key: { $in: keys } });
    return object.deletedCount > 0;
  }

  async clear(): Promise<void> {
    const client = await this._getClient();

    if (this.opts.useGridFS && this.isGridFSClient(client)) {
      try {
        await client.bucket.drop();
      } catch (error: unknown) {
        // Throw error if not "namespace not found" error
        const errorCode =
          error instanceof Error && 'code' in error ? (error as { code?: number }).code : undefined;
        if (errorCode !== 26) {
          throw error;
        }
      }
    }

    await client.store.deleteMany({
      key: { $regex: this.namespace ? `^${this.namespace}:*` : '' },
    });
  }

  async has(key: string): Promise<boolean> {
    const client = await this._getClient();
    const filter = { [this.opts.useGridFS ? 'filename' : 'key']: { $eq: key } };
    const document = await client.store.countDocuments(filter, { limit: 1 });
    return document !== 0;
  }

  // No-op disconnect
  async disconnect(): Promise<boolean> {
    // This is a no-op since we don't want to close the shared mongoose connection
    return true;
  }

  private isGridFSClient(client: Client): client is GridFSClient {
    return (client as GridFSClient).bucket != null;
  }
}

const keyvMongo: KeyvMongoCustom = new KeyvMongoCustom({
  collection: 'logs',
});

keyvMongo.on('error', (err) => logger.error('KeyvMongo connection error:', err));

export default keyvMongo;
