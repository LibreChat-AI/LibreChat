import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState, type MutableSnapshot } from 'recoil';
import useSteerConvert from '../useSteerConvert';
import store from '~/store';

const mockFetchStreamStatus = jest.fn();
let mockFileMap: Record<string, { llmDeliveryPath: 'text' }> = {};
jest.mock('~/Providers', () => ({ useFileMapContext: () => mockFileMap }));
jest.mock('~/data-provider', () => ({
  fetchStreamStatus: (...args: unknown[]) => mockFetchStreamStatus(...args),
  getGenerationProtocolVersion: (value: unknown) =>
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion === 2
      ? 2
      : 1,
}));

const CONVO_ID = 'convo-steer-convert';

function setup(initialize?: (snapshot: MutableSnapshot) => void) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={(snapshot) => {
        snapshot.set(store.activeGenerationProtocolVersionByConvoId(CONVO_ID), 2);
        initialize?.(snapshot);
      }}
    >
      {children}
    </RecoilRoot>
  );
  return renderHook(
    () => {
      const setQueue = useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID));
      return {
        convert: useSteerConvert(),
        chips: useRecoilValue(store.pendingSteersByConvoId(CONVO_ID)),
        queue: useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID)),
        applied: useRecoilValue(store.appliedSteerIdsByConvoId(CONVO_ID)),
        // Mirrors `useQueueDrain` dequeuing the head item after auto-send.
        drainQueue: () => setQueue((prev) => prev.slice(1)),
      };
    },
    { wrapper },
  );
}

