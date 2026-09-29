import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueuedMessage, RunEnd } from '~/store/families';
import type { RevealedQueuedTurn } from '~/store/steer';
import useQueuedTurnReveal, {
  buildRevealedMessage,
  hasRevealSuccessor,
  selectQueuedTurnReveal,
  shouldRollbackReveal,
} from '../useQueuedTurnReveal';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import { streamStatusQueryKey } from '~/data-provider/SSE/queries';
import { revealedQueuedTurnFamily } from '~/store/steer';
import store from '~/store';

const CONVO_ID = 'convo-reveal';
const RESPONSE_ID = 'response-1';

const serverRow = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q-server',
  text: 'queued follow-up',
  createdAt: 10,
  parentMessageId: 'original-queue-parent',
  expectedPredecessorCreatedAt: 41,
  clientRequestId: 'client-request-1',
  server: { id: 'server-queue-1', status: 'queued', revision: 1 },
  ...overrides,
});

const completedEnd = (overrides: Partial<RunEnd> = {}): RunEnd => ({
  conversationId: CONVO_ID,
  outcome: 'completed',
  endedAt: 100,
  generationCreatedAt: 41,
  responseMessageId: RESPONSE_ID,
  ...overrides,
});

const history = (): TMessage[] => [
  { messageId: 'user-1', parentMessageId: '00000000-0000-0000-0000-000000000000' } as TMessage,
  { messageId: RESPONSE_ID, parentMessageId: 'user-1', isCreatedByUser: false } as TMessage,
];

const successor = (messageId = 'user-2'): TMessage =>
  ({ messageId, parentMessageId: RESPONSE_ID, isCreatedByUser: true }) as TMessage;

const reveal = (overrides: Partial<RevealedQueuedTurn> = {}): RevealedQueuedTurn => ({
  clientRequestId: 'client-request-1',
  parentMessageId: RESPONSE_ID,
  text: 'queued follow-up',
  revealedAt: '2026-09-14T00:00:00.000Z',
  ...overrides,
});

const receipt = (overrides: Partial<TAgentQueuedTurnReceipt> = {}): TAgentQueuedTurnReceipt =>
  ({
    queuedTurnId: 'server-queue-1',
    clientRequestId: 'client-request-1',
    conversationId: CONVO_ID,
    text: 'queued follow-up',
    status: 'queued',
    revision: 1,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }) as TAgentQueuedTurnReceipt;

describe('selectQueuedTurnReveal', () => {
  it('picks a durably queued server-owned head after a clean completion', () => {
    expect(selectQueuedTurnReveal(completedEnd(), [serverRow()])?.id).toBe('q-server');
    expect(
      selectQueuedTurnReveal(completedEnd(), [
        serverRow({ server: { id: 'server-queue-1', status: 'claimed', revision: 1 } }),
      ])?.id,
    ).toBe('q-server');
  });

  it('reveals nothing for a stop, an error, or a run with no response to follow', () => {
    expect(selectQueuedTurnReveal(completedEnd({ outcome: 'aborted' }), [serverRow()])).toBeNull();
    expect(selectQueuedTurnReveal(completedEnd({ outcome: 'error' }), [serverRow()])).toBeNull();
    expect(
      selectQueuedTurnReveal(completedEnd({ generationCreatedAt: undefined }), [serverRow()]),
    ).toBeNull();
    expect(
      selectQueuedTurnReveal(completedEnd({ responseMessageId: undefined }), [serverRow()]),
    ).toBeNull();
  });

  it('skips rejected server rows and local rows ahead of the admissible successor', () => {
    const rejected = serverRow({
      id: 'q-rejected',
      clientRequestId: 'client-request-0',
      server: { id: 'server-queue-0', status: 'rejected', revision: 0 },
    });
    const local: QueuedMessage = { id: 'q-local', text: 'local first', createdAt: 5 };
    expect(selectQueuedTurnReveal(completedEnd(), [rejected, serverRow()])?.id).toBe('q-server');
    expect(selectQueuedTurnReveal(completedEnd(), [local, serverRow()])?.id).toBe('q-server');
    expect(selectQueuedTurnReveal(completedEnd(), [local])).toBeNull();
  });

  it('leaves rows the server has not durably accepted, or has settled, on the chip', () => {
    expect(
      selectQueuedTurnReveal(completedEnd(), [serverRow({ server: { status: 'sending' } })]),
    ).toBeNull();
    expect(selectQueuedTurnReveal(completedEnd(), [serverRow({ server: undefined })])).toBeNull();
    expect(selectQueuedTurnReveal(completedEnd(), [])).toBeNull();
  });
});

describe('hasRevealSuccessor', () => {
  it('is true once anything parents on the response the reveal follows', () => {
    expect(hasRevealSuccessor(history(), reveal())).toBe(false);
    expect(hasRevealSuccessor([...history(), successor()], reveal())).toBe(true);
    expect(
      hasRevealSuccessor(
        [...history(), { messageId: 'x', parentMessageId: 'user-1' } as TMessage],
        reveal(),
      ),
    ).toBe(false);
  });
});

