import React, { useMemo, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { VisuallyHidden } from '@ariakit/react';
import { Tools } from 'librechat-data-provider';
import { X, Globe, Newspaper, Image, ChevronDown, File, Download } from 'lucide-react';
import {
  Button,
  OGDialog,
  AnimatedTabs,
  OGDialogClose,
  OGDialogTitle,
  OGDialogContent,
  OGDialogTrigger,
  useToastContext,
} from '@librechat/client';
import type { ValidSource, ImageResult } from 'librechat-data-provider';
import { FaviconImage, getCleanDomain } from '~/components/Web/SourceHovercard';
import SourcesErrorBoundary from './SourcesErrorBoundary';
import { useFileDownload } from '~/data-provider';
import { useSearchContext } from '~/Providers';
import { cn, triggerDownload } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface SourceItemProps {
  source: ValidSource;
  expanded?: boolean;
}

function SourceItem({ source, expanded = false }: SourceItemProps) {
  const localize = useLocalize();
  const domain = getCleanDomain(source.link);

  if (expanded) {
    return (
      <a
        href={source.link}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-surface-primary-contrast hover:bg-surface-tertiary flex w-full flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300"
      >
        <div className="flex items-center gap-2">
          <FaviconImage domain={domain} />
          <span className="text-text-secondary truncate text-xs font-medium">{domain}</span>
        </div>
        <div className="mt-1">
          <span className="text-text-primary line-clamp-2 text-sm font-medium md:line-clamp-3">
            {source.title || source.link}
          </span>
          {'snippet' in source && source.snippet && (
            <span className="text-text-secondary mt-1 line-clamp-2 text-xs md:line-clamp-3">
              {source.snippet}
            </span>
          )}
        </div>
      </a>
    );
  }

  return (
    <span className="not-prose relative inline-block h-full w-full">
      <Ariakit.HovercardProvider showTimeout={150} hideTimeout={150}>
        <div className="flex h-full items-center">
          <Ariakit.HovercardAnchor
            render={
              <a
                href={source.link}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-surface-primary-contrast hover:bg-surface-tertiary flex h-full w-full flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300"
              >
                <div className="flex items-center gap-2">
                  <FaviconImage domain={domain} />
                  <span className="text-text-secondary truncate text-xs font-medium">{domain}</span>
                </div>
                <div className="mt-1">
                  <span className="text-text-primary line-clamp-2 text-sm font-medium md:line-clamp-3">
                    {source.title || source.link}
                  </span>
                </div>
              </a>
            }
          />
          <Ariakit.HovercardDisclosure className="text-text-primary focus:ring-text-primary absolute right-2 rounded-full focus:ring-2 focus:outline-hidden">
            <VisuallyHidden>
              {localize('com_citation_more_details', { label: domain })}
            </VisuallyHidden>
            <ChevronDown className="icon-sm" aria-hidden="true" />
          </Ariakit.HovercardDisclosure>

          <Ariakit.Hovercard
            gutter={16}
            className={cn(
              'border-border-medium bg-surface-secondary text-text-primary z-[999] w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border p-3 shadow-lg',
              'origin-top-left scale-95 opacity-0 transition-[opacity,transform] duration-150 ease-out',
              'data-[enter]:scale-100 data-[enter]:opacity-100',
              'data-[leave]:scale-95 data-[leave]:opacity-0',
            )}
            portal={true}
            unmountOnHide={true}
          >
            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 overflow-hidden text-sm">
                  <FaviconImage domain={domain} className="float-left mt-0.5 mr-2" />
                  <span className="text-text-secondary float-right ml-2 max-w-[40%] truncate text-xs">
                    {domain}
                  </span>
                  <a
                    href={source.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-primary font-medium hover:underline"
                  >
                    {source.title || source.link}
                  </a>
                </div>
                {'snippet' in source && source.snippet && (
                  <p className="text-text-secondary line-clamp-4 text-xs break-words md:text-sm">
                    {source.snippet}
                  </p>
                )}
              </div>
              {'imageUrl' in source && source.imageUrl && (
                <div className="size-24 shrink-0 overflow-hidden rounded-md">
                  <img
                    src={source.imageUrl}
                    alt={source.title || localize('com_sources_image_alt')}
                    className="size-full object-cover"
                  />
                </div>
              )}
            </div>
          </Ariakit.Hovercard>
        </div>
      </Ariakit.HovercardProvider>
    </span>
  );
}

function ImageItem({ image }: { image: ImageResult }) {
  const localize = useLocalize();
  return (
    <a
      href={image.imageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group bg-surface-secondary hover:bg-surface-tertiary overflow-hidden rounded-lg transition-all duration-300"
    >
      {image.imageUrl && (
        <div className="relative aspect-square w-full overflow-hidden">
          <img
            src={image.imageUrl}
            alt={image.title || localize('com_sources_image_alt')}
            className="size-full object-cover"
          />
          {image.title && (
            <div className="absolute right-0 bottom-0 left-0 w-full border-none bg-gray-900/80 p-1 text-xs font-medium text-white backdrop-blur-xs">
              <span className="truncate">{image.title}</span>
            </div>
          )}
        </div>
      )}
    </a>
  );
}

// Type for agent file sources (simplified for file citations)
type AgentFileSource = {
  file_id: string;
  filename: string;
  bytes?: number;
  type?: string;
  source?: string;
  pages?: number[];
  relevance?: number;
  pageRelevance?: Record<number, number>;
  messageId: string;
  toolCallId: string;
  metadata?: any;
};

interface FileItemProps {
  file: AgentFileSource;
  messageId: string;
  conversationId: string;
  expanded?: boolean;
}

/**
 * Sorts page numbers by their relevance scores in descending order (highest first)
 */
function sortPagesByRelevance(pages: number[], pageRelevance?: Record<number, number>): number[] {
  if (!pageRelevance || Object.keys(pageRelevance).length === 0) {
    return pages; // Return original order if no relevance data
  }

  return [...pages].sort((a, b) => {
    const relevanceA = pageRelevance[a] || 0;
    const relevanceB = pageRelevance[b] || 0;
    return relevanceB - relevanceA; // Highest relevance first
  });
}

const FileItem = React.memo(function FileItem({
  file,
  messageId: _messageId,
  conversationId: _conversationId,
  expanded = false,
}: FileItemProps) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();

  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file.file_id, {
    source: file.source,
  });

  // Extract error message logic to avoid duplication
  const getErrorMessage = useCallback(
    (error: any) => {
      const errorString = JSON.stringify(error);
      const errorWithResponse = error as any;
      const isLocalFileError =
        error?.message?.includes('local files') ||
        errorWithResponse?.response?.data?.error?.includes('local files') ||
        errorWithResponse?.response?.status === 403 ||
        errorString.includes('local files') ||
        errorString.includes('403');

      return isLocalFileError
        ? localize('com_sources_download_local_unavailable')
        : localize('com_sources_download_failed');
    },
    [localize],
  );

  // Check if file is from local storage
  const isLocalFile = file.metadata?.storageType === 'local';

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't allow download for local files
      if (isLocalFile) {
        return;
      }
      try {
        const stream = await downloadFile();
        if (stream.data == null || stream.data === '') {
          console.error('Error downloading file: No data found');
          showToast({
            status: 'error',
            message: localize('com_ui_download_error'),
          });
          return;
        }
        triggerDownload(stream.data, file.filename);
      } catch (error) {
        console.error('Error downloading file:', error);
      }
    },
    [downloadFile, file.filename, isLocalFile, localize, showToast],
  );
  const isLoading = false;

  // Memoize file icon computation for performance
  const fileIcon = useMemo(() => {
    const fileType = file.type?.toLowerCase() || '';
    if (fileType.includes('pdf')) return '📄';
    if (fileType.includes('image')) return '🖼️';
    if (fileType.includes('text')) return '📝';
    if (fileType.includes('word') || fileType.includes('doc')) return '📄';
    if (fileType.includes('excel') || fileType.includes('sheet')) return '📊';
    if (fileType.includes('powerpoint') || fileType.includes('presentation')) return '📈';
    return '📎';
  }, [file.type]);

  // Simple aria label
  const downloadAriaLabel = localize('com_sources_download_aria_label', {
    filename: file.filename,
    status: isLoading ? localize('com_sources_downloading_status') : '',
  });
  const error = null;
  if (expanded) {
    return (
      <button
        onClick={isLocalFile ? undefined : handleDownload}
        disabled={isLoading}
        className={`bg-surface-primary-contrast flex w-full flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300 disabled:opacity-50 ${
          isLocalFile ? 'cursor-default' : 'hover:bg-surface-tertiary'
        }`}
        aria-label={
          isLocalFile ? localize('com_sources_download_local_unavailable') : downloadAriaLabel
        }
      >
        <div className="flex items-center gap-2">
          <span className="text-base">{fileIcon}</span>
          <span className="text-text-secondary truncate text-xs font-medium">
            {localize('com_sources_agent_file')}
          </span>
          {!isLocalFile && <Download className="ml-auto size-3" aria-hidden="true" />}
        </div>
        <div className="mt-1 min-w-0">
          <span className="text-text-primary line-clamp-2 text-left text-sm font-medium break-words md:line-clamp-3">
            {file.filename}
          </span>
          {file.pages && file.pages.length > 0 && (
            <span className="text-text-secondary mt-1 line-clamp-1 text-left text-xs">
              {localize('com_sources_pages')}:{' '}
              {sortPagesByRelevance(file.pages, file.pageRelevance).join(', ')}
            </span>
          )}
          {file.bytes && (
            <span className="text-text-secondary mt-1 line-clamp-1 text-xs">
              {(file.bytes / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
        {error && (
          <div className="text-text-destructive mt-1 text-xs">{getErrorMessage(error)}</div>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={isLocalFile ? undefined : handleDownload}
      disabled={isLoading}
      className={`bg-surface-primary-contrast flex h-full w-full flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300 disabled:opacity-50 ${
        isLocalFile ? 'cursor-default' : 'hover:bg-surface-tertiary'
      }`}
      aria-label={
        isLocalFile ? localize('com_sources_download_local_unavailable') : downloadAriaLabel
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-base">{fileIcon}</span>
        <span className="text-text-secondary truncate text-xs font-medium">
          {localize('com_sources_agent_file')}
        </span>
        {!isLocalFile && <Download className="ml-auto size-3" aria-hidden="true" />}
      </div>
      <div className="mt-1 min-w-0">
        <span className="text-text-primary line-clamp-2 text-left text-sm font-medium break-words md:line-clamp-3">
          {file.filename}
        </span>
        {file.pages && file.pages.length > 0 && (
          <span className="text-text-secondary mt-1 line-clamp-1 text-left text-xs">
            {localize('com_sources_pages')}:{' '}
            {sortPagesByRelevance(file.pages, file.pageRelevance).join(', ')}
          </span>
        )}
      </div>
      {error && <div className="text-text-destructive mt-1 text-xs">{getErrorMessage(error)}</div>}
    </button>
  );
});

export function StackedFavicons({
  sources,
  start = 0,
  end = 3,
}: {
  sources: ValidSource[];
  start?: number;
  end?: number;
}) {
  let slice = [start, end];
  if (start < 0) {
    slice = [start];
  }
  return (
    <div className="relative flex">
      {sources.slice(...slice).map((source, i) => (
        <FaviconImage
          key={`icon-${i}`}
          domain={getCleanDomain(source.link)}
          className={i > 0 ? 'ml-[-6px]' : ''}
        />
      ))}
    </div>
  );
}

const SourcesGroup = React.memo(function SourcesGroup({
  sources,
  limit = 3,
}: {
  sources: ValidSource[];
  limit?: number;
}) {
  const localize = useLocalize();

  // Memoize source slicing for better performance
  const { visibleSources, remainingSources, hasMoreSources } = useMemo(() => {
    const visible = sources.slice(0, limit);
    const remaining = sources.slice(limit);
    return {
      visibleSources: visible,
      remainingSources: remaining,
      hasMoreSources: remaining.length > 0,
    };
  }, [sources, limit]);

  return (
    <div className="grid w-full grid-cols-4 gap-2 overflow-x-auto">
      <OGDialog>
        {visibleSources.map((source, i) => (
          <div key={`source-${i}`} className="w-full min-w-[120px]">
            <SourceItem source={source} />
          </div>
        ))}
        {hasMoreSources && (
          <OGDialogTrigger className="bg-surface-primary-contrast hover:bg-surface-tertiary flex flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300">
            <div className="flex items-center gap-2">
              <StackedFavicons sources={remainingSources} />
              <span className="text-text-secondary truncate text-xs font-medium">
                {localize('com_sources_more_sources', { count: remainingSources.length })}
              </span>
            </div>
          </OGDialogTrigger>
        )}
        <OGDialogContent className="bg-surface-dialog flex max-h-[80vh] max-w-full flex-col overflow-hidden rounded-lg p-0 md:max-w-[600px]">
          <div className="border-border-light bg-surface-dialog sticky top-0 z-10 flex items-center justify-between border-b px-3 py-2">
            <OGDialogTitle className="text-base font-medium">
              {localize('com_sources_title')}
            </OGDialogTitle>
            <OGDialogClose
              className="text-text-secondary hover:bg-surface-tertiary hover:text-text-primary rounded-full p-1"
              aria-label={localize('com_ui_close')}
            >
              <X className="size-4" aria-hidden="true" />
            </OGDialogClose>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <div className="flex flex-col gap-2">
              {[...visibleSources, ...remainingSources].map((source, i) => (
                <a
                  key={`more-source-${i}`}
                  href={source.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-surface-tertiary flex gap-2 rounded-lg px-2 py-2 transition-colors"
                >
                  <FaviconImage domain={getCleanDomain(source.link)} className="h-5 w-5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-text-primary mb-0.5 truncate text-sm font-medium">
                      {source.title || source.link}
                    </h3>
                    {'snippet' in source && source.snippet && (
                      <p className="text-text-secondary mb-1 line-clamp-2 text-xs md:line-clamp-3">
                        {source.snippet}
                      </p>
                    )}
                    <span className="text-text-secondary-alt text-xs">
                      {getCleanDomain(source.link)}
                    </span>
                  </div>
                  {'imageUrl' in source && source.imageUrl && (
                    <div className="hidden h-12 w-12 shrink-0 overflow-hidden rounded-md sm:block">
                      <img
                        src={source.imageUrl}
                        alt={source.title || localize('com_sources_image_alt')}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  )}
                </a>
              ))}
            </div>
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
});

interface FilesGroupProps {
  files: AgentFileSource[];
  messageId: string;
  conversationId: string;
  limit?: number;
}

function FilesGroup({ files, messageId, conversationId, limit = 3 }: FilesGroupProps) {
  const localize = useLocalize();
  // If there's only 1 remaining file, show it instead of "+1 files"
  const shouldShowAll = files.length <= limit + 1;
  const actualLimit = shouldShowAll ? files.length : limit;
  const visibleFiles = files.slice(0, actualLimit);
  const remainingFiles = files.slice(actualLimit);
  const hasMoreFiles = remainingFiles.length > 0;

  return (
    <div className="grid w-full grid-cols-4 gap-2 overflow-x-auto">
      <OGDialog>
        {visibleFiles.map((file, i) => (
          <div key={`file-${i}`} className="w-full min-w-[120px]">
            <FileItem file={file} messageId={messageId} conversationId={conversationId} />
          </div>
        ))}
        {hasMoreFiles && (
          <OGDialogTrigger className="bg-surface-primary-contrast hover:bg-surface-tertiary flex flex-col rounded-lg px-3 py-2 text-sm transition-all duration-300">
            <div className="flex items-center gap-2">
              <div className="relative flex">
                {remainingFiles.slice(0, 3).map((_, i) => (
                  <File key={`file-icon-${i}`} className={`size-4 ${i > 0 ? 'ml-[-6px]' : ''}`} />
                ))}
              </div>
              <span className="text-text-secondary truncate text-xs font-medium">
                {localize('com_sources_more_files', { count: remainingFiles.length })}
              </span>
            </div>
          </OGDialogTrigger>
        )}
        <OGDialogContent className="bg-surface-dialog flex max-h-[80vh] max-w-full flex-col overflow-hidden rounded-lg p-0 md:max-w-[600px]">
          <div className="border-border-light bg-surface-dialog sticky top-0 z-10 flex items-center justify-between border-b px-3 py-2">
            <OGDialogTitle className="text-base font-medium">
              {localize('com_sources_agent_files')}
            </OGDialogTitle>
            <OGDialogClose
              className="text-text-secondary hover:bg-surface-tertiary hover:text-text-primary rounded-full p-1"
              aria-label={localize('com_ui_close')}
            >
              <X className="size-4" aria-hidden="true" />
            </OGDialogClose>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <div className="flex flex-col gap-2">
              {[...visibleFiles, ...remainingFiles].map((file, i) => (
                <FileItem
                  key={`more-file-${i}`}
                  file={file}
                  messageId={messageId}
                  conversationId={conversationId}
                  expanded={true}
                />
              ))}
            </div>
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

function TabWithIcon({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="hover:bg-surface-tertiary hover:text-text-primary flex items-center gap-2 rounded-md px-3 py-1 text-sm transition-colors">
      {React.cloneElement(icon as React.ReactElement, { size: 14, 'aria-hidden': true })}
      <span>{label}</span>
    </div>
  );
}

interface SourcesProps {
  messageId?: string;
  conversationId?: string;
}

function SourcesComponent({ messageId, conversationId }: SourcesProps = {}) {
  const localize = useLocalize();
  const { searchResults } = useSearchContext();

  // Simple search results processing with good memoization
  const { organicSources, topStories, images, hasAnswerBox, agentFiles } = useMemo(() => {
    const organicSourcesMap = new Map<string, ValidSource>();
    const topStoriesMap = new Map<string, ValidSource>();
    const imagesMap = new Map<string, ImageResult>();
    const agentFilesMap = new Map<string, AgentFileSource>();
    let hasAnswerBox = false;

    if (!searchResults) {
      return {
        organicSources: [],
        topStories: [],
        images: [],
        hasAnswerBox: false,
        agentFiles: [],
      };
    }

    // Process search results
    for (const result of Object.values(searchResults)) {
      if (!result) continue;

      // Process organic sources
      result.organic?.forEach((source) => {
        if (source.link) organicSourcesMap.set(source.link, source);
      });

      // Process references
      result.references?.forEach((source) => {
        if (source.type === 'image') {
          imagesMap.set(source.link, { ...source, imageUrl: source.link });
        } else if ((source as any).type === 'file') {
          const fileId = (source as any).fileId || 'unknown';
          const fileName = source.title || 'Unknown File';
          const uniqueKey = `${fileId}_${fileName}`;

          if (agentFilesMap.has(uniqueKey)) {
            // Merge pages for the same file
            const existing = agentFilesMap.get(uniqueKey)!;
            const existingPages = existing.pages || [];
            const newPages = (source as any).pages || [];
            const uniquePages = [...new Set([...existingPages, ...newPages])].sort((a, b) => a - b);

            existing.pages = uniquePages;
            existing.relevance = Math.max(existing.relevance || 0, (source as any).relevance || 0);
            existing.pageRelevance = {
              ...existing.pageRelevance,
              ...(source as any).pageRelevance,
            };
          } else {
            const agentFile: AgentFileSource = {
              type: Tools.file_search,
              file_id: fileId,
              filename: fileName,
              bytes: undefined,
              metadata: (source as any).metadata,
              pages: (source as any).pages,
              relevance: (source as any).relevance,
              pageRelevance: (source as any).pageRelevance,
              messageId: messageId || '',
              toolCallId: 'file_search_results',
            };
            agentFilesMap.set(uniqueKey, agentFile);
          }
        } else if (source.link) {
          organicSourcesMap.set(source.link, source);
        }
      });

      // Process top stories
      result.topStories?.forEach((source) => {
        if (source.link) topStoriesMap.set(source.link, source);
      });

      // Process images
      result.images?.forEach((image) => {
        if (image.imageUrl) imagesMap.set(image.imageUrl, image);
      });

      if (result.answerBox) hasAnswerBox = true;
    }

    return {
      organicSources: Array.from(organicSourcesMap.values()),
      topStories: Array.from(topStoriesMap.values()),
      images: Array.from(imagesMap.values()),
      hasAnswerBox,
      agentFiles: Array.from(agentFilesMap.values()),
    };
  }, [searchResults, messageId]);

  const tabs = useMemo(() => {
    const availableTabs: Array<{ label: React.ReactNode; content: React.ReactNode }> = [];

    if (organicSources.length || topStories.length || hasAnswerBox) {
      availableTabs.push({
        label: <TabWithIcon label={localize('com_sources_tab_all')} icon={<Globe />} />,
        content: <SourcesGroup sources={[...organicSources, ...topStories]} />,
      });
    }

    if (topStories.length) {
      availableTabs.push({
        label: <TabWithIcon label={localize('com_sources_tab_news')} icon={<Newspaper />} />,
        content: <SourcesGroup sources={topStories} limit={3} />,
      });
    }

    if (images.length) {
      availableTabs.push({
        label: <TabWithIcon label={localize('com_sources_tab_images')} icon={<Image />} />,
        content: (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {images.map((item, i) => (
              <ImageItem key={`image-${i}`} image={item} />
            ))}
          </div>
        ),
      });
    }

    if (agentFiles.length && messageId && conversationId) {
      availableTabs.push({
        label: <TabWithIcon label={localize('com_sources_tab_files')} icon={<File />} />,
        content: (
          <FilesGroup
            files={agentFiles}
            messageId={messageId}
            conversationId={conversationId}
            limit={3}
          />
        ),
      });
    }

    return availableTabs;
  }, [
    organicSources,
    topStories,
    images,
    hasAnswerBox,
    agentFiles,
    messageId,
    conversationId,
    localize,
  ]);

  if (!tabs.length) return null;

  return (
    <div role="region" aria-label={localize('com_sources_region_label')}>
      <AnimatedTabs
        tone="muted"
        tabs={tabs}
        containerClassName="flex min-w-full mb-4"
        tabListClassName="flex items-center mb-2 border-b border-border-light overflow-x-auto"
        tabPanelClassName="w-full overflow-x-auto md:mx-0 md:px-0"
        tabClassName="flex items-center whitespace-nowrap text-xs font-medium px-1 pt-2 pb-1 border-b-2 border-transparent focus:ring-2 focus:ring-text-primary focus:ring-offset-2"
      />
    </div>
  );
}

// Enhanced error boundary wrapper with accessibility features
export default function Sources(props: SourcesProps) {
  const localize = useLocalize();

  const handleError = (error: Error, errorInfo: React.ErrorInfo) => {
    // Log error for monitoring/analytics
    console.error('Sources component error:', { error, errorInfo });

    // Could send to error tracking service here
    // analytics.track('sources_error', { error: error.message });
  };

  const fallbackUI = (
    <div
      className="border-border-medium bg-surface-secondary flex flex-col items-center justify-center rounded-lg border p-4 text-center"
      role="alert"
      aria-live="polite"
    >
      <div className="text-text-secondary mb-2 text-sm">
        {localize('com_sources_error_fallback')}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => window.location.reload()}
        className="bg-surface-primary text-text-primary hover:bg-surface-hover rounded-md px-3 py-1 text-sm"
        aria-label={localize('com_sources_reload_page')}
      >
        {localize('com_ui_refresh')}
      </Button>
    </div>
  );

  return (
    <SourcesErrorBoundary
      onError={handleError}
      fallback={fallbackUI}
      showDetails={process.env.NODE_ENV === 'development'}
    >
      <SourcesComponent {...props} />
    </SourcesErrorBoundary>
  );
}
