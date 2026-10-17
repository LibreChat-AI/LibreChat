const { logger } = require('@librechat/data-schemas');
const {
  filterEndpointCatalog,
  getAppConfigOptionsFromUser,
  getUserEndpointAllowlist,
} = require('@librechat/api');
const { getAppConfig, loadDefaultModels, loadConfigModels } = require('~/server/services/Config');

const getModelsConfig = async (req) => {
  const [modelsConfig, appConfig] = await Promise.all([
    loadModels(req),
    req.config ?? getAppConfig(getAppConfigOptionsFromUser(req.user)),
  ]);
  const allowedEndpoints = getUserEndpointAllowlist(req.user, appConfig?.endpoints?.userAccess);
  return filterEndpointCatalog(modelsConfig, allowedEndpoints);
};

async function loadModels(req) {
  const [defaultModelsConfig, customModelsConfig] = await Promise.all([
    loadDefaultModels(req),
    loadConfigModels(req),
  ]);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

async function modelController(req, res) {
  try {
    const modelConfig = await getModelsConfig(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
