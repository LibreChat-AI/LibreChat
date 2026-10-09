const express = require('express');
const { createMessageFilterPii, reportLocatorTraversalFailure } = require('@librechat/api');

const router = express.Router();
const { handleAbort, validateModel, buildEndpointOption } = require('~/server/middleware');
const validateConvoAccess = require('~/server/middleware/validate/convoAccess');
const guardSubagentThreadTurn = require('~/server/middleware/validate/subagentThreadTurn');
const validateAssistant = require('~/server/middleware/assistants/validate');
const chatController = require('~/server/controllers/assistants/chatV2');
const { getFiles } = require('~/models');

router.post('/abort', handleAbort());

const filterMessageContent = createMessageFilterPii({
  onTraversalFailure: reportLocatorTraversalFailure,
  getConfig: (req) => req.config?.messageFilter?.pii,
  getFilters: (req) => req.config?.filters,
  getFiles,
});

/**
 * @route POST /
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post(
  '/',
  filterMessageContent,
  validateModel,
  buildEndpointOption,
  validateAssistant,
  validateConvoAccess,
  guardSubagentThreadTurn,
  chatController,
);

module.exports = router;