describe('useSteerConvert', () => {
  beforeEach(() => {
    mockFileMap = {};
  });

  it.each([false, true])(
    'hydrates late metadata during terminal recovery (queued origin: %s)',
    (fromQueue) => {
      const files = [{ file_id: 'f1', filename: 'notes.pdf' }];
      const { result, rerender } = setup(({ set }) => {
        set(store.pendingSteersByConvoId(CONVO_ID), [
          {
            steerId: 'legacy',
            text: 'recover',
            status: 'pending',
            createdAt: 1,
            files,
            ...(fromQueue && {
              queuedOrigin: {
                item: { id: 'original', text: 'recover', createdAt: 1, files },
                beforeIds: [],
                afterIds: [],
              },
            }),
          },
        ]);
      });
      const retainedCallback = result.current.convert;
      mockFileMap = { f1: { llmDeliveryPath: 'text' } };
      rerender();
      act(() => {
        retainedCallback(CONVO_ID, [{ steerId: 'legacy', text: 'recover', files }]);
      });
      expect(result.current.queue[0].files).toEqual([{ ...files[0], llmDeliveryPath: 'text' }]);
      expect(result.current.chips).toEqual([]);
      act(() => {
        retainedCallback(CONVO_ID, [{ steerId: 'legacy', text: 'recover', files }]);
      });
      expect(result.current.queue).toHaveLength(1);
    },
  );

  it('converts leftover steers to queued chips and drops their pending chips', () => {
    const { result } = setup(({ set }) => {
      set(store.pendingSteersByConvoId(CONVO_ID), [
        { steerId: 'srv-1', text: 'leftover', status: 'pending' as const, createdAt: 1 },
        { steerId: 'local-x', text: 'still sending', status: 'sending' as const, createdAt: 2 },
      ]);
    });
    act(() => {
      result.current.convert(CONVO_ID, [{ steerId: 'srv-1', text: 'leftover', createdAt: 1 }]);
    });
    expect(result.current.queue).toEqual([expect.objectContaining({ id: 'srv-1' })]);
    expect(result.current.chips).toEqual([expect.objectContaining({ steerId: 'local-x' })]);
  });

  it('restores quotes + manual skills from the local chip (server steers never carry them)', () => {
    const { result } = setup(({ set }) => {
      set(store.pendingSteersByConvoId(CONVO_ID), [
        {
          steerId: 'srv-ctx',
          text: 'carried',
          status: 'pending' as const,
          createdAt: 1,
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        },
      ]);
    });
    act(() => {
      result.current.convert(CONVO_ID, [{ steerId: 'srv-ctx', text: 'carried', createdAt: 1 }]);
    });
    expect(result.current.chips).toEqual([]);
    expect(result.current.queue).toEqual([
      expect.objectContaining({
        id: 'srv-ctx',
        quotes: ['carried quote'],
        manualSkills: ['carried-skill'],
      }),
    ]);
  });

  it('restores an accepted queued-origin steer with its queue identity, position, and receipt', () => {
    const original = {
      id: 'queue-original',
      text: 'sent from queue',
      createdAt: 10,
      priority: true,
      quotes: ['original quote'],
    };
    const after = { id: 'queue-after', text: 'still queued', createdAt: 20 };
    const { result } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [after]);
      set(store.pendingSteersByConvoId(CONVO_ID), [
        {
          steerId: 'server-replacement-id',
          text: original.text,
          status: 'pending' as const,
          createdAt: 999,
          queuedOrigin: { item: original, beforeIds: [], afterIds: [after.id] },
        },
      ]);
    });

    act(() => {
      result.current.convert(CONVO_ID, [
        { steerId: 'server-replacement-id', text: original.text, createdAt: 999 },
      ]);
    });

    expect(result.current.queue).toEqual([
      expect.objectContaining({
        ...original,
        clientRequestId: expect.any(String),
        recoverySteerId: 'server-replacement-id',
      }),
      after,
    ]);
    expect(result.current.queue[0]).toMatchObject({
      id: 'queue-original',
      createdAt: 10,
      priority: true,
      quotes: ['original quote'],
    });
    expect(result.current.applied).toContain('server-replacement-id');
  });

  it('recovers a v1 leftover as an ordinary local follow-up without receipt binding', () => {
    const { result } = setup();
    act(() => {
      result.current.convert(
        CONVO_ID,
        [{ steerId: 'legacy-leftover', text: 'recover locally', createdAt: 1 }],
        { generationProtocolVersion: 1 },
      );
    });

    expect(result.current.queue).toEqual([
      {
        id: 'legacy-leftover',
        text: 'recover locally',
        createdAt: 1,
      },
    ]);
  });

  it('keeps a local v2 failure ordinary when no server receipt exists', () => {
    const { result } = setup();
    act(() => {
      result.current.convert(
        CONVO_ID,
        [{ steerId: 'local-failure', text: 'queue locally', createdAt: 1 }],
        { generationProtocolVersion: 2, bindRecoverySource: false },
      );
    });

    expect(result.current.queue).toEqual([
      { id: 'local-failure', text: 'queue locally', createdAt: 1 },
    ]);
  });

  it('correlates a terminal leftover that arrives before the 202 ACK', () => {
    const original = {
      id: 'queue-before-ack',
      text: 'terminal raced the ACK',
      createdAt: 10,
      priority: true,
    };
    const after = { id: 'queue-after-race', text: 'after', createdAt: 20 };
    const { result } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [after]);
      set(store.pendingSteersByConvoId(CONVO_ID), [
        {
          steerId: 'local-correlation-id',
          text: original.text,
          status: 'sending' as const,
          createdAt: 999,
          queuedOrigin: { item: original, beforeIds: [], afterIds: [after.id] },
        },
      ]);
    });

    act(() => {
      result.current.convert(CONVO_ID, [
        {
          steerId: 'server-id-before-ack',
          clientSteerId: 'local-correlation-id',
          text: original.text,
          createdAt: 999,
        },
      ]);
    });

    expect(result.current.queue).toEqual([
      expect.objectContaining({
        ...original,
        clientRequestId: expect.any(String),
        recoverySteerId: 'server-id-before-ack',
        recoveryClientSteerId: 'local-correlation-id',
      }),
      after,
    ]);
    expect(result.current.chips).toEqual([]);
    expect(result.current.applied).toContain('server-id-before-ack');
  });

  it('falls back to context carried on the steer when its chip is already gone', () => {
    // A reclaimed steer stays interactive during its cancel round-trip, so a
    // competing X can delete the chip before the conversion runs. The steer
    // carries its own picks so they survive that race.
    const { result } = setup();
    act(() => {
      result.current.convert(CONVO_ID, [
        {
          steerId: 'reclaimed',
          text: 'carried',
          createdAt: 1,
          quotes: ['carried quote'],
          manualSkills: ['carried-skill'],
        },
      ]);
    });
    expect(result.current.queue).toEqual([
      expect.objectContaining({
        id: 'reclaimed',
        quotes: ['carried quote'],
        manualSkills: ['carried-skill'],
      }),
    ]);
  });

  it('adds no context fields when no local chip matches (fresh reload)', () => {
    const { result } = setup();
    act(() => {
      result.current.convert(CONVO_ID, [{ steerId: 'srv-plain', text: 'plain', createdAt: 1 }]);
    });
    expect(result.current.queue[0].quotes).toBeUndefined();
    expect(result.current.queue[0].manualSkills).toBeUndefined();
  });

  it('retains previously applied ids so a late 202 ACK still drops its chip', () => {
    const { result } = setup(({ set }) => {
      set(store.appliedSteerIdsByConvoId(CONVO_ID), ['srv-applied']);
    });
    act(() => {
      result.current.convert(CONVO_ID, [{ steerId: 'srv-queued', text: 'to queue' }]);
    });
    // Both the applied and converted steers are settled — an ACK arriving
    // after run end must not re-mint a pending chip for either.
    expect(result.current.applied).toEqual(['srv-applied', 'srv-queued']);
  });

  it('keeps interrupt front-inserts ahead of chronologically older steers', () => {
    const { result } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { id: 'urgent', text: 'interrupt message', createdAt: 100, priority: true },
      ]);
    });
    act(() => {
      // Older steer (createdAt 50) converts after the interrupt was queued.
      result.current.convert(CONVO_ID, [{ steerId: 'old', text: 'older steer', createdAt: 50 }]);
    });
    expect(result.current.queue.map((item) => item.id)).toEqual(['urgent', 'old']);
  });

  /* The rail can be reordered by hand, and that order decides what sends next.
     A conversion arriving afterwards may only place its own items; sorting the
     whole list would quietly restore the order the messages were written in. */
  it('leaves a hand-reordered queue in the order the user left it', () => {
    const { result } = setup(({ set }) => {
      set(store.pendingSteersByConvoId(CONVO_ID), [
        { steerId: 'srv-late', text: 'converted', status: 'pending' as const, createdAt: 9 },
      ]);
      // As if the user had dragged the newest message to the front.
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { id: 'm3', text: 'third, promoted', createdAt: 3 },
        { id: 'm1', text: 'first', createdAt: 1 },
        { id: 'm2', text: 'second', createdAt: 2 },
      ]);
    });
    act(() => {
      result.current.convert(CONVO_ID, [{ steerId: 'srv-late', text: 'converted', createdAt: 9 }]);
    });
    expect(result.current.queue.map((item) => item.id)).toEqual(['m3', 'm1', 'm2', 'srv-late']);
  });

  it('still places a converted steer ahead of messages written after it', () => {
    const { result } = setup(({ set }) => {
      set(store.pendingSteersByConvoId(CONVO_ID), [
        { steerId: 'srv-early', text: 'accepted first', status: 'pending' as const, createdAt: 1 },
      ]);
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { id: 'later', text: 'queued afterwards', createdAt: 5 },
      ]);
    });
    act(() => {
      result.current.convert(CONVO_ID, [
        { steerId: 'srv-early', text: 'accepted first', createdAt: 1 },
      ]);
    });
    expect(result.current.queue.map((item) => item.id)).toEqual(['srv-early', 'later']);
  });

  it('is idempotent across double delivery (abort response + final SSE event)', () => {
    const { result } = setup();
    const steers = [{ steerId: 'srv-2', text: 'delivered twice', createdAt: 5 }];
    act(() => {
      result.current.convert(CONVO_ID, steers);
      result.current.convert(CONVO_ID, steers);
    });
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.applied).toEqual(['srv-2']);
  });

  it('does not re-queue a steer already drained after conversion', () => {
    const { result } = setup();
    const steers = [{ steerId: 'srv-drained', text: 'submitted once', createdAt: 5 }];
    // First delivery converts the leftover steer into a queued chip.
    act(() => {
      result.current.convert(CONVO_ID, steers);
    });
    expect(result.current.queue).toEqual([expect.objectContaining({ id: 'srv-drained' })]);
    // The run-end drain submits it and removes it from the queue.
    act(() => {
      result.current.drainQueue();
    });
    expect(result.current.queue).toEqual([]);
    // A late redelivery of the SAME steer (claimParked /chat/status, abort
    // response, or reconnect) must NOT resurrect a queued chip for a message
    // that was already sent — the applied-id set marks it settled.
    act(() => {
      result.current.convert(CONVO_ID, steers);
    });
    expect(result.current.queue).toEqual([]);
    expect(result.current.applied).toEqual(['srv-drained']);
  });

  it('re-queues a drained recovery source when inactive status proves it was not consumed', () => {
    const { result } = setup();
    const steers = [{ steerId: 'srv-retry', text: 'retry after failed recovery', createdAt: 5 }];
    act(() => {
      result.current.convert(CONVO_ID, steers);
    });
    const failedAttemptId = result.current.queue[0].clientRequestId;
    act(() => {
      result.current.drainQueue();
    });

    expect(result.current.queue).toEqual([]);
    act(() => {
      result.current.convert(CONVO_ID, steers, {
        generationProtocolVersion: 2,
        allowPreviouslyConvertedIds: ['srv-retry'],
      });
    });

    expect(result.current.queue).toEqual([
      expect.objectContaining({
        id: 'srv-retry',
        clientRequestId: expect.any(String),
        recoverySteerId: 'srv-retry',
      }),
    ]);
    expect(result.current.queue[0].clientRequestId).not.toBe(failedAttemptId);
    expect(result.current.applied).toEqual(['srv-retry']);
  });

  describe('claimParked (reconciles the parked server copy of live-delivered steers)', () => {
    beforeEach(() => {
      mockFetchStreamStatus.mockReset();
    });

    it('fires exactly one status fetch per batch and dedupes the claimed steers', async () => {
      mockFetchStreamStatus.mockResolvedValue({
        active: false,
        generationProtocolVersion: 2,
        unrecoveredSteers: [
          { steerId: 'live-1', text: 'delivered live', createdAt: 1 },
          { steerId: 'parked-1', text: 'parked only', createdAt: 2 },
        ],
      });
      const { result } = setup();
      await act(async () => {
        result.current.convert(
          CONVO_ID,
          [
            { steerId: 'live-1', text: 'delivered live', createdAt: 1 },
            { steerId: 'live-2', text: 'also live', createdAt: 3 },
          ],
          { claimParked: true },
        );
      });
      expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchStreamStatus).toHaveBeenCalledWith(CONVO_ID);
      // The claimed copy of live-1 re-ran the id-deduped conversion: no double-add.
      expect(result.current.queue.map((item) => item.id)).toEqual(['live-1', 'parked-1', 'live-2']);
    });

    it('tolerates a failed status fetch without breaking conversion', async () => {
      mockFetchStreamStatus.mockRejectedValue(new Error('offline'));
      const { result } = setup();
      await act(async () => {
        result.current.convert(CONVO_ID, [{ steerId: 'srv-3', text: 'kept', createdAt: 1 }], {
          claimParked: true,
        });
      });
      expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
      expect(result.current.queue).toEqual([expect.objectContaining({ id: 'srv-3' })]);
    });

    it('downgrades an existing bound recovery when a legacy claim deletes its source', async () => {
      mockFetchStreamStatus.mockResolvedValue({
        active: false,
        generationProtocolVersion: 1,
        unrecoveredSteers: [{ steerId: 'legacy-claimed', text: 'keep these words', createdAt: 1 }],
      });
      const { result } = setup();

      await act(async () => {
        result.current.convert(
          CONVO_ID,
          [{ steerId: 'legacy-claimed', text: 'keep these words', createdAt: 1 }],
          { claimParked: true, generationProtocolVersion: 2 },
        );
      });

      expect(result.current.queue).toEqual([
        {
          id: 'legacy-claimed',
          text: 'keep these words',
          createdAt: 1,
        },
      ]);
    });

    it('claims under claimConversationId while chips land under the chip key', async () => {
      mockFetchStreamStatus.mockResolvedValue({
        active: false,
        generationProtocolVersion: 2,
        unrecoveredSteers: [
          { steerId: 'parked-2', text: 'parked under resolved id', createdAt: 2 },
        ],
      });
      const { result } = setup();
      await act(async () => {
        result.current.convert(CONVO_ID, [{ steerId: 'live-3', text: 'live', createdAt: 1 }], {
          claimParked: true,
          claimConversationId: 'convo-resolved',
        });
      });
      expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
      expect(mockFetchStreamStatus).toHaveBeenCalledWith('convo-resolved');
      // Claimed steers still convert under the conversation the chips live on.
      expect(result.current.queue.map((item) => item.id)).toEqual(['live-3', 'parked-2']);
    });

    it('skips the claim without the option or with an empty batch', async () => {
      const { result } = setup();
      await act(async () => {
        result.current.convert(CONVO_ID, [{ steerId: 'srv-4', text: 'plain', createdAt: 1 }]);
        result.current.convert(CONVO_ID, [], { claimParked: true });
      });
      expect(mockFetchStreamStatus).not.toHaveBeenCalled();
      expect(result.current.queue).toEqual([expect.objectContaining({ id: 'srv-4' })]);
    });
  });
});
