import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { EToolResources, FileSources } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ExtendedFile } from '~/common';
import { appFilesHost } from '../FilesHostContext';

const mockDeleteFiles = jest.fn();

/** The HTTP boundary: the one service call the deletion mutation makes. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteFiles: (...args: unknown[]) => mockDeleteFiles(...args),
    },
  };
});

jest.mock('~/components/Endpoints', () => ({
  MinimalIcon: () => null,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

const scope = {
  agent_id: 'agent-1',
  assistant_id: 'asst-1',
  tool_resource: EToolResources.file_search,
  index: 1,
};

const staged = (file_id: string): ExtendedFile =>
  ({
    file_id,
    temp_file_id: '',
    filepath: `/uploads/${file_id}`,
    source: FileSources.local,
    embedded: true,
    progress: 1,
  }) as ExtendedFile;

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <RecoilRoot>{children}</RecoilRoot>
    </QueryClientProvider>
  );
}

/** The app host runs its real deletion hooks; only the HTTP call is replaced. */
describe('appFilesHost.useDeleteFile', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDeleteFiles.mockReset().mockResolvedValue({ message: 'ok' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the unlink to the server with the row scope and drops the file from the staged map', async () => {
    const setFiles = jest.fn();
    const { result } = renderHook(() => appFilesHost.useDeleteFile(scope), { wrapper });

    act(() => {
      result.current({ file: staged('file-1'), setFiles });
    });
    await act(async () => {
      jest.advanceTimersByTime(1100);
    });

    const update = setFiles.mock.calls[0][0] as (
      files: Map<string, ExtendedFile>,
    ) => Map<string, ExtendedFile>;
    expect([...update(new Map([['file-1', staged('file-1')]])).keys()]).toEqual([]);
    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);
    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'file-1',
          embedded: true,
          filepath: '/uploads/file-1',
          source: FileSources.local,
        },
      ],
      agent_id: 'agent-1',
      assistant_id: 'asst-1',
      tool_resource: EToolResources.file_search,
    });
  });

  it('batches files removed together into one request', async () => {
    const { result } = renderHook(() => appFilesHost.useDeleteFile({}), { wrapper });

    act(() => {
      result.current({ file: staged('file-a'), setFiles: jest.fn() });
      result.current({ file: staged('file-b'), setFiles: jest.fn() });
    });
    await act(async () => {
      jest.advanceTimersByTime(1100);
    });

    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);
    const [payload] = mockDeleteFiles.mock.calls[0] as [{ files: { file_id: string }[] }];
    expect(payload.files.map((file) => file.file_id)).toEqual(['file-a', 'file-b']);
  });

  it('does not call the server for a file whose upload is still in progress', async () => {
    const setFiles = jest.fn();
    const { result } = renderHook(() => appFilesHost.useDeleteFile({}), { wrapper });

    act(() => {
      result.current({ file: { ...staged('file-1'), progress: 0.4 }, setFiles });
    });
    await act(async () => {
      jest.advanceTimersByTime(1100);
    });

    expect(setFiles).not.toHaveBeenCalled();
    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });
});

describe('appFilesHost.getPreviewUrl', () => {
  it('reads nothing for a file with no cached preview', () => {
    expect(appFilesHost.getPreviewUrl('unknown-file')).toBeUndefined();
  });
});
