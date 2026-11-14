import type { PostgresDatabase } from '../pool';
import { createPostgresOpenIDRefreshFlightMethods } from './flight';
import { createPostgresTestDatabase } from '../postgres.helper';
import { migratePostgresAuthentication } from './schema';
import { createPostgresDatabase } from '../pool';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const future = () => new Date(Date.now() + 60_000);
postgres('native PostgreSQL OpenID refresh flights', () => {
  let db: PostgresDatabase;
  let peer: PostgresDatabase;
  let methods: ReturnType<typeof createPostgresOpenIDRefreshFlightMethods>;
  let other: ReturnType<typeof createPostgresOpenIDRefreshFlightMethods>;
  beforeAll(async () => {
    const setup = await createPostgresTestDatabase();
    db = setup.db;
    peer = createPostgresDatabase(setup.options);
    await migratePostgresAuthentication(db);
    methods = createPostgresOpenIDRefreshFlightMethods(db);
    other = createPostgresOpenIDRefreshFlightMethods(peer);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE auth_refresh_flights');
  });
  afterAll(async () => {
    await peer?.close();
    await db?.close();
  });

  it('admits one owner across pools and refuses completion by a replaced owner', async () => {
    const results = await Promise.all(
      ['a', 'b'].map((ownerId, i) =>
        (i ? other : methods).acquireOpenIDRefreshFlight({
          key: 'key',
          ownerId,
          lockExpiresAt: future(),
          expiresAt: future(),
        }),
      ),
    );
    expect(results.filter((row) => row.acquired)).toHaveLength(1);
    expect(results[0].flight?._id).toMatch(/^[a-f0-9]{24}$/);
    const first = results.find((row) => row.acquired)!.flight!;
    await db.query('UPDATE auth_refresh_flights SET lock_expires_at=$1', [new Date(0)]);
    expect(
      (
        await other.acquireOpenIDRefreshFlight({
          key: 'key',
          ownerId: 'replacement',
          lockExpiresAt: future(),
          expiresAt: future(),
        })
      ).acquired,
    ).toBe(true);
    expect(
      await methods.completeOpenIDRefreshFlight({
        key: 'key',
        ownerId: first.ownerId,
        encryptedResult: 'stale',
        expiresAt: future(),
      }),
    ).toBeNull();
    expect(
      await methods.renewOpenIDRefreshFlight({
        key: 'key',
        ownerId: first.ownerId,
        lockExpiresAt: future(),
        expiresAt: future(),
      }),
    ).toBeNull();
    expect(
      await methods.failOpenIDRefreshFlight({
        key: 'key',
        ownerId: first.ownerId,
        errorMessage: 'stale',
        expiresAt: future(),
      }),
    ).toBeNull();
  });

  it('serializes logout with active delivery and does not let a stale delivery release its successor', async () => {
    await methods.acquireOpenIDRefreshFlight({
      key: 'key',
      ownerId: 'owner',
      lockExpiresAt: future(),
      expiresAt: future(),
    });
    await methods.completeOpenIDRefreshFlight({
      key: 'key',
      ownerId: 'owner',
      encryptedResult: 'encrypted',
      expiresAt: future(),
    });
    const claims = await Promise.all(
      ['first', 'second'].map((deliveryId, i) =>
        (i ? other : methods).claimOpenIDRefreshFlightDelivery({
          key: 'key',
          ownerId: 'owner',
          deliveryId,
          deliveryExpiresAt: future(),
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    let settled = false;
    const revoking = other
      .revokeOpenIDRefreshFlight({ key: 'key', expiresAt: future() })
      .then((row) => {
        settled = true;
        return row;
      });
    try {
      for (let i = 0; i < 50; i++) {
        if ((await methods.findOpenIDRefreshFlight({ key: 'key' }))?.revocationRequestedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        (await methods.findOpenIDRefreshFlight({ key: 'key' }))?.revocationRequestedAt,
      ).toBeInstanceOf(Date);
      expect(settled).toBe(false);
      expect(
        await methods.releaseOpenIDRefreshFlightDelivery({
          key: 'key',
          ownerId: 'owner',
          deliveryId: 'stale',
        }),
      ).toBeNull();
    } finally {
      await methods.releaseOpenIDRefreshFlightDelivery({
        key: 'key',
        ownerId: 'owner',
        deliveryId: winner.deliveryId!,
      });
      expect(await revoking).toMatchObject({ status: 'revoked', ownerId: 'revoked' });
    }
    expect(
      await methods.claimOpenIDRefreshFlightDelivery({
        key: 'key',
        ownerId: 'owner',
        deliveryId: 'late',
        deliveryExpiresAt: future(),
      }),
    ).toBeNull();
    expect(
      (
        await methods.acquireOpenIDRefreshFlight({
          key: 'key',
          ownerId: 'late',
          lockExpiresAt: future(),
          expiresAt: future(),
        })
      ).acquired,
    ).toBe(false);
  });

  it('handles synthetic delivery generations and expired leases without TTL deletion', async () => {
    expect(
      await methods.claimOpenIDRefreshFlightDelivery({
        key: 'synthetic',
        ownerId: 'generation',
        deliveryId: 'lease',
        deliveryExpiresAt: future(),
        createdAt: new Date(),
      }),
    ).toMatchObject({ status: 'completed' });
    expect(
      await methods.releaseOpenIDRefreshFlightDelivery({
        key: 'synthetic',
        ownerId: 'generation',
        deliveryId: 'lease',
      }),
    ).toBeNull();
    expect(await methods.findOpenIDRefreshFlight({ key: 'synthetic' })).toBeNull();
    await methods.claimOpenIDRefreshFlightDelivery({
      key: 'expired',
      ownerId: 'generation',
      deliveryId: 'lease',
      deliveryExpiresAt: new Date(0),
      createdAt: new Date(0),
    });
    expect(
      await methods.revokeOpenIDRefreshFlight({ key: 'expired', expiresAt: future() }),
    ).toMatchObject({ status: 'revoked' });
    await db.query('UPDATE auth_refresh_flights SET expires_at=$1 WHERE key=$2', [
      new Date(0),
      'expired',
    ]);
    expect(await methods.findOpenIDRefreshFlight({ key: 'expired' })).toBeNull();
    expect(
      (
        await methods.acquireOpenIDRefreshFlight({
          key: 'expired',
          ownerId: 'new',
          lockExpiresAt: future(),
          expiresAt: future(),
        })
      ).acquired,
    ).toBe(true);
  });
});
