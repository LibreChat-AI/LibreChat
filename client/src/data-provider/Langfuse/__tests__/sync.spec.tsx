import { act, renderHook } from '@testing-library/react';
import { QueryKeys, ResourceType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSyncLangfusePromptsMutation } from '../index';

const mockSyncLangfusePrompts = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      syncLangfusePrompts: (...args: unknown[]) => mockSyncLangfusePrompts(...args),
    },
  };
});

describe('useSyncLangfusePromptsMutation', () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  let invalidateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it('invalidates prompt groups, all prompt groups, and prompt-group effective permissions on success', async () => {
    mockSyncLangfusePrompts.mockResolvedValueOnce({ created: 1, unchanged: 2, skipped: 0 });
    const { result } = renderHook(() => useSyncLangfusePromptsMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.promptGroups]);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.allPromptGroups]);
    expect(invalidateSpy).toHaveBeenCalledWith([
      QueryKeys.effectivePermissions,
      'all',
      ResourceType.PROMPTGROUP,
    ]);
  });

  it('invalidates prompt groups, all prompt groups, and prompt-group effective permissions when the sync call fails', async () => {
    // An earlier page's groups can already be committed when a later page throws, so a
    // failed sync still invalidates the catalog's queries, not only a successful one.
    mockSyncLangfusePrompts.mockRejectedValueOnce(new Error('upstream'));
    const { result } = renderHook(() => useSyncLangfusePromptsMutation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.promptGroups]);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.allPromptGroups]);
    expect(invalidateSpy).toHaveBeenCalledWith([
      QueryKeys.effectivePermissions,
      'all',
      ResourceType.PROMPTGROUP,
    ]);
  });

  it('still calls a caller-supplied onError when the sync call fails', async () => {
    mockSyncLangfusePrompts.mockRejectedValueOnce(new Error('upstream'));
    const { result } = renderHook(() => useSyncLangfusePromptsMutation(), { wrapper });
    const onError = jest.fn();

    await act(async () => {
      await result.current.mutateAsync(undefined, { onError }).catch(() => undefined);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith([QueryKeys.promptGroups]);
  });
});
