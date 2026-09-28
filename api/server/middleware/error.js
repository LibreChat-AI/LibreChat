const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { parseConvo } = require('librechat-data-provider');
const { sendEvent, handleError, sanitizeMessageForTransmit } = require('@librechat/api');
const { saveMessage, getMessages, getConvo } = require('~/models');

/**
 * Processes an error with provided options, saves the error message and sends a corresponding SSE response
 * @async
 * @param {object} req - The request.
 * @param {object} res - The response.
 * @param {object} options - The options for handling the error containing message properties.
 * @param {object} options.user - The user ID.
 * @param {string} options.sender - The sender of the message.
 * @param {string} options.conversationId - The conversation ID.
 * @param {string} options.messageId - The message ID.
 * @param {string} options.parentMessageId - The parent message ID.
 * @param {string} options.text - The error message.
 * @param {boolean} options.shouldSaveMessage - [Optional] Whether the message should be saved. Default is true.
 * @param {function} callback - [Optional] The callback function to be executed.
 */
const sendError = async (req, res, options, callback) => {
  const {
    user,
    sender,
    conversationId,
    messageId,
    parentMessageId,
    text,
    shouldSaveMessage,
    ...rest
  } = options;
  const errorMessage = {
    sender,
    messageId: messageId ?? crypto.randomUUID(),
    conversationId,
    parentMessageId,
    unfinished: false,
    error: true,
    final: true,
    text,
    isCreatedByUser: false,
    ...rest,
  };
  if (callback && typeof callback === 'function') {
    await callback();
  }

  if (shouldSaveMessage) {
    await saveMessage(
      {
        userId: req?.user?.id,
        isTemporary: req?.resolvedConversation?.isTemporary ?? req?.body?.isTemporary,
        expiredAt: req?.resolvedConversation?.expiredAt,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      { ...errorMessage, user },
      {
        context: 'api/server/utils/streamResponse.js - sendError',
      },
    );
  }

  if (!errorMessage.error) {
    const requestMessage = { messageId: parentMessageId, conversationId };
    let query = [],
      convo = {};
    try {
      query = await getMessages(requestMessage);
      convo = await getConvo(user, conversationId);
    } catch (err) {
      logger.error('[sendError] Error retrieving conversation data:', err);
      convo = parseConvo(errorMessage);
    }

    return sendEvent(res, {
      final: true,
      requestMessage: sanitizeMessageForTransmit(query?.[0] ?? requestMessage),
      responseMessage: errorMessage,
      conversation: convo,
    });
  }

  handleError(res, errorMessage);
};

/**
 * Sends the response based on whether headers have been sent or not.
 * @param {ServerRequest} req - The server response.
 * @param {Express.Response} res - The server response.
 * @param {Object} data - The data to be sent.
 * @param {string} [errorMessage] - The error message, if any.
 */
const sendResponse = (req, res, data, errorMessage) => {
  if (!res.headersSent) {
    if (errorMessage) {
      return res.status(500).json({ error: errorMessage });
    }
    return res.json(data);
  }

  if (errorMessage) {
    return sendError(req, res, { ...data, text: errorMessage });
  }
  return sendEvent(res, data);
};

module.exports = {
  sendError,
  sendResponse,
};
