const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { getCodeBaseURL } = require('@librechat/agents');
const {
  withTimeout,
  getBasePath,
  logAxiosError,
  hasOfficeHtmlPath,
  sanitizeArtifactPath,
  flattenArtifactPath,
  createAxiosInstance,
  getCodeApiAuthHeaders,
  getCodeApiUploadOptions,
  withCodeApiRateLimit,
  withCodeApiUploadRecovery,
  classifyCodeArtifact,
  isMissingSandboxPathError,
  parseSandboxImageChunk,
  readWindowedSandboxImage,
  createCodeApiRateLimitBudget,
  codeServerHttpAgent,
  codeServerHttpsAgent,
  extractCodeArtifactText,
  extractCodeArtifactRawText,
  extractCodeArtifactInspectionText,
  prepareCodeOutputBufferForInspection,
  getBoundedCodeOutputByteLimit,
  getExtractedTextFormat,
  getStorageMetadata,
  getCodeExecutionBaseUrl,
  buildCodeEnvDownloadQuery,
  codeExecutionHeaders,
  executeWorkspaceTool,
  selectCodeFiles,
  getCodeFileInfo,
  getCodeFileContextLine,
  appendCodeFileContextLine,
  getUploadedCodeEnvFilename,
  checkCodeFileActive: checkIfActive,
  CODE_OUTPUT_PREFLIGHT_MAX_BYTES,
  CODE_OUTPUT_PREFLIGHT_MAX_COUNT,
  normalizeArtifactDeliveryFailure,
  processCodeOutput: processCodeOutputWithDeps,
  resolveDownloadPath,
} = require('@librechat/api');
const {
  megabyte,
  FileSources,
  EToolResources,
  EModelEndpoint,
  ErrorTypes,
  mergeFileConfig,
  mergeCodeEnvRef,
  getEndpointFileConfig,
} = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles, updateFile, claimCodeFile, commitCodeFile } = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { convertImage } = require('~/server/services/Files/images/convert');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { determineFileType } = require('~/server/utils');

const axios = createAxiosInstance();

/** Request-scoped references to buffers already fetched by artifact preflight.
 * The request object is the ownership boundary, and WeakMap keeps completed
 * requests from retaining generated-file bytes. */
const preparedCodeOutputBuffers = new WeakMap();

const codeOutputBufferKey = (routeKey, sessionId, fileId) => `${routeKey}\0${sessionId}\0${fileId}`;

const getCodeOutputRouteKey = ({ executionRouteKey, codeApiBaseUrl, executionProfile }) =>
  executionRouteKey ?? codeApiBaseUrl ?? executionProfile ?? 'default';

const normalizeSandboxArtifactName = (filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null;
  }
  if (filePath.includes('\\')) {
    return null;
  }
  const posixPath = filePath;
  let relativePath = posixPath;
  if (posixPath.startsWith('/mnt/data/')) {
    relativePath = posixPath.slice('/mnt/data/'.length);
  } else if (posixPath.startsWith('/')) {
    return null;
  }
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  const normalized = path.posix.normalize(relativePath).replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
};

const cachePreparedCodeOutputBuffer = ({
  req,
  id,
  name,
  session_id,
  buffer,
  codeApiBaseUrl,
  executionProfile,
  executionRouteKey,
}) => {
  if (
    !req ||
    (typeof req !== 'object' && typeof req !== 'function') ||
    typeof id !== 'string' ||
    typeof session_id !== 'string' ||
    !Buffer.isBuffer(buffer)
  ) {
    return;
  }
  let cache = preparedCodeOutputBuffers.get(req);
  if (!cache) {
    cache = { buffers: new Map(), totalBytes: 0 };
    preparedCodeOutputBuffers.set(req, cache);
  }
  const routeKey = getCodeOutputRouteKey({ executionRouteKey, codeApiBaseUrl, executionProfile });
  const key = codeOutputBufferKey(routeKey, session_id, id);
  const existing = cache.buffers.get(key);
  if (existing) {
    cache.totalBytes -= existing.buffer.length;
    cache.buffers.delete(key);
  }
  if (buffer.length > CODE_OUTPUT_PREFLIGHT_MAX_BYTES) {
    return;
  }
  while (
    cache.buffers.size >= CODE_OUTPUT_PREFLIGHT_MAX_COUNT ||
    cache.totalBytes + buffer.length > CODE_OUTPUT_PREFLIGHT_MAX_BYTES
  ) {
    const oldestKey = cache.buffers.keys().next().value;
    if (oldestKey == null) {
      break;
    }
    const oldest = cache.buffers.get(oldestKey);
    cache.buffers.delete(oldestKey);
    cache.totalBytes -= oldest.buffer.length;
  }
  cache.buffers.set(key, { name, buffer });
  cache.totalBytes += buffer.length;
};

const getPreparedCodeOutputBuffer = ({
  req,
  file_path,
  session_id,
  files,
  codeApiBaseUrl,
  executionProfile,
  executionRouteKey,
}) => {
  if (!req || (typeof req !== 'object' && typeof req !== 'function') || !Array.isArray(files)) {
    return null;
  }
  const cache = preparedCodeOutputBuffers.get(req);
  const requestedName = normalizeSandboxArtifactName(file_path);
  if (!cache || !requestedName) {
    return null;
  }

  const routeKey = getCodeOutputRouteKey({ executionRouteKey, codeApiBaseUrl, executionProfile });
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') {
      continue;
    }
    if (normalizeSandboxArtifactName(file.name) !== requestedName) {
      continue;
    }
    const storageSessionId = file.storage_session_id ?? file.session_id ?? session_id;
    if (typeof storageSessionId !== 'string') {
      continue;
    }
    const key = codeOutputBufferKey(routeKey, storageSessionId, file.id);
    const cached = cache.buffers.get(key);
    if (cached && normalizeSandboxArtifactName(cached.name) === requestedName) {
      cache.buffers.delete(key);
      cache.totalBytes -= cached.buffer.length;
      return cached.buffer;
    }
  }
  return null;
};

class CodeOutputDownloadLimitError extends Error {
  constructor(maxBytes) {
    super(`Generated file exceeds the ${maxBytes}-byte transport limit`);
    this.name = 'CodeOutputDownloadLimitError';
    this.code = 'CODE_OUTPUT_DOWNLOAD_LIMIT';
  }
}

