import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import FileGrid from '../Files';

const file = (over: Partial<TFile> & Pick<TFile, 'file_id' | 'filename'>): TFile =>
  ({
    bytes: 2048,
    type: 'text/plain',
    filepath: `/uploads/${over.filename}`,
    source: 'local',
    createdAt: '2026-09-27T10:00:00.000Z',
    ...over,
  }) as TFile;

let mockFiles: TFile[] | undefined = [];
let mockQueryState = { isLoading: false, isError: false };
const mockRefetch = jest.fn();
const mockFetchPreview = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetFiles: () => ({ data: mockFiles, refetch: mockRefetch, ...mockQueryState }),
  useFilePreviewBlob: () => ({ refetch: mockFetchPreview }),
  useFilePreview: () => ({ refetch: jest.fn() }),
  useFileDownload: () => ({ refetch: jest.fn() }),
  useSharedFileDownload: () => ({ refetch: jest.fn() }),
}));

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) =>
    options ? `${key}:${options['0']}` : key,
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

const renderGrid = (props: Partial<React.ComponentProps<typeof FileGrid>> = {}) => {
  const onAttach = jest.fn();
  render(
    <RecoilRoot>
      <FileGrid query="" view="all" onAttach={onAttach} {...props} />
    </RecoilRoot>,
  );
  return { onAttach };
};

describe('FileGrid', () => {
  beforeEach(() => {
    mockFetchPreview.mockReset().mockResolvedValue({ data: undefined });
    mockQueryState = { isLoading: false, isError: false };
    mockFiles = [
      file({ file_id: 'img', filename: 'photo.png', type: 'image/png' }),
      file({ file_id: 'pdf', filename: 'report.pdf', type: 'application/pdf' }),
      file({ file_id: 'txt', filename: 'notes.txt' }),
    ];
  });

  it('shows every file as a card with its kind and size', () => {
    renderGrid();
    const cards = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards[1]).toHaveTextContent('report.pdf');
    expect(cards[1]).toHaveTextContent('PDF · 2.0 KB');
  });

  it('offers a preview for images and PDFs only', () => {
    renderGrid();
    expect(
      screen.getByRole('button', { name: 'com_ui_composer_preview_file:photo.png' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_composer_preview_file:report.pdf' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_composer_preview_file:notes.txt' }),
    ).not.toBeInTheDocument();
  });

  it('filters by kind and by name', () => {
    renderGrid({ view: 'images' });
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('keeps audio and video out of the documents view', () => {
    mockFiles = [
      ...(mockFiles ?? []),
      file({ file_id: 'mp3', filename: 'memo.mp3', type: 'audio/mpeg' }),
      file({ file_id: 'mp4', filename: 'clip.mp4', type: 'video/mp4' }),
    ];
    renderGrid({ view: 'documents' });
    const list = within(screen.getByRole('list'));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.queryByText('memo.mp3')).not.toBeInTheDocument();
    expect(list.queryByText('clip.mp4')).not.toBeInTheDocument();
  });

  it('matches a search against the file name', () => {
    renderGrid({ query: 'repo' });
    const cards = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('report.pdf');
  });

  it('says so when nothing matches', () => {
    renderGrid({ query: 'nothing-here' });
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_composer_no_results');
  });

  it('shows loading rather than no matches while the files are fetched', () => {
    mockFiles = undefined;
    mockQueryState = { isLoading: true, isError: false };
    renderGrid();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
    expect(screen.queryByText('com_ui_composer_no_results')).not.toBeInTheDocument();
  });

  it('reports a failed fetch rather than an empty list', () => {
    mockFiles = undefined;
    mockQueryState = { isLoading: false, isError: true };
    renderGrid();
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_error_connection');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('stays on the grid when an image has nothing to preview', async () => {
    mockFiles = [file({ file_id: 'bare', filename: 'bare.png', type: 'image/png', filepath: '' })];
    renderGrid();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_composer_preview_file:bare.png' }));
    await waitFor(() => expect(mockFetchPreview).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'com_ui_composer_preview_failed:bare.png',
          status: 'error',
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'com_ui_composer_preview_file:bare.png' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('attaches a file when its card is chosen, not when it is previewed', () => {
    const { onAttach } = renderGrid();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_composer_preview_file:photo.png' }));
    expect(onAttach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('notes.txt'));
    expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ file_id: 'txt' }));
  });
});
