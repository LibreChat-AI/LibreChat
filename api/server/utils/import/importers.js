const mongoose = require('mongoose');
const {
  isGrokExport,
  GROK_SOURCE,
  GROK_ENDPOINT,
  withoutTraceRefs,
  convertConversation,
  convertGrokConversation,
  convertClaudeConversation,
} = require('@librechat/api');
const {
  logger,
  getTenantId,
  sanitizeUIResourceContent,
  stripMessageUIResourceMarkers,
} = require('@librechat/data-schemas');
const {
  Tools,
  Constants,
  EModelEndpoint,
  openAISettings,
  anthropicSettings,
} = require('librechat-data-provider');
const { getEndpointsConfig } = require('~/server/services/Config');
const { createImportBatchBuilder } = require('./importBatchBuilder');
const { resolveImportDefaultModel } = require('./defaults');
const { cloneMessagesWithTimestamps } = require('./fork');

const castImportedBoolean = mongoose.Schema.Types.Boolean.cast();
const castImportedString = mongoose.Schema.Types.String.cast();

function isImportedAssistantMessage(isCreatedByUser) {
  if (isCreatedByUser === null) {
    return false;
  }
  if (isCreatedByUser === undefined) {
    return true;
  }
  try {
    return castImportedBoolean(isCreatedByUser) !== true;
  } catch {
    return true;
  }
}

function isImportedAssistantContent(isCreatedByUser) {
  try {
    return castImportedBoolean(isCreatedByUser) !== true;
  } catch {
    return true;
  }
}

function castPersistedImportedText(text) {
  try {
    return castImportedString(text);
  } catch {
    return text;
  }
}

function normalizeImportedArray(value) {
  if (value == null) {
    return null;
  }
  return Array.isArray(value) ? value : [value];
}

/** Removes executable legacy MCP-UI payloads from untrusted conversation imports. */
function sanitizeImportedMessage(message) {
  const sanitizeTextMarkers = isImportedAssistantMessage(message.isCreatedByUser);
  const sanitizeContentMarkers = isImportedAssistantContent(message.isCreatedByUser);
  const text = castPersistedImportedText(message.text);
  const content = normalizeImportedArray(message.content);
  const attachments = normalizeImportedArray(message.attachments);
  /** Server-private run state and trace sampling records never come from an import. */
  const importable = withoutTraceRefs({ ...message });
  delete importable.contextMeta;
  delete importable.privateText;
  delete importable.privacyRevision;
  delete importable.privateTextTokens;
  return {
    ...importable,
    isUserSubmitted: true,
    ...(text !== message.text && { text }),
    ...(sanitizeTextMarkers &&
      typeof text === 'string' && { text: stripMessageUIResourceMarkers(text, false) }),
    ...(content && {
      content: sanitizeUIResourceContent(content, sanitizeContentMarkers),
    }),
    ...(attachments && {
      attachments: attachments.filter((attachment) => attachment?.type !== Tools.ui_resources),
    }),
  };
}

/**
 * Returns the appropriate importer function based on the provided JSON data.
 *
 * @param {Object} jsonData - The JSON data to import.
 * @returns {Function} - The importer function.
 * @throws {Error} - If the import type is not supported.
 */
function getImporter(jsonData) {
  // For array-based formats (ChatGPT or Claude)
  if (Array.isArray(jsonData)) {
    // Claude format has chat_messages array in each conversation
    if (jsonData.length > 0 && jsonData[0]?.chat_messages) {
      logger.info('Importing Claude conversation');
      return importClaudeConvo;
    }
    // ChatGPT format has mapping object in each conversation
    if (jsonData.length === 0 || jsonData[0]?.mapping) {
      logger.info('Importing ChatGPT conversation');
      return importChatGptConvo;
    }
    throw new Error('Unsupported import type');
  }

  // For ChatbotUI
  if (jsonData.version && Array.isArray(jsonData.history)) {
    logger.info('Importing ChatbotUI conversation');
    return importChatBotUiConvo;
  }

  // For LibreChat
  if (jsonData.conversationId && (jsonData.messagesTree || jsonData.messages)) {
    logger.info('Importing LibreChat conversation');
    return importLibreChatConvo;
  }

  // For Grok, the only export whose root is an object of conversations
  if (isGrokExport(jsonData)) {
    logger.info('Importing Grok conversation');
    return importGrokConvo;
  }

  throw new Error('Unsupported import type');
}