const getCodeOutputFileSettings = (req) => {
  const mergedFileConfig = mergeFileConfig(req.config.fileConfig);
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergedFileConfig,
    endpoint: EModelEndpoint.agents,
  });
  const configuredFileSizeLimit =
    endpointFileConfig.fileSizeLimit ?? mergedFileConfig.serverFileSizeLimit;
  return {
    endpointFileConfig,
    fileSizeLimit: getBoundedCodeOutputByteLimit(configuredFileSizeLimit),
  };
};

const downloadCodeOutputBuffer = async ({
  req,
  id,
  session_id,
  maxBytes,
  codeApiBaseUrl,
  executionProfile = 'default',
  bridgeWorkerId,
}) => {
  const baseURL = codeApiBaseUrl ?? getCodeExecutionBaseUrl(executionProfile);
  const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
  const downloadQuery = buildCodeEnvDownloadQuery({ kind: 'user', id: req.user.id });
  let response;
  try {
    response = await axios({
      method: 'get',
      url: `${baseURL}/download/${session_id}/${id}${downloadQuery}`,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
        ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
      ...(Number.isFinite(maxBytes) && maxBytes >= 0
        ? {
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
          }
        : {}),
    });
  } catch (error) {
    if (
      Number.isFinite(maxBytes) &&
      maxBytes >= 0 &&
      /maxContentLength|maxBodyLength/i.test(error?.message ?? '')
    ) {
      throw new CodeOutputDownloadLimitError(maxBytes);
    }
    throw error;
  }
  const buffer = Buffer.from(response.data, 'binary');
  if (Number.isFinite(maxBytes) && maxBytes >= 0 && buffer.length > maxBytes) {
    throw new CodeOutputDownloadLimitError(maxBytes);
  }
  return buffer;
};

/**
 * Downloads and derives inspectable text for a code artifact without writing
 * file bytes or metadata. Direct tool calls use this to preflight every
 * artifact before allowing any one artifact to persist.
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.id
 * @param {string} params.name
 * @param {string} params.session_id
 * @param {number} [params.maxBytes] - Remaining aggregate inspection budget.
 * @param {string} [params.codeApiBaseUrl] - Trusted per-agent Code API endpoint.
 * @param {'default'|'stateful'} [params.executionProfile] - Trusted execution profile.
 * @param {string} [params.bridgeWorkerId] - Trusted worker selected for this execution.
 * @param {string} [params.executionRouteKey] - Trusted deployment-local route identity.
 */
const prepareCodeOutputForInspection = async ({
  req,
  id,
  name,
  session_id,
  maxBytes,
  inspectContent = true,
  codeApiBaseUrl,
  executionProfile = 'default',
  bridgeWorkerId,
  executionRouteKey,
}) => {
  const { fileSizeLimit } = getCodeOutputFileSettings(req);
  const transportLimit =
    Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.min(maxBytes, fileSizeLimit) : fileSizeLimit;
  const buffer = await downloadCodeOutputBuffer({
    req,
    id,
    session_id,
    maxBytes: transportLimit,
    codeApiBaseUrl,
    executionProfile,
    bridgeWorkerId,
  });
  cachePreparedCodeOutputBuffer({
    req,
    id,
    name,
    session_id,
    buffer,
    codeApiBaseUrl,
    executionProfile,
    executionRouteKey,
  });
  return prepareCodeOutputBufferForInspection({
    buffer,
    name,
    fileSizeLimit,
    inspectContent,
    determineFileType,
    classify: classifyCodeArtifact,
    extractRawText: extractCodeArtifactRawText,
    extractInspectionText: extractCodeArtifactInspectionText,
  });
};

/**
 * Creates a fallback download URL response when file cannot be processed locally.
 * Used when: file exceeds size limit, storage strategy unavailable, or download error occurs.
 * @param {Object} params - The parameters.
 * @param {string} params.name - The filename.
 * @param {string} params.session_id - The code execution session ID.
 * @param {string} params.id - The file ID from the code environment.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.toolCallId - The tool call ID that generated the file.
 * @param {string} params.messageId - The current message ID.
 * @param {number} params.expiresAt - Expiration timestamp (24 hours from creation).
 * @param {'default'|'stateful'} [params.executionProfile] - Code API route for later fallback download.
 * @param {string} [params.executionRouteKey] - Deployment-local route identity.
 * @returns {Object} Fallback response with download URL.
 */
const createDownloadFallback = ({
  id,
  name,
  agentId,
  messageId,
  expiresAt,
  session_id,
  toolCallId,
  conversationId,
  executionProfile,
  executionRouteKey,
}) => {
  const basePath = getBasePath();
  const query = new URLSearchParams();
  if (executionProfile === 'stateful') {
    query.set('execution_profile', 'stateful');
  }
  if (executionRouteKey && executionRouteKey !== executionProfile) {
    query.set('execution_route_key', executionRouteKey);
  }
  const routeQuery = query.size > 0 ? `?${query.toString()}` : '';
  return {
    filename: name,
    filepath: `${basePath}/api/files/code/download/${session_id}/${id}${routeQuery}`,
    expiresAt,
    conversationId,
    toolCallId,
    messageId,
    agentId,
  };
};

/**
 * Hard ceiling on the deferred preview rendering (HTML extraction + DB
 * update). The inner office-render path already has its own 12s timeout
 * and a concurrency-limited queue; this is the outer guard that catches
 * pathological cases where queue wait + render + DB write would
 * otherwise hang the file in `status: 'pending'` indefinitely.
 *
 * If the timeout fires the record is updated to `status: 'failed'`
 * with `previewError: 'timeout'` and the UI shows download-only.
 */
const PREVIEW_FINALIZE_TIMEOUT_MS = 60_000;

