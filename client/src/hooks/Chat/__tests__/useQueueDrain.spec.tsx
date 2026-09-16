import React from 'react';
import { getDefaultStore } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Constants, ReasoningEffort } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecoilRoot, useRecoilValue, useSetRecoilState, type MutableSnapshot } from 'recoil';
import type {
  DrainAfterAbort,
  RunEnd,
  QueuedMessage,
  SettledQueuedTurnReceipt,
} from '~/store/families';
import {
  claimQueuedIntent,
  releaseQueuedIntent,
  acquireQueueSendLock,
  releaseQueueSendLock,
} from '~/utils/queueIntent';
import { revealedQueuedTurnFamily } from '~/store/steer';
import useQueueDrain from '../useQueueDrain';
import store from '~/store';

const mockMarkFilesUsage = jest.fn();
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useMarkFilesUsageMutation: () => ({ mutate: mockMarkFilesUsage }),
}));

const INDEX = 0;
const CONVO_ID = 'convo-drain';

function setup(
  initialize?: (snapshot: MutableSnapshot) => void,
  activeConversationId: string | undefined = CONVO_ID,
  revealQueuedTurn?: jest.Mock,
) {
  const ask = jest.fn();
  const setters: {
    setRunEnd?: (value: RunEnd | null) => void;
    setIsSubmitting?: (value: boolean) => void;
    setQueue?: (value: QueuedMessage[]) => void;
    setNewConvoQueue?: (value: QueuedMessage[]) => void;
    setSettledReceipts?: (value: SettledQueuedTurnReceipt[]) => void;
    setInterruptFlag?: (value: DrainAfterAbort | false) => void;
    queueRef?: { current: QueuedMessage[] };
    queue?: QueuedMessage[];
    newConvoQueue?: QueuedMessage[];
    settledReceipts?: SettledQueuedTurnReceipt[];
    runEnd?: RunEnd | null;
  } = {};

  function Harness() {
    setters.setRunEnd = useSetRecoilState(store.runEndByIndex(INDEX));
    setters.setIsSubmitting = useSetRecoilState(store.isSubmittingFamily(INDEX));
    setters.setQueue = useSetRecoilState(store.queuedMessagesByConvoId(CONVO_ID));
    setters.queueRef = {
      current: useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID)),
    };
    setters.setNewConvoQueue = useSetRecoilState(
      store.queuedMessagesByConvoId(Constants.NEW_CONVO),
    );
    setters.setSettledReceipts = useSetRecoilState(
      store.settledQueuedTurnReceiptsByConvoId(CONVO_ID),
    );
    setters.setInterruptFlag = useSetRecoilState(store.drainAfterAbortByIndex(INDEX));
    setters.queue = useRecoilValue(store.queuedMessagesByConvoId(CONVO_ID));
    setters.newConvoQueue = useRecoilValue(store.queuedMessagesByConvoId(Constants.NEW_CONVO));
    setters.settledReceipts = useRecoilValue(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID));
    setters.runEnd = useRecoilValue(store.runEndByIndex(INDEX));
    useQueueDrain(INDEX, activeConversationId, ask, revealQueuedTurn);
    return null;
  }

  /* The drain renews the TTL hold on what stays queued, which goes through
   * react-query, so the harness needs a client. */
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initialize}>
        <Harness />
        {children}
      </RecoilRoot>
    </QueryClientProvider>
  );
  renderHook(() => null, { wrapper });
  return { ask, setters };
}

const emptyOverrides = expect.objectContaining({
  overrideFiles: [],
  overrideQuotes: [],
  overrideManualSkills: [],
  overrideReasoning: null,
  overrideQueuedMessageOrigin: expect.any(Object),
});

const queuedMessage = (id: string, text: string) => ({
  id,
  text,
  createdAt: Date.now(),
});

const runEnd = (overrides: Partial<RunEnd> = {}): RunEnd => ({
  conversationId: CONVO_ID,
  outcome: 'completed',
  endedAt: Date.now(),
  generationCreatedAt: 41,
  ...overrides,
});