/**
 * Imports a chatbot-ui V1  conversation from a JSON file and saves it to the database.
 *
 * @param {Object} jsonData - The JSON data containing the chatbot conversation.
 * @param {string} requestUserId - The ID of the user making the import request.
 * @param {Function} [builderFactory=createImportBatchBuilder] - The factory function to create an import batch builder.
 * @returns {Promise<void>} - A promise that resolves when the import is complete.
 * @throws {Error} - If there is an error creating the conversation from the JSON file.
 */
async function importChatBotUiConvo(
  jsonData,
  requestUserId,
  builderFactory = createImportBatchBuilder,
  userRole,
) {
  // this have been tested with chatbot-ui V1 export https://github.com/mckaywrigley/chatbot-ui/tree/b865b0555f53957e96727bc0bbb369c9eaecd83b#legacy-code
  try {
    /** @type {ImportBatchBuilder} */
    const importBatchBuilder = builderFactory(requestUserId);
    const defaultModel = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.openAI,
      requestUserId,
      userRole,
    });

    for (const historyItem of jsonData.history) {
      importBatchBuilder.startConversation(EModelEndpoint.openAI);
      for (const message of historyItem.messages) {
        if (message.role === 'assistant') {
          importBatchBuilder.addGptMessage(message.content, historyItem.model.id);
        } else if (message.role === 'user') {
          importBatchBuilder.addUserMessage(message.content);
        }
      }
      importBatchBuilder.finishConversation(historyItem.name, new Date(), {}, defaultModel);
    }
    await importBatchBuilder.saveBatch();
    logger.info(`user: ${requestUserId} | ChatbotUI conversation imported`);
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from ChatbotUI file`, error);
    throw error;
  }
}

/**
 * Imports Claude conversations from provided JSON data.
 * Delegates conversion of each conversation to `convertClaudeConversation`, the
 * same engine `runImport` uses for zipped Claude exports, so a bare
 * `conversations.json` upload and a zip archive produce identical messages:
 * branching, tool calls, reasoning, attachment extractions and citations
 * included. A Claude export ships no binaries in either shape, so nothing is
 * lost by this path not resolving assets.
 *
 * @param {Array} jsonData - Array of Claude conversation objects to be imported.
 * @param {string} requestUserId - The ID of the user who initiated the import process.
 * @param {Function} builderFactory - Factory function to create a new import batch builder instance.
 * @param {string} [userRole] - The role of the importing user.
 * @returns {Promise<void>} Promise that resolves when all conversations have been imported.
 */
async function importClaudeConvo(
  jsonData,
  requestUserId,
  builderFactory = createImportBatchBuilder,
  userRole,
) {
  try {
    const importBatchBuilder = builderFactory(requestUserId);
    const defaultModel = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.anthropic,
      requestUserId,
      userRole,
    });

    for (const conv of jsonData) {
      const converted = convertClaudeConversation(conv, {
        defaultModel: defaultModel || anthropicSettings.model.default,
      });

      importBatchBuilder.startConversation(EModelEndpoint.anthropic);
      for (const message of converted.messages) {
        importBatchBuilder.saveMessage(toSaveMessageDetails(message, EModelEndpoint.anthropic));
      }
      importBatchBuilder.finishConversation(
        converted.title,
        converted.createdAt,
        {
          isArchived: converted.isArchived,
          pinned: converted.pinned,
          model: converted.model,
          importedFrom: { source: 'claude', externalId: converted.externalId },
        },
        converted.model,
      );
    }

    await importBatchBuilder.saveBatch();
    logger.info(`user: ${requestUserId} | Claude conversation imported`);
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from Claude file`, error);
    throw error;
  }
}

