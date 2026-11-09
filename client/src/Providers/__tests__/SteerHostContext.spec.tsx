import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { StreamStatusResponse } from '@librechat/chat';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import { streamStatusQueryKey } from '~/data-provider/SSE/queries';
import { appSteerHost } from '../SteerHostContext';

const CONVO_ID = 'convo-cache';

const receipt = { clientRequestId: 'request-1', status: 'queued' } as TAgentQueuedTurnReceipt;
const status: StreamStatusResponse = { active: false, status: 'complete', createdAt: 10 };

function renderCache(queryClient: QueryClient, conversationId = CONVO_ID) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ id }) => appSteerHost.useQueuedTurnCache(id), {
    wrapper,
    initialProps: { id: conversationId },
  });
}

describe('appSteerHost.useQueuedTurnCache', () => {
  it('reads the receipts and stream status cached for the conversation', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(agentQueuedTurnsQueryKey(CONVO_ID), [receipt]);
    queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), status);
    queryClient.setQueryData(streamStatusQueryKey('other'), { active: true });

    const { result } = renderCache(queryClient);

    expect(result.current.read()).toEqual({ receipts: [receipt], status });
  });

  it('reads nothing for a conversation the caches do not hold', () => {
    const { result } = renderCache(new QueryClient());
    expect(result.current.read()).toEqual({ receipts: undefined, status: undefined });
  });

  it('notifies only for the receipts and status of its own conversation', () => {
    const queryClient = new QueryClient();
    const { result } = renderCache(queryClient);
    const notify = jest.fn();
    const unsubscribe = result.current.subscribe(notify);

    act(() => {
      queryClient.setQueryData(['messages', CONVO_ID], []);
      queryClient.setQueryData(agentQueuedTurnsQueryKey('other'), [receipt]);
    });
    expect(notify).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData(agentQueuedTurnsQueryKey(CONVO_ID), [receipt]);
    });
    const afterReceipts = notify.mock.calls.length;
    expect(afterReceipts).toBeGreaterThan(0);

    act(() => {
      queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), status);
    });
    expect(notify.mock.calls.length).toBeGreaterThan(afterReceipts);

    unsubscribe();
    const settled = notify.mock.calls.length;
    act(() => {
      queryClient.setQueryData(streamStatusQueryKey(CONVO_ID), { ...status, createdAt: 20 });
    });
    expect(notify).toHaveBeenCalledTimes(settled);
  });

  it('keeps its functions while the conversation does, and replaces them when it changes', () => {
    const { result, rerender } = renderCache(new QueryClient());
    const first = result.current;

    rerender({ id: CONVO_ID });
    expect(result.current.read).toBe(first.read);
    expect(result.current.subscribe).toBe(first.subscribe);

    rerender({ id: 'other' });
    expect(result.current.subscribe).not.toBe(first.subscribe);
  });
});
