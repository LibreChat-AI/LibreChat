const { logger } = require('@librechat/data-schemas');
const { getForwardedHeaders } = require('@librechat/api');

/**
 * Middleware to log Forwarded Headers
 * @function
 * @param {ServerRequest} req - Express request object containing user information.
 * @param {ServerResponse} res - Express response object.
 * @param {import('express').NextFunction} next - Next middleware function.
 * @throws {Error} Throws an error if the user exceeds the concurrent request limit.
 */
const logHeaders = (req, res, next) => {
  try {
    const forwardedHeaders = getForwardedHeaders(req.headers);
    if (Object.keys(forwardedHeaders).length > 0) {
      logger.debug('X-Forwarded headers detected in OAuth request:', forwardedHeaders);
    }
  } catch (error) {
    logger.error('Error logging X-Forwarded headers:', error);
  }
  next();
};

module.exports = logHeaders;
