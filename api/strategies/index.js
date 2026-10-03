const {
  setupOpenId,
  getOpenIdConfig,
  ensureOpenIdConfigured,
  getOpenIdEmail,
} = require('./openidStrategy');
const openIdJwtLogin = require('./openIdJwtStrategy');
const facebookLogin = require('./facebookStrategy');
const { facebookAdminLogin } = facebookLogin;
const discordLogin = require('./discordStrategy');
const { discordAdminLogin } = discordLogin;
const passportLogin = require('./localStrategy');
const googleLogin = require('./googleStrategy');
const { googleAdminLogin } = googleLogin;
const githubLogin = require('./githubStrategy');
const { githubAdminLogin } = githubLogin;
const { setupSaml } = require('./samlStrategy');
const appleLogin = require('./appleStrategy');
const { appleAdminLogin } = appleLogin;
const ldapLogin = require('./ldapStrategy');
const jwtLogin = require('./jwtStrategy');

module.exports = {
  appleLogin,
  appleAdminLogin,
  passportLogin,
  googleLogin,
  googleAdminLogin,
  githubLogin,
  githubAdminLogin,
  discordLogin,
  discordAdminLogin,
  jwtLogin,
  facebookLogin,
  facebookAdminLogin,
  setupOpenId,
  getOpenIdConfig,
  ensureOpenIdConfigured,
  getOpenIdEmail,
  ldapLogin,
  setupSaml,
  openIdJwtLogin,
};
