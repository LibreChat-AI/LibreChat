import type { MediaThread, MediaSubmissionReceipt } from 'librechat-data-provider';
import { mergeMediaTiles, mayClearMediaDraft, newerMediaSnapshot } from '../reconcile';

const thread: MediaThread = {
  schemaVersion: 1,
  threadId: 'thread',
  version: 4,
  title: 'Original',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turnCount: 2,
  pendingJobCount: 1,
};
const receipt: MediaSubmissionReceipt = {
  schemaVersion: 1,
  clientRequestId: 'request',
  threadId: 'thread',
  turnId: 'turn',
  jobId: 'job',
  phase: 'preparing',
};

describe('media recovery projections', () => {
  it('pins a receipt-backed tile while the thread projection is absent', () => {
    expect(mergeMediaTiles([], [{ receipt, title: 'A mountain' }])).toEqual([
      { threadId: 'thread', title: 'A mountain', thread: undefined, receipt },
    ]);
    const projected = mergeMediaTiles([thread], [{ receipt, title: 'A mountain' }]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ thread, receipt, title: 'Original' });
  });
  it('does not turn a rejected receipt into a thread or regress overlapping page versions', () => {
    const rejected: MediaSubmissionReceipt = {
      ...receipt,
      phase: 'rejected',
      error: { code: 'invalid_request' },
    };
    expect(mergeMediaTiles([], [{ receipt: rejected, title: 'Rejected' }])).toEqual([]);
    expect(mergeMediaTiles([thread, { ...thread, version: 2, title: 'Stale' }], [])[0].thread).toBe(
      thread,
    );
    expect(newerMediaSnapshot(thread, { ...thread, version: 1 })).toBe(thread);
  });
  it('keeps drafts through preparing/rejection and preserves edits made after submission', () => {
    expect(mayClearMediaDraft(7, 7, 'preparing')).toBe(false);
    expect(mayClearMediaDraft(7, 7, 'rejected')).toBe(false);
    expect(mayClearMediaDraft(8, 7, 'accepted')).toBe(false);
    expect(mayClearMediaDraft(7, 7, 'accepted')).toBe(true);
    expect(mayClearMediaDraft(0, -1, 'accepted')).toBe(false);
  });
});