/**
 * Render the inline HTML preview for a code-execution file (or plain
 * text for non-office buckets that still benefit from caching), then
 * atomically transition the DB record to `status: 'ready'` (with
 * `text`/`textFormat`) or `status: 'failed'` (with `previewError`).
 *
 * Decoupled from `processCodeOutput` so the agent's final response is
 * not blocked on potentially slow office rendering. The caller fires
 * this without awaiting; promises continue running after the HTTP
 * response closes (Node doesn't kill them) and the frontend learns of
 * completion via the `attachment` update SSE event (if the stream is
 * still open) or via React Query polling otherwise. Process restart
 * is the only thing that can lose progress — covered by the boot-time
 * orphan sweep.
 *
 * @param {object} params
 * @param {Buffer} params.buffer - The full downloaded file contents,
 *   bounded by the server's `fileSizeLimit` config (defaults far above
 *   the 1MB extractor cap). The buffer is captured by the closure
 *   returned in `{ finalize }`, so when many office files queue behind
 *   the inner concurrency limiter (cap 2), all queued buffers stay
 *   resident until each one's slot frees. For a tool result emitting
 *   N office files, peak heap usage from this path is up to
 *   `N * fileSizeLimit`. Acceptable for typical agent runs (a handful
 *   of files at a few hundred KB each); pathological cases are bounded
 *   by the inner per-file 12s timeout and the outer 60s render cap.
 * @param {string} params.leafName - Basename for classification.
 * @param {string} params.mimeType - Detected/inferred MIME.
 * @param {string} params.category - Classifier output.
 * @param {string} params.file_id - The DB record key for the update.
 * @param {string} [params.previewRevision] - Generation marker stamped
 *   by the immediate persist step. The DB commit is conditional on
 *   this — if a newer emit (cross-turn filename reuse) has rotated
 *   the revision before this render finishes, `updateFile` returns
 *   null and the stale render is silently discarded rather than
 *   overwriting the newer record.
 * @returns {Promise<MongoFile | null>} The post-update record on
 *   success; `null` if the DB update itself failed (extraction failure
 *   is reflected as `status: 'failed'`, not a thrown error) or if the
 *   `previewRevision` guard rejected the write.
 */
const finalizePreview = async ({
  buffer,
  leafName,
  mimeType,
  category,
  file_id,
  previewRevision,
}) => {
  let text = null;
  let previewError;
  try {
    text = await withTimeout(
      extractCodeArtifactText(buffer, leafName, mimeType, category),
      PREVIEW_FINALIZE_TIMEOUT_MS,
      `Preview extraction exceeded ${PREVIEW_FINALIZE_TIMEOUT_MS}ms`,
    );
  } catch (_error) {
    /* `extractCodeArtifactText` swallows its own errors and returns null,
     * so the only way to reach here is a `withTimeout` rejection — i.e.
     * the queue + render combined exceeded the outer 60s ceiling. */
    previewError = 'timeout';
    logger.warn(
      `[finalizePreview] ${file_id}: extraction timed out after ${PREVIEW_FINALIZE_TIMEOUT_MS}ms`,
    );
  }
  /* HTML-or-null contract (PR #12934): null result on an office file
   * must NOT fall back to plain text — surface as failed. Caller gates
   * on `hasOfficeHtmlPath`, so reaching here always means office. */
  const textFormat = getExtractedTextFormat(leafName, mimeType, text);
  const failed = text == null;
  const status = failed ? 'failed' : 'ready';
  if (failed && !previewError) {
    previewError = 'parser-error';
  }
  try {
    /* Conditional update: commit only if `previewRevision` still
     * matches what the immediate persist step stamped. If a newer
     * emit has rotated the revision (cross-turn filename reuse),
     * `updateFile` returns null and the stale render is silently
     * discarded. (Codex P1 review on PR #12957.) */
    const updated = await updateFile(
      {
        file_id,
        text,
        textFormat,
        status,
        previewError: failed ? previewError : null,
      },
      previewRevision ? { previewRevision } : undefined,
    );
    if (!updated && previewRevision) {
      logger.debug(
        `[finalizePreview] ${file_id}: stale render skipped — newer emit has superseded revision ${previewRevision}`,
      );
    }
    return updated;
  } catch (error) {
    logger.error(
      `[finalizePreview] ${file_id}: failed to persist preview result: ${error?.message ?? error}`,
    );
    return null;
  }
};

/**
 * Run the background `finalize` thunk returned by `processCodeOutput`
 * and route the resolved record to the caller's emit logic. Shared
 * between `callbacks.js` (chat-completions + Open Responses) and
 * `tools.js` (direct tool endpoint) so the fire-and-forget pattern
 * doesn't drift across callsites.
 *
 * `onResolved` receives the post-update DB record and is the only piece
 * that varies — chat-completions writes the legacy `attachment` SSE
 * event, Open Responses writes the spec-shaped `librechat:attachment`
 * event with a sequence number, and the direct tool endpoint has no
 * stream to write to (caller passes a no-op).
 *
 * The catch path is the safety net for unexpected programming errors
 * inside `finalizePreview` ONLY. The function is designed to never
 * throw (extraction and DB failures are translated to `status: 'failed'`
 * inside it), but a ref error or future regression would otherwise
 * leave the DB record stuck at `'pending'` until the boot-time orphan
 * sweep — potentially hours away on a stable server. We attempt a
 * best-effort `updateFile` to mark the record `'failed'` with
 * `previewError: 'unexpected'` so the UI stops polling and the
 * next-turn LLM context surfaces the failure.
 *
 * `onResolved` errors are deliberately isolated in their own try/catch.
 * Without that isolation, a transient transport-side failure (SSE write
 * race after the stream closed, an emitter listener throwing) would
 * propagate into the finalize catch and downgrade an *already-resolved*
 * record to `failed` with `previewError: 'unexpected'` — surfacing
 * "preview unavailable" in the UI even though extraction succeeded
 * and the file is on disk. The emit failure is logged but the DB
 * record stays at whatever `finalizePreview` wrote (typically
 * `'ready'`), so the polling layer / next page load still sees the
 * resolved preview.
 *
 * @param {object} params
 * @param {(() => Promise<object | null>) | undefined} params.finalize - The
 *   thunk returned by `processCodeOutput`. No-op when undefined.
 * @param {string | undefined} params.fileId - DB key for the failure
 *   marker; if absent the catch only logs.
 * @param {string | undefined} [params.previewRevision] - Generation
 *   marker stamped by the immediate persist step. The defensive
 *   `updateFile` in the catch is conditional on this — if a newer
 *   emit has rotated the revision, the stale failure marker is
 *   silently discarded so a programming error from an older render
 *   doesn't override a newer turn's record.
 * @param {(updated: object) => void} [params.onResolved] - Called once
 *   on success with the post-update record.
 */
