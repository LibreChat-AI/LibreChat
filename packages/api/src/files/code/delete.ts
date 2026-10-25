import { EModelEndpoint, getCodeEnvRefs } from 'librechat-data-provider';
import type { ClearFileCodeEnvRefsParams } from '@librechat/data-schemas';
import type { CodeEnvReferenceSet } from 'librechat-data-provider';
import type { AxiosRequestConfig } from 'axios';
import type {
  getCodeExecutionBaseUrl,
  createCodeExecutionRouteKey,
  codeExecutionHeaders,
} from '~/agents/execution';
import type { getCodeApiAuthHeaders } from '~/auth/codeapi';
import type { buildCodeEnvDownloadQuery } from './identity';
import type { ServerRequest } from '~/types';
import { getSafeErrorMetadata } from '../../utils/errors';

/** Deletes and reconciles each confirmed copy before another route can fail. */
export function createCodeFileDeleter({
  httpClient,
  getAuthHeaders,
  getBaseUrl,
  routeKey,
  profileHeaders,
  downloadQuery,
  clearFileCodeEnvRefs,
  logger,
  httpAgent,
  httpsAgent,
}: {
  httpClient: (config: AxiosRequestConfig) => Promise<unknown>;
  getAuthHeaders: typeof getCodeApiAuthHeaders;
  getBaseUrl: typeof getCodeExecutionBaseUrl;
  routeKey: typeof createCodeExecutionRouteKey;
  profileHeaders: typeof codeExecutionHeaders;
  downloadQuery: typeof buildCodeEnvDownloadQuery;
  clearFileCodeEnvRefs: (data: ClearFileCodeEnvRefsParams) => Promise<boolean>;
  logger: { warn: (message: string, metadata?: unknown) => void };
  httpAgent?: AxiosRequestConfig['httpAgent'];
  httpsAgent?: AxiosRequestConfig['httpsAgent'];
}): (
  req: ServerRequest,
  file: {
    file_id?: string;
    user?: { toString(): string };
    tenantId?: string;
    metadata?: CodeEnvReferenceSet;
  },
) => Promise<{ deleted: true } | undefined> {
  return async (req, file) => {
    const refs = getCodeEnvRefs(file.metadata);
    if (refs.length === 0) return undefined;
    let skipped = false;
    for (const [executionRouteKey, ref] of refs) {
      const executionProfile = ref.executionProfile ?? 'default';
      const environments =
        req.config?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments;
      const environment = environments?.find(
        (candidate) => routeKey(executionProfile, candidate) === executionRouteKey,
      );
      if (
        executionProfile === 'stateful' &&
        executionRouteKey !== executionProfile &&
        !environment
      ) {
        skipped = true;
        continue;
      }
      let baseUrl: string;
      try {
        baseUrl = getBaseUrl(executionProfile, environment);
      } catch (error) {
        if (
          executionProfile !== 'stateful' ||
          executionRouteKey !== executionProfile ||
          environment
        ) {
          throw error;
        }
        skipped = true;
        continue;
      }
      const query = downloadQuery({
        kind: ref.kind,
        id: ref.id,
        ...(ref.kind === 'skill' ? { version: ref.version } : {}),
      });
      const bridgeWorkerId = environment?.workerId ?? environment?.pairing?.workerId;
      const headers = await getAuthHeaders(req, bridgeWorkerId);
      try {
        await httpClient({
          method: 'delete',
          url: `${baseUrl}/files/${ref.storage_session_id}/${ref.file_id}${query}`,
          headers: {
            'User-Agent': 'LibreChat/1.0',
            ...headers,
            ...profileHeaders({ executionProfile, bridgeWorkerId }),
          },
          httpAgent,
          httpsAgent,
          timeout: 15000,
        });
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { error?: string } } })
          ?.response;
        if (response?.status !== 404) {
          if (response?.status === 409 && response.data?.error === 'execution_profile_mismatch') {
            skipped = true;
            continue;
          }
          throw error;
        }
        logger.warn('Code storage copy already absent during delete', getSafeErrorMetadata(error));
      }
      if (file.file_id) {
        try {
          if (
            !(await clearFileCodeEnvRefs({
              file_id: file.file_id,
              userId: file.user?.toString() ?? req.user?.id ?? '',
              tenantId: file.tenantId,
              refs: [{ routeKey: executionRouteKey, ref }],
            }))
          ) {
            throw new Error('Code reference snapshot changed');
          }
        } catch (error) {
          throw new Error('Code storage reconciliation failed', { cause: error });
        }
      }
    }
    return skipped ? undefined : { deleted: true };
  };
}
