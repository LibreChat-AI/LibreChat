import { pipeline } from 'node:stream/promises';
import { EModelEndpoint, getEndpointFileConfig, mergeFileConfig } from 'librechat-data-provider';
import type { Readable } from 'node:stream';
import type { AxiosInstance } from 'axios';
import type { RunArtifactDescriptor } from './publication';
import type { CodeOutputTypeDetector } from './inspection';
import type { ServerRequest } from '~/types';
import {
  assertRemoteFileContentLength,
  createRemoteFileByteLimitTransform,
  DEFAULT_REMOTE_FILE_FETCH_TIMEOUT_MS,
} from '~/storage/url';
import {
  getBoundedCodeOutputByteLimit,
  preflightCodeOutputBatch,
  CODE_OUTPUT_PREFLIGHT_MAX_COUNT,
} from './preflight';
import { codeServerHttpAgent, codeServerHttpsAgent } from '~/utils/code';
import { prepareCodeOutputBufferForInspection } from './inspection';
import { codeExecutionHeaders } from '~/agents/execution';
import { buildCodeEnvDownloadQuery } from './identity';

export interface RunArtifactSnapshotAdapter {
  open: (artifact: RunArtifactDescriptor, signal?: AbortSignal) => Promise<Readable>;
  prepare: (
    artifact: RunArtifactDescriptor,
    buffer: Buffer,
    signal?: AbortSignal,
  ) => Promise<Buffer>;
}

/** Downloads privately once; publication inspects that immutable copy with the normal file policy. */
export function createRunArtifactSnapshotAdapter({
  req,
  request,
  getAuthHeaders,
  getBaseURL,
  determineFileType,
}: {
  req: ServerRequest;
  request: AxiosInstance;
  getAuthHeaders: (req: ServerRequest, bridgeWorkerId?: string) => Promise<Record<string, string>>;
  getBaseURL: (profile: 'default' | 'stateful') => string;
  determineFileType: CodeOutputTypeDetector;
}): RunArtifactSnapshotAdapter {
  const fileConfig = mergeFileConfig(req.config?.fileConfig);
  const endpointLimits = getEndpointFileConfig({ fileConfig, endpoint: EModelEndpoint.agents });
  const limits = {
    fileLimit: endpointLimits.fileLimit ?? CODE_OUTPUT_PREFLIGHT_MAX_COUNT,
    fileSizeLimit: getBoundedCodeOutputByteLimit(
      endpointLimits.fileSizeLimit ?? fileConfig.serverFileSizeLimit,
    ),
    totalSizeLimit: getBoundedCodeOutputByteLimit(endpointLimits.totalSizeLimit),
  };
  const fileSizeLimit = Math.min(limits.fileSizeLimit, limits.totalSizeLimit);

  async function open(artifact: RunArtifactDescriptor, signal?: AbortSignal): Promise<Readable> {
    signal?.throwIfAborted();
    const userId = req.user?.id;
    if (!userId) throw new Error('A user identity is required to snapshot generated files.');
    if ([artifact.id, artifact.sessionId].some((id) => !id || id === '.' || id === '..')) {
      throw new Error('The generated artifact has no valid sandbox identity.');
    }
    const {
      executionProfile = 'default',
      bridgeWorkerId,
      baseUrl,
    } = artifact.codeExecutionContext ?? {};
    const baseURL = (baseUrl ?? getBaseURL(executionProfile)).replace(/\/+$/, '');
    const authHeaders = await getAuthHeaders(req, bridgeWorkerId);
    signal?.throwIfAborted();
    const query = buildCodeEnvDownloadQuery({ kind: 'user', id: userId });
    const response = await request<Readable>({
      method: 'get',
      url: `${baseURL}/download/${encodeURIComponent(artifact.sessionId)}/${encodeURIComponent(artifact.id)}${query}`,
      responseType: 'stream',
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
        ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: DEFAULT_REMOTE_FILE_FETCH_TIMEOUT_MS,
      maxContentLength: fileSizeLimit,
      maxBodyLength: fileSizeLimit,
      signal,
    });
    try {
      signal?.throwIfAborted();
      assertRemoteFileContentLength(
        { 'content-length': String(response.headers['content-length'] ?? '') },
        fileSizeLimit,
      );
      const bounded = createRemoteFileByteLimitTransform(fileSizeLimit);
      // Pipeline forwards source errors and consumer cancellation in both directions.
      // Its rejection is also delivered by the returned stream to the snapshot store.
      void pipeline(response.data, bounded, { signal }).catch(() => undefined);
      return bounded;
    } catch (error) {
      response.data.destroy();
      throw error;
    }
  }

  async function prepare(
    artifact: RunArtifactDescriptor,
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    signal?.throwIfAborted();
    const entries = await preflightCodeOutputBatch({
      filters: req.config?.filters,
      artifact: {
        session_id: artifact.sessionId,
        files: [{ id: artifact.id, name: artifact.name }],
      },
      limits,
      prepare: ({ maxBytes, inspectContent }) =>
        prepareCodeOutputBufferForInspection({
          buffer,
          name: artifact.name,
          fileSizeLimit: Math.min(fileSizeLimit, maxBytes),
          inspectContent,
          determineFileType,
        }),
    });
    signal?.throwIfAborted();
    const preparedBuffer = entries[0]?.preparedBuffer;
    if (!preparedBuffer || entries[0]?.downloadFallback) {
      throw new Error('The private artifact snapshot could not pass file inspection.');
    }
    return preparedBuffer;
  }

  return { open, prepare };
}
