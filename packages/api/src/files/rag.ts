import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import type { AxiosInstance } from 'axios';
import { isMissingStorageError, readEmbeddedEntities } from './storage';
import { generateShortLivedToken } from '~/crypto/jwt';

interface DeleteRagFileParams {
  /** The user ID. Required for authentication. If not provided, the function returns false and logs an error. */
  userId: string;
  /** The file object. Must have `embedded` and `file_id` properties. */
  file: {
    file_id: string;
    embedded?: boolean;
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
  if (!file.embedded || !process.env.RAG_API_URL) {
    return true;
  }

  if (!userId) {
    logger.error('[deleteRagFile] No user ID provided');
    return false;
  }

  const jwtToken = generateShortLivedToken(userId);

  try {
    await axios.delete(`${process.env.RAG_API_URL}/documents`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
    logger.debug(`[deleteRagFile] Successfully deleted document ${file.file_id} from RAG API`);
    return true;
  } catch (error) {
    const axiosError = error as { response?: { status?: number }; message?: string };
    if (axiosError.response?.status === 404) {
      logger.warn(
        `[deleteRagFile] Document ${file.file_id} not found in RAG API, may have been deleted already`,
      );
      return true;
    } else {
      logger.error('[deleteRagFile] Error deleting document from RAG API:', axiosError.message);
      return false;
    }
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

/**
 * A skipped or failed request must never be reported as a removed vector copy.
 *
 * rag_api deletes with `delete_scoped(ids, owners)` where the owner set is the
 * token's user plus any `entity_id` the caller names. Chunks embedded under an
 * entity, which is every agent knowledge-base file, are therefore outside an
 * unscoped delete's reach: it matches nothing, answers 404, and the chunks
 * survive. The owners are the file's `metadata.embeddedEntities`, a set that
 * grows when a record is shared (a duplicated agent embeds its own copy), so one
 * scoped request is sent per recorded entity: each also covers the user's own
 * copy, and none is skipped. For those files a missing document stops counting
 * as success: anything other than a 2xx means the chunks may still be there.
 * Files with no recorded entity keep the previous behaviour exactly, including
 * its tolerance of a missing document. See #14988.
 */
export function createVectorFileDeleter({
  baseUrl,
  httpClient,
  generateToken,
}: {
  baseUrl?: string;
  httpClient: Pick<AxiosInstance, 'delete'>;
  generateToken: (userId: string) => string;
}): (
  req: { user: { id: string } },
  file: { file_id: string; embedded?: boolean; metadata?: { embeddedEntities?: string[] } },
) => Promise<{ deleted: true } | undefined> {
  return async (req, file) => {
    if (!file.embedded || !baseUrl) return undefined;
    const entities = [...new Set(readEmbeddedEntities(file.metadata?.embeddedEntities) ?? [])];
    const owners: Array<string | undefined> = entities.length > 0 ? entities : [undefined];
    const deleteOwned = async (entityId?: string): Promise<void> => {
      try {
        await httpClient.delete(`${baseUrl}/documents`, {
          headers: {
            Authorization: `Bearer ${generateToken(req.user.id)}`,
            'Content-Type': 'application/json',
            accept: 'application/json',
          },
          /* The entity travels as a query parameter, never in the body: an older
           * rag_api ignores a parameter it does not declare, so a new client
           * stays inert against it rather than breaking. */
          ...(entityId ? { params: { entity_id: entityId } } : {}),
          data: [file.file_id],
        });
      } catch (error) {
        /* A missing document means the chunks are gone for a user-owned file,
         * but means the opposite for an entity-owned one: the delete matched
         * nothing under that owner, so the chunks are still there. */
        if (!entityId && isMissingStorageError(error)) {
          return;
        }
        logger.warn(
          `Error deleting vectors for file ${file.file_id}${
            entityId ? ` scoped to entity ${entityId}` : ''
          }; its embedded chunks may remain`,
        );
        throw error;
      }
    };
    const settled = await Promise.allSettled(owners.map(deleteOwned));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return { deleted: true };
  };
}
