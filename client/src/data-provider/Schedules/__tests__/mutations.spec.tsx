import { createElement } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDeleteScheduleMutation } from '../mutations';

const mockDeleteSchedule = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteSchedule: (...args: unknown[]) => mockDeleteSchedule(...args),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };

describe('useDeleteScheduleMutation', () => {
  it('invalidates the schedules list when deletion returns an error after mutating state', async () => {
    const queryClient = new QueryClient({
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    mockDeleteSchedule.mockRejectedValueOnce(new Error('Could not confirm active run stopped'));
    const { result } = renderHook(() => useDeleteScheduleMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync('schedule-1').catch(() => undefined);
    });

    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.schedules]);
    queryClient.clear();
  });
});
