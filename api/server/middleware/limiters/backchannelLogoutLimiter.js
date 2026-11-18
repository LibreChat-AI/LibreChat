const { removePorts, limiterCache, createBackchannelLogoutLimiter } = require('@librechat/api');
const { getBackchannelLogoutConfig } = require('~/server/services/ProviderSession');

const backchannelLogoutLimiter = createBackchannelLogoutLimiter({
  getConfig: getBackchannelLogoutConfig,
  removePorts,
  limiterCache,
});

module.exports = backchannelLogoutLimiter;
