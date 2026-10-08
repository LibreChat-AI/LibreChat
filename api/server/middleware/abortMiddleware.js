const { logger } = require('@librechat/data-schemas');
const { isAssistantsEndpoint, ErrorTypes } = require('librechat-data-provider');
const {
  isEnabled,
  sendEvent,
  countTokens,
  isAbortError,
  GenerationJobManager,
  sanitizeMessageForTransmit,
  buildAbortedResponseMetadata,
  announceReply,
} = require('@librechat/api');
const { truncateText, smartTruncateText } = require('~/app/clients/prompts');
const clearPendingReq = require('~/cache/clearPendingReq');
const { sendError } = require('~/server/middleware/error');
const { abortRun } = require('./abortRun');
const db = require('~/models');

/**
 * Abort an active message generation.
 * Uses GenerationJobManager for all agent requests.
 * Since streamId === conversationId, we can directly abort by conversationId.
 */
async function abortMessage(req, res) {
  const { abortKey, endpoint } = req.body;

  if (isAssistantsEndpoint(endpoint)) {
    return await abortRun(req, res);
  }

  const conversationId = abortKey?.split(':')?.[0] ?? req.user.id;
  const userId = req.user.id;

  // Use GenerationJobManager to abort the job (streamId === conversationId)
  const abortResult = await GenerationJobManager.abortJob(conversationId);

  if (!abortResult.success) {
    if (!res.headersSent) {
      return res.status(204).send({ message: 'Request not found' });
    }
    return;
  }

  const { jobData, content, text } = abortResult;

  const completionTokens = await countTokens(text);

  const responseMessage = {
    messageId: jobData?.responseMessageId,
    parentMessageId: jobData?.userMessage?.messageId,
    conversationId: jobData?.conversationId,
    content,
    text,
    sender: jobData?.sender ?? 'AI',
    finish_reason: 'incomplete',
    endpoint: jobData?.endpoint,
    iconURL: jobData?.iconURL,
    model: jobData?.model,
    unfinished: false,
    error: false,
    isCreatedByUser: false,
    tokenCount: completionTokens,
    /** The run publishes its calibration and fading tiers onto the job as it
     * goes; a stopped response must carry them or the next turn re-derives its
     * provider projection of history from scratch and loses the cached prefix.
     * A job with none unsets what an earlier pause stored on this row. */
    ...(jobData != null && { contextMeta: jobData.contextMeta ?? null }),
  };

  /** Persist the usage/cost rollup + context breakdown for the stopped response
   *  so its branch/total cost and granular rows survive a reload, matching the
   *  normal completion path. */
  const abortMetadata = buildAbortedResponseMetadata(jobData);
  if (abortMetadata) {
    responseMessage.metadata = abortMetadata;
  }

  /** The run that produced this response records its own usage on exit
   *  (`AgentClient` labels a stopped turn `'abort'`), so billing here would
   *  charge it a second time. This route only stops and persists. */

  const savedMessage = await db.saveMessage(
    {
      userId: req?.user?.id,
      isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
      expiredAt: req?.resolvedConversation?.expiredAt,
      interfaceConfig: req?.config?.interfaceConfig,
    },
    { ...responseMessage, user: userId },
    { context: 'api/server/middleware/abortMiddleware.js' },
  );

  /* Mirrors the agents abort route: when Stop wins the terminal claim, the request controller
     can return before its own save, making this direct write the only one that could reach
     the unseen-reply indicator. The assistants path stamps inside `syncMessages`; this one
     saves the message directly, so the stamp rides along here. Best-effort: the row is
     already durable, and a missed stamp must not suppress the final event.
     The temporary flag comes from the job: the client's abort request carries only the abort
     key and endpoint, so the request body alone would stamp a stopped temporary chat.
     An interrupt before the first real token still persists the unfinished assistant row, but
     that row renders nothing: stamping it would raise a dot for a reply with nothing to read,
     and opening the conversation could never clear it. */
  await announceReply(db, {
    userId,
    conversationId: jobData?.conversationId,
    reply: {
      messageId: savedMessage?.messageId,
      content,
      text,
      isTemporary: (jobData?.isTemporary ?? req?.body?.isTemporary) === true,
    },
    context: 'abortMessage',
  });

  // Get conversation for title
  const conversation = await db.getConvo(userId, conversationId);

  const finalEvent = {
    title: conversation && !conversation.title ? null : conversation?.title || 'New Chat',
    final: true,
    conversation,
    requestMessage: jobData?.userMessage
      ? sanitizeMessageForTransmit({
          messageId: jobData.userMessage.messageId,
          parentMessageId: jobData.userMessage.parentMessageId,
          conversationId: jobData.userMessage.conversationId,
          text: jobData.userMessage.text,
          quotes: jobData.userMessage.quotes,
          reasoningOverride: jobData.userMessage.reasoningOverride,
          isCreatedByUser: true,
        })
      : null,
    responseMessage,
  };

  logger.debug(
    `[abortMessage] ID: ${userId} | ${req.user.email} | Aborted request: ${conversationId}`,
  );

  if (res.headersSent) {
    return sendEvent(res, finalEvent);
  }

  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(finalEvent));
}

