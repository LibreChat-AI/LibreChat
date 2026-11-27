const path = require('path');
const apiConfig = require('../api/jest.config');

const apiDir = path.resolve(__dirname, '..', 'api');

const resolvedMapper = Object.fromEntries(
  Object.entries(apiConfig.moduleNameMapper).map(([key, value]) => [
    key,
    value.replace('<rootDir>', apiDir),
  ]),
);

module.exports = {
  ...apiConfig,
  roots: ['<rootDir>'],
  setupFiles: apiConfig.setupFiles.map((f) => path.resolve(apiDir, f)),
  moduleNameMapper: resolvedMapper,
};
