import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import RetrievalCall from '../RetrievalCall';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_searching_files: 'Searching files...',
      com_ui_retrieved_files: 'Retrieved files',
      com_ui_retrieval_failed: 'failed',
      com_ui_tool_failed: 'failed',
      com_ui_preview: 'Preview',
      com_ui_relevance: 'Relevance',
      com_file_pages: 'Pages',
    };
    return translations[key] || key;
  },
  useProgress: (initialProgress: number) => (initialProgress >= 1 ? 1 : initialProgress),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: isExpanded
      ? { display: 'grid', gridTemplateRows: '1fr', opacity: 1 }
      : { display: 'grid', gridTemplateRows: '0fr', opacity: 0 },
    ref: { current: null },
  }),
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

jest.mock('../ToolOutput', () => ({
  ToolIcon: ({ type, isAnimating }: { type: string; isAnimating?: boolean }) => (
    <span data-testid="tool-icon" data-type={type} data-animating={isAnimating} />
  ),
  OutputRenderer: ({ text }: { text: string }) => <pre data-testid="output-renderer">{text}</pre>,
  isError: (output: string) => typeof output === 'string' && output.toLowerCase().includes('error'),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' '),
  sortPagesByRelevance: (pages: number[]) => pages,
  logger: { error: jest.fn(), debug: jest.fn() },
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.fn(() => ({ data: [] })),
}));

jest.mock('../FilePreviewDialog', () => ({
  __esModule: true,
  default: ({
    open,
    fileId,
    fileName,
    fileSource,
  }: {
    open: boolean;
    fileId?: string;
    fileName: string;
    fileSource?: string;
  }) =>
    open ? (
      <div data-testid="file-preview-dialog" data-file-id={fileId} data-file-source={fileSource}>
        {fileName}
      </div>
    ) : null,
}));

const defaultProps = {
  initialProgress: 1,
  isSubmitting: false,
};

const renderRetrievalCall = (
  props: Partial<typeof defaultProps & { output?: string; attachments?: TAttachment[] }> = {},
) =>
  render(
    <RecoilRoot>
      <RetrievalCall {...defaultProps} {...props} />
    </RecoilRoot>,
  );

const mockedUseGetFiles = jest.requireMock('~/data-provider').useGetFiles as jest.Mock;

beforeEach(() => {
  mockedUseGetFiles.mockReturnValue({ data: [] });
});

describe('RetrievalCall - LGCY-02: Modern visual patterns', () => {
  it('renders ToolIcon with type="file_search"', () => {
    renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    const icon = screen.getByTestId('tool-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-type', 'file_search');
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
      output: 'error processing tool',
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(screen.queryByText('error processing tool')).not.toBeInTheDocument();
  });
});

describe('RetrievalCall - LGCY-03: Localization', () => {
  it('uses localized in-progress text', () => {
    renderRetrievalCall({ initialProgress: 0.5, isSubmitting: true });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-in-progress', 'Searching files...');
  });

  it('uses localized finished text', () => {
    renderRetrievalCall({ initialProgress: 1, isSubmitting: false });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveAttribute('data-finished', 'Retrieved files');
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
    mockedUseGetFiles.mockReturnValue({
      data: [
        {
          file_id: 'file-123',
          filename: 'Tutorial Imazing.pdf',
          bytes: 2048,
          type: 'application/pdf',
          source: 'text',
        },
      ],
    });

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
      ] as any,
    });

    fireEvent.click(screen.getByTestId('progress-text'));

    expect(screen.getAllByRole('button', { name: 'Preview: Tutorial Imazing.pdf' })).toHaveLength(
      2,
    );
  });
});
