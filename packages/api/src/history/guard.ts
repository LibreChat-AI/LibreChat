import { assertScope } from '@librechat/data-schemas';
import type { Scope } from '@librechat/data-schemas';
import type {
  AntiJoinRejection,
  AntiJoinResult,
  HistoryCandidate,
  HistoryKind,
  LiveDocumentRow,
  PgQueryClient,
  SqlParam,
} from './types';

/**
 * Fail-closed anti-join (PLAN Watermark, finding [R7]).
 *
 * ClickHouse candidates are never returned to a user on ClickHouse's word alone.
 * Before fusion, the caller loads the corresponding `chat_search.documents` rows
 * from PostgreSQL in one indexed batch (<= 200 IDs) and runs this filter.
 *
 * A candidate is DROPPED unless a live, non-deleted, non-expired, non-temporary
 * PostgreSQL row exists for its key, and dropped again when that row's
 * `projection_version` is NEWER than the candidate's — the ClickHouse row is then
 * superseded content and would rank stale text.
 *
 * The direction matters. After PostgreSQL tombstone retention expires, a ghost
 * ClickHouse row surviving in an un-merged part matches no PostgreSQL row at all;
 * absence must therefore mean rejection, never admission. That is the whole
 * reason this is an anti-join and not an enrichment step.
 */
export function applyFailClosedAntiJoin(
  candidates: readonly HistoryCandidate[],
  liveRows: readonly LiveDocumentRow[],
  now: Date = new Date(),
): AntiJoinResult {
  const live = new Map<string, LiveDocumentRow>();
  for (let i = 0; i < liveRows.length; i++) {
    live.set(liveRows[i].recordId, liveRows[i]);
  }

  const admitted: HistoryCandidate[] = [];
  const rejected: { candidate: HistoryCandidate; reason: AntiJoinRejection }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const reason = rejectionFor(candidate, live.get(candidate.recordId), now);
    if (reason === null) {
      admitted.push(candidate);
      continue;
    }
    rejected.push({ candidate, reason });
  }

  return { admitted, rejected };
}

function rejectionFor(
  candidate: HistoryCandidate,
  row: LiveDocumentRow | undefined,
  now: Date,
): AntiJoinRejection | null {
  if (row === undefined) {
    return 'no-live-row';
  }
  if (row.deletedAt !== null) {
    return 'deleted';
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (row.isTemporary) {
    return 'temporary';
  }
  if (row.projectionVersion > candidate.projectionVersion) {
    return 'superseded';
  }
  return null;
}

/**
 * Batch lookup backing the anti-join. Runs on the request-reader DSN
 * (`CHAT_SEARCH_DATABASE_URL`) under forced RLS; the tenant and user predicates
 * are still written explicitly so the query is correct independently of session
 * settings and identical to the ClickHouse-side scoping.
 */
export const antiJoinLookupSql = `
SELECT
  d.record_id                AS record_id,
  d.projection_version::text AS projection_version,
  d.deleted_at               AS deleted_at,
  d.expires_at               AS expires_at,
  coalesce(d.is_temporary, false) AS is_temporary
FROM chat_search.documents d
WHERE d.tenant_id = $1
  AND d.user_id   = $2
  AND d.kind      = $3
  AND d.record_id = ANY($4::text[])
`;

export async function loadLiveDocumentRows(
  pg: PgQueryClient,
  scope: Scope,
  kind: HistoryKind,
  recordIds: readonly string[],
): Promise<readonly LiveDocumentRow[]> {
  /**
   * The same branded scope the ClickHouse arms rendered, gated by the same
   * shared assertion — so the anti-join cannot run under a wider scope than the
   * query that produced the candidates. Forced RLS backs this DSN, but RLS is
   * the net, not the fence.
   */
  const resolved = assertScope(scope);

  if (recordIds.length === 0) {
    return [];
  }

  const params: SqlParam[] = [resolved.tenantId, resolved.userId, kind, recordIds];
  const result = await pg.query<{
    record_id: string;
    projection_version: string;
    deleted_at: Date | string | null;
    expires_at: Date | string | null;
    is_temporary: boolean;
  }>(antiJoinLookupSql, params);

  return result.rows.map((row) => ({
    recordId: row.record_id,
    projectionVersion: BigInt(row.projection_version),
    deletedAt: asDate(row.deleted_at),
    expiresAt: asDate(row.expires_at),
    isTemporary: row.is_temporary,
  }));
}

function asDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}
