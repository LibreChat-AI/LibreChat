const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

const getEnvironmentVariables = () => {
  const FILE_UPLOAD_IP_MAX = parseInt(process.env.FILE_UPLOAD_IP_MAX) || 100;
  const FILE_UPLOAD_IP_WINDOW = parseInt(process.env.FILE_UPLOAD_IP_WINDOW) || 15;
  const FILE_UPLOAD_USER_MAX = parseInt(process.env.FILE_UPLOAD_USER_MAX) || 50;
  const FILE_UPLOAD_USER_WINDOW = parseInt(process.env.FILE_UPLOAD_USER_WINDOW) || 15;
  const FILE_UPLOAD_VIOLATION_SCORE = process.env.FILE_UPLOAD_VIOLATION_SCORE;

  const fileUploadIpWindowMs = FILE_UPLOAD_IP_WINDOW * 60 * 1000;
  const fileUploadIpMax = FILE_UPLOAD_IP_MAX;
  const fileUploadIpWindowInMinutes = fileUploadIpWindowMs / 60000;

  const fileUploadUserWindowMs = FILE_UPLOAD_USER_WINDOW * 60 * 1000;
  const fileUploadUserMax = FILE_UPLOAD_USER_MAX;
  const fileUploadUserWindowInMinutes = fileUploadUserWindowMs / 60000;

  return {
    fileUploadIpWindowMs,
    fileUploadIpMax,
    fileUploadIpWindowInMinutes,
    fileUploadUserWindowMs,
    fileUploadUserMax,
    fileUploadUserWindowInMinutes,
    fileUploadViolationScore: FILE_UPLOAD_VIOLATION_SCORE,
  };
};

const createFileUploadHandler = (ip = true, onLimit) => {
  const {
    fileUploadIpMax,
    fileUploadIpWindowInMinutes,
    fileUploadUserMax,
    fileUploadUserWindowInMinutes,
    fileUploadViolationScore,
  } = getEnvironmentVariables();

  return async (req, res) => {
    const type = ViolationTypes.FILE_UPLOAD_LIMIT;
    const errorMessage = {
      type,
      max: ip ? fileUploadIpMax : fileUploadUserMax,
      limiter: ip ? 'ip' : 'user',
      windowInMinutes: ip ? fileUploadIpWindowInMinutes : fileUploadUserWindowInMinutes,
    };

    await logViolation(req, res, type, errorMessage, fileUploadViolationScore);
    if (onLimit) {
      return onLimit(req, res);
    }
    res.status(429).json({ message: 'Too many file upload requests. Try again later' });
  };
};

const createFileLimiters = ({ onLimit } = {}) => {
  const { fileUploadIpWindowMs, fileUploadIpMax, fileUploadUserWindowMs, fileUploadUserMax } =
    getEnvironmentVariables();

  const ipLimiterOptions = {
    windowMs: fileUploadIpWindowMs,
    max: fileUploadIpMax,
    handler: createFileUploadHandler(true, onLimit),
    keyGenerator: removePorts,
    store: limiterCache('file_upload_ip_limiter'),
  };

  const userLimiterOptions = {
    windowMs: fileUploadUserWindowMs,
    max: fileUploadUserMax,
    handler: createFileUploadHandler(false, onLimit),
    keyGenerator: function (req) {
      return req.user?.id;
    },
    store: limiterCache('file_upload_user_limiter'),
  };

  const fileUploadIpLimiter = rateLimit(ipLimiterOptions);
  const fileUploadUserLimiter = rateLimit(userLimiterOptions);

  return { fileUploadIpLimiter, fileUploadUserLimiter };
};

/**
 * Per-user limiter for the `/files/usage` TTL hold. Deliberately separate from
 * the upload limiters: a metadata touch must not consume upload quota, but it
 * still writes to the DB and so cannot go unmetered. Sized well above the
 * enqueue-driven call rate a real client produces.
 */
const createFileUsageLimiter = () => {
  const windowMinutes = parseInt(process.env.FILE_USAGE_USER_WINDOW) || 15;
  const max = parseInt(process.env.FILE_USAGE_USER_MAX) || 120;
  const windowMs = windowMinutes * 60 * 1000;

  return rateLimit({
    windowMs,
    max,
    handler: async (req, res) => {
      const type = ViolationTypes.FILE_UPLOAD_LIMIT;
      await logViolation(
        req,
        res,
        type,
        { type, max, limiter: 'user', windowInMinutes: windowMinutes },
        process.env.FILE_UPLOAD_VIOLATION_SCORE,
      );
      res.status(429).json({ message: 'Too many file usage requests. Try again later' });
    },
    keyGenerator: function (req) {
      return req.user?.id;
    },
    store: limiterCache('file_usage_user_limiter'),
  });
};

module.exports = {
  createFileLimiters,
  createFileUsageLimiter,
};
