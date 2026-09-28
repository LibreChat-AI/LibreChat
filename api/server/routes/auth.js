const express = require('express');
const {
  limiterCache,
  createSetBalanceConfig,
  requireTwoFactorSetupToken,
  createTwoFactorManagementLimiter,
  forceRefreshCloudFrontAuthCookies,
  blockTwoFactorDisableWhenRequired,
  requireTwoFactorSetupAcknowledgementToken,
  requireTwoFactorSetupFinalizationToken,
} = require('@librechat/api');
const {
  resetPasswordRequestController,
  resetPasswordController,
  registrationController,
  graphTokenController,
  refreshController,
} = require('~/server/controllers/AuthController');
const {
  regenerateBackupCodes,
  disable2FA,
  confirm2FA,
  enable2FA,
  verify2FA,
} = require('~/server/controllers/TwoFactorController');
const {
  listPasskeys,
  updatePasskey,
  removePasskey,
  authenticatePasskey,
  loginPasskeyOptions,
  registerPasskeyOptions,
  registerPasskeyVerify,
} = require('~/server/controllers/auth/PasskeyController');
const {
  verify2FAWithTempToken,
  confirm2FASetupWithTempToken,
  acknowledge2FASetup,
  finalize2FASetup,
} = require('~/server/controllers/auth/TwoFactorAuthController');
const { logoutController } = require('~/server/controllers/auth/LogoutController');
const { loginController } = require('~/server/controllers/auth/LoginController');
const { findBalanceByUser, upsertBalanceFields } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const middleware = require('~/server/middleware');

const setBalanceConfig = createSetBalanceConfig({
  getAppConfig,
  findBalanceByUser,
  upsertBalanceFields,
});

const router = express.Router();
const twoFactorManagementLimiter = createTwoFactorManagementLimiter({
  getAppConfig: () => getAppConfig({ baseOnly: true }),
  store: limiterCache('two_factor_management_user_limiter'),
});
const getCloudFrontAuthCookieRefreshResult = (req, res) => {
  const warmedResult = req.cloudFrontAuthCookieRefreshResult;
  if (warmedResult && (warmedResult.attempted || !warmedResult.enabled)) {
    return warmedResult;
  }

  return forceRefreshCloudFrontAuthCookies(req, res, req.user);
};

const ldapAuth = !!process.env.LDAP_URL && !!process.env.LDAP_USER_SEARCH_BASE;
//Local
router.post('/logout', middleware.requireJwtAuth, logoutController);
router.post(
  '/login',
  middleware.logHeaders,
  middleware.requireSameOrigin,
  middleware.loginLimiter,
  middleware.checkBan,
  middleware.validateEmailLogin,
  ldapAuth ? middleware.requireLdapAuth : middleware.requireLocalAuth,
  setBalanceConfig,
  loginController,
);
router.post('/refresh', refreshController);
router.post('/cloudfront/refresh', middleware.requireJwtAuth, (req, res) => {
  const result = getCloudFrontAuthCookieRefreshResult(req, res);
  if (!result.enabled) {
    return res.sendStatus(404);
  }

  const status = result.refreshed ? 200 : 500;
  return res.status(status).json({
    ok: result.refreshed,
    expiresInSec: result.expiresInSec,
    refreshAfterSec: result.refreshAfterSec,
  });
});
router.post(
  '/register',
  middleware.registerLimiter,
  middleware.checkBan,
  middleware.checkInviteUser,
  middleware.validateRegistration,
  registrationController,
);
router.post(
  '/requestPasswordReset',
  middleware.resetPasswordLimiter,
  middleware.checkBan,
  middleware.validatePasswordReset,
  resetPasswordRequestController,
);
router.post(
  '/resetPassword',
  middleware.resetPasswordSubmissionLimiter,
  middleware.checkBan,
  middleware.validatePasswordReset,
  resetPasswordController,
);

router.post('/2fa/enable', middleware.requireJwtAuth, twoFactorManagementLimiter, enable2FA);
router.post('/2fa/verify', middleware.requireJwtAuth, twoFactorManagementLimiter, verify2FA);
router.post(
  '/2fa/setup',
  middleware.setTwoFactorTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupToken,
  middleware.blockRetiredSetupToken,
  enable2FA,
);
router.post(
  '/2fa/setup/confirm',
  middleware.setTwoFactorTempUser,
  middleware.twoFactorTempLimiter,
  middleware.checkBan,
  requireTwoFactorSetupToken,
  middleware.blockRetiredSetupToken,
  confirm2FASetupWithTempToken,
);
router.post(
  '/2fa/setup/acknowledge',
  middleware.setTwoFactorAcknowledgementTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupAcknowledgementToken,
  acknowledge2FASetup,
);
router.post(
  '/2fa/setup/finalize',
  middleware.setTwoFactorFinalizationTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupFinalizationToken,
  finalize2FASetup,
);
router.post(
  '/2fa/verify-temp',
  middleware.requireSameOrigin,
  middleware.setTwoFactorTempUser,
  middleware.twoFactorTempLimiter,
  middleware.checkBan,
  verify2FAWithTempToken,
);
router.post('/2fa/confirm', middleware.requireJwtAuth, twoFactorManagementLimiter, confirm2FA);
router.post(
  '/2fa/disable',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  blockTwoFactorDisableWhenRequired,
  disable2FA,
);
router.post(
  '/2fa/backup/regenerate',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  regenerateBackupCodes,
);

/* Passkeys (WebAuthn) */
router.post(
  '/passkey/login/options',
  middleware.logHeaders,
  middleware.passkeyLimiter,
  middleware.checkBan,
  loginPasskeyOptions,
);
router.post(
  '/passkey/login/verify',
  middleware.logHeaders,
  middleware.requireSameOrigin,
  middleware.passkeyLimiter,
  middleware.checkBan,
  authenticatePasskey,
  setBalanceConfig,
  loginController,
);
router.get('/passkey', middleware.requireJwtAuth, listPasskeys);
router.post(
  '/passkey/register/options',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  registerPasskeyOptions,
);
router.post(
  '/passkey/register/verify',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  registerPasskeyVerify,
);
router.patch('/passkey/:passkeyId', middleware.requireJwtAuth, updatePasskey);
router.delete(
  '/passkey/:passkeyId',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  removePasskey,
);

router.get('/graph-token', middleware.requireJwtAuth, graphTokenController);

module.exports = router;
