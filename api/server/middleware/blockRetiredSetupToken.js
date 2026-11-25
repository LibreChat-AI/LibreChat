const { createBlockRetiredSetupToken } = require('@librechat/api');
const { getUserById } = require('~/models');

module.exports = createBlockRetiredSetupToken({ getUserById });
