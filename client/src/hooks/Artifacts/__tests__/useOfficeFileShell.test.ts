import { renderHook, waitFor } from '@testing-library/react';
import {
  fillOfficeFileShell,
  OFFICE_DOC_DATA_SLOT,
  OFFICE_FILE_SHELL_MARKER,
} from 'librechat-data-provider';
import type { Artifact } from '~/common';
import useOfficeFileShell from '../useOfficeFileShell';

const mockRefetch = jest.fn();
const mockUseFilePreviewBlob = jest.fn((..._args: (string | undefined)[]) => ({
  refetch: mockRefetch,
}));
let mockShareId: string | undefined;

jest.mock('~/data-provider', () => ({
  useFilePreviewBlob: (...args: (string | undefined)[]) => mockUseFilePreviewBlob(...args),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: mockShareId }),
}));

const shell = `<html><head>${OFFICE_FILE_SHELL_MARKER}</head><body>${OFFICE_DOC_DATA_SLOT}</body></html>`;

const shellArtifact: Artifact = {
  id: 'a1',
  lastUpdateTime: 1,
  content: shell,
  download: { file_id: 'file-1', user: 'user-1' },
};

describe('useOfficeFileShell', () => {
  beforeEach(() => {
    mockRefetch.mockReset();
    mockUseFilePreviewBlob.mockClear();
    mockShareId = undefined;
  });

  it('fills the shell with the fetched bytes as base64 after loading', async () => {
    mockRefetch.mockResolvedValue({ data: new Blob(['ABC']) });
    const { result } = renderHook(() => useOfficeFileShell(shellArtifact));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toBe(fillOfficeFileShell(shell, 'QUJD'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockUseFilePreviewBlob).toHaveBeenCalledWith('user-1', 'file-1', undefined);
  });

  it('passes the share id so shared viewers use the share-scoped route', async () => {
    mockShareId = 'share-9';
    mockRefetch.mockResolvedValue({ data: new Blob(['ABC']) });
    const { result } = renderHook(() => useOfficeFileShell(shellArtifact));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockUseFilePreviewBlob).toHaveBeenCalledWith('user-1', 'file-1', 'share-9');
  });

  it('keeps the stored shell when the fetch fails', async () => {
    mockRefetch.mockResolvedValue({ data: undefined, error: new Error('nope') });
    const { result } = renderHook(() => useOfficeFileShell(shellArtifact));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toBe(shell);
  });

  it('keeps the stored shell when the fetch rejects', async () => {
    mockRefetch.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useOfficeFileShell(shellArtifact));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toBe(shell);
  });

  it('reports loading for a second artifact with an identical shell', async () => {
    mockRefetch.mockResolvedValueOnce({ data: new Blob(['ABC']) });
    const { result, rerender } = renderHook(({ artifact }) => useOfficeFileShell(artifact), {
      initialProps: { artifact: shellArtifact },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const filledA = fillOfficeFileShell(shell, 'QUJD');
    expect(result.current.content).toBe(filledA);

    mockRefetch.mockReturnValueOnce(new Promise(() => undefined));
    const other: Artifact = {
      ...shellArtifact,
      id: 'a2',
      download: { file_id: 'file-2', user: 'user-1' },
    };
    rerender({ artifact: other });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.content).toBe(shell);
  });

  it('does not fetch for a non-shell artifact', () => {
    const plain: Artifact = { ...shellArtifact, content: '<html>inline</html>' };
    const { result } = renderHook(() => useOfficeFileShell(plain));
    expect(result.current).toEqual({ content: '<html>inline</html>', isLoading: false });
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('does not fetch for a null artifact', () => {
    const { result } = renderHook(() => useOfficeFileShell(null));
    expect(result.current).toEqual({ content: undefined, isLoading: false });
    expect(mockRefetch).not.toHaveBeenCalled();
  });
});
