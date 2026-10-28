const { createEnrollmentControllers, clearCloudFrontCookies } = require('@librechat/api');
const {
  verifyTOTP,
  getTOTPSecret,
  verifyBackupCode,
  generateBackupCodes,
} = require('~/server/services/twoFactorService');
const { setAuthTokens } = require('~/server/services/AuthService');
const { getUserById, updateTwoFactorEnrollment, deleteAllUserSessions } = require('~/models');

module.exports = createEnrollmentControllers({
  getUserById,
  getTOTPSecret,
  verifyTOTP,
  verifyBackupCode,
  generateBackupCodes,
  updateTwoFactorEnrollment,
  deleteAllUserSessions,
  setAuthTokens,
  clearCloudFrontCookies,
});
