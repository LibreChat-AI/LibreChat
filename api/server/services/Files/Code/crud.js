const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { getCodeBaseURL } = require('@librechat/agents');
const { EModelEndpoint, getCodeEnvRefs } = require('librechat-data-provider');
const {
  logAxiosError,
  wrapCodeApiUploadError,
  appendCodeEnvFile,
  createAxiosInstance,
  codeServerHttpAgent,
  codeServerHttpsAgent,
  appendCodeEnvFileIdentity,
  buildCodeEnvDownloadQuery,
  getCodeApiAuthHeaders,
  getCodeExecutionBaseUrl,
  createCodeExecutionRouteKey,
  codeExecutionHeaders,
} = require('@librechat/api');

const axios = createAxiosInstance();

const MAX_FILE_SIZE = 150 * 1024 * 1024;

/**
 * Retrieves a download stream for a specified file.
 * @param {string} fileIdentifier - The identifier for the file (e.g., "session_id/fileId").
 * @param {{ kind: 'skill' | 'agent' | 'user'; id: string; version?: number }} identity
 *   Resource identity required by codeapi's `sessionAuth` to derive the
 *   matching sessionKey. For code-output downloads this is always
 *   `kind: 'user', id: <userId>`; for skill/agent re-downloads pass
 *   the kind+id (+version for skill) from the file's `metadata.codeEnvRef`.
 * @param {ServerRequest} req - Current authenticated request.
 * @param {{baseUrl?: string, executionProfile?: 'default'|'stateful', bridgeWorkerId?: string}} [route]
 *   Trusted host-selected Code API route.
 * @returns {Promise<AxiosResponse>} A promise that resolves to a readable stream of the file content.
 * @throws {Error} If there's an error during the download process.
 */
async function getCodeOutputDownloadStream(fileIdentifier, identity, req, route = {}) {
  try {
    const baseURL = route.baseUrl ?? getCodeBaseURL();
    const query = buildCodeEnvDownloadQuery(identity);
    const authHeaders = await getCodeApiAuthHeaders(req, route.bridgeWorkerId);
    /** @type {import('axios').AxiosRequestConfig} */
    const options = {
      method: 'get',
      url: `${baseURL}/download/${fileIdentifier}${query}`,
      responseType: 'stream',
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...authHeaders,
        ...(route.executionProfile
          ? codeExecutionHeaders({
              executionProfile: route.executionProfile,
              bridgeWorkerId: route.bridgeWorkerId,
            })
          : {}),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 15000,
    };

    const response = await axios(options);
    return response;
  } catch (error) {
    throw new Error(
      logAxiosError({
        message: `Error downloading code environment file stream: ${error.message}`,
        error,
      }),
    );
  }
}

/**
 * Deletes a file from the Code Environment server.
 *
 * @param {ServerRequest} req - Current authenticated request, used to mint Code API auth.
 * @param {MongoFile} file - File metadata containing `metadata.codeEnvRef`.
 * @returns {Promise<void>}
 */
async function deleteCodeEnvFile(req, file) {
  const refs = getCodeEnvRefs(file?.metadata);
  if (refs.length === 0) {
    return;
  }

  for (const [executionRouteKey, ref] of refs) {
    const executionProfile = ref.executionProfile ?? 'default';
    const environments =
      req.config?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments;
    const configuredEnvironment = environments?.find(
      (environment) =>
        createCodeExecutionRouteKey(executionProfile, environment) === executionRouteKey,
    );
    if (
      executionProfile === 'stateful' &&
      executionRouteKey !== executionProfile &&
      !configuredEnvironment
    ) {
      logger.warn(
        `[deleteCodeEnvFile] Skipping remote cleanup for unmapped historical route ${executionRouteKey}`,
      );
      continue;
    }
    let baseURL;
    try {
      baseURL = getCodeExecutionBaseUrl(executionProfile, configuredEnvironment);
    } catch (error) {
      if (
        executionProfile === 'stateful' &&
        executionRouteKey === executionProfile &&
        !configuredEnvironment
      ) {
        logger.warn(
          '[deleteCodeEnvFile] Skipping remote cleanup for retired legacy stateful route',
        );
        continue;
      }
      throw error;
    }
    const query = buildCodeEnvDownloadQuery({
      kind: ref.kind,
      id: ref.id,
      ...(ref.kind === 'skill' ? { version: ref.version } : {}),
    });
    const bridgeWorkerId =
      configuredEnvironment?.workerId ?? configuredEnvironment?.pairing?.workerId;
    const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
    /* codeapi has mounted DELETE at `/files/:session_id/:fileId` since its
     * first release. The file-server's own `/sessions/:id/objects/:fileId`
     * only gained DELETE in LibreChat-AI/code-interpreter#85, so trying it
     * first cost a guaranteed 404 against every older deployment. */
    try {
      await axios({
        method: 'delete',
        url: `${baseURL}/files/${ref.storage_session_id}/${ref.file_id}${query}`,
        headers: {
          'User-Agent': 'LibreChat/1.0',
          ...authHeaders,
          ...codeExecutionHeaders({
            executionProfile,
            bridgeWorkerId,
          }),
        },
        httpAgent: codeServerHttpAgent,
        httpsAgent: codeServerHttpsAgent,
        timeout: 15000,
      });
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
      /* Already gone. Logged rather than swallowed: a 404 from a
       * misconfigured base URL is indistinguishable from one for an absent
       * object, and this branch drops the file's record either way. */
      logAxiosError({
        error,
        message: `Code environment object already absent: ${error.message}`,
      });
    }
  }
}

