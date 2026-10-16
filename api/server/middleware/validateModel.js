const { handleError, filterManagedEndpoints } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { resolveModelCatalogKey, ViolationTypes } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getEndpointsConfig } = require('~/server/services/Config');
const { logViolation } = require('~/cache');

const MAX_MODEL_STRING_LENGTH = 256;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/;

/**
 * Validates the model of the request.
 *
 * @async
 * @param {ServerRequest} req - The Express request object.
 * @param {Express.Response} res - The Express response object.
 * @param {Function} next - The Express next function.
 */
const validateModel = async (req, res, next) => {
  const { endpoint } = req.body;
  const rawModel = req.body.model;

  if (!rawModel || typeof rawModel !== 'string') {
    return handleError(res, { text: 'Model not provided' });
  }

  const model = rawModel.trim();
  if (!model || model.length > MAX_MODEL_STRING_LENGTH || !MODEL_PATTERN.test(model)) {
    return handleError(res, { text: 'Invalid model identifier' });
  }

  req.body.model = model;

  const endpointsConfig = await getEndpointsConfig(req);
  const endpointConfig = endpointsConfig?.[endpoint];

  if (endpointConfig?.userProvide) {
    return next();
  }

  const modelsConfig = await getModelsConfig(req);

  if (!modelsConfig) {
    return handleError(res, { text: 'Models not loaded' });
  }

  const catalogKey = resolveModelCatalogKey(endpoint, modelsConfig);
  const availableModels = modelsConfig[catalogKey];
  if (!availableModels) {
    return handleError(res, { text: 'Endpoint models not loaded' });
  }

  let validModel = !!availableModels.find((availableModel) => availableModel === model);

  if (validModel) {
    return next();
  }

  /* A filter-managed endpoint serving no models is unavailable, not being
     asked for an illegal model — a violation would penalize users whose stored
     conversations name an endpoint that no longer serves them. */
  if (availableModels.length === 0 && filterManagedEndpoints(req.config).has(catalogKey)) {
    logger.debug(`[validateModel] "${endpoint}" has no models available; rejecting "${model}"`);
    return handleError(res, { text: 'Endpoint unavailable' });
  }

  const { ILLEGAL_MODEL_REQ_SCORE: score = 1 } = process.env ?? {};

  const type = ViolationTypes.ILLEGAL_MODEL_REQUEST;
  const errorMessage = {
    type,
  };

  await logViolation(req, res, type, errorMessage, score);
  return handleError(res, { text: 'Illegal model request' });
};

module.exports = validateModel;
