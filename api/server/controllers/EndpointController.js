const { logger } = require('@librechat/data-schemas');
const { withholdEmptyEndpoints, filterManagedEndpoints } = require('@librechat/api');
const { getEndpointsConfig, getModelsConfig } = require('~/server/services/Config');

/**
 * Withholding happens here and nowhere else: this route decides what the user
 * may be offered, while other callers of `getEndpointsConfig` read
 * configuration keys (`defaultParamsEndpoint`, `userProvide`) that withholding
 * would remove.
 */
async function endpointController(req, res) {
  /* Without `models.filter` this route stays the cached config read it has
     always been — no models resolution. */
  const filterManaged = filterManagedEndpoints(req.config);
  if (filterManaged.size === 0) {
    return res.send(JSON.stringify(await getEndpointsConfig(req)));
  }

  const [endpointsConfig, modelsConfig] = await Promise.all([
    getEndpointsConfig(req),
    /* Fail open: an unresolvable models config withholds nothing. */
    getModelsConfig(req).catch((error) => {
      logger.error('[endpointController] Could not resolve available models', error);
      return null;
    }),
  ]);

  res.send(JSON.stringify(withholdEmptyEndpoints(endpointsConfig, modelsConfig, filterManaged)));
}

module.exports = endpointController;
