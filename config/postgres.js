#!/usr/bin/env node
require('dotenv').config();
require('module-alias/register');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../api'));
const { runPostgresCommand } = require('@librechat/api');
const mongoose = require('mongoose');
const { createMongoFavoriteStore, createPostgresDatabase } = require('@librechat/data-schemas');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
runPostgresCommand({
  favorites: createMongoFavoriteStore(mongoose),
  createDatabase: createPostgresDatabase,
  connectDb: () => mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false }),
  disconnectDb: () => mongoose.disconnect(),
  loadCustomConfig,
  args: process.argv.slice(2),
  env: process.env,
}).catch(() => {
  console.error('PostgreSQL operation failed. No automatic storage cutover was performed.');
  process.exitCode = 1;
});
