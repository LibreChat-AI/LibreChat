import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { logger } from '@librechat/data-schemas';
import { getCodeBaseURL } from '@librechat/agents';
import {
  FileSources,
  getCodeEnvRefs,
  mergeCodeEnvRef,
  resolveSandboxFilename,
} from 'librechat-data-provider';
import type { CodeEnvRef, CodeEnvRefMap, TFile } from 'librechat-data-provider';
import type { Readable } from 'node:stream';
import type { CodeEnvIdentity } from '~/files/code/identity';
import type { CodeApiRateLimitBudget } from '~/utils';
import type { ServerRequest } from '~/types';
import {
  logAxiosError,
  createAxiosInstance,
  createCodeApiRateLimitBudget,
  codeServerHttpAgent,
  codeServerHttpsAgent,
  getCodeApiUploadOptions,
  withCodeApiUploadRecovery,
} from '~/utils';
import { getCodeEnvUploadFilename, getUploadedCodeEnvFilename } from '../code/form';
import { buildCodeEnvIdentityParams } from '~/files/code/identity';
import { getCodeApiAuthHeaders } from '~/auth/codeapi';
import { resolveDownloadPath } from '~/storage/path';

/** Storage strategy lookup, injected so this module stays free of the api workspace. */
export interface ProvisionDeps {
  getStrategyFunctions: (source: string) => {
    getDownloadStream?: (
      req: ServerRequest,
      filepath: string,
      options?: { signal?: AbortSignal },
    ) => Promise<Readable>;
    handleFileUpload?: (params: Record<string, unknown>) => Promise<{
      storage_session_id: string;
      file_id: string;
      filename?: string;
    }>;
  };
  uploadVectors: (params: {
    req: ServerRequest;
    file: { path: string; originalname: string; mimetype?: string; size?: number };
    file_id: string;
    entity_id?: string;
    signal?: AbortSignal;
  }) => Promise<{ embedded?: boolean } | undefined>;
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    throwError?: boolean;
  }) => Promise<Record<string, string | undefined>>;
}

/** The Code API deployment an agent resolved for this turn. */
export interface CodeExecutionRoute {
  baseUrl?: string;
  executionProfile?: 'default' | 'stateful';
  executionRouteKey?: string;
}

/** Deferred database write produced by a successful provisioning call. */
export interface ProvisionFileUpdate {
  file_id: string;
  metadata?: Record<string, unknown>;
  embedded?: boolean;
}

/** One route pointer, written on its own so concurrent routes do not overwrite each other. */
export interface CodeEnvRefUpdate {
  file_id: string;
  routeKey: string;
  ref: CodeEnvRef;
  legacyRef?: CodeEnvRef;
}

/** Merged code-environment pointers written after a successful sandbox upload. */
export interface CodeEnvReferenceSetResult {
  codeEnvRef?: CodeEnvRef;
  codeEnvRefs?: CodeEnvRefMap;
}

export interface ProvisionService {
  loadCodeApiKey: (userId: string) => Promise<string | undefined>;
  provisionToCodeEnv: (params: {
    req: ServerRequest;
    file: TFile;
    entity_id?: string;
    route?: CodeExecutionRoute;
    sandboxFilename?: string;
    signal?: AbortSignal;
    rateLimitBudget?: CodeApiRateLimitBudget;
  }) => Promise<{
    referenceSet: CodeEnvReferenceSetResult;
    refUpdate: CodeEnvRefUpdate;
    /** The name the sandbox stored it under, which a converted image renames. */
    sandboxFilename: string;
  }>;
  provisionToVectorDB: (params: {
    req: ServerRequest;
    file: TFile;
    entity_id?: string;
    existingStream?: Readable;
    signal?: AbortSignal;
  }) => Promise<{ embedded: boolean; fileUpdate: ProvisionFileUpdate | null }>;
  checkCodeEnvFileAlive: (params: {
    file: TFile;
    apiKey?: string;
    req?: ServerRequest;
  }) => Promise<boolean>;
  checkSessionsAlive: (params: {
    files: TFile[];
    apiKey?: string;
    req?: ServerRequest;
    staleSafeWindowMs?: number;
    /** Deployment this turn runs on. Refs are deployment-local, so a ref is probed
     *  against the Code API that issued it, not against the default one. */
    baseURL?: string;
    routeKey?: string;
  }) => Promise<Set<string>>;
}

/**
 * Provisioning service for the code environment and vector store.
 *
 * Storage strategies, vector upload, and credential lookup live in the api workspace,
 * so they are injected rather than imported: that keeps the logic here, where it is
 * type checked, and leaves only wiring on the other side.
 */
