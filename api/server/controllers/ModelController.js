const { logger } = require('@librechat/data-schemas');
const {
  loadDefaultModels,
  loadConfigModels,
  getConfigGenerationForConfig,
} = require('~/server/services/Config');
const { CONFIG_GENERATION_HEADER } = require('librechat-data-provider');

const getModelsConfig = (req) => loadModels(req);

async function loadModels(req) {
  const [defaultModelsConfig, customModelsConfig] = await Promise.all([
    loadDefaultModels(req),
    loadConfigModels(req),
  ]);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

async function modelController(req, res) {
  try {
    const modelConfig = await loadModels(req);
    res.set(CONFIG_GENERATION_HEADER, getConfigGenerationForConfig(req.config));
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
