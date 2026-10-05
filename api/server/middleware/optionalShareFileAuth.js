const cookie = require('cookie');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  createOptionalCookieAuth,
  clearCloudFrontCookies,
  isTwoFactorEnrollmentRequired,
  isTokenRetired,
  isEnabled,
} = require('@librechat/api');
const { getUserById, findSession } = require('~/models');

module.exports = createOptionalCookieAuth({
  parseCookies: cookie.parse,
  isOpenIdReuseEnabled: () => isEnabled(process.env.OPENID_REUSE_TOKENS),
  getSecret: () => process.env.JWT_REFRESH_SECRET,
  findSession,
  getUserById,
  asSystem: runAsSystem,
  clearCloudFrontCookies,
  enrollmentRequired: isTwoFactorEnrollmentRequired,
  tokenRetired: isTokenRetired,
  log: logger.warn.bind(logger),
});
