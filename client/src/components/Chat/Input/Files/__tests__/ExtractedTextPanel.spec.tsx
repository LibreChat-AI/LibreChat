import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TFilePreview } from 'librechat-data-provider';
import ExtractedTextPanel from '../ExtractedTextPanel';

const mockUseFilePreview = jest.fn();

jest.mock('~/data-provider', () => ({
  useFilePreview: (
    fileId: string | undefined,
    config?: Record<string, unknown>,
    shareId?: string,
  ) => mockUseFilePreview(fileId, config, shareId),
}));

jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: jest.fn(() => true),
}));

const mockCopy = jest.requireMock('copy-to-clipboard').default as jest.Mock;

interface PreviewResult {
  data?: TFilePreview;
  isInitialLoading?: boolean;
  isError?: boolean;
}

const setPreview = (result: PreviewResult) =>
  mockUseFilePreview.mockReturnValue({
    isInitialLoading: false,
    isError: false,
    ...result,
  });

const ready = (text?: string): TFilePreview => ({ file_id: 'f1', status: 'ready', text });

describe('ExtractedTextPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setPreview({ data: ready('Line one\nLine two') });
  });

  test('waits on a parse that is still running', () => {
    /* `pending` is not a terminal state: the query polls it every 2.5s, so
     * reporting "no extracted text" here would be wrong the moment it resolves. */
    setPreview({ data: { file_id: 'f1', status: 'pending' } });

    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/No extracted text/i)).not.toBeInTheDocument();
  });

  test('waits while the first fetch is in flight', () => {
    setPreview({ data: undefined, isInitialLoading: true });

    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('tells a failed fetch apart from a document with no text', () => {
    setPreview({ data: undefined, isError: true });

    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByText(/No extracted text/i)).not.toBeInTheDocument();
  });

  test('reports an empty document as having no text', () => {
    setPreview({ data: ready('') });

    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    expect(screen.getByText(/No extracted text/i)).toBeInTheDocument();
  });

  test('the text is a labelled region a keyboard can scroll', () => {
    /* Chrome and Safari do not focus overflow containers on their own, so without
     * a tab stop everything past the panel's max height is unreachable. */
    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    const region = screen.getByRole('region', { name: /extracted text/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent('Line one');
  });

  test('copies through the clipboard fallback rather than the secure-context API', async () => {
    /* `navigator.clipboard` is undefined on plain-HTTP self-hosts, where calling
     * it throws straight out of the click handler. */
    render(<ExtractedTextPanel fileId="f1" enabled={true} />);

    await userEvent.click(screen.getByRole('button'));

    expect(mockCopy).toHaveBeenCalledWith('Line one\nLine two', { format: 'text/plain' });
  });

  test('routes the fetch through the share endpoint and never restales the text', () => {
    render(<ExtractedTextPanel fileId="f1" enabled={true} shareId="share-1" />);

    expect(mockUseFilePreview).toHaveBeenCalledWith(
      'f1',
      expect.objectContaining({ enabled: true, staleTime: Infinity }),
      'share-1',
    );
  });

  test('stays idle without a file', () => {
    render(<ExtractedTextPanel fileId={undefined} enabled={true} />);

    expect(mockUseFilePreview).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
      undefined,
    );
  });
});
