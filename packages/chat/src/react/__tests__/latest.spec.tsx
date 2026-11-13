/**
 * @jest-environment jsdom
 */
import React from 'react';
import { createStore, Provider } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { useBranchTail, useBranchTailId } from '../latest';
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
