/**
 * @jest-environment jsdom
 */
import React from 'react';
import { createStore, Provider } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import {
  useBranchTail,
  useBranchTailId,
  useBranchTailGetter,
  useBranchTailSelect,
} from '../latest';
import { siblingIdxFamily, siblingKey } from '../thread';

const message = (messageId: string, parentMessageId: string): TMessage =>
  ({ messageId, parentMessageId, conversationId: 'c1', text: messageId }) as TMessage;

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const messages = [message('user', NO_PARENT), message('older', 'user'), message('newer', 'user')];

function setup(queryId: string | null = 'c1') {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.messages, 'c1'], messages);
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({ tail: useBranchTail('c1', queryId), id: useBranchTailId('c1', queryId) }),
    { wrapper },
  );
  return { result, store };
}

describe('useBranchTail', () => {
  it('reads the newest sibling by default', () => {
    const { result } = setup();
    expect(result.current.tail?.messageId).toBe('newer');
    expect(result.current.id).toBe('newer');
  });

  it('follows the selected sibling', () => {
    const { result, store } = setup();
    act(() => {
      store.set(siblingIdxFamily(siblingKey('user')), 1);
    });
    expect(result.current.tail?.messageId).toBe('older');
    expect(result.current.id).toBe('older');
  });

  it('reads nothing without a query id', () => {
    const { result } = setup(null);
    expect(result.current.tail).toBeNull();
    expect(result.current.id).toBeNull();
  });
});

/** A streamed delta, as the cache sees it: the tail is a new object with more text. */
const streamInto = (queryClient: QueryClient, text: string) =>
  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, 'c1'], (current = []) =>
    current.map((entry) => (entry.messageId === 'newer' ? { ...entry, text } : entry)),
  );

const pickPlace = (tail: TMessage | null) =>
  tail && { messageId: tail.messageId, parentMessageId: tail.parentMessageId };

function setupReaders() {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.messages, 'c1'], messages);
  const store = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  const renders = { tail: 0, place: 0, getter: 0 };
  const tail = renderHook(
    () => {
      renders.tail += 1;
      return useBranchTail('c1', 'c1');
    },
    { wrapper },
  );
  const place = renderHook(
    () => {
      renders.place += 1;
      return useBranchTailSelect('c1', 'c1', pickPlace);
    },
    { wrapper },
  );
  const getter = renderHook(
    () => {
      renders.getter += 1;
      return useBranchTailGetter('c1', 'c1');
    },
    { wrapper },
  );
  return { queryClient, store, renders, tail, place, getter };
}

describe('readers of the tail while it streams', () => {
  it('renders a reader of the whole tail for a delta, and no one else', async () => {
    const { queryClient, renders, tail, place, getter } = setupReaders();
    const before = { ...renders };
    const placeBefore = place.result.current;
    const getterBefore = getter.result.current;

    act(() => {
      streamInto(queryClient, 'one');
    });
    await waitFor(() => expect(tail.result.current?.text).toBe('one'));
    act(() => {
      streamInto(queryClient, 'one two');
    });
    /** The probe that proves the writes reached their observers: this reader rendered. */
    await waitFor(() => expect(tail.result.current?.text).toBe('one two'));
    expect(renders.tail).toBeGreaterThan(before.tail);

    /** A projection of fields the delta left alone keeps its identity and its reader's render
     *  count; a call-time reader never subscribed. */
    expect(renders.place).toBe(before.place);
    expect(place.result.current).toBe(placeBefore);
    expect(renders.getter).toBe(before.getter);
    expect(getter.result.current).toBe(getterBefore);
  });

  it('reads the streamed tail at call time', () => {
    const { queryClient, getter } = setupReaders();
    expect(getter.result.current()?.text).toBe('newer');

    act(() => {
      streamInto(queryClient, 'one two');
    });

    expect(getter.result.current()?.text).toBe('one two');
  });

  it('follows the selected sibling at call time', () => {
    const { store, getter } = setupReaders();
    act(() => {
      store.set(siblingIdxFamily(siblingKey('user')), 1);
    });
    expect(getter.result.current()?.messageId).toBe('older');
  });

  it('reads nothing at call time without a query id', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useBranchTailGetter('c1', null), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    expect(result.current()).toBeNull();
  });
});
