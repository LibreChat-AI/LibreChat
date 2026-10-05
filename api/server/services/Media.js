const path = require('path');
const axios = require('axios');
const multer = require('multer');
const { logger, runAsSystem, tenantStorage, decrypt } = require('@librechat/data-schemas');
const {
  createMediaApplication,
  cacheConfig,
  ioredisClient,
  standardCache,
  loadServiceKey,
  registerShutdownTask,
  getRemainingShutdownMs,
  tenantContextMiddleware,
} = require('@librechat/api');
const db = require('~/models');
const { getAppConfig } = require('./Config');
const { getStrategyFunctions } = require('./Files/strategies');
const { saveBase64Image } = require('./Files/process');
const requireJwtAuth = require('../middleware/requireJwtAuth');
const optionalJwtAuth = require('../middleware/optionalJwtAuth');
const optionalShareFileAuth = require('../middleware/optionalShareFileAuth');
const checkBan = require('../middleware/checkBan');
const {
  messageIpLimiter,
  messageUserLimiter,
  consumeMessageLimit,
} = require('../middleware/limiters/messageLimiters');
const { createFileLimiters } = require('../middleware/limiters/uploadLimiters');
const { logViolation } = require('~/cache');

module.exports = createMediaApplication({
  activityTransport: { useRedis: cacheConfig.USE_REDIS_STREAMS, redisClient: ioredisClient },
  host: {
    db,
    saveNativeImage: saveBase64Image,
    getRoleByName: db.getRoleByName,
    getAppConfig,
    tenantContext: tenantStorage,
    asSystem: runAsSystem,
    environment: process.env,
    http: axios,
    upload: multer,
    admission: {
      checkBan,
      messageIpLimiter,
      messageUserLimiter,
      consumeMessageLimit,
      createFileLimiters,
      logViolation,
    },
    getStorageStrategy: getStrategyFunctions,
    loadServiceKey,
    defaultServiceKeyFile: path.resolve(__dirname, '../../data/auth.json'),
    decrypt,
    logger,
  },
  createCache: standardCache,
  registerShutdownTask,
  getRemainingShutdownMs,
  requireJwtAuth,
  optionalJwtAuth,
  optionalShareFileAuth,
  checkBan,
  tenantContextMiddleware,
});
