import { randomBytes } from 'node:crypto';
import type {
  TokenRecord,
  TokenQuery,
  TokenCreateData,
  TokenUpdateData,
  TokenFindOptions,
} from '~/types/token';
import type { TokenListMethods } from '~/methods/tokenList';
import type { TokenMethods } from '~/methods/token';
import type { PostgresDatabase } from '../pool';
import { resolveTenantScope, tenantFilter, stampTenantOnDocument } from '~/tenant/policy';

const columns = `id AS "_id", user_id AS "userId", email, type, scope, identifier, token,
  created_at AS "createdAt", expires_at AS "expiresAt", metadata, tenant_id AS "tenantId"`;

type TokenRow = Omit<
  TokenRecord,
  'email' | 'type' | 'scope' | 'identifier' | 'metadata' | 'tenantId'
> & {
  email: string | null;
  type: string | null;
  scope: string | null;
  identifier: string | null;
  metadata: Record<string, unknown> | null;
  tenantId: string | null;
};

function record(row: TokenRow): TokenRecord {
  return {
    ...row,
    email: row.email ?? undefined,
    type: row.type ?? undefined,
    scope: row.scope ?? undefined,
    identifier: row.identifier ?? undefined,
    metadata: row.metadata ?? undefined,
    tenantId: row.tenantId ?? undefined,
  };
}

function metadata(value: TokenCreateData['metadata']): string | null {
  return value === undefined
    ? null
    : JSON.stringify(value instanceof Map ? Object.fromEntries(value) : value);
}

function expiry(seconds: number): Date {
  const value = new Date(Date.now() + seconds * 1000);
  if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid token expiry');
  return value;
}

/** Domain selectors only; no Mongo operator interpretation. */
function where(query: TokenQuery): { text: string; values: unknown[] } {
  const terms: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    terms.push(`${column} IS NOT DISTINCT FROM $${values.length}`);
  };
  if (query.userId !== undefined) add('user_id', String(query.userId));
  if (query.token !== undefined) add('token', query.token);
  if (query.email !== undefined) add('email', query.email?.trim().toLowerCase() ?? null);
  if (query.type !== undefined) add('type', query.type);
  if (query.scope !== undefined) add('scope', query.scope);
  if (query.identifier instanceof RegExp) {
    const regex = query.identifier;
    if (/[^ims]/.test(regex.flags) || /\\[bB]/.test(regex.source)) {
      throw new TypeError('Unsupported token identifier regular expression');
    }
    // PostgreSQL newline modes: p = JS default, n = m, s = s, w = ms.
    let mode = regex.dotAll ? 's' : 'p';
    if (regex.multiline) mode = regex.dotAll ? 'w' : 'n';
    values.push(`(?${mode}${regex.ignoreCase ? 'i' : ''})${regex.source}`);
    terms.push(`identifier ~ $${values.length}`);
  } else if (query.identifier !== undefined) add('identifier', query.identifier);
  if (query.metadataCredentialSetId !== undefined) {
    if (query.metadataCredentialSetId !== null) {
      terms.push("jsonb_typeof(metadata->'credential_set_id')='string'");
    }
    add("metadata->>'credential_set_id'", query.metadataCredentialSetId);
  }
  if (!terms.length) throw new TypeError('At least one query parameter must be provided');
  const tenant = tenantFilter(resolveTenantScope('Query'));
  if (tenant) add('tenant_id', tenant.tenantId);
  return { text: terms.join(' AND '), values };
}

function tenant(): string | null {
  const document: { tenantId?: string } = {};
  stampTenantOnDocument(resolveTenantScope('save'), document);
  return document.tenantId ?? null;
}

