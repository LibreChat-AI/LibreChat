/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment, TFile } from 'librechat-data-provider';
import type { MessagePartsFilePreviewProps } from '../../../react/host';
import type { FilesHost } from '../../../react/files';
import { GeneratedToolLabelContext } from '../../../react/parts/disclosure';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { FilesHostProvider } from '../../../react/files';
import RetrievalCall from '../Retrieval';

const knownFiles: { current: TFile[] } = { current: [] };

const filesHost: FilesHost = {
  renderEndpointIcon: () => null,
  useDeleteFile: () => () => undefined,
  getPreviewUrl: () => undefined,
  useKnownFiles: () => knownFiles.current,
};

const partsHost = createMessagePartsHost({
  renderFilePreview: ({ open, fileId, fileName, fileSource }: MessagePartsFilePreviewProps) =>
    open ? (
      <div data-testid="file-preview-dialog" data-file-id={fileId} data-file-source={fileSource}>
        {fileName}
      </div>
    ) : null,
});

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_searching_files: 'Searching your files',
      com_ui_retrieved_files: 'Searched your files',
      com_ui_retrieval_failed: 'failed',
      com_ui_tool_failed: 'failed',
      com_ui_preview: 'Preview',
      com_ui_relevance: 'Relevance',
      com_file_pages: 'Pages',
    };
    return translations[key] || key;
  },
}));

jest.mock('../useExpandCollapse', () => ({
  __esModule: true,
  ...jest.requireActual('../useExpandCollapse'),
  default: (isExpanded: boolean) => ({
    style: isExpanded
      ? { display: 'grid', gridTemplateRows: '1fr', opacity: 1 }
      : { display: 'grid', gridTemplateRows: '0fr', opacity: 0 },
    ref: { current: null },
  }),
}));

jest.mock('../../../react/parts/useProgress', () => ({
  __esModule: true,
  default: (initialProgress: number) => (initialProgress >= 1 ? 1 : initialProgress),
}));

jest.mock('../ProgressText', () => ({
  __esModule: true,
  default: ({
    onClick,
    inProgressText,
    finishedText,
    icon,
    hasInput,
    isExpanded,
    error,
    errorSuffix,
  }: {
    onClick?: () => void;
    inProgressText: string;
    finishedText: string;
    icon?: React.ReactNode;
    hasInput?: boolean;
    isExpanded?: boolean;
    error?: boolean;
    errorSuffix?: string;
  }) => (
    <div
      onClick={onClick}
      data-testid="progress-text"
      data-in-progress={inProgressText}
      data-finished={finishedText}
      data-has-input={hasInput}
      data-expanded={isExpanded}
      data-error={error}
      data-error-suffix={errorSuffix}
    >
      {icon}
      {finishedText || inProgressText}
    </div>
  ),
}));

jest.mock('../OutputRenderer', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <pre data-testid="output-renderer">{text}</pre>,
}));

const defaultProps = {
  initialProgress: 1,
  isSubmitting: false,
};

const renderRetrievalCall = (
  props: Partial<typeof defaultProps & { output?: string; attachments?: TAttachment[] }> = {},
) =>
  render(
    <MessagePartsHostProvider host={partsHost}>
      <FilesHostProvider host={filesHost}>
        <RetrievalCall {...defaultProps} {...props} />
      </FilesHostProvider>
    </MessagePartsHostProvider>,
  );

beforeEach(() => {
  knownFiles.current = [];
});

describe('RetrievalCall - LGCY-02: Modern visual patterns', () => {
  it('draws the file search icon in the row', () => {
    renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    const row = screen.getByTestId('progress-text');
    expect(row.querySelector('svg.lucide-file-search')).not.toBeNull();
  });

  it('does not render ProgressCircle', () => {
    renderRetrievalCall();

    expect(screen.queryByTestId('progress-circle')).not.toBeInTheDocument();
  });

  it('does not render InProgressCall', () => {
    renderRetrievalCall();

    expect(screen.queryByTestId('in-progress-call')).not.toBeInTheDocument();
  });

  it('does not render RetrievalIcon', () => {
    renderRetrievalCall();

    expect(screen.queryByTestId('retrieval-icon')).not.toBeInTheDocument();
  });
});

