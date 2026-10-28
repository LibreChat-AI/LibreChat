import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackgroundTaskIndex } from 'librechat-data-provider';
import { backgroundTasksRefetchInterval, useBackgroundTasksQuery } from './queries';

const mockGetBackgroundTasks = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getBackgroundTasks: (...args: unknown[]) => mockGetBackgroundTasks(...args),
    },
  };
});

const empty: BackgroundTaskIndex = {
  conversationId: 'convo-1',
  tasks: [],
  cancellable: true,
};

const setup = (submitting = false, enabled = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ isSubmitting }) => useBackgroundTasksQuery('convo-1', { enabled }, isSubmitting).data,
    { initialProps: { isSubmitting: submitting }, wrapper },
  );
  return { ...hook, client };
};

describe('background task discovery polling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetBackgroundTasks.mockReset().mockResolvedValue(empty);
  });

  afterEach(() => jest.useRealTimers());

  it('does not fetch disabled conversations, including when their submission ends', async () => {
    const { rerender, client, unmount } = setup(true, false);
    rerender({ isSubmitting: false });
    await act(async () => jest.advanceTimersByTimeAsync(120_000));
    expect(mockGetBackgroundTasks).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it('refetches immediately at submit end and discovers tasks that appear afterward', async () => {
    mockGetBackgroundTasks.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    mockGetBackgroundTasks.mockResolvedValue({
      ...empty,
      tasks: [
        {
          taskId: 'late-task',
          toolName: 'bash_tool',
          toolCallId: 'call-1',
          status: 'running',
          cancellationRequested: false,
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const { rerender, result, client, unmount } = setup(true);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTimeAsync(1_000));
    rerender({ isSubmitting: false });
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTimeAsync(2_000));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(3);
    await waitFor(() =>
      expect(
        client.getQueryData<BackgroundTaskIndex>([QueryKeys.backgroundTasks, 'convo-1'])?.tasks[0]
          ?.taskId,
      ).toBe('late-task'),
    );
    await waitFor(() => expect(result.current?.tasks[0]?.taskId).toBe('late-task'));
    unmount();
    client.clear();
  });

  it('backs off to quiet discovery after the bounded fast discovery window', async () => {
    const { rerender, client, unmount } = setup(true);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    rerender({ isSubmitting: false });
    await act(async () => jest.advanceTimersByTimeAsync(12_000));
    const calls = mockGetBackgroundTasks.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    await act(async () => jest.advanceTimersByTimeAsync(30_000));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(calls);
    await act(async () => jest.advanceTimersByTimeAsync(30_000));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(calls + 1);
    unmount();
    client.clear();
  });

  it('discovers server-started tasks without a browser submission', async () => {
    const { result, client, unmount } = setup();
    await act(async () => jest.advanceTimersByTimeAsync(0));
    mockGetBackgroundTasks.mockResolvedValue({
      ...empty,
      tasks: [{ taskId: 'server-task', toolName: 'bash_tool', status: 'running' }],
    });
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    await waitFor(() => expect(result.current?.tasks[0]?.taskId).toBe('server-task'));
    const calls = mockGetBackgroundTasks.mock.calls.length;
    await act(async () => jest.advanceTimersByTimeAsync(2_000));
    expect(mockGetBackgroundTasks).toHaveBeenCalledTimes(calls + 1);
    unmount();
    client.clear();
  });
});

describe('backgroundTasksRefetchInterval', () => {
  const index = (tasks: BackgroundTaskIndex['tasks']): BackgroundTaskIndex => ({
    conversationId: 'convo-1',
    cancellable: false,
    tasks,
  });
  const task = (extra: Partial<BackgroundTaskIndex['tasks'][number]>) => ({
    taskId: 'task-1',
    toolName: 'bash_tool',
    toolCallId: 'call-1',
    status: 'completed' as const,
    cancellationRequested: false,
    startedAt: '2026-09-25T14:52:02.000Z',
    ...extra,
  });

  it('polls undelivered results slower than running work and faster than idle', () => {
    expect(backgroundTasksRefetchInterval(index([task({ status: 'running' })]))).toBe(2_000);
    expect(backgroundTasksRefetchInterval(index([task({ delivery: 'pending' })]))).toBe(10_000);
    expect(backgroundTasksRefetchInterval(index([task({ delivery: 'pending' })]), true)).toBe(
      5_000,
    );
    expect(backgroundTasksRefetchInterval(index([task({ delivery: 'delivered' })]))).toBe(60_000);
    expect(backgroundTasksRefetchInterval(index([task({ delivery: 'failed' })]))).toBe(60_000);
  });
});
