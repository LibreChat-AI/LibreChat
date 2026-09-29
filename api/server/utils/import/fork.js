const { v4: uuidv4 } = require('uuid');
const { cloneLineage, withoutTraceRefs, getAllMessagesUpToParent } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { EModelEndpoint, Constants, ForkOptions } = require('librechat-data-provider');
const { getConvo, getMessages, getSharedMessages } = require('~/models');
const { createImportBatchBuilder } = require('./importBatchBuilder');
const { getAppConfig } = require('~/server/services/Config');
const { resolveImportDefaultEndpoint } = require('./defaults');
const BaseClient = require('~/app/clients/BaseClient');

/**
 * Helper function to clone messages with proper parent-child relationships and timestamps
 * @param {TMessage[]} messagesToClone - Original messages to clone
 * @param {ImportBatchBuilder} importBatchBuilder - Instance of ImportBatchBuilder
 * @param {object} [options] - Clone behavior for the source conversation.
 * @param {boolean} [options.detachSubagentRuntime=false] - Remove durable child execution metadata.
 * @returns {Map<string, string>} Map of original messageIds to new messageIds
 */
function cloneMessagesWithTimestamps(
  messagesToClone,
  importBatchBuilder,
  { detachSubagentRuntime = false } = {},
) {
  const { entries, idMapping } = cloneLineage(messagesToClone, uuidv4);
  for (const { source, messageId, parentMessageId, createdAt } of entries) {
    const clonedMessage = {
      ...withoutTraceRefs(source),
      messageId,
      parentMessageId,
      createdAt,
    };
    if (detachSubagentRuntime) {
      delete clonedMessage.subagentTask;
      delete clonedMessage.subagentTranscript;
    }

    importBatchBuilder.saveMessage(clonedMessage);
  }

  return idMapping;
}

/**
 *
 * @param {object} params - The parameters for the importer.
 * @param {string} params.originalConvoId - The ID of the conversation to fork.
 * @param {string} params.targetMessageId - The ID of the message to fork from.
 * @param {string} params.requestUserId - The ID of the user making the request.
 * @param {string} [params.newTitle] - Optional new title for the forked conversation uses old title if not provided
 * @param {string} [params.option=''] - Optional flag for fork option
 * @param {boolean} [params.records=false] - Optional flag for returning actual database records or resulting conversation and messages.
 * @param {boolean} [params.splitAtTarget=false] - Optional flag for splitting the messages at the target message level.
 * @param {string} [params.latestMessageId] - latestMessageId - Required if splitAtTarget is true.
 * @param {object} [params.filters] - Source-aware content filters applied before cloned records are persisted.
 * @param {object} [params.legacyPii] - Legacy messageFilter.pii applied before cloned records are persisted.
 * @param {(userId: string, interfaceConfig?: object, filters?: object, legacyPii?: object) => ImportBatchBuilder} [params.builderFactory] - Optional factory function for creating an ImportBatchBuilder instance.
 * @returns {Promise<TForkConvoResponse>} The response after forking the conversation.
 */
