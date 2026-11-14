import type { PostgresDatabase } from '../pool';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createPostgresTestDatabase } from '../postgres.helper';
import { resetTenantStrictCache } from '~/tenant/policy';
import { migratePostgresAuthentication } from './schema';
import { createPostgresTokenMethods } from './token';
import { createPostgresDatabase } from '../pool';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const userId = '0123456789abcdef01234567';
const scoped = <T>(tenantId: string, work: () => Promise<T>) =>
  tenantStorage.run({ tenantId }, work);

postgres('native PostgreSQL tokens', () => {
  let db: PostgresDatabase;
  let peer: PostgresDatabase;
  let methods: ReturnType<typeof createPostgresTokenMethods>;
  const strict = process.env.TENANT_ISOLATION_STRICT;
  beforeAll(async () => {
    const setup = await createPostgresTestDatabase();
    db = setup.db;
    peer = createPostgresDatabase(setup.options);
    await migratePostgresAuthentication(db);
    methods = createPostgresTokenMethods(db);
  });
  beforeEach(async () => {
    process.env.TENANT_ISOLATION_STRICT = 'false';
    resetTenantStrictCache();
    await db.query('TRUNCATE auth_tokens');
  });
  afterAll(async () => {
    if (strict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
    else process.env.TENANT_ISOLATION_STRICT = strict;
    resetTenantStrictCache();
    await peer?.close();
    await db?.close();
  });

  it('returns plain IDs and metadata, normalizes email, and does not hide expired lookup rows', async () => {
    const created = await methods.createToken({
      userId,
      token: 'expired',
      expiresIn: -10,
      email: ' User@Example.com ',
      metadata: new Map([['credential_set_id', 'set-1']]),
    });
    expect(created).toMatchObject({
      _id: expect.stringMatching(/^[a-f0-9]{24}$/),
      userId,
      email: 'user@example.com',
      metadata: { credential_set_id: 'set-1' },
    });
    expect(created).not.toHaveProperty('save');
    expect(
      await methods.findToken({ email: ' USER@example.com ', type: null, identifier: null }),
    ).toEqual(created);
    expect(await methods.findTokensOfUser({ userId, type: 'mcp_oauth' })).toEqual([]);
    expect(await methods.deleteTokens({ userId, token: 'wrong' })).toEqual({ deletedCount: 0 });
    expect(
      await methods.deleteTokens({ userId, token: 'expired', metadataCredentialSetId: 'set-1' }),
    ).toEqual({ deletedCount: 1 });
  });

  it('serializes scoped replacement across independent pools and fences stale generations', async () => {
    const other = createPostgresTokenMethods(peer);
    const data = { userId, token: 'initial', expiresIn: 60 };
    const inserted = await Promise.all([
      methods.replaceTokenIfCurrent('scope', null, data),
      other.replaceTokenIfCurrent('scope', null, { ...data, token: 'different' }),
    ]);
    expect(inserted.filter(Boolean)).toHaveLength(1);
    const current = await methods.findToken({ scope: 'scope' });
    const replacements = await Promise.all([
      methods.replaceTokenIfCurrent('scope', current!.token, { ...data, token: 'next-a' }),
      other.replaceTokenIfCurrent('scope', current!.token, { ...data, token: 'next-b' }),
    ]);
    expect(replacements.filter(Boolean)).toHaveLength(1);
    expect(
      await methods.updateToken(
        { scope: 'scope', metadataCredentialSetId: 'stale' },
        { token: 'lost' },
      ),
    ).toBeNull();
    expect(
      await methods.deleteTokens({ scope: 'scope', metadataCredentialSetId: 'stale' }),
    ).toEqual({ deletedCount: 0 });
    expect((await db.query('SELECT count(*)::text AS count FROM auth_tokens')).rows[0].count).toBe(
      '1',
    );
  });

  it('uses exact null selectors, parameterized identifier regex, conjunctive CAS and projections', async () => {
    await methods.createToken({
      userId,
      token: 'one',
      expiresIn: 60,
      identifier: 'mcp:Server',
      type: 'mcp_oauth',
      metadata: { credential_set_id: 'old' },
    });
    await methods.createToken({ userId, token: 'two', expiresIn: 60, identifier: 'other' });
    expect(await methods.findToken({ identifier: /^mcp:server$/i })).toMatchObject({
      token: 'one',
    });
    await expect(methods.findToken({ identifier: /mcp/g })).rejects.toThrow('Unsupported');
    expect(await methods.findToken({ userId, type: null })).toMatchObject({ token: 'two' });
    const changed = await methods.updateToken(
      { userId, token: 'one', metadataCredentialSetId: 'old' },
      { token: 'new', metadata: { credential_set_id: 'next' } },
    );
    expect(changed?.metadata).toEqual({ credential_set_id: 'next' });
    expect(await methods.findToken({ token: 'new' }, { projection: { token: 1, _id: 0 } })).toEqual(
      { token: 'new' },
    );
    await expect(methods.deleteTokens({})).rejects.toThrow('At least one');
  });

  it('enforces scoped, default-unscoped, system and strict tenant behavior', async () => {
    await scoped('a', () =>
      methods.createToken({ userId, token: 'a', expiresIn: 60, scope: 'shared' }),
    );
    expect(await scoped('b', () => methods.findToken({ token: 'a' }))).toBeNull();
    expect(
      await scoped('b', () =>
        methods.replaceTokenIfCurrent('shared', null, { userId, token: 'a', expiresIn: 60 }),
      ),
    ).toBe(false);
    expect(await methods.findToken({ token: 'a' })).not.toBeNull();
    expect(await scoped(SYSTEM_TENANT_ID, () => methods.findToken({ token: 'a' }))).not.toBeNull();
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();
    await expect(methods.findToken({ token: 'a' })).rejects.toThrow('strict mode');
  });

  it('lists only unexpired tokens of one type and sorts stable token queries', async () => {
    for (const [token, type, expiresIn] of [
      ['z', 'mcp_oauth', 60],
      ['a', 'mcp_oauth', 60],
      ['expired', 'mcp_oauth', -1],
      ['other', 'other', 60],
    ] as const) {
      await methods.createToken({ userId, token, type, expiresIn, email: `${token}@example.com` });
    }
    expect(
      (await methods.findTokensOfUser({ userId, type: 'mcp_oauth' }))
        .map((row) => row.token)
        .sort(),
    ).toEqual(['a', 'z']);
    expect(await methods.findToken({ userId }, { sort: { email: 1 } })).toMatchObject({
      token: 'a',
    });
  });
});
