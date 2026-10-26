import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import { FileContext } from 'librechat-data-provider';
import type { AxiosInstance } from 'axios';
import { generateShortLivedToken } from '~/crypto/jwt';
import { getSafeErrorMetadata } from '~/utils/errors';

interface DeleteRagFileParams {
  /** The user ID. Required for authentication. If not provided, the function returns false and logs an error. */
  userId: string;
  /** The file object. Must have `embedded` and `file_id` properties. */
  file: {
    file_id: string;
    embedded?: boolean;
    context?: string;
    metadata?: { embeddedEntities?: string[] };
  };
}

/**
 * Deletes embedded document(s) from the RAG API.
 * This is a shared utility function used by all file storage strategies
 * (S3, Azure, Firebase, Local) to delete RAG embeddings when a file is deleted.
 *
 * @param params - The parameters object.
 * @param params.userId - The user ID for authentication.
 * @param params.file - The file object. Must have `embedded` and `file_id` properties.
 * @returns Returns true if deletion was successful or skipped, false if there was an error.
 */
export async function deleteRagFile({ userId, file }: DeleteRagFileParams): Promise<boolean> {
  if (!file.embedded) return true;
  if (!userId) {
    logger.error('[deleteRagFile] No user ID provided');
    return false;
  }
  try {
    const deleted = await createVectorFileDeleter({
      baseUrl: process.env.RAG_API_URL,
      httpClient: axios,
      generateToken: generateShortLivedToken,
    })({ user: { id: userId } }, file);
    return deleted?.deleted === true;
  } catch (error) {
    logger.error('[deleteRagFile] Vector deletion was not confirmed', getSafeErrorMetadata(error));
    return false;
  }
}

/**
 * Chunks a presence check asks for. RAG ranks chunks across every owner of a file_id and,
 * once the top one is authorized, returns all of them, so a copy of the same file embedded
 * for the requesting user ties with the entity's copy; asking for several keeps the
 * entity's chunks in the answer whichever copy ranks first.
 */
export const ENTITY_EMBEDDINGS_PROBE_K = 10;

interface EntityEmbeddingsParams {
  /** The requesting user, whose token authorizes the query. */
  userId: string;
  file_id: string;
  /** The namespace to look in, such as an agent id. */
  entity_id: string;
  /** Any non-empty text; RAG needs one to rank chunks. */
  query: string;
  /** How long to wait for RAG before giving up; a stalled check rejects. */
  timeoutMs?: number;
}

/**
 * Whether RAG holds chunks of a file under an entity's namespace. RAG filters a query by
 * file_id and also returns chunks owned by the requesting user, so a result counts only
 * when its recorded owner is the entity itself.
 * Rejects when RAG cannot be asked; the caller chooses the fallback.
 */
export async function hasEntityEmbeddings({
  userId,
  file_id,
  entity_id,
  query,
  timeoutMs,
}: EntityEmbeddingsParams): Promise<boolean> {
  if (!process.env.RAG_API_URL) {
    return false;
  }
  const { data } = await axios.post<Array<[{ metadata?: { user_id?: string } }, number]>>(
    `${process.env.RAG_API_URL}/query`,
    { file_id, query, k: ENTITY_EMBEDDINGS_PROBE_K, entity_id },
    {
      headers: {
        Authorization: `Bearer ${generateShortLivedToken(userId)}`,
        'Content-Type': 'application/json',
      },
      ...(timeoutMs != null ? { timeout: timeoutMs } : {}),
    },
  );
  return Array.isArray(data) && data.some(([chunk]) => chunk?.metadata?.user_id === entity_id);
}

/** A skipped or failed request must never be reported as a removed vector copy. */
export function createVectorFileDeleter({
  baseUrl,
  httpClient,
  generateToken,
}: {
  baseUrl?: string;
  httpClient: Pick<AxiosInstance, 'delete' | 'get'>;
  generateToken: (userId: string) => string;
}): (
  req: { user: { id: string } },
  file: DeleteRagFileParams['file'],
) => Promise<{ deleted: true } | undefined> {
  return async (req, file) => {
    if (!file.embedded || !baseUrl) return undefined;
    if (!req.user.id) throw new Error('Invalid vector deletion principal');
    const entities = file.metadata?.embeddedEntities;
    if (
      entities != null &&
      (!Array.isArray(entities) || entities.some((id) => typeof id !== 'string' || !id))
    ) {
      throw new Error('Invalid file embedding snapshot');
    }
    if (file.context === FileContext.agents && !entities?.length) {
      throw new Error('Agent vector ownership must be recorded before deletion');
    }
    const headers = {
      Authorization: `Bearer ${generateToken(req.user.id)}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    };
    // Legacy user embeddings have no namespace metadata. Never infer an agent from the request.
    const namespaces = entities?.length ? [...new Set(entities)] : [undefined];
    const results = await Promise.allSettled(
      namespaces.map(async (entity_id) => {
        const config = { headers, ...(entity_id ? { params: { entity_id } } : {}) };
        try {
          await httpClient.delete(`${baseUrl}/documents`, { ...config, data: [file.file_id] });
        } catch (error) {
          // A 404 can mean a wrong scope. Only a successful inventory can establish absence,
          // including when a prior attempt removed just some of the namespaces.
          if (getSafeErrorMetadata(error).status !== 404) throw error;
          const { data } = await httpClient.get<string[]>(`${baseUrl}/ids`, config);
          if (
            !Array.isArray(data) ||
            data.some((id) => typeof id !== 'string') ||
            data.includes(file.file_id)
          ) {
            throw new Error('Vector absence was not confirmed');
          }
        }
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      // Do not expose a provider 404 to generic storage cleanup, which forgives missing blobs.
      throw new Error('Vector deletion was not confirmed', {
        cause: getSafeErrorMetadata(failure.reason),
      });
    }
    return { deleted: true };
  };
}
