const { logger } = require('@librechat/data-schemas');
const { resolveTokenConfigMap } = require('@librechat/api');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getValueKey, getMultiplier, getCacheMultiplier } = require('~/models');

/**
 * Returns server-resolved context windows (and pricing when
 * `interface.contextCost` is enabled) for every configured model. Resolution
 * lives in `@librechat/api`; this controller only supplies request-scoped deps.
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
async function tokenConfigController(req, res) {
  try {
    const modelsConfig = await getModelsConfig(req);
    const tokenConfigMap = await resolveTokenConfigMap(
      {
        appConfig: req.config,
        modelsConfig,
        userId: req.user.id,
        tenantId: req.user.tenantId,
      },
      { getValueKey, getMultiplier, getCacheMultiplier },
    );
    res.json(tokenConfigMap);
  } catch (error) {
    logger.error('[tokenConfigController]', error);
    res.status(500).json({ error: 'Failed to resolve token config' });
  }
}

module.exports = tokenConfigController;