const runPreviewFinalize = ({ finalize, fileId, previewRevision, onResolved }) => {
  if (typeof finalize !== 'function') {
    return;
  }
  finalize()
    .then((updated) => {
      if (!updated || !onResolved) {
        return;
      }
      /* Isolated try/catch — a throw inside `onResolved` (transport-side
       * SSE write race, emitter listener error) MUST NOT propagate to
       * the outer `.catch`, which would downgrade an already-resolved
       * record to `failed` with `previewError: 'unexpected'`.
       * Extraction succeeded at this point and `finalizePreview` has
       * already persisted the terminal status; the polling layer / next
       * page load will surface the resolved preview even if this turn's
       * SSE emit didn't land. */
      try {
        onResolved(updated);
      } catch (emitError) {
        logger.error(
          `[runPreviewFinalize] onResolved threw for ${fileId}; record stays at the finalized status:`,
          emitError,
        );
      }
    })
    .catch((error) => {
      logger.error('Error rendering deferred preview:', error);
      if (!fileId) {
        return;
      }
      updateFile(
        {
          file_id: fileId,
          status: 'failed',
          previewError: 'unexpected',
        },
        previewRevision ? { previewRevision } : undefined,
      ).catch((updateErr) => {
        logger.error(
          `[runPreviewFinalize] also failed to mark ${fileId} as failed after error:`,
          updateErr,
        );
      });
    });
};

const processCodeOutput = (params) =>
  processCodeOutputWithDeps(params, {
    getCodeOutputFileSettings,
    downloadCodeOutputBuffer,
    createDownloadFallback,
    getRetentionExpiry,
    convertImage,
    getStrategyFunctions,
    determineFileType,
    claimCodeFile,
    commitCodeFile,
    finalizePreview,
    hasOfficeHtmlPath,
    sanitizeArtifactPath,
    flattenArtifactPath,
    classifyCodeArtifact,
    extractCodeArtifactText,
    getExtractedTextFormat,
    getStorageMetadata,
    logAxiosError,
    logger,
  });

function getSessionFileInfo(ref, req, route = {}, signal) {
  return getCodeFileInfo({
    ref,
    req,
    route,
    signal,
    request: axios,
    getBaseURL: getCodeBaseURL,
    getAuthHeaders: getCodeApiAuthHeaders,
  });
}

async function getSessionInfo(ref, req, route = {}, signal) {
  return (await getSessionFileInfo(ref, req, route, signal))?.lastModified ?? null;
}

class CodeResourceRecoveryError extends Error {
  constructor({ required, primed, failed }) {
    super(JSON.stringify({ type: ErrorTypes.RESOURCE_RECOVERY_REQUIRED }));
    this.name = 'CodeResourceRecoveryError';
    this.code = ErrorTypes.RESOURCE_RECOVERY_REQUIRED;
    this.status = 409;
    this.statusCode = 409;
    this.details = { required, primed, failed };
    this.required = required;
    this.primed = primed;
    this.failed = failed;
  }
}

const getPrimingCorrelation = (req) => ({
  requestId: req?.requestId ?? req?.id ?? 'unknown',
  runId: req?.body?.messageId ?? req?.body?.conversationId ?? 'unknown',
});

