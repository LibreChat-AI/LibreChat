const validatePasswordReset = require('./validatePasswordReset');
const setTwoFactorTempUser = require('./setTwoFactorTempUser');
const validateRegistration = require('./validateRegistration');
const buildEndpointOption = require('./buildEndpointOption');
const validateEmailLogin = require('./validateEmailLogin');
const validateMessageReq = require('./validateMessageReq');
const {
  canReadActiveJobConversation,
  prepareMessageRequestValidation,
  sendValidationResponse,
} = require('./messageValidation');
const checkDomainAllowed = require('./checkDomainAllowed');
const { markOAuthNavigation } = require('./oauthNavigation');
const requireSameOrigin = require('./requireSameOrigin');
const requireLocalAuth = require('./requireLocalAuth');
const canDeleteAccount = require('./canDeleteAccount');
const accessResources = require('./accessResources');
const requireLdapAuth = require('./requireLdapAuth');
const abortMiddleware = require('./abortMiddleware');
const checkInviteUser = require('./checkInviteUser');
const requireJwtAuth = require('./requireJwtAuth');
const { requireRumProxyAuth } = require('./requireJwtAuth');
const configMiddleware = require('./config/app');
const validateModel = require('./validateModel');
const moderateText = require('./moderateText');
const logHeaders = require('./logHeaders');
const setHeaders = require('./setHeaders');
const validate = require('./validate');
const limiters = require('./limiters');
const uaParser = require('./uaParser');
const checkBan = require('./checkBan');
const noIndex = require('./noIndex');
const roles = require('./roles');

module.exports = {
  ...abortMiddleware,
  ...validate,
  ...limiters,
  ...roles,
  ...accessResources,
  noIndex,
  checkBan,
  uaParser,
  setHeaders,
  logHeaders,
  markOAuthNavigation,
  moderateText,
  validateModel,
  requireJwtAuth,
  requireRumProxyAuth,
  setTwoFactorTempUser,
  checkInviteUser,
  requireLdapAuth,
  requireLocalAuth,
  requireSameOrigin,
  canDeleteAccount,
  configMiddleware,
  checkDomainAllowed,
  validateMessageReq,
  canReadActiveJobConversation,
  sendValidationResponse,
  prepareMessageRequestValidation,
  buildEndpointOption,
  validateRegistration,
  validatePasswordReset,
  validateEmailLogin,
};
