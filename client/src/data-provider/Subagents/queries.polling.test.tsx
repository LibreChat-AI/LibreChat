import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ParentSubagentIndex } from 'librechat-data-provider';
import { useParentSubagentsQuery } from './queries';

const mockGetParentSubagents = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getParentSubagents: (...args: unknown[]) => mockGetParentSubagents(...args),
    },
  };
});

const index: ParentSubagentIndex = {
  parentConversationId: 'parent',
  children: [],
  childrenTruncated: false,
};

function setup(isSubmitting = false) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useParentSubagentsQuery('parent', undefined, isSubmitting), {
    wrapper,
  });
  return { ...hook, client };
}

describe('parent subagent discovery polling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetParentSubagents.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts at the existing cadence and settles at one read per minute when empty', async () => {
    mockGetParentSubagents.mockResolvedValue(index);
    const { client, unmount } = setup();
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTimeAsync(59_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTimeAsync(1_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(3);
    unmount();
    client.clear();
  });

  it('wakes immediately on child activity and resumes active-child refresh', async () => {
    mockGetParentSubagents
      .mockResolvedValueOnce(index)
      .mockResolvedValueOnce(index)
      .mockResolvedValue({ ...index, children: [{ status: 'running' }] });
    const { client, unmount } = setup();
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(2);

    await act(async () => {
      await client.invalidateQueries([QueryKeys.parentSubagents, 'parent']);
    });
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(3);
    await act(async () => jest.advanceTimersByTimeAsync(2_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(4);
    unmount();
    client.clear();
  });

  it('does not retry or poll a missing parent on an idle tab', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetParentSubagents.mockRejectedValue({ response: { status: 404 } });
    const { client, unmount } = setup();
    await act(async () => jest.advanceTimersByTimeAsync(0));
    await act(async () => jest.advanceTimersByTimeAsync(120_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  });

  it('recovers when an initially missing parent persists during the first run', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetParentSubagents.mockRejectedValueOnce({ response: { status: 404 } });
    mockGetParentSubagents.mockResolvedValue(index);
    const { client, unmount, result } = setup(true);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(2);
    expect(result.current.data?.children).toEqual([]);
    unmount();
    client.clear();
  });

  it('retries a new parent during a running first turn but stops after readiness expires', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetParentSubagents.mockRejectedValue({ response: { status: 404 } });
    const { client, unmount } = setup(true);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    await act(async () => jest.advanceTimersByTimeAsync(10_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTimeAsync(120_000));
    expect(mockGetParentSubagents).toHaveBeenCalledTimes(7);
    unmount();
    client.clear();
  });
});
