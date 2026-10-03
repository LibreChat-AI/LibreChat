const path = require('path');
const { loadYaml, redactConfigSecretMaps, createCustomConfigLoader } = require('@librechat/api');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { syncCategories } = require('~/server/utils/agentCategory');

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'librechat.yaml');

const loadConfig = createCustomConfigLoader({
  loadLocal: loadYaml,
  defaultConfigPath,
  redactConfig: redactConfigSecretMaps,
});

async function loadCustomConfig(printConfig = true, options = {}) {
  const customConfig = await loadConfig(printConfig, options);
  if (!customConfig) {
    return customConfig;
  }

  // Injecting custom marketplace categories
  logger.info('Checking for custom marketplace categories to sync.');
  if (customConfig.interface?.marketplace?.use) {
    logger.info('Marketplace is enabled in config.');
    const marketplaceConfig = customConfig.interface.marketplace;
    if (marketplaceConfig.categories) {
      logger.info('Marketplace categories configuration found.');
      // enableDefaultCategories should be set as a boolean, defaulting to true if not specified
      const enableDefaultCategories =
        typeof marketplaceConfig.categories.enableDefaultCategories === 'boolean'
          ? marketplaceConfig.categories.enableDefaultCategories
          : true;
      const customCategoriesList = marketplaceConfig.categories.list;
      if (Array.isArray(customCategoriesList)) {
        logger.info(`Found ${customCategoriesList.length} custom categories to sync.`);
      } else {
        logger.info(
          'No custom categories `list` provided; only default-category toggling will run.',
        );
      }
      await runAsSystem(() => syncCategories(customCategoriesList, enableDefaultCategories));
    }
  }

  return customConfig;
}

module.exports = loadCustomConfig;