describe('RetrievalCall - LGCY-02: Collapsible output panel', () => {
  it('shows collapsible panel when output exists and is clicked', () => {
    renderRetrievalCall({
      output: 'File: notes.txt\nRelevance: 0.8\nContent: file results here',
      initialProgress: 1,
      isSubmitting: false,
    });

    const progressText = screen.getByTestId('progress-text');
    fireEvent.click(progressText);

    expect(screen.getByText('file results here')).toBeInTheDocument();
  });

  it('does not show panel when output is undefined', () => {
    renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    expect(screen.queryByText('file results here')).not.toBeInTheDocument();
  });

  it('does not offer expansion when output has no renderable results', () => {
    renderRetrievalCall({
      output: 'Search completed without matches',
      initialProgress: 1,
      isSubmitting: false,
    });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-has-input', 'false');

    fireEvent.click(progressText);
    expect(progressText).toHaveAttribute('data-expanded', 'false');
  });

  it('offers attachment results even when the tool has no text output', () => {
    renderRetrievalCall({
      initialProgress: 1,
      isSubmitting: false,
      attachments: [
        {
          type: 'file_search',
          toolCallId: 'call-1',
          file_search: {
            sources: [
              {
                fileId: 'file-123',
                fileName: 'notes.txt',
                relevance: 0.8,
                content: 'Attachment result content',
                pages: [],
                pageRelevance: {},
              },
            ],
          },
        },
      ] as unknown as TAttachment[],
    });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-has-input', 'true');

    fireEvent.click(progressText);
    expect(screen.getByText('Attachment result content')).toBeInTheDocument();
  });

  it('does not show panel when output contains error', () => {
    renderRetrievalCall({
      output: 'Error processing tool',
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(screen.queryByText('Error processing tool')).not.toBeInTheDocument();
  });
});

describe('RetrievalCall - LGCY-03: Localization', () => {
  it('uses localized in-progress text', () => {
    renderRetrievalCall({ initialProgress: 0.5, isSubmitting: true });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-in-progress', 'Searching your files');
  });

  it('uses localized finished text', () => {
    renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-finished', 'Searched your files');
  });

  it('does not contain hardcoded "Searching my knowledge" text', () => {
    const { container } = renderRetrievalCall({ initialProgress: 0.5, isSubmitting: true });

    expect(container.textContent).not.toContain('Searching my knowledge');
  });

  it('does not contain hardcoded "Used Retrieval" text', () => {
    const { container } = renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    expect(container.textContent).not.toContain('Used Retrieval');
  });
});

describe('RetrievalCall - A11Y-04: screen reader status announcements', () => {
  it('includes sr-only aria-live region for status announcements', () => {
    renderRetrievalCall({
      initialProgress: 1,
      isSubmitting: false,
      output: 'files found',
    });

    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion!.className).toContain('sr-only');
  });
});

describe('RetrievalCall - file preview resolution', () => {
  it('resolves parsed filenames against known files and opens preview', () => {
    knownFiles.current = [
      {
        file_id: 'file-123',
        filename: 'Tutorial Imazing.pdf',
        bytes: 2048,
        type: 'application/pdf',
        source: 'text',
      } as TFile,
    ];

    renderRetrievalCall({
      initialProgress: 1,
      isSubmitting: false,
      output:
        'File: Tutorial_Imazing.pdf\nRelevance: 0.4442\nContent: Example content from parsed output',
    });

    fireEvent.click(screen.getByTestId('progress-text'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview: Tutorial Imazing.pdf' }));

    expect(screen.getByTestId('file-preview-dialog')).toHaveAttribute('data-file-id', 'file-123');
    expect(screen.getByTestId('file-preview-dialog')).toHaveAttribute('data-file-source', 'text');
  });

  it('keeps multiple parsed results clickable when only one attachment source is available', () => {
    renderRetrievalCall({
      initialProgress: 1,
      isSubmitting: false,
      output:
        'File: Tutorial_Imazing.pdf\nRelevance: 0.4843\nContent: First result\n---\nFile: Tutorial_Imazing.pdf\nRelevance: 0.3751\nContent: Second result',
      attachments: [
        {
          type: 'file_search',
          toolCallId: 'call-1',
          file_search: {
            sources: [
              {
                fileId: 'file-123',
                fileName: 'Tutorial Imazing.pdf',
                relevance: 0.4843,
                content: 'First result',
                pages: [1],
                pageRelevance: { 1: 0.4843 },
                metadata: {
                  fileType: 'application/pdf',
                  fileBytes: 2048,
                },
              },
            ],
          },
        },
      ] as unknown as TAttachment[],
    });

    fireEvent.click(screen.getByTestId('progress-text'));

    expect(screen.getAllByRole('button', { name: 'Preview: Tutorial Imazing.pdf' })).toHaveLength(
      2,
    );
  });
});

it('shows file search results directly beneath a generated single-tool title', () => {
  render(
    <MessagePartsHostProvider host={partsHost}>
      <FilesHostProvider host={filesHost}>
        <GeneratedToolLabelContext.Provider value>
          <RetrievalCall
            initialProgress={1}
            isSubmitting={false}
            output="File: notes.txt\nRelevance: 0.8\nContent: file results here"
          />
        </GeneratedToolLabelContext.Provider>
      </FilesHostProvider>
    </MessagePartsHostProvider>,
  );
  expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
});
