import type { PasskeyCreateData } from '~/types/passkey';
import type { PasskeyMethods } from '~/methods/passkey';
import type { PostgresDatabase } from '../pool';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createPostgresTestDatabase } from '../postgres.helper';
import { resetTenantStrictCache } from '~/tenant/policy';
import { migratePostgresAuthentication } from './schema';
import { createPostgresPasskeyMethods } from './passkey';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const user = '0123456789abcdef01234567';
const other = '1123456789abcdef01234567';
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const data = (patch: Partial<PasskeyCreateData> = {}): PasskeyCreateData => ({
  user,
  credentialId: 'credential',
  publicKey: Buffer.from([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
  deviceType: 'multiDevice',
  backedUp: true,
  name: ' This device ',
  ...patch,
});

postgres('PostgreSQL passkeys', () => {
  let db: PostgresDatabase;
  let methods: PasskeyMethods;
  const strict = process.env.TENANT_ISOLATION_STRICT;
  beforeAll(async () => {
    ({ db } = await createPostgresTestDatabase());
    await migratePostgresAuthentication(db);
    methods = createPostgresPasskeyMethods(db);
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await db.query('TRUNCATE auth_passkeys');
    process.env.TENANT_ISOLATION_STRICT = 'false';
    resetTenantStrictCache();
  });
  afterAll(async () => {
    if (strict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
    else process.env.TENANT_ISOLATION_STRICT = strict;
    resetTenantStrictCache();
    await db?.close();
  });

  it('returns plain records, real public key bytes and schema defaults', async () => {
    const created = await methods.createPasskey(data({ transports: undefined }));
    expect(created).toMatchObject({
      id: expect.stringMatching(/^[a-f\d]{24}$/),
      userId: user,
      publicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: [],
      name: 'This device',
      lastUsedAt: null,
      createdAt: expect.any(Date),
    });
    expect(created).not.toHaveProperty('save');
    expect(await methods.findPasskeyByCredentialId('credential')).toEqual(created);
  });

  it('enforces credential uniqueness across users and tenant contexts', async () => {
    await inTenant('a', () => methods.createPasskey(data()));
    await expect(
      inTenant('b', () => methods.createPasskey(data({ user: other }))),
    ).rejects.toThrow();
  });

  it('lists only owner credentials newest first and counts them', async () => {
    const first = await methods.createPasskey(data());
    const second = await methods.createPasskey(data({ credentialId: 'second' }));
    await db.query('UPDATE auth_passkeys SET created_at=$1 WHERE id=$2', [new Date(0), first.id]);
    await methods.createPasskey(data({ user: other, credentialId: 'other' }));
    expect((await methods.findPasskeysByUser(user)).map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await methods.countPasskeysByUser(user)).toBe(2);
  });

  it('allows exactly one counter transition for concurrent replayed assertions', async () => {
    await methods.createPasskey(data({ counter: 1 }));
    const results = await Promise.all([
      methods.recordPasskeyUse('credential', 2, false),
      methods.recordPasskeyUse('credential', 2, false),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await methods.recordPasskeyUse('credential', 1)).toBe(false);
    expect(await methods.recordPasskeyUse('credential', 0)).toBe(false);
    expect(await methods.findPasskeyByCredentialId('credential')).toMatchObject({
      counter: 2,
      backedUp: false,
      lastUsedAt: expect.any(Date),
    });
  });

  it('retains counterless behavior but never treats a failed capable-counter write as success', async () => {
    await methods.createPasskey(data());
    expect(await methods.recordPasskeyUse('credential', 0)).toBe(true);
    expect(await methods.recordPasskeyUse('credential', 0)).toBe(true);
    expect(await methods.recordPasskeyUse('absent', 0)).toBe(false);
    jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('database unavailable'));
    expect(await methods.recordPasskeyUse('credential', 1)).toBe(false);
    jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('database unavailable'));
    expect(await methods.recordPasskeyUse('credential', 0)).toBe(true);
  });

  it('requires ownership for rename and delete and preserves binary bytes during updates', async () => {
    const created = await methods.createPasskey(data());
    expect(await methods.renamePasskey(created.id, other, 'Stolen')).toBeNull();
    expect(await methods.deletePasskey(created.id, other)).toEqual({
      acknowledged: true,
      deletedCount: 0,
    });
    expect(await methods.renamePasskey(created.id, user, 'New name')).toMatchObject({
      name: 'New name',
      publicKey: Buffer.from([1, 2, 3]),
    });
    expect(await methods.deletePasskeysByUser(user)).toEqual({
      acknowledged: true,
      deletedCount: 1,
    });
  });

  it('isolates preauthentication lookups, counters and mutations by active tenant', async () => {
    const created = await inTenant('a', () => methods.createPasskey(data()));
    await inTenant('b', async () => {
      expect(await methods.findPasskeyByCredentialId('credential')).toBeNull();
      expect(await methods.findPasskeysByUser(user)).toEqual([]);
      expect(await methods.countPasskeysByUser(user)).toBe(0);
      expect(await methods.recordPasskeyUse('credential', 1)).toBe(false);
      expect(await methods.renamePasskey(created.id, user, 'Hidden')).toBeNull();
      expect(await methods.deletePasskey(created.id, user)).toMatchObject({ deletedCount: 0 });
      expect(await methods.deletePasskeysByUser(user)).toMatchObject({ deletedCount: 0 });
    });
    expect(
      await inTenant(SYSTEM_TENANT_ID, () => methods.findPasskeyByCredentialId('credential')),
    ).toMatchObject({ tenantId: 'a' });
  });

  it('fails closed on strict scope errors, including a counterless assertion', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();
    await expect(methods.findPasskeyByCredentialId('credential')).rejects.toThrow('tenant context');
    await expect(methods.recordPasskeyUse('credential', 0)).rejects.toThrow('tenant context');
    await expect(methods.createPasskey(data())).rejects.toThrow('tenant context');
  });

  it('rejects invalid input without storing a row', async () => {
    await expect(methods.createPasskey(data({ counter: -1 }))).rejects.toThrow();
    await expect(methods.createPasskey(data({ name: ' ' }))).rejects.toThrow();
    await expect(methods.createPasskey(data({ user: 'invalid' }))).rejects.toThrow();
    expect(await methods.countPasskeysByUser(user)).toBe(0);
  });
});
