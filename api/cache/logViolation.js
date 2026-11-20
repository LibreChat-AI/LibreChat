const { isEnabled, incrementViolationCount, appendViolationLog } = require('@librechat/api');
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

  const { prevCount, count: violationCount } = await incrementViolationCount(
    violationLogs,
    key,
    score,
  );

  errorMessage.user_id = userId;
  errorMessage.prev_count = prevCount;
  errorMessage.violation_count = violationCount;
  errorMessage.date = new Date().toISOString();

  await banViolation(req, res, errorMessage);
  delete errorMessage.user_id;
  await appendViolationLog(logs, key, errorMessage, req.config?.violationLog?.maxEntries);
};

module.exports = logViolation;