const handleAbort = function () {
  return async function (req, res) {
    try {
      if (isEnabled(process.env.LIMIT_CONCURRENT_MESSAGES)) {
        await clearPendingReq({ userId: req.user.id });
      }
      return await abortMessage(req, res);
    } catch (err) {
      logger.error('[abortMessage] handleAbort error', err);
    }
  };
};

/**
 * Handle abort errors during generation.
 * @param {ServerResponse} res
 * @param {ServerRequest} req
 * @param {Error | unknown} error
 * @param {Partial<TMessage> & { partialText?: string }} data
 * @returns {Promise<void>}
 */
const handleAbortError = async (res, req, error, data) => {
  const { sender, conversationId, messageId, parentMessageId, userMessageId, partialText } = data;

  if (error?.message?.includes('base64')) {
    logger.error('[handleAbortError] Error in base64 encoding', {
      ...error,
      stack: smartTruncateText(error?.stack, 1000),
      message: truncateText(error.message, 350),
    });
  } else if (isAbortError(error)) {
    logger.debug('[handleAbortError] AI response aborted by user', {
      conversationId,
      code: error?.code,
      name: error?.name,
      message: truncateText(error?.message ?? 'AbortError', 350),
    });
  } else {
    logger.error('[handleAbortError] AI response error; aborting request:', error);
  }

  if (error?.stack && error.stack.includes('google')) {
    logger.warn(
      `AI Response error for conversation ${conversationId} likely caused by Google censor/filter`,
    );
  }

  let errorText = error?.message?.includes('"type"')
    ? error.message
    : 'An error occurred while processing your request. Please contact the Admin.';

  if (error?.type === ErrorTypes.INVALID_REQUEST) {
    errorText = `{"type":"${ErrorTypes.INVALID_REQUEST}"}`;
  }

  if (error?.message?.includes("does not support 'system'")) {
    errorText = `{"type":"${ErrorTypes.NO_SYSTEM_MESSAGES}"}`;
  }

  /**
   * @param {string} partialText
   * @returns {Promise<void>}
   */
  const respondWithError = async (partialText) => {
    const endpointOption = req.body?.endpointOption;
    let options = {
      sender,
      messageId,
      conversationId,
      parentMessageId,
      text: errorText,
      user: req.user.id,
      spec: endpointOption?.spec,
      iconURL: endpointOption?.iconURL,
      modelLabel: endpointOption?.modelLabel,
      shouldSaveMessage: userMessageId != null,
      model: endpointOption?.modelOptions?.model || req.body?.model,
    };

    if (req.body?.agent_id) {
      options.agent_id = req.body.agent_id;
    }

    if (partialText) {
      options = {
        ...options,
        error: false,
        unfinished: true,
        text: partialText,
      };
    }

    await sendError(req, res, options);
  };

  if (partialText && partialText.length > 5) {
    try {
      return await abortMessage(req, res);
    } catch (err) {
      logger.error('[handleAbortError] error while trying to abort message', err);
      return respondWithError(partialText);
    }
  } else {
    return respondWithError();
  }
};

module.exports = {
  handleAbort,
  handleAbortError,
};