const getReuploadFailureCategory = (error) => {
  const status =
    error?.response?.status ??
    error?.statusCode ??
    error?.status ??
    error?.$metadata?.httpStatusCode;
  const code = error?.code ?? error?.name;
  if (
    status === 404 ||
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'BlobNotFound' ||
    code === 'ResourceNotFound'
  ) {
    return 'missing_backing_object';
  }
  if (
    status === 401 ||
    status === 403 ||
    code === 'AccessDenied' ||
    code === 'AccessDeniedException' ||
    code === 'Forbidden'
  ) {
    return 'resource_access_denied';
  }
  if (status === 429 || code === 'CODE_API_RATE_LIMITED') {
    return 'rate_limited';
  }
  return 'reupload_failed';
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @param {string} [options.agentResourceType] - Permission resource type for the authorized agent route
 * @param {AbortSignal} [options.signal] - Effective run cancellation signal
 * @param {import('@librechat/api').CodeFileLocation} [options.codeFileLocation] - Where the model can open primed files
 * @returns {Promise<{
 * files: Array<{ id: string; session_id: string; name: string }>,
 * toolContext: string,
 * }>}
 */
const primeFiles = async (options) => {
  const {
    tool_resources,
    req,
    agentId,
    agentResourceType,
    codeApiBaseUrl,
    executionProfile = 'default',
    executionRouteKey = executionProfile,
    bridgeWorkerId,
    codeFileLocation,
    signal,
  } = options;
  const codeApiRoute = { baseUrl: codeApiBaseUrl, executionProfile, bridgeWorkerId };
  const file_ids = tool_resources?.[EToolResources.execute_code]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.execute_code]?.files ?? [];
  /** Runtime entries identify candidates only; database records remain authoritative for storage metadata. */
  const candidateFileIds = new Set(file_ids);
  for (const file of resourceFiles) {
    if (typeof file?.file_id === 'string') {
      candidateFileIds.add(file.file_id);
    }
  }

  /* Step 1 of the priming trace: input volume. Pair with the
   * per-file `[primeCodeFiles] file=...` lines and the final
   * `[primeCodeFiles] returned=...` line below to locate which
   * layer drops a file the sandbox doesn't end up seeing. */
  logger.debug(
    `[primeCodeFiles] in: file_ids=${file_ids.length} resourceFiles=${resourceFiles.length}`,
    { agentId, file_ids, resourceFileIds: resourceFiles.map((f) => f?.file_id) },
  );

  // Get all files first
  const allFiles =
    (await getFiles({ file_id: { $in: Array.from(candidateFileIds) } }, null, { text: 0 })) ?? [];

  // Filter by access if user and agent are provided
  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
      resourceType: agentResourceType,
    });
  } else {
    dbFiles = allFiles;
  }

  const files = [];
  const uploadOptions = getCodeApiUploadOptions(req, executionRouteKey);
  /** All stale-file reuploads in this prime share one live-turn wait cap. */
  const uploadRateLimitBudget = createCodeApiRateLimitBudget(uploadOptions.retryWaitMs);
  let toolContext = '';

  const { selected, skippedNoRef, skippedSuperseded } = await selectCodeFiles({
    files: dbFiles,
    privateFileIds: agentResourceIds,
    routeKey: executionRouteKey,
    getFileInfo: (ref) => getSessionFileInfo(ref, req, codeApiRoute, signal),
    concurrency: uploadOptions.concurrency,
    signal,
  });
  let reuploadFailures = 0;
  let requiredCodeFiles = 0;
  const reuploadFailureCategories = new Set();

  for (const { file, ref, sourceRef, sandboxName, isActive, getUploadTime } of selected) {
    requiredCodeFiles += 1;
    const session_id = sourceRef.storage_session_id;
    const id = sourceRef.file_id;

    /**
     * `pushFile` accepts optional overrides so the reupload path can
     * push the FRESH `(storage_session_id, file_id)` from the new
     * `codeEnvRef`. Without these overrides, the closure would
     * capture the stale pre-reupload refs from the outer loop and
     * the in-memory `files` array (now consumed by
     * `buildInitialToolSessions` to seed `Graph.sessions`) would
     * point at a sandbox object that no longer exists. The DB record
     * gets the new ref via `updateFile`, but the seed would still
     * inject the old one — bash_tool / read_file would 404 trying to
     * mount the file until the next turn re-reads metadata.
     *
     * `kind`, `id`, `version` are preserved on the in-memory ref so
     * codeapi can resolve sessionKey per-file (kind switch +
     * tenant prefix from auth context).
     */
    const pushFile = (overrideSessionId, overrideId, destination = sandboxName) => {
      /* The sandbox holds the converted name, not the record's, so the mount path has
       * to follow the same rule provisioning uploaded under. */
      toolContext = appendCodeFileContextLine(
        toolContext,
        getCodeFileContextLine(file, agentResourceIds, destination, codeFileLocation),
        codeFileLocation,
      );
      /* `id` is the storage file_id (drives codeapi's upload-key
       * existence check), `resource_id` is the entity that owns
       * the storage session (drives sessionKey re-derivation). For
       * code-output files this is `kind: 'user'` and `resource_id`
       * is informational (codeapi ignores it for user kind), but
       * we still send it for shape uniformity with shared kinds. */
      files.push({
        id: overrideId ?? id,
        resource_id: sourceRef.id,
        storage_session_id: overrideSessionId ?? session_id,
        name: destination,
        kind: sourceRef.kind,
        ...(sourceRef.kind === 'skill' ? { version: sourceRef.version } : {}),
      });
    };

    const reuploadFile = async () => {
      try {
        const { getDownloadStream } = getStrategyFunctions(file.source);
        const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(
          FileSources.execute_code,
        );
        /* Reupload preserves the resource identity from the existing
         * ref so codeapi re-buckets under the same sessionKey shape
         * (skill stays skill, user stays user). Without this, a
         * skill-cache-miss reupload would land in the user bucket
         * and never re-shareable cross-user. */
        const uploaded = await withCodeApiUploadRecovery({
          registry: req.app?.locals?.codeApiUploadRegistry,
          scope: uploadOptions.scope,
          concurrency: uploadOptions.concurrency,
          label: `re-uploading file ${file.file_id} to the code environment`,
          budget: uploadRateLimitBudget,
          signal,
          onWait: (waitMs) =>
            logger.warn(
              `[primeCodeFiles] Rate-limited reupload requestId=${getPrimingCorrelation(req).requestId} ` +
                `runId=${getPrimingCorrelation(req).runId}; retrying in ${waitMs}ms`,
            ),
          openSource: async () => {
            signal?.throwIfAborted();
            return getDownloadStream(options.req, resolveDownloadPath(file), { signal });
          },
          upload: (stream) =>
            uploadCodeEnvFile({
              req: options.req,
              stream,
              filename: sandboxName,
              kind: sourceRef.kind,
              id: sourceRef.id,
              ...(sourceRef.kind === 'skill' ? { version: sourceRef.version } : {}),
              codeApiBaseUrl,
              executionProfile,
              bridgeWorkerId,
              signal,
            }),
        });

        /**
         * Use the FRESH `(storage_session_id, file_id)` from the
         * reupload response and route it through the persisted record
         * and the in-memory `files` list. The
         * original ref captured at the top of this iteration refers
         * to the old, expired/missing sandbox object — using it here
         * would silently re-introduce the bug `Graph.sessions`
         * seeding is supposed to fix.
         *
         * `kind`, `id`, `version` survive the round-trip: the
         * upload preserves the resource identity, only the storage
         * pointer changes.
         */
        const newRef = {
          kind: sourceRef.kind,
          id: sourceRef.id,
          storage_session_id: uploaded.storage_session_id,
          file_id: uploaded.file_id,
          sandboxFilename: getUploadedCodeEnvFilename(uploaded, sandboxName),
          executionProfile,
          ...(executionRouteKey !== executionProfile ? { executionRouteKey } : {}),
          ...(sourceRef.kind === 'skill' ? { version: sourceRef.version } : {}),
        };

        const updatedRefs = mergeCodeEnvRef(file.metadata, newRef);

        await updateFile({
          file_id: file.file_id,
          'metadata.codeEnvRef': updatedRefs.codeEnvRef,
          [`metadata.codeEnvRefs.${executionRouteKey}`]: newRef,
        });
        pushFile(newRef.storage_session_id, newRef.file_id, newRef.sandboxFilename);
        logger.debug(
          `[primeCodeFiles] file=${file.file_id} path=reupload-success ` +
            `oldSession=${session_id} newSession=${newRef.storage_session_id} newFileId=${newRef.file_id}`,
        );
      } catch (error) {
        /* Cancellation is an operation outcome, not a recoverable per-file
         * miss. Swallowing it here would keep walking and could dispatch more
         * uploads after the foreground run has ended. */
        signal?.throwIfAborted();
        reuploadFailures += 1;
        const failureCategory = getReuploadFailureCategory(error);
        reuploadFailureCategories.add(failureCategory);
        const { requestId, runId } = getPrimingCorrelation(req);
        logger.error(
          `[primeCodeFiles] reupload-failed requestId=${requestId} runId=${runId} ` +
            `category=${failureCategory}`,
        );
      }
    };
    if (!ref) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=reupload reason=profile-missing ` +
          `requestedProfile=${executionProfile}`,
      );
      await reuploadFile();
      continue;
    }
    const uploadTime = await getUploadTime();
    signal?.throwIfAborted();
    if (!uploadTime) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=reupload reason=no-uploadtime ` +
          `storage_session_id=${session_id}`,
      );
      await reuploadFile();
      continue;
    }
    if (!isActive) {
      logger.debug(
        `[primeCodeFiles] file=${file.file_id} path=reupload reason=stale ` +
          `uploadTime=${uploadTime} storage_session_id=${session_id}`,
      );
      await reuploadFile();
      continue;
    }
    logger.debug(
      `[primeCodeFiles] file=${file.file_id} path=fresh-active storage_session_id=${session_id}`,
    );
    pushFile();
  }

  /* Dispatch summary — emitted unconditionally so a single grep on
   * `[primeCodeFiles] out` always shows the final state, not only
   * the per-path trail leading up to it. */
  const primedCodeFiles = files.length;
  const allRequiredResourcesFailed =
    requiredCodeFiles > 0 && primedCodeFiles === 0 && reuploadFailures === requiredCodeFiles;
  const { requestId, runId } = getPrimingCorrelation(req);
  logger.debug(
    `[primeCodeFiles] out: returned=${files.length} ` +
      `required=${requiredCodeFiles} skippedNoRef=${skippedNoRef} ` +
      `skippedSuperseded=${skippedSuperseded} reuploadFailures=${reuploadFailures}`,
  );

  if (allRequiredResourcesFailed) {
    const failureCategory =
      reuploadFailureCategories.size === 1
        ? Array.from(reuploadFailureCategories)[0]
        : 'mixed_reupload_failure';
    logger.warn(
      `[primeCodeFiles] resource-recovery-required requestId=${requestId} runId=${runId} ` +
        `required=${requiredCodeFiles} primed=${primedCodeFiles} failed=${reuploadFailures} ` +
        `category=${failureCategory}`,
    );
    throw new CodeResourceRecoveryError({
      required: requiredCodeFiles,
      primed: primedCodeFiles,
      failed: reuploadFailures,
    });
  }

  return { files, toolContext };
};

