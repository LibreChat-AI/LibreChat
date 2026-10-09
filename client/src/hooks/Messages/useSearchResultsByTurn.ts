import { useMemo } from 'react';
import { TAttachment, Tools, SearchResultData } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

interface FileSource {
  fileId: string;
  fileName: string;
  pages?: number[];
  relevance?: number;
  pageRelevance?: Record<string, number>;
  metadata?: any;
}

/**
 * The `file_search` attachment is typed as {@link SearchResultData} in the
 * shared schema, but at runtime the agent file-search tool emits a
 * `{ sources: FileSource[] }` payload. Read the sources defensively.
 */
type FileSearchAttachmentData = SearchResultData & { sources?: FileSource[] };

function getFileSearchSources(data: FileSearchAttachmentData): FileSource[] {
  return Array.isArray(data.sources) ? data.sources : [];
}

/**
 * Hook that creates a map of turn numbers to SearchResultData from web search and agent file search attachments
 * @param attachments Array of attachment metadata
 * @returns A map of turn numbers to their corresponding search result data
 */
export function useSearchResultsByTurn(attachments?: TAttachment[]) {
  const localize = useLocalize();
  const searchResultsByTurn = useMemo(() => {
    const turnMap: { [key: string]: SearchResultData } = {};
    let agentFileSearchTurn = 0;

    attachments?.forEach((attachment) => {
      // Handle web search attachments (existing functionality)
      if (attachment.type === Tools.web_search && attachment[Tools.web_search]) {
        const searchData = attachment[Tools.web_search];
        if (searchData && typeof searchData.turn === 'number') {
          turnMap[searchData.turn.toString()] = searchData;
        }
      }

      // Handle agent file search attachments (following web search pattern)
      if (attachment.type === Tools.file_search && attachment[Tools.file_search]) {
        const sources = getFileSearchSources(attachment[Tools.file_search]);

        // Convert agent file sources to SearchResultData format
        const agentSearchData: SearchResultData = {
          turn: agentFileSearchTurn,
          organic: [], // Agent file search doesn't have organic web results
          topStories: [], // No top stories for file search
          images: [], // No images for file search
          references: sources.map(
            (source) =>
              ({
                title: source.fileName || localize('com_file_unknown'),
                link: `#file-${source.fileId}`, // Create a pseudo-link for file references
                attribution: source.fileName || localize('com_file_unknown'), // Show filename in inline display
                snippet:
                  source.pages && source.pages.length > 0
                    ? localize('com_file_pages', { pages: source.pages.join(', ') })
                    : '', // Only page numbers for hover
                type: 'file' as const,
                // Store additional agent-specific data as properties on the reference
                fileId: source.fileId,
                fileName: source.fileName,
                pages: source.pages || [],
                pageRelevance: source.pageRelevance || {},
                metadata: source.metadata,
              }) as any,
          ),
        };

        turnMap[agentFileSearchTurn.toString()] = agentSearchData;
        agentFileSearchTurn++;
      }
    });

    return turnMap;
  }, [attachments, localize]);

  return searchResultsByTurn;
}
