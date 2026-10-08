const { logger } = require('@librechat/data-schemas');
const {
  getSafeErrorMetadata,
  resolveStrictAppConfig,
  getAppConfigOptionsFromUser,
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

/** The same resolution, without the fallback; `resolveStrictAppConfig` owns that choice. */
const strictConfigMiddleware = async (req, res, next) => {
  try {
    req.config = await resolveStrictAppConfig(getAppConfig, req.user);
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

/** The principal's config without runtime augmentation, for reads that need only YAML
 * settings (for example the stream keepalive interval) on a hot path. */
const loadPlainAppConfig = (req) =>
  getAppConfig({ ...getAppConfigOptionsFromUser(req.user), skipRuntimeAugmentation: true });

module.exports = configMiddleware;
module.exports.strictConfigMiddleware = strictConfigMiddleware;
module.exports.loadPlainAppConfig = loadPlainAppConfig;
