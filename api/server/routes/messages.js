const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { logger, CLIENT_MESSAGE_SELECT, MEILI_SEARCH_LIMIT } = require('@librechat/data-schemas');
const {
  ContentTypes,
  feedbackSchema,
  isAssistantsEndpoint,
  stripReasoningLabelMetadata,
} = require('librechat-data-provider');
const {
  unescapeLaTeX,
  countTokens,
  sendFeedbackScore,
  traceIdForMessage,
  mergeQuotedTextForCount,
  requireFeedbackEnabled,
  CHILD_THREAD_READ_ONLY_ERROR,
  isSubagentThreadWriteBlocked,
  createContentFilter,
  extractFeedbackContent,
  extractStoredMessageContent,
  assertStoredMessageMutationAllowed,
  assertChatMutationAllowed,
  assertStoredMessageBranchAllowed,
  reportLocatorTraversalFailure,
  mergeUserSubmittedPaths,
  mergeUserSubmittedMessageFieldPaths,
  isContentFilterError,
  withoutTraceRefs,
} = require('@librechat/api');
const subagentThreadTaskStore = require('~/server/services/Endpoints/agents/subagentThreadStore');
const { findAllArtifacts, replaceArtifactContent } = require('~/server/services/Artifacts/update');
const {
  requireJwtAuth,
  validateMessageReq,
  configMiddleware,
  sendValidationResponse,
  canReadActiveJobConversation,
  prepareMessageRequestValidation,
} = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const filterStoredMessageContent = createContentFilter({
  messageCount: 1,
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  getMessageRoles: (req) => [req.body?.role],
  getOpaqueFileInput: (req) => req.body,
  getFiles: db.getFiles,
  extract: (req) => extractStoredMessageContent(req.body),
});
const filterFeedbackContent = createContentFilter({
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  extract: (req) => extractFeedbackContent(req.body),
});
const messageMutationMiddleware = [validateMessageReq, configMiddleware];
const storedMessageMutationMiddleware = [
  validateMessageReq,
  configMiddleware,
  filterStoredMessageContent,
];

router.use(requireJwtAuth);

async function rejectSubagentThreadWrite(req, res, conversationId) {
  const blocked = await isSubagentThreadWriteBlocked(
    {
      getConvo: async (...args) => {
        const conversation = await db.getConvo(...args);
        req.resolvedConversation = conversation;
        return conversation;
      },
      store: subagentThreadTaskStore,
    },
    {
      userId: req.user.id,
      conversationId,
      ...(typeof req.user.tenantId === 'string' && req.user.tenantId !== ''
        ? { tenantId: req.user.tenantId }
        : {}),
    },
  );
  if (!blocked) {
    return false;
  }
  res.status(409).json({ error: CHILD_THREAD_READ_ONLY_ERROR });
  return true;
}