/**
 * Uploads a file to the Code Environment server.
 *
 * `kind`/`id`/`version?` are required so codeapi can route the upload to
 * the correct sessionKey bucket — `<tenant>:<kind>:<id>[:v:<version>]`
 * for shared kinds, `<tenant>:user:<authContext.userId>` for `user`.
 * Without these, codeapi falls back to user-scoped bucketing regardless
 * of the resource the file belongs to, so skill-cache invalidation
 * (driven by the version bump on edit) never fires. See codeapi #1455.
 *
 * @param {Object} params - The params object.
 * @param {ServerRequest} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {import('fs').ReadStream | import('stream').Readable} params.stream - The read stream for the file.
 * @param {string} params.filename - The name of the file.
 * @param {'skill' | 'agent' | 'user'} params.kind - Resource kind that owns this file's storage session.
 * @param {string} params.id - Resource id (skillId / agentId / userId). Codeapi
 *   ignores this for `kind: 'user'` (auth context provides userId), but it's
 *   sent uniformly for shape symmetry with the discriminated union.
 * @param {number} [params.version] - Required when `kind === 'skill'`; absent otherwise.
 * @param {string} [params.codeApiBaseUrl] - Trusted per-agent Code API endpoint.
 * @param {'default'|'stateful'} [params.executionProfile] - Trusted execution profile.
 * @param {string} [params.bridgeWorkerId] - Trusted worker selected for this execution.
 * @param {AbortSignal} [params.signal] - Effective cancellation signal.
 * @returns {Promise<{ storage_session_id: string; file_id: string; filename: string }>}
 *   The codeapi storage location of the uploaded file.
 * @throws {Error} If there's an error during the upload process.
 */
