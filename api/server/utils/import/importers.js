const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const {
  logger,
  getTenantId,
  sanitizeUIResourceContent,
  stripMessageUIResourceMarkers,
} = require('@librechat/data-schemas');
const { EModelEndpoint, Constants, Tools, openAISettings } = require('librechat-data-provider');
const {
  withoutTraceRefs,
  orderMessageLineage,
  createChatGptLineage,
  linkChatGptCitations,
} = require('@librechat/api');
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
 * Extracts text and thinking content from a Claude message.
 * @param {Object} msg - Claude message object with content array and optional text field.
 * @returns {{textContent: string, thinkingContent: string}} Extracted text and thinking content.
 */
function extractClaudeContent(msg) {
  let textContent = '';
  let thinkingContent = '';

  for (const part of msg.content || []) {
    if (part.type === 'text' && part.text) {
      textContent += part.text;
    } else if (part.type === 'thinking' && part.thinking) {
      thinkingContent += part.thinking;
    }
  }

  // Use the text field as fallback if content array is empty
  if (!textContent && msg.text) {
    textContent = msg.text;
  }

  return { textContent, thinkingContent };
}

/**
 * Imports Claude conversations from provided JSON data.
 * Claude export format: array of conversations with chat_messages array.
 *
 * @param {Array} jsonData - Array of Claude conversation objects to be imported.
 * @param {string} requestUserId - The ID of the user who initiated the import process.
 * @param {Function} builderFactory - Factory function to create a new import batch builder instance.
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
      importBatchBuilder.startConversation(EModelEndpoint.anthropic);

      let lastMessageId = Constants.NO_PARENT;
      let lastTimestamp = null;

      for (const msg of conv.chat_messages || []) {
        const isCreatedByUser = msg.sender === 'human';
        const messageId = uuidv4();

        const { textContent, thinkingContent } = extractClaudeContent(msg);

        // Skip empty messages
        if (!textContent && !thinkingContent) {
          continue;
        }

        // Parse timestamp, fallback to conversation create_time or current time
        const messageTime = msg.created_at || conv.created_at;
        let createdAt = messageTime ? new Date(messageTime) : new Date();

        // Ensure timestamp is after the previous message.
        // Messages are sorted by createdAt and buildTree expects parents to appear before children.
        // This guards against any potential ordering issues in exports.
        if (lastTimestamp && createdAt <= lastTimestamp) {
          createdAt = new Date(lastTimestamp.getTime() + 1);
        }
        lastTimestamp = createdAt;

        const message = {
          messageId,
          parentMessageId: lastMessageId,
          text: textContent,
          sender: isCreatedByUser ? 'user' : 'Claude',
          isCreatedByUser,
          isUserSubmitted: true,
          user: requestUserId,
          endpoint: EModelEndpoint.anthropic,
          createdAt,
        };

        // Add content array with thinking if present
        if (thinkingContent && !isCreatedByUser) {
          message.content = [
            { type: 'think', think: thinkingContent },
            { type: 'text', text: textContent },
          ];
        }

        importBatchBuilder.saveMessage(message);
        lastMessageId = messageId;
      }

      const createdAt = conv.created_at ? new Date(conv.created_at) : new Date();
      importBatchBuilder.finishConversation(
        conv.name || 'Imported Claude Chat',
        createdAt,
        {},
        defaultModel,
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
 * Imports ChatGPT conversations from provided JSON data.
 * Initializes the import process by creating a batch builder and processing each conversation in the data.
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
      processConversation(conv, importBatchBuilder, requestUserId, defaultModel);
    }
    await importBatchBuilder.saveBatch();
  } catch (error) {
    logger.error(`user: ${requestUserId} | Error creating conversation from imported file`, error);
    throw error;
  }
}

/**
 * Processes a single conversation, adding messages to the batch builder based on author roles and handling text content.
 * It directly manages the addition of messages for different roles and handles citations for assistant messages.
 *
 * @param {ChatGPTConvo} conv - A single conversation object that contains multiple messages and other details.
 * @param {ImportBatchBuilder} importBatchBuilder - The batch builder instance used to manage and batch conversation data.
 * @param {string} requestUserId - The ID of the user who initiated the import process.
 * @param {string} [defaultModel] - Resolved default model for the openAI endpoint.
 * @returns {void}
 */
