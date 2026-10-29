const express = require('express');
const { createRealtimeTranscriptionHandler } = require('@librechat/api');
const { speechToText } = require('~/server/services/Files/Audio');

const router = express.Router();

router.post('/', speechToText);
router.post('/realtime', createRealtimeTranscriptionHandler());

module.exports = router;