/**
 * Imports Grok conversations from provided JSON data.
 * Delegates conversion of each conversation to `convertGrokConversation`, the
 * same engine `runImport` uses for zipped Grok exports, so a bare
 * `prod-grok-backend.json` upload and a zip archive produce identical messages:
 * branching, per-message models and dropped empty generations included. The
 * binaries a Grok export ships belong to its `media_posts` rather than to any
 * conversation, so nothing is lost by this path not resolving assets.
 *
 * @param {object} jsonData - Grok export object keyed by `conversations`.
 * @param {string} requestUserId - The ID of the user who initiated the import process.
 * @param {Function} builderFactory - Factory function to create a new import batch builder instance.
 * @param {string} [userRole] - The role of the importing user.
 * @returns {Promise<void>} Promise that resolves when all conversations have been imported.
 */
async function importGrokConvo(
  jsonData,
  requestUserId,
  builderFactory = createImportBatchBuilder,
  userRole,
) {
  try {
    const importBatchBuilder = builderFactory(requestUserId);
    const defaultModel = await resolveImportDefaultModel({
      endpoint: GROK_ENDPOINT,
      requestUserId,
      userRole,
    });

    for (const entry of jsonData.conversations) {
      const converted = convertGrokConversation(entry, {
        defaultModel: defaultModel || openAISettings.model.default,
      });

      importBatchBuilder.startConversation(GROK_ENDPOINT);
      for (const message of converted.messages) {
        importBatchBuilder.saveMessage(toSaveMessageDetails(message, GROK_ENDPOINT));
      }
      importBatchBuilder.finishConversation(
        converted.title,
        converted.createdAt,
        {
          isArchived: converted.isArchived,
          pinned: converted.pinned,
          model: converted.model,
          importedFrom: { source: GROK_SOURCE, externalId: converted.externalId },
        },
        converted.model,
      );
    }

    await importBatchBuilder.saveBatch();
    logger.info(`user: ${requestUserId} | Grok conversation imported`);
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from Grok file`, error);
    throw error;
  }
}

/**
 * Imports a LibreChat conversation from JSON.
 *
 * @param {Object} jsonData - The JSON data representing the conversation.
 * @param {string} requestUserId - The ID of the user making the import request.
 * @param {Function} [builderFactory=createImportBatchBuilder] - The factory function to create an import batch builder.
 * @returns {Promise<void>} - A promise that resolves when the import is complete.
 */
async function importLibreChatConvo(
  jsonData,
  requestUserId,
  builderFactory = createImportBatchBuilder,
  userRole,
) {
  try {
    /** @type {ImportBatchBuilder} */
    const importBatchBuilder = builderFactory(requestUserId);
    const options = jsonData.options || {};

    /* Endpoint configuration */
    let endpoint = jsonData.endpoint ?? options.endpoint ?? EModelEndpoint.openAI;
    const endpointsConfig = await getEndpointsConfig({
      user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
    });
    const endpointConfig = endpointsConfig?.[endpoint];
    if (!endpointConfig && endpointsConfig) {
      endpoint = Object.keys(endpointsConfig)[0];
    } else if (!endpointConfig) {
      endpoint = EModelEndpoint.openAI;
    }

    importBatchBuilder.startConversation(endpoint);

    const defaultModel = await resolveImportDefaultModel({
      endpoint,
      requestUserId,
      userRole,
    });

    let firstMessageDate = null;

    const messagesToImport = jsonData.messagesTree || jsonData.messages;

    if (jsonData.recursive) {
      /**
       * Flatten the recursive message tree into a flat array
       * @param {TMessage[]} messages
       * @param {string} parentMessageId
       * @param {TMessage[]} flatMessages
       */
      const flattenMessages = (
        messages,
        parentMessageId = Constants.NO_PARENT,
        flatMessages = [],
      ) => {
        for (const message of messages) {
          if (!message.text && !message.content) {
            continue;
          }

          const flatMessage = {
            ...message,
            parentMessageId: parentMessageId,
            isUserSubmitted: true,
            children: undefined, // Remove children from flat structure
          };
          flatMessages.push(flatMessage);

          if (!firstMessageDate && message.createdAt) {
            firstMessageDate = new Date(message.createdAt);
          }

          if (message.children && message.children.length > 0) {
            flattenMessages(message.children, message.messageId, flatMessages);
          }
        }
        return flatMessages;
      };

      const flatMessages = flattenMessages(messagesToImport).map(sanitizeImportedMessage);
      cloneMessagesWithTimestamps(flatMessages, importBatchBuilder);
    } else if (messagesToImport) {
      cloneMessagesWithTimestamps(
        messagesToImport.map(sanitizeImportedMessage),
        importBatchBuilder,
      );
      for (const message of messagesToImport) {
        if (!firstMessageDate && message.createdAt) {
          firstMessageDate = new Date(message.createdAt);
        }
      }
    } else {
      throw new Error('Invalid LibreChat file format');
    }

    if (firstMessageDate === 'Invalid Date') {
      firstMessageDate = null;
    }

    importBatchBuilder.finishConversation(
      jsonData.title,
      firstMessageDate ?? new Date(),
      options,
      defaultModel,
    );
    await importBatchBuilder.saveBatch();
    logger.debug(`user: ${requestUserId} | Conversation "${jsonData.title}" imported`);
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from LibreChat file`, error);
    throw error;
  }
}

