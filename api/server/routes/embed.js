const express = require('express');
const { createEmbedSessionHandler, getBalanceConfig, standardCache } = require('@librechat/api');
const { findUser, createUserIfAbsent, generateToken } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

const router = express.Router();

router.post(
  '/session',
  createEmbedSessionHandler({
    getAppConfig: () => getAppConfig({ baseOnly: true }),
    findUser,
    createUserIfAbsent,
    getBalanceConfig,
    generateToken,
    replayStore: standardCache('embed_replay'),
  }),
);

module.exports = router;
