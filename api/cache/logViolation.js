const { isEnabled } = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');
const getLogStores = require('./getLogStores');
const banViolation = require('./banViolation');

/**
 * Logs the violation.
 *
 * @param {Object} req - Express request object containing user information.
 * @param {Object} res - Express response object.
 * @param {string} type - The type of violation.
 * @param {Object} errorMessage - The error message to log.
 * @param {number | string} [score=1] - The severity of the violation. Defaults to 1
 */
const logViolation = async (req, res, type, errorMessage, score = 1) => {
  const userId = req.user?.id ?? req.user?._id?.toString();
  if (!userId) {
    return;
  }
  const logs = getLogStores(ViolationTypes.GENERAL);
  const violationLogs = getLogStores(type);
  const key = isEnabled(process.env.USE_REDIS) ? `${type}:${userId}` : userId;

  const userViolations = (await violationLogs.get(key)) ?? 0;
  const violationCount = +userViolations + +score;
  await violationLogs.set(key, violationCount);

  errorMessage.user_id = userId;
  errorMessage.prev_count = userViolations;
  errorMessage.violation_count = violationCount;
  errorMessage.date = new Date().toISOString();

  await banViolation(req, res, errorMessage);
  const userLogs = (await logs.get(key)) ?? [];
  userLogs.push(errorMessage);
  delete errorMessage.user_id;
  await logs.set(key, userLogs);
};

module.exports = logViolation;