describe('shouldRollbackReveal', () => {
  it('ends the reveal on cancelled, dead, or indeterminate receipts for its request', () => {
    expect(shouldRollbackReveal([receipt({ status: 'cancelled' })], reveal())).toBe(true);
    expect(shouldRollbackReveal([receipt({ status: 'dead' })], reveal())).toBe(true);
    expect(
      shouldRollbackReveal(
        [receipt({ status: 'claimed', failure: { code: 'ADMISSION_INDETERMINATE' } })],
        reveal(),
      ),
    ).toBe(true);
    expect(
      shouldRollbackReveal(
        [receipt({ status: 'cancelled', clientRequestId: 'client-request-9' })],
        reveal(),
      ),
    ).toBe(false);
  });

  it('keeps the reveal while the turn is queued, claimed, or admitted', () => {
    expect(shouldRollbackReveal([receipt()], reveal())).toBe(false);
    expect(shouldRollbackReveal([receipt({ status: 'claimed' })], reveal())).toBe(false);
    expect(shouldRollbackReveal([receipt({ status: 'admitted' })], reveal())).toBe(false);
    expect(shouldRollbackReveal([], reveal())).toBe(false);
  });
});

describe('buildRevealedMessage', () => {
  it('shapes a render-only user turn after the completed response with the queued context', () => {
    const message = buildRevealedMessage(
      reveal({ files: [{ file_id: 'f1' }], quotes: ['q'], manualSkills: ['s'] }),
      CONVO_ID,
    );
    expect(message).toEqual(
      expect.objectContaining({
        parentMessageId: RESPONSE_ID,
        conversationId: CONVO_ID,
        text: 'queued follow-up',
        isCreatedByUser: true,
        clientTimestamp: '2026-09-14T00:00:00.000Z',
        files: [{ file_id: 'f1' }],
        quotes: ['q'],
        manualSkills: ['s'],
      }),
    );
    expect(message.createdAt).toBeUndefined();
    expect(buildRevealedMessage(reveal(), CONVO_ID)).not.toHaveProperty('files');
  });
});

