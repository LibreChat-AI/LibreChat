import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LogLink from '../LogLink';

const mockShowToast = jest.fn();
const mockDownloadFromApi = jest.fn();
const mockDownloadFromUrl = jest.fn();
const mockTriggerDownload = jest.fn();
let mockShareContext: { shareId?: string } = {};

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: mockDownloadFromApi }),
  useCodeOutputDownload: () => ({ refetch: mockDownloadFromUrl }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => mockShareContext,
}));

jest.mock('~/utils', () => ({
  getDownloadFilename: (filename: string, fileId?: string, source?: string) => {
    const resolvedFilename = filename || fileId || 'download';
    return source === 'text' && !resolvedFilename.toLowerCase().endsWith('.txt')
      ? `${resolvedFilename}.txt`
      : resolvedFilename;
  },
  isHttpDownloadTarget: (target?: string | null) => /^https?:\/\//i.test(target ?? ''),
  triggerDownload: (...args: Parameters<typeof mockTriggerDownload>) =>
    mockTriggerDownload(...args),
}));

describe('LogLink download routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareContext = {};
  });

  it('navigates directly to http URLs when no stored file metadata is available', async () => {
    const filename = 'report.pptx';
    render(
      <LogLink href="https://cdn.example.com/uploads/report.pptx" filename={filename}>
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'https://cdn.example.com/uploads/report.pptx',
        'report.pptx',
      );
    });
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
  });

  it('reports a thrown fetch to the user instead of failing silently', async () => {
    /* A caller gates its own success feedback on the returned `false`, so
     * this layer owns the visible notification for every failure — the
     * empty-response one and the thrown one alike. Otherwise a network
     * error leaves the press with no feedback at all. */
    const filename = 'file.pdf';
    mockDownloadFromApi.mockRejectedValue(new Error('network down'));

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename={filename}
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'Error downloading file. The file may have been deleted.',
      }),
    );
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('uses the authorized file download route when stored metadata is available', async () => {
    const filename = 'file.pdf';
    mockDownloadFromApi.mockResolvedValue({ data: 'https://cdn.example.com/signed/file.pdf' });

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename={filename}
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'https://cdn.example.com/signed/file.pdf',
        'file.pdf',
      );
    });
    expect(mockDownloadFromApi).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  it('routes downloads through the share-scoped route in a shared view', async () => {
    mockShareContext = { shareId: 'share-9' };
    const filename = 'file.pdf';

    render(
      <LogLink href="/api/share/share-9/files/file-1" file_id="file-1" filename={filename}>
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        '/api/share/share-9/files/file-1/download',
        'file.pdf',
      );
    });
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  it('keeps legacy code-output handles on the blob download path', async () => {
    const filename = 'legacy.txt';
    mockDownloadFromUrl.mockResolvedValue({ data: 'blob:https://app.example.com/file' });

    render(
      <LogLink
        href="/api/files/code/download/session-1/file-1"
        filename={filename}
        source={FileSources.execute_code}
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'blob:https://app.example.com/file',
        'legacy.txt',
      );
    });
    expect(mockDownloadFromUrl).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
  });

  it('uses a text filename for shared text-source downloads', async () => {
    mockShareContext = { shareId: 'share-9' };
    const filename = 'report.pdf';

    render(
      <LogLink
        href="/api/share/share-9/files/file-1"
        file_id="file-1"
        filename={filename}
        source={FileSources.text}
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        '/api/share/share-9/files/file-1/download',
        'report.pdf.txt',
      );
    });
  });

  it('uses the authorized file route and a text filename for owned text-source files', async () => {
    const filename = 'report.pdf';
    mockDownloadFromApi.mockResolvedValue({ data: 'blob:https://app.example.com/text-file' });

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename={filename}
        source={FileSources.text}
        href="mistral_ocr"
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'blob:https://app.example.com/text-file',
        'report.pdf.txt',
      );
    });
    expect(mockDownloadFromApi).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });
});
