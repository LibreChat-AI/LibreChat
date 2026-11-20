import type { TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueuedMessage, SettledQueuedTurnReceipt } from '../types';
import {
  toQueuedTurnFileRefs,
  queuedTurnLookupIds,
  ownedPromotedSteerIds,
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

describe('queuedTurnLookupIds', () => {
  const serverRow = (index: number): QueuedMessage => ({
    id: `row-${index}`,
    text: 'x',
    createdAt: index,
    clientRequestId: `request-${index}`,
    server: { status: 'queued', id: `turn-${index}` },
  });
  const held: QueuedMessage = {
    id: 'steer-1',
    text: 'y',
    createdAt: 0,
    clientRequestId: 'legacy-request',
    recoverySteerId: 'steer-1',
    recoveryClientSteerId: 'local-1',
  };

  it('asks about server rows and about every steer the pane still holds', () => {
    expect(
      queuedTurnLookupIds([], [serverRow(1), held, { id: 'plain', text: 'z', createdAt: 2 }]),
    ).toEqual(['steer-leftover:local-1', 'request-1']);
  });

  it('keeps a held steer inside the lookup limit behind a full server queue', () => {
    const queue = [...Array.from({ length: 100 }, (_, index) => serverRow(index)), held];
    const ids = queuedTurnLookupIds([], queue);

    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe('steer-leftover:local-1');
  });
});

describe('ownedPromotedSteerIds', () => {
  const promoted = (id: string, extra: Partial<TAgentQueuedTurnReceipt> = {}) =>
    receipt(`steer-leftover:${id}`, {
      steer: { steerId: id, clientSteerId: `local-${id}` },
      ...extra,
    });

  it('maps live or admitted promoted turns back to both ids of their steers', () => {
    expect(
      ownedPromotedSteerIds([
        promoted('steer-1'),
        promoted('steer-2', { status: 'claimed' }),
        promoted('steer-3', { status: 'admitted' }),
        receipt('ordinary-request'),
        /** Only the server's own record names a steer, never the request id. */
        receipt('steer-leftover:forged'),
      ]),
    ).toEqual(['steer-1', 'local-steer-1', 'steer-2', 'local-steer-2', 'steer-3', 'local-steer-3']);
  });

  it('keeps answering for the words of a dead turn that held them', () => {
    expect(
      ownedPromotedSteerIds([
        /** Held for review after it became the words' sole owner. */
        promoted('steer-1', {
          status: 'dead',
          steer: { steerId: 'steer-1', clientSteerId: 'local-steer-1', owned: true },
          failure: { code: 'PREDECESSOR_ABORTED' },
        }),
        /** May still settle as admitted once its admission is reconciled. */
        promoted('steer-2', { status: 'dead', failure: { code: 'ADMISSION_INDETERMINATE' } }),
      ]),
    ).toEqual(['steer-1', 'local-steer-1', 'steer-2', 'local-steer-2']);
  });

  it('leaves the words to the client when the turn handed them back or never owned them', () => {
    expect(
      ownedPromotedSteerIds([
        promoted('steer-1', { status: 'cancelled' }),
        promoted('steer-2', { status: 'dead', failure: { code: 'STEER_HANDOFF_UNCONFIRMED' } }),
        promoted('steer-3', { status: 'dead' }),
      ]),
    ).toEqual([]);
  });
});

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
  it('keeps a bounded snippet without sending full extracted text to the queue', () => {
    expect(
      toQueuedTurnFileRefs([
        {
          file_id: 'paste',
          type: 'text/plain',
          textPreview: 'p'.repeat(500),
          text: 'full private text',
        },
      ]),
    ).toEqual([{ file_id: 'paste', type: 'text/plain', textPreview: 'p'.repeat(240) }]);
  });

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

  it.each(['local', 'stored'] as const)(
    'keeps a missing preview during %s reconciliation with delivery metadata present',
    (source) => {
      const files = [{ file_id: 'paste', type: 'text/plain', llmDeliveryPath: 'text' as const }];
      const local: QueuedMessage[] =
        source === 'local'
          ? [
              {
                id: 'local-a',
                text: 'a',
                createdAt: 1,
                clientRequestId: 'a',
                files: [{ ...files[0], textPreview: 'restored excerpt' }],
                server: { status: 'sending' },
              },
            ]
          : [];
      const [row] = reconcileServerQueuedTurns(
        local,
        [receipt('a', { files })],
        settled([]),
        true,
        source === 'stored' ? { paste: { textPreview: 'restored excerpt' } } : undefined,
      );
      expect(row.files?.[0].textPreview).toBe('restored excerpt');
      expect(row.files?.[0]).not.toHaveProperty('text');
    },
  );

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
