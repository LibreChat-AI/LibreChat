import { renderHook } from '@testing-library/react';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  BatchFile,
  DeleteFilesBody,
  DeleteFilesResponse,
  DeleteMutationOptions,
  TFile,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';

const mockUseDeleteFilesMutation = jest.fn();
const mockDeleteFiles = jest.fn();

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: (options: DeleteMutationOptions) => {
    mockUseDeleteFilesMutation(options);
    return { mutateAsync: jest.fn() };
  },
}));

jest.mock('../useFileDeletion', () => ({
  __esModule: true,
  default: () => ({ deleteFiles: mockDeleteFiles }),
}));

import useDeleteFilesFromTable from '../useDeleteFilesFromTable';

const makeFile = (file_id: string): TFile => ({ file_id }) as TFile;
const makeBatchFile = (file_id: string): BatchFile =>
  ({
    file_id,
    filepath: `/uploads/${file_id}`,
    embedded: false,
    source: 'local',
  }) as BatchFile;

const wrapper =
  (queryClient: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

describe('useDeleteFilesFromTable', () => {
  beforeEach(() => {
    mockUseDeleteFilesMutation.mockClear();
    mockDeleteFiles.mockClear();
  });

  it('keeps files reported as failed in the cached table list', async () => {
    const queryClient = new QueryClient();
    const failedFile = makeFile('failed-file');
    const deletedFile = makeFile('deleted-file');
    queryClient.setQueryData<TFile[]>([QueryKeys.files], [failedFile, deletedFile]);

    renderHook(() => useDeleteFilesFromTable(), { wrapper: wrapper(queryClient) });

    const options = mockUseDeleteFilesMutation.mock.calls[0][0] as DeleteMutationOptions;
    const variables: DeleteFilesBody = {
      files: [makeBatchFile('failed-file'), makeBatchFile('deleted-file')],
    };
    const context = await options.onMutate?.(variables);
    const result: DeleteFilesResponse = {
      message: 'Some files could not be deleted',
      failedFileIds: ['failed-file'],
      deletedFileIds: ['deleted-file'],
    };

    options.onSuccess?.(result, variables, context);

    expect(queryClient.getQueryData<TFile[]>([QueryKeys.files])).toEqual([failedFile]);
  });
});
