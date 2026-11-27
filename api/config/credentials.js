require('dotenv').config();

const { bootstrapCredentials } = require('@librechat/api/credentials');

module.exports = bootstrapCredentials();