async function uploadCodeEnvFile({
  req,
  stream,
  filename,
  kind,
  id,
  version,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  signal,
}) {
  try {
    const form = new FormData();
    appendCodeEnvFileIdentity(form, { kind, id, version });
    appendCodeEnvFile(form, stream, filename);

    const baseURL = codeApiBaseUrl ?? getCodeBaseURL();
    const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
    /** @type {import('axios').AxiosRequestConfig} */
    const options = {
      headers: {
        ...form.getHeaders(),
        'Content-Type': 'multipart/form-data',
        'User-Agent': 'LibreChat/1.0',
        'User-Id': req.user.id,
        ...authHeaders,
        ...(executionProfile ? codeExecutionHeaders({ executionProfile, bridgeWorkerId }) : {}),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 120000,
      maxContentLength: MAX_FILE_SIZE,
      maxBodyLength: MAX_FILE_SIZE,
      ...(signal ? { signal } : {}),
    };

    const response = await axios.post(`${baseURL}/upload`, form, options);

    /** @type {{ message: string; storage_session_id: string; files: Array<{ fileId: string; filename: string }> }} */
    const result = response.data;
    if (result.message !== 'success') {
      throw new Error(`Error uploading file: ${result.message}`);
    }

    return {
      storage_session_id: result.storage_session_id,
      file_id: result.files[0].fileId,
      filename: result.files[0].filename,
    };
  } catch (error) {
    throw wrapCodeApiUploadError(error, `Error uploading code environment file: ${error.message}`);
  }
}

/**
 * Uploads multiple files to the code execution environment in a single request.
 * Uses the /upload/batch endpoint which shares one session_id across all files.
 *
 * `kind`/`id`/`version?` carry the resource identity for codeapi's sessionKey
 * derivation — see `uploadCodeEnvFile` for the full motivation.
 *
 * @param {object} params
 * @param {import('express').Request & { user: { id: string } }} params.req - The request object.
 * @param {Array<{ stream: NodeJS.ReadableStream; filename: string }>} params.files - Files to upload.
 * @param {'skill' | 'agent' | 'user'} params.kind - Resource kind that owns the batch's storage session.
 * @param {string} params.id - Resource id (skillId / agentId / userId).
 * @param {number} [params.version] - Required when `kind === 'skill'`; absent otherwise.
 * @param {boolean} [params.read_only] - When true, codeapi tags every file in
 *   the batch as infrastructure (e.g. skill files). The flag is persisted as
 *   MinIO object metadata (`X-Amz-Meta-Read-Only`) and travels with the file
 *   through subsequent download/walk passes — sandboxed-code modifications
 *   are dropped on the floor and the original ref is echoed back as
 *   `inherited: true`, never as a generated artifact.
 * @param {string} [params.codeApiBaseUrl] - Trusted per-agent Code API endpoint.
 * @param {'default'|'stateful'} [params.executionProfile] - Trusted execution profile.
 * @param {string} [params.bridgeWorkerId] - Trusted worker selected for this execution.
 * @returns {Promise<{ storage_session_id: string; files: Array<{ fileId: string; filename: string }> }>}
 * @throws {Error} If the batch upload fails entirely.
 */
async function batchUploadCodeEnvFiles({
  req,
  files,
  kind,
  id,
  version,
  read_only = false,
  codeApiBaseUrl,
  executionProfile,
  bridgeWorkerId,
  signal,
}) {
  const form = new FormData();
  appendCodeEnvFileIdentity(form, { kind, id, version });
  if (read_only) {
    form.append('read_only', 'true');
  }
  for (const file of files) {
    appendCodeEnvFile(form, file.stream, file.filename);
  }

  const baseURL = codeApiBaseUrl ?? getCodeBaseURL();
  const authHeaders = await getCodeApiAuthHeaders(req, bridgeWorkerId);
  /** @type {import('axios').AxiosRequestConfig} */
  const options = {
    headers: {
      ...form.getHeaders(),
      'Content-Type': 'multipart/form-data',
      'User-Agent': 'LibreChat/1.0',
      'User-Id': req.user.id,
      ...authHeaders,
      ...(executionProfile ? codeExecutionHeaders({ executionProfile, bridgeWorkerId }) : {}),
    },
    httpAgent: codeServerHttpAgent,
    httpsAgent: codeServerHttpsAgent,
    timeout: 120000,
    maxContentLength: MAX_FILE_SIZE,
    maxBodyLength: MAX_FILE_SIZE,
    signal,
  };

  const response = await axios.post(`${baseURL}/upload/batch`, form, options);

  /** @type {{ message: string; storage_session_id: string; files: Array<{ status: string; fileId?: string; filename: string; error?: string }>; succeeded: number; failed: number }} */
  const result = response.data;
  if (
    !result ||
    typeof result !== 'object' ||
    !result.storage_session_id ||
    !Array.isArray(result.files)
  ) {
    throw new Error(`Unexpected batch upload response: ${JSON.stringify(result).slice(0, 200)}`);
  }
  if (result.message === 'error') {
    throw new Error('All files in batch upload failed');
  }

  if (result.failed > 0) {
    const failedNames = result.files
      .filter((f) => f.status === 'error')
      .map((f) => `${f.filename}: ${f.error || 'unknown'}`)
      .join(', ');
    logger.warn(`[batchUploadCodeEnvFiles] ${result.failed} file(s) failed: ${failedNames}`);
  }

  const successFiles = result.files
    .filter((f) => f.status === 'success' && f.fileId)
    .map((f) => ({ fileId: f.fileId, filename: f.filename }));

  return { storage_session_id: result.storage_session_id, files: successFiles };
}

module.exports = {
  deleteCodeEnvFile,
  getCodeOutputDownloadStream,
  uploadCodeEnvFile,
  batchUploadCodeEnvFiles,
};