/** The reference a given deployment issued, across both the per-route map and the
 *  legacy single pointer. A ref from another deployment answers for another Code API. */
const codeEnvRefForRoute = (file: TFile, routeKey: string): CodeEnvRef | undefined =>
  getCodeEnvRefs(file.metadata).find(([key]) => key === routeKey)?.[1];

export function createProvisionService({
  getStrategyFunctions,
  uploadVectors,
  loadAuthValues,
}: ProvisionDeps): ProvisionService {
  /* Created on first use rather than at module load: this module is pulled into the
   * OpenAI-compatible controllers, whose tests partially mock @librechat/api, and a
   * load-time call would throw before any provisioning is even requested. */
  let axiosInstance;
  const getAxios = () => (axiosInstance ??= createAxiosInstance());

  /* Sources whose `getDownloadStream` takes `(req, filepath)` and returns a readable.
   * Others diverge: `openai` takes `(file_id, client)` and `execute_code` takes
   * `(fileIdentifier, identity, req)` returning an Axios response, so calling them
   * through this contract fails. An allowlist keeps an unfamiliar source skipped
   * rather than mis-invoked. */
  const STORAGE_STREAM_SOURCES = new Set([
    FileSources.local,
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ]);

  /** Resolves a storage download stream, or null when the source uses a different contract. */
  async function getStorageStream(
    file: TFile,
    req: ServerRequest,
    signal?: AbortSignal,
  ): Promise<Readable | null> {
    if (file.source == null || !STORAGE_STREAM_SOURCES.has(file.source)) {
      logger.warn(
        `[provision] Cannot stream "${file.filename}" (${file.file_id}) from source "${file.source}": unsupported download contract`,
      );
      return null;
    }
    const { getDownloadStream } = getStrategyFunctions(file.source as string);
    if (!getDownloadStream) {
      return null;
    }
    signal?.throwIfAborted();
    const stream = await getDownloadStream(req, resolveDownloadPath(file), { signal });
    if (signal?.aborted) {
      stream.destroy(signal.reason instanceof Error ? signal.reason : undefined);
      signal.throwIfAborted();
    }
    return stream;
  }

  /** Uses managed bearer auth when available, otherwise the configured legacy API key. */
  async function buildCodeApiHeaders({
    apiKey,
    req,
  }: {
    apiKey?: string;
    req?: ServerRequest;
  }): Promise<Record<string, string>> {
    const authHeaders = await getCodeApiAuthHeaders(req);
    return {
      'User-Agent': 'LibreChat/1.0',
      ...(authHeaders.Authorization == null && apiKey ? { 'X-API-Key': apiKey } : {}),
      ...authHeaders,
    };
  }

  /** Env var holding the code-execution API key (symmetric with LIBRECHAT_CODE_BASEURL). */
  const CODE_API_KEY_FIELD = 'LIBRECHAT_CODE_API_KEY';

  /**
   * Loads the code-execution API key for a user. Call once per request and pass the
   * result to checkSessionsAlive to avoid redundant lookups. Returns undefined when
   * no key is configured; JWT-mode code auth can still authorize provisioning.
   *
   * @param {string} userId
   * @returns {Promise<string | undefined>} The code-execution API key, if configured
   */
  async function loadCodeApiKey(userId: string): Promise<string | undefined> {
    const result = await loadAuthValues({
      userId,
      authFields: [CODE_API_KEY_FIELD],
      throwError: false,
    });
    return result[CODE_API_KEY_FIELD];
  }

  /**
   * Provisions a file to the code execution environment.
   * Gets a read stream from our storage and uploads to the code env, persisting
   * the resulting `codeEnvRef` so downstream readers (primeFiles, code env
   * categorization) can locate the sandbox copy on subsequent turns.
   *
   * @param {object} params
   * @param {object} params.req - Express request object (needs req.user.id)
   * @param {import('librechat-data-provider').TFile} params.file - The file record from DB
   * @param {string} [params.entity_id] - Optional entity ID (agent_id); when present the ref
   *   is scoped to `kind: 'agent'`, otherwise it falls back to `kind: 'user'`.
   * @returns {Promise<{ referenceSet: { codeEnvRef: object, codeEnvRefs: object }, fileUpdate: object }>}
   *   Merged pointers plus the deferred DB update
   */
  async function provisionToCodeEnv({
    req,
    file,
    entity_id,
    route,
    sandboxFilename: requestedSandboxFilename,
    signal,
    rateLimitBudget,
  }: {
    req: ServerRequest;
    file: TFile;
    entity_id?: string;
    route?: CodeExecutionRoute;
    sandboxFilename?: string;
    signal?: AbortSignal;
    rateLimitBudget?: CodeApiRateLimitBudget;
  }) {
    signal?.throwIfAborted();
    const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(FileSources.execute_code);
    if (!uploadCodeEnvFile) {
      throw new Error('Code environment upload strategy is unavailable');
    }
    const kind: 'agent' | 'user' = entity_id ? 'agent' : 'user';
    const id = entity_id ?? (req.user?.id as string);

    /* Upload to the deployment this agent actually resolved. Hard-coding the default
     * meant a stateful agent's file was uploaded to the wrong Code API and then had to
     * be re-uploaded by priming, and a deployment whose only healthy Code API is the
     * configured stateful one could not provision at all. */
    const executionProfile = route?.executionProfile ?? 'default';
    const sandboxFilename = getCodeEnvUploadFilename(
      resolveSandboxFilename(requestedSandboxFilename ?? file.filename, file.type),
    );
    const uploadOptions = getCodeApiUploadOptions(
      req,
      route?.executionRouteKey ?? route?.baseUrl ?? executionProfile,
    );
    const uploaded = await withCodeApiUploadRecovery({
      registry: req.app.locals.codeApiUploadRegistry,
      scope: uploadOptions.scope,
      concurrency: uploadOptions.concurrency,
      label: `uploading "${file.filename}" to the code environment`,
      budget: rateLimitBudget ?? createCodeApiRateLimitBudget(uploadOptions.retryWaitMs),
      signal,
      onWait: (waitMs) =>
        logger.warn(
          `[provisionToCodeEnv] Rate-limited uploading file ${file.file_id}; retrying in ${waitMs}ms`,
        ),
      openSource: async () => {
        const stream = await getStorageStream(file, req, signal);
        signal?.throwIfAborted();
        if (!stream) {
          throw new Error(
            `Cannot provision file "${file.filename}" to code env: storage source "${file.source}" does not support download streams`,
          );
        }
        return stream;
      },
      upload: (stream) =>
        uploadCodeEnvFile({
          req,
          stream,
          filename: sandboxFilename,
          kind,
          id,
          ...(route?.baseUrl ? { codeApiBaseUrl: route.baseUrl } : {}),
          executionProfile,
          signal,
        }),
    });
    signal?.throwIfAborted();

    /* Merge rather than overwrite: the eager upload path persists the same shape via
     * mergeCodeEnvRef, so both the legacy pointer and the route-keyed map stay in sync
     * and pointers for other Code API routes survive re-provisioning. */
    const storedSandboxFilename = getUploadedCodeEnvFilename(uploaded, sandboxFilename);
    const ref: CodeEnvRef = {
      kind,
      id,
      storage_session_id: uploaded.storage_session_id,
      file_id: uploaded.file_id,
      executionProfile,
      ...(route?.executionRouteKey ? { executionRouteKey: route.executionRouteKey } : {}),
      provisionedAt: Date.now(),
      sandboxFilename: storedSandboxFilename,
    };
    const referenceSet = mergeCodeEnvRef(file.metadata, ref);
    const routeKey = route?.executionRouteKey ?? executionProfile;

    logger.debug(
      `[provisionToCodeEnv] Provisioned file "${file.filename}" (${file.file_id}) to code env`,
    );

    return {
      referenceSet,
      sandboxFilename: storedSandboxFilename,
      refUpdate: {
        file_id: file.file_id,
        routeKey,
        ref,
        ...(referenceSet.codeEnvRef ? { legacyRef: referenceSet.codeEnvRef } : {}),
      },
    };
  }

  /**
   * Provisions a file to the vector DB for file_search/RAG.
   * Gets the file from our storage and uploads vectors/embeddings.
   *
   * @param {object} params
   * @param {object} params.req - Express request object
   * @param {import('librechat-data-provider').TFile} params.file - The file record from DB
   * @param {string} [params.entity_id] - Optional entity ID (agent_id)
   * @param {import('stream').Readable} [params.existingStream] - Pre-fetched download stream (avoids duplicate storage fetch)
   * @returns {Promise<{ embedded: boolean, fileUpdate: object | null }>} Result with deferred DB update
   */
  async function provisionToVectorDB({
    req,
    file,
    entity_id,
    existingStream,
    signal,
  }: {
    req: ServerRequest;
    file: TFile;
    entity_id?: string;
    existingStream?: Readable;
    signal?: AbortSignal;
  }): Promise<{ embedded: boolean; fileUpdate: { file_id: string; embedded?: boolean } | null }> {
    /* Unique per attempt: two concurrent requests provisioning the same file_id would
     * otherwise share one path, and the first to finish unlinks it while the second is
     * still streaming into uploadVectors. */
    const tmpPath = path.join(
      os.tmpdir(),
      `provision-${file.file_id}-${randomUUID()}${path.extname(file.filename)}`,
    );

    try {
      signal?.throwIfAborted();
      let stream: Readable | undefined = existingStream;
      if (!stream) {
        stream = (await getStorageStream(file, req, signal)) ?? undefined;
        if (!stream) {
          throw new Error(
            `Cannot provision file "${file.filename}" to vector DB: storage source "${file.source}" does not support download streams`,
          );
        }
      }

      // uploadVectors expects a file-like object with a `path` property for fs.createReadStream.
      // Since we're provisioning from storage (not a multer upload), we stream to a temp file first.
      await pipeline(stream, fs.createWriteStream(tmpPath), { signal });

      const tempFile = {
        path: tmpPath,
        originalname: file.filename,
        mimetype: file.type,
        size: file.bytes,
      };

      const embeddingResult = await uploadVectors({
        req,
        file: tempFile,
        file_id: file.file_id,
        entity_id,
        signal,
      });
      signal?.throwIfAborted();

      const embedded = embeddingResult?.embedded ?? false;

      logger.debug(
        `[provisionToVectorDB] Provisioned file "${file.filename}" (${file.file_id}) to vector DB, embedded=${embedded}`,
      );

      return {
        embedded,
        fileUpdate: embedded ? { file_id: file.file_id, embedded } : null,
      };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Check if a single code env file is still alive by querying its session.
   *
   * @param {object} params
   * @param {import('librechat-data-provider').TFile} params.file - File with metadata.codeEnvRef
   * @param {string} [params.apiKey] - Legacy CODE_API_KEY, when configured
   * @param {object} [params.req] - Request used to mint JWT code auth, when enabled
   * @returns {Promise<boolean>} true if the file is still accessible in the code env
   */
  async function checkCodeEnvFileAlive({
    file,
    apiKey,
    req,
  }: {
    file: TFile;
    apiKey?: string;
    req?: ServerRequest;
  }): Promise<boolean> {
    const ref = file.metadata?.codeEnvRef;
    if (!ref?.storage_session_id || !ref?.file_id) {
      return false;
    }

    try {
      const baseURL = getCodeBaseURL();
      const response = await getAxios()({
        method: 'get',
        url: `${baseURL}/files/${ref.storage_session_id}`,
        params: { detail: 'summary' },
        headers: await buildCodeApiHeaders({ apiKey, req }),
        httpAgent: codeServerHttpAgent,
        httpsAgent: codeServerHttpsAgent,
        timeout: 5000,
      });

      const found = (response.data as Array<{ fileId?: string }> | undefined)?.some(
        (f) => f.fileId === ref.file_id,
      );
      return !!found;
    } catch (error) {
      logAxiosError({
        message: `[checkCodeEnvFileAlive] Error checking file "${file.filename}": ${(error as Error).message}`,
        error,
      });
      return false;
    }
  }

  /**
   * Batch-check code env file liveness by `storage_session_id`.
   * Groups files by session, makes one API call per session.
   *
   * @param {object} params
   * @param {import('librechat-data-provider').TFile[]} params.files - Files with metadata.codeEnvRef
   * @param {string} [params.apiKey] - Pre-loaded legacy CODE_API_KEY, when configured
   * @param {object} [params.req] - Request used to mint JWT code auth, when enabled
   * @param {number} [params.staleSafeWindowMs=21600000] - Skip the live check if the file was provisioned to the code env within this window (default 6h)
   * @returns {Promise<Set<string>>} file_ids that are not known to be expired: confirmed
   *   alive, within the safe window, or unverifiable because the probe itself failed
   */
  /** A definitive not-found from the Code API, as opposed to a transient probe failure. */
  function isSessionNotFound(error: unknown): boolean {
    const { response, status } = (error ?? {}) as {
      response?: { status?: number };
      status?: number;
    };
    return (response?.status ?? status) === 404;
  }

  async function checkSessionsAlive({
    files,
    apiKey,
    req,
    staleSafeWindowMs = 6 * 60 * 60 * 1000,
    baseURL: routeBaseURL,
    routeKey,
  }: {
    files: TFile[];
    apiKey?: string;
    req?: ServerRequest;
    staleSafeWindowMs?: number;
    baseURL?: string;
    routeKey?: string;
  }): Promise<Set<string>> {
    const aliveFileIds = new Set<string>();
    const now = Date.now();

    /* Group by session AND resource identity, skipping recently-updated files. Codeapi
     * reconstructs the session key from kind and id for shared kinds, so a probe that
     * omits them asks about the requester's own bucket and 404s on a live agent
     * session, which reads here as expiry and forces a needless re-upload. */
    const sessionGroups = new Map<
      string,
      {
        session_id: string;
        identity: CodeEnvIdentity;
        entries: Array<{ file_id: string; remoteFileId: string }>;
      }
    >();

    for (const file of files) {
      const ref = routeKey != null ? codeEnvRefForRoute(file, routeKey) : file.metadata?.codeEnvRef;
      if (!ref?.storage_session_id || !ref?.file_id) {
        continue;
      }

      // Trust only the code-env upload timestamp, not `updatedAt` (bumped by usage,
      // e.g. updateFilesUsage on resend); a usage-touched file may still have an
      // expired sandbox session. Refs without a marker fall through to a live check.
      const provisionedAt = ref.provisionedAt ?? 0;
      if (provisionedAt && now - provisionedAt < staleSafeWindowMs) {
        aliveFileIds.add(file.file_id);
        continue;
      }

      const identity: CodeEnvIdentity = {
        kind: ref.kind,
        id: ref.id,
        ...(ref.kind === 'skill' ? { version: ref.version } : {}),
      };
      const groupKey = `${ref.storage_session_id}\0${identity.kind}\0${identity.id}\0${
        identity.version ?? ''
      }`;
      let group = sessionGroups.get(groupKey);
      if (!group) {
        group = { session_id: ref.storage_session_id, identity, entries: [] };
        sessionGroups.set(groupKey, group);
      }
      group.entries.push({ file_id: file.file_id, remoteFileId: ref.file_id });
    }

    // One API call per session (in parallel)
    const baseURL = routeBaseURL ?? getCodeBaseURL();
    /* Minting can fail on its own, for example when the request carries no tenant
     * context. That is an unverifiable probe, not an expired file, so it is handled
     * like any other probe failure: every ref stays alive rather than the rejection
     * propagating out and aborting initialization for the whole turn. */
    let headers;
    try {
      headers = await buildCodeApiHeaders({ apiKey, req });
    } catch (error) {
      logger.warn(
        `[checkSessionsAlive] Could not build Code API auth headers; treating ${files.length} reference(s) as unverified: ${(error as Error).message}`,
      );
      for (const file of files) {
        if (file?.file_id) {
          aliveFileIds.add(file.file_id);
        }
      }
      return aliveFileIds;
    }
    const sessionChecks = Array.from(sessionGroups.values()).map(
      async ({ session_id, identity, entries: fileEntries }) => {
        try {
          const response = await getAxios()({
            method: 'get',
            url: `${baseURL}/files/${session_id}`,
            params: { detail: 'summary', ...buildCodeEnvIdentityParams(identity) },
            headers,
            httpAgent: codeServerHttpAgent,
            httpsAgent: codeServerHttpsAgent,
            timeout: 5000,
          });

          const remoteFiles = response.data ?? [];
          for (const { file_id, remoteFileId } of fileEntries) {
            if (
              (remoteFiles as Array<{ fileId?: string }>).some((f) => f.fileId === remoteFileId)
            ) {
              aliveFileIds.add(file_id);
            }
          }
        } catch (error) {
          logAxiosError({
            message: `[checkSessionsAlive] Error checking session "${session_id}": ${(error as Error).message}`,
            error,
          });
          /* A 404 is the Code API answering that the session is gone, so its files are
           * expired and a replacement upload should be queued. Every other failure means
           * unknown: a timeout or 5xx would otherwise clear a live ref and force a
           * re-upload that the same outage will likely fail too. */
          if (isSessionNotFound(error)) {
            return;
          }
          for (const { file_id } of fileEntries) {
            aliveFileIds.add(file_id);
          }
        }
      },
    );

    await Promise.allSettled(sessionChecks);
    return aliveFileIds;
  }
  return {
    loadCodeApiKey,
    provisionToCodeEnv,
    provisionToVectorDB,
    checkCodeEnvFileAlive,
    checkSessionsAlive,
  };
}
