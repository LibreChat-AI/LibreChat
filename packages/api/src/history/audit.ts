import type {
  AuditKindReport,
  AuditReport,
  ClickHouseQueryClient,
  HistoryKind,
  PgQueryClient,
  RecordKey,
} from './types';
import { readWatermark } from './source';
import { keyOf } from './consumer';

const ALL_KINDS: readonly HistoryKind[] = ['message', 'conversation', 'shared-link'];

/**
 * PostgreSQL side of the audit: per-kind counts and version ranges at or below
 * the applied watermark version. Tombstoned rows are counted separately because
 * ClickHouse retains a tombstone row for them while PostgreSQL may already have
 * hard-deleted the row after its retention window.
 */
export const auditPostgresSummarySql = `
SELECT
  d.kind                          AS kind,
  count(*)::text                  AS row_count,
  min(d.projection_version)::text AS min_version,
  max(d.projection_version)::text AS max_version
FROM chat_search.documents d
WHERE d.projection_version <= $1::bigint
  AND d.deleted_at IS NULL
GROUP BY d.kind
`;

/**
 * ClickHouse side: the same statistics over the LATEST version of each key.
 * Aggregating before filtering is required — a raw `WHERE projection_version <=
 * W` over un-collapsed parts would count superseded versions as separate rows.
 */
export const auditClickHouseSummarySql = `
SELECT
  kind                    AS kind,
  toString(count())       AS row_count,
  toString(min(version))  AS min_version,
  toString(max(version))  AS max_version
FROM (
  SELECT
    kind,
    max(projection_version) AS version,
    argMax(is_deleted, projection_version) AS is_deleted
  FROM chat_search.documents
  GROUP BY tenant_id, user_id, kind, record_id
)
WHERE version <= {applied_version:UInt64}
  AND is_deleted = 0
GROUP BY kind
`;

/** Keyset page of PostgreSQL keys for one kind, used to locate individual gaps. */
export const auditPostgresKeysSql = `
SELECT
  d.tenant_id                     AS tenant_id,
  d.user_id                       AS user_id,
  d.record_id                     AS record_id,
  d.projection_version::text      AS projection_version
FROM chat_search.documents d
WHERE d.kind = $1
  AND d.projection_version <= $2::bigint
  AND d.deleted_at IS NULL
  AND (d.tenant_id, d.user_id, d.record_id) > ($3, $4, $5)
ORDER BY d.tenant_id, d.user_id, d.record_id
LIMIT $6::int
`;

export const auditClickHouseKeysSql = `
SELECT
  tenant_id,
  user_id,
  record_id,
  toString(max(projection_version)) AS version,
  toString(argMax(is_deleted, projection_version)) AS is_deleted
FROM chat_search.documents
WHERE kind = {kind:String}
  AND (tenant_id, user_id, record_id) IN (
    arrayZip({tenant_ids:Array(String)}, {user_ids:Array(String)}, {record_ids:Array(String)})
  )
GROUP BY tenant_id, user_id, record_id
`;

export type AuditOptions = Readonly<{
  kinds?: readonly HistoryKind[];
  /** Keys per keyset page. */
  pageSize?: number;
  /**
   * Pages sampled per kind before the report is marked `sampled`. The audit is a
   * skeleton: a full sweep at 10M rows is follow-up scope alongside the
   * reconciler's own budget.
   */
  maxPages?: number;
  /** Cap on reported gap keys per kind, so a systemic outage cannot flood a log. */
  maxReportedKeys?: number;
}>;

export type AuditDeps = Readonly<{
  pg: PgQueryClient;
  clickhouse: ClickHouseQueryClient;
}>;

/**
 * CH-vs-PG audit (PLAN Watermark).
 *
 * Gate: no version <= W may be absent from ClickHouse. This job reports the
 * evidence for that gate — per-kind row counts, version ranges, and the specific
 * keys that are missing or trailing — and never mutates either store. It reads
 * IDs and versions only; no document text crosses this path.
 */
export async function runHistoryAudit(
  deps: AuditDeps,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const kinds = options.kinds ?? ALL_KINDS;
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 10;
  const maxReportedKeys = options.maxReportedKeys ?? 100;

  const watermark = await readWatermark(deps.pg);

  const [pgSummary, chSummary] = await Promise.all([
    readPostgresSummary(deps.pg, watermark.appliedVersion),
    readClickHouseSummary(deps.clickhouse, watermark.appliedVersion),
  ]);

  const reports: AuditKindReport[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const gaps = await findGaps(deps, kind, watermark.appliedVersion, {
      pageSize,
      maxPages,
      maxReportedKeys,
    });

    reports.push({
      kind,
      postgres: pgSummary.get(kind) ?? emptySummary(),
      clickhouse: chSummary.get(kind) ?? emptySummary(),
      missingKeys: gaps.missingKeys,
      staleKeys: gaps.staleKeys,
      sampled: gaps.sampled,
    });
  }

  const clean = reports.every(
    (report) => report.missingKeys.length === 0 && report.staleKeys.length === 0,
  );

  return {
    appliedSeq: watermark.appliedSeq,
    appliedVersion: watermark.appliedVersion,
    kinds: reports,
    clean,
  };
}

