const express = require('express');
const { createConversationMetadataHandlers } = require('@librechat/api');
const { checkBan, requireTermsAcceptance } = require('~/server/middleware');
const { getConversationMetadata, listConversationMetadata } = require('~/models');
const { requireConversationReadAuth } = require('./middleware');

const router = express.Router();
const { list, get, missing } = createConversationMetadataHandlers({
  getConversationMetadata,
  listConversationMetadata,
});

router.use(requireConversationReadAuth);
router.use(requireTermsAcceptance);
router.use(checkBan);
router.get('/', list);
router.get('/:id', get);
router.use(missing);

module.exports = router;
