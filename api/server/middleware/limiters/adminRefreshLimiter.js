const { limiterCache, createAdminRefreshLimiter } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');

module.exports = createAdminRefreshLimiter({
  getAppConfig: () => getAppConfig({ baseOnly: true }),
  store: limiterCache('admin_refresh_limiter'),
});
