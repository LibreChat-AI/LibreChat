import { randomBytes } from 'node:crypto';
import type { ToolFavoriteMethods, ToolFavoriteParams } from '~/types/favorite';
import type { PostgresDatabase, SqlExecutor } from './pool';
import { resolveTenantScope, tenantFilter, stampTenantOnDocument } from '~/tenant/policy';
import { MAX_TOOL_FAVORITES } from '~/methods/favorite';

function userKey(value: ToolFavoriteParams['userId']): string {
  const user = String(value).toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(user)) {
    throw new Error('Invalid favorite user ID');
  }
  return user;
}

function validateAttemptId(attemptId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new Error('Invalid favorite deletion attempt ID');
  }
}

export function createPostgresFavoriteMethods(db: PostgresDatabase): ToolFavoriteMethods {
  function scope(): string | null {
    return tenantFilter(resolveTenantScope('Query'))?.tenantId ?? null;
  }
  async function lock(sql: SqlExecutor, user: string): Promise<void> {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user]);
  }
  return {
    async getToolFavorites(userId) {
      const result = await db.query<{ itemType: ToolFavoriteParams['itemType']; itemId: string }>(
        `SELECT item_type AS "itemType", item_id AS "itemId" FROM tool_favorites
         WHERE user_id = $1 AND ($2::text IS NULL OR tenant_id = $2) ORDER BY created_at, id`,
        [userKey(userId), scope()],
      );
      return result.rows;
    },
    async addToolFavorite({ userId, itemType, itemId }) {
      const user = userKey(userId);
      const tenant = scope();
      const document: { tenantId?: string } = {};
      stampTenantOnDocument(resolveTenantScope('Query'), document);
      if (
        !['builtin', 'tool', 'mcp', 'skill'].includes(itemType) ||
        typeof itemId !== 'string' ||
        itemId.length < 1 ||
        itemId.length > 256
      ) {
        throw new Error('Invalid favorite item');
      }
      return db.transaction(async (sql) => {
        await lock(sql, user);
        const erased = await sql.query(
          'SELECT 1 FROM tool_favorite_erasure WHERE user_id = $1 AND (scope = $2 OR scope = $3) LIMIT 1',
          [user, '*', tenant == null ? '*' : `tenant:${tenant}`],
        );
        if (erased.rowCount) {
          throw new Error('Favorite account erasure in progress');
        }
        const exists = await sql.query(
          'SELECT 1 FROM tool_favorites WHERE user_id=$1 AND item_type=$2 AND item_id=$3 AND ($4::text IS NULL OR tenant_id=$4)',
          [user, itemType, itemId, tenant],
        );
        if (exists.rowCount) {
          return { ok: true, added: false };
        }
        const count = await sql.query<{ count: string }>(
          'SELECT count(*) FROM tool_favorites WHERE user_id=$1 AND ($2::text IS NULL OR tenant_id=$2)',
          [user, tenant],
        );
        if (Number(count.rows[0].count) >= MAX_TOOL_FAVORITES) {
          throw Object.assign(new Error(`Maximum of ${MAX_TOOL_FAVORITES} favorites reached`), {
            code: 'MAX_FAVORITES_EXCEEDED',
            limit: MAX_TOOL_FAVORITES,
          });
        }
        await sql.query(
          `INSERT INTO tool_favorites (id,user_id,tenant_id,item_type,item_id,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,now(),now()) ON CONFLICT (user_id,item_type,item_id) DO NOTHING`,
          [randomBytes(12).toString('hex'), user, document.tenantId ?? null, itemType, itemId],
        );
        return { ok: true, added: true };
      });
    },
    async removeToolFavorite({ userId, itemType, itemId }) {
      const result = await db.query(
        'DELETE FROM tool_favorites WHERE user_id=$1 AND item_type=$2 AND item_id=$3 AND ($4::text IS NULL OR tenant_id=$4)',
        [userKey(userId), itemType, itemId, scope()],
      );
      return { ok: true, removed: (result.rowCount ?? 0) > 0 };
    },
    async cancelUserToolFavoriteDeletion(userId, deletionAttemptId) {
      validateAttemptId(deletionAttemptId);
      const user = userKey(userId);
      const tenant = scope();
      await db.transaction(async (sql) => {
        await lock(sql, user);
        await sql.query(
          'DELETE FROM tool_favorite_erasure WHERE user_id=$1 AND ($2::text IS NULL OR scope=$2) AND attempt_id=$3',
          [user, tenant == null ? null : `tenant:${tenant}`, deletionAttemptId],
        );
      });
    },
    async deleteUserToolFavorites(userId, deletionAttemptId) {
      if (deletionAttemptId !== undefined) validateAttemptId(deletionAttemptId);
      const user = userKey(userId);
      const tenant = scope();
      return db.transaction(async (sql) => {
        await lock(sql, user);
        await sql.query(
          'INSERT INTO tool_favorite_erasure (user_id,scope,attempt_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [user, tenant == null ? '*' : `tenant:${tenant}`, deletionAttemptId ?? ''],
        );
        const result = await sql.query(
          'DELETE FROM tool_favorites WHERE user_id=$1 AND ($2::text IS NULL OR tenant_id=$2)',
          [user, tenant],
        );
        return result.rowCount ?? 0;
      });
    },
  };
}
