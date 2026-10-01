import { createElement } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TImportJob } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  fetchImportJob,
  importJobRefetchInterval,
  importJobRefetchOnMount,
  useImportJobQuery,
} from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getImportJob: jest.fn(),
    },
  };
});

function job(phase: TImportJob['phase']): TImportJob {
  return {
    jobId: 'j1',
    filename: 'export.zip',
    phase,
    status: phase === 'completed' ? 'completed' : 'active',
    summary: null,
    progress: {
      conversations: { done: 0, total: 0 },
      messages: { done: 0, total: 0 },
      assets: { done: 0, total: 0 },
    },
    report: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** The axios error shape the panel reads: only a 404 means the job itself is
 * gone, and everything else is a request that failed on the way there. */
const notFound = () => ({ response: { status: 404 } });
const serverError = () => ({ response: { status: 503 } });

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('importJobRefetchInterval', () => {
  it('polls while the import is running', () => {
    expect(importJobRefetchInterval(job('conversations'))).toBe(2000);
    expect(importJobRefetchInterval(job('assets'))).toBe(2000);
  });

  it('polls while the job is queued', () => {
    expect(importJobRefetchInterval(job('queued'))).toBe(2000);
  });

  it('stops on terminal phases', () => {
    expect(importJobRefetchInterval(job('completed'))).toBe(false);
    expect(importJobRefetchInterval(job('failed'))).toBe(false);
    expect(importJobRefetchInterval(job('cancelled'))).toBe(false);
  });

  it('stops while awaiting the user’s confirmation', () => {
    expect(importJobRefetchInterval(job('awaiting_confirmation'))).toBe(false);
  });

  it('polls when there is no data yet', () => {
    expect(importJobRefetchInterval(undefined)).toBe(2000);
  });

  it('stops once the job is gone, so a 404 does not poll forever', () => {
    expect(
      importJobRefetchInterval(undefined, { state: { status: 'error', error: notFound() } }),
    ).toBe(false);
  });

  /** The import runs server-side; a request that failed on the way there says
   * nothing about it. Giving up here would strand the panel on a job it would
   * otherwise have watched finish. */
  it('keeps polling through a transient failure', () => {
    expect(
      importJobRefetchInterval(undefined, { state: { status: 'error', error: serverError() } }),
    ).toBe(2000);
    expect(
      importJobRefetchInterval(undefined, {
        state: { status: 'error', error: new Error('Network Error') },
      }),
    ).toBe(2000);
  });
});

describe('importJobRefetchOnMount', () => {
  it('refreshes a cached confirmation but retains completed-job caching', () => {
    expect(importJobRefetchOnMount({ state: { data: job('awaiting_confirmation') } })).toBe(true);
    expect(importJobRefetchOnMount({ state: { data: job('completed') } })).toBe(false);
  });
});

describe('fetchImportJob', () => {
  it('invalidates the conversation list when the job has just completed', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('completed'));

    const data = await fetchImportJob('job-1', queryClient);

    expect(data.phase).toBe('completed');
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.allConversations]);
  });

  /** Neither is a rollback: a run that throws or is cancelled after a batch
   * flush leaves every conversation up to that flush permanently saved, so the
   * sidebar has to be refreshed even though the import did not succeed. */
  it.each(['failed', 'cancelled'] as const)(
    'invalidates the conversation list for a %s job, which may have written before stopping',
    async (phase) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
        typeof dataService.getImportJob
      >;
      mockGetImportJob.mockResolvedValue(job(phase));

      await fetchImportJob('job-1', queryClient);

      expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.allConversations]);
    },
  );

  it('does not invalidate the conversation list while the job is still running', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;

    mockGetImportJob.mockResolvedValue(job('assets'));
    await fetchImportJob('job-1', queryClient);
    mockGetImportJob.mockResolvedValue(job('awaiting_confirmation'));
    await fetchImportJob('job-1', queryClient);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useImportJobQuery', () => {
  it('refetches a cached confirmation on remount', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.importJob, 'job-1'], job('awaiting_confirmation'));
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('completed'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data?.phase).toBe('completed'));
    expect(mockGetImportJob).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('retains a cached completed job without refetching on remount', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.importJob, 'job-1'], job('completed'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.data?.phase).toBe('completed');
    expect(dataService.getImportJob).not.toHaveBeenCalled();
    unmount();
  });

  it('surfaces the error without retrying when the job is gone', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockRejectedValue(notFound());

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(mockGetImportJob).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('rides out a transient failure instead of declaring the job lost', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockRejectedValueOnce(serverError()).mockResolvedValue(job('conversations'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data?.phase).toBe('conversations');
    });
    expect(result.current.isError).toBe(false);
    expect(mockGetImportJob).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('stays disabled and never calls the API when jobId is null', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useImportJobQuery(null), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(dataService.getImportJob).not.toHaveBeenCalled();
    unmount();
  });

  it('fetches the job by id once enabled', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('conversations'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(job('conversations'));
    });
    expect(mockGetImportJob).toHaveBeenCalledWith('job-1');

    unmount();
  });

  it('invalidates the conversation list once the job reports completed', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('completed'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data?.phase).toBe('completed');
    });
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.allConversations]);

    unmount();
  });

  it('does not invalidate the conversation list while the job is still running', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('assets'));

    const { result, unmount } = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data?.phase).toBe('assets');
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith([QueryKeys.allConversations]);

    unmount();
  });

  it('does not refetch, and so does not re-invalidate, when remounted on an already-cached completed job', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mockGetImportJob = dataService.getImportJob as jest.MockedFunction<
      typeof dataService.getImportJob
    >;
    mockGetImportJob.mockResolvedValue(job('completed'));

    const first = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(first.result.current.data?.phase).toBe('completed');
    });
    first.unmount();

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const second = renderHook(() => useImportJobQuery('job-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(second.result.current.data?.phase).toBe('completed');
    expect(mockGetImportJob).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();

    second.unmount();
  });
});
