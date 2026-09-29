const path = require('path');
const fs = require('fs').promises;
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  getSafeErrorMetadata,
  shouldUseUploadSse,
  startUploadSseStream,
  sendUploadPolicyError,
  resolveUploadErrorMessage,
  verifyAgentUploadPermission,
  assertUploadContentAllowed,
  hasActiveFilePolicy,
  sanitizeFilename,
  checkToolResourceUploadPermission,
} = require('@librechat/api');
const {
  isAssistantsEndpoint,
  hasActivePiiPatterns,
  mergeFileConfig,
  isMessageFileUpload,
  getEndpointFileConfig,
  resolveUploadLLMDeliveryPath,
  isResponsesApiUpload,
  isSpeechProviderConfigured,
} = require('librechat-data-provider');
const {
  processAgentFileUpload,
  processImageFile,
  filterFile,
} = require('~/server/services/Files/process');
const {
  resolveEffectiveToolResource,
  resolveUploadEndpoint,
  resolveUploadAgent,
} = require('~/server/services/Files/routing');
const { checkPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const db = require('~/models');

const router = express.Router();

router.post('/', async (req, res) => {
  const metadata = req.body;
  const appConfig = req.config;

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

    /* Authorization runs before anything reads the target agent, matching the file
     * route. Validating against a record the caller cannot access answers with that
     * agent's provider limits and content policy, so the rejection reports its
     * configuration. Message attachments and requests naming no agent pass straight
     * through without a read. */
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

    /* Agent uploads arrive as `agents` but route by the agent's own provider, so the
     * provider's configuration has to govern acceptance too. Resolved once here and
     * reused by routing, authorization and processing below. */
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
    filterFile({ req, image: true, endpoint: effectiveEndpoint });

    /* A unified upload the config routes to text is processed as a context resource, so
     * the preflight has to judge that destination. Told only the request's empty tool
     * resource, it cannot see the extraction step and fail-closes on a derived field it
     * would in fact be able to inspect. */
    const effectiveToolResource = await resolveEffectiveToolResource({ req, metadata });
    const fileConfig = mergeFileConfig(req.config?.fileConfig);
    const deliveryPath = resolveUploadLLMDeliveryPath({
      mimeType: req.file.mimetype,
      endpointConfig: getEndpointFileConfig({ fileConfig, endpoint: effectiveEndpoint }),
      fileConfig,
      endpoint: effectiveEndpoint,
      useResponsesApi: isResponsesApiUpload(metadata.useResponsesApi),
      sttConfigured: isSpeechProviderConfigured(req.config?.speech?.stt),
    });
    if (
      deliveryPath === 'none' &&
      effectiveToolResource == null &&
      metadata.endpoint !== 'agents'
    ) {
      throw new Error(
        `Files of type ${req.file.mimetype} are not sent to the model here, and this conversation has no agent whose tools could read them.`,
      );
    }

    /** The Code Files UI routes image uploads here instead of `/files`, so the
     * same role gate has to run before any content inspection — otherwise an
     * image is a way around the tool-resource boundary. */
    const uploadAllowed = await checkToolResourceUploadPermission({
      req,
      toolResource: metadata.tool_resource,
      getRoleByName: db.getRoleByName,
    });
    if (!uploadAllowed) {
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    }

    await assertUploadContentAllowed({
      filters: req.config?.filters,
      file: req.file,
      endpoint: metadata.endpoint,
      toolResource: effectiveToolResource,
      fileConfig,
      ocrConfigured: req.config?.ocr != null,
      ragConfigured: !!process.env.RAG_API_URL,
      rawFileMode: 'opaque',
    });

    metadata.temp_file_id = metadata.file_id;
    metadata.file_id = req.file_id;

    /* An image the config routes to text delivery has to go through the agent upload
     * path, which extracts and stores the text. The image pipeline would persist the
     * routing without any text, leaving the file out of provider delivery and out of
     * the text context both.
     *
     * A permanent upload against an agent takes that path regardless of what the routing
     * inferred, because the image pipeline always stores a message attachment and never
     * files anything against the agent. Sent here it would report success while leaving
     * an orphan, so it goes where that is decided rather than assumed. */
    const isPermanentAgentUpload =
      metadata.agent_id != null && !isMessageFileUpload(metadata.message_file);
    const takesAgentUploadPath = effectiveToolResource != null || isPermanentAgentUpload;

    if (!isAssistants && takesAgentUploadPath) {
      openSseStreamIfRequested();
      return await processAgentFileUpload({ req, res, metadata, sseStream });
    }

    openSseStreamIfRequested();
    await processImageFile({ req, res, metadata, sseStream });
  } catch (error) {
    // TODO: delete remote file if it exists
    logger.error('[/files/images] Error processing file:', getSafeErrorMetadata(error));

    try {
      const filepath = path.join(
        appConfig.paths.imageOutput,
        req.user.id,
        path.basename(req.file.filename),
      );
      await fs.unlink(filepath);
    } catch (cleanupError) {
      logger.error('[/files/images] Error deleting file:', getSafeErrorMetadata(cleanupError));
    }
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
    if (sseStream) {
      sseStream.sendError({
        message,
        code: 500,
        temp_file_id: metadata.temp_file_id,
        tool_resource: metadata.tool_resource,
        display_to_user: true,
      });
    } else {
      res.status(500).json({ message });
    }
  } finally {
    try {
      await fs.unlink(req.file.path);
      logger.debug('[/files/images] Temp. image upload file deleted');
    } catch {
      logger.debug('[/files/images] Temp. image upload file already deleted');
    }
    if (sseStream) {
      sseStream.close();
    }
  }
});

module.exports = router;
