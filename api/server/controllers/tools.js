const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const {
  checkAccess,
  assertDirectToolOutputAllowed,
  loadWebSearchAuth,
  isContentFilterError,
  isActiveExpirationDate,
  getConversationExpirationDate,
} = require('@librechat/api');
const {
  Tools,
  AuthType,
  Permissions,
  ToolCallTypes,
  PermissionTypes,
} = require('librechat-data-provider');
const { getRoleByName, createToolCall, getToolCallsByConvo, getMessage } = require('~/models');
const { processFileURL, uploadImageBuffer } = require('~/server/services/Files/process');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { processCodeOutput, runPreviewFinalize } = require('~/server/services/Files/Code/process');
const { preflightCodeOutputBatch } = require('~/server/services/Files/Code/preflight');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { loadTools } = require('~/app/clients/tools/util');

/**
 * Tools that are callable directly via `POST /tools/:toolId/call`.
 * `execute_code` is the only entry today; the tool runs server-side via
 * the agents library / sandbox service without any per-user credential.
 */
const directCallableTools = new Set([Tools.execute_code]);

const toolAccessPermType = {
  [Tools.execute_code]: PermissionTypes.RUN_CODE,
};

/**
 * Verifies web search authentication, ensuring each category has at least
 * one fully authenticated service.
 *
 * @param {ServerRequest} req - The request object
 * @param {ServerResponse} res - The response object
 * @returns {Promise<void>} A promise that resolves when the function has completed
 */
const verifyWebSearchAuth = async (req, res) => {
  try {
    const appConfig = req.config;
    const userId = req.user.id;
    /** @type {TCustomConfig['webSearch']} */
    const webSearchConfig = appConfig?.webSearch || {};
    const result = await loadWebSearchAuth({
      userId,
      loadAuthValues,
      webSearchConfig,
      throwError: false,
    });

    return res.status(200).json({
      authenticated: result.authenticated,
      authTypes: result.authTypes,
      searchProvider: result.authResult.searchProvider,
      scraperProvider: result.authResult.scraperProvider,
      rerankerType: result.authResult.rerankerType,
    });
  } catch (error) {
    console.error('Error in verifyWebSearchAuth:', error);
    return res.status(500).json({ message: error.message });
  }
};

/**
 * @param {ServerRequest} req - The request object, containing information about the HTTP request.
 * @param {ServerResponse} res - The response object, used to send back the desired HTTP response.
 * @returns {Promise<void>} A promise that resolves when the function has completed.
 */
