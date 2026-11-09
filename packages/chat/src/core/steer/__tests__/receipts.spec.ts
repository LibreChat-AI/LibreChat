import type { TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueuedMessage, SettledQueuedTurnReceipt } from '../types';
import {
  toQueuedTurnFileRefs,
  reconcileServerQueuedTurns,
  mergeSettledQueuedTurnEvidence,
} from '../receipts';

const receipt = (
  clientRequestId: string,
  extra: Partial<TAgentQueuedTurnReceipt> = {},
): TAgentQueuedTurnReceipt => ({
  conversationId: 'convo',
  parentMessageId: 'parent',
  clientRequestId,
  text: clientRequestId,
  queuedTurnId: `server-${clientRequestId}`,
  status: 'queued',
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const settled = (
  entries: SettledQueuedTurnReceipt[],
): ReadonlyMap<string, SettledQueuedTurnReceipt> =>
  new Map(entries.map((entry) => [entry.clientRequestId, entry]));

describe('mergeSettledQueuedTurnEvidence', () => {
  it('derives evidence from a terminal receipt when nothing is known yet', () => {
    expect(
      mergeSettledQueuedTurnEvidence(undefined, receipt('a', { status: 'cancelled' }), 'snapshot'),
    ).toEqual({ clientRequestId: 'a', status: 'cancelled' });
    expect(mergeSettledQueuedTurnEvidence(undefined, receipt('a'), 'snapshot')).toBeUndefined();
  });

  it('upgrades an admission without a boundary once the boundary is reported', () => {
    const pending = mergeSettledQueuedTurnEvidence(
      undefined,
      receipt('a', { status: 'admitted' }),
      'snapshot',
    );
    expect(pending?.status).toBe('admitted_pending_boundary');
    expect(
      mergeSettledQueuedTurnEvidence(
        pending,
        receipt('a', { status: 'admitted', effectivePredecessorCreatedAt: 7 }),
        'direct',
      ),
    ).toEqual({ clientRequestId: 'a', status: 'admitted', effectivePredecessorCreatedAt: 7 });
  });

  it('never lets an enqueue snapshot resolve indeterminate evidence', () => {
    const indeterminate: SettledQueuedTurnReceipt = {
      clientRequestId: 'a',
      status: 'indeterminate',
    };
    const dead = receipt('a', { status: 'dead' });
    expect(mergeSettledQueuedTurnEvidence(indeterminate, dead, 'enqueue')).toBe(indeterminate);
    expect(mergeSettledQueuedTurnEvidence(indeterminate, dead, 'snapshot')?.status).toBe('dead');
  });
});

describe('toQueuedTurnFileRefs', () => {
  it('keeps only files with an id and only the fields the server accepts', () => {
    expect(
      toQueuedTurnFileRefs([
        { file_id: 'f1', filename: 'a.png', type: 'image/png', progress: 1 } as never,
        { filename: 'no-id' } as never,
      ]),
    ).toEqual([{ file_id: 'f1', filename: 'a.png', type: 'image/png' }]);
    expect(toQueuedTurnFileRefs([])).toBeUndefined();
    expect(toQueuedTurnFileRefs(undefined)).toBeUndefined();
  });
});

describe('reconcileServerQueuedTurns', () => {
  it('projects server rows over optimistic ones, keeping the local id', () => {
    const optimistic: QueuedMessage = {
      id: 'local-a',
      text: 'a',
      createdAt: 1,
      clientRequestId: 'a',
      server: { status: 'sending' },
    };
    const [row] = reconcileServerQueuedTurns([optimistic], [receipt('a')], settled([]));
    expect(row).toMatchObject({
      id: 'local-a',
      clientRequestId: 'a',
      server: { id: 'server-a', status: 'queued', revision: 1 },
    });
  });

  it('drops rows whose admission or cancellation is already settled', () => {
    const next = reconcileServerQueuedTurns(
      [],
      [receipt('a'), receipt('b')],
      settled([
        { clientRequestId: 'a', status: 'admitted', rootPredecessor: true },
        { clientRequestId: 'b', status: 'cancelled' },
      ]),
    );
    expect(next).toEqual([]);
  });

  it('retains local-only rows and unresolved server rows missing from an authoritative snapshot', () => {
    const local: QueuedMessage = { id: 'local', text: 'x', createdAt: 5 };
    const uncertain: QueuedMessage = {
      id: 'u',
      text: 'u',
      createdAt: 2,
      clientRequestId: 'u',
      server: { status: 'uncertain' },
    };
    const queued: QueuedMessage = {
      id: 'q',
      text: 'q',
      createdAt: 3,
      clientRequestId: 'q',
      server: { status: 'queued' },
    };
    const next = reconcileServerQueuedTurns([local, uncertain, queued], [], settled([]));
    expect(next.map((item) => item.id)).toEqual(['u', 'local']);
    const partial = reconcileServerQueuedTurns([queued], [], settled([]), false);
    expect(partial.map((item) => item.id)).toEqual(['q']);
  });

  it('orders priority rows first, then server sequence', () => {
    const next = reconcileServerQueuedTurns(
      [],
      [
        receipt('late', { revision: 2 }),
        receipt('early', { revision: 1 }),
        receipt('urgent', { revision: 3, priority: true }),
      ],
      settled([]),
    );
    expect(next.map((item) => item.clientRequestId)).toEqual(['urgent', 'early', 'late']);
  });
});
