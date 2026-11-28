import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useDeleteFilesFromTable from '../useDeleteFilesFromTable';

const mockDelete = jest.fn();
const mockClearRecovery = jest.fn();
jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: mockDelete }),
}));
jest.mock('../useFileHandling', () => ({
  clearUploadRecovery: (id: string) => mockClearRecovery(id),
}));

const files = ['failed', 'deleted'].map((file_id) => ({ file_id }) as TFile);

function setup() {
  const client = new QueryClient();
  const refresh = jest.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(useDeleteFilesFromTable, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { result, refresh };
}

describe('useDeleteFilesFromTable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps failed files available for retry and clears only confirmed attachment state', async () => {
    mockDelete.mockResolvedValue({ failedFileIds: ['failed'], deletedFileIds: ['deleted'] });
    const { result, refresh } = setup();
    await act(async () => {
      expect(await result.current.deleteFiles(files)).toEqual(new Set(['failed']));
    });
    expect(mockClearRecovery.mock.calls).toEqual([['deleted']]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes an ambiguous failure and preserves attachment state', async () => {
    mockDelete.mockRejectedValue(new Error('Connection lost'));
    const { result, refresh } = setup();
    await act(async () => {
      expect(await result.current.deleteFiles(files)).toEqual(new Set(['failed', 'deleted']));
    });
    expect(mockClearRecovery).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
