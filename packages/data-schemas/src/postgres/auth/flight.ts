import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { FlightRecord } from '~/types/openidRefreshFlight';
import type { PostgresDatabase } from '../pool';

const columns = `id AS "_id", key, owner_id AS "ownerId", status,
  encrypted_result AS "encryptedResult", error_message AS "errorMessage", delivery_id AS "deliveryId",
  delivery_expires_at AS "deliveryExpiresAt", revocation_requested_at AS "revocationRequestedAt",
  created_at AS "createdAt", updated_at AS "updatedAt", lock_expires_at AS "lockExpiresAt", expires_at AS "expiresAt"`;
type FlightRow = Omit<
  FlightRecord,
  'encryptedResult' | 'errorMessage' | 'deliveryId' | 'deliveryExpiresAt' | 'revocationRequestedAt'
> & {
  encryptedResult: string | null;
  errorMessage: string | null;
  deliveryId: string | null;
  deliveryExpiresAt: Date | null;
  revocationRequestedAt: Date | null;
};
function record(row: FlightRow): FlightRecord {
  return {
    ...row,
    encryptedResult: row.encryptedResult ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    deliveryId: row.deliveryId ?? undefined,
    deliveryExpiresAt: row.deliveryExpiresAt ?? undefined,
    revocationRequestedAt: row.revocationRequestedAt ?? undefined,
  };
}

