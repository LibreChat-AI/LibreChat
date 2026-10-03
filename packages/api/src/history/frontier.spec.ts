import type { OutboxRow } from './types';
import { computeFrontier, isGapPermanent, maxProjectionVersion, nextSeqAbove } from './frontier';

function row(outboxSeq: number, projectionVersion = outboxSeq): OutboxRow {
  return {
    outboxSeq: BigInt(outboxSeq),
    projectionVersion: BigInt(projectionVersion),
    tenantId: '__BASE__',
    userId: 'u1',
    kind: 'message',
    recordId: `m${outboxSeq}`,
    op: 'upsert',
  };
}

function seqs(rows: readonly OutboxRow[]): number[] {
  return rows.map((r) => Number(r.outboxSeq));
}

describe('computeFrontier', () => {
  it('advances across a fully contiguous window', () => {
    const result = computeFrontier(BigInt(99), [row(100), row(101), row(102)]);

    expect(seqs(result.prefix)).toEqual([100, 101, 102]);
    expect(result.appliedSeq).toBe(BigInt(102));
    expect(result.gapAt).toBeNull();
    expect(result.withheldCount).toBe(0);
  });

  it('never advances past a gap: seq 105 visible before 100', () => {
    const result = computeFrontier(BigInt(99), [row(105)]);

    expect(result.prefix).toEqual([]);
    expect(result.appliedSeq).toBe(BigInt(99));
    expect(result.gapAt).toBe(BigInt(100));
    expect(result.withheldCount).toBe(1);
  });

  it('withholds everything above the gap, not just the missing value', () => {
    const result = computeFrontier(BigInt(99), [row(100), row(101), row(105), row(106), row(107)]);

    expect(seqs(result.prefix)).toEqual([100, 101]);
    expect(result.appliedSeq).toBe(BigInt(101));
    expect(result.gapAt).toBe(BigInt(102));
    expect(result.withheldCount).toBe(3);
  });

  it('is insensitive to the order rows arrive in', () => {
    const shuffled = computeFrontier(BigInt(99), [row(102), row(100), row(101)]);
    const ordered = computeFrontier(BigInt(99), [row(100), row(101), row(102)]);

    expect(seqs(shuffled.prefix)).toEqual(seqs(ordered.prefix));
    expect(shuffled.appliedSeq).toBe(ordered.appliedSeq);
  });

  it('ignores replayed rows at or below the watermark', () => {
    const result = computeFrontier(BigInt(101), [row(100), row(101), row(102), row(103)]);

    expect(seqs(result.prefix)).toEqual([102, 103]);
    expect(result.appliedSeq).toBe(BigInt(103));
  });

  it('holds the watermark when the window is empty', () => {
    const result = computeFrontier(BigInt(42), []);

    expect(result.prefix).toEqual([]);
    expect(result.appliedSeq).toBe(BigInt(42));
    expect(result.gapAt).toBeNull();
  });

  it('reproduces the out-of-order commit sequence across successive polls', () => {
    // Poll 1: transaction holding 100 is still in flight; 101-102 committed.
    const poll1 = computeFrontier(BigInt(99), [row(101), row(102)]);
    expect(poll1.prefix).toEqual([]);
    expect(poll1.appliedSeq).toBe(BigInt(99));
    expect(poll1.gapAt).toBe(BigInt(100));

    // Poll 2: 100 commits late and the whole prefix becomes available.
    const poll2 = computeFrontier(poll1.appliedSeq, [row(100), row(101), row(102)]);
    expect(seqs(poll2.prefix)).toEqual([100, 101, 102]);
    expect(poll2.appliedSeq).toBe(BigInt(102));
    expect(poll2.gapAt).toBeNull();
  });

  it('handles sequence values beyond 2^53', () => {
    const big = BigInt('9007199254740993');
    const result = computeFrontier(big, [
      { ...row(1), outboxSeq: big + BigInt(1) },
      { ...row(2), outboxSeq: big + BigInt(2) },
    ]);

    expect(result.appliedSeq).toBe(big + BigInt(2));
    expect(result.gapAt).toBeNull();
  });
});

describe('maxProjectionVersion', () => {
  it('takes the highest version in the prefix, never a lower fallback', () => {
    expect(maxProjectionVersion([row(1, 7), row(2, 3)], BigInt(0))).toBe(BigInt(7));
  });

  it('keeps the fallback when the prefix is empty or trails it', () => {
    expect(maxProjectionVersion([], BigInt(9))).toBe(BigInt(9));
    expect(maxProjectionVersion([row(1, 2)], BigInt(9))).toBe(BigInt(9));
  });
});

describe('isGapPermanent', () => {
  const barrier = { gapBarrierSeq: BigInt(100), gapBarrierXmax: BigInt(5000) };

  it('is false while any transaction from the observation instant may still commit', () => {
    expect(isGapPermanent(barrier, BigInt(100), BigInt(4999))).toBe(false);
  });

  it('is true once snapshot xmin reaches the recorded xmax bound', () => {
    expect(isGapPermanent(barrier, BigInt(100), BigInt(5000))).toBe(true);
    expect(isGapPermanent(barrier, BigInt(100), BigInt(5001))).toBe(true);
  });

  it('is false when the barrier was recorded for a different gap', () => {
    expect(isGapPermanent(barrier, BigInt(101), BigInt(9999))).toBe(false);
  });

  it('is false when no barrier has been recorded yet', () => {
    expect(
      isGapPermanent(
        { gapBarrierSeq: BigInt(100), gapBarrierXmax: null },
        BigInt(100),
        BigInt(9999),
      ),
    ).toBe(false);
  });
});

describe('nextSeqAbove', () => {
  it('finds the lowest visible sequence at or above the gap', () => {
    expect(nextSeqAbove(BigInt(102), [row(101), row(105), row(107)])).toBe(BigInt(105));
  });

  it('returns null when nothing above the gap is visible', () => {
    expect(nextSeqAbove(BigInt(102), [row(100), row(101)])).toBeNull();
  });
});