async function forkConversation({
  originalConvoId,
  targetMessageId: targetId,
  requestUserId,
  newTitle,
  option = ForkOptions.TARGET_LEVEL,
  records = false,
  splitAtTarget = false,
  latestMessageId,
  filters,
  legacyPii,
  builderFactory = createImportBatchBuilder,
}) {
  try {
    const originalConvo = await getConvo(requestUserId, originalConvoId);
    let originalMessages = await getMessages({
      user: requestUserId,
      conversationId: originalConvoId,
    });

    let targetMessageId = targetId;
    if (splitAtTarget && !latestMessageId) {
      throw new Error('Latest `messageId` is required for forking from target message.');
    } else if (splitAtTarget) {
      originalMessages = splitAtTargetLevel(originalMessages, targetId);
      targetMessageId = latestMessageId;
    }

    const importBatchBuilder =
      legacyPii == null
        ? builderFactory(requestUserId, undefined, filters)
        : builderFactory(requestUserId, undefined, filters, legacyPii);
    importBatchBuilder.startConversation(originalConvo.endpoint ?? EModelEndpoint.openAI);

    let messagesToClone = [];

    if (option === ForkOptions.DIRECT_PATH) {
      // Direct path only
      messagesToClone = BaseClient.getMessagesForConversation({
        messages: originalMessages,
        parentMessageId: targetMessageId,
      });
    } else if (option === ForkOptions.INCLUDE_BRANCHES) {
      // Direct path and siblings
      messagesToClone = getAllMessagesUpToParent(originalMessages, targetMessageId);
    } else if (option === ForkOptions.TARGET_LEVEL || !option) {
      // Direct path, siblings, and all descendants
      messagesToClone = getMessagesUpToTargetLevel(originalMessages, targetMessageId);
    }

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder, {
      /** A human continuation is an ordinary conversation snapshot, not another
       * durable child executor. Preserve visible history while dropping the
       * task protocol and private serialized model transcript. */
      detachSubagentRuntime: originalConvo.subagentThread != null,
    });

    const result = importBatchBuilder.finishConversation(
      newTitle || originalConvo.title,
      new Date(),
      originalConvo,
    );
    await importBatchBuilder.saveBatch();
    logger.debug(
      `user: ${requestUserId} | New conversation "${
        newTitle || originalConvo.title
      }" forked from conversation ID ${originalConvoId}`,
    );

    if (!records) {
      return result;
    }

    const conversation = await getConvo(requestUserId, result.conversation.conversationId);
    const messages = await getMessages({
      user: requestUserId,
      conversationId: conversation.conversationId,
    });

    return {
      conversation,
      messages,
    };
  } catch (error) {
    logger.error(
      `user: ${requestUserId} | Error forking conversation from original ID ${originalConvoId}`,
      error,
    );
    throw error;
  }
}

/**
 * Retrieves all messages up to the root from the target message and its neighbors.
 * @param {TMessage[]} messages - The list of messages to search.
 * @param {string} targetMessageId - The ID of the target message.
 * @returns {TMessage[]} The list of inclusive messages up to the root from the target message.
 */
function getMessagesUpToTargetLevel(messages, targetMessageId) {
  if (messages.length === 1 && messages[0] && messages[0].messageId === targetMessageId) {
    return messages;
  }

  // Create a map of parentMessageId to children messages
  const parentToChildrenMap = new Map();
  for (const message of messages) {
    if (!parentToChildrenMap.has(message.parentMessageId)) {
      parentToChildrenMap.set(message.parentMessageId, []);
    }
    parentToChildrenMap.get(message.parentMessageId).push(message);
  }

  // Retrieve the target message
  const targetMessage = messages.find((msg) => msg.messageId === targetMessageId);
  if (!targetMessage) {
    logger.error('Target message not found.');
    return [];
  }

  const visited = new Set();

  const rootMessages = parentToChildrenMap.get(Constants.NO_PARENT) || [];
  let currentLevel = rootMessages.length > 0 ? [...rootMessages] : [targetMessage];
  const results = new Set(currentLevel);

  // Check if the target message is at the root level
  if (
    currentLevel.some((msg) => msg.messageId === targetMessageId) &&
    targetMessage.parentMessageId === Constants.NO_PARENT
  ) {
    return Array.from(results);
  }

  // Iterate level by level until the target is found
  let targetFound = false;
  while (!targetFound && currentLevel.length > 0) {
    const nextLevel = [];
    for (const node of currentLevel) {
      if (visited.has(node.messageId)) {
        logger.warn('Cycle detected in message tree');
        continue;
      }
      visited.add(node.messageId);
      const children = parentToChildrenMap.get(node.messageId) || [];
      for (const child of children) {
        if (visited.has(child.messageId)) {
          logger.warn('Cycle detected in message tree');
          continue;
        }
        nextLevel.push(child);
        results.add(child);
        if (child.messageId === targetMessageId) {
          targetFound = true;
        }
      }
    }
    currentLevel = nextLevel;
  }

  return Array.from(results);
}

/**
 * Splits the conversation at the targeted message level, including the target, its siblings, and all descendant messages.
 * All target level messages have their parentMessageId set to the root.
 * @param {TMessage[]} messages - The list of messages to analyze.
 * @param {string} targetMessageId - The ID of the message to start the split from.
 * @returns {TMessage[]} The list of messages at and below the target level.
 */