const verifyToolAuth = async (req, res) => {
  try {
    const { toolId } = req.params;
    if (toolId === Tools.web_search) {
      return await verifyWebSearchAuth(req, res);
    }
    if (!directCallableTools.has(toolId)) {
      res.status(404).json({ message: 'Tool not found' });
      return;
    }
    /**
     * `execute_code` no longer requires a per-user credential — sandbox
     * auth is handled server-side by the agents library. Always report
     * system-authenticated so the client proceeds straight to the call
     * without a key-entry dialog.
     *
     * Deployment contract: reachability of the sandbox service is the
     * admin's responsibility. This endpoint does not probe the service
     * (a per-auth-check network hop would be too expensive for what is
     * a UI-gate query). If the sandbox is unreachable, the call path
     * surfaces the error at execution time instead of here.
     */
    res.status(200).json({ authenticated: true, message: AuthType.SYSTEM_DEFINED });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * @param {ServerRequest} req - The request object, containing information about the HTTP request.
 * @param {ServerResponse} res - The response object, used to send back the desired HTTP response.
 * @param {NextFunction} next - The next middleware function to call.
 * @returns {Promise<void>} A promise that resolves when the function has completed.
 */
const callTool = async (req, res) => {
  try {
    const appConfig = req.config;
    const { toolId = '' } = req.params;
    if (!directCallableTools.has(toolId)) {
      logger.warn(`[${toolId}/call] User ${req.user.id} attempted call to invalid tool`);
      res.status(404).json({ message: 'Tool not found' });
      return;
    }

    const { partIndex, blockIndex, messageId, conversationId: _conversationId, ...args } = req.body;
    if (!messageId) {
      logger.warn(`[${toolId}/call] User ${req.user.id} attempted call without message ID`);
      res.status(400).json({ message: 'Message ID required' });
      return;
    }

    const message = await getMessage({ user: req.user.id, messageId });
    const sourceExpiration = getConversationExpirationDate(message);
    if (!message || (sourceExpiration != null && !isActiveExpirationDate(sourceExpiration))) {
      logger.debug(`[${toolId}/call] User ${req.user.id} attempted call with invalid message ID`);
      res.status(404).json({ message: 'Message not found' });
      return;
    }
    const conversationId = message.conversationId;
    req.body.conversationId = conversationId;
    req.fileRetentionSource = {
      isTemporary: message.isTemporary,
      expiredAt: message.expiredAt,
    };
    const retentionExpiryPromise = getRetentionExpiry(req);
    logger.debug(`[${toolId}/call] User: ${req.user.id}`);
    let hasAccess = true;
    if (toolAccessPermType[toolId]) {
      /** `req` is what puts this read in the request cache, so the shared
       *  `loadTools` gate below resolves the same grant for free instead of
       *  issuing a second serial role lookup before the sandbox call. */
      hasAccess = await checkAccess({
        req,
        user: req.user,
        permissionType: toolAccessPermType[toolId],
        permissions: [Permissions.USE],
        getRoleByName,
      });
    }
    if (!hasAccess) {
      logger.warn(
        `[${toolAccessPermType[toolId]}] Forbidden: Insufficient permissions for User ${req.user.id}: ${Permissions.USE}`,
      );
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    }
    const { loadedTools } = await loadTools({
      user: req.user.id,
      tools: [toolId],
      functions: true,
      options: {
        req,
        returnMetadata: true,
        processFileURL,
        uploadImageBuffer,
      },
      webSearch: appConfig.webSearch,
      fileStrategy: appConfig.fileStrategy,
      imageOutputType: appConfig.imageOutputType,
    });

    const tool = loadedTools[0];
    const toolCallId = `${req.user.id}_${nanoid()}`;
    const result = await tool.invoke({
      args,
      name: toolId,
      id: toolCallId,
      type: ToolCallTypes.TOOL_CALL,
    });

    const { content, artifact } = result;
    assertDirectToolOutputAllowed(appConfig?.filters, toolId, content);
    const hasGeneratedArtifacts = toolId === Tools.execute_code && Array.isArray(artifact?.files);
    const generatedFiles = hasGeneratedArtifacts
      ? await preflightCodeOutputBatch({ req, artifact })
      : [];
    const toolCallData = {
      toolId,
      messageId,
      partIndex,
      blockIndex,
      conversationId,
      result: content,
      user: req.user.id,
      ...(await retentionExpiryPromise),
    };

    if (!hasGeneratedArtifacts) {
      createToolCall(toolCallData).catch((error) => {
        logger.error(`Error creating tool call: ${error.message}`);
      });
      return res.status(200).json({
        result: content,
      });
    }

    const attachments = [];
    for (const { file, sessionId, preparedBuffer, downloadFallback } of generatedFiles) {
      const { id, name } = file;
      try {
        const result = await processCodeOutput({
          req,
          id,
          name,
          messageId,
          toolCallId,
          conversationId,
          session_id: sessionId,
          preparedBuffer,
          downloadFallback,
        });
        const fileMetadata = result?.file ?? null;
        const finalize = result?.finalize;
        if (!fileMetadata) {
          attachments.push(null);
          continue;
        }
        /* This endpoint is non-streaming and its contract is "give
         * me the artifacts" — return the persisted record immediately
         * (with `status: 'pending'` for office buckets) and run the
         * preview render in the background. The client polls
         * `/api/files/:file_id/preview` for the resolved record.
         * No `onResolved` — there's no live stream to write to here. */
        runPreviewFinalize({
          finalize,
          fileId: fileMetadata.file_id,
          previewRevision: result?.previewRevision,
        });
        attachments.push(fileMetadata);
      } catch {
        logger.error('Error processing code output');
        attachments.push(null);
      }
    }
    toolCallData.attachments = attachments;
    createToolCall(toolCallData).catch((error) => {
      logger.error(`Error creating tool call: ${error.message}`);
    });
    res.status(200).json({
      result: content,
      attachments,
    });
  } catch (error) {
    if (isContentFilterError(error)) {
      res.status(error.statusCode).json(error.body);
      return;
    }
    logger.error('Error calling tool', error);
    res.status(500).json({ message: 'Error calling tool' });
  }
};

const getToolCalls = async (req, res) => {
  try {
    const { conversationId } = req.query;
    const toolCalls = await getToolCallsByConvo(conversationId, req.user.id);
    res.status(200).json(toolCalls);
  } catch (error) {
    logger.error('Error getting tool calls', error);
    res.status(500).json({ message: 'Error getting tool calls' });
  }
};

module.exports = {
  callTool,
  getToolCalls,
  verifyToolAuth,
};
