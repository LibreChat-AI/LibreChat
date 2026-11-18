const express = require('express');
const { feedbackHandlers } = require('~/server/services/Channels');

const router = express.Router();
router.post('/service/:channelId/reactions', feedbackHandlers.reaction);
module.exports = router;
