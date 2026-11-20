/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment, TFile } from 'librechat-data-provider';
import type { MessagePartsFilePreviewProps } from '../../../react/host';
import type { RetrievalCallProps } from '../Retrieval';
import type { FilesHost } from '../../../react/files';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { FilesHostProvider } from '../../../react/files';
import RetrievalCall from '../Retrieval';

const TRANSLATIONS: Record<string, string> = {
  com_ui_preview: 'Preview',
  com_ui_relevance: 'Relevance',
  com_file_pages: 'Pages: {{pages}}',
  com_ui_retrieved_files: 'Searched your files',
  com_ui_searching_files: 'Searching your files',
};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      TRANSLATIONS[key] ?? key,
    ),
}));

const EXCERPT = 'Revenue grew twelve percent.';
const OUTPUT = ['File: quarterly-report.pdf', 'Relevance: 0.92', `Content: ${EXCERPT}`].join('\n');

const attachments = [
  {
    type: 'file_search',
    toolCallId: 'tool-1',
    file_search: {
      sources: [
        {
          fileId: 'file-1',
          fileName: 'quarterly-report.pdf',
          relevance: 0.92,
          content: EXCERPT,
          pages: [2, 5],
          pageRelevance: { 2: 0.92, 5: 0.71 },
          metadata: { fileType: 'application/pdf', storageType: 'local' },
        },
      ],
    },
  },
] as unknown as TAttachment[];

const baseHost: FilesHost = {
  renderEndpointIcon: () => null,
  useDeleteFile: () => () => undefined,
  getPreviewUrl: () => undefined,
};

type Options = {
  files?: FilesHost;
  onPreview?: (props: MessagePartsFilePreviewProps) => void;
  props?: Partial<RetrievalCallProps>;
};

function renderRetrieval({ files, onPreview, props }: Options = {}) {
  const host = createMessagePartsHost({
    renderFilePreview: (preview) => {
      onPreview?.(preview);
      return null;
    },
  });
  const row = (
    <MessagePartsHostProvider host={host}>
      <RetrievalCall
        initialProgress={1}
        isSubmitting={false}
        output={OUTPUT}
        attachments={attachments}
        renderProgress={(progress) => (
          <button
            type="button"
            aria-expanded={progress.isExpanded}
            disabled={progress.onClick == null}
            onClick={progress.onClick}
          >
            {progress.finishedText}
          </button>
        )}
        renderOutput={(text) => <p>{text}</p>}
        renderIcon={() => null}
        {...props}
      />
    </MessagePartsHostProvider>
  );
  if (files == null) {
    return render(row);
  }
  return render(<FilesHostProvider host={files}>{row}</FilesHostProvider>);
}

describe('RetrievalCall', () => {
  it('lists the matched files from the attachment sources once opened', () => {
    renderRetrieval();

    const toggle = screen.getByRole('button', { name: 'Searched your files' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Preview: quarterly-report.pdf' })).toBeVisible();
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText(EXCERPT)).toBeInTheDocument();
  });

  it('hands the host the file and its relevance to preview', () => {
    const previews: MessagePartsFilePreviewProps[] = [];
    renderRetrieval({ onPreview: (preview) => previews.push(preview) });

    fireEvent.click(screen.getByRole('button', { name: 'Searched your files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview: quarterly-report.pdf' }));

    expect(previews[previews.length - 1]).toMatchObject({
      open: true,
      fileId: 'file-1',
      fileName: 'quarterly-report.pdf',
      relevance: 0.92,
      fileType: 'application/pdf',
      fileSource: 'local',
    });
  });

  it('keeps the pages and page relevance of a result that has no output text', () => {
    const previews: MessagePartsFilePreviewProps[] = [];
    renderRetrieval({
      onPreview: (preview) => previews.push(preview),
      props: { output: undefined },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Searched your files' }));
    expect(screen.getByText('Pages: 2, 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview: quarterly-report.pdf' }));

    expect(previews[previews.length - 1]).toMatchObject({
      open: true,
      pages: [2, 5],
      pageRelevance: { 2: 0.92, 5: 0.71 },
    });
  });

  it('matches parsed names to the files the host knows', () => {
    const previews: MessagePartsFilePreviewProps[] = [];
    const known = [
      { file_id: 'file-9', filename: 'Notes.pdf', type: 'application/pdf', source: 'local' },
    ] as TFile[];
    renderRetrieval({
      files: { ...baseHost, useKnownFiles: () => known },
      onPreview: (preview) => previews.push(preview),
      props: {
        attachments: undefined,
        output: ['File: Notes.pdf', 'Relevance: 0.5', 'Content: A note.'].join('\n'),
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Searched your files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview: Notes.pdf' }));

    expect(previews[previews.length - 1]).toMatchObject({
      open: true,
      fileId: 'file-9',
      fileName: 'Notes.pdf',
    });
  });

  it('leaves a parsed name unmatched, and unclickable, without a files host', () => {
    renderRetrieval({
      props: {
        attachments: undefined,
        output: ['File: Notes.pdf', 'Relevance: 0.5', 'Content: A note.'].join('\n'),
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Searched your files' }));

    expect(screen.getByText('Notes.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Preview/ })).not.toBeInTheDocument();
  });

  it('offers nothing to open for a search that failed', () => {
    renderRetrieval({ props: { output: 'Error processing tool: the index is unavailable' } });

    expect(screen.getByRole('button', { name: 'Searched your files' })).toBeDisabled();
    expect(screen.queryByText(EXCERPT)).not.toBeInTheDocument();
  });
});
