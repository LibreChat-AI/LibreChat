#!/usr/bin/env node
require('dotenv').config();
require('module-alias/register');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../api'));
const mongoose = require('mongoose');
const {
  createPostgresDatabase,
  createMongoAuthenticationSource,
} = require('@librechat/data-schemas');
const { runAuthenticationCommand } = require('@librechat/api');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
runAuthenticationCommand({
  args: process.argv.slice(2),
  env: process.env,
  source: createMongoAuthenticationSource(mongoose),
  createDatabase: createPostgresDatabase,
  connectDb: () => mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false }),
  disconnectDb: () => mongoose.disconnect(),
  loadCustomConfig,
}).catch(() => {
  console.error('Authentication migration failed. No automatic storage cutover was performed.');
  process.exitCode = 1;
});
