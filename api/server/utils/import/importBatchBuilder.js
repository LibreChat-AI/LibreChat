const { v4: uuidv4 } = require('uuid');
const {
  assertConversationImportWriteSize,
  assertModelBoundContent,
  assertConversationImportContentAllowed,
  reportLocatorTraversalFailure,
  resolveImportRetentionFields,
  resolveImportTagCounts,
  getNativeCopyInspectionTokens,
  saveNativeCopyMessages,
} = require('@librechat/api');
const {
  getTenantId,
  logger,
  createFallbackRetentionDate,
  createChatExpirationDate,
} = require('@librechat/data-schemas');
const { EModelEndpoint, Constants, openAISettings } = require('librechat-data-provider');
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
 * @param {object} [options] - Builder options.
 * @param {number} [options.flushThreshold=250] - Number of buffered conversations that triggers an automatic flush.
 * @returns {ImportBatchBuilder} - The newly created ImportBatchBuilder instance.
 */
function createImportBatchBuilder(requestUserId, interfaceConfig, filters, legacyPii, options) {
  return new ImportBatchBuilder(requestUserId, interfaceConfig, filters, legacyPii, options);
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
   * @param {object} [options] - Builder options.
   * @param {number} [options.flushThreshold=250] - Number of buffered conversations that triggers an automatic flush.
   */
  constructor(requestUserId, interfaceConfig, filters, legacyPii, options = {}) {
    this.requestUserId = requestUserId;
    this.interfaceConfig = interfaceConfig;
    this.filters = filters;
    this.legacyPii = legacyPii;
    this.conversations = [];
    this.messages = [];
    this.retentionFields = undefined;
    /** Set by a fork or duplicate so the copy keeps its source's temporary classification. */
    this.sourceIsTemporary = undefined;
    this.flushThreshold = options.flushThreshold ?? 250;
    this.lastFlushOutcome = 'none';
    this.committedConversations = 0;
  }

  getRetentionFields() {
    if (this.retentionFields === undefined) {
      this.retentionFields = resolveImportRetentionFields(
        this.interfaceConfig,
        { createChatExpirationDate, createFallbackRetentionDate, logger },
        { sourceIsTemporary: this.sourceIsTemporary },
      );
    }
    return this.retentionFields;
  }

  /**
   * Returns the outcome of the most recent flush attempt.
   * @returns {'none'|'not_committed'|'ambiguous'|'committed'}
   */
  getLastFlushOutcome() {
    return this.lastFlushOutcome;
  }

  /**
   * Returns how many conversations flushes have committed so far.
   * @returns {number}
   */
  getCommittedConversationCount() {
    return this.committedConversations;
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
      ...(originalConvo.tags != null && {
        tags: resolveImportTagCounts(this.getRetentionFields(), originalConvo.tags),
      }),
    };
    convo._id && delete convo._id;
    delete convo.subagentThread;
    /* A fork or duplicate starts its own unread history; carrying the source
       conversation's catch-up state over would light a dot on a never-read copy. */
    delete convo.lastResponseAt;
    delete convo.lastResponseMessageId;
    delete convo.lastResponseIsManual;
    delete convo.lastSeenAt;
    /** `convoSchema` declares `importedFrom.externalId` required, but every
     * import writes through `bulkSaveConvos`, whose `updateOne` upserts run no
     * validators. An export whose own conversation id is missing or wrongly
     * typed would otherwise store a marker that violates its own schema. The
     * marker is dropped rather than half-filled: an id-less conversation is
     * not dedupable either way, because `loadExistingExternalIds` skips falsy
     * ids when it reads the markers back. */
    const externalId = convo.importedFrom?.externalId;
    if (convo.importedFrom && (typeof externalId !== 'string' || externalId.length === 0)) {
      delete convo.importedFrom;
    }
    this.conversations.push(convo);

    return { conversation: convo, messages: this.messages };
  }

  /**
   * Flushes whatever conversations and messages are currently buffered to the DB.
   * Clears the buffers before awaiting the writes so a concurrent saveMessage
   * call cannot be silently dropped or double-written.
   *
   * The size guard and the content policy run before any write, so a rejected
   * batch leaves nothing behind. Messages are then written before
   * conversations, deliberately: the conversation record is the idempotency
   * marker a retry uses to skip already-imported data, so it must not exist
   * until its messages are durably saved.
   *
   * A failed write removes what this flush may have stored, scoped to this
   * owner and the conversation ids the builder minted. Conversations go first:
   * if that cleanup fails, the messages are kept rather than leaving a
   * committed, marked conversation with no messages that no retry would repair,
   * and the outcome is reported as `ambiguous`. Tag maintenance runs once the
   * markers exist and is logged rather than thrown, because the conversations
   * it counts are already committed.
   * @returns {Promise<void>} A promise that resolves when the flush completes.
   * @throws {Error} If the batch is rejected or a write fails.
   */
  async flush() {
    if (this.conversations.length === 0 && this.messages.length === 0) {
      this.lastFlushOutcome = 'none';
      return;
    }

    this.lastFlushOutcome = 'not_committed';

    const conversations = this.conversations;
    const messages = this.messages;
    this.conversations = [];
    this.messages = [];

    const tenantId = getTenantId();
    assertConversationImportWriteSize({
      conversations,
      messages,
      ...(tenantId == null ? {} : { tenantId }),
    });
    await assertConversationContentAllowed(
      this.filters,
      { conversations, messages },
      {
        user: { id: this.requestUserId },
        getFiles,
        privateTextTokens: getNativeCopyInspectionTokens(messages),
        ...(this.legacyPii == null ? {} : { legacyPii: this.legacyPii }),
      },
    );

    const cleanupScope = {
      user: this.requestUserId,
      conversationIds: conversations.map((convo) => convo.conversationId),
      ...(tenantId == null ? {} : { tenantId }),
    };

    try {
      await saveNativeCopyMessages(bulkSaveMessages, messages);
    } catch (error) {
      logger.error('Error saving batch messages', error);
      await this.discardFailedBatch(cleanupScope, { conversationsWritten: false });
      throw error;
    }

    try {
      await bulkSaveConvos(conversations);
    } catch (error) {
      logger.error('Error saving batch conversations', error);
      await this.discardFailedBatch(cleanupScope, { conversationsWritten: true });
      throw error;
    }
    this.lastFlushOutcome = 'committed';
    this.committedConversations += conversations.length;

    const tags = resolveImportTagCounts(
      this.getRetentionFields(),
      conversations.flatMap((convo) => convo.tags),
    );
    try {
      await bulkIncrementTagCounts(this.requestUserId, tags);
    } catch (error) {
      logger.error(`Error updating imported tag counts: ${error.message}`);
    }
    logger.debug(
      `user: ${this.requestUserId} | Added ${conversations.length} conversations and ${messages.length} messages to the DB.`,
    );
  }

  /**
   * Removes what a failed flush may have stored. A rejected bulk write can still
   * have committed some or all of its documents, so cleanup is by scope, not by
   * the writes that reported success. Best effort, and never allowed to mask the
   * original failure: a cleanup that fails once a conversation write was issued
   * leaves the outcome `ambiguous`, which the importer reads to keep the assets
   * those conversations may reference.
   * @param {{ user: string, conversationIds: string[], tenantId?: string }} scope
   * @param {{ conversationsWritten: boolean }} options
   * @returns {Promise<void>}
   */
  async discardFailedBatch(scope, { conversationsWritten }) {
    if (conversationsWritten) {
      try {
        await deleteImportedConversations(scope);
      } catch (cleanupError) {
        this.lastFlushOutcome = 'ambiguous';
        logger.error(`Error cleaning imported conversations: ${cleanupError.message}`);
        return;
      }
    }
    try {
      await deleteImportedMessages(scope);
    } catch (cleanupError) {
      logger.error(`Error cleaning imported messages: ${cleanupError.message}`);
    }
  }

  /**
   * Flushes the buffered batch once the number of buffered conversations
   * reaches flushThreshold. Intended to be called periodically while importing
   * to bound peak memory and Mongo op size.
   * @returns {Promise<boolean>} Whether a flush actually ran. Callers that
   *   promote bookkeeping on commit (the importer's asset claims) need to know
   *   the difference between "buffered" and "written".
   */
  async maybeFlush() {
    if (this.conversations.length < this.flushThreshold) {
      return false;
    }
    await this.flush();
    return true;
  }

  /**
   * Saves whatever remains in the batch to the DB. Safe to call on an empty
   * builder, in which case it is a no-op.
   * @returns {Promise<void>} A promise that resolves when the batch is saved.
   * @throws {Error} If there is an error saving the batch.
   */
  async saveBatch() {
    await this.flush();
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
