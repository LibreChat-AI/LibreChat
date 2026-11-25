const express = require('express');
const handlers = require('~/server/services/SlackDispatch');

const router = express.Router();
router.get('/service/workspaces', handlers.bootstrap);
router.post('/service/workspaces/app', handlers.app);
router.post('/service/workspaces/resolve', handlers.resolve);
router.post('/service/workspaces/discover', handlers.discover);
router.post('/service/workspaces/lifecycle', handlers.lifecycle);

module.exports = router;