router.get('/', async (req, res) => {
  try {
    const user = req.user.id ?? '';
    const {
      cursor = null,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
      pageSize: pageSizeRaw,
      conversationId,
      messageId,
      search,
    } = req.query;
    const parsedPageSize = parseInt(pageSizeRaw, 10);
    const pageSize = Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : 25;

    let response;
    const sortField = ['endpoint', 'createdAt', 'updatedAt'].includes(sortBy)
      ? sortBy
      : 'createdAt';
    const sortOrder = sortDirection === 'asc' ? 1 : -1;

    let scopedMessageRead;
    if (typeof conversationId === 'string') {
      const ownershipRead = db.getConvoOwnership(user, conversationId);
      /** Client-facing reads never expose server-private fields such as `contextMeta`. */
      const messageRead = messageId
        ? db.getMessages({ conversationId, messageId, user }, CLIENT_MESSAGE_SELECT)
        : db.getMessagesByCursor(
            { conversationId, user },
            { sortField, sortOrder, limit: pageSize, cursor, select: CLIENT_MESSAGE_SELECT },
          );
      scopedMessageRead = Promise.resolve(messageRead).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );

      const conversation = await ownershipRead;
      const canReadActiveJob =
        conversation == null &&
        !messageId &&
        (await canReadActiveJobConversation(req, conversationId));
      if ((!conversation && !canReadActiveJob) || conversation?.subagentThread != null) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    } else if (conversationId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversationId && messageId) {
      const messageResult = await scopedMessageRead;
      if (!messageResult.ok) {
        throw messageResult.error;
      }
      const messages = messageResult.value;
      response = { messages: messages?.length ? [messages[0]] : [], nextCursor: null };
    } else if (conversationId) {
      const messageResult = await scopedMessageRead;
      if (!messageResult.ok) {
        throw messageResult.error;
      }
      response = messageResult.value;
    } else if (search) {
      const searchResults = await db.searchMessages(
        search,
        {
          filter: `user = "${user}"`,
          limit: Math.min(pageSize, MEILI_SEARCH_LIMIT),
        },
        true,
      );

      const messages = searchResults.hits || [];

      const result = await db.getConvosQueried(req.user.id, messages, cursor, pageSize);

      const messageIds = [];
      const cleanedMessages = [];
      for (let i = 0; i < messages.length; i++) {
        let message = messages[i];
        if (result.convoMap[message.conversationId]) {
          messageIds.push(message.messageId);
          cleanedMessages.push(message);
        }
      }

      const dbMessages = await db.getMessages(
        {
          user,
          messageId: { $in: messageIds },
        },
        CLIENT_MESSAGE_SELECT,
      );

      const dbMessageMap = {};
      for (const dbMessage of dbMessages) {
        dbMessageMap[dbMessage.messageId] = dbMessage;
      }

      const activeMessages = [];
      for (const message of cleanedMessages) {
        const convo = result.convoMap[message.conversationId];
        const dbMessage = dbMessageMap[message.messageId];
        /** Search hydrates every schema field; server-private state never leaves. */
        const publicHit = { ...message };
        delete publicHit.contextMeta;

        activeMessages.push({
          ...publicHit,
          title: convo.title,
          conversationId: message.conversationId,
          model: convo.model,
          isCreatedByUser: dbMessage?.isCreatedByUser,
          endpoint: dbMessage?.endpoint,
          iconURL: dbMessage?.iconURL,
        });
      }

      response = { messages: activeMessages, nextCursor: null };
    } else {
      response = { messages: [], nextCursor: null };
    }

    res.status(200).json(response);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Creates a new branch message from a specific agent's content within a parallel response message.
 * Filters the original message's content to only include parts attributed to the specified agentId.
 * Only available for non-user messages with content attributions.
 *
 * @route POST /branch
 * @param {string} req.body.messageId - The ID of the source message
 * @param {string} req.body.agentId - The agentId to filter content by
 * @returns {TMessage} The newly created branch message
 */
/**
 * Projects a saved row for a client response. The context meta stays in the
 * database for the next turn; no client-facing read or write response carries it.
 * @param {TMessage} message
 * @returns {TMessage}
 */
function toClientMessage(message) {
  const clientMessage = { ...message };
  delete clientMessage.contextMeta;
  return clientMessage;
}

router.post('/branch', configMiddleware, async (req, res) => {
  try {
    const { messageId, agentId } = req.body;
    const userId = req.user.id;

    if (!messageId || !agentId) {
      return res.status(400).json({ error: 'messageId and agentId are required' });
    }

    const sourceMessage = await db.getMessage({ user: userId, messageId });
    if (!sourceMessage) {
      return res.status(404).json({ error: 'Source message not found' });
    }

    if (await rejectSubagentThreadWrite(req, res, sourceMessage.conversationId)) {
      return;
    }

    if (sourceMessage.isCreatedByUser) {
      return res.status(400).json({ error: 'Cannot branch from user messages' });
    }

    if (!Array.isArray(sourceMessage.content)) {
      return res.status(400).json({ error: 'Message does not have content' });
    }

    const hasAgentMetadata = sourceMessage.content.some((part) => part?.agentId);
    if (!hasAgentMetadata) {
      return res
        .status(400)
        .json({ error: 'Message does not have parallel content with attributions' });
    }

    /** @type {Array<import('librechat-data-provider').TMessageContentParts>} */
    const filteredContent = [];
    const sourceUserSubmittedPaths = Array.isArray(sourceMessage.userSubmittedPaths)
      ? sourceMessage.userSubmittedPaths.filter((path) => typeof path === 'string')
      : [];
    const sourceUserSubmittedMessageFieldPaths = Array.isArray(
      sourceMessage.userSubmittedMessageFieldPaths,
    )
      ? sourceMessage.userSubmittedMessageFieldPaths.filter(
          (entry) => entry != null && typeof entry.path === 'string',
        )
      : [];
    const remappedUserSubmittedPaths = sourceUserSubmittedPaths.filter((path) =>
      path.startsWith('/attachments/'),
    );
    const remappedUserSubmittedMessageFieldPaths = [];
    for (let sourceIndex = 0; sourceIndex < sourceMessage.content.length; sourceIndex++) {
      const part = sourceMessage.content[sourceIndex];
      if (part?.agentId === agentId) {
        const targetIndex = filteredContent.length;
        const { agentId: _a, groupId: _g, ...cleanPart } = part;
        filteredContent.push(cleanPart);
        const sourcePrefix = `/content/${sourceIndex}`;
        const targetPrefix = `/content/${targetIndex}`;
        for (const path of sourceUserSubmittedPaths) {
          if (path === sourcePrefix || path.startsWith(`${sourcePrefix}/`)) {
            remappedUserSubmittedPaths.push(`${targetPrefix}${path.slice(sourcePrefix.length)}`);
          }
        }
        for (const entry of sourceUserSubmittedMessageFieldPaths) {
          if (entry.path === sourcePrefix || entry.path.startsWith(`${sourcePrefix}/`)) {
            remappedUserSubmittedMessageFieldPaths.push({
              ...entry,
              path: `${targetPrefix}${entry.path.slice(sourcePrefix.length)}`,
            });
          }
        }
      }
    }

    if (filteredContent.length === 0) {
      return res.status(400).json({ error: 'No content found for the specified agentId' });
    }

    const newMessageId = uuidv4();
    /** @type {import('librechat-data-provider').TMessage} */
    const newMessage = {
      messageId: newMessageId,
      conversationId: sourceMessage.conversationId,
      parentMessageId: sourceMessage.parentMessageId,
      attachments: sourceMessage.attachments,
      isCreatedByUser: false,
      model: sourceMessage.model,
      endpoint: sourceMessage.endpoint,
      sender: sourceMessage.sender,
      iconURL: sourceMessage.iconURL,
      // Server-private context meta (calibration and fading tier) travels with the branch so
      // the next turn seeds its pruner the same way it would from the source response.
      ...(sourceMessage.contextMeta != null && { contextMeta: sourceMessage.contextMeta }),
      ...(typeof sourceMessage.isUserSubmitted === 'boolean' && {
        isUserSubmitted: sourceMessage.isUserSubmitted,
      }),
      ...(remappedUserSubmittedPaths.length > 0 && {
        userSubmittedPaths: mergeUserSubmittedPaths(remappedUserSubmittedPaths),
      }),
      ...(remappedUserSubmittedMessageFieldPaths.length > 0 && {
        userSubmittedMessageFieldPaths: mergeUserSubmittedMessageFieldPaths(
          remappedUserSubmittedMessageFieldPaths,
        ),
      }),
      content: filteredContent,
      unfinished: false,
      error: false,
      user: userId,
    };

    await assertStoredMessageBranchAllowed(
      {
        filters: req.config?.filters,
        legacyPii: req.config?.messageFilter?.pii,
        message: newMessage,
        user: req.user,
      },
      { getFiles: db.getFiles, onTraversalFailure: reportLocatorTraversalFailure },
    );

    const savedMessage = await db.saveMessage(
      {
        userId: req?.user?.id,
        isTemporary: sourceMessage.isTemporary,
        expiredAt: sourceMessage.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      newMessage,
      { context: 'POST /api/messages/branch' },
    );

    if (!savedMessage) {
      return res.status(500).json({ error: 'Failed to save branch message' });
    }

    res.status(201).json(toClientMessage(savedMessage));
  } catch (error) {
    if (isContentFilterError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    logger.error('Error creating branch message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/artifact/:messageId', configMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { index, original, updated } = req.body;

    if (typeof index !== 'number' || index < 0 || original == null || updated == null) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    }

    assertStoredMessageMutationAllowed(req.config?.filters, { original, updated });

    const message = await db.getMessage({ user: req.user.id, messageId });
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (await rejectSubagentThreadWrite(req, res, message.conversationId)) {
      return;
    }

    const artifacts = findAllArtifacts(message);
    if (index >= artifacts.length) {
      return res.status(400).json({ error: 'Artifact index out of bounds' });
    }

    // Unescape LaTeX preprocessing done by the frontend
    // The frontend escapes $ signs for display, but the database has unescaped versions
    const unescapedOriginal = unescapeLaTeX(original);
    const unescapedUpdated = unescapeLaTeX(updated);

    const targetArtifact = artifacts[index];
    let updatedText = null;

    if (targetArtifact.source === 'content') {
      const part = message.content[targetArtifact.partIndex];
      updatedText = replaceArtifactContent(
        part.text,
        targetArtifact,
        unescapedOriginal,
        unescapedUpdated,
      );
      if (updatedText) {
        part.text = updatedText;
      }
    } else {
      updatedText = replaceArtifactContent(
        message.text,
        targetArtifact,
        unescapedOriginal,
        unescapedUpdated,
      );
      if (updatedText) {
        message.text = updatedText;
      }
    }

    if (!updatedText) {
      return res.status(400).json({ error: 'Original content not found in target artifact' });
    }

    const filteredArtifact =
      targetArtifact.source === 'content'
        ? { content: [{ text: updatedText }] }
        : { text: updatedText };
    assertStoredMessageMutationAllowed(req.config?.filters, filteredArtifact);

    const savedMessage = await db.saveMessage(
      {
        userId: req?.user?.id,
        isTemporary: message.isTemporary,
        expiredAt: message.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      {
        messageId,
        conversationId: message.conversationId,
        text: message.text,
        content: message.content,
        userSubmittedPaths: mergeUserSubmittedPaths(
          message.userSubmittedPaths,
          targetArtifact.source === 'content'
            ? `/content/${targetArtifact.partIndex}/text`
            : '/text',
        ),
        user: req.user.id,
      },
      { context: 'POST /api/messages/artifact/:messageId' },
    );

    res.status(200).json({
      conversationId: savedMessage.conversationId,
      content: savedMessage.content,
      text: savedMessage.text,
    });
  } catch (error) {
    if (isContentFilterError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    logger.error('Error editing artifact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:conversationId', prepareMessageRequestValidation, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const validation = req.messageRequestValidation;
    // This intentionally starts a user-scoped read before validation resolves;
    // the response remains gated on validation success below.
    const messagesPromise = validation.shouldFetchMessages
      ? db.getMessages({ conversationId, user: req.user.id }, CLIENT_MESSAGE_SELECT).then(
          (messages) => ({ messages }),
          (error) => ({ error }),
        )
      : null;

    const validationResult = await validation.promise;
    if (!validationResult.ok) {
      return sendValidationResponse(res, validationResult);
    }

    const messagesResult = await messagesPromise;
    if (messagesResult?.error) {
      throw messagesResult.error;
    }

    const messages = messagesResult?.messages ?? [];
    res.status(200).json(messages);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:conversationId', storedMessageMutationMiddleware, async (req, res) => {
  try {
    if (await rejectSubagentThreadWrite(req, res, req.params.conversationId)) {
      return;
    }
    /** Trace sampling fields are ownership claims only the server writes. */
    const message = withoutTraceRefs({ ...req.body, conversationId: req.params.conversationId });
    delete message.isUserSubmitted;
    delete message.userSubmittedPaths;
    delete message.userSubmittedMessageFieldPaths;
    /** Server-private run state: a client-authored row must never seed a run's
     * calibration or fading tiers, so the field only ever comes from the server. */
    delete message.contextMeta;
    const reqCtx = {
      userId: req?.user?.id,
      isTemporary: req.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
      expiredAt: req.resolvedConversation?.expiredAt,
      interfaceConfig: req?.config?.interfaceConfig,
    };
    const savedMessage = await db.saveMessage(
      reqCtx,
      { ...message, user: req.user.id, isUserSubmitted: true },
      { context: 'POST /api/messages/:conversationId' },
    );
    if (!savedMessage) {
      return res.status(400).json({ error: 'Message not saved' });
    }
    const conversationUpdate = {
      conversationId: savedMessage.conversationId,
      ...(message.endpoint !== undefined && { endpoint: savedMessage.endpoint }),
      ...(message.model !== undefined && { model: savedMessage.model }),
      ...(message.iconURL !== undefined && { iconURL: savedMessage.iconURL }),
    };
    await db.saveConvo(reqCtx, conversationUpdate, {
      context: 'POST /api/messages/:conversationId',
      ...(savedMessage._id != null ? { appendMessageIds: [savedMessage._id] } : {}),
    });
    res.status(201).json(toClientMessage(savedMessage));
  } catch (error) {
    logger.error('Error saving message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:conversationId/:messageId', validateMessageReq, async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    const message = await db.getMessages(
      { conversationId, messageId, user: req.user.id },
      CLIENT_MESSAGE_SELECT,
    );
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.status(200).json(message);
  } catch (error) {
    logger.error('Error fetching message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:conversationId/:messageId', messageMutationMiddleware, async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    const message = (
      await db.getMessages(
        { messageId, user: req.user.id },
        'conversationId content tokenCount quotes isCreatedByUser userSubmittedPaths',
      )
    )?.[0];
    if (!message || message.conversationId !== conversationId) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (await rejectSubagentThreadWrite(req, res, message.conversationId)) {
      return;
    }
    const { text, index, model } = req.body;

    if (index !== undefined && (typeof index !== 'number' || index < 0)) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    if (index === undefined) {
      assertStoredMessageMutationAllowed(req.config?.filters, { text });

      /** A user turn's persisted `quotes` are re-prepended into the prompt on
       *  every send, but this edit only changes `text`. Count the merged
       *  text+quotes so the stored `tokenCount` stays authoritative (matching the
       *  send path); a plain text-only count under-reports by the quote block. */
      const textToCount = mergeQuotedTextForCount(
        text,
        message.quotes,
        message.isCreatedByUser === true,
      );
      assertChatMutationAllowed(req.config?.filters, {
        text,
        quotes: message.isCreatedByUser === true ? message.quotes : undefined,
      });
      const tokenCount = await countTokens(textToCount, model);
      const result = await db.updateMessage(req?.user?.id, {
        messageId,
        text,
        tokenCount,
        userSubmittedPaths: mergeUserSubmittedPaths(message.userSubmittedPaths, '/text'),
      });
      return res.status(200).json(result);
    }

    const existingContent = message.content;
    if (!Array.isArray(existingContent) || index >= existingContent.length) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const updatedContent = [...existingContent];
    if (!updatedContent[index]) {
      return res.status(400).json({ error: 'Content part not found' });
    }

    const currentPartType = updatedContent[index].type;
    if (currentPartType !== ContentTypes.TEXT && currentPartType !== ContentTypes.THINK) {
      return res.status(400).json({ error: 'Cannot update non-text content' });
    }

    assertStoredMessageMutationAllowed(req.config?.filters, {
      content: [{ [currentPartType]: text }],
    });

    /** A text part is `string | { value, annotations }`. The Assistants thread sync
     *  persists the structured form with its file citations intact, and the editor
     *  reads it through the same union, so an edit has to be written into `value`
     *  rather than over the whole part. The same object is what gets counted below,
     *  and the tokenizer measures `length`, which an object does not have. */
    const currentPart = updatedContent[index];
    const currentValue = currentPart[currentPartType];
    const isStructuredValue = currentValue != null && typeof currentValue === 'object';
    const oldText = isStructuredValue ? (currentValue.value ?? '') : currentValue;
    const editedPart = {
      ...currentPart,
      [currentPartType]: isStructuredValue ? { ...currentValue, value: text } : text,
    };
    updatedContent[index] =
      currentPartType === ContentTypes.THINK ? stripReasoningLabelMetadata(editedPart) : editedPart;
    assertStoredMessageMutationAllowed(req.config?.filters, {
      content: [updatedContent[index]],
    });

    let tokenCount = message.tokenCount;
    if (tokenCount !== undefined) {
      const oldTokenCount = await countTokens(oldText, model);
      const newTokenCount = await countTokens(text, model);
      tokenCount = Math.max(0, tokenCount - oldTokenCount) + newTokenCount;
    }

    const result = await db.updateMessage(req?.user?.id, {
      messageId,
      content: updatedContent,
      tokenCount,
      userSubmittedPaths: mergeUserSubmittedPaths(
        message.userSubmittedPaths,
        `/content/${index}/${currentPartType}`,
      ),
    });
    return res.status(200).json(result);
  } catch (error) {
    if (isContentFilterError(error)) {
      return res.status(error.statusCode).json(error.body);
    }
    logger.error('Error updating message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put(
  '/:conversationId/:messageId/feedback',
  validateMessageReq,
  configMiddleware,
  requireFeedbackEnabled,
  filterFeedbackContent,
  async (req, res) => {
    try {
      const { conversationId, messageId } = req.params;
      const { feedback } = req.body;
      const feedbackResult = feedback == null ? null : feedbackSchema.safeParse(feedback);

      if (feedbackResult && !feedbackResult.success) {
        return res.status(400).json({ error: 'Invalid feedback' });
      }

      const updatedMessage = await db.updateMessage(
        req?.user?.id,
        {
          messageId,
          feedback: feedbackResult?.data ?? null,
        },
        { context: 'updateFeedback' },
      );

      // Best-effort: Assistants messages do not have deterministic AgentRun traces.
      if (!isAssistantsEndpoint(updatedMessage.endpoint)) {
        sendFeedbackScore({
          traceId: traceIdForMessage(updatedMessage.langfuseRunId ?? messageId),
          sampled: updatedMessage.langfuseSampled,
          destinationIds: updatedMessage.langfuseDestinationIds,
          feedback: updatedMessage.feedback,
          appConfig: req.config,
          metadata: {
            messageId: updatedMessage.messageId ?? messageId,
            parentMessageId: updatedMessage.parentMessageId,
            conversationId: updatedMessage.conversationId ?? conversationId,
            sessionId: updatedMessage.conversationId ?? conversationId,
            userId: req?.user?.id,
            tenantId: req?.user?.tenantId,
            endpoint: updatedMessage.endpoint,
            sender: updatedMessage.sender,
            isCreatedByUser: updatedMessage.isCreatedByUser,
            tokenCount: updatedMessage.tokenCount,
          },
        }).catch((err) => logger.error('[langfuse] feedback score failed:', err));
      }

      res.json({
        messageId,
        conversationId,
        feedback: updatedMessage.feedback,
      });
    } catch (error) {
      logger.error('Error updating message feedback:', error);
      res.status(500).json({ error: 'Failed to update feedback' });
    }
  },
);

router.delete('/:conversationId/:messageId', validateMessageReq, async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    if (await rejectSubagentThreadWrite(req, res, conversationId)) {
      return;
    }
    await db.deleteMessages({ messageId, conversationId, user: req.user.id });
    res.status(204).send();
  } catch (error) {
    logger.error('Error deleting message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