export function createPostgresTokenMethods(db: PostgresDatabase): TokenMethods & TokenListMethods {
  async function update(query: TokenQuery, data: TokenUpdateData): Promise<TokenRecord | null> {
    const filter = where(query);
    const assignments: string[] = [];
    const set = (column: string, value: unknown) => {
      filter.values.push(value);
      assignments.push(`${column}=$${filter.values.length}`);
    };
    if (data.email !== undefined) set('email', data.email.trim().toLowerCase());
    if (data.type !== undefined) set('type', data.type);
    if (data.scope !== undefined) set('scope', data.scope);
    if (data.identifier !== undefined) set('identifier', data.identifier);
    if (data.token !== undefined) set('token', data.token);
    if (data.expiresIn !== undefined) set('expires_at', expiry(data.expiresIn));
    else if (data.expiresAt !== undefined) set('expires_at', data.expiresAt);
    if (data.metadata !== undefined) set('metadata', metadata(data.metadata));
    if (!assignments.length) {
      const found = await db.query<TokenRow>(
        `SELECT ${columns} FROM auth_tokens WHERE ${filter.text} LIMIT 1`,
        filter.values,
      );
      return found.rows[0] ? record(found.rows[0]) : null;
    }
    const result = await db.query<TokenRow>(
      `UPDATE auth_tokens SET ${assignments.join(',')} WHERE id=(SELECT id FROM auth_tokens
       WHERE ${filter.text} LIMIT 1 FOR UPDATE) RETURNING ${columns}`,
      filter.values,
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  return {
    async createToken(data) {
      const result = await db.query<TokenRow>(
        `INSERT INTO auth_tokens (id,user_id,email,type,scope,identifier,token,created_at,expires_at,metadata,tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${columns}`,
        [
          randomBytes(12).toString('hex'),
          String(data.userId),
          data.email?.trim().toLowerCase() ?? null,
          data.type ?? null,
          data.scope ?? null,
          data.identifier ?? null,
          data.token,
          new Date(),
          expiry(data.expiresIn),
          metadata(data.metadata),
          tenant(),
        ],
      );
      return record(result.rows[0]);
    },
    async findToken(query, options) {
      const filter = where(query);
      const order: string[] = [];
      const sortable = {
        _id: 'id',
        userId: 'user_id',
        email: 'email',
        type: 'type',
        scope: 'scope',
        identifier: 'identifier',
        token: 'token',
        createdAt: 'created_at',
        expiresAt: 'expires_at',
        tenantId: 'tenant_id',
      };
      for (const key of Object.keys(options?.sort ?? {}) as Array<keyof typeof sortable>) {
        if (!Object.prototype.hasOwnProperty.call(sortable, key))
          throw new TypeError('Unsupported token sort field');
        order.push(`${sortable[key]} ${options?.sort?.[key] === -1 ? 'DESC' : 'ASC'}`);
      }
      const result = await db.query<TokenRow>(
        `SELECT ${columns} FROM auth_tokens WHERE ${filter.text}${order.length ? ` ORDER BY ${order.join(',')}` : ''} LIMIT 1`,
        filter.values,
      );
      return result.rows[0] ? project(record(result.rows[0]), options?.projection) : null;
    },
    updateToken: update,
    async deleteTokens(query) {
      const filter = where(query);
      const result = await db.query(`DELETE FROM auth_tokens WHERE ${filter.text}`, filter.values);
      return { deletedCount: result.rowCount ?? 0 };
    },
    async replaceTokenIfCurrent(scope, expectedToken, data) {
      const scoped = tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
      if (expectedToken === null) {
        const result = await db.query(
          `INSERT INTO auth_tokens (id,user_id,email,type,scope,identifier,token,created_at,expires_at,metadata,tenant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (scope) DO UPDATE SET scope=auth_tokens.scope
           WHERE auth_tokens.token=EXCLUDED.token AND ($12::text IS NULL OR auth_tokens.tenant_id=$12)
           RETURNING id`,
          [
            randomBytes(12).toString('hex'),
            String(data.userId),
            data.email?.trim().toLowerCase() ?? null,
            data.type ?? null,
            scope,
            data.identifier ?? null,
            data.token,
            new Date(),
            expiry(data.expiresIn),
            metadata(data.metadata),
            tenant(),
            scoped,
          ],
        );
        return (result.rowCount ?? 0) > 0;
      }
      const filter = where({ scope, token: expectedToken });
      const values = filter.values;
      const assignments: string[] = [];
      const set = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column}=$${values.length}`);
      };
      set('user_id', String(data.userId));
      set('token', data.token);
      set('created_at', new Date());
      set('expires_at', expiry(data.expiresIn));
      if (data.email !== undefined) set('email', data.email.trim().toLowerCase());
      if (data.type !== undefined) set('type', data.type);
      if (data.identifier !== undefined) set('identifier', data.identifier);
      if (data.metadata !== undefined) set('metadata', metadata(data.metadata));
      const result = await db.query(
        `UPDATE auth_tokens SET ${assignments.join(',')} WHERE ${filter.text} RETURNING id`,
        values,
      );
      return (result.rowCount ?? 0) > 0;
    },
    async findTokensOfUser(query) {
      const filter = where(query);
      const result = await db.query<TokenRow>(
        `SELECT ${columns} FROM auth_tokens WHERE ${filter.text} AND expires_at>clock_timestamp()
         ORDER BY created_at DESC LIMIT 100`,
        filter.values,
      );
      return result.rows.map(record);
    },
  };
}

function project(value: TokenRecord, projection: TokenFindOptions['projection']): TokenRecord {
  if (!projection) return value;
  const included = Object.entries(projection).some(
    ([key, enabled]) => key !== '_id' && enabled === 1,
  );
  const result: Partial<TokenRecord> = {};
  for (const key of Object.keys(value) as Array<keyof TokenRecord>) {
    if (projection[key] === 0 || (included && key !== '_id' && projection[key] !== 1)) continue;
    Object.assign(result, { [key]: value[key] });
  }
  // The existing projection contract may omit required record fields.
  return result as TokenRecord;
}
