const { getTenantId } = require('@librechat/data-schemas');
const {
  createImportDefaults,
  FALLBACK_MODEL_BY_ENDPOINT,
  pickFirstConfiguredModel,
} = require('@librechat/api');
const { getModelsConfig } = require('~/server/controllers/ModelController');

module.exports = {
  FALLBACK_MODEL_BY_ENDPOINT,
  pickFirstConfiguredModel,
  ...createImportDefaults({ getModelsConfig, getTenantId }),
};