function splitAtTargetLevel(messages, targetMessageId) {
  // Create a map of parentMessageId to children messages
  const parentToChildrenMap = new Map();
  for (const message of messages) {
    if (!parentToChildrenMap.has(message.parentMessageId)) {
      parentToChildrenMap.set(message.parentMessageId, []);
    }
    parentToChildrenMap.get(message.parentMessageId).push(message);
  }

  // Retrieve the target message
  const targetMessage = messages.find((msg) => msg.messageId === targetMessageId);
  if (!targetMessage) {
    logger.error('Target message not found.');
    return [];
  }

  // Initialize the search with root messages
  const rootMessages = parentToChildrenMap.get(Constants.NO_PARENT) || [];
  let currentLevel = [...rootMessages];
  let currentLevelIndex = 0;
  const levelMap = {};

  // Map messages to their levels
  rootMessages.forEach((msg) => {
    levelMap[msg.messageId] = 0;
  });

  // Search for the target level
  while (currentLevel.length > 0) {
    const nextLevel = [];
    for (const node of currentLevel) {
      const children = parentToChildrenMap.get(node.messageId) || [];
      for (const child of children) {
        nextLevel.push(child);
        levelMap[child.messageId] = currentLevelIndex + 1;
      }
    }
    currentLevel = nextLevel;
    currentLevelIndex++;
  }

  // Determine the target level
  const targetLevel = levelMap[targetMessageId];
  if (targetLevel === undefined) {
    logger.error('Target level not found.');
    return [];
  }

  // Filter messages at or below the target level
  const filteredMessages = messages
    .map((msg) => {
      const messageLevel = levelMap[msg.messageId];
      if (messageLevel < targetLevel) {
        return null;
      } else if (messageLevel === targetLevel) {
        return {
          ...msg,
          parentMessageId: Constants.NO_PARENT,
        };
      }

      return msg;
    })
    .filter((msg) => msg !== null);

  return filteredMessages;
}

/**
 * Strips file identifiers from a shared message's `files` and `attachments`.
 * A shared fork is owned by the requesting user, but the underlying file records
 * still belong to the original sharer. Persisting their `file_id`s would let the
 * agents file-resend path collect them on the next turn and call `getUserCodeFiles`,
 * which looks them up by `file_id` with no ownership filter, rehydrating the
 * sharer's files into the viewer's run. Dropping the ids keeps a fork's file
 * access no broader than viewing the read-only share, while leaving render-only
 * metadata (e.g. `filepath`, `toolCallId`) intact.
 * @param {TMessage} message - The shared message to sanitize.
 * @returns {TMessage} The message with file identifiers removed.
 */
function stripSharedFileIds(message) {
  const sanitized = { ...message };
  if (Array.isArray(sanitized.files)) {
    sanitized.files = sanitized.files.map(({ file_id: _fileId, ...file }) => file);
  }
  if (Array.isArray(sanitized.attachments)) {
    sanitized.attachments = sanitized.attachments.map(
      ({ file_id: _fileId, ...attachment }) => attachment,
    );
  }
  return sanitized;
}

/** Compares a client-held share revision against the stored one, tolerating the
 * Date/ISO-string round trip through JSON. */
function isSameRevision(storedUpdatedAt, clientRevision) {
  const stored = new Date(storedUpdatedAt ?? 0).getTime();
  const client = new Date(clientRevision).getTime();
  return Number.isFinite(stored) && Number.isFinite(client) && stored === client;
}

