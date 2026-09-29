const fs = require('fs').promises;
const { logger } = require('@librechat/data-schemas');
const {
  inspectContent,
  extractFileContent,
  hasActiveFileFieldPolicy,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
  resolveAssistantToolPermissions,
} = require('@librechat/api');
const { FileContext } = require('librechat-data-provider');
const {
  deleteFileByFilter,
  updateAssistantDoc,
  getAssistants,
  getRoleByName,
} = require('~/models');
const { uploadImageBuffer, filterFile } = require('~/server/services/Files/process');
const validateAuthor = require('~/server/middleware/assistants/validateAuthor');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { deleteAssistantActions } = require('~/server/services/ActionService');
const { getOpenAIClient, fetchAssistants } = require('./helpers');
const {
  healMcpToolNames,
  getAssistantToolDefinitions,
  toProviderToolDefinition,
} = require('~/server/services/MCP');
const { manifestToolMap, isAgentsOnlyTool } = require('~/app/clients/tools');

/**
 * Create an assistant.
 * @route POST /assistants
 * @param {AssistantCreateParams} req.body - The assistant creation parameters.
 * @returns {Assistant} 201 - success response - application/json
 */
const createAssistant = async (req, res) => {
  try {
    const { openai } = await getOpenAIClient({ req, res });

    const {
      tools = [],
      endpoint,
      conversation_starters,
      append_current_datetime,
      ...assistantData
    } = req.body;
    delete assistantData.conversation_starters;
    delete assistantData.append_current_datetime;

    const { toolDefinitions, accessibleServerNames } = await getAssistantToolDefinitions({
      req,
      res,
      tools,
    });
    const healedTools = await healMcpToolNames({
      req,
      tools,
      toolDefinitions,
      accessibleServerNames,
    });
    const isNativeToolPermitted = await resolveAssistantToolPermissions({
      req,
      tools,
      getRoleByName,
    });

    assistantData.tools = healedTools
      .map((tool) => {
        /** Agents-runtime-only tools (e.g. ask_user_question) cannot execute on
         *  the assistants runtime — drop them even when posted directly, since
         *  the tools-dialog scoping doesn't gate REST clients or stale payloads. */
        if (isAgentsOnlyTool(tool)) {
          logger.warn('[/assistants] Dropping agents-only tool from assistant payload', {
            toolShape: typeof tool === 'string' ? 'name' : 'definition',
          });
          return undefined;
        }
        if (typeof tool !== 'string') {
          return tool;
        }

        const toolDef = toolDefinitions[tool];
        if (!toolDef && manifestToolMap[tool] && manifestToolMap[tool].toolkit === true) {
          return Object.entries(toolDefinitions)
            .filter(([key]) => key.startsWith(`${tool}_`))

            .map(([_, val]) => val);
        }

        return toolDef;
      })
      .filter((tool) => tool)
      .flat()
      .map(toProviderToolDefinition)
      .filter((tool) => {
        if (isNativeToolPermitted(tool)) {
          return true;
        }
        logger.warn(
          `[/assistants] Dropping role-denied native tool from assistant payload: ${tool?.type}`,
        );
        return false;
      });

    let azureModelIdentifier = null;
    if (openai.locals?.azureOptions) {
      azureModelIdentifier = assistantData.model;
      assistantData.model = openai.locals.azureOptions.azureOpenAIApiDeploymentName;
    }

    assistantData.metadata = {
      author: req.user.id,
      endpoint,
    };

    const assistant = await openai.beta.assistants.create(assistantData);

    const createData = { user: req.user.id, endpoint };
    if (conversation_starters) {
      createData.conversation_starters = conversation_starters;
    }
    if (append_current_datetime !== undefined) {
      createData.append_current_datetime = append_current_datetime;
    }

    const document = await updateAssistantDoc({ assistantId: assistant.id }, createData);

    if (azureModelIdentifier) {
      assistant.model = azureModelIdentifier;
    }

    if (document.conversation_starters) {
      assistant.conversation_starters = document.conversation_starters;
    }

    if (append_current_datetime !== undefined) {
      assistant.append_current_datetime = append_current_datetime;
    }

    logger.debug('[/assistants] Assistant created', {
      assistantId: assistant.id,
      toolCount: assistantData.tools.length,
      hasConversationStarters: Array.isArray(document.conversation_starters),
    });
    res.status(201).json(assistant);
  } catch (error) {
    logger.error('[/assistants] Error creating assistant', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Retrieves an assistant.
 * @route GET /assistants/:id
 * @param {string} req.params.id - Assistant identifier.
 * @returns {Assistant} 200 - success response - application/json
 */
const retrieveAssistant = async (req, res) => {
  try {
    /* NOTE: not actually being used right now */
    const { openai } = await getOpenAIClient({ req, res });
    const assistant_id = req.params.id;
    const assistant = await openai.beta.assistants.retrieve(assistant_id);
    res.json(assistant);
  } catch (error) {
    logger.error('[/assistants/:id] Error retrieving assistant', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Modifies an assistant.
 * @route PATCH /assistants/:id
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Assistant identifier.
 * @param {AssistantUpdateParams} req.body - The assistant update parameters.
 * @returns {Assistant} 200 - success response - application/json
 */
const patchAssistant = async (req, res) => {
  try {
    const { openai } = await getOpenAIClient({ req, res });
    await validateAuthor({ req, openai });

    const assistant_id = req.params.id;
    const {
      endpoint: _e,
      conversation_starters,
      append_current_datetime,
      ...updateData
    } = req.body;

    const { toolDefinitions, accessibleServerNames } = await getAssistantToolDefinitions({
      req,
      res,
      tools: updateData.tools,
    });
    const healedTools = await healMcpToolNames({
      req,
      tools: updateData.tools,
      toolDefinitions,
      accessibleServerNames,
    });
    const isNativeToolPermitted = await resolveAssistantToolPermissions({
      req,
      tools: updateData.tools,
      getRoleByName,
    });

    updateData.tools = healedTools
      .map((tool) => {
        /** Agents-runtime-only tools (e.g. ask_user_question) cannot execute on
         *  the assistants runtime — drop them even when posted directly, since
         *  the tools-dialog scoping doesn't gate REST clients or stale payloads. */
        if (isAgentsOnlyTool(tool)) {
          logger.warn(
            `[/assistants] Dropping agents-only tool from assistant payload: ${typeof tool === 'string' ? tool : tool?.function?.name}`,
          );
          return undefined;
        }
        if (typeof tool !== 'string') {
          return tool;
        }

        const toolDef = toolDefinitions[tool];
        if (!toolDef && manifestToolMap[tool] && manifestToolMap[tool].toolkit === true) {
          return Object.entries(toolDefinitions)
            .filter(([key]) => key.startsWith(`${tool}_`))

            .map(([_, val]) => val);
        }

        return toolDef;
      })
      .filter((tool) => tool)
      .flat()
      .map(toProviderToolDefinition)
      .filter((tool) => {
        if (isNativeToolPermitted(tool)) {
          return true;
        }
        logger.warn(
          `[/assistants] Dropping role-denied native tool from assistant payload: ${tool?.type}`,
        );
        return false;
      });

    if (openai.locals?.azureOptions && updateData.model) {
      updateData.model = openai.locals.azureOptions.azureOpenAIApiDeploymentName;
    }

    const updatedAssistant = await openai.beta.assistants.update(assistant_id, updateData);

    if (conversation_starters !== undefined) {
      const conversationStartersUpdate = await updateAssistantDoc(
        { assistantId: assistant_id },
        { conversation_starters },
      );
      updatedAssistant.conversation_starters = conversationStartersUpdate.conversation_starters;
    }

    if (append_current_datetime !== undefined) {
      await updateAssistantDoc({ assistantId: assistant_id }, { append_current_datetime });
      updatedAssistant.append_current_datetime = append_current_datetime;
    }

    res.json(updatedAssistant);
  } catch (error) {
    logger.error('[/assistants/:id] Error updating assistant', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Deletes an assistant.
 * @route DELETE /assistants/:id
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.id - Assistant identifier.
 * @returns {Assistant} 200 - success response - application/json
 */
const deleteAssistant = async (req, res) => {
  try {
    const { openai } = await getOpenAIClient({ req, res });
    await validateAuthor({ req, openai });

    const assistant_id = req.params.id;
    const deletionStatus = await openai.beta.assistants.delete(assistant_id);
    if (deletionStatus?.deleted) {
      await deleteAssistantActions({ req, assistant_id });
    }
    res.json(deletionStatus);
  } catch (error) {
    logger.error('[/assistants/:id] Error deleting assistant', error);
    res.status(500).json({ error: 'Error deleting assistant' });
  }
};

/**
 * Returns a list of assistants.
 * @route GET /assistants
 * @param {object} req - Express Request
 * @param {AssistantListParams} req.query - The assistant list parameters for pagination and sorting.
 * @returns {AssistantListResponse} 200 - success response - application/json
 */
const listAssistants = async (req, res) => {
  try {
    const body = await fetchAssistants({ req, res });
    res.json(body);
  } catch (error) {
    logger.error('[/assistants] Error listing assistants', error);
    res.status(500).json({ message: 'Error listing assistants' });
  }
};

/**
 * Filter assistants based on configuration.
 *
 * @param {object} params - The parameters object.
 * @param {string} params.userId -  The user ID to filter private assistants.
 * @param {AssistantDocument[]} params.assistants - The list of assistants to filter.
 * @param {Partial<TAssistantEndpoint>} [params.assistantsConfig] -  The assistant configuration.
 * @returns {AssistantDocument[]} - The filtered list of assistants.
 */
function filterAssistantDocs({ documents, userId, assistantsConfig = {} }) {
  const { supportedIds, excludedIds, privateAssistants } = assistantsConfig;
  const removeUserId = (doc) => {
    const { user: _u, ...document } = doc;
    return document;
  };

  if (privateAssistants) {
    return documents.filter((doc) => userId === doc.user.toString()).map(removeUserId);
  } else if (supportedIds?.length) {
    return documents.filter((doc) => supportedIds.includes(doc.assistant_id)).map(removeUserId);
  } else if (excludedIds?.length) {
    return documents.filter((doc) => !excludedIds.includes(doc.assistant_id)).map(removeUserId);
  }
  return documents.map(removeUserId);
}

/**
 * Returns a list of the user's assistant documents (metadata saved to database).
 * @route GET /assistants/documents
 * @returns {AssistantDocument[]} 200 - success response - application/json
 */
const getAssistantDocuments = async (req, res) => {
  try {
    const appConfig = req.config;
    const endpoint = req.query?.endpoint;
    const assistantsConfig = appConfig.endpoints?.[endpoint];
    const documents = await getAssistants(
      {},
      {
        user: 1,
        assistant_id: 1,
        conversation_starters: 1,
        createdAt: 1,
        updatedAt: 1,
        append_current_datetime: 1,
      },
    );

    const docs = filterAssistantDocs({
      documents,
      userId: req.user.id,
      assistantsConfig,
    });
    res.json(docs);
  } catch (error) {
    logger.error('[/assistants/documents] Error listing assistant documents', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Uploads and updates an avatar for a specific assistant.
 * @route POST /:assistant_id/avatar
 * @param {object} req - Express Request
 * @param {object} req.params - Request params
 * @param {string} req.params.assistant_id - The ID of the assistant.
 * @param {Express.Multer.File} req.file - The avatar image file.
 * @param {object} req.body - Request body
 * @returns {Object} 200 - success response - application/json
 */
const uploadAssistantAvatar = async (req, res) => {
  try {
    const appConfig = req.config;
    filterFile({ req, file: req.file, image: true, isAvatar: true });
    if (hasActiveFileFieldPolicy(req.config?.filters, ['name', 'content'])) {
      const finding = inspectContent(extractFileContent({ name: req.file.originalname }), {
        filters: req.config.filters,
      });
      if (finding != null) {
        return res.status(400).json(contentFilterBlockResponse(finding));
      }
      const uninspectableField = getBlockedUninspectableFileField(req.config.filters, ['content']);
      if (uninspectableField != null) {
        return res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
      }
    }

    const { assistant_id } = req.params;
    const endpoint = req.body?.endpoint ?? req.query?.endpoint;
    if (!assistant_id) {
      return res.status(400).json({ message: 'Assistant ID is required' });
    }

    const { openai } = await getOpenAIClient({ req, res });
    await validateAuthor({ req, openai });

    const buffer = await fs.readFile(req.file.path);
    const image = await uploadImageBuffer({
      req,
      context: FileContext.avatar,
      metadata: { buffer },
    });

    let _metadata;

    try {
      const assistant = await openai.beta.assistants.retrieve(assistant_id);
      if (assistant) {
        _metadata = assistant.metadata;
      }
    } catch (error) {
      logger.error('[/:assistant_id/avatar] Error fetching assistant', error);
      _metadata = {};
    }

    if (_metadata.avatar && _metadata.avatar_source) {
      const { deleteFile } = getStrategyFunctions(_metadata.avatar_source);
      try {
        await deleteFile(req, {
          filepath: _metadata.avatar,
          user: req.user.id,
          tenantId: req.user.tenantId,
        });
        await deleteFileByFilter({ user: req.user.id, filepath: _metadata.avatar });
      } catch (error) {
        logger.error('[/:assistant_id/avatar] Error deleting old avatar', error);
      }
    }

    const metadata = {
      ..._metadata,
      avatar: image.filepath,
      avatar_source: appConfig.fileStrategy,
    };

    const promises = [];
    promises.push(
      updateAssistantDoc(
        { assistantId: assistant_id },
        {
          avatar: {
            filepath: image.filepath,
            source: appConfig.fileStrategy,
          },
          user: req.user.id,
          endpoint,
        },
      ),
    );
    promises.push(openai.beta.assistants.update(assistant_id, { metadata }));

    const resolved = await Promise.all(promises);
    res.status(201).json(resolved[1]);
  } catch (error) {
    const message = 'An error occurred while updating the Assistant Avatar';
    logger.error(message, error);
    res.status(500).json({ message });
  } finally {
    try {
      await fs.unlink(req.file.path);
      logger.debug('[/:agent_id/avatar] Temp. image upload file deleted');
    } catch {
      logger.debug('[/:agent_id/avatar] Temp. image upload file already deleted');
    }
  }
};

module.exports = {
  createAssistant,
  retrieveAssistant,
  patchAssistant,
  deleteAssistant,
  listAssistants,
  getAssistantDocuments,
  uploadAssistantAvatar,
};
