import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import Attachment from '../Attachment';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
}));

const mockHandleDownload = jest.fn();
// Keep `isLocallyStoredSource`/`isCodeOutputAttachment` real (pure, hook-free
// functions `FileAttachment` needs to decide whether a click can preview);
// only the hook itself is replaced.
jest.mock('../LogLink', () => ({
  ...jest.requireActual('../LogLink'),
  useAttachmentLink: () => ({ handleDownload: mockHandleDownload }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="file-container" onClick={onClick}>
      {file.filename ?? ''}
    </button>
  ),
}));

jest.mock('../../FilePreviewDialog', () => ({
  __esModule: true,
  default: ({ open, fileName }: { open: boolean; fileName: string }) =>
    open ? <div data-testid="preview-dialog">{fileName}</div> : null,
}));

// `type` is nominally `Tools` on `TAttachment`, but the render path reads it
// as a MIME string (see `detectArtifactTypeFromFile`/`getPreviewKind`), so
// fixtures assert the mime value through `as unknown` like the sibling
// `attachmentTypes.test.ts` fixtures do.
const attachment = (overrides: Record<string, unknown> = {}): TAttachment =>
  ({
    filename: 'report.pdf',
    filepath: '/uploads/report.pdf',
    ...overrides,
  }) as unknown as TAttachment;

// A persisted code-output: the backend committed it to storage, so it has a
// real `file_id` + storage `source` like any other uploaded file.
const persistedAttachment = (overrides: Record<string, unknown> = {}) =>
  attachment({
    file_id: 'file-1',
    type: 'application/pdf',
    source: FileSources.local,
    ...overrides,
  });

// A download-fallback code-output (oversized, or no storage strategy
// configured): no `file_id`, `source`, or `type` — only filename + a
// session-scoped `filepath`. See `createDownloadFallback` in
// `packages/api/src/files/code/process.ts`.
const fallbackAttachment = (overrides: Record<string, unknown> = {}) =>
  attachment({
    filepath: '/api/files/code/download/session-1/output-1',
    ...overrides,
  });

describe('FileAttachment preview routing', () => {
  beforeEach(() => {
    mockHandleDownload.mockReset();
  });

  it('opens the preview dialog for a persisted PDF instead of downloading', () => {
    render(<Attachment attachment={persistedAttachment()} />);
    fireEvent.click(screen.getByTestId('file-container'));
    expect(screen.getByTestId('preview-dialog')).toHaveTextContent('report.pdf');
    expect(mockHandleDownload).not.toHaveBeenCalled();
  });

  it('opens the preview dialog for a download-fallback PDF with no file_id/source', () => {
    render(<Attachment attachment={fallbackAttachment()} />);
    fireEvent.click(screen.getByTestId('file-container'));
    expect(screen.getByTestId('preview-dialog')).toHaveTextContent('report.pdf');
    expect(mockHandleDownload).not.toHaveBeenCalled();
  });

  it('falls back to downloading a non-previewable download-fallback file', () => {
    render(
      <Attachment
        attachment={fallbackAttachment({
          filename: 'archive.zip',
          filepath: '/api/files/code/download/session-1/output-2',
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('file-container'));
    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('preview-dialog')).not.toBeInTheDocument();
  });
});
