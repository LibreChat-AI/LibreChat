import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SearchResultData } from 'librechat-data-provider';
import { Citation, CompositeCitation, HighlightedText } from '~/components/Web/Citation';
import { CitationContext } from '~/components/Web/Context';
import { SearchContext } from '~/Providers';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { label?: string; pages?: string }) => {
    if (key === 'com_citation_source') {
      return 'Source';
    }
    if (key === 'com_citation_more_details') {
      return `More details about ${values?.label ?? ''}`;
    }
    if (key === 'com_ui_relevance') {
      return 'Relevance';
    }
    if (key === 'com_file_pages') {
      return `Pages: ${values?.pages ?? ''}`;
    }
    if (key === 'com_file_source') {
      return 'File source';
    }
    return key;
  },
}));

jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () => ({
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

jest.mock('@librechat/client', () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

function renderWithProviders(
  children: React.ReactNode,
  searchResults: Record<string, SearchResultData>,
) {
  return render(
    <SearchContext.Provider value={{ searchResults }}>
      <CitationContext.Provider
        value={{
          hoveredCitationId: null,
          setHoveredCitationId: jest.fn(),
        }}
      >
        {children}
      </CitationContext.Provider>
    </SearchContext.Provider>,
  );
}

describe('Citation', () => {
  it('uses the semantic active surface for a highlighted passage', () => {
    const highlightedPassage = 'Highlighted passage';
    render(
      <CitationContext.Provider
        value={{ hoveredCitationId: 'cite-highlight', setHoveredCitationId: jest.fn() }}
      >
        <HighlightedText citationId="cite-highlight">{highlightedPassage}</HighlightedText>
      </CitationContext.Provider>,
    );

    expect(screen.getByText(highlightedPassage)).toHaveClass('bg-surface-active');
  });

  it('renders composite file citations as buttons and opens the preview dialog', () => {
    const searchResults = {
      '0': {
        references: [
          {
            attribution: 'Tutorial Imazing.pdf',
            fileId: 'file-123',
            fileName: 'Tutorial Imazing.pdf',
            link: '#file-123',
            metadata: {
              fileBytes: 2048,
              fileType: 'application/pdf',
              storageType: 'text',
            },
            pageRelevance: { 1: 0.92 },
            pages: [1],
            relevance: 0.92,
            title: 'Tutorial Imazing.pdf',
            type: 'file',
          },
        ],
      },
    };

    renderWithProviders(
      <CompositeCitation
        node={{
          properties: {
            citationId: 'cite-1',
            citations: [{ turn: 0, refType: 'file', index: 0 }],
          },
        }}
      />,
      searchResults as any,
    );

    const fileButton = screen.getByRole('button', { name: 'Tutorial Imazing.pdf' });

    expect(fileButton).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tutorial Imazing.pdf' })).not.toBeInTheDocument();

    fireEvent.click(fileButton);

    expect(screen.getByTestId('file-preview-dialog')).toHaveAttribute('data-file-id', 'file-123');
    expect(screen.getByTestId('file-preview-dialog')).toHaveAttribute('data-file-source', 'text');
  });

  it('keeps standalone web citations as links', () => {
    const searchResults = {
      '0': {
        organic: [
          {
            attribution: 'example.com',
            link: 'https://example.com',
            snippet: 'Example snippet',
            title: 'Example',
          },
        ],
      },
    };

    renderWithProviders(
      <Citation
        citationId="cite-2"
        citationType="standalone"
        node={{
          properties: {
            citation: { turn: 0, refType: 'search', index: 0 },
            citationId: 'cite-2',
          },
        }}
      />,
      searchResults as any,
    );

    expect(screen.getByRole('link', { name: 'example.com' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
  });
});
