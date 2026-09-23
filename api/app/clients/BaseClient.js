const crypto = require('crypto');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const {
  countTokens,
  checkBalance,
  getBalanceConfig,
  buildMessageFiles,
  sanitizeFileForTransmit,
  extractFileContext,
  getReferencedQuotes,
  applyTurnDelivery,
  encodeAndFormatAudios,
  encodeAndFormatVideos,
  getTransactionsConfig,
  encodeAndFormatDocuments,
  getLangfuseTraceMessageFields,
  isContentFilterError,
  assertModelBoundProviderContent,
  reportLocatorTraversalFailure,
  collectModelBoundHistoricalFileIdState,
  projectModelBoundSourceFiles,
  isModelBoundAttachmentFile,
  isToolOwnedAttachment,
  withBalanceReservations,
  findCheckpointSummaryPart,
  getSummaryPartText,
  runAfterSeed,
  saveTurnConversation,
  seedTurnConversation,
  announceReply,
  needsRetentionConversation,
  getConversationWriteContext,
  persistedReasoningOverrideFields,
} = require('@librechat/api');
const {
  Constants,
  FileSources,
  Tools,
  ErrorTypes,
  ContentTypes,
  isCompactedLeaf,
  EModelEndpoint,
  isParamEndpoint,
  isAgentsEndpoint,
  supportsBalanceCheck,
  isBedrockDocumentType,
  HITL_MESSAGE_FILTER_FIELDS,
  stripReasoningLabelMetadata,
  resolveTurnLLMDeliveryPath,
  resolveUseResponsesApi,
} = require('librechat-data-provider');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { logViolation } = require('~/cache');
const TextStream = require('./TextStream');
const db = require('~/models');

const omitUnreplayedHistoricalFiles = (messages) =>
  messages.map(({ files: _files, attachments: _attachments, ...message }) => ({
    ...message,
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => {
            if (part == null || typeof part !== 'object') {
              return part;
            }
            const {
              file: _partFile,
              files: _partFiles,
              image_file: _imageFile,
              file_id: _fileId,
              ...rest
            } = part;
            return rest;
          }),
        }
      : {}),
  }));

