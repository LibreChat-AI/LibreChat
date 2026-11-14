import type { ClientSession, Model } from 'mongoose';
import type { PostgresDatabase } from '../pool';
import type { IToken } from '~/types/token';
import { resolveTenantScope, tenantFilter } from '~/tenant/policy';

export interface MCPAuthorityTokenRecord {
  readonly storageRevision: string;
  _id: string;
  type?: string;
  identifier?: string;
  token: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}
export interface MCPTokenGeneration {
  type: string;
  identifier: string;
  metadata?: { credential_set_id?: unknown };
}
export interface MCPTokenSelection {
  userId: string;
  tenantId?: string;
  serverNames: readonly string[];
}
export interface TokenQueries {
  findMCPTokenUserIds(input: {
    serverName: string;
    tenantId?: string;
    scope: 'exact' | 'context';
  }): Promise<string[]>;
  getMCPAuthorityTokens(
    input: MCPTokenSelection & { limit: number },
  ): Promise<{ tokens: MCPAuthorityTokenRecord[]; count: number }>;
  getMCPTokenGenerations(input: MCPTokenSelection): Promise<MCPTokenGeneration[]>;
}

function identities(names: readonly string[]): Array<{ type: string; identifier: string }> {
  return [...new Set(names)].flatMap((name) => [
    { type: 'mcp_oauth', identifier: `mcp:${name}` },
    { type: 'mcp_oauth_refresh', identifier: `mcp:${name}:refresh` },
    { type: 'mcp_oauth_client', identifier: `mcp:${name}:client` },
  ]);
}
function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 96)
    throw new TypeError('Invalid MCP authority token limit');
  return value + 1;
}

/** The optional session is internal to the Mongo authority snapshot, not a port argument. */
export function createMongoTokenQueries(
  mongoose: typeof import('mongoose'),
  session?: ClientSession,
): TokenQueries {
  const model = () => mongoose.models.Token as Model<IToken>;
  const filter = (input: MCPTokenSelection) => ({
    userId: new mongoose.Types.ObjectId(input.userId),
    tenantId: input.tenantId ?? null,
    $or: identities(input.serverNames),
  });
  return {
    async findMCPTokenUserIds(input) {
      const identifier = `mcp:${input.serverName}`;
      const ids = await model()
        .distinct('userId', {
          ...(input.scope === 'exact' ? { tenantId: input.tenantId ?? null } : {}),
          identifier: { $in: [identifier, `${identifier}:client`, `${identifier}:refresh`] },
        })
        .read('primary');
      return ids.map(String);
    },
    async getMCPAuthorityTokens(input) {
      const maximum = limit(input.limit);
      if (!input.serverNames.length) return { tokens: [], count: 0 };
      const queryFilter = {
        ...filter(input),
        ...(input.tenantId === undefined ? { tenantId: { $exists: false } } : {}),
      };
      const countQuery = model()
        .countDocuments(queryFilter)
        .limit(maximum)
        .session(session ?? null);
      if (!session) countQuery.read('primary').readConcern('majority');
      const count = await countQuery;
      const rowQuery = model()
        .find(queryFilter)
        .select('_id type identifier token metadata createdAt expiresAt __v')
        .sort({ _id: 1 })
        .limit(maximum)
        .setOptions({ singleBatch: true })
        .session(session ?? null);
      if (!session) rowQuery.read('primary').readConcern('majority');
      const found = await rowQuery.lean<IToken[]>({ flattenMaps: true });
      const tokens = found.map((row) => ({
        _id: String(row._id),
        storageRevision: String(row.__v ?? 0),
        type: row.type,
        identifier: row.identifier,
        token: row.token,
        metadata: row.metadata instanceof Map ? Object.fromEntries(row.metadata) : row.metadata,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
      return { tokens, count };
    },
    async getMCPTokenGenerations(input) {
      if (!input.serverNames.length) return [];
      const rows = await model()
        .aggregate<{
          _id: { type: string; identifier: string };
          minimum: string | null;
          maximum: string | null;
          invalid: number;
        }>([
          { $match: filter(input) },
          {
            $project: {
              type: 1,
              identifier: 1,
              generation: {
                $cond: [
                  { $eq: [{ $type: '$metadata.credential_set_id' }, 'string'] },
                  '$metadata.credential_set_id',
                  null,
                ],
              },
            },
          },
          {
            $group: {
              _id: { type: '$type', identifier: '$identifier' },
              minimum: { $min: '$generation' },
              maximum: { $max: '$generation' },
              invalid: { $sum: { $cond: [{ $in: ['$generation', [null, '']] }, 1, 0] } },
            },
          },
        ])
        .read('primary');
      return rows.map((row) => ({
        type: row._id.type,
        identifier: row._id.identifier,
        metadata: {
          credential_set_id:
            row.invalid === 0 && row.minimum === row.maximum ? row.minimum : undefined,
        },
      }));
    },
  };
}

export function createPostgresTokenQueries(db: PostgresDatabase): TokenQueries {
  function selection(input: MCPTokenSelection): { values: unknown[]; text: string } {
    const pairs = identities(input.serverNames);
    const tenant = tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
    return {
      values: [
        input.userId,
        input.tenantId ?? null,
        pairs.map((pair) => pair.type),
        pairs.map((pair) => pair.identifier),
        tenant,
      ],
      text: `user_id=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND (type,identifier) IN
        (SELECT * FROM unnest($3::text[],$4::text[])) AND ($5::text IS NULL OR tenant_id=$5)`,
    };
  }
  return {
    async findMCPTokenUserIds(input) {
      const identifier = `mcp:${input.serverName}`;
      const tenant = tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
      const result = await db.query<{ userId: string }>(
        `SELECT DISTINCT user_id AS "userId" FROM auth_tokens WHERE identifier=ANY($1::text[])
         AND ($2::boolean OR tenant_id IS NOT DISTINCT FROM $3) AND ($4::text IS NULL OR tenant_id=$4)`,
        [
          [identifier, `${identifier}:client`, `${identifier}:refresh`],
          input.scope === 'context',
          input.tenantId ?? null,
          tenant,
        ],
      );
      return result.rows.map((row) => row.userId);
    },
    async getMCPAuthorityTokens(input) {
      const maximum = limit(input.limit);
      const query = selection(input);
      const result = await db.query<MCPAuthorityTokenRecord>(
        `SELECT id AS "_id",revision::text AS "storageRevision",type,identifier,token,metadata,created_at AS "createdAt",expires_at AS "expiresAt"
         FROM auth_tokens WHERE ${query.text} ORDER BY id LIMIT $6`,
        [...query.values, maximum],
      );
      return { tokens: result.rows, count: result.rows.length };
    },
    async getMCPTokenGenerations(input) {
      const query = selection(input);
      const result = await db.query<{
        type: string;
        identifier: string;
        generation: string | null;
      }>(
        `SELECT type,identifier,CASE WHEN bool_and(jsonb_typeof(metadata->'credential_set_id')='string'
          AND COALESCE(metadata->>'credential_set_id','')<>'')
          AND min(metadata->>'credential_set_id')=max(metadata->>'credential_set_id')
          THEN min(metadata->>'credential_set_id') ELSE NULL END AS generation
         FROM auth_tokens WHERE ${query.text} GROUP BY type,identifier`,
        query.values,
      );
      return result.rows.map((row) => ({
        type: row.type,
        identifier: row.identifier,
        metadata: { credential_set_id: row.generation ?? undefined },
      }));
    },
  };
}
