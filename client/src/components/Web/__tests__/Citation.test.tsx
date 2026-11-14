import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SearchResultData } from 'librechat-data-provider';
import { Citation, CompositeCitation, HighlightedText } from '~/components/Web/Citation';
import { CitationContext } from '~/components/Web/Context';
import { SearchContext } from '~/Providers';

jest.mock('~/hooks', () => ({
  useLocalize:
    () => (key: string, values?: { label?: string; pages?: string; number?: number }) => {
      if (key === 'com_sources_previous') {
        return 'Source précédente';
      }
      if (key === 'com_sources_next') {
        return 'Source suivante';
      }
      if (key === 'com_sources_number') {
        return `Référence ${values?.number}`;
      }
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

  it.each([
    { refType: 'image', collection: 'images', composite: false },
    { refType: 'video', collection: 'videos', composite: false },
    { refType: 'image', collection: 'images', composite: true },
    { refType: 'video', collection: 'videos', composite: true },
  ] as const)(
    'links $refType citations to the source page (composite: $composite)',
    ({ refType, collection, composite }) => {
      const title = `${refType} source`;
      const link = `https://example.com/${refType}`;
      const searchResults: Record<string, SearchResultData> = {
        '0': {
          [collection]: [
            {
              title,
              link,
              imageUrl: 'https://example.com/media.jpg',
            },
          ],
        },
      };
      const citation = { turn: 0, refType, index: 0 };
      const citationId = `cite-${refType}`;

      renderWithProviders(
        composite ? (
          <CompositeCitation node={{ properties: { citationId, citations: [citation] } }} />
        ) : (
          <Citation
            citationId={citationId}
            citationType="standalone"
            node={{ properties: { citationId, citation } }}
          />
        ),
        searchResults,
      );

      expect(screen.getByRole('link', { name: title })).toHaveAttribute('href', link);
    },
  );

  it.each(['file', 'search'] as const)('localizes %s source pagination', async (refType) => {
    const sources = [0, 1].map((index) => ({
      title: `Document ${index}`,
      link: `https://example.com/${index}`,
      ...(refType === 'file' ? { fileId: `file-${index}`, fileName: `Document ${index}` } : {}),
    }));
    renderWithProviders(
      <CompositeCitation
        node={{
          properties: {
            citationId: 'localized-pagination',
            citations: sources.map((_, index) => ({ turn: 0, refType, index })),
          },
        }}
      />,
      { '0': { [refType === 'file' ? 'references' : 'organic']: sources } },
    );

    fireEvent.click(screen.getByRole('button', { name: 'More details about Document 0 +1' }));
    const previous = await screen.findByRole('button', { name: 'Source précédente' });
    const next = screen.getByRole('button', { name: 'Source suivante' });
    expect(previous).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Référence 1' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Référence 2' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    fireEvent.click(previous);
    expect(previous).toBeDisabled();
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
