import { renderHook } from '@testing-library/react';
import { EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { appFilesHost } from '../FilesHostContext';
import { logger } from '~/utils';

const mockDeleteFile = jest.fn();
const mockUseFileDeletion = jest.fn((_args: unknown) => ({ deleteFile: mockDeleteFile }));
const mockMutateAsync = jest.fn();
let mutationOptions: {
  onMutate: () => Promise<void>;
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: (options: typeof mutationOptions) => {
    mutationOptions = options;
    return { mutateAsync: mockMutateAsync };
  },
}));

jest.mock('~/hooks/Files', () => ({
  useFileDeletion: (args: unknown) => mockUseFileDeletion(args),
}));

jest.mock('~/components/Endpoints', () => ({
  MinimalIcon: () => null,
}));

const scope = {
  agent_id: 'agent-1',
  assistant_id: 'asst-1',
  tool_resource: EToolResources.file_search,
  index: 1,
};

describe('appFilesHost.useDeleteFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes through useFileDeletion with the mutation and the scope', () => {
    const { result } = renderHook(() => appFilesHost.useDeleteFile(scope));

    expect(mockUseFileDeletion).toHaveBeenCalledWith({ mutateAsync: mockMutateAsync, ...scope });
    expect(result.current).toBe(mockDeleteFile);
  });

  it('logs the scope when the deletion starts', async () => {
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    renderHook(() => appFilesHost.useDeleteFile(scope));

    await mutationOptions.onMutate();

    expect(logSpy).toHaveBeenCalledWith(
      'agents',
      'Deleting files: agent_id, assistant_id, tool_resource',
      'agent-1',
      'asst-1',
      EToolResources.file_search,
    );
    logSpy.mockRestore();
  });

  it('reports success and failure to the console', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    renderHook(() => appFilesHost.useDeleteFile(scope));
    const error = new Error('nope');

    mutationOptions.onSuccess();
    mutationOptions.onError(error);

    expect(consoleSpy).toHaveBeenCalledWith('Files deleted');
    expect(consoleSpy).toHaveBeenCalledWith('Error deleting files:', error);
    consoleSpy.mockRestore();
  });
});

describe('appFilesHost.getPreviewUrl', () => {
  it('reads nothing for a file with no cached preview', () => {
    const file: Pick<ExtendedFile, 'file_id'> = { file_id: 'unknown-file' };

    expect(appFilesHost.getPreviewUrl(file.file_id)).toBeUndefined();
  });
});
