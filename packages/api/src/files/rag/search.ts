import { EModelEndpoint, Tools } from 'librechat-data-provider';
import type { logger } from '@librechat/data-schemas';
import type axios from 'axios';
import type { FileCitationSelectionConfig, selectFileCitationSources } from '../citations';
import type { logAxiosError } from '~/utils/axios';

type SearchFile = { file_id: string; fromAgent?: boolean };
type FileSearchResult = [
  string,
  { file_search: { sources: FileSearchSource[]; fileCitations: boolean } } | undefined,
];

type FileSearchSource = {
  type: string;
  fileId: string;
  content: string;
  fileName?: string;
  relevance: number;
  pages: number[];
  pageRelevance: { [page: number]: number };
};

interface SearchHit {
  page_content: string;
  metadata: { source: string; page?: number | string | null };
}

type SearchResults = [SearchHit, number][];

interface SearchOptions {
  query?: string;
  userId: string;
  files: readonly SearchFile[];
  entity_id?: string;
  fileCitations: boolean;
  appConfig?: { endpoints?: Partial<Record<EModelEndpoint, FileCitationSelectionConfig>> };
  ragApiUrl?: string;
  httpClient: Pick<typeof axios, 'post'>;
  generateShortLivedToken: (userId: string) => string;
  logAxiosError: typeof logAxiosError;
  selectFileCitationSources: typeof selectFileCitationSources;
  logger: Pick<typeof logger, 'debug'>;
}

/** Executes a file-search tool call without sending malformed queries to RAG API. */
export async function executeFileSearchQuery({
  query,
  userId,
  files,
  entity_id,
  fileCitations,
  appConfig,
  ragApiUrl,
  httpClient,
  generateShortLivedToken,
  logAxiosError,
  selectFileCitationSources,
  logger,
}: SearchOptions): Promise<FileSearchResult> {
  if (files.length === 0) {
    return ['No files to search. Instruct the user to add files for the search.', undefined];
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    return ['A non-empty query is required to search the files.', undefined];
  }
  const jwtToken = generateShortLivedToken(userId);
  if (!jwtToken) {
    return ['There was an error authenticating the file search request.', undefined];
  }

  const createQueryBody = (file: SearchFile) => {
    const body: { file_id: string; query: string; k: number; entity_id?: string } = {
      file_id: file.file_id,
      query,
      k: 5,
    };
    // Only agent knowledge-base files carry entity_id. User attachments must stay user-scoped.
    if (!entity_id || file.fromAgent !== true) {
      return body;
    }
    body.entity_id = entity_id;
    logger.debug(`[${Tools.file_search}] RAG API /query body`, body);
    return body;
  };

  const queryPromises = files.map((file) =>
    httpClient
      .post<SearchResults>(`${ragApiUrl}/query`, createQueryBody(file), {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
        },
      })
      .then((result) => ({ data: result.data, file_id: file.file_id }))
      .catch((error) => {
        logAxiosError({
          message: 'Error encountered in `file_search` while querying file',
          error,
        });
        return null;
      }),
  );

  const results = await Promise.all(queryPromises);
  const validResults = results.filter((result) => result !== null);

  if (validResults.length === 0) {
    return ['No results found or errors occurred while searching the files.', undefined];
  }

  const formattedResults = validResults
    .flatMap((result) =>
      result.data.map(([docInfo, distance]) => ({
        filename: docInfo.metadata.source.split('/').pop(),
        content: docInfo.page_content,
        distance,
        file_id: result.file_id,
        page:
          typeof docInfo.metadata.page === 'number' &&
          Number.isInteger(docInfo.metadata.page) &&
          docInfo.metadata.page >= 0
            ? docInfo.metadata.page + 1
            : null,
      })),
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);

  if (formattedResults.length === 0) {
    return [
      'No content found in the files. The files may not have been processed correctly or you may need to refine your query.',
      undefined,
    ];
  }

  const sources = formattedResults.map((result) => ({
    type: 'file',
    fileId: result.file_id,
    content: result.content,
    fileName: result.filename,
    relevance: 1.0 - result.distance,
    pages: result.page ? [result.page] : [],
    pageRelevance: result.page ? { [result.page]: 1.0 - result.distance } : {},
  }));

  const citationConfig = appConfig?.endpoints?.[EModelEndpoint.agents];
  const citationSources = fileCitations ? selectFileCitationSources(sources, citationConfig) : [];
  const formattedString = formattedResults
    .map((result, index) => {
      const citationIndex = citationSources.indexOf(sources[index]);
      return `File: ${result.filename}${
        citationIndex >= 0 ? `\nAnchor: \\ue202turn0file${citationIndex} (${result.filename})` : ''
      }\nRelevance: ${(1.0 - result.distance).toFixed(4)}\nContent: ${result.content}\n`;
    })
    .join('\n---\n');

  return [formattedString, { [Tools.file_search]: { sources, fileCitations } }];
}