const mergeUserSubmittedPaths = (...pathLists) => [
  ...new Set(
    pathLists
      .flat()
      .filter((path) => typeof path === 'string' && path.startsWith('/') && path.length <= 2048),
  ),
];
const hitlMessageFilterFields = new Set(HITL_MESSAGE_FILTER_FIELDS);
const mergeUserSubmittedMessageFieldPaths = (...entryLists) => {
  const entries = [];
  const seen = new Set();
  for (const entry of entryLists.flat()) {
    if (
      entry == null ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('/') ||
      entry.path.length > 2048 ||
      !hitlMessageFilterFields.has(entry.field)
    ) {
      continue;
    }
    const key = `${entry.field}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries;
};

const buildOwnerFileFilter = (fileIds, user) => {
  if (!user?.id || fileIds.length === 0) {
    return null;
  }

  const filter = {
    file_id: { $in: fileIds },
    user: user.id,
  };
  if (user.tenantId) {
    filter.tenantId = user.tenantId;
  }
  return filter;
};

const getOwnerHistoricalFiles = async (fileIds, user) => {
  const fileFilter = buildOwnerFileFilter(fileIds, user);
  if (!fileFilter) {
    return [];
  }
  return (await db.getFiles(fileFilter, {}, {})) ?? [];
};

const TOOL_ATTACHMENT_KEYS = [
  Tools.file_search,
  Tools.web_search,
  Tools.ui_resources,
  Tools.memory,
];
const DISPLAY_ATTACHMENT_FIELDS = [
  'filename',
  'filepath',
  'expiresAt',
  'conversationId',
  'messageId',
  'toolCallId',
  'name',
];
const PER_MESSAGE_FILE_ATTACHMENT_FIELDS = ['messageId', 'toolCallId'];

const pickFields = (source, fields) => {
  const picked = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked;
};

const sanitizeDisplayOnlyAttachment = (ref) => {
  if (!ref || ref.file_id) {
    return undefined;
  }

  const attachment = pickFields(ref, DISPLAY_ATTACHMENT_FIELDS);
  if (TOOL_ATTACHMENT_KEYS.includes(ref.type)) {
    attachment.type = ref.type;
  }
  for (const key of TOOL_ATTACHMENT_KEYS) {
    if (ref[key] !== undefined) {
      attachment[key] = ref[key];
    }
  }

  return Object.keys(attachment).length > 0 ? attachment : undefined;
};

const rehydrateMessageFileRefs = (refs, filesById, { preserveDisplayOnly = false } = {}) => {
  if (!Array.isArray(refs)) {
    return undefined;
  }

  const files = [];
  for (const ref of refs) {
    const file = filesById.get(ref?.file_id);
    if (file) {
      files.push({
        ...sanitizeFileForTransmit(file),
        ...pickFields(ref, PER_MESSAGE_FILE_ATTACHMENT_FIELDS),
      });
      continue;
    }

    if (preserveDisplayOnly) {
      const displayOnlyAttachment = sanitizeDisplayOnlyAttachment(ref);
      if (displayOnlyAttachment) {
        files.push(displayOnlyAttachment);
      }
    }
  }
  return files.length > 0 ? files : undefined;
};

class BaseClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.sender = options.sender ?? 'AI';
    this.currentDateString = new Date().toLocaleDateString('en-us', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    /** @type {boolean} */
    this.skipSaveConvo = false;
    /** @type {boolean} */
    this.skipSaveUserMessage = false;
    /** @type {string} */
    this.user;
    /** @type {string} */
    this.conversationId;
    /** @type {string} */
    this.responseMessageId;
    /** @type {string} */
    this.parentMessageId;
    /** @type {TAttachment[]} */
    this.attachments;
    /** The key for the usage object's input tokens
     * @type {string} */
    this.inputTokensKey = 'prompt_tokens';
    /** The key for the usage object's output tokens
     * @type {string} */
    this.outputTokensKey = 'completion_tokens';
    /** @type {Set<string>} */
    this.savedMessageIds = new Set();
    /**
     * Flag to determine if the client re-submitted the latest assistant message.
     * @type {boolean | undefined} */
    this.continued;
    /**
     * Flag to determine if the client has already fetched the conversation while saving new messages.
     * @type {boolean | undefined} */
    this.fetchedConvo;
    /** @type {TMessage[]} */
    this.currentMessages = [];
    /** @type {import('librechat-data-provider').VisionModes | undefined} */
    this.visionMode;
  }

  setOptions() {
    throw new Error("Method 'setOptions' must be implemented.");
  }

  getModelBoundStoredMessages(messages) {
    return this.options.resendFiles === false ? omitUnreplayedHistoricalFiles(messages) : messages;
  }

  /** @param {TMessage[]} messages */
  setModelBoundStoredMessages(messages) {
    this.modelBoundStoredMessages = [...(messages ?? [])];
  }

  getModelBoundFileProjection() {
    return projectModelBoundSourceFiles({
      messageFilesBySourceMessageId: this.message_file_map,
      sourceMessages: this.modelBoundStoredMessages,
      steerFileIdsBySourceMessageId: this.modelBoundSteerFileIdsBySourceMessageId,
      replayHistoricalFiles: this.options.resendFiles !== false,
      historicalFiles: this.authorizedHistoricalFiles,
      processedCurrentFiles: Array.isArray(this.options.attachments)
        ? this.options.attachments
        : [],
      canonicalCurrentFiles: Array.isArray(this.modelBoundCurrentFiles)
        ? this.modelBoundCurrentFiles
        : [],
      initiallyOverflowed: this.modelBoundHistoricalFileIdsOverflowed === true,
    });
  }

  /** Optional pre-build guard for policies that cover restored history
   * independently of the final provider selection. */
  assertStoredModelBoundContent() {}

  /** Agent runs can defer the parent write until their first exact model
   * boundary is admitted. Generic clients preserve the historical eager
   * persistence behavior. */
  shouldDeferUserMessagePersistence() {
    return false;
  }

  /** Whether a deferred parent write may still create a new conversation's row up front, so
   * the conversation lists can return it while the run is in flight. */
  shouldSeedDeferredConversation() {
    return false;
  }

  /** Returns the request-scoped deferred parent-write controller, when any. */
  getModelBoundUserMessagePersistence() {
    return this.modelBoundUserMessagePersistence;
  }

  /**
   * Generic clients return their selected model payload from `buildMessages`.
   * AgentClient overrides this because its SDK performs pruning later and
   * enforces the same projection at the actual chat-model callback instead.
   *
   * @param {string | Array<Record<string, unknown>>} payload
   */
  assertBuiltModelBoundContent(payload) {
    const messages = Array.isArray(payload)
      ? payload
      : [{ role: 'user', content: payload, isCreatedByUser: true, isUserSubmitted: true }];
    const fileProjection = this.getModelBoundFileProjection();
    assertModelBoundProviderContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters: this.options.req?.config?.filters,
      legacyPii: this.options.req?.config?.messageFilter?.pii,
      providerMessages: messages,
      storedMessages: this.modelBoundStoredMessages,
      fileIdsBySourceMessageId: fileProjection.fileIdsBySourceMessageId,
      resolvedFiles: fileProjection.resolvedFiles,
      sourceFileProjectionOverflowed: fileProjection.overflowed,
    });
  }

  async getCompletion() {
    throw new Error("Method 'getCompletion' must be implemented.");
  }

  /** @type {sendCompletion} */
  async sendCompletion() {
    throw new Error("Method 'sendCompletion' must be implemented.");
  }

  getSaveOptions() {
    throw new Error('Subclasses must implement getSaveOptions');
  }

  async buildMessages() {
    throw new Error('Subclasses must implement buildMessages');
  }

  async summarizeMessages() {
    throw new Error('Subclasses attempted to call summarizeMessages without implementing it');
  }

  /**
   * @returns {string}
   */
  getResponseModel() {
    if (isAgentsEndpoint(this.options.endpoint) && this.options.agent && this.options.agent.id) {
      return this.options.agent.id;
    }

    return this.modelOptions?.model ?? this.model;
  }

  /**
   * Abstract method to get the token count for a message. Subclasses must implement this method.
   * @param {TMessage} responseMessage
   * @returns {number}
   */
  getTokenCountForResponse(responseMessage) {
    logger.debug('[BaseClient] `recordTokenUsage` not implemented.', {
      messageId: responseMessage?.messageId,
    });
  }

  /**
   * Abstract method to record token usage. Subclasses must implement this method.
   * If a correction to the token usage is needed, the method should return an object with the corrected token counts.
   * Should only be used if `recordCollectedUsage` was not used instead.
   * @param {string} [model]
   * @param {AppConfig['balance']} [balance]
   * @param {number} promptTokens
   * @param {number} completionTokens
   * @param {string} [messageId]
   * @returns {Promise<void>}
   */
  async recordTokenUsage({
    model,
    balance,
    messageId,
    transactions,
    promptTokens,
    completionTokens,
  }) {
    logger.debug('[BaseClient] `recordTokenUsage` not implemented.', {
      model,
      balance,
      messageId,
      transactions,
      promptTokens,
      completionTokens,
    });
  }

  /**
   * Makes an HTTP request and logs the process.
   *
   * @param {RequestInfo} url - The URL to make the request to. Can be a string or a Request object.
   * @param {RequestInit} [init] - Optional init options for the request.
   * @returns {Promise<Response>} - A promise that resolves to the response of the fetch request.
   */
  async fetch(_url, init) {
    let url = _url;
    if (this.options.directEndpoint) {
      url = this.options.reverseProxyUrl;
    }
    logger.debug(`Making request to ${url}`);
    if (typeof Bun !== 'undefined') {
      return await fetch(url, init);
    }
    return await fetch(url, init);
  }

  getBuildMessagesOptions() {
    throw new Error('Subclasses must implement getBuildMessagesOptions');
  }

  async generateTextStream(text, onProgress, options = {}) {
    const stream = new TextStream(text, options);
    await stream.processTextStream(onProgress);
  }

  /**
   * @returns {[string|undefined, string|undefined]}
   */
  processOverideIds() {
    /** @type {Record<string, string | undefined>} */
    let { overrideConvoId, overrideUserMessageId } = this.options?.req?.body ?? {};
    if (overrideConvoId) {
      const [conversationId, index] = overrideConvoId.split(Constants.COMMON_DIVIDER);
      overrideConvoId = conversationId;
      if (index !== '0') {
        this.skipSaveConvo = true;
      }
    }
    if (overrideUserMessageId) {
      const [userMessageId, index] = overrideUserMessageId.split(Constants.COMMON_DIVIDER);
      overrideUserMessageId = userMessageId;
      if (index !== '0') {
        this.skipSaveUserMessage = true;
      }
    }

    return [overrideConvoId, overrideUserMessageId];
  }

  async setMessageOptions(opts = {}) {
    if (opts && opts.replaceOptions) {
      this.setOptions(opts);
    }

    const [overrideConvoId, overrideUserMessageId] = this.processOverideIds();
    const { isEdited, isContinued } = opts;
    if (opts.isCompaction === true) {
      /** The leaf stands in for the user message and is already persisted. */
      this.skipSaveUserMessage = true;
    }
    const user = opts.user ?? null;
    this.user = user;
    const saveOptions = this.getSaveOptions();
    this.abortController = opts.abortController ?? new AbortController();
    const requestConvoId = overrideConvoId ?? opts.conversationId;
    const conversationId = requestConvoId ?? crypto.randomUUID();
    const parentMessageId = opts.parentMessageId ?? Constants.NO_PARENT;
    const userMessageId =
      opts.preallocatedUserMessageId ??
      overrideUserMessageId ??
      opts.overrideParentMessageId ??
      crypto.randomUUID();
    let responseMessageId =
      opts.responseMessageId ?? opts.preallocatedResponseMessageId ?? crypto.randomUUID();
    let head = isEdited ? responseMessageId : parentMessageId;
    this.currentMessages = (await this.loadHistory(conversationId, head)) ?? [];
    this.conversationId = conversationId;

    if (isEdited && !isContinued) {
      responseMessageId = opts.preallocatedResponseMessageId ?? crypto.randomUUID();
      head = responseMessageId;
      this.currentMessages[this.currentMessages.length - 1].messageId = head;
    } else if (opts.preallocatedResponseMessageId != null) {
      responseMessageId = opts.preallocatedResponseMessageId;
    }

    if (opts.isRegenerate && responseMessageId.endsWith('_')) {
      responseMessageId = crypto.randomUUID();
    }

    this.responseMessageId = responseMessageId;

    return {
      ...opts,
      user,
      head,
      saveOptions,
      userMessageId,
      requestConvoId,
      conversationId,
      parentMessageId,
      responseMessageId,
    };
  }

  createUserMessage({ messageId, parentMessageId, conversationId, text }) {
    return {
      messageId,
      parentMessageId,
      conversationId,
      sender: 'User',
      text,
      isCreatedByUser: true,
      ...(this.options?.req?._agentEventTriggerProjection != null && {
        subagentTriggerProjection: this.options.req._agentEventTriggerProjection,
      }),
    };
  }

  /**
   * The message a compaction turn hangs off: the branch's leaf, presented in
   * the user-message slot so the response parents onto it and every consumer
   * of `userMessage` (progress, job metadata, the abort path) keeps working.
   * Identity fields only: the row stays in history untouched, and the object
   * mirrored into job metadata must not carry the leaf's full content.
   * @param {string} parentMessageId
   * @returns {TMessage}
   */
  getCompactionAnchor(parentMessageId) {
    const leaf = this.currentMessages[this.currentMessages.length - 1];
    if (leaf == null || leaf.messageId !== parentMessageId) {
      throw Object.assign(new Error('The message to compact up to was not found.'), {
        statusCode: 404,
        code: 'COMPACTION_ANCHOR_NOT_FOUND',
      });
    }
    if (isCompactedLeaf(leaf)) {
      /** Typed so a stream that already started renders localized copy. */
      throw Object.assign(
        new Error(
          JSON.stringify({
            type: ErrorTypes.COMPACTION_SKIPPED,
            reason: 'nothing_to_summarize',
          }),
        ),
        { statusCode: 409, code: 'NOTHING_TO_COMPACT' },
      );
    }
    return {
      messageId: leaf.messageId,
      parentMessageId: leaf.parentMessageId,
      conversationId: leaf.conversationId,
      isCreatedByUser: leaf.isCreatedByUser === true,
      text: '',
    };
  }

  /**
   * The message the turn hangs off: a fresh user message, the edited message
   * already in history, or (for a compaction) the branch's leaf.
   * @returns {TMessage}
   */
  resolveStartUserMessage({ opts, message, userMessageId, parentMessageId, conversationId }) {
    if (opts.isCompaction) {
      return this.getCompactionAnchor(parentMessageId);
    }
    if (opts.isEdited) {
      return this.currentMessages[this.currentMessages.length - 2];
    }
    return this.createUserMessage({
      messageId: userMessageId,
      parentMessageId,
      conversationId,
      text: message,
    });
  }

  async handleStartMethods(message, opts) {
    const {
      user,
      head,
      saveOptions,
      userMessageId,
      requestConvoId,
      conversationId,
      parentMessageId,
      responseMessageId,
    } = await this.setMessageOptions(opts);
    this.options.startupTelemetry?.mark('history_loaded');

    const userMessage = this.resolveStartUserMessage({
      opts,
      message,
      userMessageId,
      parentMessageId,
      conversationId,
    });

    /**
     * Attach quoted excerpts (the "Add to chat" selections from `req.body.quotes`)
     * before `getReqData`/`onStart` fire, so the optimistic bubble, resumable job
     * metadata, and the saved row all carry them. Only on fresh turns — edits
     * replay an existing message that already has its quotes. The excerpts are
     * merged into the model-facing text later, per message, in `buildMessages`,
     * keeping the stored `text` clean while the count stays consistent.
     */
    if (!opts.isEdited && !opts.isCompaction) {
      const referencedQuotes = getReferencedQuotes(this.options.req?.body?.quotes);
      if (referencedQuotes != null) {
        userMessage.quotes = referencedQuotes;
      }
    }

    Object.assign(
      userMessage,
      persistedReasoningOverrideFields({
        rawReasoningOverride: this.options.req?.body?.reasoningOverride,
        isEdited: opts.isEdited,
        isCompaction: opts.isCompaction,
      }),
    );

    if (typeof opts?.getReqData === 'function') {
      opts.getReqData({
        userMessage,
        conversationId,
        responseMessageId,
        sender: this.sender,
      });
    }

    if (typeof opts?.onStart === 'function') {
      const isNewConvo = !requestConvoId && parentMessageId === Constants.NO_PARENT;
      opts.onStart(userMessage, responseMessageId, isNewConvo);
    }

    return {
      ...opts,
      user,
      head,
      conversationId,
      responseMessageId,
      saveOptions,
      userMessage,
    };
  }

  /**
   * Adds instructions to the messages array. If the instructions object is empty or undefined,
   * the original messages array is returned. Otherwise, the instructions are added to the messages
   * array either at the beginning (default) or preserving the last message at the end.
   *
   * @param {Array} messages - An array of messages.
   * @param {Object} instructions - An object containing instructions to be added to the messages.
   * @param {boolean} [beforeLast=false] - If true, adds instructions before the last message; if false, adds at the beginning.
   * @returns {Array} An array containing messages and instructions, or the original messages if instructions are empty.
   */
  addInstructions(messages, instructions, beforeLast = false) {
    if (!instructions || Object.keys(instructions).length === 0) {
      return messages;
    }

    if (!beforeLast) {
      return [instructions, ...messages];
    }

    // Legacy behavior: add instructions before the last message
    const payload = [];
    if (messages.length > 1) {
      payload.push(...messages.slice(0, -1));
    }

    payload.push(instructions);

    if (messages.length > 0) {
      payload.push(messages[messages.length - 1]);
    }

    return payload;
  }

  concatenateMessages(messages) {
    return messages.reduce((acc, message) => {
      const nameOrRole = message.name ?? message.role;
      return acc + `${nameOrRole}:\n${message.content}\n\n`;
    }, '');
  }

  /**
   * This method processes an array of messages and returns a context of messages that fit within a specified token limit.
   * It iterates over the messages from newest to oldest, adding them to the context until the token limit is reached.
   * If the token limit would be exceeded by adding a message, that message is not added to the context and remains in the original array.
   * The method uses `push` and `pop` operations for efficient array manipulation, and reverses the context array at the end to maintain the original order of the messages.
   *
   * @param {Object} params
   * @param {TMessage[]} params.messages - An array of messages, each with a `tokenCount` property. The messages should be ordered from oldest to newest.
   * @param {number} [params.maxContextTokens] - The max number of tokens allowed in the context. If not provided, defaults to `this.maxContextTokens`.
   * @param {{ role: 'system', content: text, tokenCount: number }} [params.instructions] - Instructions already added to the context at index 0.
   * @returns {Promise<{
   *  context: TMessage[],
   *  remainingContextTokens: number,
   *  messagesToRefine: TMessage[],
   * }>} An object with three properties: `context`, `remainingContextTokens`, and `messagesToRefine`.
   *    `context` is an array of messages that fit within the token limit.
   *    `remainingContextTokens` is the number of tokens remaining within the limit after adding the messages to the context.
   *    `messagesToRefine` is an array of messages that were not added to the context because they would have exceeded the token limit.
   */
  async getMessagesWithinTokenLimit({ messages: _messages, maxContextTokens, instructions }) {
    // Every reply is primed with <|start|>assistant<|message|>, so we
    // start with 3 tokens for the label after all messages have been counted.
    let currentTokenCount = 3;
    const instructionsTokenCount = instructions?.tokenCount ?? 0;
    let remainingContextTokens =
      (maxContextTokens ?? this.maxContextTokens) - instructionsTokenCount;
    const messages = [..._messages];

    const context = [];

    if (currentTokenCount < remainingContextTokens) {
      while (messages.length > 0 && currentTokenCount < remainingContextTokens) {
        if (messages.length === 1 && instructions) {
          break;
        }
        const poppedMessage = messages.pop();
        const { tokenCount } = poppedMessage;

        if (poppedMessage && currentTokenCount + tokenCount <= remainingContextTokens) {
          context.push(poppedMessage);
          currentTokenCount += tokenCount;
        } else {
          messages.push(poppedMessage);
          break;
        }
      }
    }

    if (instructions) {
      context.push(_messages[0]);
      messages.shift();
    }

    const prunedMemory = messages;
    remainingContextTokens -= currentTokenCount;

    return {
      context: context.reverse(),
      remainingContextTokens,
      messagesToRefine: prunedMemory,
    };
  }

  async sendMessage(message, opts = {}) {
    return withBalanceReservations((balanceReservations) =>
      this.sendReservedMessage(message, opts, balanceReservations),
    );
  }

  /**
   * @param {string} message
   * @param {Record<string, unknown>} opts
   * @param {BalanceReservations} balanceReservations - Holds the balance reservation admitting
   * this message; released once its usage is recorded, and by `sendMessage` on any other exit.
   */
  async sendReservedMessage(message, opts, balanceReservations) {
    const appConfig = this.options.req?.config;
    /** @type {Promise<TMessage>} */
    let userMessagePromise;
    /** @type {{ promise: Promise<unknown>, isPending: () => boolean, start: () => Promise<unknown>, cancel: () => Promise<unknown> } | undefined} */
    let userMessagePersistence;
    this.modelBoundUserMessagePersistence = undefined;
    const { user, head, isEdited, conversationId, responseMessageId, saveOptions, userMessage } =
      await this.handleStartMethods(message, opts);

    if (opts.progressCallback) {
      opts.onProgress = opts.progressCallback.call(null, {
        ...(opts.progressOptions ?? {}),
        parentMessageId: userMessage.messageId,
        messageId: responseMessageId,
      });
    }

    const { editedContent } = opts;

    // It's not necessary to push to currentMessages
    // depending on subclass implementation of handling messages
    // When this is an edit, all messages are already in currentMessages, both user and response
    if (isEdited) {
      let latestMessage = this.currentMessages[this.currentMessages.length - 1];
      if (!latestMessage) {
        latestMessage = {
          messageId: responseMessageId,
          conversationId,
          parentMessageId: userMessage.messageId,
          isCreatedByUser: false,
          model: this.modelOptions?.model ?? this.model,
          sender: this.sender,
        };
        this.currentMessages.push(userMessage, latestMessage);
      } else if (editedContent != null) {
        // Handle editedContent for content parts
        if (editedContent && latestMessage.content && Array.isArray(latestMessage.content)) {
          const { index, type } = editedContent;
          const text = editedContent[type];
          if (index >= 0 && index < latestMessage.content.length) {
            const contentPart = latestMessage.content[index];
            let didApplyEdit = false;
            if (type === ContentTypes.THINK && contentPart.type === ContentTypes.THINK) {
              contentPart[ContentTypes.THINK] = text;
              didApplyEdit = true;
              delete contentPart.reasoning_label;
              delete contentPart.reasoning_label_step_id;
              delete contentPart.reasoning_label_attempts;
              delete contentPart.reasoning_label_submitted_chars;
              delete contentPart.reasoning_label_revision;
              delete contentPart.reasoning_label_status;
            } else if (type === ContentTypes.TEXT && contentPart.type === ContentTypes.TEXT) {
              contentPart[ContentTypes.TEXT] = text;
              didApplyEdit = true;
            }
            if (didApplyEdit) {
              latestMessage.userSubmittedPaths = mergeUserSubmittedPaths(
                latestMessage.userSubmittedPaths,
                [`/content/${index}/${type}`],
              );
            }
          }
        }
      }
      this.continued = true;
    } else if (opts.isCompaction !== true) {
      this.currentMessages.push(userMessage);
    }

    /**
     * When the userMessage is pushed to currentMessages, the parentMessage is the userMessageId.
     * this only matters when buildMessages is utilizing the parentMessageId, and may vary on implementation
     */
    const parentMessageId = isEdited ? head : userMessage.messageId;
    this.parentMessageId = parentMessageId;
    const modelBoundStoredMessages = this.getModelBoundStoredMessages(this.currentMessages);
    this.setModelBoundStoredMessages(modelBoundStoredMessages);
    this.assertStoredModelBoundContent();
    this.modelBoundCurrentFiles = Array.isArray(this.options.attachments)
      ? [...this.options.attachments]
      : [];
    if (this.options.resendFiles !== false && this.authorizedHistoricalFiles == null) {
      const historicalFileState = collectModelBoundHistoricalFileIdState(modelBoundStoredMessages);
      this.modelBoundHistoricalFileIdsOverflowed ||= historicalFileState.overflowed;
      const files = this.resolveTurnAttachments(
        await getOwnerHistoricalFiles(historicalFileState.fileIds, this.options.req?.user),
      );
      this.authorizedHistoricalFiles = new Map(
        files
          .filter((file) => typeof file?.file_id === 'string' && file.file_id.length > 0)
          .map((file) => [file.file_id, file]),
      );
    }
    let {
      prompt: payload,
      tokenCountMap,
      promptTokens,
    } = await this.buildMessages(
      modelBoundStoredMessages,
      parentMessageId,
      this.getBuildMessagesOptions(opts),
      opts,
    );
    this.assertBuiltModelBoundContent(payload);
    this.options.startupTelemetry?.mark('messages_built');

    /** A compaction anchor is the persisted leaf, whose own count must stay. */
    if (tokenCountMap && tokenCountMap[userMessage.messageId] && opts.isCompaction !== true) {
      userMessage.tokenCount = tokenCountMap[userMessage.messageId];
      logger.debug('[BaseClient] userMessage', {
        messageId: userMessage.messageId,
        tokenCount: userMessage.tokenCount,
        conversationId: userMessage.conversationId,
      });
    }

    if (!isEdited && !this.skipSaveUserMessage) {
      const reqFiles = this.options.req?.body?.files;
      if (reqFiles && Array.isArray(this.options.attachments)) {
        const files = buildMessageFiles(reqFiles, this.options.attachments);
        if (files.length > 0) {
          userMessage.files = files;
        }
        delete userMessage.image_urls;
      }
      /**
       * Persist the user's manual skill picks onto the user message so the
       * frontend `SkillPills` component can render them in history
       * after reload. UI-only metadata — the runtime skill resolution
       * pipeline reads the top-level `req.body.manualSkills` separately.
       * Filter is defense-in-depth on top of Mongoose schema validation:
       * keeps the DB row free of empty/non-string entries even if a
       * crafted payload slips past schema checks upstream.
       */
      const rawManualSkills = this.options.req?.body?.manualSkills;
      if (Array.isArray(rawManualSkills) && rawManualSkills.length > 0) {
        const skills = rawManualSkills.filter((s) => typeof s === 'string' && s.length > 0);
        if (skills.length > 0) {
          userMessage.manualSkills = skills;
        }
      }
      /**
       * Persist the names of skills auto-primed this turn via `always-apply`
       * frontmatter so `SkillPills` can render pinned-variant badges
       * on the user bubble that survive reload and history render. Frozen
       * at turn time (not reconstructed from `Skill.alwaysApply` at render
       * time) because the flag is mutable — historical turns must keep
       * their audit trail even if an admin flips `alwaysApply` off later.
       */
      const alwaysApplySkillPrimes = this.options.agent?.alwaysApplySkillPrimes;
      if (Array.isArray(alwaysApplySkillPrimes) && alwaysApplySkillPrimes.length > 0) {
        const names = alwaysApplySkillPrimes
          .map((p) => p?.name)
          .filter((n) => typeof n === 'string' && n.length > 0);
        if (names.length > 0) {
          userMessage.alwaysAppliedSkills = names;
        }
      }
      const startUserMessagePersistence = () => {
        this.savedMessageIds.add(userMessage.messageId);
        return this.saveMessageToDatabase(userMessage, saveOptions, user).catch((err) => {
          logger.error('[BaseClient] Failed to save user message:', err);
          return {};
        });
      };
      if (this.shouldDeferUserMessagePersistence()) {
        let state = 'pending';
        let startPersistence = startUserMessagePersistence;
        if (!this.skipSaveConvo && this.shouldSeedDeferredConversation()) {
          const seed = seedTurnConversation(
            db,
            this.getTurnConversationFields(
              this.options,
              userMessage.conversationId,
              saveOptions,
              'api/app/clients/BaseClient.js - sendMessage #seedConversation',
            ),
          );
          startPersistence = runAfterSeed(seed, startUserMessagePersistence);
        }
        let resolvePersistence;
        let removeAbortListener = () => {};
        const persistencePromise = new Promise((resolve) => {
          resolvePersistence = resolve;
        });
        const start = () => {
          if (state !== 'pending') {
            return persistencePromise;
          }
          state = 'started';
          removeAbortListener();
          const startDeferredPersistence = startPersistence;
          startPersistence = undefined;
          try {
            Promise.resolve(startDeferredPersistence?.()).then(resolvePersistence, () =>
              resolvePersistence({}),
            );
          } catch (error) {
            logger.error('[BaseClient] Failed to start deferred user-message persistence:', error);
            resolvePersistence({});
          }
          return persistencePromise;
        };
        const cancel = () => {
          if (state !== 'pending') {
            return persistencePromise;
          }
          state = 'cancelled';
          removeAbortListener();
          startPersistence = undefined;
          /** Resolve with a non-persisted sentinel. The subagent task store
           * validates the result and fails child creation closed, while the
           * request's policy error remains the only surfaced rejection. */
          resolvePersistence({});
          return persistencePromise;
        };
        userMessagePersistence = Object.freeze({
          promise: persistencePromise,
          isPending: () => state === 'pending',
          start,
          cancel,
        });
        const requestAbortSignal = this.abortController?.signal;
        if (requestAbortSignal?.aborted) {
          /** Preserve the historical durability contract for Stop: abort
           * persistence may publish the partial assistant response before the
           * provider unwinds, so its parent write must already be underway. */
          start();
        } else if (requestAbortSignal != null) {
          const startOnAbort = () => start();
          requestAbortSignal.addEventListener('abort', startOnAbort, { once: true });
          removeAbortListener = () => requestAbortSignal.removeEventListener('abort', startOnAbort);
        }
        this.modelBoundUserMessagePersistence = userMessagePersistence;
        userMessagePromise = persistencePromise;
      } else {
        userMessagePromise = startUserMessagePersistence();
      }
      if (typeof opts?.getReqData === 'function') {
        opts.getReqData({
          userMessagePromise,
        });
      }
    }

    const balanceConfig = getBalanceConfig(appConfig);
    const transactionsConfig = getTransactionsConfig(appConfig);
    let completionResult;
    try {
      if (
        balanceConfig?.enabled &&
        supportsBalanceCheck[this.options.endpointType ?? this.options.endpoint]
      ) {
        const balanceAdmission = checkBalance(
          {
            req: this.options.req,
            res: this.options.res,
            txData: {
              user: this.user,
              tokenType: 'prompt',
              amount: promptTokens,
              endpoint: this.options.endpoint,
              model: this.modelOptions?.model ?? this.model,
              endpointTokenConfig: this.options.endpointTokenConfig,
            },
          },
          {
            logViolation,
            getMultiplier: db.getMultiplier,
            reserveBalance: db.reserveBalance,
            renewBalanceReservation: db.renewBalanceReservation,
            releaseBalanceReservation: db.releaseBalanceReservation,
            balanceConfig,
          },
        );
        await balanceReservations.track(balanceAdmission);
      }

      completionResult = await this.sendCompletion(payload, opts);
    } catch (error) {
      if (userMessagePersistence?.isPending()) {
        if (isContentFilterError(error)) {
          userMessagePersistence.cancel();
        } else {
          userMessagePersistence.start();
        }
      }
      throw error;
    }
    /** A safe no-model completion (or a runtime that cannot expose the
     * admission callback) must not leave the parent-write gate pending. */
    userMessagePersistence?.start();
    const { completion, metadata } = completionResult;
    if (this.abortController) {
      this.abortController.requestCompleted = true;
    }

    const isAgentResponse =
      this.clientName === EModelEndpoint.agents || isAgentsEndpoint(this.options.endpoint);
    const langfuseTraceFields = isAgentResponse
      ? await getLangfuseTraceMessageFields(appConfig, responseMessageId)
      : undefined;

    /** @type {TMessage} */
    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      ...(langfuseTraceFields ?? {}),
      isEdited,
      model: this.getResponseModel(),
      sender: this.sender,
      promptTokens,
      iconURL: this.options.iconURL,
      endpoint: this.options.endpoint,
      ...(this.metadata ?? {}),
      metadata: Object.keys(metadata ?? {}).length > 0 ? metadata : undefined,
    };
    let editedSourceMessage;
    let editedSourceContentLength = 0;

    if (typeof completion === 'string') {
      responseMessage.text = completion;
    } else if (
      Array.isArray(completion) &&
      (this.clientName === EModelEndpoint.agents ||
        isParamEndpoint(this.options.endpoint, this.options.endpointType))
    ) {
      responseMessage.text = '';

      if (!opts.editedContent || this.currentMessages.length === 0) {
        responseMessage.content = completion;
      } else {
        const latestMessage = this.currentMessages[this.currentMessages.length - 1];
        if (!latestMessage?.content) {
          responseMessage.content = completion;
        } else {
          editedSourceMessage = latestMessage;
          editedSourceContentLength = latestMessage.content.length;
          const existingContent = [...latestMessage.content];
          const { type: editedType } = opts.editedContent;
          responseMessage.content = this.mergeEditedContent(
            existingContent,
            completion,
            editedType,
          );
        }
      }
    } else if (Array.isArray(completion)) {
      responseMessage.text = completion.join('');
    }

    if (Array.isArray(responseMessage.content)) {
      const userSubmittedPaths = [];
      const userSubmittedMessageFieldPaths = [];
      for (let index = 0; index < responseMessage.content.length; index++) {
        if (responseMessage.content[index]?.type === ContentTypes.STEER) {
          userSubmittedPaths.push(`/content/${index}`);
        }
      }
      if (editedSourceMessage != null) {
        userSubmittedPaths.push(
          ...(editedSourceMessage.userSubmittedPaths ?? []).filter((path) => {
            const match = /^\/content\/(\d+)(?:\/|$)/.exec(path);
            return match != null && Number(match[1]) < editedSourceContentLength;
          }),
        );
        userSubmittedMessageFieldPaths.push(
          ...(editedSourceMessage.userSubmittedMessageFieldPaths ?? []).filter((entry) => {
            const match = /^\/content\/(\d+)(?:\/|$)/.exec(entry?.path);
            return match != null && Number(match[1]) < editedSourceContentLength;
          }),
        );
        if (editedSourceMessage.isUserSubmitted === true) {
          for (let index = 0; index < editedSourceContentLength; index++) {
            userSubmittedPaths.push(`/content/${index}`);
          }
        }
        const editedIndex = opts.editedContent?.index;
        const editedType = opts.editedContent?.type;
        if (
          Number.isInteger(editedIndex) &&
          editedIndex >= 0 &&
          editedIndex < editedSourceContentLength &&
          (editedType === ContentTypes.TEXT || editedType === ContentTypes.THINK)
        ) {
          userSubmittedPaths.push(`/content/${editedIndex}/${editedType}`);
        }
      }
      if (userSubmittedPaths.length > 0) {
        responseMessage.userSubmittedPaths = mergeUserSubmittedPaths(userSubmittedPaths);
      }
      if (userSubmittedMessageFieldPaths.length > 0) {
        responseMessage.userSubmittedMessageFieldPaths = mergeUserSubmittedMessageFieldPaths(
          userSubmittedMessageFieldPaths,
        );
      }
    }

    if (tokenCountMap && this.recordTokenUsage && this.getTokenCountForResponse) {
      let completionTokens;

      /**
       * Metadata about input/output costs for the current message. The client
       * should provide a function to get the current stream usage metadata; if not,
       * use the legacy token estimations.
       * @type {StreamUsage | null} */
      const usage = this.getStreamUsage != null ? this.getStreamUsage() : null;

      if (usage != null && Number(usage[this.outputTokensKey]) > 0) {
        responseMessage.tokenCount = usage[this.outputTokensKey];
        completionTokens = responseMessage.tokenCount;
      } else {
        responseMessage.tokenCount = this.getTokenCountForResponse(responseMessage);
        completionTokens = responseMessage.tokenCount;
        await this.recordTokenUsage({
          usage,
          promptTokens,
          completionTokens,
          balance: balanceConfig,
          transactions: transactionsConfig,
          /** Note: When using agents, responseMessage.model is the agent ID, not the model */
          model: this.model,
          messageId: this.responseMessageId,
        });
      }

      logger.debug('[BaseClient] Response token usage', {
        messageId: responseMessage.messageId,
        model: responseMessage.model,
        promptTokens,
        completionTokens,
      });
    }
    await balanceReservations.release();

    if (userMessagePromise) {
      await userMessagePromise;
    }

    if (
      opts.isCompaction !== true &&
      this.contextMeta?.calibrationRatio > 0 &&
      this.contextMeta.calibrationRatio !== 1 &&
      userMessage.tokenCount > 0
    ) {
      const calibrated = Math.round(userMessage.tokenCount * this.contextMeta.calibrationRatio);
      if (calibrated !== userMessage.tokenCount) {
        logger.debug('[BaseClient] Calibrated user message tokenCount', {
          messageId: userMessage.messageId,
          raw: userMessage.tokenCount,
          calibrated,
          ratio: this.contextMeta.calibrationRatio,
        });
        userMessage.tokenCount = calibrated;
        await this.updateMessageInDatabase({
          messageId: userMessage.messageId,
          tokenCount: calibrated,
        });
      }
    }

    if (this.artifactPromises) {
      responseMessage.attachments = (await Promise.all(this.artifactPromises)).filter((a) => a);
    }

    if (this.options.attachments) {
      try {
        saveOptions.files = this.options.attachments.map((attachments) => attachments.file_id);
      } catch (error) {
        logger.error('[BaseClient] Error mapping attachments for conversation', error);
      }
    }

    if (this.contextMeta) {
      responseMessage.contextMeta = this.contextMeta;
    }

    /** Resumable generation controllers must win the generation's terminal
     * CAS before this outcome-defining `unfinished:false` write can begin.
     * The hook is deliberately narrow: ordinary clients omit it, and `false`
     * means another terminal owner (for example Stop) already won, so this
     * stale completion must return without writing the response row. */
    if (typeof opts.beforeResponsePersistence === 'function') {
      const ownsTerminalPersistence = await opts.beforeResponsePersistence(responseMessage);
      if (ownsTerminalPersistence === false) {
        responseMessage.databasePromise = Promise.resolve({ persistenceSkipped: true });
        return responseMessage;
      }
    }

    responseMessage.databasePromise = this.saveMessageToDatabase(
      responseMessage,
      saveOptions,
      user,
    );
    this.savedMessageIds.add(responseMessage.messageId);
    return responseMessage;
  }

  async loadHistory(conversationId, parentMessageId = null) {
    logger.debug('[BaseClient] Loading history:', { conversationId, parentMessageId });

    /** No message has the root sentinel as its id, so the chain walk from it is empty. */
    if (parentMessageId === Constants.NO_PARENT) {
      return [];
    }

    const messages = (await db.getMessages({ conversationId, user: this.user })) ?? [];
    /** A client that reads beyond the walk below (which stops at a checkpoint
     *  summary) receives every row here; the rest keep nothing. */
    this.onHistoryLoaded?.(messages);

    if (messages.length === 0) {
      return [];
    }

    let mapMethod = null;
    if (this.getMessageMapMethod) {
      mapMethod = this.getMessageMapMethod();
    }

    let _messages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      mapMethod,
    });
    if (this.shouldSummarize) {
      for (let i = _messages.length - 1; i >= 0; i--) {
        const msg = _messages[i];
        if (!msg) {
          continue;
        }

        const summaryBlock = findCheckpointSummaryPart(msg.content);
        if (summaryBlock) {
          this.previous_summary = {
            ...msg,
            summary: getSummaryPartText(summaryBlock),
            summaryTokenCount: summaryBlock.tokenCount,
          };
          break;
        }

        if (msg.summary) {
          this.previous_summary = msg;
          break;
        }
      }

      _messages = this.constructor.getMessagesForConversation({
        messages,
        parentMessageId,
        mapMethod,
        summary: true,
      });

      if (this.previous_summary) {
        const { messageId, summary, tokenCount, summaryTokenCount } = this.previous_summary;
        logger.debug('[BaseClient] Previous summary:', {
          messageId,
          summary,
          tokenCount,
          summaryTokenCount,
        });
      }
    }

    return this.addPreviousAttachments(_messages);
  }

  /**
   * Save a message to the database.
   * @param {TMessage} message
   * @param {Partial<TConversation>} endpointOptions
   * @param {string | null} user
   */
  async saveMessageToDatabase(message, endpointOptions, user = null) {
    // Snapshot options before any await; disposeClient may set client.options = null
    // while this method is suspended at an I/O boundary, but the local reference
    // remains valid (disposeClient nulls the property, not the object itself).
    const options = this.options;
    if (!options) {
      logger.error('[BaseClient] saveMessageToDatabase: client disposed before save, skipping');
      return {};
    }

    if (this.user && user !== this.user) {
      throw new Error('User mismatch.');
    }

    const hasAddedConvo = options?.req?.body?.addedConvo != null;
    const req = options?.req;
    if (needsRetentionConversation(req)) {
      req.resolvedConversation = await db.getConvo(req.user.id, message.conversationId);
    }
    const reqCtx = getConversationWriteContext(req);
    const savedMessage = await db.saveMessage(
      reqCtx,
      {
        ...message,
        endpoint: options.endpoint,
        unfinished: false,
        user,
        ...(hasAddedConvo && { addedConvo: true }),
      },
      { context: 'api/app/clients/BaseClient.js - saveMessageToDatabase #saveMessage' },
    );

    /** Only a reply that is actually in the message history may light an indicator: a write
     *  that resolved empty (duplicate-key recovery that could not re-read the row) would
     *  otherwise announce a reply nobody can open. */
    const persistedReply = savedMessage != null && message.isCreatedByUser === false;

    if (this.skipSaveConvo) {
      /* The secondary response of an override pair persists its message but deliberately skips
         the conversation-field save, so the stamp below is never reached. The reply still has
         to light the indicator: the primary response's stamp is older whenever this one
         finishes later, and absent altogether when the primary failed. Best effort, because a
         missed indicator must not fail a reply that is already persisted. */
      /* `user` is the same id the message was just saved under; `reqCtx` carries an empty
         string when no request object is present, which the direct-save paths do not
         guarantee, so the fallback turns on truthiness rather than on nullishness. */
      await announceReply(db, {
        userId: reqCtx.userId || user || this.user,
        conversationId: message.conversationId,
        reply: {
          messageId: persistedReply ? savedMessage.messageId : undefined,
          content: message.content,
          text: message.text,
          attachments: message.attachments,
          isTemporary: reqCtx.isTemporary,
        },
        context: 'BaseClient - skipped conversation save',
      });
      return { message: savedMessage };
    }

    const { conversation, initialized } = await saveTurnConversation(db, {
      ...this.getTurnConversationFields(
        options,
        message.conversationId,
        endpointOptions,
        'api/app/clients/BaseClient.js - saveMessageToDatabase #saveConvo',
      ),
      ctx: reqCtx,
      initialized: this.fetchedConvo === true,
      savedMessageId: savedMessage?._id,
      reply: persistedReply
        ? {
            messageId: savedMessage.messageId,
            content: message.content,
            text: message.text,
            attachments: message.attachments,
          }
        : undefined,
    });
    if (initialized) {
      this.fetchedConvo = true;
    }

    return { message: savedMessage, conversation };
  }

  /**
   * The conversation fields a turn's writes share.
   * @param {Object} options - The client options snapshot.
   * @param {string} conversationId
   * @param {Partial<TConversation>} endpointOptions
   * @param {string} context - Names the write in the save log.
   */
  getTurnConversationFields(options, conversationId, endpointOptions, context) {
    return {
      req: options.req,
      conversationId,
      endpoint: options.endpoint,
      endpointType: options.endpointType,
      endpointOptions,
      agentId: options.agent?.id,
      context,
    };
  }

  /**
   * Update a message in the database.
   * @param {Partial<TMessage>} message
   */
  async updateMessageInDatabase(message) {
    await db.updateMessage(this.options?.req?.user?.id, message);
  }

  /**
   * Iterate through messages, building an array based on the parentMessageId.
   *
   * This function constructs a conversation thread by traversing messages from a given parentMessageId up to the root message.
   * It handles cyclic references by ensuring that a message is not processed more than once.
   * If the 'summary' option is set to true and a message has a 'summary' property:
   * - The message's 'role' is set to 'system'.
   * - The message's 'text' is set to its 'summary'.
   * - If the message has a 'summaryTokenCount', the message's 'tokenCount' is set to 'summaryTokenCount'.
   * The traversal stops at the message with the 'summary' property.
   *
   * Each message object should have an 'id' or 'messageId' property and may have a 'parentMessageId' property.
   * The 'parentMessageId' is the ID of the message that the current message is a reply to.
   * If 'parentMessageId' is not present, null, or is Constants.NO_PARENT,
   * the message is considered a root message.
   *
   * @param {Object} options - The options for the function.
   * @param {TMessage[]} options.messages - An array of message objects. Each object should have either an 'id' or 'messageId' property, and may have a 'parentMessageId' property.
   * @param {string} options.parentMessageId - The ID of the parent message to start the traversal from.
   * @param {Function} [options.mapMethod] - An optional function to map over the ordered messages. Applied conditionally based on mapCondition.
   * @param {(message: TMessage) => boolean} [options.mapCondition] - An optional function to determine whether mapMethod should be applied to a given message. If not provided and mapMethod is set, mapMethod applies to all messages.
   * @param {boolean} [options.summary=false] - If set to true, the traversal modifies messages with 'summary' and 'summaryTokenCount' properties and stops at the message with a 'summary' property.
   * @returns {TMessage[]} An array containing the messages in the order they should be displayed, starting with the most recent message with a 'summary' property if the 'summary' option is true, and ending with the message identified by 'parentMessageId'.
   */
  static getMessagesForConversation({
    messages,
    parentMessageId,
    mapMethod = null,
    mapCondition = null,
    summary = false,
  }) {
    if (!messages || messages.length === 0) {
      return [];
    }

    const orderedMessages = [];
    let currentMessageId = parentMessageId;
    const visitedMessageIds = new Set();
    const messagesById = new Map();
    for (const msg of messages) {
      const messageId = msg.messageId ?? msg.id;
      if (!messagesById.has(messageId)) {
        messagesById.set(messageId, msg);
      }
    }

    while (currentMessageId) {
      if (visitedMessageIds.has(currentMessageId)) {
        break;
      }
      const message = messagesById.get(currentMessageId);

      visitedMessageIds.add(currentMessageId);

      if (!message) {
        break;
      }

      let resolved = message;
      let hasSummary = false;
      if (summary) {
        const summaryBlock = findCheckpointSummaryPart(message.content);
        if (summaryBlock) {
          const summaryText = getSummaryPartText(summaryBlock);
          resolved = {
            ...message,
            role: 'system',
            content: [{ type: ContentTypes.TEXT, text: summaryText }],
            tokenCount: summaryBlock.tokenCount,
          };
          hasSummary = true;
        } else if (message.summary) {
          resolved = {
            ...message,
            role: 'system',
            content: [{ type: ContentTypes.TEXT, text: message.summary }],
            tokenCount: message.summaryTokenCount ?? message.tokenCount,
          };
          hasSummary = true;
        }
      }

      const shouldMap = mapMethod != null && (mapCondition != null ? mapCondition(resolved) : true);
      const processedMessage = shouldMap ? mapMethod(resolved) : resolved;
      orderedMessages.push(processedMessage);

      if (hasSummary) {
        break;
      }

      currentMessageId =
        message.parentMessageId === Constants.NO_PARENT ? null : message.parentMessageId;
    }

    orderedMessages.reverse();
    return orderedMessages;
  }

  /**
   * Algorithm adapted from "6. Counting tokens for chat API calls" of
   * https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   *
   * An additional 3 tokens need to be added for assistant label priming after all messages have been counted.
   * In our implementation, this is accounted for in the getMessagesWithinTokenLimit method.
   *
   * The content parts example was adapted from the following example:
   * https://github.com/openai/openai-cookbook/pull/881/files
   *
   * Note: image token calculation is to be done elsewhere where we have access to the image metadata
   *
   * @param {Object} message
   */
  getTokenCountForMessage(message) {
    // Note: gpt-3.5-turbo and gpt-4 may update over time. Use default for these as well as for unknown models
    let tokensPerMessage = 3;
    let tokensPerName = 1;
    const model = this.modelOptions?.model ?? this.model;

    if (model === 'gpt-3.5-turbo-0301') {
      tokensPerMessage = 4;
      tokensPerName = -1;
    }

    const processValue = (value) => {
      if (Array.isArray(value)) {
        for (let item of value) {
          if (
            !item ||
            !item.type ||
            item.type === ContentTypes.THINK ||
            item.type === ContentTypes.ERROR ||
            // UI-only progress headers — never model input, never billed output
            item.type === ContentTypes.ACTIVITY_LABEL ||
            item.type === ContentTypes.IMAGE_URL
          ) {
            continue;
          }

          if (item.type === ContentTypes.TOOL_CALL && item.tool_call != null) {
            const toolName = item.tool_call?.name || '';
            if (toolName != null && toolName && typeof toolName === 'string') {
              numTokens += this.getTokenCount(toolName);
            }

            const args = item.tool_call?.args || '';
            if (args != null && args && typeof args === 'string') {
              numTokens += this.getTokenCount(args);
            }

            const output = item.tool_call?.output || '';
            if (output != null && output && typeof output === 'string') {
              numTokens += this.getTokenCount(output);
            }
            continue;
          }

          const nestedValue = item[item.type];

          if (!nestedValue) {
            continue;
          }

          processValue(nestedValue);
        }
      } else if (typeof value === 'string') {
        numTokens += this.getTokenCount(value);
      } else if (typeof value === 'number') {
        numTokens += this.getTokenCount(value.toString());
      } else if (typeof value === 'boolean') {
        numTokens += this.getTokenCount(value.toString());
      }
    };

    let numTokens = tokensPerMessage;
    for (let [key, value] of Object.entries(message)) {
      processValue(value);

      if (key === 'name') {
        numTokens += tokensPerName;
      }
    }
    return numTokens;
  }

  /**
   * Merges completion content with existing content when editing TEXT or THINK types
   * @param {Array} existingContent - The existing content array
   * @param {Array} newCompletion - The new completion content
   * @param {string} editedType - The type of content being edited
   * @returns {Array} The merged content array
   */
  mergeEditedContent(existingContent, newCompletion, editedType) {
    if (!newCompletion.length) {
      return existingContent.concat(newCompletion);
    }

    const lastIndex = existingContent.length - 1;
    const lastExisting = existingContent[lastIndex];
    const firstNew = newCompletion[0];
    /** Phased and legacy/unphased text are distinct semantic streams. Merging
     *  either direction would stamp retained text with the wrong phase. */
    const textPhaseCompatible =
      editedType !== ContentTypes.TEXT ||
      (lastExisting?.phase ?? null) === (firstNew?.phase ?? null);
    const mergesFirstPart =
      (editedType === ContentTypes.TEXT || editedType === ContentTypes.THINK) &&
      lastExisting?.type === firstNew?.type &&
      firstNew?.type === editedType &&
      textPhaseCompatible;
    /** Phase bounds are completion-local while the run streams. Persist them
     *  in the same absolute index space as the edited response assembled
     *  here. When the first new text/think part merges into the retained tail,
     *  every completion index shifts by prefixLength - 1; otherwise it shifts
     *  by the full retained prefix. */
    const phaseIndexOffset = mergesFirstPart ? lastIndex : existingContent.length;
    const adjustedCompletion = newCompletion.map((part) => {
      if (
        part?.type !== ContentTypes.ACTIVITY_LABEL ||
        part.activity_label_type !== 'phase' ||
        typeof part.activity_start_index !== 'number'
      ) {
        return part;
      }
      return {
        ...part,
        activity_start_index: part.activity_start_index + phaseIndexOffset,
        ...(typeof part.activity_end_index === 'number' && {
          activity_end_index: part.activity_end_index + phaseIndexOffset,
        }),
      };
    });

    if (editedType !== ContentTypes.TEXT && editedType !== ContentTypes.THINK) {
      return existingContent.concat(adjustedCompletion);
    }

    if (!mergesFirstPart) {
      return existingContent.concat(adjustedCompletion);
    }

    const mergedContent = [...existingContent];
    if (editedType === ContentTypes.TEXT) {
      mergedContent[lastIndex] = {
        ...mergedContent[lastIndex],
        ...(firstNew.phase != null && { phase: firstNew.phase }),
        [ContentTypes.TEXT]:
          (mergedContent[lastIndex][ContentTypes.TEXT] || '') +
          (adjustedCompletion[0][ContentTypes.TEXT] || ''),
      };
    } else {
      mergedContent[lastIndex] = {
        ...stripReasoningLabelMetadata(mergedContent[lastIndex]),
        ...(adjustedCompletion[0].reasoning_label_step_id != null && {
          reasoning_label: adjustedCompletion[0].reasoning_label,
          reasoning_label_step_id: adjustedCompletion[0].reasoning_label_step_id,
          reasoning_label_attempts: adjustedCompletion[0].reasoning_label_attempts,
          reasoning_label_submitted_chars: adjustedCompletion[0].reasoning_label_submitted_chars,
          reasoning_label_revision: adjustedCompletion[0].reasoning_label_revision,
          reasoning_label_status: adjustedCompletion[0].reasoning_label_status,
        }),
        [ContentTypes.THINK]:
          (mergedContent[lastIndex][ContentTypes.THINK] || '') +
          (adjustedCompletion[0][ContentTypes.THINK] || ''),
      };
    }

    // Add remaining completion items
    return mergedContent.concat(adjustedCompletion.slice(1));
  }

  async sendPayload(payload, opts = {}) {
    if (opts && typeof opts === 'object') {
      this.setOptions(opts);
    }

    return await this.sendCompletion(payload, opts);
  }

  /** Whether this turn talks to the Responses API, which is what lets Azure carry a
   *  document natively. A saved agent holds it in its parameters and a plain conversation
   *  in its model options, and both readers of it have been wrong by consulting one. */
  usesResponsesApi() {
    return resolveUseResponsesApi(
      this.options.agent?.model_parameters?.useResponsesApi,
      this.modelOptions?.useResponsesApi,
    );
  }

  async addDocuments(message, attachments) {
    const documentResult = await encodeAndFormatDocuments(
      this.options.req,
      attachments,
      {
        provider: this.options.agent?.provider ?? this.options.endpoint,
        endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
        useResponsesApi: this.usesResponsesApi(),
        model: this.modelOptions?.model ?? this.model,
      },
      getStrategyFunctions,
    );
    message.documents =
      documentResult.documents && documentResult.documents.length
        ? documentResult.documents
        : undefined;
    return documentResult.files;
  }

  async addVideos(message, attachments) {
    const videoResult = await encodeAndFormatVideos(
      this.options.req,
      attachments,
      {
        provider: this.options.agent?.provider ?? this.options.endpoint,
        endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      },
      getStrategyFunctions,
    );
    message.videos =
      videoResult.videos && videoResult.videos.length ? videoResult.videos : undefined;
    return videoResult.files;
  }

  async addAudios(message, attachments) {
    const audioResult = await encodeAndFormatAudios(
      this.options.req,
      attachments,
      {
        provider: this.options.agent?.provider ?? this.options.endpoint,
        endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      },
      getStrategyFunctions,
    );
    message.audios =
      audioResult.audios && audioResult.audios.length ? audioResult.audios : undefined;
    return audioResult.files;
  }

  /**
   * Extracts text context from attachments and sets it on the message.
   * This handles text that was already extracted from files (OCR, transcriptions, document text, etc.)
   * @param {TMessage} message - The message to add context to
   * @param {MongoFile[]} attachments - Array of file attachments
   * @returns {Promise<void>}
   */
  async addFileContextToMessage(message, attachments, fileConsumers) {
    const textAttachments = this.getTextContextAttachments(attachments, fileConsumers);
    const fileContext = await extractFileContext({
      attachments: textAttachments,
      req: this.options?.req,
      tokenCountFn: (text) => countTokens(text),
    });

    if (fileContext) {
      message.fileContext = fileContext;
    }
  }

  getTextContextAttachments(attachments, fileConsumers) {
    return attachments.filter((file) => {
      const deliveryPath = this.getAttachmentDeliveryPath(file, fileConsumers);
      /* Records predating delivery paths keep legacy extraction. Current routing is
       * authoritative for inferred uploads, so native provider bytes are not also
       * injected as extracted text after a provider handoff. */
      return deliveryPath == null || deliveryPath === 'text';
    });
  }

  /** The turn's view of stored records, applied before admission at every load. */
  resolveTurnAttachments(files, fileConsumers = this.options.agent?.fileConsumers) {
    return applyTurnDelivery(files, {
      routing: this.options.agent?.deliveryRouting,
      consumers: fileConsumers,
    });
  }

  getAttachmentDeliveryPath(file, fileConsumers = this.options.agent?.fileConsumers) {
    return resolveTurnLLMDeliveryPath(this.options.agent?.deliveryRouting, file, fileConsumers);
  }

  async processAttachments(message, attachments, fileConsumers) {
    const categorizedAttachments = {
      images: [],
      videos: [],
      audios: [],
      documents: [],
    };

    const allFiles = [];
    const provider = this.options.agent?.provider ?? this.options.endpoint;
    const isBedrock = provider === EModelEndpoint.bedrock;
    const deliveryRouting = this.options.agent?.deliveryRouting;

    /* The stored path records what upload time inferred from the endpoint it saw, and this
     * turn may be running somewhere else: audio stored as `provider` under Google reaches
     * an encoder that emits nothing for OpenAI, delivering neither media nor text. An
     * explicit chooser decision is the user's and survives, and a record predating the
     * field keeps its legacy handling. */
    for (const file of attachments) {
      /** @type {FileSources} */
      const source = file.source ?? FileSources.local;
      if (source === FileSources.text) {
        allFiles.push(file);
        continue;
      }
      const deliveryPath = this.getAttachmentDeliveryPath(file, fileConsumers);
      if (deliveryPath === 'text' || deliveryPath === 'none') {
        allFiles.push(file);
        continue;
      }
      /* An explicit `provider` path is authoritative: lazy provisioning stamps
       * `embedded`/`codeEnvRef` on files that are still meant for the model, so the
       * legacy tool-provisioning exclusion only applies to records without one. */
      if (deliveryPath !== 'provider' && isToolOwnedAttachment(file)) {
        allFiles.push(file);
        continue;
      }

      if (file.type.startsWith('image/')) {
        categorizedAttachments.images.push(file);
      } else if (file.type === 'application/pdf') {
        categorizedAttachments.documents.push(file);
        allFiles.push(file);
      } else if (isBedrock && isBedrockDocumentType(file.type)) {
        categorizedAttachments.documents.push(file);
        allFiles.push(file);
      } else if (file.type.startsWith('video/')) {
        categorizedAttachments.videos.push(file);
        allFiles.push(file);
      } else if (file.type.startsWith('audio/')) {
        categorizedAttachments.audios.push(file);
        allFiles.push(file);
      } else if (
        file.type &&
        deliveryRouting?.endpointConfig.supportedMimeTypes &&
        deliveryRouting.fileConfig.checkType(
          file.type,
          deliveryRouting.endpointConfig.supportedMimeTypes,
        )
      ) {
        categorizedAttachments.documents.push(file);
        allFiles.push(file);
      }
    }

    const [imageFiles] = await Promise.all([
      categorizedAttachments.images.length > 0
        ? this.addImageURLs(message, categorizedAttachments.images)
        : Promise.resolve([]),
      categorizedAttachments.documents.length > 0
        ? this.addDocuments(message, categorizedAttachments.documents)
        : Promise.resolve([]),
      categorizedAttachments.videos.length > 0
        ? this.addVideos(message, categorizedAttachments.videos)
        : Promise.resolve([]),
      categorizedAttachments.audios.length > 0
        ? this.addAudios(message, categorizedAttachments.audios)
        : Promise.resolve([]),
    ]);

    allFiles.push(...imageFiles);

    const seenFileIds = new Set();
    const uniqueFiles = [];

    for (const file of allFiles) {
      if (file.file_id && !seenFileIds.has(file.file_id)) {
        seenFileIds.add(file.file_id);
        uniqueFiles.push(file);
      } else if (!file.file_id) {
        uniqueFiles.push(file);
      }
    }

    return uniqueFiles;
  }

  /**
   * @param {TMessage[]} _messages
   * @returns {Promise<TMessage[]>}
   */
  async addPreviousAttachments(_messages) {
    if (!this.options.resendFiles) {
      return _messages;
    }

    const contextSeen = new Set();
    const attachmentsProcessed =
      this.options.attachments && !(this.options.attachments instanceof Promise);
    if (attachmentsProcessed) {
      for (const attachment of this.options.attachments) {
        if (attachment?.file_id) {
          contextSeen.add(attachment.file_id);
        }
      }
    }

    const historicalFileState = collectModelBoundHistoricalFileIdState(_messages);
    this.modelBoundHistoricalFileIdsOverflowed ||= historicalFileState.overflowed;
    const authorizedFilesById = new Map();
    const files = this.resolveTurnAttachments(
      await getOwnerHistoricalFiles(historicalFileState.fileIds, this.options.req?.user),
    );
    const nonSteerReplayFileIds = collectModelBoundHistoricalFileIdState(
      _messages.map((message) => ({
        files: message.files,
        content: Array.isArray(message.content)
          ? message.content.filter((part) => part?.type !== ContentTypes.STEER)
          : message.content,
      })),
    ).fileIds.filter((fileId) => !contextSeen.has(fileId));
    const steerReplayFileIds = [];
    for (const message of _messages) {
      if (!Array.isArray(message?.content)) {
        continue;
      }
      for (const part of message.content) {
        if (part?.type !== ContentTypes.STEER || !Array.isArray(part.files)) {
          continue;
        }
        for (const file of part.files) {
          if (typeof file?.file_id === 'string' && file.file_id.length > 0) {
            steerReplayFileIds.push(file.file_id);
          }
        }
      }
    }
    for (const file of files) {
      if (file?.file_id) {
        authorizedFilesById.set(file.file_id, file);
      }
    }
    let admittedHistoricalFileIds;
    if (typeof this.assertHistoricalAttachmentLimits === 'function') {
      const admittedHistoricalFiles = await this.assertHistoricalAttachmentLimits(
        [...nonSteerReplayFileIds, ...steerReplayFileIds]
          .map((fileId) => authorizedFilesById.get(fileId))
          .filter((file) => file != null && isModelBoundAttachmentFile(file)),
      );
      admittedHistoricalFileIds = new Set(
        (admittedHistoricalFiles ?? []).map((file) => file?.file_id).filter(Boolean),
      );
    }
    this.modelBoundHistoricalSteerFiles = steerReplayFileIds
      .map((fileId) => authorizedFilesById.get(fileId))
      .filter(
        (file) =>
          file != null &&
          isModelBoundAttachmentFile(file) &&
          (!admittedHistoricalFileIds || admittedHistoricalFileIds.has(file.file_id)),
      );
    /** Owner-scoped docs for THIS turn, including steer-part refs — the steer
     *  replay stamp consumes this instead of issuing a second query. */
    this.authorizedHistoricalFiles = authorizedFilesById;
    this.authorizedHistoricalReplayFiles = new Map(
      files
        .filter(
          (file) =>
            file?.file_id &&
            (!admittedHistoricalFileIds || admittedHistoricalFileIds.has(file.file_id)),
        )
        .map((file) => [file.file_id, file]),
    );

    /**
     *
     * @param {TMessage} message
     */
    const processMessage = async (message) => {
      if (!this.message_file_map) {
        /** @type {Record<string, MongoFile[]> */
        this.message_file_map = {};
      }

      delete message.fileContext;

      const contextFiles = [];
      if (Array.isArray(message.files)) {
        for (const file of message.files) {
          if (!file?.file_id || contextSeen.has(file.file_id)) {
            continue;
          }
          const authorizedFile = authorizedFilesById.get(file.file_id);
          if (
            authorizedFile &&
            (!admittedHistoricalFileIds || admittedHistoricalFileIds.has(file.file_id))
          ) {
            contextFiles.push(authorizedFile);
            contextSeen.add(file.file_id);
          }
        }
      }

      const rehydratedFiles = rehydrateMessageFileRefs(message.files, authorizedFilesById);
      if (rehydratedFiles) {
        message.files = rehydratedFiles;
      } else {
        delete message.files;
      }

      const rehydratedAttachments = rehydrateMessageFileRefs(
        message.attachments,
        authorizedFilesById,
        {
          preserveDisplayOnly: true,
        },
      );
      if (rehydratedAttachments) {
        message.attachments = rehydratedAttachments;
      } else {
        delete message.attachments;
      }

      if (contextFiles.length === 0) {
        return message;
      }

      const [, processedFiles] = await Promise.all([
        this.addFileContextToMessage(message, contextFiles),
        this.processAttachments(message, contextFiles),
      ]);

      const processedFileIds = new Set(
        (processedFiles ?? []).map((file) => file?.file_id).filter(Boolean),
      );
      this.message_file_map[message.messageId] = contextFiles.filter(
        (file) => processedFileIds.has(file?.file_id) && isModelBoundAttachmentFile(file),
      );
      return message;
    };

    const promises = [];

    for (const message of _messages) {
      if (!message.files && !message.attachments) {
        promises.push(message);
        continue;
      }

      promises.push(processMessage(message));
    }

    const messages = await Promise.all(promises);

    this.checkVisionRequest(Object.values(this.message_file_map ?? {}).flat());
    return messages;
  }
}

module.exports = BaseClient;
