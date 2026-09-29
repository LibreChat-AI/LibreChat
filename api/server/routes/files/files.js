const fs = require('fs').promises;
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  logAxiosError,
  getSafeErrorMetadata,
  getApprovalTtlMs,
  refreshS3FileUrls,
  handleFilesUsageRequest,
  buildDeleteFilesResponse,
  shouldUseUploadSse,
  startUploadSseStream,
  sendUploadPolicyError,
  resolveUploadErrorMessage,
  verifyAgentUploadPermission,
  createCodeExecutionRouteKey,
  getCodeExecutionBaseUrl,
  assertUploadContentAllowed,
  hasActiveFilePolicy,
  sanitizeFilename,
  checkToolResourceUploadPermission,
  resolveAssistantToolPermissions,
  resolveDownloadPath,
} = require('@librechat/api');
const {
  Time,
  isUUID,
  CacheKeys,
  FileSources,
  ResourceType,
  EModelEndpoint,
  EToolResources,
  PermissionBits,
  checkOpenAIStorage,
  isAssistantsEndpoint,
  hasActivePiiPatterns,
  mergeFileConfig,
} = require('librechat-data-provider');
const {
  filterFile,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
} = require('~/server/services/Files/process');
const {
  resolveEffectiveToolResource,
  resolveUploadEndpoint,
  resolveUploadAgent,
} = require('~/server/services/Files/routing');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getRoleByName } = require('~/models');
const { checkPermission } = require('~/server/services/PermissionService');
const { cleanFileName, getContentDisposition } = require('~/server/utils/files');
const { getLogStores } = require('~/cache');
const { Readable } = require('stream');
const db = require('~/models');

const router = express.Router();
const AGENT_TOOL_RESOURCE_KEYS = new Set([
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
  EToolResources.context,
  EToolResources.ocr,
]);

const isAgentToolResourceKey = (toolResource) =>
  typeof toolResource === 'string' && AGENT_TOOL_RESOURCE_KEYS.has(toolResource);

