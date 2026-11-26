import { randomBytes } from 'node:crypto';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { BridgeRecord } from '~/types/refreshTokenBridge';
import type { PostgresDatabase } from '../pool';

const columns = `id AS "_id", old_refresh_token_hash AS "oldRefreshTokenHash",
  user_id AS "userId", tenant_id AS "tenantId", openid_issuer AS "openidIssuer",
  encrypted_new_refresh_token AS "encryptedNewRefreshToken", version,
  created_at AS "createdAt", expires_at AS "expiresAt"`;
type BridgeRow = Omit<BridgeRecord, 'tenantId' | 'openidIssuer' | 'version'> & {
  tenantId: string | null;
  openidIssuer: string | null;
  version: string | null;
};
function record(row: BridgeRow): BridgeRecord {
  return {
    ...row,
    tenantId: row.tenantId ?? undefined,
    openidIssuer: row.openidIssuer ?? undefined,
    version: row.version ?? undefined,
  };
}

/** Bridge tenant keys are explicit, including the absent-tenant partition. */
export function createPostgresRefreshTokenBridgeMethods(
  db: PostgresDatabase,
): RefreshTokenBridgeMethods {
  return {
    async upsertRefreshTokenBridge(data) {
      const result = await db.query<BridgeRow>(
        `INSERT INTO auth_bridges (id,old_refresh_token_hash,user_id,tenant_id,openid_issuer,
         encrypted_new_refresh_token,version,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (old_refresh_token_hash,user_id,tenant_id) DO UPDATE SET
         encrypted_new_refresh_token=EXCLUDED.encrypted_new_refresh_token,
         version=COALESCE(EXCLUDED.version,auth_bridges.version), openid_issuer=EXCLUDED.openid_issuer,
         expires_at=EXCLUDED.expires_at RETURNING ${columns}`,
        [
          randomBytes(12).toString('hex'),
          data.oldRefreshTokenHash,
          data.userId,
          data.tenantId ?? null,
          data.openidIssuer ?? null,
          data.encryptedNewRefreshToken,
          data.version ?? null,
          new Date(),
          data.expiresAt,
        ],
      );
      return record(result.rows[0]);
    },
    async findRefreshTokenBridge(query) {
      const result = await db.query<BridgeRow>(
        `SELECT ${columns} FROM auth_bridges WHERE old_refresh_token_hash=$1 AND user_id=$2
         AND tenant_id IS NOT DISTINCT FROM $3 AND expires_at>clock_timestamp() LIMIT 1`,
        [query.oldRefreshTokenHash, query.userId, query.tenantId ?? null],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async deleteRefreshTokenBridges(data) {
      const result = await db.query(
        `DELETE FROM auth_bridges WHERE user_id=$1 AND tenant_id IS NOT DISTINCT FROM $2
         AND ($3::text[] IS NULL OR old_refresh_token_hash=ANY($3)) AND ($4::text IS NULL OR version=$4)`,
        [
          data.userId,
          data.tenantId ?? null,
          data.oldRefreshTokenHashes ?? null,
          data.version || null,
        ],
      );
      return { deletedCount: result.rowCount ?? 0 };
    },
  };
}