export function createPostgresOpenIDRefreshFlightMethods(
  db: PostgresDatabase,
): OpenIDRefreshFlightMethods {
  return {
    async acquireOpenIDRefreshFlight(data) {
      const result = await db.query<FlightRow>(
        `INSERT INTO auth_refresh_flights (id,key,owner_id,status,created_at,updated_at,lock_expires_at,expires_at)
         VALUES ($1,$2,$3,'pending',clock_timestamp(),clock_timestamp(),$4,$5)
         ON CONFLICT (key) DO UPDATE SET owner_id=EXCLUDED.owner_id,status='pending',
         created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,
         lock_expires_at=EXCLUDED.lock_expires_at,expires_at=EXCLUDED.expires_at,
         encrypted_result=NULL,error_message=NULL,delivery_id=NULL,delivery_expires_at=NULL,revocation_requested_at=NULL
         WHERE auth_refresh_flights.status='failed' OR auth_refresh_flights.expires_at<=clock_timestamp()
         OR (auth_refresh_flights.status='pending' AND auth_refresh_flights.lock_expires_at<=clock_timestamp())
         RETURNING ${columns}`,
        [
          randomBytes(12).toString('hex'),
          data.key,
          data.ownerId,
          data.lockExpiresAt,
          data.expiresAt,
        ],
      );
      if (result.rows[0]) return { acquired: true, flight: record(result.rows[0]) };
      const existing = await db.query<FlightRow>(
        `SELECT ${columns} FROM auth_refresh_flights WHERE key=$1 AND expires_at>clock_timestamp()`,
        [data.key],
      );
      return { acquired: false, flight: existing.rows[0] ? record(existing.rows[0]) : null };
    },
    async completeOpenIDRefreshFlight(data) {
      const result = await db.query<FlightRow>(
        `UPDATE auth_refresh_flights SET status='completed',encrypted_result=$3,expires_at=$4,updated_at=clock_timestamp(),
         error_message=NULL,delivery_id=NULL,delivery_expires_at=NULL,revocation_requested_at=NULL
         WHERE key=$1 AND owner_id=$2 AND status='pending' RETURNING ${columns}`,
        [data.key, data.ownerId, data.encryptedResult, data.expiresAt],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async renewOpenIDRefreshFlight(data) {
      const result = await db.query<FlightRow>(
        `UPDATE auth_refresh_flights SET lock_expires_at=$3,expires_at=$4,updated_at=clock_timestamp()
         WHERE key=$1 AND owner_id=$2 AND status='pending' RETURNING ${columns}`,
        [data.key, data.ownerId, data.lockExpiresAt, data.expiresAt],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async failOpenIDRefreshFlight(data) {
      const result = await db.query<FlightRow>(
        `UPDATE auth_refresh_flights SET status='failed',error_message=$3,expires_at=$4,updated_at=clock_timestamp(),
         encrypted_result=NULL,delivery_id=NULL,delivery_expires_at=NULL,revocation_requested_at=NULL
         WHERE key=$1 AND owner_id=$2 AND status='pending' RETURNING ${columns}`,
        [data.key, data.ownerId, data.errorMessage, data.expiresAt],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async findOpenIDRefreshFlight(query) {
      const result = await db.query<FlightRow>(
        `SELECT ${columns} FROM auth_refresh_flights WHERE key=$1 AND expires_at>clock_timestamp()`,
        [query.key],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async claimOpenIDRefreshFlightDelivery(data) {
      const available = `auth_refresh_flights.owner_id=$2 AND auth_refresh_flights.status='completed'
        AND auth_refresh_flights.revocation_requested_at IS NULL AND (auth_refresh_flights.delivery_id IS NULL
        OR auth_refresh_flights.delivery_expires_at IS NULL OR auth_refresh_flights.delivery_expires_at<=clock_timestamp())`;
      const result = data.createdAt
        ? await db.query<FlightRow>(
            `INSERT INTO auth_refresh_flights (id,key,owner_id,status,delivery_id,delivery_expires_at,
           created_at,updated_at,lock_expires_at,expires_at)
           VALUES ($5,$1,$2,'completed',$3,$4,$6,clock_timestamp(),$4,$4)
           ON CONFLICT (key) DO UPDATE SET delivery_id=EXCLUDED.delivery_id,
           delivery_expires_at=EXCLUDED.delivery_expires_at,updated_at=clock_timestamp(),
           expires_at=GREATEST(auth_refresh_flights.expires_at,EXCLUDED.delivery_expires_at)
           WHERE ${available} RETURNING ${columns}`,
            [
              data.key,
              data.ownerId,
              data.deliveryId,
              data.deliveryExpiresAt,
              randomBytes(12).toString('hex'),
              data.createdAt,
            ],
          )
        : await db.query<FlightRow>(
            `UPDATE auth_refresh_flights SET delivery_id=$3,delivery_expires_at=$4,updated_at=clock_timestamp(),
           expires_at=GREATEST(expires_at,$4) WHERE key=$1 AND ${available} RETURNING ${columns}`,
            [data.key, data.ownerId, data.deliveryId, data.deliveryExpiresAt],
          );
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async releaseOpenIDRefreshFlightDelivery(data) {
      return db.transaction(async (sql) => {
        const found = await sql.query<FlightRow>(
          `SELECT ${columns} FROM auth_refresh_flights WHERE key=$1 AND owner_id=$2
           AND delivery_id=$3 AND status='completed' FOR UPDATE`,
          [data.key, data.ownerId, data.deliveryId],
        );
        const row = found.rows[0];
        if (!row) return null;
        if (row.revocationRequestedAt !== null) {
          const result = await sql.query<FlightRow>(
            `UPDATE auth_refresh_flights SET owner_id='revoked',status='revoked',
             error_message='OpenID refresh was revoked by logout',updated_at=clock_timestamp(),
             delivery_id=NULL,delivery_expires_at=NULL,revocation_requested_at=NULL WHERE id=$1 RETURNING ${columns}`,
            [row._id],
          );
          return record(result.rows[0]);
        }
        if (row.encryptedResult === null) {
          await sql.query('DELETE FROM auth_refresh_flights WHERE id=$1', [row._id]);
          return null;
        }
        const result = await sql.query<FlightRow>(
          `UPDATE auth_refresh_flights SET updated_at=clock_timestamp(),delivery_id=NULL,delivery_expires_at=NULL
           WHERE id=$1 RETURNING ${columns}`,
          [row._id],
        );
        return record(result.rows[0]);
      });
    },
    async revokeOpenIDRefreshFlight(data) {
      const delivering = `(auth_refresh_flights.status='completed' AND auth_refresh_flights.delivery_id IS NOT NULL
        AND auth_refresh_flights.delivery_expires_at>clock_timestamp())`;
      for (;;) {
        const result = await db.query<FlightRow>(
          `INSERT INTO auth_refresh_flights (id,key,owner_id,status,error_message,created_at,updated_at,lock_expires_at,expires_at)
           VALUES ($1,$2,'revoked','revoked','OpenID refresh was revoked by logout',clock_timestamp(),clock_timestamp(),$3,$3)
           ON CONFLICT (key) DO UPDATE SET
           owner_id=CASE WHEN ${delivering} THEN auth_refresh_flights.owner_id ELSE 'revoked' END,
           status=CASE WHEN ${delivering} THEN auth_refresh_flights.status ELSE 'revoked' END,
           error_message=CASE WHEN ${delivering} THEN auth_refresh_flights.error_message ELSE 'OpenID refresh was revoked by logout' END,
           lock_expires_at=CASE WHEN ${delivering} THEN auth_refresh_flights.lock_expires_at ELSE EXCLUDED.lock_expires_at END,
           delivery_id=CASE WHEN ${delivering} THEN auth_refresh_flights.delivery_id ELSE NULL END,
           delivery_expires_at=CASE WHEN ${delivering} THEN auth_refresh_flights.delivery_expires_at ELSE NULL END,
           revocation_requested_at=CASE WHEN ${delivering} THEN clock_timestamp() ELSE NULL END,
           expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp() RETURNING ${columns}`,
          [randomBytes(12).toString('hex'), data.key, data.expiresAt],
        );
        const row = result.rows[0];
        if (row.status === 'revoked') return record(row);
        // The statement has committed. Never retain a connection or transaction while waiting.
        await delay(100);
      }
    },
  };
}
