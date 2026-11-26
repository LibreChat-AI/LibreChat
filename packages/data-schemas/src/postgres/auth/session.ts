import { randomBytes } from 'node:crypto';
import type { SessionMethods, SessionMethodDeps } from '~/methods/session';
import type { SessionRecord } from '~/types/session';
import type { PostgresDatabase } from '../pool';
import { createSessionToken, SessionError, DEFAULT_REFRESH_TOKEN_EXPIRY } from '~/methods/session';
import { resolveTenantScope, tenantFilter, TenantIsolationError } from '~/tenant/policy';
import { hashToken } from '~/crypto';

const columns = `id AS "_id", user_id AS "user", refresh_token_hash AS "refreshTokenHash",
  expiration, tenant_id AS "tenantId"`;
type SessionRow = Omit<SessionRecord, 'tenantId'> & { tenantId: string | null };

function record(row: SessionRow): SessionRecord {
  const { tenantId, ...session } = row;
  return { ...session, ...(tenantId == null ? {} : { tenantId }) };
}

function objectId(value: string): string {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new Error('Invalid session identifier');
  return value.toLowerCase();
}

function tenant(): string | null {
  return tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
}

export function createPostgresSessionMethods(
  db: PostgresDatabase,
  deps: SessionMethodDeps = {},
): SessionMethods {
  const digest = deps.hashToken ?? hashToken;
  return {
    SessionError,
    async ensureSessionIndexes() {
      await db.query('SELECT id FROM auth_sessions LIMIT 0');
    },
    async createSession(userId, options = {}) {
      if (!userId) throw new SessionError('User ID is required', 'INVALID_USER_ID');
      try {
        const scope = tenant();
        const session = {
          _id: randomBytes(12).toString('hex'),
          user: objectId(userId),
          expiration:
            options.expiration ??
            new Date(Date.now() + (options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY)),
        };
        const { refreshToken, refreshTokenHash } = await createSessionToken(session, deps);
        const result = await db.query<SessionRow>(
          `INSERT INTO auth_sessions (id,user_id,tenant_id,refresh_token_hash,expiration)
           VALUES ($1,$2,$3,$4,$5) RETURNING ${columns}`,
          [session._id, session.user, scope, refreshTokenHash, session.expiration],
        );
        return { session: record(result.rows[0]), refreshToken };
      } catch {
        throw new SessionError('Failed to create session', 'CREATE_SESSION_FAILED');
      }
    },
    async upsertSession(userId, refreshToken, options) {
      if (!userId || !refreshToken || !options.expiration) {
        throw new SessionError(
          'User, refresh token, and expiration are required',
          'INVALID_SESSION',
        );
      }
      try {
        const scope = resolveTenantScope('Query');
        const filter = tenantFilter(scope)?.tenantId ?? null;
        if (scope.kind === 'scoped' && options.tenantId && options.tenantId !== scope.tenantId) {
          throw new TenantIsolationError('Cross-tenant tenantId mutation is not allowed');
        }
        const target = scope.kind === 'system' ? (options.tenantId ?? null) : filter;
        const result = await db.query<SessionRow>(
          `INSERT INTO auth_sessions (id,user_id,tenant_id,refresh_token_hash,expiration)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,refresh_token_hash)
           DO UPDATE SET expiration=EXCLUDED.expiration,
             tenant_id=CASE WHEN $7::boolean THEN EXCLUDED.tenant_id ELSE auth_sessions.tenant_id END
           WHERE ($6::text IS NULL OR auth_sessions.tenant_id=$6) RETURNING ${columns}`,
          [
            randomBytes(12).toString('hex'),
            objectId(userId),
            target,
            await digest(refreshToken),
            options.expiration,
            filter,
            scope.kind === 'system' && Boolean(options.tenantId),
          ],
        );
        if (!result.rows[0]) throw new Error('Stored session was not returned');
        return record(result.rows[0]);
      } catch {
        throw new SessionError('Failed to store session', 'UPSERT_SESSION_FAILED');
      }
    },
    async findSession(params, _options) {
      try {
        if (!params.refreshToken && !params.userId && !params.sessionId) {
          throw new Error('At least one search parameter is required');
        }
        const id =
          typeof params.sessionId === 'object' ? params.sessionId.sessionId : params.sessionId;
        const result = await db.query<SessionRow>(
          `SELECT ${columns} FROM auth_sessions WHERE expiration>$1
           AND ($2::text IS NULL OR tenant_id=$2) AND ($3::text IS NULL OR user_id=$3)
           AND ($4::text IS NULL OR id=$4) AND ($5::text IS NULL OR refresh_token_hash=$5) LIMIT 1`,
          [
            new Date(),
            tenant(),
            params.userId ? objectId(params.userId) : null,
            id ? objectId(id) : null,
            params.refreshToken ? await digest(params.refreshToken) : null,
          ],
        );
        return result.rows[0] ? record(result.rows[0]) : null;
      } catch {
        throw new SessionError('Failed to find session', 'FIND_SESSION_FAILED');
      }
    },
    async deleteSession(params) {
      try {
        if (!params.refreshToken && !params.sessionId) throw new Error('Missing session selector');
        const result = await db.query(
          `DELETE FROM auth_sessions WHERE ($1::text IS NULL OR tenant_id=$1)
           AND ($2::text IS NULL OR id=$2) AND ($3::text IS NULL OR refresh_token_hash=$3)
           AND id=(SELECT id FROM auth_sessions WHERE ($1::text IS NULL OR tenant_id=$1)
             AND ($2::text IS NULL OR id=$2)
             AND ($3::text IS NULL OR refresh_token_hash=$3) LIMIT 1)`,
          [
            tenant(),
            params.sessionId ? objectId(params.sessionId) : null,
            params.refreshToken ? await digest(params.refreshToken) : null,
          ],
        );
        return { deletedCount: result.rowCount ?? 0 };
      } catch {
        throw new SessionError('Failed to delete session', 'DELETE_SESSION_FAILED');
      }
    },
    async deleteAllUserSessions(userId, options = {}) {
      try {
        const user = typeof userId === 'object' && userId !== null ? userId.userId : userId;
        const result = await db.query(
          `DELETE FROM auth_sessions WHERE user_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
           AND ($3::text IS NULL OR id<>$3)`,
          [
            objectId(user),
            tenant(),
            options.excludeCurrentSession && options.currentSessionId
              ? objectId(options.currentSessionId)
              : null,
          ],
        );
        return { deletedCount: result.rowCount ?? 0 };
      } catch {
        throw new SessionError('Failed to delete user sessions', 'DELETE_ALL_SESSIONS_FAILED');
      }
    },
    async generateRefreshToken(session) {
      if (!session || !session.user)
        throw new SessionError('Invalid session object', 'INVALID_SESSION');
      try {
        const scope = tenant();
        const previousHash = session.refreshTokenHash;
        const { refreshToken, refreshTokenHash } = await createSessionToken(session, deps);
        if (refreshTokenHash === previousHash) throw new Error('Refresh token did not change');
        const result = await db.query(
          `UPDATE auth_sessions SET refresh_token_hash=$1 WHERE id=$2 AND user_id=$3
           AND refresh_token_hash=$4 AND expiration>$5
           AND tenant_id IS NOT DISTINCT FROM $6::text AND ($7::text IS NULL OR tenant_id=$7)`,
          [
            refreshTokenHash,
            objectId(session._id),
            objectId(session.user),
            previousHash,
            new Date(),
            session.tenantId ?? null,
            scope,
          ],
        );
        if (result.rowCount !== 1) throw new Error('Session is no longer current');
        return refreshToken;
      } catch {
        throw new SessionError('Failed to generate refresh token', 'GENERATE_TOKEN_FAILED');
      }
    },
  };
}