/**
 * Forks a shared (sanitized) conversation into a fresh conversation owned by the requesting user.
 * Only the anonymized, allowlisted message fields returned by `getSharedMessages` are cloned,
 * so no private data from the original owner can leak into the new conversation.
 * @param {object} params - The parameters for forking the shared conversation.
 * @param {string} params.shareId - The ID of the shared link to fork from.
 * @param {string} [params.shareResourceId] - The SharedLink resource ID set by `canAccessSharedLink`.
 * @param {string} params.requestUserId - The ID of the user making the request.
 * @param {string} [params.userRole] - The role of the requesting user, used to resolve the default model.
 * @param {string} [params.userTenantId] - Tenant of the requesting user. `canAccessSharedLink` runs this handler under the share owner's tenant so the share resolves, so the copy must be persisted (and its config/retention resolved) under the requesting user's tenant or it would be invisible (404) when they open it normally.
 * @param {number} [params.targetMessageIndex] - Index, within the shared payload, of the message at the tip of the branch the viewer has active. When set, only the direct path to that message is cloned so the fork continues the branch that was actually shown rather than the newest sibling. An index is used (not id or `createdAt`) because shared ids are re-anonymized per request while `getSharedMessages` returns a deterministic, stable order, so the same index resolves to the same message on the server.
 * @param {string} [params.shareRevision] - `updatedAt` of the payload the viewer is forking from. A shareId now survives an update, so an owner republishing between the GET and the fork would silently shift `targetMessageIndex` onto a different branch; a mismatch is rejected instead of cloning content the viewer never saw.
 * @param {boolean} [params.snapshotFiles] - When `false`, file/attachment metadata is omitted from the cloned messages, mirroring the GET share route so the global shared-file kill switch is honored.
 * @param {(snapshot: object) => Promise<void>} [params.sharedContentPreflight] - Reapplies current policy to the exact public projection before a legacy shared-file snapshot is persisted.
 * @param {(userId: string, interfaceConfig?: object, filters?: object, legacyPii?: object) => ImportBatchBuilder} [params.builderFactory] - Optional factory function for creating an ImportBatchBuilder instance.
 * @param {(options: object) => Promise<object>} [params.loadAppConfig] - Resolves the app config; injectable for tests. Called inside the requesting user's tenant context so retention policy is read from the viewer's tenant, not the share owner's.
 * @returns {Promise<TForkConvoResponse | null>} The new conversation and messages, or null when the share is missing or empty.
 */
async function forkSharedConversation({
  shareId,
  shareResourceId,
  requestUserId,
  userRole,
  userTenantId,
  targetMessageIndex,
  shareRevision,
  snapshotFiles,
  sharedContentPreflight,
  builderFactory = createImportBatchBuilder,
  loadAppConfig = getAppConfig,
}) {
  // Mirror the GET share route: when the shared-file snapshot is globally
  // disabled, omit file/attachment metadata so a fork can't persist filenames
  // or share file URLs into the new conversation while file serving is off.
  const share = await getSharedMessages(shareId, shareResourceId, {
    snapshotFiles,
    preflight: sharedContentPreflight,
  });
  if (!share?.messages?.length) {
    return null;
  }

  // The index below is positional against the payload the viewer holds, and the
  // shareId no longer rotates on update, so a republish between the GET and this
  // request would resolve it against different messages. Reject rather than fork
  // a branch the viewer never saw.
  if (shareRevision != null && !isSameRevision(share.updatedAt, shareRevision)) {
    const error = new Error('Shared link was updated');
    error.code = 'SHARE_REVISION_MISMATCH';
    throw error;
  }

  /**
   * The shared payload includes sibling branches. Reduce to the direct path of
   * the viewer's active message so the fork continues exactly the branch that
   * was shown; without this the default branch selection lands on the newest
   * sibling. The active tip is located by its index in the shared payload, which
   * `getSharedMessages` returns in a deterministic order (stored ref-array order),
   * unlike ids (re-anonymized per request) or `createdAt` (can collide). Falls
   * back to the full set when the index is absent or out of range.
   */
  let sourceMessages = share.messages;
  if (
    // A positional target only means something against the payload the caller read;
    // with no revision proving which one that was, fall back to the whole share
    // rather than resolving the index against a snapshot they never saw.
    shareRevision != null &&
    Number.isInteger(targetMessageIndex) &&
    targetMessageIndex >= 0 &&
    targetMessageIndex < share.messages.length
  ) {
    const targetMessage = share.messages[targetMessageIndex];
    const directPath = BaseClient.getMessagesForConversation({
      messages: share.messages,
      parentMessageId: targetMessage.messageId,
    });
    if (directPath.length > 0) {
      sourceMessages = directPath;
    }
  }

  const messageIds = new Set(sourceMessages.map((message) => message.messageId));
  const messagesToClone = sourceMessages.map(({ model: _model, ...message }) =>
    stripSharedFileIds({
      ...message,
      parentMessageId:
        message.parentMessageId != null && messageIds.has(message.parentMessageId)
          ? message.parentMessageId
          : Constants.NO_PARENT,
    }),
  );

  /**
   * Persist and read back under the requesting user's tenant rather than the
   * share owner's. The read above runs in the share owner's tenant (set by
   * `canAccessSharedLink`); writing the copy there would leave it invisible to
   * the user under their normal tenant context (the new conversation would 404
   * when they navigate to it). Switching to the user's tenant only affects this
   * deployment when tenant isolation is enabled; otherwise it is a no-op.
   */
  return tenantStorage.run({ tenantId: userTenantId, userId: requestUserId }, async () => {
    // Resolve config inside the viewer's tenant so retention (e.g. all-data
    // expiry) reflects the requesting user's tenant, not the share owner's.
    const appConfig = await loadAppConfig({
      role: userRole,
      userId: requestUserId,
      tenantId: userTenantId,
    });
    // The shared payload strips the original endpoint, so resolve one the viewer
    // can actually use; hard-coding OpenAI breaks the first follow-up message on
    // deployments that don't expose it.
    const { endpoint, model } = await resolveImportDefaultEndpoint({ requestUserId, userRole });
    const importBatchBuilder =
      appConfig?.messageFilter?.pii == null
        ? builderFactory(requestUserId, appConfig?.interfaceConfig, appConfig?.filters)
        : builderFactory(
            requestUserId,
            appConfig?.interfaceConfig,
            appConfig?.filters,
            appConfig.messageFilter.pii,
          );
    importBatchBuilder.startConversation(endpoint);

    cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

    const result = importBatchBuilder.finishConversation(share.title, new Date(), {}, model);
    await importBatchBuilder.saveBatch();
    logger.debug('Shared conversation forked', {
      userId: requestUserId,
      shareId,
      conversationId: result.conversation.conversationId,
    });

    const conversation = await getConvo(requestUserId, result.conversation.conversationId);
    const messages = await getMessages({
      user: requestUserId,
      conversationId: conversation.conversationId,
    });

    return {
      conversation,
      messages,
    };
  });
}