/**
 * Reads a single file from the code-execution sandbox by shelling `cat`
 * through the sandbox `/exec` endpoint. Used by the `read_file` host
 * handler when the requested path is a code-env path (`/mnt/data/...`)
 * or otherwise not resolvable as a skill file. Resolves to
 * `{ content }` from stdout on success, or `null` when the codeapi base
 * URL isn't configured / the read returns no content (caller turns that
 * into a model-visible error). Throws axios-style errors on transport
 * failure so the caller can surface a meaningful error message.
 *
 * `session_id` and `files` come from the seeded `tc.codeSessionContext`
 * (emitted by the agents-side `ToolNode` for `read_file` calls in
 * v3.1.72+) so the read lands in the same sandbox session that holds
 * the agent's prior-turn artifacts.
 *
 * @param {Object} params
 * @param {string} params.file_path - Absolute path inside the sandbox (e.g. `/mnt/data/foo.txt`).
 * @param {string} [params.session_id] - Sandbox session id from the seeded context.
 * @param {Array<{id: string, name: string, session_id?: string}>} [params.files] - File refs to mount.
 * @param {ServerRequest} [params.req] - Current authenticated request, used to mint Code API auth.
 * @returns {Promise<{content: string} | null>}
 */
async function readSandboxFile({
  file_path,
  session_id,
  files,
  runtime_session_hint,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
}) {
  const baseURL = codeApiBaseUrl ?? getCodeBaseURL();
  if (!baseURL) {
    return null;
  }

  /** Single-quote `file_path` with embedded-quote escaping so a malicious
   *  filename can't break out of the `cat` command. The handler upstream
   *  has already established this is a code-env path the model
   *  legitimately asked to read; this just keeps the shell quoting safe. */
  const safePath = `'${file_path.replace(/'/g, `'\\''`)}'`;
  /** @type {Record<string, unknown>} */
  const postData = { lang: 'bash', code: `cat ${safePath}` };
  if (session_id) {
    postData.session_id = session_id;
  }
  if (runtime_session_hint) {
    postData.runtime_session_hint = runtime_session_hint;
  }
  if (files && files.length > 0) {
    postData.files = files;
  }

  let response;
  try {
    const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
    response = await axios({
      method: 'post',
      url: `${baseURL}/exec`,
      data: postData,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
        ...(executionProfile ? codeExecutionHeaders({ executionProfile, bridgeWorkerId }) : {}),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    });
  } catch (error) {
    logAxiosError({
      message: `Error reading sandbox file "${file_path}"`,
      error,
    });
    throw error;
  }

  const result = response?.data ?? {};
  if (result.stderr && (result.stdout == null || result.stdout === '')) {
    const reason = String(result.stderr).trim();
    /** An absent path is the ordinary outcome, not a fault: `create_file`
     *  reads its target before writing so it can tell a create from an
     *  overwrite. Logging that at error level with a stack made every
     *  file creation look like a file that had gone missing. */
    if (isMissingSandboxPathError(reason)) {
      logger.debug(`[readSandboxFile] "${file_path}" is not present in the sandbox: ${reason}`);
    } else {
      logger.error(`[readSandboxFile] Error reading sandbox file "${file_path}": ${reason}`);
    }
    throw new Error(reason);
  }
  if (result.stdout == null) {
    return null;
  }
  return { content: String(result.stdout) };
}

/**
 * Reads a bounded range from the workspace directory registered by an attached worker.
 * The authenticated worker route is derived from the selected environment and
 * the host path remains private to the worker.
 *
 * @param {Object} params
 * @param {string} params.file_path
 * @param {string} params.workspace_id
 * @param {string} [params.workspace_instance_id]
 * @param {number} params.start_line
 * @param {number} params.max_lines
 * @param {string} params.codeApiBaseUrl
 * @param {'default' | 'stateful'} params.executionProfile
 * @param {string} [params.bridgeWorkerId]
 * @param {ServerRequest} [params.req]
 * @param {AbortSignal} [params.signal]
 */
async function readWorkspaceFile({
  file_path,
  workspace_id,
  workspace_instance_id,
  start_line,
  max_lines,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      path: file_path,
      startLine: start_line,
      maxLines: max_lines,
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Searches literal text within the workspace directory registered by an attached worker.
 *
 * @param {Object} params
 * @param {string} params.query
 * @param {string} params.workspace_id
 * @param {string} [params.workspace_instance_id]
 * @param {string} [params.path]
 * @param {number} params.max_results
 * @param {string} params.codeApiBaseUrl
 * @param {'default' | 'stateful'} params.executionProfile
 * @param {string} [params.bridgeWorkerId]
 * @param {ServerRequest} [params.req]
 * @param {AbortSignal} [params.signal]
 */
async function searchWorkspace({
  query,
  workspace_id,
  workspace_instance_id,
  path,
  max_results,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'search_text',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      query,
      ...(path ? { path } : {}),
      maxResults: max_results,
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Lists relative files within the workspace directory registered by an attached worker.
 *
 * @param {Object} params
 * @param {string} params.workspace_id
 * @param {string} [params.workspace_instance_id]
 * @param {string} [params.path]
 * @param {string} [params.after_path]
 * @param {number} params.max_results
 * @param {string} params.codeApiBaseUrl
 * @param {'default' | 'stateful'} params.executionProfile
 * @param {string} [params.bridgeWorkerId]
 * @param {ServerRequest} [params.req]
 * @param {AbortSignal} [params.signal]
 */
async function listWorkspaceFiles({
  workspace_id,
  workspace_instance_id,
  path,
  after_path,
  max_results,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'list_files',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      ...(path ? { path } : {}),
      ...(after_path ? { afterPath: after_path } : {}),
      maxResults: max_results,
    },
    ...(signal ? { signal } : {}),
  });
}

/** Writes a UTF-8 file in the workspace registered by an attached worker. */
async function writeWorkspaceFile({
  file_path,
  content,
  overwrite,
  workspace_id,
  workspace_instance_id,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'write_file',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      path: file_path,
      content,
      overwrite,
    },
    ...(signal ? { signal } : {}),
  });
}

/** Applies an ordered exact-edit batch in one attached-worker mutation. */
async function editWorkspaceFile({
  file_path,
  edits,
  expected_base_sha256,
  workspace_id,
  workspace_instance_id,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'edit_file',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      path: file_path,
      edits,
      ...(expected_base_sha256 ? { expectedBaseSha256: expected_base_sha256 } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/** Previews an ordered exact-edit batch without mutating the attached workspace. */
async function previewWorkspaceEdit({
  file_path,
  edits,
  workspace_id,
  workspace_instance_id,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
  signal,
  maxQueueWaitMs,
}) {
  return executeWorkspaceTool({
    baseURL: codeApiBaseUrl,
    maxQueueWaitMs,
    /** Minted per admission attempt: a queued call outlives one token TTL. */
    authHeaders: async () => ({
      ...(await getCodeApiAuthHeaders(req, bridgeWorkerId)),
      ...codeExecutionHeaders({ executionProfile, bridgeWorkerId }),
    }),
    request: {
      protocolVersion: 1,
      operation: 'preview_edit',
      workspaceId: workspace_id,
      ...(workspace_instance_id ? { workspaceInstanceId: workspace_instance_id } : {}),
      path: file_path,
      edits,
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Reads a small code artifact as base64 so `read_file` can surface it to
 * vision-capable models. Reuses bytes fetched by the current request's
 * artifact preflight when the requested path resolves to the exact returned
 * file ref; otherwise falls back to the code-execution sandbox.
 * `readSandboxFile`'s
 * `cat` round-trips stdout through codeapi's JSON transport, which lossily
 * replaces non-UTF-8 bytes and corrupts image data. The in-sandbox reader
 * base64-encodes the bytes instead, so the payload stays ASCII-safe across
 * the JSON `/exec` transport. Session forwarding mirrors `readSandboxFile`
 * so the read lands in the same sandbox session that holds the agent's
 * prior-turn artifacts.
 *
 * Windowing, window sizing, and assembly live in `@librechat/api`
 * (`readWindowedSandboxImage`); this function is the `/exec` transport it
 * calls, plus the rate-limit wait that keeps a multi-window read from
 * discarding the bytes it already pulled.
 *
 * @param {Object} params
 * @param {string} params.file_path - Path inside the sandbox (e.g. `/mnt/data/chart.png`).
 * @param {string} [params.session_id] - Sandbox session id from the seeded context.
 * @param {Array<{id: string, name: string, session_id?: string}>} [params.files] - File refs to mount.
 * @param {string} [params.runtime_session_hint] - Per-conversation stateful runtime-session hint.
 * @param {number} [params.maxBytes] - In-sandbox size cap; larger files return `{ tooLarge, bytes }`.
 * @param {ServerRequest} [params.req] - Current authenticated request, used to mint Code API auth.
 * @param {AbortSignal} [params.signal] - Foreground run cancellation.
 * @param {string} [params.executionRouteKey] - Trusted deployment-local route identity.
 * @param {string} [params.bridgeWorkerId] - Trusted bridge worker selected for this execution.
 * @returns {Promise<{base64: string, bytes: number}
 *   | {tooLarge: true, reason: 'size' | 'round_trips', bytes: number} | null>}
 *   `null` when codeapi is unavailable; throws on transport / read errors.
 */
async function readSandboxImage({
  file_path,
  session_id,
  files,
  runtime_session_hint,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  executionRouteKey,
  maxBytes,
  req,
  signal,
}) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 5 * megabyte;
  const preparedBuffer = getPreparedCodeOutputBuffer({
    req,
    file_path,
    session_id,
    files,
    codeApiBaseUrl,
    executionProfile,
    executionRouteKey,
  });
  if (preparedBuffer) {
    if (preparedBuffer.length > limit) {
      return { tooLarge: true, reason: 'size', bytes: preparedBuffer.length };
    }
    return { base64: preparedBuffer.toString('base64'), bytes: preparedBuffer.length };
  }

  const baseURL = codeApiBaseUrl ?? getCodeBaseURL();
  if (!baseURL) {
    return null;
  }

  /** Every window is one `/exec` call against the Code API's per-user
   *  execution limiter, so the read shares one wait budget: a window that
   *  resets mid-read is worth pausing for, an exhausted budget is not. */
  const rateLimit = createCodeApiRateLimitBudget(
    req?.config?.endpoints?.agents?.codeApiMaxRetryWaitMs,
  );
  return readWindowedSandboxImage({
    filePath: file_path,
    baseUrl: baseURL,
    limit,
    readChunk: ({ code }) =>
      execSandboxImageChunk({
        baseURL,
        code,
        file_path,
        session_id,
        runtime_session_hint,
        executionProfile,
        bridgeWorkerId,
        files,
        req,
        rateLimit,
        signal,
      }),
  });
}

/**
 * Runs one image-window read over `/exec` and hands the response to the
 * shared parser. Rate limits are waited out inside the shared budget; a
 * truncated response comes back as a chunk the reader narrows for, not an
 * error, so it is neither logged nor thrown here.
 * @returns {Promise<import('@librechat/api').SandboxImageChunk>}
 */
async function execSandboxImageChunk({
  baseURL,
  code,
  file_path,
  session_id,
  runtime_session_hint,
  executionProfile,
  bridgeWorkerId,
  files,
  req,
  rateLimit,
  signal,
}) {
  /** @type {Record<string, unknown>} */
  const postData = { lang: 'bash', code };
  if (session_id) {
    postData.session_id = session_id;
  }
  if (runtime_session_hint) {
    postData.runtime_session_hint = runtime_session_hint;
  }
  if (files && files.length > 0) {
    postData.files = files;
  }

  try {
    const response = await withCodeApiRateLimit({
      label: `reading "${file_path}" from the sandbox`,
      budget: rateLimit,
      signal,
      onWait: (waitMs) =>
        logger.warn(
          `[readSandboxImage] Rate-limited reading "${file_path}"; retrying in ${waitMs}ms`,
        ),
      attempt: async () => {
        const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
        return axios({
          method: 'post',
          url: `${baseURL}/exec`,
          data: postData,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'LibreChat/1.0',
            ...authHeaders,
            ...(executionProfile ? codeExecutionHeaders({ executionProfile, bridgeWorkerId }) : {}),
          },
          httpAgent: codeServerHttpAgent,
          httpsAgent: codeServerHttpsAgent,
          timeout: 15000,
          signal,
        });
      },
    });
    return parseSandboxImageChunk(response?.data ?? {});
  } catch (error) {
    logAxiosError({
      message: `Error reading sandbox image "${file_path}"`,
      error,
    });
    throw error;
  }
}

/**
 * Writes a UTF-8 text file into the code-execution sandbox by running a
 * small Python writer through the sandbox `/exec` endpoint. The payload is
 * base64-encoded JSON so neither the file path nor the content is
 * interpolated into shell syntax.
 *
 * @param {Object} params
 * @param {string} params.file_path - Path inside the sandbox (prefer `/mnt/data/...`).
 * @param {string} params.content - Complete UTF-8 text content to write.
 * @param {string} [params.session_id] - Sandbox session id from the seeded context.
 * @param {Array<{id: string, name: string, session_id?: string}>} [params.files] - File refs to mount.
 * @param {ServerRequest} [params.req] - Current authenticated request, used to mint Code API auth.
 * @returns {Promise<{stdout?: string, stderr?: string, session_id?: string, files?: Array<Object>, artifact_delivery?: {code: 'artifact_delivery_failed', status: 'partial' | 'failed', attempted: number, delivered: number, failed: number}} | null>}
 */
async function writeSandboxFile({
  file_path,
  content,
  session_id,
  files,
  runtime_session_hint,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  req,
}) {
  const baseURL = codeApiBaseUrl ?? getCodeBaseURL();
  if (!baseURL) {
    return null;
  }

  const payload = Buffer.from(
    JSON.stringify({
      file_path,
      content_b64: Buffer.from(content, 'utf8').toString('base64'),
    }),
    'utf8',
  ).toString('base64');
  const code = [
    "python3 - <<'PY'",
    'import base64, json, os',
    `payload = ${JSON.stringify(payload)}`,
    "data = json.loads(base64.b64decode(payload).decode('utf-8'))",
    "path = data['file_path']",
    "content = base64.b64decode(data['content_b64'])",
    'parent = os.path.dirname(path)',
    'if parent:',
    '    os.makedirs(parent, exist_ok=True)',
    "with open(path, 'wb') as f:",
    '    f.write(content)',
    'print(f"WROTE {len(content)} bytes to {path}")',
    'PY',
  ].join('\n');

  /** @type {Record<string, unknown>} */
  const postData = { lang: 'bash', code };
  if (session_id) {
    postData.session_id = session_id;
  }
  if (runtime_session_hint) {
    postData.runtime_session_hint = runtime_session_hint;
  }
  if (files && files.length > 0) {
    postData.files = files;
  }

  try {
    const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
    const response = await axios({
      method: 'post',
      url: `${baseURL}/exec`,
      data: postData,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
        ...(executionProfile ? codeExecutionHeaders({ executionProfile, bridgeWorkerId }) : {}),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    });
    const result = response?.data ?? {};
    if (result.stderr && (result.stdout == null || result.stdout === '')) {
      throw new Error(String(result.stderr).trim());
    }
    if (result.stdout == null && result.session_id == null) {
      return null;
    }
    return {
      stdout: result.stdout == null ? undefined : String(result.stdout),
      stderr: result.stderr == null ? undefined : String(result.stderr),
      session_id: result.session_id,
      files: result.files,
      artifact_delivery: normalizeArtifactDeliveryFailure(result.artifact_delivery),
    };
  } catch (error) {
    logAxiosError({
      message: `Error writing sandbox file "${file_path}"`,
      error,
    });
    throw error;
  }
}

module.exports = {
  CodeResourceRecoveryError,
  primeFiles,
  checkIfActive,
  getSessionInfo,
  processCodeOutput,
  prepareCodeOutputForInspection,
  readWorkspaceFile,
  searchWorkspace,
  listWorkspaceFiles,
  writeWorkspaceFile,
  previewWorkspaceEdit,
  editWorkspaceFile,
  readSandboxFile,
  readSandboxImage,
  writeSandboxFile,
  runPreviewFinalize,
};
