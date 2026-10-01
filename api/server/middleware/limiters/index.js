const createTTSLimiters = require('./ttsLimiters');
const createSTTLimiters = require('./sttLimiters');

const loginLimiter = require('./loginLimiter');
const passkeyLimiter = require('./passkeyLimiter');
const importLimiters = require('./importLimiters');
const uploadLimiters = require('./uploadLimiters');
const forkLimiters = require('./forkLimiters');
const shareLimiters = require('./shareLimiters');
const registerLimiter = require('./registerLimiter');
const toolCallLimiter = require('./toolCallLimiter');
const messageLimiters = require('./messageLimiters');
const promptUsageLimiter = require('./promptUsageLimiter');
const verifyEmailLimiter = require('./verifyEmailLimiter');
const emailChangeLimiter = require('./emailChangeLimiter');
const emailChangeSubmissionLimiter = require('./emailChangeSubmissionLimiter');
const emailChangeSubmissionIpLimiter = require('./emailChangeSubmissionIpLimiter');
const resetPasswordLimiter = require('./resetPasswordLimiter');
const twoFactorTempLimiter = require('./twoFactorTempLimiter');
const passkeyStepUpLimiter = require('./passkeyStepUpLimiter');
const verifyEmailSubmissionLimiter = require('./verifyEmailSubmissionLimiter');
const resetPasswordSubmissionLimiter = require('./resetPasswordSubmissionLimiter');

module.exports = {
  ...uploadLimiters,
  ...importLimiters,
  ...messageLimiters,
  ...forkLimiters,
  ...shareLimiters,
  ...promptUsageLimiter,
  loginLimiter,
  passkeyLimiter,
  passkeyStepUpLimiter,
  registerLimiter,
  toolCallLimiter,
  createTTSLimiters,
  createSTTLimiters,
  verifyEmailLimiter,
  emailChangeLimiter,
  emailChangeSubmissionLimiter,
  emailChangeSubmissionIpLimiter,
  resetPasswordLimiter,
  verifyEmailSubmissionLimiter,
  resetPasswordSubmissionLimiter,
  twoFactorTempLimiter,
};
