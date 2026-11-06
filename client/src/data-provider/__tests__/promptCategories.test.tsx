import { RecoilRoot } from 'recoil';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDeletePrompt, useDeletePromptGroup } from '../prompts';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deletePrompt: jest.fn(),
      deletePromptGroup: jest.fn(),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </RecoilRoot>
    );
  };

describe('prompt category refresh on delete', () => {
  let queryClient: QueryClient;
  let invalidate: jest.SpyInstance;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  });

  it('invalidates categories after deleting a prompt group', async () => {
    jest.mocked(dataService.deletePromptGroup).mockResolvedValue({ message: 'deleted' });
    const { result } = renderHook(() => useDeletePromptGroup(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ id: 'g1' });
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith([QueryKeys.categories]));
  });

  it('invalidates categories when deleting the last prompt removes its group', async () => {
    jest.mocked(dataService.deletePrompt).mockResolvedValue({
      prompt: 'p1',
      promptGroup: { id: 'g1', message: 'deleted' },
    });
    const { result } = renderHook(() => useDeletePrompt(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ _id: 'p1', groupId: 'g1' });
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith([QueryKeys.categories]));
  });

  it('leaves categories alone when only a non-final prompt is deleted', async () => {
    jest.mocked(dataService.deletePrompt).mockResolvedValue({ prompt: 'p1' });
    const { result } = renderHook(() => useDeletePrompt(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ _id: 'p1', groupId: 'g1' });
    });

    expect(invalidate).not.toHaveBeenCalledWith([QueryKeys.categories]);
  });
});
