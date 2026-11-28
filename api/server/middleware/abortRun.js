const { stopRun } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { initializeClient } = require('~/server/services/Endpoints/assistants');
const { checkMessageGaps, recordUsage } = require('~/server/services/Threads');
const { distributedLock } = require('~/cache/distributedLock');
const getLogStores = require('~/cache/getLogStores');
const { getConvo } = require('~/models');

/** Stops the Assistants run a conversation names; see `stopRun` in `@librechat/api`. */
const abortRun = (req, res) =>
  stopRun(req, res, {
    cache: getLogStores(CacheKeys.ABORT_KEYS),
    lock: distributedLock,
    getConvo,
    initializeClient,
    recordUsage,
    checkMessageGaps,
  });

module.exports = {
  abortRun,
};
