import { memo, useState, useContext, useCallback } from 'react';
import { Button } from '@librechat/client';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import type { SourceData } from '~/components/Web/SourceHovercard';
import type { CitationProps } from './types';
import { SourceHovercard, FaviconImage, getCleanDomain } from '~/components/Web/SourceHovercard';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { CitationContext, useCitation, useCompositeCitations } from './Context';
import { useLocalize } from '~/hooks';

interface FileCitationMetadata {
  fileBytes?: number;
  fileType?: string;
  storageType?: string;
}

interface FileCitationSource {
  attribution?: string;
  fileId?: string;
  fileName?: string;
  link?: string;
  metadata?: FileCitationMetadata;
  pageRelevance?: Record<number, number>;
  pages?: number[];
  refType?: string;
  relevance?: number;
  snippet?: string;
  title?: string;
}

function getFileCitationData(source?: FileCitationSource) {
  const isFileType = source?.refType === 'file' && source.fileId != null;

  return {
    isFileType,
    fileId: isFileType ? source.fileId : undefined,
    fileMeta: isFileType ? source.metadata : undefined,
    fileName: isFileType ? source.fileName : undefined,
    filePages: isFileType ? source.pages : undefined,
    fileRelevance: isFileType ? source.relevance : undefined,
    filePageRelevance: isFileType ? source.pageRelevance : undefined,
  };
}

function toSourceData(source: FileCitationSource): SourceData {
  return {
    link: source.link ?? '',
    title: source.title,
    attribution: source.attribution,
    snippet: source.snippet,
  };
}

interface CompositeCitationProps {
  citationId?: string;
  node?: {
    properties?: CitationProps;
  };
}

export function CompositeCitation(props: CompositeCitationProps) {
  const localize = useLocalize();
  const { citations, citationId } = props.node?.properties ?? ({} as CitationProps);
  const { setHoveredCitationId } = useContext(CitationContext);
  const [currentPage, setCurrentPage] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const sources = useCompositeCitations(citations || []);

  if (!sources || sources.length === 0) {
    return null;
  }
  const totalPages = sources.length;

  const getCitationLabel = () => {
    if (!sources || sources.length === 0) {
      return localize('com_citation_source');
    }

    const firstSource = sources[0] as FileCitationSource;
    const remainingCount = sources.length - 1;
    const attribution =
      firstSource.attribution ||
      firstSource.title ||
      getCleanDomain(firstSource.link || '') ||
      localize('com_citation_source');

    return remainingCount > 0 ? `${attribution} +${remainingCount}` : attribution;
  };

  const handlePrevPage = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleNextPage = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentPage < totalPages - 1) {
      setCurrentPage(currentPage + 1);
    }
  };

  const currentSource = sources[currentPage] as FileCitationSource;
  const { isFileType, fileId, fileMeta, fileName, filePages, fileRelevance, filePageRelevance } =
    getFileCitationData(currentSource);

  const handleFileClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isFileType && fileId) {
      setShowPreview(true);
    }
  };

  return (
    <>
      <SourceHovercard
        source={toSourceData(currentSource)}
        label={getCitationLabel()}
        onMouseEnter={() => setHoveredCitationId(citationId || null)}
        onMouseLeave={() => setHoveredCitationId(null)}
        onClick={isFileType ? handleFileClick : undefined}
        isFile={isFileType}
        filePages={filePages}
        fileRelevance={fileRelevance}
      >
        {isFileType ? (
          <>
            <div className="flex items-center gap-2">
              <FileText className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <button
                onClick={handleFileClick}
                className="min-w-0 truncate text-sm font-medium text-text-primary hover:underline"
              >
                {fileName || currentSource.title || localize('com_file_source')}
              </button>
            </div>
            {(fileRelevance != null || (filePages && filePages.length > 0)) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                {fileRelevance != null && fileRelevance > 0 && (
                  <span className="text-xs text-text-secondary">
                    {localize('com_ui_relevance')}: {Math.round(fileRelevance * 100)}%
                  </span>
                )}
                {filePages && filePages.length > 0 && (
                  <span className="text-xs text-text-secondary">
                    {localize('com_file_pages', { pages: filePages.join(', ') })}
                  </span>
                )}
              </div>
            )}
            {currentSource.snippet && (
              <p className="mt-1.5 line-clamp-3 break-words text-xs leading-relaxed text-text-secondary">
                {currentSource.snippet}
              </p>
            )}
            {totalPages > 1 && (
              <div className="mt-2 flex items-center gap-1 border-t border-border-light pt-2">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handlePrevPage}
                  disabled={currentPage === 0}
                  className="size-7"
                  aria-label="Previous source"
                >
                  <ChevronLeft className="size-3.5" aria-hidden="true" />
                </Button>
                {sources.map((source, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCurrentPage(i);
                    }}
                    className={`flex size-6 items-center justify-center rounded text-xs transition-colors ${
                      i === currentPage
                        ? 'bg-surface-hover font-medium text-text-primary'
                        : 'text-text-secondary hover:bg-surface-hover'
                    }`}
                    aria-label={`Source ${i + 1}`}
                    aria-current={i === currentPage ? 'true' : undefined}
                  >
                    {i + 1}
                  </button>
                ))}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleNextPage}
                  disabled={currentPage === totalPages - 1}
                  className="size-7"
                  aria-label="Next source"
                >
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-1.5 overflow-hidden text-sm">
              <FaviconImage
                domain={getCleanDomain(currentSource.link || '')}
                className="float-left mr-2 mt-0.5"
              />
              <span className="float-right ml-2 max-w-[40%] truncate text-xs text-text-secondary">
                {getCleanDomain(currentSource.link || '')}
              </span>
              <a
                href={currentSource.link}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-text-primary hover:underline"
              >
                {currentSource.title}
              </a>
            </div>
            {currentSource.snippet && (
              <p className="line-clamp-4 break-words text-xs text-text-secondary md:text-sm">
                {currentSource.snippet}
              </p>
            )}
            {totalPages > 1 && (
              <div className="flex items-center gap-1 border-t border-border-light pt-2">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handlePrevPage}
                  disabled={currentPage === 0}
                  className="size-7"
                  aria-label="Previous source"
                >
                  <ChevronLeft className="size-3.5" aria-hidden="true" />
                </Button>
                {sources.map((source, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCurrentPage(i);
                    }}
                    className={`flex size-6 items-center justify-center rounded text-xs transition-colors ${
                      i === currentPage
                        ? 'bg-surface-hover font-medium text-text-primary'
                        : 'text-text-secondary hover:bg-surface-hover'
                    }`}
                    aria-label={`Source ${i + 1}`}
                    aria-current={i === currentPage ? 'true' : undefined}
                  >
                    {i + 1}
                  </button>
                ))}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleNextPage}
                  disabled={currentPage === totalPages - 1}
                  className="size-7"
                  aria-label="Next source"
                >
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </>
        )}
      </SourceHovercard>
      {isFileType && fileId && (
        <FilePreviewDialog
          open={showPreview}
          onOpenChange={setShowPreview}
          fileName={fileName || currentSource.title || ''}
          fileId={fileId}
          relevance={fileRelevance}
          pages={filePages}
          pageRelevance={filePageRelevance}
          fileType={fileMeta?.fileType}
          fileSource={fileMeta?.storageType}
          fileSize={fileMeta?.fileBytes}
        />
      )}
    </>
  );
}

