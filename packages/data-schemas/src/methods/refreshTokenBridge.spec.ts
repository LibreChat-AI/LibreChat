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

  it('persists the provider session supplied on first write', async () => {
    const providerSession = {
      issuer: 'https://issuer.example.com',
      clientId: 'client-1',
      sid: 'sid-1',
    };
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      providerSession,
      expiresAt: new Date(Date.now() + 60000),
    });

    const stored = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
    });
    expect(stored?.providerSession).toEqual(providerSession);
  });

  it('never clears or replaces an already-stored provider session on a later rotation', async () => {
    const providerSession = {
      issuer: 'https://issuer.example.com',
      clientId: 'client-1',
      sid: 'sid-1',
    };
    const otherProviderSession = {
      issuer: 'https://issuer.example.com',
      clientId: 'client-1',
      sid: 'sid-2',
    };
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      providerSession,
      expiresAt: new Date(Date.now() + 60000),
    });

    // A rotation that omits providerSession must not clear the stored one.
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-newer',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60000),
    });
    const afterOmitted = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
    });
    expect(afterOmitted?.providerSession).toEqual(providerSession);

    // A rotation that supplies a different ref must not replace the stored one either; the
    // caller's own bridge/marker comparison is what denies on a mismatch.
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-newest',
      userId: 'user-1',
      providerSession: otherProviderSession,
      expiresAt: new Date(Date.now() + 60000),
    });
    const afterDiffering = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
    });
    expect(afterDiffering?.providerSession).toEqual(providerSession);
  });

  it('clears openidIssuer on a later store that omits it, even when providerSession is also omitted', async () => {
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-new',
      userId: 'user-1',
      openidIssuer: 'https://issuer.example.com',
      expiresAt: new Date(Date.now() + 60000),
    });

    // Both openidIssuer and providerSession are omitted on this write: the old code built two
    // separate $unset spreads that overwrote each other, so openidIssuer was silently never
    // cleared when providerSession was also absent.
    await methods.upsertRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      encryptedNewRefreshToken: 'encrypted-newer',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60000),
    });

    const stored = await methods.findRefreshTokenBridge({
      oldRefreshTokenHash: 'old-hash',
      userId: 'user-1',
    });
    expect(stored?.openidIssuer).toBeUndefined();
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

  describe('tenant isolation on insert', () => {
    it('stores the given tenantId and never matches, overwrites, or returns it for a different or missing tenant', async () => {
      const expiresAt = new Date(Date.now() + 60000);
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'shared-hash',
        encryptedNewRefreshToken: 'encrypted-tenant-a',
        userId: 'shared-user',
        tenantId: 'tenant-a',
        expiresAt,
      });

      const foundA = await methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'shared-hash',
        userId: 'shared-user',
        tenantId: 'tenant-a',
      });
      expect(foundA?.tenantId).toBe('tenant-a');

      // A different tenant must not match tenant A's bridge.
      await expect(
        methods.findRefreshTokenBridge({
          oldRefreshTokenHash: 'shared-hash',
          userId: 'shared-user',
          tenantId: 'tenant-b',
        }),
      ).resolves.toBeNull();

      // A missing tenant must not match a tenant-scoped record either.
      await expect(
        methods.findRefreshTokenBridge({
          oldRefreshTokenHash: 'shared-hash',
          userId: 'shared-user',
        }),
      ).resolves.toBeNull();

      // Upserting under tenant B must create its own record, not overwrite tenant A's.
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'shared-hash',
        encryptedNewRefreshToken: 'encrypted-tenant-b',
        userId: 'shared-user',
        tenantId: 'tenant-b',
        expiresAt,
      });

      const stillA = await methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'shared-hash',
        userId: 'shared-user',
        tenantId: 'tenant-a',
      });
      expect(stillA?.encryptedNewRefreshToken).toBe('encrypted-tenant-a');
      expect(stillA?.tenantId).toBe('tenant-a');

      const foundB = await methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'shared-hash',
        userId: 'shared-user',
        tenantId: 'tenant-b',
      });
      expect(foundB?.encryptedNewRefreshToken).toBe('encrypted-tenant-b');
      expect(foundB?.tenantId).toBe('tenant-b');

      expect(await mongoose.models.RefreshTokenBridge.countDocuments()).toBe(2);
    });

    it('never writes a tenantId field when it is explicitly null, so the record stays tenant-less', async () => {
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'null-tenant-hash',
        encryptedNewRefreshToken: 'encrypted',
        userId: 'user-1',
        // Runtime defensive case: a caller-supplied null, distinct from simply omitting the field.
        tenantId: null as unknown as string,
        expiresAt: new Date(Date.now() + 60000),
      });

      const raw = await mongoose.connection.db
        ?.collection('refreshtokenbridges')
        .findOne({ oldRefreshTokenHash: 'null-tenant-hash' });
      expect(raw).not.toBeNull();
      expect('tenantId' in (raw as Record<string, unknown>)).toBe(false);

      // Because no tenantId field was written, the tenant-less lookup must still find it.
      const found = await methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'null-tenant-hash',
        userId: 'user-1',
      });
      expect(found?.encryptedNewRefreshToken).toBe('encrypted');
    });

    it('never writes a providerSession field on insert when it is explicitly null', async () => {
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'null-provider-session-hash',
        encryptedNewRefreshToken: 'encrypted',
        userId: 'user-1',
        providerSession: null,
        expiresAt: new Date(Date.now() + 60000),
      } as unknown as t.RefreshTokenBridgeCreateData);

      const raw = await mongoose.connection.db
        ?.collection('refreshtokenbridges')
        .findOne({ oldRefreshTokenHash: 'null-provider-session-hash' });
      expect(raw).not.toBeNull();
      expect('providerSession' in (raw as Record<string, unknown>)).toBe(false);
    });

    it('clears openidIssuer without error when it is passed as an explicit null rather than omitted', async () => {
      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'null-issuer-hash',
        encryptedNewRefreshToken: 'encrypted-old',
        userId: 'user-1',
        openidIssuer: 'https://issuer.example.com',
        expiresAt: new Date(Date.now() + 60000),
      });

      await expect(
        methods.upsertRefreshTokenBridge({
          oldRefreshTokenHash: 'null-issuer-hash',
          encryptedNewRefreshToken: 'encrypted-new',
          userId: 'user-1',
          openidIssuer: null as unknown as string,
          expiresAt: new Date(Date.now() + 60000),
        }),
      ).resolves.not.toThrow();

      const found = await methods.findRefreshTokenBridge({
        oldRefreshTokenHash: 'null-issuer-hash',
        userId: 'user-1',
      });
      expect(found?.openidIssuer).toBeUndefined();
    });
  });

  describe('$unset is only sent when there is something to clear', () => {
    it('omits $unset entirely when openidIssuer is supplied, and sends an exact unset otherwise', async () => {
      const RefreshTokenBridge = mongoose.models.RefreshTokenBridge;
      const findOneAndUpdateSpy = jest.spyOn(RefreshTokenBridge, 'findOneAndUpdate');

      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'unset-shape-hash',
        encryptedNewRefreshToken: 'encrypted',
        userId: 'user-1',
        openidIssuer: 'https://issuer.example.com',
        expiresAt: new Date(Date.now() + 60000),
      });
      const [, updateWithIssuer] = findOneAndUpdateSpy.mock.calls[0];
      expect(updateWithIssuer).not.toHaveProperty('$unset');

      await methods.upsertRefreshTokenBridge({
        oldRefreshTokenHash: 'unset-shape-hash',
        encryptedNewRefreshToken: 'encrypted-2',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 60000),
      });
      const [, updateWithoutIssuer] = findOneAndUpdateSpy.mock.calls[1];
      expect(updateWithoutIssuer).toMatchObject({ $unset: { openidIssuer: '' } });

      findOneAndUpdateSpy.mockRestore();
    });
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
