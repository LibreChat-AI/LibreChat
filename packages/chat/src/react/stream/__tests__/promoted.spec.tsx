/**
 * @jest-environment jsdom
 */
import React from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import type { TPromotedSteer, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { PendingSteer, QueuedMessage } from '../../../core';
import type { SteerHost } from '../../steer/host';
import { pendingSteersByConvoId, appliedSteerIdsByConvoId } from '../../steer/atoms';
import { queuedMessagesByConvoId } from '../../steer/queue';
import useQueuedTurnReceipts from '../../steering/receipts';
import { SteerHostProvider } from '../../steer/host';
import { insertQueuedOrigin } from '../../../core';
import { useSteerState } from '../steer';

const conversationId = 'promoted-steer-conversation';
const endedEpoch = 1_000;
const winnerEpoch = 2_000;

const receipt: TAgentQueuedTurnReceipt = {
  queuedTurnId: 'queued-turn-1',
  conversationId,
  parentMessageId: 'response-ended',
  clientRequestId: 'steer-leftover:client-1',
  text: 'also cover the error path',
  priority: false,
  expectedPredecessorCreatedAt: endedEpoch,
  status: 'queued',
  steer: { steerId: 'steer-1', clientSteerId: 'client-1' },
  revision: 1,
  createdAt: new Date(10).toISOString(),
  updatedAt: new Date(10).toISOString(),
};
const promoted: TPromotedSteer = { steerId: 'steer-1', clientSteerId: 'client-1', receipt };

const chip: PendingSteer = {
  steerId: 'steer-1',
  clientSteerId: 'client-1',
  text: 'also cover the error path',
  status: 'pending',
  createdAt: 5,
  generationCreatedAt: endedEpoch,
  generationProtocolVersion: 2,
};

/** A copy an earlier status read already converted through the legacy path. */
const legacyCopy: QueuedMessage = {
  id: 'steer-1',
  text: 'also cover the error path',
  createdAt: 5,
  clientRequestId: 'legacy-request',
  recoverySteerId: 'steer-1',
  recoveryClientSteerId: 'client-1',
};

const queuedBefore: QueuedMessage = { id: 'queued-local', text: 'then summarize', createdAt: 3 };

let serverReceipts: TAgentQueuedTurnReceipt[] | undefined;
let requestedIds: string[][] = [];
const host = {
  useFileMap: () => undefined,
  useFetchStreamStatus: () => async () => ({ active: false }),
  useSettings: () => ({}),
  useQueuedTurns: (_conversationId: string, _enabled: boolean, clientRequestIds: string[]) => {
    requestedIds.push(clientRequestIds);
    return serverReceipts;
  },
} as unknown as SteerHost;

function setup() {
  const store = createStore();
  store.set(pendingSteersByConvoId(conversationId), [chip]);
  store.set(queuedMessagesByConvoId(conversationId), [queuedBefore, legacyCopy]);
  const wrapper = ({ children }: { children?: ReactNode }) => (
    <Provider store={store}>
      <SteerHostProvider host={host}>{children}</SteerHostProvider>
    </Provider>
  );
  const { result } = renderHook(() => useSteerState(), { wrapper });
  return { store, result };
}

describe('adoptPromotedSteers', () => {
  it('replaces the chip and any local copy with the durable server row', () => {
    const { store, result } = setup();

    let adoptedIds: string[] = [];
    act(() => {
      adoptedIds = result.current.adoptPromotedSteers(conversationId, [promoted]);
    });

    expect(adoptedIds).toEqual(['steer-1', 'client-1']);
    expect(store.get(pendingSteersByConvoId(conversationId))).toEqual([]);
    expect(store.get(appliedSteerIdsByConvoId(conversationId))).toEqual(
      expect.arrayContaining(['steer-1', 'client-1']),
    );
    const queue = store.get(queuedMessagesByConvoId(conversationId));
    expect(queue).toEqual([
      expect.objectContaining({
        clientRequestId: receipt.clientRequestId,
        parentMessageId: 'response-ended',
        expectedPredecessorCreatedAt: endedEpoch,
        server: expect.objectContaining({ id: 'queued-turn-1', status: 'queued' }),
      }),
      queuedBefore,
    ]);
  });

  it('keeps a legacy conversion of the same steer from queuing it again', () => {
    const { store, result } = setup();
    act(() => {
      result.current.adoptPromotedSteers(conversationId, [promoted]);
    });
    const adopted = store.get(queuedMessagesByConvoId(conversationId));

    act(() => {
      result.current.convertSteersToQueued(
        conversationId,
        [{ steerId: 'steer-1', clientSteerId: 'client-1', text: chip.text, createdAt: 5 }],
        { generationProtocolVersion: 2 },
      );
      result.current.convertLocalSteersToQueued(conversationId, {
        generationProtocolVersion: 2,
      });
    });

    expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual(adopted);
    expect(
      store.get(queuedMessagesByConvoId(conversationId)).filter((item) => item.text === chip.text),
    ).toHaveLength(1);
  });

  it('is a no-op without promoted steers, leaving the legacy conversion intact', () => {
    const { store, result } = setup();

    let adoptedIds: string[] = ['unchanged'];
    act(() => {
      adoptedIds = result.current.adoptPromotedSteers(conversationId, []);
    });

    expect(adoptedIds).toEqual([]);
    expect(store.get(pendingSteersByConvoId(conversationId))).toEqual([chip]);
    expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([queuedBefore, legacyCopy]);
  });

  it('still restores a local row that lost the predecessor race behind the winning epoch', () => {
    const { store, result } = setup();
    act(() => {
      result.current.adoptPromotedSteers(conversationId, [promoted]);
    });
    const queue = store.get(queuedMessagesByConvoId(conversationId));
    const local = queue.find((item) => item.id === queuedBefore.id)!;
    store.set(
      queuedMessagesByConvoId(conversationId),
      queue.filter((item) => item !== local),
    );

    store.set(queuedMessagesByConvoId(conversationId), (prev) =>
      insertQueuedOrigin(
        prev,
        {
          item: { ...local, expectedPredecessorCreatedAt: endedEpoch },
          beforeIds: [],
          afterIds: [],
        },
        winnerEpoch,
      ),
    );

    const restored = store.get(queuedMessagesByConvoId(conversationId));
    expect(restored).toHaveLength(2);
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: expect.objectContaining({ id: 'queued-turn-1' }) }),
        { ...queuedBefore, expectedPredecessorCreatedAt: winnerEpoch },
      ]),
    );
  });

  it('retires local copies from the durable receipt list when this pane missed FINAL', () => {
    const store = createStore();
    /** A chip whose 202 never arrived knows the steer only by its client id. */
    const unacknowledged: PendingSteer = { ...chip, steerId: 'client-1', status: 'failed' };
    store.set(pendingSteersByConvoId(conversationId), [chip, unacknowledged]);
    store.set(queuedMessagesByConvoId(conversationId), [queuedBefore, legacyCopy]);
    requestedIds = [];
    serverReceipts = [receipt];
    const wrapper = ({ children }: { children?: ReactNode }) => (
      <Provider store={store}>
        <SteerHostProvider host={host}>{children}</SteerHostProvider>
      </Provider>
    );

    renderHook(
      () =>
        useQueuedTurnReceipts({
          conversationId,
          queueKey: conversationId,
          serverQueueEnabled: true,
        }),
      { wrapper },
    );
    serverReceipts = undefined;

    /** The pane asked by the steer it held, which is how a turn that already
     *  ran (and so is no longer listed as active) is still found. */
    expect(requestedIds[0]).toEqual(['steer-leftover:client-1']);

    expect(store.get(pendingSteersByConvoId(conversationId))).toEqual([]);
    expect(store.get(appliedSteerIdsByConvoId(conversationId))).toEqual(
      expect.arrayContaining(['steer-1', 'client-1']),
    );
    const queue = store.get(queuedMessagesByConvoId(conversationId));
    expect(queue.filter((item) => item.text === chip.text)).toEqual([
      expect.objectContaining({ server: expect.objectContaining({ id: 'queued-turn-1' }) }),
    ]);
    expect(queue).toContainEqual(queuedBefore);
  });

  it('retires local copies of a promoted steer whose turn already ran', () => {
    const store = createStore();
    store.set(pendingSteersByConvoId(conversationId), [chip]);
    store.set(queuedMessagesByConvoId(conversationId), [queuedBefore, legacyCopy]);
    serverReceipts = [
      { ...receipt, status: 'admitted', effectivePredecessorCreatedAt: endedEpoch },
    ];
    const wrapper = ({ children }: { children?: ReactNode }) => (
      <Provider store={store}>
        <SteerHostProvider host={host}>{children}</SteerHostProvider>
      </Provider>
    );

    renderHook(
      () =>
        useQueuedTurnReceipts({
          conversationId,
          queueKey: conversationId,
          serverQueueEnabled: true,
        }),
      { wrapper },
    );
    serverReceipts = undefined;

    expect(store.get(pendingSteersByConvoId(conversationId))).toEqual([]);
    expect(store.get(queuedMessagesByConvoId(conversationId))).toEqual([queuedBefore]);
  });
});
