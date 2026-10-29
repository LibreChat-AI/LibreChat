import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import DownloadFile from '../DownloadFile';

jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useFileDownload: jest.fn(),
}));

jest.mock('~/utils', () => ({
  triggerDownload: jest.fn(),
  getDownloadFilename: jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  TooltipAnchor: ({ children, render }: any) => render ?? children,
  Spinner: () => <span data-testid="download-spinner" />,
  useToastContext: jest.fn(),
}));

const mockUseAuthContext = jest.requireMock('~/hooks').useAuthContext;
const mockUseFileDownload = jest.requireMock('~/data-provider').useFileDownload;
const mockTriggerDownload = jest.requireMock('~/utils').triggerDownload;
const mockGetDownloadFilename = jest.requireMock('~/utils').getDownloadFilename;
const mockUseToastContext = jest.requireMock('@librechat/client').useToastContext;
const mockRefetch = jest.fn();
const mockShowToast = jest.fn();

const file = {
  file_id: 'file-123',
  filename: 'report.pdf',
  filepath: '/uploads/user-123/report.pdf',
  source: FileSources.local,
  type: 'application/pdf',
  bytes: 1024,
} as TFile;

const getDownloadButton = () => screen.getByRole('button', { name: 'com_ui_download report.pdf' });

describe('DownloadFile', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-123' } });
    mockUseFileDownload.mockReturnValue({ refetch: mockRefetch, isFetching: false });
    mockRefetch.mockResolvedValue({ data: 'blob:download-url', isError: false });
    mockGetDownloadFilename.mockReturnValue('report.pdf');
    mockUseToastContext.mockReturnValue({ showToast: mockShowToast });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('waits for an explicit click before requesting a download', () => {
    render(<DownloadFile file={file} />);

    expect(getDownloadButton()).toBeEnabled();
    expect(mockUseFileDownload).toHaveBeenCalledWith('user-123', 'file-123', {
      source: FileSources.local,
    });
    expect(mockRefetch).not.toHaveBeenCalled();
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('downloads the fetched URL using the source-aware filename', async () => {
    render(<DownloadFile file={file} />);

    await userEvent.click(getDownloadButton());

    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockGetDownloadFilename).toHaveBeenCalledWith(
      'report.pdf',
      'file-123',
      FileSources.local,
    );
    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:download-url', 'report.pdf');
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('keeps the button disabled and shows progress until the request finishes', async () => {
    let resolveDownload!: (value: { data: string; isError: boolean }) => void;
    mockRefetch.mockReturnValue(
      new Promise((resolve) => {
        resolveDownload = resolve;
      }),
    );
    render(<DownloadFile file={file} />);

    await userEvent.click(getDownloadButton());

    expect(getDownloadButton()).toBeDisabled();
    expect(getDownloadButton()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('download-spinner')).toBeInTheDocument();
    await userEvent.click(getDownloadButton());
    expect(mockRefetch).toHaveBeenCalledTimes(1);

    await act(async () => resolveDownload({ data: 'blob:download-url', isError: false }));

    expect(getDownloadButton()).toBeEnabled();
    expect(screen.queryByTestId('download-spinner')).not.toBeInTheDocument();
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['query error', { data: 'blob:stale-url', isError: true }],
    ['missing URL', { data: undefined, isError: false }],
  ])('reports a localized error for a %s and supports retry', async (_name, result) => {
    mockRefetch.mockResolvedValueOnce(result);
    render(<DownloadFile file={file} />);

    await userEvent.click(getDownloadButton());

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_download_error', status: 'error' }),
    );
    expect(mockTriggerDownload).not.toHaveBeenCalled();
    expect(getDownloadButton()).toBeEnabled();

    await userEvent.click(getDownloadButton());

    expect(mockRefetch).toHaveBeenCalledTimes(2);
    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:download-url', 'report.pdf');
  });

  it('handles a rejected download request and releases the pending state', async () => {
    mockRefetch.mockRejectedValueOnce(new Error('Download unavailable'));
    render(<DownloadFile file={file} />);

    await userEvent.click(getDownloadButton());

    await waitFor(() => expect(getDownloadButton()).toBeEnabled());
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_download_error', status: 'error' }),
    );
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('handles browser download failures with a localized error', async () => {
    mockTriggerDownload.mockImplementationOnce(() => {
      throw new Error('Download blocked');
    });
    render(<DownloadFile file={file} />);

    await userEvent.click(getDownloadButton());

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_download_error', status: 'error' }),
    );
    expect(getDownloadButton()).toBeEnabled();
  });

  it('does not activate the containing file preview', async () => {
    const onPreview = jest.fn();
    render(
      <div onClick={onPreview}>
        <DownloadFile file={file} />
      </div>,
    );

    await userEvent.click(getDownloadButton());

    expect(onPreview).not.toHaveBeenCalled();
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('disables downloads when no authenticated user is available', async () => {
    mockUseAuthContext.mockReturnValue({ user: undefined });
    render(<DownloadFile file={file} />);

    expect(getDownloadButton()).toBeDisabled();
    await userEvent.click(getDownloadButton());

    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('disables downloads when the file has no identifier', async () => {
    render(<DownloadFile file={{ ...file, file_id: '' }} />);

    expect(getDownloadButton()).toBeDisabled();
    await userEvent.click(getDownloadButton());

    expect(mockRefetch).not.toHaveBeenCalled();
  });
});
