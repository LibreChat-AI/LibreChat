import FormData from 'form-data';
import { createReadStream } from 'node:fs';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { AxiosInstance } from 'axios';
import type { ReadStream } from 'node:fs';
import type { FileStorageUploadObserver } from '../operations';
import { dispatchFileStorageOperation } from '../dispatch';
import { getSafeErrorMetadata } from '~/utils/errors';
import { RagEmbeddingError } from './errors';

type VectorUpload = {
  req: { user: { id: string } };
  file: { path: string; originalname: string; mimetype?: string; size?: number };
  file_id: string;
  entity_id?: string;
  storageMetadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onUploadStart?: FileStorageUploadObserver;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Legacy status/known_type flags do not prove rollback completed or that inserts never began. */
function confirmEmbedding(data: unknown, fileId: string): void {
  if (isRecord(data)) {
    if (
      data.status === false &&
      data.file_id === fileId &&
      isRecord(data.error) &&
      data.error.code === 'RAG_EMBEDDING_REFUSED' &&
      data.error.side_effects === 'none'
    ) {
      throw new RagEmbeddingError('RAG_EMBEDDING_REFUSED');
    }
    if (
      data.status === true &&
      data.known_type === true &&
      !('error' in data) &&
      (data.file_id === undefined || data.file_id === fileId)
    ) {
      return;
    }
  }
  throw new RagEmbeddingError('RAG_EMBEDDING_OUTCOME_UNKNOWN');
}

/** HTTP clients and credentials are supplied by the host, not application singletons. */
export function createVectorFileUploader({
  baseUrl,
  httpClient,
  generateToken,
}: {
  baseUrl?: string;
  httpClient: Pick<AxiosInstance, 'post'>;
  generateToken: (userId: string) => string;
}): (params: VectorUpload) => Promise<{
  bytes?: number;
  filename: string;
  filepath: FileSources;
  embedded: boolean;
}> {
  return async ({ req, file, file_id, entity_id, storageMetadata, signal, onUploadStart }) => {
    let stream: ReadStream | undefined;
    try {
      if (!baseUrl) throw new RagEmbeddingError('RAG_EMBEDDING_OUTCOME_UNKNOWN');
      const token = generateToken(req.user.id);
      const body = new FormData();
      body.append('file_id', file_id);
      stream = createReadStream(file.path);
      body.append('file', stream);
      if (entity_id) body.append('entity_id', entity_id);
      if (storageMetadata) body.append('storage_metadata', JSON.stringify(storageMetadata));

      return await dispatchFileStorageOperation(onUploadStart, async () => {
        try {
          const response = await httpClient.post<unknown>(`${baseUrl}/embed`, body, {
            ...(signal ? { signal } : {}),
            headers: {
              Authorization: `Bearer ${token}`,
              accept: 'application/json',
              ...body.getHeaders(),
            },
          });
          if (
            !Number.isInteger(response.status) ||
            response.status < 200 ||
            response.status >= 300
          ) {
            throw new RagEmbeddingError('RAG_EMBEDDING_OUTCOME_UNKNOWN');
          }
          confirmEmbedding(response.data, file_id);
          return {
            bytes: file.size,
            filename: file.originalname,
            filepath: FileSources.vectordb,
            embedded: true,
          };
        } catch (error) {
          logger.error('[uploadVectors] Embedding was not confirmed', getSafeErrorMetadata(error));
          // Upstream errors can contain document text, credentials or SQL, including in causes.
          throw error instanceof RagEmbeddingError
            ? error
            : new RagEmbeddingError('RAG_EMBEDDING_OUTCOME_UNKNOWN');
        }
      });
    } catch (error) {
      if (error instanceof RagEmbeddingError) throw error;
      logger.error('[uploadVectors] Embedding setup failed', getSafeErrorMetadata(error));
      throw new RagEmbeddingError('RAG_EMBEDDING_OUTCOME_UNKNOWN');
    } finally {
      stream?.destroy();
    }
  };
}
