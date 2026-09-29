import type { AxiosResponse } from 'axios';
import type axios from 'axios';
import type { logAxiosError } from '~/utils/axios';
import type { isEnabled } from '~/utils/common';

interface ContextFile {
  embedded?: boolean;
  file_id: string;
  filename: string;
  type?: string;
}

interface SearchHit {
  page_content?: string;
}

type SearchResults = [SearchHit, number][];
type ContextResponse = AxiosResponse<string | SearchResults>;

interface RagContextOptions {
  req: { user: { id: string } };
  userMessageContent?: string;
  ragApiUrl?: string;
  fullContextSetting?: string;
  httpClient: Pick<typeof axios, 'get' | 'post'>;
  generateShortLivedToken: (userId: string) => string;
  isEnabled: typeof isEnabled;
  logAxiosError: typeof logAxiosError;
}

const footer = `Use the context as your learned knowledge to better answer the user.

In your response, remember to follow these guidelines:
- If you don't know the answer, simply say that you don't know.
- If you are unsure how to answer, ask for clarification.
- Avoid mentioning that you obtained the information from the context.
`;

/** Builds legacy RAG context for non-agents endpoints (including Bedrock). */
export function createRagContextHandlers({
  req,
  userMessageContent,
  ragApiUrl,
  fullContextSetting,
  httpClient,
  generateShortLivedToken,
  isEnabled,
  logAxiosError,
}: RagContextOptions):
  | {
      processFile: (file: ContextFile) => Promise<void>;
      createContext: () => Promise<string>;
    }
  | undefined {
  if (!ragApiUrl) {
    return undefined;
  }

  const queryPromises: Array<Promise<ContextResponse>> = [];
  const processedFiles: ContextFile[] = [];
  const processedIds = new Set<string>();
  const jwtToken = generateShortLivedToken(req.user.id);
  const useFullContext = isEnabled(fullContextSetting);
  const canSemanticSearch =
    typeof userMessageContent === 'string' && userMessageContent.trim().length > 0;

  const query = async (file: ContextFile): Promise<ContextResponse> => {
    if (useFullContext) {
      return httpClient.get<string>(`${ragApiUrl}/documents/${file.file_id}/context`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
        },
      });
    }

    return httpClient.post<SearchResults>(
      `${ragApiUrl}/query`,
      {
        file_id: file.file_id,
        query: userMessageContent,
        k: 4,
      },
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
  };

  const processFile = async (file: ContextFile): Promise<void> => {
    if (!useFullContext && !canSemanticSearch) {
      return;
    }
    if (file.embedded && !processedIds.has(file.file_id)) {
      try {
        const promise = query(file);
        queryPromises.push(promise);
        processedFiles.push(file);
        processedIds.add(file.file_id);
      } catch (error) {
        logAxiosError({ message: `Error processing file ${file.filename}`, error });
      }
    }
  };

  const createContext = async (): Promise<string> => {
    try {
      if (!queryPromises.length || !processedFiles.length) {
        return '';
      }

      const oneFile = processedFiles.length === 1;
      const header = `The user has attached ${oneFile ? 'a' : processedFiles.length} file${
        !oneFile ? 's' : ''
      } to the conversation:`;

      const files = `${
        oneFile
          ? ''
          : `
      <files>`
      }${processedFiles
        .map(
          (file) => `
              <file>
                <filename>${file.filename}</filename>
                <type>${file.type}</type>
              </file>`,
        )
        .join('')}${
        oneFile
          ? ''
          : `
        </files>`
      }`;

      const resolvedQueries = await Promise.all(queryPromises);

      const context =
        resolvedQueries.length === 0
          ? '\n\tThe semantic search did not return any results.'
          : resolvedQueries
              .map((queryResult, index) => {
                const file = processedFiles[index];
                const contextItems = queryResult.data;

                const generateContext = (currentContext: string): string => `
          <file>
            <filename>${file.filename}</filename>
            <context>${currentContext}
            </context>
          </file>`;

                if (useFullContext) {
                  return generateContext(`\n${contextItems}`);
                }

                if (!Array.isArray(contextItems)) {
                  throw new TypeError('Unexpected RAG query response');
                }

                return generateContext(
                  contextItems
                    .map((item) => {
                      const pageContent = item[0].page_content;
                      return `
            <contextItem>
              <![CDATA[${pageContent?.trim()}]]>
            </contextItem>`;
                    })
                    .join(''),
                );
              })
              .join('');

      if (useFullContext) {
        const prompt = `${header}
          ${context}
          ${footer}`;

        return prompt;
      }

      const prompt = `${header}
        ${files}

        A semantic search was executed with the user's message as the query, retrieving the following context inside <context></context> XML tags.

        <context>${context}
        </context>

        ${footer}`;

      return prompt;
    } catch (error) {
      logAxiosError({ message: 'Error creating context', error });
      throw error;
    }
  };

  return { processFile, createContext };
}
