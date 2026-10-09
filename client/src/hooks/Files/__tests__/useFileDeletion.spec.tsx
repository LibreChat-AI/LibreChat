import React, { useState } from 'react';
import { FileSources, EToolResources } from 'librechat-data-provider';
import { render, screen, act, renderHook } from '@testing-library/react';
import type { ExtendedFile } from '~/common';
import {
  clearRetainedFileDeletion,
  collectLiveAttachmentIds,
  publishTabAttachmentIds,
  takeRetainedFileDeletions,
} from '~/utils';
import FileRow from '~/components/Chat/Input/Files/FileRow';
import useFileDeletion from '../useFileDeletion';

const mockMutateAsync = jest.fn();

jest.mock('../useFileHandling', () => ({
  clearUploadRecovery: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: mockMutateAsync }),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn() },
  getCachedPreview: () => undefined,
  deletePreview: jest.fn(),
}));

jest.mock('../useSetFilesToDelete', () => ({
  __esModule: true,
  default: () => jest.fn(),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => {
  return function MockFileContainer({
    file,
    onDelete,
  }: {
    file: ExtendedFile;
    onDelete: () => void;
  }) {
    return <button data-testid={`del-${file.file_id}`} onClick={onDelete} />;
  };
});

jest.mock('~/components/Chat/Input/Files/Image', () => {
  return function MockImage() {
    return null;
  };
});

const mockClearUploadRecovery = jest.requireMock('../useFileHandling').clearUploadRecovery;

/** Mirrors the shape `utils/forms.tsx` builds for agent Context/File Search panels */
const makeFile = (file_id: string): ExtendedFile =>
  ({
    file_id,
    type: 'application/pdf',
    filepath: `/uploads/${file_id}.pdf`,
    filename: `${file_id}.pdf`,
    size: 1024,
    progress: 1,
    source: FileSources.local,
  }) as ExtendedFile;

/** Mirrors FileContext.tsx, which mounts FileRow only while `fileCount > 0` */
function ConditionalPanel({ initial }: { initial: ExtendedFile[] }) {
  const [files, setFiles] = useState(new Map(initial.map((f) => [f.file_id, f])));
  return (
    <>
      {files.size > 0 && (
        <FileRow
          files={files}
          setFiles={setFiles}
          agent_id="agent-123"
          tool_resource={EToolResources.context}
        />
      )}
    </>
  );
}

describe('useFileDeletion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockClear();
    /** react-query's `mutateAsync` always hands back a promise, and the hook reads the response
     * to find out what the server could not delete. */
    mockMutateAsync.mockResolvedValue({ message: 'ok', deletedFileIds: [], failedFileIds: [] });
    mockClearUploadRecovery.mockClear();
    for (const retained of takeRetainedFileDeletions()) {
      clearRetainedFileDeletion(retained.file_id);
    }
  });
  afterEach(() => jest.useRealTimers());

  const clickDelete = (file_id: string) => {
    act(() => {
      screen.getByTestId(`del-${file_id}`).click();
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
  };

  it('sends the unlink request when removing the last file from an agent panel', () => {
    render(<ConditionalPanel initial={[makeFile('only-file')]} />);

    clickDelete('only-file');

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith({
      files: [expect.objectContaining({ file_id: 'only-file' })],
      agent_id: 'agent-123',
      tool_resource: EToolResources.context,
    });
  });

  it('sends the unlink request when removing a non-last file from an agent panel', () => {
    render(<ConditionalPanel initial={[makeFile('file-a'), makeFile('file-b')]} />);

    clickDelete('file-a');

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: 'agent-123', tool_resource: EToolResources.context }),
    );
  });

  it('retains a deletion the request never completed', async () => {
    /** The chip is gone by the time this runs, so nothing else remembers the upload exists. */
    mockMutateAsync.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useFileDeletion({ mutateAsync: mockMutateAsync }));

    act(() => {
      result.current.deleteFile({ file: makeFile('lost-file') });
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    await act(async () => {});

    expect(takeRetainedFileDeletions()).toEqual([
      expect.objectContaining({ file_id: 'lost-file' }),
    ]);
  });

  it('does not queue a failed agent unlink for the generic delete retry', async () => {
    /** The retry sends files alone, so replaying an unlink through it would hit the ordinary
     * delete branch and destroy a record the agent and other references still point at. */
    mockMutateAsync.mockRejectedValueOnce(new Error('offline'));
    render(<ConditionalPanel initial={[makeFile('agent-file')]} />);

    clickDelete('agent-file');
    await act(async () => {});

    expect(takeRetainedFileDeletions()).toEqual([]);
  });

  it('retains only the ids the server reported as failed', async () => {
    mockMutateAsync.mockResolvedValue({
      message: 'Some files could not be deleted',
      deletedFileIds: ['file-a'],
      failedFileIds: ['file-b'],
    });
    const { result } = renderHook(() => useFileDeletion({ mutateAsync: mockMutateAsync }));

    act(() => {
      result.current.deleteFiles({ files: [makeFile('file-a'), makeFile('file-b')] });
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    await act(async () => {});

    expect(takeRetainedFileDeletions()).toEqual([expect.objectContaining({ file_id: 'file-b' })]);
  });

  it('does not delete a file that was attached from existing storage', () => {
    const { result } = renderHook(() => useFileDeletion({ mutateAsync: mockMutateAsync }));

    act(() => {
      result.current.deleteFile({
        file: { ...makeFile('stored-file'), attached: true } as ExtendedFile,
      });
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('clears upload recovery before returning for a pending attachment', () => {
    const { result } = renderHook(() => useFileDeletion({ mutateAsync: mockMutateAsync }));

    act(() => {
      result.current.deleteFile({
        file: { ...makeFile('pending-file'), progress: 0.5 },
      });
    });

    expect(mockClearUploadRecovery).toHaveBeenCalledWith('pending-file');
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps a sibling pane's published claim when pane 0 removes its chip", () => {
    publishTabAttachmentIds(0, ['shared-file']);
    publishTabAttachmentIds(1, ['shared-file']);
    const { result } = renderHook(() =>
      useFileDeletion({ mutateAsync: mockMutateAsync, index: 0 }),
    );

    act(() => {
      result.current.deleteFile({ file: makeFile('shared-file') });
    });

    expect(collectLiveAttachmentIds().has('shared-file')).toBe(true);
  });

  it("keeps a sibling pane's published claim when pane 0 removes a batch", () => {
    publishTabAttachmentIds(0, ['batch-shared-file']);
    publishTabAttachmentIds(1, ['batch-shared-file']);
    const { result } = renderHook(() =>
      useFileDeletion({ mutateAsync: mockMutateAsync, index: 0 }),
    );

    act(() => {
      result.current.deleteFiles({ files: [makeFile('batch-shared-file')] });
    });

    expect(collectLiveAttachmentIds().has('batch-shared-file')).toBe(true);
  });
});