interface CitationComponentProps {
  citationId: string;
  citationType: 'span' | 'standalone' | 'composite' | 'group' | 'navlist';
  node?: {
    properties?: CitationProps;
  };
}

export function Citation(props: CitationComponentProps) {
  const localize = useLocalize();
  const { citation, citationId } = props.node?.properties ?? {};
  const { setHoveredCitationId } = useContext(CitationContext);
  const refData = useCitation({
    turn: citation?.turn || 0,
    refType: citation?.refType,
    index: citation?.index || 0,
  }) as FileCitationSource | undefined;

  const { isFileType, fileId, fileMeta, fileName, filePages, fileRelevance, filePageRelevance } =
    getFileCitationData(refData);

  const [showPreview, setShowPreview] = useState(false);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFileType && fileId) {
        setShowPreview(true);
      }
    },
    [isFileType, fileId],
  );

  if (!refData) {
    return null;
  }

  const getCitationLabel = () => {
    return (
      refData.attribution ||
      refData.title ||
      getCleanDomain(refData.link || '') ||
      localize('com_citation_source')
    );
  };

  return (
    <>
      <SourceHovercard
        source={toSourceData(refData)}
        label={getCitationLabel()}
        onMouseEnter={() => setHoveredCitationId(citationId || null)}
        onMouseLeave={() => setHoveredCitationId(null)}
        onClick={isFileType ? handleFileClick : undefined}
        isFile={isFileType}
        filePages={filePages}
        fileRelevance={fileRelevance}
      />
      {isFileType && fileId && (
        <FilePreviewDialog
          open={showPreview}
          onOpenChange={setShowPreview}
          fileName={fileName || refData.title || ''}
          fileId={fileId}
          relevance={fileRelevance}
          pages={filePages}
          pageRelevance={filePageRelevance}
          fileType={fileMeta?.fileType}
          fileSource={fileMeta?.storageType}
          fileSize={fileMeta?.fileBytes}
        />
      )}
    </>
  );
}

export interface HighlightedTextProps {
  children: React.ReactNode;
  citationId?: string;
}

export function useHighlightState(citationId: string | undefined) {
  const { hoveredCitationId } = useContext(CitationContext);
  return citationId && hoveredCitationId === citationId;
}

export const HighlightedText = memo(function HighlightedText({
  children,
  citationId,
}: HighlightedTextProps) {
  const isHighlighted = useHighlightState(citationId);

  return (
    <span
      className={`rounded px-0 py-0.5 transition-colors ${isHighlighted ? 'bg-surface-active' : ''}`}
    >
      {children}
    </span>
  );
});
