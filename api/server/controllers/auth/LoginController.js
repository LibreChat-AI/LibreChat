const { createLoginController, clearCloudFrontCookies } = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { getUserById, deleteAllUserSessions } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');

/** Matches the strategy `routes/auth.js` mounts for `/login`, so the recorded `authMethod`
 *  reflects which credential check actually ran. */
const ldapAuth = !!process.env.LDAP_URL && !!process.env.LDAP_USER_SEARCH_BASE;

const loginController = createLoginController({
  generate2FATempToken,
  getUserById,
  deleteAllUserSessions,
  setAuthTokens,
  clearCloudFrontCookies,
  defaultAuthMethod: ldapAuth ? 'ldap' : 'local',
});

module.exports = { loginController };
