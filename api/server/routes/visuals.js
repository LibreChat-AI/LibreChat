const express = require('express');
const { createVisualFrameHandler, resolveFrameAncestors } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');

const router = express.Router();

router.get(
  '/frame',
  createVisualFrameHandler({ getAppConfig, frameAncestors: resolveFrameAncestors() }),
);

module.exports = router;
