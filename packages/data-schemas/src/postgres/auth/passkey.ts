import { randomBytes } from 'node:crypto';
import type { PasskeyMethods } from '~/methods/passkey';
import type { PasskeyRecord } from '~/types/passkey';
import type { PostgresDatabase } from '../pool';
import { resolveTenantScope, tenantFilter, stampTenantOnDocument } from '~/tenant/policy';
import { PasskeyConflictError } from '~/types/passkey';

const columns = `id, user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey",
  counter::text, transports, device_type AS "deviceType", backed_up AS "backedUp", name,
  last_used_at AS "lastUsedAt", created_at AS "createdAt", tenant_id AS "tenantId"`;
type PasskeyRow = Omit<PasskeyRecord, 'counter' | 'tenantId'> & {
  counter: string;
  tenantId: string | null;
};

function record(row: PasskeyRow): PasskeyRecord {
  const { counter, tenantId, ...passkey } = row;
  const value = Number(counter);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid passkey counter');
  return { ...passkey, counter: value, ...(tenantId == null ? {} : { tenantId }) };
}

function objectId(value: string): string {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new Error('Invalid passkey identifier');
  return value.toLowerCase();
}

function tenant(): string | null {
  return tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
}

function passkeyName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 60) throw new Error('Invalid passkey name');
  return name;
}

export function createPostgresPasskeyMethods(db: PostgresDatabase): PasskeyMethods {
  return {
    async createPasskey(data) {
      const scope = resolveTenantScope('Query');
      const document: { tenantId?: string } = {};
      stampTenantOnDocument(scope, document);
      if (
        !Number.isSafeInteger(data.counter) ||
        data.counter < 0 ||
        !data.credentialId ||
        !Buffer.isBuffer(data.publicKey) ||
        !['singleDevice', 'multiDevice'].includes(data.deviceType)
      ) {
        throw new Error('Invalid passkey');
      }
      try {
        const result = await db.query<PasskeyRow>(
          `INSERT INTO auth_passkeys (id,user_id,tenant_id,credential_id,public_key,counter,transports,
            device_type,backed_up,name,last_used_at,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,now(),now()) RETURNING ${columns}`,
          [
            randomBytes(12).toString('hex'),
            objectId(data.user),
            document.tenantId ?? null,
            data.credentialId,
            data.publicKey,
            data.counter,
            data.transports ?? [],
            data.deviceType,
            data.backedUp,
            passkeyName(data.name),
          ],
        );
        return record(result.rows[0]);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505' &&
          'constraint' in error &&
          error.constraint === 'auth_passkeys_credential_id_key'
        ) {
          throw new PasskeyConflictError();
        }
        throw error;
      }
    },
    async findPasskeysByUser(userId) {
      const result = await db.query<PasskeyRow>(
        `SELECT ${columns} FROM auth_passkeys WHERE user_id=$1
         AND ($2::text IS NULL OR tenant_id=$2) ORDER BY created_at DESC,id DESC`,
        [objectId(userId), tenant()],
      );
      return result.rows.map(record);
    },
    async findPasskeyByCredentialId(credentialId) {
      const result = await db.query<PasskeyRow>(
        `SELECT ${columns} FROM auth_passkeys WHERE credential_id=$1
         AND ($2::text IS NULL OR tenant_id=$2) LIMIT 1`,
        [credentialId, tenant()],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async countPasskeysByUser(userId) {
      const result = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM auth_passkeys WHERE user_id=$1 AND ($2::text IS NULL OR tenant_id=$2)',
        [objectId(userId), tenant()],
      );
      return Number(result.rows[0].count);
    },
    async recordPasskeyUse(credentialId, counter, backedUp) {
      const scope = tenant();
      if (!Number.isSafeInteger(counter) || counter < 0) return false;
      try {
        const result = await db.query(
          `UPDATE auth_passkeys SET counter=$1,last_used_at=now(),updated_at=now(),
           backed_up=COALESCE($2::boolean,backed_up) WHERE credential_id=$3
           AND ($4::text IS NULL OR tenant_id=$4)
           AND (($1::bigint>0 AND counter<$1) OR ($1::bigint=0 AND counter<=0))`,
          [counter, backedUp ?? null, credentialId, scope],
        );
        return result.rowCount === 1;
      } catch {
        // Counterless authenticators retain the existing availability policy.
        return counter === 0;
      }
    },
    async renamePasskey(passkeyId, userId, name) {
      const result = await db.query<PasskeyRow>(
        `UPDATE auth_passkeys SET name=$1,updated_at=now() WHERE id=$2 AND user_id=$3
         AND ($4::text IS NULL OR tenant_id=$4) RETURNING ${columns}`,
        [passkeyName(name), objectId(passkeyId), objectId(userId), tenant()],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async deletePasskey(passkeyId, userId) {
      const result = await db.query(
        'DELETE FROM auth_passkeys WHERE id=$1 AND user_id=$2 AND ($3::text IS NULL OR tenant_id=$3)',
        [objectId(passkeyId), objectId(userId), tenant()],
      );
      return { acknowledged: true, deletedCount: result.rowCount ?? 0 };
    },
    async deletePasskeysByUser(userId) {
      const result = await db.query(
        'DELETE FROM auth_passkeys WHERE user_id=$1 AND ($2::text IS NULL OR tenant_id=$2)',
        [objectId(userId), tenant()],
      );
      return { acknowledged: true, deletedCount: result.rowCount ?? 0 };
    },
  };
}
