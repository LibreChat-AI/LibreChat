const express = require('express');
const { modelController } = require('~/server/controllers/ModelController');
const { requireJwtAuth } = require('~/server/middleware/');

const configMiddleware = require('~/server/middleware/config/app');

const router = express.Router();
router.get('/', requireJwtAuth, configMiddleware, modelController);

module.exports = router;
