import type { FrontierAdvance, OutboxRow, SnapshotBound } from './types';

/**
 * The applied frontier: pure ordering logic, no I/O.
 *
 * `chat_search.outbox.outbox_seq` is a `bigserial` drawn at INSERT time, so
 * SEQUENCE ORDER IS NOT COMMIT ORDER. Reading `WHERE outbox_seq > W ORDER BY
 * outbox_seq` and advancing `W` to the highest row returned is exactly the bug
 * PLAN [R3]/[R6] exist to prevent: a transaction holding seq 100 can commit
 * after one holding seq 105, and the record behind 100 is then skipped forever —
 * absent from ClickHouse and (once the `> W` PostgreSQL filter lands) filtered
 * out of the PostgreSQL arm too.
 *
 * Two rules make the frontier safe, and they are not interchangeable:
 *
 *  1. xmin visibility (`readVisibleOutboxSql` in `source.ts`) restricts the read
 *     to rows whose inserting transaction had already committed before every
 *     currently-running transaction began. It keeps the visible window stable
 *     between polls, but on its own it does NOT close the gap — a committed
 *     seq 105 can still be visible while seq 100 is in flight.
 *  2. The contiguous-prefix rule below is the load-bearing guarantee. `W`
 *     advances only across `W+1, W+2, ...` with no missing value. Rows above a
 *     gap are withheld from the ClickHouse insert as well as from the watermark,
 *     which preserves the follow-up invariant "no ClickHouse candidate exceeds W".
 */
export function computeFrontier(watermark: bigint, visible: readonly OutboxRow[]): FrontierAdvance {
  const ascending = [...visible].sort(compareBySeq);

  const prefix: OutboxRow[] = [];
  let appliedSeq = watermark;
  let gapAt: bigint | null = null;

  for (let i = 0; i < ascending.length; i++) {
    const row = ascending[i];

    if (row.outboxSeq <= appliedSeq) {
      continue;
    }

    if (row.outboxSeq !== appliedSeq + BigInt(1)) {
      gapAt = appliedSeq + BigInt(1);
      return {
        prefix,
        appliedSeq,
        gapAt,
        withheldCount: ascending.length - i,
      };
    }

    prefix.push(row);
    appliedSeq = row.outboxSeq;
  }

  return { prefix, appliedSeq, gapAt: null, withheldCount: 0 };
}

/** Highest `projectionVersion` in a prefix, or the fallback when it is empty. */
export function maxProjectionVersion(rows: readonly OutboxRow[], fallback: bigint): bigint {
  let max = fallback;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].projectionVersion > max) {
      max = rows[i].projectionVersion;
    }
  }
  return max;
}

/**
 * Whether a stalled gap is provably permanent.
 *
 * `bigserial` values are burned by aborted transactions, so some gaps never
 * fill and a naive contiguous-prefix rule would stall the watermark forever.
 * The barrier resolves it without ever risking a skip: record
 * `pg_snapshot_xmax(pg_current_snapshot())` when the gap is first observed —
 * the first transaction id not yet assigned at that instant. Once
 * `pg_snapshot_xmin(pg_current_snapshot())` reaches that bound, every
 * transaction that existed at observation time has finished, so no transaction
 * capable of committing the missing sequence value remains. Both bounds are
 * `xid8`, so this comparison is wraparound-safe.
 */
export function isGapPermanent(
  barrier: Readonly<{ gapBarrierSeq: bigint | null; gapBarrierXmax: SnapshotBound | null }>,
  gapAt: bigint,
  currentSnapshotXmin: SnapshotBound,
): boolean {
  if (barrier.gapBarrierSeq !== gapAt || barrier.gapBarrierXmax === null) {
    return false;
  }
  return currentSnapshotXmin >= barrier.gapBarrierXmax;
}

/**
 * Smallest sequence value present above a known gap. Skipping the gap means
 * jumping the watermark to `next - 1` so the contiguous walk resumes at `next`.
 */
export function nextSeqAbove(gapAt: bigint, visible: readonly OutboxRow[]): bigint | null {
  let next: bigint | null = null;
  for (let i = 0; i < visible.length; i++) {
    const seq = visible[i].outboxSeq;
    if (seq >= gapAt && (next === null || seq < next)) {
      next = seq;
    }
  }
  return next;
}

function compareBySeq(a: OutboxRow, b: OutboxRow): number {
  if (a.outboxSeq < b.outboxSeq) {
    return -1;
  }
  return a.outboxSeq > b.outboxSeq ? 1 : 0;
}
