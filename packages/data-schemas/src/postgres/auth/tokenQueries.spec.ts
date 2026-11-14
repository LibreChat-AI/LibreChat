import mongoose from 'mongoose';
import type { PostgresDatabase } from '../pool';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createPostgresTestDatabase } from '../postgres.helper';
import { createMCPServerMethods } from '~/methods/mcpServer';
import { createPostgresTokenQueries } from './tokenQueries';
import { migratePostgresAuthentication } from './schema';
import { createPostgresTokenMethods } from './token';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const userId = '0123456789abcdef01234567';
const other = '1123456789abcdef01234567';

it('delegates MCP server token discovery to the injected selected authority', async () => {
  const findMCPTokenUserIds = jest.fn().mockResolvedValue([userId]);
  const methods = createMCPServerMethods(mongoose, {
    getSoleOwnedResourceIds: async () => [],
    tokenQueries: { findMCPTokenUserIds },
  });
  expect(await methods.findMCPServerOAuthTokenUserIds('server', 'tenant')).toEqual([userId]);
  expect(findMCPTokenUserIds).toHaveBeenCalledWith({
    serverName: 'server',
    tenantId: 'tenant',
    scope: 'exact',
  });
});

postgres('selected PostgreSQL MCP token queries', () => {
  let db: PostgresDatabase;
  let queries: ReturnType<typeof createPostgresTokenQueries>;
  let tokens: ReturnType<typeof createPostgresTokenMethods>;
  beforeAll(async () => {
    ({ db } = await createPostgresTestDatabase());
    await migratePostgresAuthentication(db);
    queries = createPostgresTokenQueries(db);
    tokens = createPostgresTokenMethods(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE auth_tokens');
  });
  afterAll(async () => {
    await db?.close();
  });
  const insert = (
    patch: Parameters<typeof tokens.createToken>[0] = { userId, token: 'secret', expiresIn: 60 },
  ) =>
    tokens.createToken({
      type: 'mcp_oauth',
      identifier: 'mcp:server',
      metadata: { credential_set_id: 'generation' },
      ...patch,
    });

  it('preserves exact tenantless and contextual discovery including expired credentials', async () => {
    await insert({ userId, token: 'old', expiresIn: -60 });
    await tenantStorage.run({ tenantId: 'tenant' }, () =>
      insert({ userId: other, token: 'new', expiresIn: 60 }),
    );
    expect(await queries.findMCPTokenUserIds({ serverName: 'server', scope: 'exact' })).toEqual([
      userId,
    ]);
    expect(
      (
        await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
          queries.findMCPTokenUserIds({ serverName: 'server', scope: 'context' }),
        )
      ).sort(),
    ).toEqual([userId, other].sort());
    expect(
      await tenantStorage.run({ tenantId: 'tenant' }, () =>
        queries.findMCPTokenUserIds({ serverName: 'server', scope: 'context' }),
      ),
    ).toEqual([other]);
    expect(
      await queries.findMCPTokenUserIds({ serverName: "server' OR TRUE --", scope: 'context' }),
    ).toEqual([]);
  });

  it('returns a bounded overflow sentinel rather than an apparently complete truncated proof', async () => {
    for (let i = 0; i < 4; i++) await insert({ userId, token: String(i), expiresIn: 60 });
    const found = await queries.getMCPAuthorityTokens({
      userId,
      serverNames: ['server'],
      limit: 2,
    });
    expect(found.count).toBe(3);
    expect(found.tokens).toHaveLength(3);
    expect(found.tokens[0]).toMatchObject({
      _id: expect.stringMatching(/^[a-f0-9]{24}$/),
      metadata: { credential_set_id: 'generation' },
    });
    expect(await queries.getMCPAuthorityTokens({ userId, serverNames: [], limit: 2 })).toEqual({
      tokens: [],
      count: 0,
    });
    await expect(
      queries.getMCPAuthorityTokens({ userId, serverNames: ['server'], limit: 97 }),
    ).rejects.toThrow('limit');
  });

  it('fails generation comparison closed for missing, nonstring, or conflicting credential sets', async () => {
    await insert();
    expect(await queries.getMCPTokenGenerations({ userId, serverNames: ['server'] })).toEqual([
      {
        type: 'mcp_oauth',
        identifier: 'mcp:server',
        metadata: { credential_set_id: 'generation' },
      },
    ]);
    await insert({ userId, token: 'missing', expiresIn: 60, metadata: {} });
    expect(
      (await queries.getMCPTokenGenerations({ userId, serverNames: ['server'] }))[0].metadata
        ?.credential_set_id,
    ).toBeUndefined();
    await db.query('TRUNCATE auth_tokens');
    await insert({ userId, token: 'number', expiresIn: 60, metadata: { credential_set_id: 123 } });
    expect(
      (await queries.getMCPTokenGenerations({ userId, serverNames: ['server'] }))[0].metadata
        ?.credential_set_id,
    ).toBeUndefined();
    await insert({
      userId,
      token: 'string',
      expiresIn: 60,
      metadata: { credential_set_id: '123' },
    });
    expect(
      (await queries.getMCPTokenGenerations({ userId, serverNames: ['server'] }))[0].metadata
        ?.credential_set_id,
    ).toBeUndefined();
  });
});