type Summary = AuditKindReport['postgres'];

function emptySummary(): Summary {
  return { rowCount: 0, minVersion: null, maxVersion: null };
}

async function readPostgresSummary(
  pg: PgQueryClient,
  appliedVersion: bigint,
): Promise<Map<HistoryKind, Summary>> {
  const result = await pg.query<{
    kind: string;
    row_count: string;
    min_version: string | null;
    max_version: string | null;
  }>(auditPostgresSummarySql, [appliedVersion.toString()]);

  const summaries = new Map<HistoryKind, Summary>();
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i];
    summaries.set(row.kind as HistoryKind, {
      rowCount: Number(row.row_count),
      minVersion: row.min_version === null ? null : BigInt(row.min_version),
      maxVersion: row.max_version === null ? null : BigInt(row.max_version),
    });
  }
  return summaries;
}

async function readClickHouseSummary(
  clickhouse: ClickHouseQueryClient,
  appliedVersion: bigint,
): Promise<Map<HistoryKind, Summary>> {
  const result = await clickhouse.query({
    query: auditClickHouseSummarySql,
    query_params: { applied_version: appliedVersion.toString() },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    kind: string;
    row_count: string;
    min_version: string;
    max_version: string;
  }>();

  const summaries = new Map<HistoryKind, Summary>();
  for (let i = 0; i < rows.length; i++) {
    summaries.set(rows[i].kind as HistoryKind, {
      rowCount: Number(rows[i].row_count),
      minVersion: BigInt(rows[i].min_version),
      maxVersion: BigInt(rows[i].max_version),
    });
  }
  return summaries;
}

type GapScan = Readonly<{
  missingKeys: readonly string[];
  staleKeys: readonly string[];
  sampled: boolean;
}>;

async function findGaps(
  deps: AuditDeps,
  kind: HistoryKind,
  appliedVersion: bigint,
  limits: Readonly<{ pageSize: number; maxPages: number; maxReportedKeys: number }>,
): Promise<GapScan> {
  const missingKeys: string[] = [];
  const staleKeys: string[] = [];

  let cursor: RecordKey = { tenantId: '', userId: '', kind, recordId: '' };
  let page = 0;
  let exhausted = false;

  while (page < limits.maxPages) {
    const pgPage = await deps.pg.query<{
      tenant_id: string;
      user_id: string;
      record_id: string;
      projection_version: string;
    }>(auditPostgresKeysSql, [
      kind,
      appliedVersion.toString(),
      cursor.tenantId,
      cursor.userId,
      cursor.recordId,
      limits.pageSize,
    ]);

    if (pgPage.rows.length === 0) {
      exhausted = true;
      break;
    }

    const tenantIds: string[] = new Array(pgPage.rows.length);
    const userIds: string[] = new Array(pgPage.rows.length);
    const recordIds: string[] = new Array(pgPage.rows.length);
    const pgVersions = new Map<string, bigint>();

    for (let i = 0; i < pgPage.rows.length; i++) {
      const row = pgPage.rows[i];
      tenantIds[i] = row.tenant_id;
      userIds[i] = row.user_id;
      recordIds[i] = row.record_id;
      pgVersions.set(
        keyOf({
          tenantId: row.tenant_id,
          userId: row.user_id,
          kind,
          recordId: row.record_id,
        }),
        BigInt(row.projection_version),
      );
    }

    const chResult = await deps.clickhouse.query({
      query: auditClickHouseKeysSql,
      query_params: { kind, tenant_ids: tenantIds, user_ids: userIds, record_ids: recordIds },
      format: 'JSONEachRow',
    });
    const chRows = await chResult.json<{
      tenant_id: string;
      user_id: string;
      record_id: string;
      version: string;
      is_deleted: string;
    }>();

    const chVersions = new Map<string, bigint>();
    for (let i = 0; i < chRows.length; i++) {
      const row = chRows[i];
      if (row.is_deleted === '1') {
        continue;
      }
      chVersions.set(
        keyOf({
          tenantId: row.tenant_id,
          userId: row.user_id,
          kind,
          recordId: row.record_id,
        }),
        BigInt(row.version),
      );
    }

    for (const [key, pgVersion] of pgVersions) {
      const chVersion = chVersions.get(key);
      if (chVersion === undefined) {
        pushCapped(missingKeys, key, limits.maxReportedKeys);
        continue;
      }
      if (chVersion < pgVersion) {
        pushCapped(staleKeys, key, limits.maxReportedKeys);
      }
    }

    const last = pgPage.rows[pgPage.rows.length - 1];
    cursor = {
      tenantId: last.tenant_id,
      userId: last.user_id,
      kind,
      recordId: last.record_id,
    };
    page += 1;

    if (pgPage.rows.length < limits.pageSize) {
      exhausted = true;
      break;
    }
  }

  return { missingKeys, staleKeys, sampled: !exhausted };
}

function pushCapped(target: string[], value: string, cap: number): void {
  if (target.length < cap) {
    target.push(value);
  }
}