describe('useQueuedTurnReveal', () => {
  function setup(initialMessages: TMessage[] = history()) {
    let setSubmitting: (value: boolean) => void;
    let setEpoch: (value: number | null) => void;
    function StateProbe() {
      setSubmitting = useSetRecoilState(store.isSubmittingFamily(0));
      setEpoch = useSetRecoilState(store.activeGenerationCreatedAtByConvoId(CONVO_ID));
      return null;
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, CONVO_ID], initialMessages);
    const jotaiStore = createStore();
    const getMessages = () => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, CONVO_ID]);
    const setMessages = (messages: TMessage[]) =>
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, CONVO_ID], messages);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <JotaiProvider store={jotaiStore}>
            <StateProbe />
            {children}
          </JotaiProvider>
        </RecoilRoot>
      </QueryClientProvider>
    );
    const rendered = renderHook(() => useQueuedTurnReveal(CONVO_ID), { wrapper });
    const current = () => jotaiStore.get(revealedQueuedTurnFamily(CONVO_ID));
    return {
      ...rendered,
      queryClient,
      jotaiStore,
      getMessages,
      setMessages,
      current,
      attach: (epoch: number, submitting = true) => {
        setEpoch(epoch);
        setSubmitting(submitting);
      },
      setReceipts: (receipts: TAgentQueuedTurnReceipt[]) =>
        queryClient.setQueryData(agentQueuedTurnsQueryKey(CONVO_ID), receipts),
    };
  }

  it('records the queued turn as the next user turn without touching the message cache', () => {
    const { result, getMessages, current } = setup();

    act(() => {
      result.current(
        serverRow({ files: [{ file_id: 'f1' }], quotes: ['why'], manualSkills: ['skill'] }),
        completedEnd(),
      );
    });

    expect(getMessages()).toHaveLength(2);
    expect(current()).toEqual(
      expect.objectContaining({
        clientRequestId: 'client-request-1',
        parentMessageId: RESPONSE_ID,
        queueParentMessageId: 'original-queue-parent',
        queuePredecessorCreatedAt: 41,
        text: 'queued follow-up',
        files: [{ file_id: 'f1' }],
        quotes: ['why'],
        manualSkills: ['skill'],
      }),
    );
  });

  it('reveals once per boundary however often the drain re-observes it', () => {
    const { result, current } = setup();

    act(() => {
      result.current(serverRow(), completedEnd());
    });
    const first = current();
    act(() => {
      result.current(serverRow({ text: 'a later observation' }), completedEnd());
    });

    expect(current()).toBe(first);
  });

  it('refuses a foreign conversation, a row without a request id, and a run without a response', () => {
    const { result, current } = setup();

    act(() => {
      result.current(serverRow(), completedEnd({ conversationId: 'elsewhere' }));
      result.current(serverRow({ clientRequestId: undefined }), completedEnd());
      result.current(serverRow(), completedEnd({ responseMessageId: undefined }));
    });

    expect(current()).toBeNull();
  });

  it('keeps admission guarded when history already has the successor before attachment', () => {
    const { result, current } = setup([...history(), successor()]);

    act(() => {
      result.current(serverRow(), completedEnd());
    });

    expect(current()).not.toBeNull();
  });

  it('keeps admission guarded when history receives the successor before attachment', async () => {
    const { result, setMessages, current } = setup();
    act(() => {
      result.current(serverRow(), completedEnd());
    });
    expect(current()).not.toBeNull();

    act(() => {
      setMessages([...history(), successor('someone-elses-turn')]);
    });

    expect(current()).not.toBeNull();
  });

  it('survives a history refetch that has not yet caught up with the admitted turn', async () => {
    const { result, setMessages, current } = setup();
    act(() => {
      result.current(serverRow(), completedEnd());
    });

    act(() => {
      setMessages(history());
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(current()).not.toBeNull();
  });

  it('ends on a cancelled, dead, or indeterminate receipt for the revealed request', async () => {
    const { result, setReceipts, current } = setup();
    act(() => {
      result.current(serverRow(), completedEnd());
    });

    act(() => {
      setReceipts([receipt({ status: 'dead' })]);
    });

    await waitFor(() => expect(current()).toBeNull());
  });

  it('keeps the reveal through queued, claimed, and admitted receipts', async () => {
    const { result, setReceipts, current } = setup();
    act(() => {
      result.current(serverRow(), completedEnd());
    });

    act(() => {
      setReceipts([receipt({ status: 'admitted' })]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(current()).not.toBeNull();
  });
  it('hands the guard to a newer attached generation, never to the predecessor or a pending attach', () => {
    const { result, attach, current } = setup();
    act(() => {
      result.current(serverRow(), completedEnd());
    });
    act(() => {
      attach(41);
    });
    expect(current()).not.toBeNull();
    act(() => {
      attach(42, false);
    });
    expect(current()).not.toBeNull();
    act(() => {
      attach(42);
    });
    expect(current()).toBeNull();
    act(() => {
      result.current(serverRow(), completedEnd());
    });
    expect(current()).toBeNull();
  });

  it('settles a successor that completed inside the poll gap without trusting old inactive status', () => {
    const { result, queryClient, current } = setup();
    act(() => {
      queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), { active: false, createdAt: 41 });
      result.current(serverRow(), completedEnd());
    });
    expect(current()).not.toBeNull();
    act(() => {
      queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), {
        active: false,
        status: 'complete',
        createdAt: 42,
      });
    });
    expect(current()).toBeNull();
    act(() => {
      result.current(serverRow(), completedEnd());
    });
    expect(current()).toBeNull();
  });

  it('does not resurrect a cancelled head from a stale queue snapshot', () => {
    const { result, setReceipts, current } = setup();
    act(() => {
      setReceipts([receipt({ status: 'cancelled' })]);
    });
    act(() => {
      result.current(serverRow(), completedEnd());
    });
    expect(current()).toBeNull();
    act(() => {
      result.current(serverRow({ clientRequestId: 'next-request' }), completedEnd());
    });
    expect(current()?.clientRequestId).toBe('next-request');
  });

  it('does not register a message fetcher or replace history fetching during invalidation', async () => {
    const { queryClient, getMessages, unmount } = setup();
    const key = [QueryKeys.messages, CONVO_ID];
    const fetchHistory = jest.fn(async () => [...history(), successor()]);
    await queryClient.fetchQuery({ queryKey: key, queryFn: fetchHistory });
    fetchHistory.mockClear();
    await queryClient.invalidateQueries({ queryKey: key, refetchType: 'all' });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(getMessages()).toHaveLength(3);
    expect(queryClient.getQueryCache().find(key)?.getObserversCount()).toBe(0);
    unmount();
  });
  it.each(['queued', 'claimed'] as const)(
    'keeps the handoff through a %s sibling and its admission boundary',
    (status) => {
      const { result, current, queryClient, setReceipts } = setup();
      act(() => {
        result.current(serverRow(), completedEnd());
        setReceipts([
          receipt({ status: 'admitted', effectivePredecessorCreatedAt: 41 }),
          receipt({ clientRequestId: 'second', status, expectedPredecessorCreatedAt: 41 }),
        ]);
        queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), {
          active: false,
          status: 'complete',
          createdAt: 42,
        });
      });
      expect(current()).not.toBeNull();
      act(() => {
        setReceipts([
          receipt({
            clientRequestId: 'second',
            status: 'admitted',
            effectivePredecessorCreatedAt: 42,
          }),
        ]);
      });
      expect(current()).toMatchObject({
        generationCreatedAt: 42,
        queueParentMessageId: 'original-queue-parent',
        queuePredecessorCreatedAt: 41,
      });
      act(() => {
        setReceipts([]);
      });
      expect(current()).not.toBeNull();
      act(() => {
        queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), {
          active: false,
          status: 'complete',
          createdAt: 43,
        });
      });
      expect(current()).toBeNull();
    },
  );
});