describe('useQueueDrain', () => {
  beforeEach(() => {
    mockMarkFilesUsage.mockClear();
  });

  it('drains exactly one queued message on clean completion', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q1', 'first follow-up'),
        queuedMessage('q2', 'second follow-up'),
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 1234 }));
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({ text: 'first follow-up' }, emptyOverrides);
  });

  it('does not locally drain or renew server-owned Agent rows', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q-server', 'the server starts this turn'),
          files: [{ file_id: 'server-held-file' }],
          clientRequestId: 'client-request-1',
          server: { id: 'server-queue-1', status: 'queued', revision: 1 },
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();
    expect(mockMarkFilesUsage).not.toHaveBeenCalledWith({
      file_ids: ['server-held-file'],
    });
  });

  it('hands the server-owned head to the reveal on clean completion and keeps the boundary', async () => {
    const reveal = jest.fn();
    const head = {
      ...queuedMessage('q-server', 'the server starts this turn'),
      clientRequestId: 'client-request-1',
      server: { id: 'server-queue-1', status: 'queued' as const, revision: 1 },
    };
    const { ask, setters } = setup(
      ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [head]);
      },
      CONVO_ID,
      reveal,
    );

    const end = runEnd({ responseMessageId: 'response-1' });
    act(() => {
      setters.setRunEnd!(end);
    });

    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(reveal).toHaveBeenCalledWith(head, expect.objectContaining(end));
    expect(ask).not.toHaveBeenCalled();
    expect(setters.runEnd).toEqual(expect.objectContaining(end));
    expect(setters.queue).toEqual([head]);
  });

  it('re-selects the next server-owned row once the revealed head settles', async () => {
    const reveal = jest.fn();
    const first = {
      ...queuedMessage('q-first', 'first server turn'),
      clientRequestId: 'client-request-1',
      server: { id: 'server-queue-1', status: 'queued' as const, revision: 1 },
    };
    const second = {
      ...queuedMessage('q-second', 'second server turn'),
      clientRequestId: 'client-request-2',
      server: { id: 'server-queue-2', status: 'queued' as const, revision: 2 },
    };
    const { setters } = setup(
      ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [first, second]);
      },
      CONVO_ID,
      reveal,
    );

    act(() => {
      setters.setRunEnd!(runEnd({ responseMessageId: 'response-1' }));
    });
    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(reveal.mock.calls[0][0]).toEqual(first);
    act(() => {
      getDefaultStore().set(revealedQueuedTurnFamily(CONVO_ID), {
        clientRequestId: 'client-request-1',
        parentMessageId: 'response-1',
        text: first.text,
        revealedAt: '2026-09-14T00:00:00.000Z',
      });
    });
    reveal.mockClear();

    /** The first row is cancelled before admission: its reveal ends and the
     *  row leaves the queue, while the boundary stays server-owned. */
    act(() => {
      getDefaultStore().set(revealedQueuedTurnFamily(CONVO_ID), null);
      setters.setQueue!([second]);
    });

    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(reveal.mock.calls[reveal.mock.calls.length - 1][0]).toEqual(second);
    expect(setters.runEnd).toEqual(expect.objectContaining({ responseMessageId: 'response-1' }));
  });

  it('reveals the server-owned row behind a migrated local head', async () => {
    const reveal = jest.fn();
    const local = queuedMessage('q-local', 'queued before the id arrived');
    const serverRow = {
      ...queuedMessage('q-server', 'queued after the id arrived'),
      clientRequestId: 'client-request-2',
      server: { id: 'server-queue-2', status: 'queued' as const, revision: 1 },
    };
    const { ask, setters } = setup(
      ({ set }) => {
        set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [local]);
        set(store.queuedMessagesByConvoId(CONVO_ID), [serverRow]);
      },
      CONVO_ID,
      reveal,
    );

    act(() => {
      setters.setRunEnd!(runEnd({ startedAsNewConvo: true, responseMessageId: 'response-1' }));
    });

    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(reveal.mock.calls[0][0]).toEqual(serverRow);
    expect(ask).not.toHaveBeenCalled();
  });

  it('reveals nothing on a stop, or when the completed run carries no response id', async () => {
    const reveal = jest.fn();
    const { setters } = setup(
      ({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [
          {
            ...queuedMessage('q-server', 'the server starts this turn'),
            clientRequestId: 'client-request-1',
            server: { id: 'server-queue-1', status: 'queued', revision: 1 },
          },
        ]);
      },
      CONVO_ID,
      reveal,
    );

    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'aborted', responseMessageId: 'response-1' }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    act(() => {
      setters.setRunEnd!(null);
      setters.setRunEnd!(runEnd());
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(reveal).not.toHaveBeenCalled();
  });

  it('retains the terminal boundary until server authority releases a local successor', async () => {
    const localSuccessor = queuedMessage('q-local', 'legacy successor');
    const queue: QueuedMessage[] = [
      {
        ...queuedMessage('q-server', 'server-owned predecessor'),
        server: { id: 'server-queue-1', status: 'queued', revision: 1 },
      },
      localSuccessor,
    ];
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), queue);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();

    act(() => {
      setters.setQueue!([localSuccessor]);
    });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({ text: 'legacy successor' }, emptyOverrides);
  });

  it('reacts to a settled admission while another server row still owns the queue', async () => {
    const admittedServer: QueuedMessage = {
      ...queuedMessage('q-server-1', 'admitted server-owned turn'),
      server: { id: 'server-queue-1', status: 'claimed', revision: 1 },
    };
    const remainingServer: QueuedMessage = {
      ...queuedMessage('q-server-2', 'later server-owned turn'),
      server: { id: 'server-queue-2', status: 'queued', revision: 2 },
    };
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [admittedServer, remainingServer]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 41 }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(setters.runEnd).not.toBeNull();

    act(() => {
      setters.setQueue!([remainingServer]);
      setters.setSettledReceipts!([
        {
          clientRequestId: 'admitted-request-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    await waitFor(() => expect(setters.runEnd).toBeNull());
    expect(ask).not.toHaveBeenCalled();
    expect(setters.settledReceipts).toEqual([]);
    expect(setters.queue).toEqual([remainingServer]);
  });

  it('discards a predecessor boundary already consumed by server admission', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q-local', 'must wait for the admitted run'),
      ]);
      set(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID), [
        {
          clientRequestId: 'admission-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 41 }));
    });

    await waitFor(() => expect(setters.runEnd).toBeNull());
    expect(ask).not.toHaveBeenCalled();
    expect(setters.settledReceipts).toEqual([]);
  });

  it('consumes one admission when separate receipts share the same predecessor epoch', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q-local', 'wait for both admitted runs'),
      ]);
      set(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID), [
        {
          clientRequestId: 'admission-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
        {
          clientRequestId: 'admission-2',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 41 }));
    });

    await waitFor(() =>
      expect(setters.settledReceipts).toEqual([
        {
          clientRequestId: 'admission-2',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]),
    );
    expect(ask).not.toHaveBeenCalled();

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 41, endedAt: Date.now() + 1 }));
    });

    await waitFor(() => expect(setters.settledReceipts).toEqual([]));
    expect(ask).not.toHaveBeenCalled();
  });

  it('migrates the NEW_CONVO queue before discarding a consumed predecessor boundary', async () => {
    const queuedBeforeResolution = queuedMessage('q-new', 'wait for the admitted successor');
    const queuedAfterResolution = queuedMessage('q-resolved', 'still ordered after migration');
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [queuedBeforeResolution]);
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedAfterResolution]);
      set(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID), [
        {
          clientRequestId: 'admission-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(
        runEnd({
          generationCreatedAt: 41,
          startedAsNewConvo: true,
        }),
      );
    });

    await waitFor(() => expect(setters.runEnd).toBeNull());
    expect(ask).not.toHaveBeenCalled();
    expect(setters.newConvoQueue).toEqual([]);
    expect(setters.queue).toEqual([queuedBeforeResolution, queuedAfterResolution]);
  });

  it('lets the admitted successor terminal boundary release the next turn', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q-local', 'send after the admitted run'),
      ]);
      set(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID), [
        {
          clientRequestId: 'admission-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 41,
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 42 }));
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({ text: 'send after the admitted run' }, emptyOverrides);
  });

  it('does not interpret a consumed predecessor as a timestamp range', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q-local', 'send after the lower-clock successor'),
      ]);
      set(store.settledQueuedTurnReceiptsByConvoId(CONVO_ID), [
        {
          clientRequestId: 'admission-1',
          status: 'admitted',
          effectivePredecessorCreatedAt: 42,
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 41 }));
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(
      { text: 'send after the lower-clock successor' },
      emptyOverrides,
    );
    expect(setters.settledReceipts).toEqual([
      {
        clientRequestId: 'admission-1',
        status: 'admitted',
        effectivePredecessorCreatedAt: 42,
      },
    ]);
  });

  it('parks a mismatched signal instead of draining into the wrong conversation', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'stay put')]);
    }, 'some-other-convo');

    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    // Not sent through the mounted (wrong-conversation) sender; the signal is
    // parked under its own conversation, freeing the shared index slot.
    expect(ask).not.toHaveBeenCalled();
  });

  it('drains a parked signal when the user returns to that conversation', async () => {
    const { ask } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'welcome back')]);
      set(store.pendingRunEndByConvoId(CONVO_ID), runEnd());
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({ text: 'welcome back' }, emptyOverrides);
  });

  it('passes a queued message`s attachments through as overrideFiles', async () => {
    const files = [{ file_id: 'f1', filepath: '/uploads/f1.png', type: 'image/png' }];
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { ...queuedMessage('q1', 'with media'), files },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(
      { text: 'with media' },
      expect.objectContaining({
        overrideFiles: files,
        overrideQuotes: [],
        overrideManualSkills: [],
        overrideQueuedMessageOrigin: expect.any(Object),
      }),
    );
  });

  /** Items behind the drained one wait another full run, which may itself
   *  pause for approval, so a hold taken once at enqueue would lapse before a
   *  deep queue finishes draining. */
  it('renews the TTL hold on attachments that stay queued', async () => {
    const { setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q1', 'first'),
          files: [{ file_id: 'sent', type: 'image/png' }],
        },
        {
          ...queuedMessage('q2', 'second'),
          files: [{ file_id: 'still-queued', type: 'image/png' }],
        },
        {
          ...queuedMessage('q3', 'third'),
          files: [{ file_id: 'also-queued', type: 'image/png' }],
        },
      ]);
    });

    mockMarkFilesUsage.mockClear();
    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(mockMarkFilesUsage).toHaveBeenCalledTimes(1));
    /* Only what remains: the drained item's file is released at send. */
    expect(mockMarkFilesUsage).toHaveBeenCalledWith({
      file_ids: ['still-queued', 'also-queued'],
    });
  });

  it('does not renew when nothing with attachments stays queued', async () => {
    const { setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q1', 'only one'),
          files: [{ file_id: 'sent', type: 'image/png' }],
        },
      ]);
    });

    mockMarkFilesUsage.mockClear();
    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(mockMarkFilesUsage).not.toHaveBeenCalled());
  });

  /** The server caps ids per request, so a queue holding more than one batch
   *  must renew in several; truncating would leave later messages on their
   *  enqueue-time hold. */
  it('renews every queued attachment across multiple capped batches', async () => {
    const manyFiles = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        file_id: `${prefix}-${i}`,
        type: 'image/png',
      }));
    const { setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { ...queuedMessage('q1', 'first'), files: manyFiles('sent', 2) },
        { ...queuedMessage('q2', 'second'), files: manyFiles('a', 10) },
        { ...queuedMessage('q3', 'third'), files: manyFiles('b', 4) },
      ]);
    });

    mockMarkFilesUsage.mockClear();
    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(mockMarkFilesUsage).toHaveBeenCalledTimes(2));
    const sent = mockMarkFilesUsage.mock.calls.flatMap((call) => call[0].file_ids);
    expect(sent).toHaveLength(14);
    expect(sent).toContain('b-3');
    expect(sent).not.toContain('sent-0');
    for (const call of mockMarkFilesUsage.mock.calls) {
      expect(call[0].file_ids.length).toBeLessThanOrEqual(10);
    }
  });

  /** A refused send puts the item back with its run-end signal already
   *  consumed, so nothing else would touch it before the next drain. */
  it('renews a restored item when the send is refused', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q1', 'refused'),
          files: [{ file_id: 'restored', type: 'image/png' }],
        },
      ]);
    });
    ask.mockReturnValue(false);

    mockMarkFilesUsage.mockClear();
    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(mockMarkFilesUsage).toHaveBeenCalledTimes(1));
    expect(mockMarkFilesUsage).toHaveBeenCalledWith({ file_ids: ['restored'] });
  });

  /** A single run can pause for approval more than once, so renewal cannot
   *  depend on catching drain transitions alone. */
  it('renews on a heartbeat while items stay queued', async () => {
    jest.useFakeTimers();
    try {
      setup(({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [
          {
            ...queuedMessage('q1', 'waiting'),
            files: [{ file_id: 'held', type: 'image/png' }],
          },
        ]);
      });

      /* Immediate, then on each interval. */
      expect(mockMarkFilesUsage).toHaveBeenCalledTimes(1);
      expect(mockMarkFilesUsage).toHaveBeenCalledWith({ file_ids: ['held'] });

      act(() => {
        jest.advanceTimersByTime(30 * 60 * 1000);
      });
      expect(mockMarkFilesUsage).toHaveBeenCalledTimes(2);

      act(() => {
        jest.advanceTimersByTime(30 * 60 * 1000);
      });
      expect(mockMarkFilesUsage).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits no heartbeat when the queue holds no attachments', async () => {
    jest.useFakeTimers();
    try {
      setup(({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'no files')]);
      });

      act(() => {
        jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      });
      expect(mockMarkFilesUsage).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  /** Items queued during the first turn stay keyed under NEW_CONVO until that
   *  run ends, so renewing only the active id would skip them for its whole
   *  duration. */
  it('renews the pre-migration NEW_CONVO queue alongside the active one', async () => {
    setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
        {
          ...queuedMessage('n1', 'queued pre-migration'),
          files: [{ file_id: 'pending-migrate' }],
        },
      ]);
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q1', 'queued after'),
          files: [{ file_id: 'already-migrated' }],
        },
      ]);
    });

    await waitFor(() => expect(mockMarkFilesUsage).toHaveBeenCalled());
    const sent = mockMarkFilesUsage.mock.calls.flatMap((call) => call[0].file_ids);
    expect(sent).toContain('pending-migrate');
    expect(sent).toContain('already-migrated');
  });

  it('does not double-count the queue before migration', async () => {
    setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
        {
          ...queuedMessage('n1', 'new convo'),
          files: [{ file_id: 'only-once' }],
        },
      ]);
    }, Constants.NEW_CONVO as string);

    await waitFor(() => expect(mockMarkFilesUsage).toHaveBeenCalled());
    const sent = mockMarkFilesUsage.mock.calls.flatMap((call) => call[0].file_ids);
    expect(sent).toEqual(['only-once']);
  });

  it('passes carried quotes, skills, and reasoning through as overrides', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('q1', 'with context'),
          quotes: ['quoted excerpt'],
          manualSkills: ['skill-1'],
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(
      { text: 'with context' },
      expect.objectContaining({
        overrideFiles: [],
        overrideQuotes: ['quoted excerpt'],
        overrideManualSkills: ['skill-1'],
        overrideReasoning: { key: 'reasoning_effort', value: ReasoningEffort.high },
        overrideQueuedMessageOrigin: expect.any(Object),
      }),
    );
  });

  it('keeps the recovery user row stable while forwarding its per-attempt identity', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          ...queuedMessage('source-steer', 'recover once'),
          clientRequestId: 'attempt-uuid',
          recoverySteerId: 'source-steer',
        },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ generationCreatedAt: 1234 }));
    });

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(
      { text: 'recover once', overrideUserMessageId: 'source-steer' },
      expect.objectContaining({
        overrideClientRequestId: 'attempt-uuid',
        overrideRecoverySteerId: 'source-steer',
        overrideExpectedPredecessorCreatedAt: 1234,
        overrideQueuedMessageOrigin: expect.any(Object),
      }),
    );
  });

  it('does not drain on user abort or error outcomes', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'kept')]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'aborted' }));
    });
    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'error' }));
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();
  });

  it('drains on abort when the interrupt & send flag is armed, then disarms', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'interrupt text')]);
      set(store.drainAfterAbortByIndex(INDEX), {
        conversationId: CONVO_ID,
        generationCreatedAt: 41,
      });
    });

    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'aborted' }));
    });
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({ text: 'interrupt text' }, emptyOverrides),
    );

    // Flag consumed: a second abort does NOT drain
    act(() => {
      setters.setQueue!([queuedMessage('q2', 'still queued')]);
      setters.setRunEnd!(runEnd({ outcome: 'aborted' }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('does not let a different generation consume an interrupt arm', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'epoch owner')]);
      set(store.drainAfterAbortByIndex(INDEX), {
        conversationId: CONVO_ID,
        generationCreatedAt: 41,
      });
    });

    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'aborted', generationCreatedAt: 42 }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();

    act(() => {
      setters.setRunEnd!(runEnd({ outcome: 'aborted', generationCreatedAt: 41 }));
    });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({ text: 'epoch owner' }, emptyOverrides);
  });

  it('parks a foreign epoch while another conversation submits and preserves the next end', async () => {
    const CONVO_A = 'convo-a';
    const CONVO_B = 'convo-b';
    const ask = jest.fn();
    let setRunEnd: ((value: RunEnd | null) => void) | undefined;
    let setIsSubmitting: ((value: boolean) => void) | undefined;

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.isSubmittingFamily(INDEX), true);
            set(store.queuedMessagesByConvoId(CONVO_A), [queuedMessage('qa', 'send for A')]);
            set(store.queuedMessagesByConvoId(CONVO_B), [queuedMessage('qb', 'send for B')]);
            set(store.drainAfterAbortByIndex(INDEX), {
              conversationId: CONVO_A,
              generationCreatedAt: 11,
            });
          }}
        >
          {children}
        </RecoilRoot>
      </QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ activeConversationId }: { activeConversationId: string }) => {
        setRunEnd = useSetRecoilState(store.runEndByIndex(INDEX));
        setIsSubmitting = useSetRecoilState(store.isSubmittingFamily(INDEX));
        useQueueDrain(INDEX, activeConversationId, ask);
        return {
          indexEnd: useRecoilValue(store.runEndByIndex(INDEX)),
          parkedA: useRecoilValue(store.pendingRunEndByConvoId(CONVO_A)),
        };
      },
      { wrapper, initialProps: { activeConversationId: CONVO_B } },
    );

    /** Both terminal callbacks land before React can park the first one. The
     * pane carrier must retain B behind A instead of replacing A. */
    act(() => {
      setRunEnd?.({
        conversationId: CONVO_A,
        outcome: 'aborted',
        endedAt: 1,
        generationCreatedAt: 11,
      });
      setRunEnd?.({
        conversationId: CONVO_B,
        outcome: 'completed',
        endedAt: 2,
        generationCreatedAt: 22,
      });
    });

    await waitFor(() =>
      expect(result.current.parkedA).toMatchObject({
        conversationId: CONVO_A,
        generationCreatedAt: 11,
        interruptArmed: true,
      }),
    );
    expect(result.current.indexEnd).toMatchObject({
      conversationId: CONVO_B,
      generationCreatedAt: 22,
    });
    expect(ask).not.toHaveBeenCalled();

    act(() => setIsSubmitting?.(false));
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        { text: 'send for B' },
        expect.objectContaining({ overrideExpectedPredecessorCreatedAt: 22 }),
      ),
    );

    rerender({ activeConversationId: CONVO_A });
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        { text: 'send for A' },
        expect.objectContaining({ overrideExpectedPredecessorCreatedAt: 11 }),
      ),
    );
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('waits for isSubmitting to flip false before draining', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q1', 'deferred')]);
      set(store.isSubmittingFamily(INDEX), true);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();

    act(() => {
      setters.setIsSubmitting!(false);
    });
    await waitFor(() => expect(ask).toHaveBeenCalledWith({ text: 'deferred' }, emptyOverrides));
  });

  it('migrates a NEW_CONVO-keyed queue when the run started as a new conversation', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
        queuedMessage('q1', 'queued before convo existed'),
        queuedMessage('q2', 'second'),
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ startedAsNewConvo: true }));
    });

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({ text: 'queued before convo existed' }, emptyOverrides),
    );
  });

  it('preserves a manually reordered NEW_CONVO queue during migration', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
        { id: 'second', text: 'send this first', createdAt: 2 },
        { id: 'first', text: 'send this second', createdAt: 1 },
      ]);
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        { id: 'third', text: 'send this third', createdAt: 3 },
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd({ startedAsNewConvo: true }));
    });

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({ text: 'send this first' }, emptyOverrides),
    );
  });

  it('keeps an interrupt queued after URL resolution ahead of pre-migration follow-ups', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
        { id: 'ordinary-before-url', text: 'ordinary follow-up', createdAt: 1 },
      ]);
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        {
          id: 'interrupt-after-url',
          text: 'interrupt next',
          createdAt: 2,
          priority: true,
        },
      ]);
      set(store.drainAfterAbortByIndex(INDEX), {
        conversationId: CONVO_ID,
        generationCreatedAt: 41,
      });
    });

    act(() => {
      setters.setRunEnd!(
        runEnd({
          outcome: 'aborted',
          startedAsNewConvo: true,
        }),
      );
    });

    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({ text: 'interrupt next' }, emptyOverrides),
    );
  });

  describe('early-aborted first turn (NEW_CONVO-keyed signal)', () => {
    const OPTIMISTIC_ID = 'optimistic-stream-id';

    function setupNewConvo(initialize?: (snapshot: MutableSnapshot) => void) {
      const ask = jest.fn();
      const setters: {
        setRunEnd?: (value: RunEnd | null) => void;
        setInterruptFlag?: (value: DrainAfterAbort | false) => void;
      } = {};
      const state: {
        newConvoQueue?: QueuedMessage[];
        parkedUnderOptimistic?: RunEnd | null;
      } = {};

      function Harness() {
        setters.setRunEnd = useSetRecoilState(store.runEndByIndex(INDEX));
        setters.setInterruptFlag = useSetRecoilState(store.drainAfterAbortByIndex(INDEX));
        state.newConvoQueue = useRecoilValue(store.queuedMessagesByConvoId(Constants.NEW_CONVO));
        state.parkedUnderOptimistic = useRecoilValue(store.pendingRunEndByConvoId(OPTIMISTIC_ID));
        useQueueDrain(INDEX, Constants.NEW_CONVO as string, ask);
        return null;
      }

      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <RecoilRoot initializeState={initialize}>
            <Harness />
            {children}
          </RecoilRoot>
        </QueryClientProvider>
      );
      renderHook(() => null, { wrapper });
      return { ask, setters, state };
    }

    it('leaves the NEW_CONVO queue in place and parks nothing under the optimistic id', async () => {
      const { ask, setters, state } = setupNewConvo(({ set }) => {
        set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
          queuedMessage('q1', 'queued during first turn'),
        ]);
      });

      act(() => {
        setters.setRunEnd!(
          runEnd({
            conversationId: Constants.NEW_CONVO as string,
            outcome: 'aborted',
            startedAsNewConvo: false,
          }),
        );
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(ask).not.toHaveBeenCalled();
      // The queue stays visible on the restored new-chat composer.
      expect(state.newConvoQueue).toEqual([
        expect.objectContaining({ id: 'q1', text: 'queued during first turn' }),
      ]);
      expect(state.parkedUnderOptimistic).toBeNull();
    });

    it('drains under NEW_CONVO when interrupt & send was armed', async () => {
      const { ask } = setupNewConvo(({ set }) => {
        set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), [
          queuedMessage('q1', 'interrupted first turn'),
        ]);
        set(store.drainAfterAbortByIndex(INDEX), {
          conversationId: String(Constants.NEW_CONVO),
          generationCreatedAt: 41,
        });
        set(store.runEndByIndex(INDEX), {
          conversationId: Constants.NEW_CONVO as string,
          outcome: 'aborted',
          startedAsNewConvo: false,
          endedAt: Date.now(),
          generationCreatedAt: 41,
        });
      });

      await waitFor(() =>
        expect(ask).toHaveBeenCalledWith({ text: 'interrupted first turn' }, emptyOverrides),
      );
      expect(ask).toHaveBeenCalledTimes(1);
    });
  });

  it('consumes the run-end signal (no double fire on re-render)', async () => {
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [
        queuedMessage('q1', 'one'),
        queuedMessage('q2', 'two'),
      ]);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    // Toggling isSubmitting without a fresh runEnd must not drain again
    act(() => {
      setters.setIsSubmitting!(true);
    });
    act(() => {
      setters.setIsSubmitting!(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /* Edit and Remove on the rail hand a row's words to the composer across an
     await, and the run end can land inside that gap. Dequeuing there sent the
     very message the user was in the middle of taking back. */
  describe('rows the rail has claimed', () => {
    afterEach(() => {
      releaseQueuedIntent('q-claimed');
      releaseQueuedIntent('q-only');
    });

    it('skips a claimed row and sends the next one instead', async () => {
      claimQueuedIntent('q-claimed');
      const { ask, setters } = setup(({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [
          queuedMessage('q-claimed', 'being taken back'),
          queuedMessage('q-next', 'still wanted'),
        ]);
      });

      act(() => {
        setters.setRunEnd!(runEnd());
      });
      await waitFor(() =>
        expect(ask).toHaveBeenCalledWith({ text: 'still wanted' }, emptyOverrides),
      );
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it('restores a refused skipped row after its claimed predecessor', async () => {
      claimQueuedIntent('q-claimed');
      const { ask, setters } = setup(({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [
          queuedMessage('q-claimed', 'being taken back'),
          queuedMessage('q-next', 'temporarily refused'),
          queuedMessage('q-tail', 'still last'),
        ]);
      });
      ask.mockReturnValue(false);

      act(() => {
        setters.setRunEnd!(runEnd());
      });

      await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(setters.queueRef?.current.map((item) => item.id)).toEqual([
          'q-claimed',
          'q-next',
          'q-tail',
        ]),
      );
    });

    it('sends nothing when the only queued row is claimed', async () => {
      claimQueuedIntent('q-only');
      const { ask, setters } = setup(({ set }) => {
        set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q-only', 'mine for now')]);
      });

      act(() => {
        setters.setRunEnd!(runEnd());
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(ask).not.toHaveBeenCalled();
    });
  });

  /* `isSubmitting` is a render-old read on both sides, so the rail's own Send
     now can already have called `ask` for this pane in the current task. */
  it('refuses to drain while a queued send holds the pane', async () => {
    const held = acquireQueueSendLock(String(INDEX));
    const { ask, setters } = setup(({ set }) => {
      set(store.queuedMessagesByConvoId(CONVO_ID), [queuedMessage('q-lock', 'after the hold')]);
    });

    act(() => {
      setters.setRunEnd!(runEnd());
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ask).not.toHaveBeenCalled();

    /* The signal was never consumed, so the queue is reconsidered rather than
       dropped as soon as the pane's submission state moves again. */
    releaseQueueSendLock(held);
    act(() => {
      setters.setIsSubmitting!(true);
    });
    act(() => {
      setters.setIsSubmitting!(false);
    });
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith({ text: 'after the hold' }, emptyOverrides),
    );
  });
});
