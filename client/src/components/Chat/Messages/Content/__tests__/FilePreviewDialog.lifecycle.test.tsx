import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFilePreview } from 'librechat-data-provider';
import FilePreviewDialog from '../FilePreviewDialog';

let mockFileMap: Record<string, { llmDeliveryPath: 'text' }> = {};
let mockShareId: string | undefined;
let mockPreview: TFilePreview | undefined;
let mockPreviewError = false;
const mockOwnedPreview = jest.fn();
const mockSharedPreview = jest.fn();
const mockDownload = jest.fn();
const mockRetry = jest.fn();
const mockRevoke = jest.fn();
const mockTriggerDownload = jest.fn();
const mockUseFilePreview = jest.fn();

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  CopyButton: () => null,
}));

jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'owner' }) }));
jest.mock('~/store', () => ({ user: {} }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: mockShareId }),
  useFileMapContext: () => mockFileMap,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  getDownloadFilename: (name: string) => name,
  logger: { error: jest.fn() },
  sortPagesByRelevance: () => [],
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
}));
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => {
    mockUseFilePreview(...args);
    return {
      data: mockPreview,
      isInitialLoading: !mockPreview && !mockPreviewError,
      isFetching: false,
      isError: mockPreviewError,
      refetch: mockRetry,
    };
  },
  useFileDownload: (_user: string, _file: string, options: { purpose?: string }) => ({
    refetch: options.purpose === 'preview' ? mockOwnedPreview : mockDownload,
  }),
  useFilePreviewBlob: (_user: string, _file: string, shareId?: string) => ({
    refetch: shareId ? mockSharedPreview : mockOwnedPreview,
  }),
  useSharedFileDownload: (_share: string, _file: string, purpose?: string) => ({
    refetch: purpose === 'preview' ? mockSharedPreview : mockDownload,
  }),
  revokeDownloadURL: (url: string) => mockRevoke(url),
}));
jest.mock('@librechat/client', () => ({
  OGDialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  OGDialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  OGDialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  OGDialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
    <button onClick={onClick}>{children}</button>
  ),
  Radio: jest.requireActual('@librechat/client').Radio,
  Shimmer: jest.requireActual('@librechat/client').Shimmer,
}));

const pdf = () => new Blob(['%PDF-1.7\n%original bytes']);

