import type { AuthenticationSnapshotRow, AuthenticationSnapshotSource } from './import';
import type { PostgresDatabase } from '../pool';
import {
  importAuthentication,
  fingerprintAuthentication,
  readPostgresAuthentication,
} from './import';
import { migratePostgresAuthentication, assertPostgresAuthenticationReady } from './schema';
import { createPostgresTestDatabase } from '../postgres.helper';
import { purgeExpiredAuthentication } from './backend';
import { assertPostgresReady } from '../migrations';
import { migratePostgres } from '../migrations';
import { importFavorites } from '../import';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
postgres('authentication schema and offline import', () => {
  let db: PostgresDatabase | undefined;
  beforeEach(async () => {
    ({ db } = await createPostgresTestDatabase());
    await migratePostgresAuthentication(db);
  });
  afterEach(async () => {
    await db?.close();
  });
  const row = (index: number): AuthenticationSnapshotRow => ({
    kind: 'sessions',
    values: {
      id: index.toString(16).padStart(24, '0'),
      user_id: '0123456789abcdef01234567',
      tenant_id: null,
      refresh_token_hash: `hashed-${index}`,
      expiration: new Date('2030-01-01'),
    },
  });
  const source = (rows: AuthenticationSnapshotRow[]): AuthenticationSnapshotSource =>
    async function* () {
      yield* rows;
    };
  it('keeps migrated schemas separate from verified data and requires an explicit empty assertion', async () => {
    await expect(assertPostgresAuthenticationReady(db!)).rejects.toThrow('not verified');
    await expect(importAuthentication(db!, source([]), { offline: true })).rejects.toThrow(
      'verified-empty',
    );
    await importAuthentication(db!, source([]), { offline: true, verifiedEmpty: true });
    expect((await db!.query('SELECT activated FROM auth_readiness')).rows).toEqual([
      { activated: false },
    ]);
    await assertPostgresAuthenticationReady(db!);
    await expect(
      importAuthentication(db!, source([]), { offline: true, verifiedEmpty: true }),
    ).rejects.toThrow('authority');
  });
  it('adds authentication schema without changing the deployed favorites schema or activation', async () => {
    await migratePostgres(db!);
    await importFavorites(db!, async function* () {}, {
      offline: true,
      batchSize: 1,
      verifiedEmpty: true,
    });
    await assertPostgresReady(db!);
    const before = await db!.query('SELECT * FROM tool_favorite_readiness');
    await Promise.all([migratePostgresAuthentication(db!), migratePostgresAuthentication(db!)]);
    expect((await db!.query('SELECT * FROM tool_favorite_readiness')).rows).toEqual(before.rows);
    await assertPostgresReady(db!);
  });
  it('validates dry-run snapshots without changing data, checkpoints or readiness', async () => {
    const before = (await db!.query('SELECT * FROM auth_readiness')).rows;
    await expect(
      importAuthentication(db!, source([row(1)]), { offline: true, dryRun: true }),
    ).resolves.toEqual(await fingerprintAuthentication(source([row(1)])));
    expect((await db!.query('SELECT * FROM auth_sessions')).rows).toEqual([]);
    expect((await db!.query('SELECT * FROM auth_readiness')).rows).toEqual(before);
    await expect(
      importAuthentication(
        db!,
        source([{ ...row(1), values: { ...row(1).values, user_id: 'invalid' } }]),
        { offline: true, dryRun: true },
      ),
    ).rejects.toThrow('owner');
  });
  it('commits batch checkpoints and resumes only the identical complete snapshot', async () => {
    const rows = Array.from({ length: 301 }, (_, index) => row(index + 1));
    let pass = 0;
    const interrupted: AuthenticationSnapshotSource = async function* () {
      ++pass;
      for (let index = 0; index < rows.length; index++) {
        if (pass === 2 && index === 250) throw new Error('source unavailable');
        yield rows[index];
      }
    };
    await expect(importAuthentication(db!, interrupted, { offline: true })).rejects.toThrow(
      'source unavailable',
    );
    expect((await db!.query('SELECT count(*) FROM auth_sessions')).rows).toEqual([
      { count: '250' },
    ]);
    expect((await db!.query('SELECT verified FROM auth_readiness')).rows).toEqual([
      { verified: false },
    ]);
    await expect(
      importAuthentication(db!, source(rows.slice(1)), { offline: true }),
    ).rejects.toThrow('authority');
    const expected = await fingerprintAuthentication(source(rows));
    await expect(importAuthentication(db!, source(rows), { offline: true })).resolves.toEqual(
      expected,
    );
    expect(await fingerprintAuthentication(readPostgresAuthentication(db!))).toEqual(expected);
    await expect(importAuthentication(db!, source(rows), { offline: true })).resolves.toEqual(
      expected,
    );
    await assertPostgresAuthenticationReady(db!);
  });
  it('rejects destination drift and altered source without marking partial imports ready', async () => {
    await db!.query(
      "INSERT INTO auth_sessions VALUES('000000000000000000000099','0123456789abcdef01234567',NULL,'unrelated','2030-01-01')",
    );
    await expect(importAuthentication(db!, source([row(1)]), { offline: true })).rejects.toThrow(
      'verification',
    );
    expect((await db!.query('SELECT verified FROM auth_readiness')).rows).toEqual([
      { verified: false },
    ]);
  });
  it('reclaims only a bounded expired batch without deleting a live refresh delivery', async () => {
    await db!.query(
      "INSERT INTO auth_sessions VALUES ('000000000000000000000001','0123456789abcdef01234567',NULL,'expired-one',now()-interval '1 minute'),('000000000000000000000002','0123456789abcdef01234567',NULL,'expired-two',now()-interval '1 minute'),('000000000000000000000003','0123456789abcdef01234567',NULL,'live',now()+interval '1 hour')",
    );
    await db!.query(
      "INSERT INTO auth_refresh_flights(id,key,owner_id,status,delivery_id,delivery_expires_at,created_at,updated_at,lock_expires_at,expires_at) VALUES('000000000000000000000004','delivering','owner','completed','delivery',now()+interval '1 minute',now(),now(),now(),now()-interval '1 minute')",
    );
    await purgeExpiredAuthentication(db!, 1);
    expect((await db!.query('SELECT count(*) FROM auth_sessions')).rows).toEqual([{ count: '2' }]);
    expect((await db!.query('SELECT key FROM auth_refresh_flights')).rows).toEqual([
      { key: 'delivering' },
    ]);
    await purgeExpiredAuthentication(db!, 1);
    expect((await db!.query('SELECT refresh_token_hash FROM auth_sessions')).rows).toEqual([
      { refresh_token_hash: 'live' },
    ]);
    await expect(purgeExpiredAuthentication(db!, 0)).rejects.toThrow('batch size');
  });
  it('refuses schema drift before activation', async () => {
    await importAuthentication(db!, source([]), { offline: true, verifiedEmpty: true });
    await db!.query('ALTER TABLE auth_passkeys ENABLE ROW LEVEL SECURITY');
    await expect(assertPostgresAuthenticationReady(db!)).rejects.toThrow('schema mismatch');
    expect((await db!.query('SELECT activated FROM auth_readiness')).rows).toEqual([
      { activated: false },
    ]);
  });
});
