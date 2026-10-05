import React from 'react';
import { SSE } from 'sse.js';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMediaEvents } from '../events';

jest.mock('sse.js', () => ({ SSE: jest.fn() }));

test('connecting catches up the current owner and denial closes without retries', async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const close = jest.fn();
  jest.mocked(SSE).mockImplementation(
    () =>
      ({
        close,
        addEventListener: (name: string, callback: (event: unknown) => void) =>
          handlers.set(name, callback),
      }) as unknown as SSE,
  );
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  let active = true;
  const host = {
    scope: 'tenant-owner',
    pollIntervalMs: 100,
    catchUpIntervalMs: 1000,
    isCurrentSession: () => active,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  jest.useFakeTimers();
  const hook = renderHook(({ enabled }) => useMediaEvents(host, 'test-token', enabled), {
    wrapper,
    initialProps: { enabled: false },
  });
  expect(SSE).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  await act(async () => handlers.get('message')?.({ data: JSON.stringify({ ready: true }) }));
  for (const key of [
    QueryKeys.mediaThreads,
    QueryKeys.mediaThread,
    QueryKeys.mediaTurns,
    QueryKeys.mediaTurnJobs,
    QueryKeys.mediaJobOutputs,
  ]) {
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: [key, host.scope] },
      { cancelRefetch: false },
    );
  }
  invalidate.mockClear();
  await act(async () =>
    handlers.get('message')?.({
      data: JSON.stringify({ event: 'media_update', data: { threadId: 'thread', version: 2 } }),
    }),
  );
  expect(invalidate).toHaveBeenCalledWith(
    { queryKey: [QueryKeys.mediaThread, host.scope, 'thread'] },
    { cancelRefetch: false },
  );
  invalidate.mockClear();
  active = false;
  await act(async () => handlers.get('message')?.({ data: JSON.stringify({ ready: true }) }));
  expect(invalidate).not.toHaveBeenCalled();
  await act(async () => {
    handlers.get('error')?.({ responseCode: 403 });
    jest.advanceTimersByTime(10000);
  });
  expect(SSE).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  hook.unmount();
  client.clear();
  jest.useRealTimers();
});

test('reconnects after the server ends the stream cleanly', async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const close = jest.fn();
  jest.mocked(SSE).mockReset();
  jest.mocked(SSE).mockImplementation(
    () =>
      ({
        close,
        addEventListener: (name: string, callback: (event: unknown) => void) =>
          handlers.set(name, callback),
      }) as unknown as SSE,
  );
  const client = new QueryClient();
  const host = {
    scope: 'owner',
    pollIntervalMs: 100,
    catchUpIntervalMs: 1000,
    isCurrentSession: () => true,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  jest.useFakeTimers();
  const hook = renderHook(() => useMediaEvents(host, 'test-token', true), { wrapper });
  expect(SSE).toHaveBeenCalledTimes(1);
  await act(async () => {
    handlers.get('readystatechange')?.({ readyState: 1 });
    jest.advanceTimersByTime(1000);
  });
  expect(SSE).toHaveBeenCalledTimes(1);
  await act(async () => {
    handlers.get('readystatechange')?.({ readyState: 2 });
    jest.advanceTimersByTime(100);
  });
  expect(SSE).toHaveBeenCalledTimes(2);
  hook.unmount();
  client.clear();
  jest.useRealTimers();
});
