const { v4: uuidv4 } = require('uuid');
const {
  assertConversationImportWriteSize,
  assertModelBoundContent,
  assertConversationImportContentAllowed,
  reportLocatorTraversalFailure,
  executeConversationImportWrites,
} = require('@librechat/api');
const {
  getTenantId,
  logger,
  createFallbackRetentionDate,
  createChatExpirationDate,
} = require('@librechat/data-schemas');
const {
  EModelEndpoint,
  Constants,
  RetentionMode,
  openAISettings,
} = require('librechat-data-provider');
const {
  bulkIncrementTagCounts,
  bulkSaveConvos,
  bulkSaveMessages,
  deleteImportedConversations,
  deleteImportedMessages,
  getFiles,
} = require('~/models');
const { FALLBACK_MODEL_BY_ENDPOINT } = require('./defaults');

/**
 * Factory function for creating an instance of ImportBatchBuilder.
 * @param {string} requestUserId - The ID of the user making the request.
 * @param {object} [interfaceConfig] - Runtime interface config for import retention.
 * @param {object} [filters] - Source-aware content filters for submitted imports.
 * @param {object} [legacyPii] - Legacy messageFilter.pii configuration.
 * @returns {ImportBatchBuilder} - The newly created ImportBatchBuilder instance.
 */
function createImportBatchBuilder(requestUserId, interfaceConfig, filters, legacyPii) {
  return new ImportBatchBuilder(requestUserId, interfaceConfig, filters, legacyPii);
}

/**
 * Applies the current content policy to a conversation snapshot before it is copied.
 * @param {object} [filters] - Source-aware content filters.
 * @param {object} snapshot - Conversation content that would be persisted.
 * @param {object[]} snapshot.conversations - Conversation metadata records.
 * @param {object[]} snapshot.messages - Message records.
 * @param {object} [resolutionContext] - Owner-aware canonical file resolution dependencies.
 * @param {{ id?: string, tenantId?: string }} [resolutionContext.user] - Snapshot owner.
 * @param {Function} [resolutionContext.getFiles] - Canonical file lookup.
 * @param {object[]} [resolutionContext.trustedLiveFiles] - Server-hydrated canonical rows.
 * @param {object} [resolutionContext.legacyPii] - Legacy messageFilter.pii configuration.
 * @returns {Promise<void>}
 * @throws {ContentFilterError|UninspectableFileError|import('@librechat/api').ContentTraversalLimitError}
 */
async function assertConversationContentAllowed(filters, snapshot, resolutionContext = {}) {
  return assertConversationImportContentAllowed(filters, snapshot, {
    ...resolutionContext,
    onTraversalFailure: reportLocatorTraversalFailure,
    assertModelBoundContent,
  });
}

/**
 * Class for building a batch of conversations and messages and pushing them to DB for Conversation Import functionality
 */
class ImportBatchBuilder {
  /**
   * Creates an instance of ImportBatchBuilder.
   * @param {string} requestUserId - The ID of the user making the import request.
   * @param {object} [interfaceConfig] - Runtime interface config for import retention.
   * @param {object} [filters] - Source-aware content filters for submitted imports.
   * @param {object} [legacyPii] - Legacy messageFilter.pii configuration.
   */
  constructor(requestUserId, interfaceConfig, filters, legacyPii) {
    this.requestUserId = requestUserId;
    this.interfaceConfig = interfaceConfig;
    this.filters = filters;
    this.legacyPii = legacyPii;
    this.conversations = [];
    this.messages = [];
    this.retentionFields = undefined;
  }

  getRetentionFields() {
    if (this.retentionFields !== undefined) {
      return this.retentionFields;
    }

    if (this.interfaceConfig?.retentionMode !== RetentionMode.ALL) {
      this.retentionFields = {};
      return this.retentionFields;
    }

    try {
      this.retentionFields = {
        isTemporary: false,
        expiredAt: createChatExpirationDate(this.interfaceConfig),
      };
    } catch (error) {
      logger.error('[ImportBatchBuilder] Error creating import expiration date:', error);
      this.retentionFields = { isTemporary: false, expiredAt: createFallbackRetentionDate() };
    }
    return this.retentionFields;
  }

  /**
   * Starts a new conversation in the batch.
   * @param {string} [endpoint=EModelEndpoint.openAI] - The endpoint for the conversation. Defaults to EModelEndpoint.openAI.
   * @returns {void}
   */
  startConversation(endpoint) {
    // we are simplifying by using a single model for the entire conversation
    this.endpoint = endpoint || EModelEndpoint.openAI;
    this.conversationId = uuidv4();
    this.lastMessageId = Constants.NO_PARENT;
  }

  /**
   * Adds a user message to the current conversation.
   * @param {string} text - The text of the user message.
   * @returns {object} The saved message object.
   */
  addUserMessage(text) {
    const message = this.saveMessage({
      text,
      sender: 'user',
      isCreatedByUser: true,
      isUserSubmitted: true,
    });
    return message;
  }

