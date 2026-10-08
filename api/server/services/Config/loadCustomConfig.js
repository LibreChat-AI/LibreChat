const path = require('path');
const { loadYaml, redactConfigSecretMaps, createCustomConfigLoader } = require('@librechat/api');

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultConfigPath = path.resolve(projectRoot, 'librechat.yaml');

module.exports = createCustomConfigLoader({
  loadLocal: loadYaml,
  defaultConfigPath,
  redactConfig: redactConfigSecretMaps,
});
