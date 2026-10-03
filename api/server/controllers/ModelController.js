const { loadModelsResponse } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { loadDefaultModels, loadConfigModels } = require('~/server/services/Config');

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
    const modelConfig = await loadModelsResponse(req, {
      loadDefaultModels,
      loadConfigModels,
    });

    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
