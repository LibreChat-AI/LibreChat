const {
  createLoginController,
  clearCloudFrontCookies,
  isLdapAuthEnabled,
} = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { getUserById, deleteAllUserSessions } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');

const sharedDeps = {
  generate2FATempToken,
  getUserById,
  deleteAllUserSessions,
  setAuthTokens,
  clearCloudFrontCookies,
};

/** Matches the strategy `routes/auth.js` mounts for `/login`, so the recorded `authMethod`
 *  reflects which credential check actually ran. */
const loginController = createLoginController({
  ...sharedDeps,
  defaultAuthMethod: isLdapAuthEnabled() ? 'ldap' : 'local',
});

/** `routes/admin/auth.js` mounts `/login/local` behind `requireLocalAuth` regardless of whether
 *  this deployment also has LDAP configured, so its recorded `authMethod` is always `'local'`. */
const localLoginController = createLoginController({
  ...sharedDeps,
  defaultAuthMethod: 'local',
});

module.exports = { loginController, localLoginController };
