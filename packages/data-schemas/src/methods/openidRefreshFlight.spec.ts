import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createOpenIDRefreshFlightMethods } from './openidRefreshFlight';
import openidRefreshFlightSchema from '~/schema/openidRefreshFlight';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createOpenIDRefreshFlightMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.OpenIDRefreshFlight) {
    mongoose.model<t.IOpenIDRefreshFlight>('OpenIDRefreshFlight', openidRefreshFlightSchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createOpenIDRefreshFlightMethods(mongoose);
});

describe('OpenIDRefreshFlight Methods', () => {
  it('creates coordination indexes before the first acquisition', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    const indexes = await mongoose.models.OpenIDRefreshFlight.listIndexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { key: 1 }, unique: true }),
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('acquires a new pending flight and returns existing flight to joiners', async () => {
    const first = await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    const second = await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-2',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(first.acquired).toBe(true);
    expect(first.flight?.ownerId).toBe('owner-1');
    expect(second.acquired).toBe(false);
    expect(second.flight?.ownerId).toBe('owner-1');
    expect(second.flight?.status).toBe('pending');
  });

  it('reads an existing flight from the primary when resolving an acquisition conflict', async () => {
    const readSpy = jest.spyOn(mongoose.Query.prototype, 'read');
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-2',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(readSpy).toHaveBeenCalledWith('primary');
    readSpy.mockRestore();
  });

  it('reclaims an expired pending lock', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60000),
    });
    await mongoose.models.OpenIDRefreshFlight.updateOne(
      { key: 'flight-key' },
      { $set: { createdAt: new Date('2020-01-01T00:00:00.000Z') } },
    );

    const reclaimed = await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-2',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(reclaimed.acquired).toBe(true);
    expect(reclaimed.flight?.ownerId).toBe('owner-2');
    expect(reclaimed.flight?.createdAt.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('reclaims a failed flight immediately so transient failures can retry', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    await methods.failOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      errorMessage: 'upstream timeout',
      expiresAt: new Date(Date.now() + 60000),
    });

    const reclaimed = await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-2',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(reclaimed.acquired).toBe(true);
    expect(reclaimed.flight?.ownerId).toBe('owner-2');
    expect(reclaimed.flight?.status).toBe('pending');
    expect(reclaimed.flight?.errorMessage).toBeUndefined();
  });

  it('renews a lease only for the owning pending worker', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    const nextLockExpiry = new Date(Date.now() + 45000);
    const nextFlightExpiry = new Date(Date.now() + 90000);
    await expect(
      methods.renewOpenIDRefreshFlight({
        key: 'flight-key',
        ownerId: 'owner-2',
        lockExpiresAt: nextLockExpiry,
        expiresAt: nextFlightExpiry,
      }),
    ).resolves.toBeNull();

    const renewed = await methods.renewOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: nextLockExpiry,
      expiresAt: nextFlightExpiry,
    });

    expect(renewed?.ownerId).toBe('owner-1');
    expect(renewed?.status).toBe('pending');
    expect(renewed?.lockExpiresAt.getTime()).toBe(nextLockExpiry.getTime());
    expect(renewed?.expiresAt.getTime()).toBe(nextFlightExpiry.getTime());
  });

  it('completes a flight only for the owning pending worker', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });

    await expect(
      methods.completeOpenIDRefreshFlight({
        key: 'flight-key',
        ownerId: 'owner-2',
        encryptedResult: 'encrypted-wrong',
        expiresAt: new Date(Date.now() + 60000),
      }),
    ).resolves.toBeNull();

    const completed = await methods.completeOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-result',
      expiresAt: new Date(Date.now() + 60000),
    });

    expect(completed?.status).toBe('completed');
    expect(completed?.encryptedResult).toBe('encrypted-result');
  });

  it('finds completed unexpired flights and ignores expired ones', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-result',
      expiresAt: new Date(Date.now() + 60000),
    });

    await expect(methods.findOpenIDRefreshFlight({ key: 'flight-key' })).resolves.toMatchObject({
      status: 'completed',
      encryptedResult: 'encrypted-result',
    });

    const OpenIDRefreshFlight = mongoose.models.OpenIDRefreshFlight;
    await OpenIDRefreshFlight.updateOne(
      { key: 'flight-key' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    await expect(methods.findOpenIDRefreshFlight({ key: 'flight-key' })).resolves.toBeNull();
  });

  it('reads publication state from the primary', async () => {
    const readSpy = jest.spyOn(mongoose.Query.prototype, 'read');

    await methods.findOpenIDRefreshFlight({ key: 'flight-key' });

    expect(readSpy).toHaveBeenCalledWith('primary');
    readSpy.mockRestore();
  });

  it('persists a logout revocation fence that an active owner cannot publish through', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });
    const revocationExpiry = new Date(Date.now() + 3600000);

    const revoked = await methods.revokeOpenIDRefreshFlight({
      key: 'flight-key',
      expiresAt: revocationExpiry,
    });

    expect(revoked?.status).toBe('revoked');
    await expect(
      methods.completeOpenIDRefreshFlight({
        key: 'flight-key',
        ownerId: 'owner-1',
        encryptedResult: 'late-result',
        expiresAt: revocationExpiry,
      }),
    ).resolves.toBeNull();
    const reacquire = await methods.acquireOpenIDRefreshFlight({
      key: 'flight-key',
      ownerId: 'owner-2',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(reacquire.acquired).toBe(false);
    expect(reacquire.flight?.status).toBe('revoked');
  });

  it('retains a completed result when logout atomically revokes its delivery', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await methods.acquireOpenIDRefreshFlight({
      key: 'completed-flight',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt,
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'completed-flight',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-successor',
      expiresAt,
    });

    const revoked = await methods.revokeOpenIDRefreshFlight({
      key: 'completed-flight',
      expiresAt: new Date(Date.now() + 3600000),
    });

    expect(revoked?.status).toBe('revoked');
    expect(revoked?.encryptedResult).toBe('encrypted-successor');
  });

  it('serializes response delivery without changing the completed publication state', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await methods.acquireOpenIDRefreshFlight({
      key: 'delivery-flight',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt,
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'delivery-flight',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-result',
      expiresAt,
    });

    const first = await methods.claimOpenIDRefreshFlightDelivery({
      key: 'delivery-flight',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 30000),
    });
    expect(first).toMatchObject({ status: 'completed', deliveryId: 'delivery-1' });

    await expect(
      methods.claimOpenIDRefreshFlightDelivery({
        key: 'delivery-flight',
        ownerId: 'owner-1',
        deliveryId: 'delivery-2',
        deliveryExpiresAt: new Date(Date.now() + 30000),
      }),
    ).resolves.toBeNull();

    const released = await methods.releaseOpenIDRefreshFlightDelivery({
      key: 'delivery-flight',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
    expect(released).toMatchObject({ status: 'completed', encryptedResult: 'encrypted-result' });
    expect(released?.deliveryId).toBeUndefined();
  });

  it('recreates an expired generation only for delivery and removes the synthetic row on release', async () => {
    const createdAt = new Date('2026-08-29T12:00:00.000Z');
    const claimed = await methods.claimOpenIDRefreshFlightDelivery({
      key: 'expired-generation',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 30000),
      createdAt,
    });

    expect(claimed).toMatchObject({
      key: 'expired-generation',
      ownerId: 'owner-1',
      status: 'completed',
      deliveryId: 'delivery-1',
    });
    expect(claimed?.createdAt.getTime()).toBe(createdAt.getTime());

    await methods.releaseOpenIDRefreshFlightDelivery({
      key: 'expired-generation',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
    await expect(
      mongoose.models.OpenIDRefreshFlight.findOne({ key: 'expired-generation' }).lean(),
    ).resolves.toBeNull();
  });

  it('makes logout wait for an active delivery and revokes it when the response releases', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await methods.acquireOpenIDRefreshFlight({
      key: 'logout-delivery-flight',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt,
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'logout-delivery-flight',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-result',
      expiresAt,
    });
    await methods.claimOpenIDRefreshFlightDelivery({
      key: 'logout-delivery-flight',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
      deliveryExpiresAt: new Date(Date.now() + 30000),
    });

    let logoutSettled = false;
    const logout = methods
      .revokeOpenIDRefreshFlight({
        key: 'logout-delivery-flight',
        expiresAt: new Date(Date.now() + 3600000),
      })
      .finally(() => {
        logoutSettled = true;
      });

    let revocationRequested = false;
    for (let attempt = 0; attempt < 20 && !revocationRequested; attempt++) {
      const flight = await mongoose.models.OpenIDRefreshFlight.findOne({
        key: 'logout-delivery-flight',
      }).lean<t.IOpenIDRefreshFlight>();
      revocationRequested = Boolean(flight?.revocationRequestedAt);
      if (!revocationRequested) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(revocationRequested).toBe(true);
    expect(logoutSettled).toBe(false);

    const released = await methods.releaseOpenIDRefreshFlightDelivery({
      key: 'logout-delivery-flight',
      ownerId: 'owner-1',
      deliveryId: 'delivery-1',
    });
    expect(released?.status).toBe('revoked');
    await expect(logout).resolves.toMatchObject({
      status: 'revoked',
      encryptedResult: 'encrypted-result',
    });
  });

  it('treats a malformed delivery without an expiry as abandoned during logout', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await methods.acquireOpenIDRefreshFlight({
      key: 'abandoned-delivery-flight',
      ownerId: 'owner-1',
      lockExpiresAt: new Date(Date.now() + 30000),
      expiresAt,
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'abandoned-delivery-flight',
      ownerId: 'owner-1',
      encryptedResult: 'encrypted-result',
      expiresAt,
    });
    await mongoose.models.OpenIDRefreshFlight.updateOne(
      { key: 'abandoned-delivery-flight' },
      { $set: { deliveryId: 'orphaned-delivery' }, $unset: { deliveryExpiresAt: '' } },
    );

    await expect(
      methods.revokeOpenIDRefreshFlight({
        key: 'abandoned-delivery-flight',
        expiresAt: new Date(Date.now() + 3600000),
      }),
    ).resolves.toMatchObject({ status: 'revoked' });
  });
});
