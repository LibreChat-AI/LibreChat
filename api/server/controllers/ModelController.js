const { logger } = require('@librechat/data-schemas');
const { getModelsConfig } = require('~/server/services/Config');

async function modelController(req, res) {
  try {
    const modelConfig = await getModelsConfig(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, getModelsConfig };