/**
 * Duplicates a conversation and all its messages.
 * @param {object} params - The parameters for duplicating the conversation.
 * @param {string} params.userId - The ID of the user duplicating the conversation.
 * @param {string} params.conversationId - The ID of the conversation to duplicate.
 * @param {string} [params.title] - Optional title override for the duplicate.
 * @param {object} [params.filters] - Source-aware content filters applied before cloned records are persisted.
 * @param {object} [params.legacyPii] - Legacy messageFilter.pii applied before cloned records are persisted.
 * @param {(userId: string, interfaceConfig?: object, filters?: object, legacyPii?: object) => ImportBatchBuilder} [params.builderFactory] - Optional factory function for creating an ImportBatchBuilder instance.
 * @returns {Promise<{ conversation: TConversation, messages: TMessage[] }>} The duplicated conversation and messages.
 */
async function duplicateConversation({
  userId,
  conversationId,
  title,
  filters,
  legacyPii,
  builderFactory = createImportBatchBuilder,
}) {
  const originalConvo = await getConvo(userId, conversationId);
  if (!originalConvo) {
    throw new Error('Conversation not found');
  }

  const originalMessages = await getMessages({
    user: userId,
    conversationId,
  });

  const messagesToClone = getMessagesUpToTargetLevel(
    originalMessages,
    originalMessages[originalMessages.length - 1].messageId,
  );

  const importBatchBuilder =
    legacyPii == null
      ? builderFactory(userId, undefined, filters)
      : builderFactory(userId, undefined, filters, legacyPii);
  importBatchBuilder.startConversation(originalConvo.endpoint ?? EModelEndpoint.openAI);

  cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

  const duplicateTitle = title || originalConvo.title;
  const result = importBatchBuilder.finishConversation(duplicateTitle, new Date(), originalConvo);
  await importBatchBuilder.saveBatch();
  logger.debug('Conversation duplicated', {
    userId,
    sourceConversationId: conversationId,
    conversationId: result.conversation.conversationId,
    hasTitleOverride: typeof title === 'string' && title.length > 0,
  });

  const conversation = await getConvo(userId, result.conversation.conversationId);
  const messages = await getMessages({
    user: userId,
    conversationId: conversation.conversationId,
  });

  return {
    conversation,
    messages,
  };
}

module.exports = {
  forkConversation,
  splitAtTargetLevel,
  duplicateConversation,
  forkSharedConversation,
  getAllMessagesUpToParent,
  getMessagesUpToTargetLevel,
  cloneMessagesWithTimestamps,
};