/** jsdom's Blob has no `text()`; browsers do, and the PDF signature check reads it. */
const hasBlobText = typeof Blob.prototype.text === 'function';
if (!hasBlobText) {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

const props = {
  open: true,
  onOpenChange: jest.fn(),
  fileId: 'f1',
  fileName: 'report.pdf',
  fileType: 'application/pdf',
};

describe('FilePreviewDialog lifecycle', () => {
  it('renders an ordinary PDF and revokes its display URL on close', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoke = jest.fn();
    URL.createObjectURL = jest.fn(() => 'blob:display');
    URL.revokeObjectURL = revoke;
    try {
      mockOwnedPreview.mockResolvedValue({ data: pdf() });
      const view = render(<FilePreviewDialog {...props} />);
      await waitFor(() =>
        expect(screen.getByTitle('com_ui_preview: report.pdf')).toHaveAttribute(
          'src',
          'blob:display',
        ),
      );
      expect(screen.queryByRole('radiogroup')).toBeNull();
      view.unmount();
      expect(revoke).toHaveBeenCalledWith('blob:display');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  const { createObjectURL, revokeObjectURL } = URL;
  afterAll(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    URL.createObjectURL = jest.fn(() => 'blob:display');
    URL.revokeObjectURL = jest.fn();
    mockFileMap = {};
    mockShareId = undefined;
    mockPreview = { file_id: 'f1', status: 'ready', text: 'extracted document' };
    mockPreviewError = false;
    mockOwnedPreview.mockResolvedValue({});
    mockSharedPreview.mockResolvedValue({});
    mockDownload.mockResolvedValue({ data: 'blob:original' });
  });

  it('opens a text-delivered PDF on its original and switches to the extracted text', async () => {
    mockOwnedPreview.mockResolvedValue({ data: pdf() });
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(await screen.findByTitle('com_ui_preview: report.pdf')).toHaveAttribute(
      'src',
      'blob:display',
    );
    expect(screen.queryByText('extracted document')).toBeNull();
    expect(mockUseFilePreview).toHaveBeenLastCalledWith('f1', { enabled: false }, undefined);
    expect(screen.getByRole('radio', { name: 'com_ui_preview_original' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_preview_extracted_text' }));
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(screen.queryByTitle('com_ui_preview: report.pdf')).toBeNull();
    expect(mockUseFilePreview).toHaveBeenLastCalledWith('f1', { enabled: true }, undefined);

    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_preview_original' }));
    expect(screen.getByTitle('com_ui_preview: report.pdf')).toBeInTheDocument();
    // Switching views reuses the loaded original instead of fetching it again.
    expect(mockOwnedPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download_original report.pdf' }));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original', 'report.pdf'),
    );
  });

  it('reopens on the original after the extracted text was chosen', async () => {
    mockOwnedPreview.mockResolvedValue({ data: pdf() });
    const view = render(<FilePreviewDialog {...props} deliveryPath="text" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'com_ui_preview_extracted_text' }));
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" open={false} />);
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(await screen.findByTitle('com_ui_preview: report.pdf')).toBeInTheDocument();
    expect(screen.queryByText('extracted document')).toBeNull();
  });

  it.each([
    ['is missing', () => mockOwnedPreview.mockRejectedValue(new Error('404'))],
    ['returns no bytes', () => mockOwnedPreview.mockResolvedValue({})],
    [
      'is not a PDF',
      () => mockOwnedPreview.mockResolvedValue({ data: new Blob(['plain extracted text']) }),
    ],
  ])('falls back to the extracted text when the original %s', async (_case, arrange) => {
    arrange();
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(await screen.findByText('extracted document')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByTitle('com_ui_preview: report.pdf')).toBeNull();
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_download report.pdf' })).toBeInTheDocument();
  });

  it('shows only the extracted text when no original is stored', () => {
    render(<FilePreviewDialog {...props} fileSource="text" deliveryPath="text" />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(mockOwnedPreview).not.toHaveBeenCalled();
  });

  it('keeps non-PDF text-delivered documents on the extracted text', async () => {
    const docx = {
      ...props,
      fileName: 'report.docx',
      fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    render(<FilePreviewDialog {...docx} deliveryPath="text" />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download report.docx' }));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original', 'report.docx'),
    );
  });

  it('handles pending, polling failure, retry, and empty success', () => {
    mockPreview = { file_id: 'f1', status: 'pending' };
    const textOnly = { ...props, fileSource: 'text', deliveryPath: 'text' as const };
    const view = render(<FilePreviewDialog {...textOnly} />);
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    mockPreviewError = true;
    view.rerender(<FilePreviewDialog {...textOnly} />);
    expect(screen.queryByText('com_ui_loading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    mockPreviewError = false;
    mockPreview = { file_id: 'f1', status: 'ready', text: '' };
    view.rerender(<FilePreviewDialog {...textOnly} />);
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('recovers late metadata while open and discards the obsolete text response', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const textProps = { ...props, fileName: 'notes.txt', fileType: 'text/plain' };
    const view = render(<FilePreviewDialog {...textProps} />);
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    view.rerender(<FilePreviewDialog {...textProps} />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    await act(async () => {
      resolve({ data: { text: async () => 'obsolete bytes' } as Blob });
    });
    expect(screen.queryByText('obsolete bytes')).toBeNull();
    expect(screen.getByText('extracted document')).toBeInTheDocument();
  });

  it('keeps loading a PDF original when late metadata routes it to text', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<FilePreviewDialog {...props} />);
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    view.rerender(<FilePreviewDialog {...props} />);
    await act(async () => {
      resolve({ data: pdf() });
    });
    expect(await screen.findByTitle('com_ui_preview: report.pdf')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(mockOwnedPreview).toHaveBeenCalledTimes(1);
  });

  it('handles a deduplicated response after closing and reopening', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const textProps = { ...props, fileName: 'notes.txt', fileType: 'text/plain' };
    const view = render(<FilePreviewDialog {...textProps} />);
    view.rerender(<FilePreviewDialog {...textProps} open={false} />);
    view.rerender(<FilePreviewDialog {...textProps} />);
    expect(mockOwnedPreview).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ data: { text: async () => 'shared bytes' } as Blob });
    });
    expect(screen.getByText('shared bytes')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('uses only shared metadata and the shared authorization scope', async () => {
    mockShareId = 'public-share';
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    mockSharedPreview.mockResolvedValue({ data: pdf() });
    const view = render(<FilePreviewDialog {...props} />);
    expect(await screen.findByTitle('com_ui_preview: report.pdf')).toBeInTheDocument();
    expect(mockSharedPreview).toHaveBeenCalledTimes(1);
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_preview_extracted_text' }));
    expect(mockUseFilePreview).toHaveBeenLastCalledWith('f1', { enabled: true }, 'public-share');
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(mockOwnedPreview).not.toHaveBeenCalled();
  });
});
