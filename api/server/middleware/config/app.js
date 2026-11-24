const { logger } = require('@librechat/data-schemas');
const {
  getSafeErrorMetadata,
  loadStrictAppConfig,
  getAppConfigOptionsFromUser,
  createStreamKeepaliveLoader,
} = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');

const configMiddleware = async (req, res, next) => {
  try {
    req.config = await getAppConfig(getAppConfigOptionsFromUser(req.user));

    next();
  } catch (error) {
    logger.error('Config middleware error:', {
      error: getSafeErrorMetadata(error),
      userRole: req.user?.role,
      path: req.path,
    });

    try {
      req.config = await getAppConfig({ tenantId: req.user?.tenantId });
      next();
    } catch (fallbackError) {
      logger.error('Fallback config middleware error:', getSafeErrorMetadata(fallbackError));
      next(fallbackError);
    }
  }
};

/** Fail closed and reuse only a successful strict read for this request identity. */
const strictConfigMiddleware = async (req, res, next) => {
  try {
    req.config = await loadStrictAppConfig(req, getAppConfig);
    next();
  } catch (error) {
    logger.error('Strict config middleware error:', {
      error: getSafeErrorMetadata(error),
      userRole: req.user?.role,
      path: req.path,
    });
    next(error);
  }
};

module.exports = configMiddleware;
module.exports.strictConfigMiddleware = strictConfigMiddleware;
module.exports.loadStreamKeepaliveMs = createStreamKeepaliveLoader(getAppConfig);
