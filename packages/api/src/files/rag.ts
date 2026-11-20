import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import type { TFileConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { AxiosInstance } from 'axios';
import { outboundRequestBudget, getOutboundTimeoutMs } from '~/utils/timeouts';
import { createConcurrencyLimiter } from '~/utils/promise';
import { generateShortLivedToken } from '~/crypto/jwt';
import { getSafeErrorMetadata } from '~/utils/errors';

interface DeleteRagFileParams {
  /** The user ID. Required for authentication. If not provided, the function returns false and logs an error. */
  userId: string;
  /** The `timeouts` block of the app config; the default RAG budget applies when absent. */
  timeouts?: AppConfig['timeouts'];
  fileConfig?: Pick<TFileConfig, 'vectorOwnershipTrackingStart' | 'vectorDeletionConcurrency'>;
  /** The file object. Must have `embedded` and `file_id` properties. */
  file: {
    file_id: string;
    embedded?: boolean;
    context?: string;
    embeddingOwnersComplete?: boolean;
    embeddingOwnersTrackedAt?: Date | string;
    /** Internal rollback descriptor, never persisted on File. */
    unrecordedUpload?: true;
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
 * @param params.timeouts - Configured outbound budgets; defaults apply when omitted.
 * @param params.file - The file object. Must have `embedded` and `file_id` properties.
 * @returns Returns true if deletion was successful or skipped, false if there was an error.
 */
export async function deleteRagFile({
  userId,
  file,
  fileConfig,
  timeouts,
}: DeleteRagFileParams): Promise<boolean> {
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
      ownershipTrackingStart: fileConfig?.vectorOwnershipTrackingStart,
      namespaceConcurrency: fileConfig?.vectorDeletionConcurrency,
    })({ user: { id: userId }, config: { timeouts } }, file);
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
  namespaceConcurrency = 4,
  ownershipTrackingStart,
}: {
  baseUrl?: string;
  httpClient: Pick<AxiosInstance, 'delete' | 'get'>;
  generateToken: (userId: string) => string;
  namespaceConcurrency?: number;
  ownershipTrackingStart?: string;
}): (
  req: { user: { id: string }; config?: Pick<AppConfig, 'timeouts'> },
  file: DeleteRagFileParams['file'],
) => Promise<{ deleted: true } | undefined> {
  const limit = createConcurrencyLimiter(namespaceConcurrency);
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
    if (file.embeddingOwnersComplete !== true) {
      throw new Error('Complete vector ownership must be recorded before deletion');
    }
    if (file.unrecordedUpload !== true) {
      const start = ownershipTrackingStart == null ? NaN : Date.parse(ownershipTrackingStart);
      const tracked = file.embeddingOwnersTrackedAt;
      let trackedAt = NaN;
      if (tracked instanceof Date) trackedAt = tracked.getTime();
      else if (typeof tracked === 'string') trackedAt = Date.parse(tracked);
      const now = Date.now();
      // Old writers can preserve the boolean while dropping owners. Exclude the overlap era.
      if (
        !Number.isFinite(start) ||
        start > now ||
        !Number.isFinite(trackedAt) ||
        trackedAt < start ||
        trackedAt > now
      ) {
        throw new Error('Vector ownership predates the safe writer rollout');
      }
    }
    const headers = () => ({
      Authorization: `Bearer ${generateToken(req.user.id)}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    });
    // Unscoped embeds can live in RAG's public scope even when metadata records a user ID.
    const namespaces = [...new Set(entities ?? []), undefined];
    const results = await Promise.allSettled(
      namespaces.map((entity_id) =>
        limit(async () => {
          const config = entity_id ? { params: { entity_id } } : {};
          try {
            await httpClient.delete(`${baseUrl}/documents`, {
              ...config,
              headers: headers(),
              data: [file.file_id],
              ...outboundRequestBudget(getOutboundTimeoutMs(req.config, 'ragMs'), 'ragMs'),
            });
          } catch (error) {
            // A 404 can mean a wrong scope. Only a successful inventory can establish absence,
            // including when a prior attempt removed just some of the namespaces.
            if (getSafeErrorMetadata(error).status !== 404) throw error;
            const { data } = await httpClient.get<string[]>(`${baseUrl}/ids`, {
              ...config,
              headers: headers(),
              ...outboundRequestBudget(getOutboundTimeoutMs(req.config, 'ragMs'), 'ragMs'),
            });
            if (
              !Array.isArray(data) ||
              data.some((id) => typeof id !== 'string') ||
              data.includes(file.file_id)
            ) {
              throw new Error('Vector absence was not confirmed');
            }
          }
        }),
      ),
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
