import type { HistoryCandidate, LiveDocumentRow } from './types';
import { applyFailClosedAntiJoin } from './guard';

const NOW = new Date('2026-08-07T00:00:00.000Z');

function candidate(recordId: string, projectionVersion: number): HistoryCandidate {
  return {
    recordId,
    conversationId: 'c1',
    score: 1,
    arm: 'text',
    projectionVersion: BigInt(projectionVersion),
  };
}

function live(recordId: string, overrides: Partial<LiveDocumentRow> = {}): LiveDocumentRow {
  return {
    recordId,
    projectionVersion: BigInt(1),
    deletedAt: null,
    expiresAt: null,
    isTemporary: false,
    ...overrides,
  };
}

describe('applyFailClosedAntiJoin', () => {
  it('admits a candidate backed by a live row at the same version', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [live('m1', { projectionVersion: BigInt(5) })],
      NOW,
    );

    expect(result.admitted.map((c) => c.recordId)).toEqual(['m1']);
    expect(result.rejected).toEqual([]);
  });

  it('drops a candidate with no PostgreSQL row at all', () => {
    const result = applyFailClosedAntiJoin([candidate('ghost', 5)], [], NOW);

    expect(result.admitted).toEqual([]);
    expect(result.rejected[0].reason).toBe('no-live-row');
  });

  it('drops every candidate when the PostgreSQL lookup returns nothing', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 1), candidate('m2', 2), candidate('m3', 3)],
      [],
      NOW,
    );

    expect(result.admitted).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });

  it('drops a candidate whose PostgreSQL row is tombstoned', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [
        live('m1', {
          projectionVersion: BigInt(5),
          deletedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ],
      NOW,
    );

    expect(result.admitted).toEqual([]);
    expect(result.rejected[0].reason).toBe('deleted');
  });

  it('drops a candidate whose PostgreSQL row has expired', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [
        live('m1', {
          projectionVersion: BigInt(5),
          expiresAt: new Date('2026-08-06T23:59:59.000Z'),
        }),
      ],
      NOW,
    );

    expect(result.rejected[0].reason).toBe('expired');
  });

  it('keeps a candidate whose expiry is still in the future', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [
        live('m1', {
          projectionVersion: BigInt(5),
          expiresAt: new Date('2026-08-07T00:00:01.000Z'),
        }),
      ],
      NOW,
    );

    expect(result.admitted).toHaveLength(1);
  });

  it('drops a candidate belonging to a temporary chat', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [live('m1', { projectionVersion: BigInt(5), isTemporary: true })],
      NOW,
    );

    expect(result.rejected[0].reason).toBe('temporary');
  });

  it('drops a candidate superseded by a newer PostgreSQL projection version', () => {
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 5)],
      [live('m1', { projectionVersion: BigInt(6) })],
      NOW,
    );

    expect(result.admitted).toEqual([]);
    expect(result.rejected[0].reason).toBe('superseded');
  });

  it('admits a candidate ahead of PostgreSQL rather than treating it as stale', () => {
    // ClickHouse can legitimately carry a version PostgreSQL has since replaced
    // in place; only a strictly newer PostgreSQL version supersedes.
    const result = applyFailClosedAntiJoin(
      [candidate('m1', 7)],
      [live('m1', { projectionVersion: BigInt(6) })],
      NOW,
    );

    expect(result.admitted).toHaveLength(1);
  });

  it('partitions a mixed batch and preserves candidate order among survivors', () => {
    const candidates = [
      candidate('keep1', 1),
      candidate('ghost', 1),
      candidate('keep2', 1),
      candidate('stale', 1),
      candidate('keep3', 1),
    ];
    const rows = [
      live('keep1'),
      live('keep2'),
      live('stale', { projectionVersion: BigInt(99) }),
      live('keep3'),
    ];

    const result = applyFailClosedAntiJoin(candidates, rows, NOW);

    expect(result.admitted.map((c) => c.recordId)).toEqual(['keep1', 'keep2', 'keep3']);
    expect(result.rejected.map((r) => [r.candidate.recordId, r.reason])).toEqual([
      ['ghost', 'no-live-row'],
      ['stale', 'superseded'],
    ]);
  });

  it('handles the same record arriving from both arms', () => {
    const fromText = { ...candidate('m1', 5), arm: 'text' as const };
    const fromVector = { ...candidate('m1', 5), arm: 'vector' as const };

    const result = applyFailClosedAntiJoin(
      [fromText, fromVector],
      [live('m1', { projectionVersion: BigInt(5) })],
      NOW,
    );

    expect(result.admitted).toHaveLength(2);
  });
});
