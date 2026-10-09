import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createRefreshTokenBridgeMethods } from './refreshTokenBridge';
import refreshTokenBridgeSchema from '~/schema/refreshTokenBridge';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createRefreshTokenBridgeMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.RefreshTokenBridge) {
    mongoose.model<t.IRefreshTokenBridge>('RefreshTokenBridge', refreshTokenBridgeSchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createRefreshTokenBridgeMethods(mongoose);
});

describe('RefreshTokenBridge Methods', () => {
  it('creates uniqueness and TTL indexes before the first write', async () => {
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      tenantId: 'tenant-1',
      expiresAt: new Date(Date.now() + 60000),
    });

    const indexes = await mongoose.models.RefreshTokenBridge.listIndexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { oldRefreshTokenHash: 1, userId: 1, tenantId: 1 },
          unique: true,
        }),
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('keeps the lookup indexes aligned with the data-layer query shape', () => {
    const indexKeys = mongoose.models.RefreshTokenBridge.schema.indexes().map(([key]) => key);

    expect(indexKeys).toContainEqual({ oldRefreshTokenHash: 1, userId: 1, tenantId: 1 });
    expect(indexKeys).not.toContainEqual({
      oldRefreshTokenHash: 1,
      userId: 1,
      tenantId: 1,
      openidIssuer: 1,
    });
  });

  it('upserts and finds a bridge by old token hash, user, and tenant', async () => {
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
      expiresAt: new Date(Date.now() + 60000),
    });

    const found = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(found?.encryptedNewRefreshToken).toBe('encrypted-new');
    expect(found?.openidIssuer).toBe('https://issuer.example.com');
  });

  it('replaces the encrypted token and expiry on repeated stores', async () => {
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-old',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60000),
    });

    const nextExpiresAt = new Date(Date.now() + 120000);
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      expiresAt: nextExpiresAt,
    });

    const found = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
    });

    expect(found?.encryptedNewRefreshToken).toBe('encrypted-new');
    expect(found?.expiresAt.getTime()).toBe(nextExpiresAt.getTime());
    expect(await mongoose.models.RefreshTokenBridge.countDocuments()).toBe(1);
  });

  it('does not return expired bridges before Mongo TTL cleanup runs', async () => {
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'old-hash',
        userId: 'user-1',
      }),
    ).resolves.toBeNull();
  });

  it('deletes only the requested user and tenant bridge hashes', async () => {
    for (const [oldRefreshTokenHash, userId, tenantId] of [
      ['hash-a', 'user-1', 'tenant-1'],
      ['hash-b', 'user-1', 'tenant-1'],
      ['hash-a', 'user-2', 'tenant-1'],
      ['hash-a', 'user-1', 'tenant-2'],
    ]) {
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash,
        encryptedNewRefreshToken: `encrypted-${oldRefreshTokenHash}`,
        userId,
        tenantId,
        expiresAt: new Date(Date.now() + 60000),
      });
    }

    const result = await methods.deleteRefreshTokenBridges({
      oldRefreshTokenHashes: ['hash-a', 'hash-b'],
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(result.deletedCount).toBe(2);
    expect(await mongoose.models.RefreshTokenBridge.countDocuments()).toBe(2);
  });

  it('does not let a stale owner delete a replacement bridge version', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-old',
      userId: 'user-1',
      tenantId: 'tenant-1',
      version: 'owner-version',
      expiresAt,
    });
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-winner',
      userId: 'user-1',
      tenantId: 'tenant-1',
      version: 'winner-version',
      expiresAt,
    });

    const staleDelete = await methods.deleteRefreshTokenBridges({
      oldRefreshTokenHashes: ['old-hash'],
      userId: 'user-1',
      tenantId: 'tenant-1',
      version: 'owner-version',
    });
    const winner = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(staleDelete.deletedCount).toBe(0);
    expect(winner?.encryptedNewRefreshToken).toBe('encrypted-winner');
    expect(winner?.version).toBe('winner-version');
  });

  it('deletes all predecessor bridges for one user and tenant', async () => {
    for (const [oldRefreshTokenHash, userId, tenantId] of [
      ['hash-a', 'user-1', 'tenant-1'],
      ['hash-b', 'user-1', 'tenant-1'],
      ['hash-c', 'user-2', 'tenant-1'],
    ]) {
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash,
        encryptedNewRefreshToken: `encrypted-${oldRefreshTokenHash}`,
        userId,
        tenantId,
        expiresAt: new Date(Date.now() + 60000),
      });
    }

    const result = await methods.deleteRefreshTokenBridges({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(result.deletedCount).toBe(2);
    expect(await mongoose.models.RefreshTokenBridge.countDocuments()).toBe(1);
  });
});