function processConversation(conv, importBatchBuilder, requestUserId, defaultModel) {
  importBatchBuilder.startConversation(EModelEndpoint.openAI);

  // Map all message IDs to new UUIDs
  const messageMap = new Map();
  for (const [id, mapping] of Object.entries(conv.mapping)) {
    if (mapping.message?.content?.content_type) {
      const newMessageId = uuidv4();
      messageMap.set(id, newMessageId);
    }
  }

  const lineage = createChatGptLineage(conv.mapping, messageMap);

  // Create and save messages using the mapped IDs
  const messages = [];
  for (const [id, mapping] of Object.entries(conv.mapping)) {
    const role = mapping.message?.author?.role;
    if (!mapping.message) {
      messageMap.delete(id);
      continue;
    } else if (role === 'system') {
      // Skip system messages but keep their ID in messageMap for parent references
      continue;
    }

    const contentType = mapping.message.content?.content_type;

    // Skip thoughts messages - they will be merged into the response message
    if (contentType === 'thoughts') {
      continue;
    }

    // Skip reasoning_recap messages (just summaries like "Thought for 44s")
    if (contentType === 'reasoning_recap') {
      continue;
    }

    const newMessageId = messageMap.get(id);
    if (!newMessageId) {
      continue;
    }
    const parentMessageId = lineage.findValidParent(mapping.parent);

    const messageText = formatMessageText(mapping.message);

    const isCreatedByUser = role === 'user';
    let sender = isCreatedByUser ? 'user' : 'assistant';
    const model =
      mapping.message.metadata?.model_slug || defaultModel || openAISettings.model.default;

    if (!isCreatedByUser) {
      /** Extracted model name from model slug */
      const gptMatch = model.match(/gpt-(.+)/i);
      if (gptMatch) {
        sender = `GPT-${gptMatch[1]}`;
      } else {
        sender = model || 'assistant';
      }
    }

    // Use create_time from ChatGPT export to ensure proper message ordering
    // For null timestamps, use the conversation's create_time as fallback, or current time as last resort
    const messageTime = mapping.message.create_time || conv.create_time;
    const createdAt = messageTime ? new Date(messageTime * 1000) : new Date();

    const message = {
      messageId: newMessageId,
      parentMessageId,
      text: messageText,
      sender,
      isCreatedByUser,
      isUserSubmitted: true,
      model,
      user: requestUserId,
      endpoint: EModelEndpoint.openAI,
      createdAt,
    };

    // For assistant messages, check if there's thinking content in the parent chain
    if (!isCreatedByUser) {
      const thinkingContent = lineage.findThinkingContent(mapping.parent);
      if (thinkingContent.length > 0) {
        // Combine thinking content with the text response
        message.content = [...thinkingContent, { type: 'text', text: messageText }];
      }
    }

    messages.push(message);
  }

  orderMessageLineage(messages);

  for (const message of messages) {
    importBatchBuilder.saveMessage(message);
  }

  importBatchBuilder.finishConversation(
    conv.title,
    new Date(conv.create_time * 1000),
    {},
    defaultModel,
  );
}

/**
 * Processes text content of messages authored by an assistant, inserting citation links as required.
 * Uses citation start and end indices to place links at the correct positions.
 *
 * @param {ChatGPTMessage} messageData - The message data containing metadata about citations.
 * @param {string} messageText - The original text of the message which may be altered by inserting citation links.
 * @returns {string} - The updated message text after processing for citations.
 */
function processAssistantMessage(messageData, messageText) {
  if (!messageText) {
    return messageText;
  }

  return linkChatGptCitations(messageText, messageData.metadata?.citations);
}

/**
 * Formats the text content of a message based on its content type and author role.
 * @param {ChatGPTMessage} messageData - The message data.
 * @returns {string} - The formatted message text.
 */
function formatMessageText(messageData) {
  const contentType = messageData.content.content_type;
  const isText = contentType === 'text';
  let messageText = '';

  if (isText && messageData.content.parts) {
    messageText = messageData.content.parts.join(' ');
  } else if (contentType === 'code') {
    messageText = `\`\`\`${messageData.content.language}\n${messageData.content.text}\n\`\`\``;
  } else if (contentType === 'execution_output') {
    messageText = `Execution Output:\n> ${messageData.content.text}`;
  } else if (messageData.content.parts) {
    for (const part of messageData.content.parts) {
      if (typeof part === 'string') {
        messageText += part + ' ';
      } else if (typeof part === 'object') {
        messageText = `\`\`\`json\n${JSON.stringify(part, null, 2)}\n\`\`\`\n`;
      }
    }
    messageText = messageText.trim();
  } else {
    messageText = `\`\`\`json\n${JSON.stringify(messageData.content, null, 2)}\n\`\`\``;
  }

  if (isText && messageData.author?.role !== 'user') {
    messageText = processAssistantMessage(messageData, messageText);
  }

  return messageText;
}

module.exports = { getImporter, processAssistantMessage };