  /**
   * Adds a GPT message to the current conversation.
   * @param {string} text - The text of the GPT message.
   * @param {string} [model='defaultModel'] - The model used for generating the GPT message. Defaults to 'defaultModel'.
   * @param {string} [sender='GPT-3.5'] - The sender of the GPT message. Defaults to 'GPT-3.5'.
   * @returns {object} The saved message object.
   */
  addGptMessage(text, model, sender = 'GPT-3.5') {
    const message = this.saveMessage({
      text,
      sender,
      isCreatedByUser: false,
      isUserSubmitted: true,
      model: model || openAISettings.model.default,
    });
    return message;
  }

  /**
   * Finishes the current conversation and adds it to the batch.
   * @param {string} [title='Imported Chat'] - The title of the conversation. Defaults to 'Imported Chat'.
   * @param {Date} [createdAt] - The creation date of the conversation.
   * @param {TConversation} [originalConvo] - The original conversation.
   * @param {string} [defaultModel] - Resolved default model for this endpoint
   *   (typically derived from the runtime models config). Used only when
   *   originalConvo.model is unset.
   * @returns {{ conversation: TConversation, messages: TMessage[] }} The resulting conversation and messages.
   */
  finishConversation(title, createdAt, originalConvo = {}, defaultModel) {
    const fallbackModel =
      defaultModel ?? FALLBACK_MODEL_BY_ENDPOINT[this.endpoint] ?? openAISettings.model.default;
    const convo = {
      ...originalConvo,
      user: this.requestUserId,
      conversationId: this.conversationId,
      title: title || 'Imported Chat',
      createdAt: createdAt,
      updatedAt: createdAt,
      overrideTimestamp: true,
      endpoint: this.endpoint,
      model: originalConvo.model ?? fallbackModel,
      ...this.getRetentionFields(),
    };
    convo._id && delete convo._id;
    delete convo.subagentThread;
    this.conversations.push(convo);

    return { conversation: convo, messages: this.messages };
  }

  /**
   * Saves the batch of conversations and messages to the DB.
   * Also increments tag counts for any existing tags.
   * @returns {Promise<void>} A promise that resolves when the batch is saved.
   * @throws {Error} If there is an error saving the batch.
   */
  async saveBatch() {
    const tenantId = getTenantId();
    assertConversationImportWriteSize({
      conversations: this.conversations,
      messages: this.messages,
      ...(tenantId == null ? {} : { tenantId }),
    });

    await assertConversationContentAllowed(
      this.filters,
      {
        conversations: this.conversations,
        messages: this.messages,
      },
      {
        user: { id: this.requestUserId },
        getFiles,
        ...(this.legacyPii == null ? {} : { legacyPii: this.legacyPii }),
      },
    );

    const conversationIds = this.conversations.map((convo) => convo.conversationId);
    const cleanupScope = {
      user: this.requestUserId,
      conversationIds,
      ...(tenantId == null ? {} : { tenantId }),
    };
    const tags = this.conversations.flatMap((convo) => convo.tags);

    try {
      await executeConversationImportWrites({
        saveConversations: () => bulkSaveConvos(this.conversations),
        saveMessages: () => bulkSaveMessages(this.messages, true),
        updateTagCounts: () => bulkIncrementTagCounts(this.requestUserId, tags),
        deleteMessages: () => deleteImportedMessages(cleanupScope),
        deleteConversations: () => deleteImportedConversations(cleanupScope),
        onTagCountError: (error) =>
          logger.error(`Error updating imported tag counts: ${error.message}`),
        onCleanupError: (error, resource) =>
          logger.error(`Error cleaning imported ${resource}: ${error.message}`),
      });
      logger.debug(
        `user: ${this.requestUserId} | Added ${this.conversations.length} conversations and ${this.messages.length} messages to the DB.`,
      );
    } catch (error) {
      logger.error('Error saving batch', error);
      throw error;
    }
  }

  /**
   * Saves a message to the current conversation.
   * @param {object} messageDetails - The details of the message.
   * @param {string} messageDetails.text - The text of the message.
   * @param {string} messageDetails.sender - The sender of the message.
   * @param {string} [messageDetails.messageId] - The ID of the current message.
   * @param {boolean} messageDetails.isCreatedByUser - Indicates whether the message is created by the user.
   * @param {string} [messageDetails.model] - The model used for generating the message.
   * @param {string} [messageDetails.endpoint] - The endpoint used for generating the message.
   * @param {string} [messageDetails.parentMessageId=this.lastMessageId] - The ID of the parent message.
   * @param {Partial<TMessage>} messageDetails.rest - Additional properties that may be included in the message.
   * @returns {object} The saved message object.
   */
  saveMessage({
    text,
    sender,
    isCreatedByUser,
    model,
    messageId,
    parentMessageId = this.lastMessageId,
    endpoint,
    ...rest
  }) {
    const newMessageId = messageId ?? uuidv4();
    const message = {
      ...rest,
      parentMessageId,
      messageId: newMessageId,
      conversationId: this.conversationId,
      isCreatedByUser: isCreatedByUser,
      model: model || this.model,
      user: this.requestUserId,
      endpoint: endpoint ?? this.endpoint,
      unfinished: false,
      isEdited: false,
      error: false,
      sender,
      text,
      ...this.getRetentionFields(),
    };
    message._id && delete message._id;
    this.lastMessageId = newMessageId;
    this.messages.push(message);
    return message;
  }
}

module.exports = {
  ImportBatchBuilder,
  createImportBatchBuilder,
  assertConversationContentAllowed,
};