/**
 * Builds the payload `ImportBatchBuilder.saveMessage` expects from one
 * message produced by a shared conversion engine (the same conversions used
 * for zipped ChatGPT and Claude export imports), so a bare `.json` upload and
 * a zip archive share one conversion implementation.
 *
 * @param {import('@librechat/api').ConvertedMessage} message
 * @param {string} endpoint
 * @returns {object}
 */
function toSaveMessageDetails(message, endpoint) {
  return {
    messageId: message.messageId,
    parentMessageId: message.parentMessageId,
    text: message.text,
    sender: message.sender,
    isCreatedByUser: message.isCreatedByUser,
    isUserSubmitted: true,
    model: message.model,
    createdAt: message.createdAt,
    endpoint,
    content: message.content,
    attachments: message.attachments,
    files: message.files,
  };
}

/**
 * Imports ChatGPT conversations from provided JSON data.
 * Delegates conversion of each conversation to `convertConversation`, the
 * same engine `runImport` uses for zipped ChatGPT exports, so a bare `.json`
 * upload and a zip archive produce identical messages. A bare JSON upload
 * never carries the export's asset files, so pointers are resolved against
 * an empty asset map: any image/audio references are dropped rather than
 * attached, exactly as before this delegation.
 *
 * @param {ChatGPTConvo[]} jsonData - Array of conversation objects to be imported.
 * @param {string} requestUserId - The ID of the user who initiated the import process.
 * @param {Function} builderFactory - Factory function to create a new import batch builder instance, defaults to createImportBatchBuilder.
 * @returns {Promise<void>} Promise that resolves when all conversations have been imported.
 */
async function importChatGptConvo(
  jsonData,
  requestUserId,
  builderFactory = createImportBatchBuilder,
  userRole,
) {
  try {
    const importBatchBuilder = builderFactory(requestUserId);
    const defaultModel = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.openAI,
      requestUserId,
      userRole,
    });

    for (const conv of jsonData) {
      const converted = convertConversation(conv, {
        userId: requestUserId,
        assets: new Map(),
        defaultModel: defaultModel || openAISettings.model.default,
      });

      importBatchBuilder.startConversation(EModelEndpoint.openAI);
      for (const message of converted.messages) {
        importBatchBuilder.saveMessage(toSaveMessageDetails(message, EModelEndpoint.openAI));
      }
      importBatchBuilder.finishConversation(
        converted.title,
        converted.createdAt,
        {
          isArchived: converted.isArchived,
          pinned: converted.pinned,
          model: converted.model,
          importedFrom: { source: 'chatgpt', externalId: converted.externalId },
        },
        converted.model,
      );
    }
    await importBatchBuilder.saveBatch();
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from imported file`, error);
    throw error;
  }
}

module.exports = { getImporter };