router.get('/', async (req, res) => {
  try {
    const appConfig = req.config;
    const files = await db.getFiles({ user: req.user.id });
    if (appConfig.fileStrategy === FileSources.s3) {
      try {
        const cache = getLogStores(CacheKeys.S3_EXPIRY_INTERVAL);
        const alreadyChecked = await cache.get(req.user.id);
        if (!alreadyChecked) {
          await refreshS3FileUrls(files, db.batchUpdateFiles);
          await cache.set(req.user.id, true, Time.THIRTY_MINUTES);
        }
      } catch (error) {
        logger.warn('[/files] Error refreshing S3 file URLs:', error);
      }
    }
    res.status(200).send(files);
  } catch (error) {
    logger.error('[/files] Error getting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

/**
 * Get files specific to an agent
 * @route GET /files/agent/:agent_id
 * @param {string} agent_id - The agent ID to get files for
 * @returns {Promise<TFile[]>} Array of files attached to the agent
 */
router.get('/agent/:agent_id', async (req, res) => {
  try {
    const { agent_id } = req.params;
    const userId = req.user.id;

    if (!agent_id) {
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    const agent = await db.getAgent({ id: agent_id });
    if (!agent) {
      return res.status(200).json([]);
    }

    if (agent.author.toString() !== userId) {
      const hasEditPermission = await checkPermission({
        userId,
        role: req.user.role,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.EDIT,
      });

      if (!hasEditPermission) {
        return res.status(200).json([]);
      }
    }

    const agentFileIds = new Set();
    if (agent.tool_resources) {
      for (const [, resource] of Object.entries(agent.tool_resources)) {
        if (resource?.file_ids && Array.isArray(resource.file_ids)) {
          resource.file_ids.forEach((fileId) => agentFileIds.add(fileId));
        }
      }
    }

    if (agentFileIds.size === 0) {
      return res.status(200).json([]);
    }

    const files = await db.getFiles({ file_id: { $in: [...agentFileIds] } }, null, {
      text: 0,
    });

    res.status(200).json(files);
  } catch (error) {
    logger.error('[/files/agent/:agent_id] Error fetching agent files:', error);
    res.status(500).json({ error: 'Failed to fetch agent files' });
  }
});

router.get('/config', async (req, res) => {
  try {
    const appConfig = req.config;
    res.status(200).json(appConfig.fileConfig);
  } catch (error) {
    logger.error('[/files] Error getting fileConfig', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

/**
 * POST /files/usage
 *
 * Owner-scoped TTL hold for uploads sitting in a client-side queue (mid-run
 * queued messages), so the upload-window TTL cannot reap them before drain.
 * Extends the deadline rather than clearing it; the real release happens at
 * send. The approval window is passed through so a queue waiting on a paused
 * run outlives that pause. Thin wrapper: validation, cap, hold window, and
 * best-effort semantics live in `@librechat/api` (`handleFilesUsageRequest`).
 */
router.post('/usage', async (req, res) => {
  try {
    const checkpointerCfg = req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
    const { status, body } = await handleFilesUsageRequest(req.user ?? {}, req.body ?? {}, {
      extendFilesTTL: db.extendFilesTTL,
      approvalTtlMs: getApprovalTtlMs(checkpointerCfg),
    });
    return res.status(status).json(body);
  } catch (error) {
    logger.error('[/files/usage] Failed to mark files used', error);
    return res.status(500).json({ code: 'FILES_USAGE_FAILED' });
  }
});

router.delete('/', async (req, res) => {
  try {
    const sendDeleteResult = (result, successMessage) =>
      res.status(200).json(buildDeleteFilesResponse(result, successMessage));

    const { files: _files } = req.body;

    /** @type {MongoFile[]} */
    const files = _files.filter((file) => {
      if (!file.file_id) {
        return false;
      }
      if (!file.filepath) {
        return false;
      }

      if (/^(file|assistant)-/.test(file.file_id)) {
        return true;
      }

      return isUUID.safeParse(file.file_id).success;
    });

    if (files.length === 0) {
      res.status(204).json({ message: 'Nothing provided to delete' });
      return;
    }

    const fileIds = files.map((file) => file.file_id);
    const dbFiles = await db.getFiles({ file_id: { $in: fileIds } });

    if (req.body.agent_id && req.body.tool_resource) {
      if (!isAgentToolResourceKey(req.body.tool_resource)) {
        return res.status(400).json({ message: 'Invalid agent tool resource' });
      }

      const agent = await db.getAgent({
        id: req.body.agent_id,
      });

      if (!agent) {
        return res.status(404).json({ message: 'Agent not found' });
      }

      const hasAgentEditAccess =
        agent.author?.toString() === req.user.id.toString() ||
        (await checkPermission({
          userId: req.user.id,
          role: req.user.role,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          requiredPermission: PermissionBits.EDIT,
        }));
      if (!hasAgentEditAccess) {
        return res.status(403).json({
          message: 'You can only delete files you have access to',
          unauthorizedFiles: files.map((file) => file.file_id),
        });
      }

      const toolResourceFiles = agent.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const agentFiles = files
        .filter((f) => toolResourceFiles.includes(f.file_id))
        .map((file) => ({ tool_resource: req.body.tool_resource, file_id: file.file_id }));
      if (agentFiles.length === 0) {
        res.status(200).json({ message: 'File associations removed successfully from agent' });
        return;
      }

      await db.removeAgentResourceFiles({
        agent_id: req.body.agent_id,
        files: agentFiles,
      });
      res.status(200).json({ message: 'File associations removed successfully from agent' });
      return;
    }

    const ownedFiles = [];
    const nonOwnedFiles = [];

    for (const file of dbFiles) {
      if (file.user.toString() === req.user.id.toString()) {
        ownedFiles.push(file);
      } else {
        nonOwnedFiles.push(file);
      }
    }

    if (dbFiles.length > 0 && nonOwnedFiles.length === 0) {
      const result = await processDeleteRequest({ req, files: ownedFiles });
      logger.debug(
        `[/files] Files deleted successfully: ${ownedFiles
          .filter((f) => f.file_id)
          .map((f) => f.file_id)
          .join(', ')}`,
      );
      sendDeleteResult(result, 'Files deleted successfully');
      return;
    }

    const authorizedFiles = [...ownedFiles];
    const unauthorizedFiles = nonOwnedFiles;

    if (unauthorizedFiles.length > 0) {
      return res.status(403).json({
        message: 'You can only delete files you own',
        unauthorizedFiles: unauthorizedFiles.map((f) => f.file_id),
      });
    }

    /* Handle assistant unlinking even if no valid files to delete */
    if (req.body.assistant_id && req.body.tool_resource && dbFiles.length === 0) {
      const assistant = await db.getAssistant({
        assistantId: req.body.assistant_id,
      });

      const toolResourceFiles = assistant?.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const assistantFiles = files.filter((f) => toolResourceFiles.includes(f.file_id));

      const result = await processDeleteRequest({ req, files: assistantFiles });
      sendDeleteResult(result, 'File associations removed successfully from assistant');
      return;
    } else if (
      req.body.assistant_id &&
      req.body.files?.[0]?.filepath === EModelEndpoint.azureAssistants
    ) {
      const result = await processDeleteRequest({ req, files: req.body.files });
      sendDeleteResult(result, 'File associations removed successfully from Azure Assistant');
      return;
    }

    const result = await processDeleteRequest({ req, files: authorizedFiles });

    logger.debug(
      `[/files] Files deleted successfully: ${authorizedFiles
        .filter((f) => f.file_id)
        .map((f) => f.file_id)
        .join(', ')}`,
    );
    sendDeleteResult(result, 'Files deleted successfully');
  } catch (error) {
    logger.error('[/files] Error deleting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

function isValidID(str) {
  return /^[A-Za-z0-9_-]{21}$/.test(str);
}

router.get('/code/download/:session_id/:fileId', async (req, res) => {
  try {
    const { session_id, fileId } = req.params;
    const logPrefix = `Session ID: ${session_id} | File ID: ${fileId} | Code output download requested by user `;
    logger.debug(logPrefix);

    if (!session_id || !fileId) {
      return res.status(400).send('Bad request');
    }

    if (!isValidID(session_id) || !isValidID(fileId)) {
      logger.debug(`${logPrefix} invalid session_id or fileId`);
      return res.status(400).send('Bad request');
    }

    const requestedProfile = req.query.execution_profile;
    if (
      requestedProfile != null &&
      requestedProfile !== 'default' &&
      requestedProfile !== 'stateful'
    ) {
      logger.debug(`${logPrefix} invalid execution_profile`);
      return res.status(400).send('Bad request');
    }
    const executionProfile = requestedProfile ?? 'default';
    const requestedRouteKey = req.query.execution_route_key;
    if (
      requestedRouteKey != null &&
      (typeof requestedRouteKey !== 'string' ||
        executionProfile !== 'stateful' ||
        !/^stateful:[a-f0-9]{32}$/.test(requestedRouteKey))
    ) {
      logger.debug(`${logPrefix} invalid execution_route_key`);
      return res.status(400).send('Bad request');
    }
    const environments =
      req.config?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments;
    const configuredEnvironment = requestedRouteKey
      ? environments?.find(
          (environment) =>
            createCodeExecutionRouteKey('stateful', environment) === requestedRouteKey,
        )
      : undefined;
    if (requestedRouteKey && !configuredEnvironment) {
      logger.debug(`${logPrefix} unknown execution_route_key`);
      return res.status(404).send('Not found');
    }
    const baseUrl = getCodeExecutionBaseUrl(executionProfile, configuredEnvironment);

    const { getDownloadStream } = getStrategyFunctions(FileSources.execute_code);
    if (!getDownloadStream) {
      logger.warn(
        `${logPrefix} has no stream method implemented for ${FileSources.execute_code} source`,
      );
      return res.status(501).send('Not Implemented');
    }

    /* Code-output downloads are always user-private — `processCodeOutput`
     * persists every code-execution artifact under
     * `metadata.codeEnvRef.kind === 'user'` regardless of which skill
     * the run invoked. Pass `kind: 'user'` + `id: <userId>` so codeapi's
     * `sessionAuth` resolves the matching `<tenant>:user:<userId>`
     * sessionKey; without these query params it 400s with
     * "kind must be one of: skill, agent, user". */
    /** @type {AxiosResponse<ReadableStream> | undefined} */
    const response = await getDownloadStream(
      `${session_id}/${fileId}`,
      {
        kind: 'user',
        id: req.user.id,
      },
      req,
      {
        baseUrl,
        executionProfile,
        ...((configuredEnvironment?.workerId ?? configuredEnvironment?.pairing?.workerId) != null
          ? {
              bridgeWorkerId:
                configuredEnvironment?.workerId ?? configuredEnvironment?.pairing?.workerId,
            }
          : {}),
      },
    );
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    response.data.pipe(res);
  } catch (error) {
    /* `logAxiosError` redacts buffer/stream response bodies — without
     * it, a stream-typed axios failure dumps the entire `Readable`'s
     * internal state (megabytes of socket + readableState) into the
     * log line. Plain `logger.error(error)` would do that here. */
    logAxiosError({ message: 'Error downloading code-output file', error });
    res.status(500).send('Error downloading file');
  }
});

/* Lazy-sweep cutoff: pending records older than this are marked failed
 * on the next poll. 2min is well past the 60s render ceiling, so any
 * `pending` past it is definitively orphaned. Tighter than the boot
 * sweep (5min) since this runs per-request, not per-instance. */
const PREVIEW_LAZY_SWEEP_CUTOFF_MS = 2 * 60 * 1000;

/**
 * Poll the lifecycle status of a code-execution file's inline preview.
 *
 * Deferred-preview flow: the immediate persist step writes the file
 * record at `status: 'pending'`; the background render transitions
 * it to `'ready'` (with `text` + `textFormat`) or `'failed'` (with
 * `previewError`). The frontend's `useFilePreview` React Query hook
 * polls this endpoint at ~2.5s intervals while `status === 'pending'`,
 * then auto-stops on terminal status.
 *
 * Returns the smallest viable shape:
 *   - `status` always present (defaults to `'ready'` for legacy records
 *     that never had the field — clients treat absent as ready).
 *   - `text` and `textFormat` only when status is 'ready' AND text
 *     is non-null (preserves the security contract from PR #12934 —
 *     office bucket files MUST NOT receive plain-text fallbacks).
 *   - `previewError` only when status is 'failed'.
 *
 * Lazy-sweeps stale `pending` records on the spot — see
 * `PREVIEW_LAZY_SWEEP_CUTOFF_MS` for the rationale.
 *
 * Reuses the `fileAccess` middleware so ACL is identical to download.
 *
 * @route GET /files/:file_id/preview
 */
router.get('/:file_id/preview', fileAccess, async (req, res) => {
  try {
    const { file_id } = req.params;
    /* `fileAccess` already fetched the record (sans `text`, the default
     * projection drops it). Reuse for the lifecycle check; only re-fetch
     * with `text` on a terminal ready response — the typical lifecycle
     * is N pending polls + 1 ready, so this avoids ~N redundant text
     * reads per file. */
    let file = req.fileAccess.file;
    /* Lazy sweep: if stuck `pending` past the cutoff, mark `failed`
     * conditional on the observed `updatedAt` (concurrent legitimate
     * updates win). */
    if (file.status === 'pending' && file.updatedAt instanceof Date) {
      const ageMs = Date.now() - file.updatedAt.getTime();
      if (ageMs > PREVIEW_LAZY_SWEEP_CUTOFF_MS) {
        const swept = await db.updateFile(
          { file_id, status: 'failed', previewError: 'orphaned' },
          { status: 'pending', updatedAt: file.updatedAt },
        );
        if (swept) {
          file = swept;
          logger.info(
            `[/files/:file_id/preview] Lazy-swept orphaned pending record ${file_id} (age ${Math.round(ageMs / 1000)}s)`,
          );
        }
      }
    }
    /* Default to 'ready' for back-compat: legacy records pre-date the
     * field, and non-office files never get a status set on persist. */
    const status = file.status ?? 'ready';
    const payload = { file_id, status };
    if (status === 'ready') {
      const withText = await db.findFileById(file_id);
      if (withText?.text != null) {
        payload.text = withText.text;
        payload.textFormat = withText.textFormat ?? null;
      }
    } else if (status === 'failed' && file.previewError) {
      payload.previewError = file.previewError;
    }
    return res.status(200).json(payload);
  } catch (error) {
    logger.error('[/files/:file_id/preview] Error fetching preview status:', error);
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'Failed to fetch preview status' });
  }
});

/**
 * Returns a strategy-managed signed URL for an already-authorized file record.
 */
const getDirectDownloadURL = async ({
  req,
  file,
  customFilename = cleanFileName(file.filename),
}) => {
  const { getDownloadURL } = getStrategyFunctions(file.source);
  if (!getDownloadURL) {
    return null;
  }

  return getDownloadURL({
    req,
    file,
    customFilename,
    contentType: file.type || 'application/octet-stream',
  });
};

// Security allowlist: excludes internal ids, owner/tenant identifiers, and extracted text.
// `filepath` stays included because cached TFile records need it for previews/deletes.
const DOWNLOAD_METADATA_FIELDS = [
  'conversationId',
  'message',
  'file_id',
  'temp_file_id',
  'bytes',
  'model',
  'embedded',
  'filename',
  'filepath',
  'storageKey',
  'storageRegion',
  'object',
  'type',
  'usage',
  'context',
  'source',
  'filterSource',
  'width',
  'height',
  'expiresAt',
  'preview',
  'textFormat',
  'status',
  'previewError',
  'createdAt',
  'updatedAt',
];

const getDownloadFileMetadata = (file) => {
  const rawFile = typeof file.toObject === 'function' ? file.toObject() : file;
  return DOWNLOAD_METADATA_FIELDS.reduce((metadata, field) => {
    if (rawFile[field] !== undefined) {
      metadata[field] = rawFile[field];
    }
    return metadata;
  }, {});
};

router.get('/download-url/:userId/:file_id', fileAccess, async (req, res) => {
  try {
    const { userId, file_id } = req.params;
    logger.debug(`File download URL requested by user ${userId}: ${file_id}`);

    const file = req.fileAccess.file;
    if (checkOpenAIStorage(file.source) && !file.model) {
      logger.warn(
        `File download URL requested by user ${userId} has no associated model: ${file_id}`,
      );
      return res.status(400).send('The model used when creating this file is not available');
    }

    const filename = cleanFileName(file.filename);
    const downloadURL = checkOpenAIStorage(file.source)
      ? null
      : await getDirectDownloadURL({ req, file, customFilename: filename });

    if (!downloadURL) {
      logger.debug(
        `File download URL requested by user ${userId} is not supported for source: ${file.source}`,
      );
      return res.status(501).send('Not Implemented');
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      url: downloadURL,
      filename,
      type: file.type || 'application/octet-stream',
      metadata: getDownloadFileMetadata(file),
    });
  } catch (error) {
    logger.error('[DOWNLOAD URL ROUTE] Error generating file download URL:', error);
    res.status(500).send('Error generating file download URL');
  }
});

router.get('/download/:userId/:file_id', fileAccess, async (req, res) => {
  try {
    const { userId, file_id } = req.params;
    logger.debug(`File download requested by user ${userId}: ${file_id}`);

    // Access already validated by fileAccess middleware
    const file = req.fileAccess.file;

    // Text-source files store extracted content in the DB; there is no backing file to stream
    if (file.source === FileSources.text) {
      /** `getFiles` excludes `text` by default, so the authorized record is re-fetched by `_id` */
      const [textFile] = (await db.getFiles({ _id: file._id }, null, { text: 1 })) ?? [];
      if (textFile?.text == null) {
        logger.warn(`File download requested by user ${userId} has no stored text: ${file_id}`);
        return res.status(404).send('No file content found');
      }
      const textFilename = file.filename?.toLowerCase().endsWith('.txt')
        ? file.filename
        : `${file.filename || file_id}.txt`;
      res.setHeader('Content-Disposition', getContentDisposition(textFilename));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'X-File-Metadata',
        encodeURIComponent(JSON.stringify(getDownloadFileMetadata(file))),
      );
      return res.send(textFile.text);
    }

    if (checkOpenAIStorage(file.source) && !file.model) {
      logger.warn(`File download requested by user ${userId} has no associated model: ${file_id}`);
      return res.status(400).send('The model used when creating this file is not available');
    }

    const { getDownloadStream, getDownloadURL } = getStrategyFunctions(file.source);
    if (!getDownloadStream && !getDownloadURL) {
      logger.warn(
        `File download requested by user ${userId} has no download method implemented: ${file.source}`,
      );
      return res.status(501).send('Not Implemented');
    }

    const setHeaders = () => {
      res.setHeader('Content-Disposition', getContentDisposition(file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'X-File-Metadata',
        encodeURIComponent(JSON.stringify(getDownloadFileMetadata(file))),
      );
    };

    if (checkOpenAIStorage(file.source)) {
      req.body = { model: file.model };
      const endpointMap = {
        [FileSources.openai]: EModelEndpoint.assistants,
        [FileSources.azure]: EModelEndpoint.azureAssistants,
      };
      const { openai } = await getOpenAIClient({
        req,
        res,
        overrideEndpoint: endpointMap[file.source],
      });
      logger.debug(`Downloading file ${file_id} from OpenAI`);
      const passThrough = await getDownloadStream(file_id, openai);
      setHeaders();
      logger.debug(`File ${file_id} downloaded from OpenAI`);

      // Handle both Node.js and Web streams
      const stream =
        passThrough.body && typeof passThrough.body.getReader === 'function'
          ? Readable.fromWeb(passThrough.body)
          : passThrough.body;

      stream.pipe(res);
    } else {
      if (getDownloadURL && req.query.direct === 'true') {
        try {
          const downloadURL = await getDirectDownloadURL({ req, file });
          if (downloadURL) {
            res.setHeader('Cache-Control', 'no-store');
            return res.redirect(302, downloadURL);
          }
        } catch (error) {
          logger.warn(
            '[DOWNLOAD ROUTE] Falling back to stream after URL generation failed:',
            error,
          );
        }
      }

      if (!getDownloadStream) {
        logger.warn(
          `File download requested by user ${userId} has no stream method implemented: ${file.source}`,
        );
        return res.status(501).send('Not Implemented');
      }

      const fileStream = await getDownloadStream(req, resolveDownloadPath(file));

      fileStream.on('error', (streamError) => {
        logger.error('[DOWNLOAD ROUTE] Stream error:', streamError);
        if (res.headersSent) {
          if (!res.writableEnded) {
            res.destroy();
          }
          return;
        }
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        res.removeHeader('X-File-Metadata');
        res.status(500).send('Error downloading file');
      });

      setHeaders();
      fileStream.pipe(res);
    }
  } catch (error) {
    logger.error('[DOWNLOAD ROUTE] Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

/**
 * A v1 Knowledge upload posts `assistant_id` with no `tool_resource`, so the
 * resource map has nothing to authorize against. What the file will feed is the
 * assistant's own native tools, so read those and require their grants.
 *
 * Runs here rather than at attach time so a denied role never gets its bytes
 * into provider storage — an authorization failure after the remote upload
 * leaves an untracked file behind and reports 500 for what is a 403.
 *
 * @returns {Promise<{ ok: boolean, openai?: OpenAI }>} `ok: false` once a
 * response has been sent. The client it had to build is returned so processing
 * reuses it rather than re-reading the user's key.
 */
const assertLegacyAssistantUploadAllowed = async (req, res, metadata) => {
  const isLegacyAssistantAttach =
    isAssistantsEndpoint(metadata.endpoint) &&
    metadata.assistant_id != null &&
    !metadata.message_file &&
    !metadata.tool_resource;
  if (!isLegacyAssistantAttach) {
    return { ok: true };
  }

  const { openai } = await getOpenAIClient({ req });
  const assistant = await openai.beta.assistants.retrieve(metadata.assistant_id);
  const isNativeToolPermitted = await resolveAssistantToolPermissions({
    req,
    tools: assistant?.tools,
    getRoleByName,
  });
  if ((assistant?.tools ?? []).some((tool) => !isNativeToolPermitted(tool))) {
    res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    return { ok: false };
  }
  return { ok: true, openai };
};

const handleFileUpload = async (req, res) => {
  const metadata = req.body;
  let cleanup = true;

  /** Opened only once auth/validation has passed, right before the potentially
   * long-running upload processing begins — see `startUploadSseStream`. */
  let sseStream = null;
  const openSseStreamIfRequested = () => {
    if (shouldUseUploadSse(req)) {
      sseStream = startUploadSseStream(res);
    }
  };

  try {
    req.file.originalname = sanitizeFilename(req.file.originalname);
    const isAssistants = isAssistantsEndpoint(metadata.endpoint);

    /* Authorization runs before anything reads the target agent. Validating against a
     * record the caller cannot access answers with that agent's provider limits and
     * content policy, so the rejection itself reports its configuration. */
    if (!isAssistants) {
      const denied = await verifyAgentUploadPermission({
        req,
        res,
        metadata,
        getAgent: ({ id }) => resolveUploadAgent(req, id),
        checkPermission,
        hasUploadBypass: () => hasCapability(req.user, SystemCapabilities.MANAGE_AGENTS),
      });
      if (denied) {
        return;
      }
    }

    /* Same configuration for validation and routing: an agent upload arrives as
     * `agents` but is processed under the agent's own provider. */
    const effectiveEndpoint = await resolveUploadEndpoint({
      endpoint: metadata.endpoint,
      agent_id: metadata.agent_id,
      req,
    });
    /* Carried so processing routes under the same configuration validation used, and so
     * it can tell whether any enabled tool could consume a file kept off the model path,
     * both from the one agent read this request already made. */
    metadata.effectiveEndpoint = effectiveEndpoint;
    /* Left undefined when no agent record backs this upload, as for an ephemeral agent
     * that exists only for the request. Processing then cannot judge what tools could
     * consume the file and does not try. */
    const uploadAgent = await resolveUploadAgent(req, metadata.agent_id);
    metadata.agentTools = uploadAgent?.tools;
    metadata.useResponsesApi ??= uploadAgent?.model_parameters?.useResponsesApi;
    filterFile({ req, endpoint: effectiveEndpoint });

    /* Same destination the processing path will use: a unified upload routed to text
     * becomes a context resource, and the preflight must account for that extraction
     * before fail-closing on an uninspectable derived field. */
    const effectiveToolResource = await resolveEffectiveToolResource({ req, metadata });

    /** Check the role permission before any content inspection: a forbidden upload
     * must be rejected without reading or embedding the file. */
    const uploadAllowed = await checkToolResourceUploadPermission({
      req,
      toolResource: metadata.tool_resource,
      getRoleByName,
    });
    if (!uploadAllowed) {
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    }

    const legacyAssistantUpload = await assertLegacyAssistantUploadAllowed(req, res, metadata);
    if (!legacyAssistantUpload.ok) {
      return;
    }

    await assertUploadContentAllowed({
      filters: req.config?.filters,
      file: req.file,
      endpoint: metadata.endpoint,
      toolResource: effectiveToolResource,
      fileConfig: mergeFileConfig(req.config?.fileConfig),
      ocrConfigured: req.config?.ocr != null,
      ragConfigured: !!process.env.RAG_API_URL,
      readFile: fs.readFile,
    });

    metadata.temp_file_id = metadata.file_id;
    metadata.file_id = req.file_id;

    if (isAssistants) {
      openSseStreamIfRequested();
      return await processFileUpload({
        req,
        res,
        metadata,
        sseStream,
        openai: legacyAssistantUpload.openai,
      });
    }

    openSseStreamIfRequested();
    return await processAgentFileUpload({ req, res, metadata, sseStream });
  } catch (error) {
    if (
      sendUploadPolicyError(res, sseStream, error, {
        tempFileId: metadata.temp_file_id,
        toolResource: metadata.tool_resource,
      })
    ) {
      return;
    }
    const contentProtectionActive =
      hasActiveFilePolicy(req.config?.filters) ||
      hasActivePiiPatterns(req.config?.messageFilter?.pii);
    const message = resolveUploadErrorMessage(
      error,
      'Error processing file',
      contentProtectionActive,
    );
    logger.error('[/files] Error processing file:', getSafeErrorMetadata(error));

    try {
      await fs.unlink(req.file.path);
      cleanup = false;
    } catch (cleanupError) {
      logger.error('[/files] Error deleting file:', getSafeErrorMetadata(cleanupError));
    }

    const userErrorStatusCode = error?.userErrorStatusCode;
    const errorStatusCode =
      Number.isInteger(userErrorStatusCode) &&
      userErrorStatusCode >= 400 &&
      userErrorStatusCode <= 599
        ? userErrorStatusCode
        : 500;

    if (sseStream) {
      sseStream.sendError({
        message,
        code: errorStatusCode,
        temp_file_id: metadata.temp_file_id,
        tool_resource: metadata.tool_resource,
        display_to_user: true,
      });
    } else {
      res.status(errorStatusCode).json({ message });
    }
  } finally {
    if (cleanup) {
      try {
        await fs.unlink(req.file.path);
      } catch (error) {
        logger.error(
          '[/files] Error deleting file after file processing:',
          getSafeErrorMetadata(error),
        );
      }
    } else {
      logger.debug('[/files] File processing completed without cleanup');
    }
    if (sseStream) {
      sseStream.close();
    }
  }
};

router.post('/', handleFileUpload);

module.exports = router;
module.exports.handleFileUpload = handleFileUpload;
