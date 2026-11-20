const { createEnrollmentControllers, clearCloudFrontCookies } = require('@librechat/api');
const {
  verifyTOTP,
  getTOTPSecret,
  verifyBackupCode,
  generateBackupCodes,
} = require('~/server/services/twoFactorService');
const { setAuthTokens } = require('~/server/services/AuthService');
const {
  getUserById,
  updateUser,
  updateTwoFactorEnrollment,
  findSession,
  deleteSession,
  deleteAllUserSessions,
  awaitAuthUserDocEviction,
} = require('~/models');

module.exports = createEnrollmentControllers({
  getUserById,
  getTOTPSecret,
  verifyTOTP,
  verifyBackupCode,
  generateBackupCodes,
  updateTwoFactorEnrollment,
  updateUser,
  findSession,
  deleteSession,
  deleteAllUserSessions,
  awaitAuthUserDocEviction,
  setAuthTokens,
  clearCloudFrontCookies,
});
