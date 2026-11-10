#!/usr/bin/env node
require('dotenv').config();
require('module-alias/register');
const path = require('node:path');
require('module-alias').addAlias('~', path.resolve(__dirname, '../api'));
const { runPostgresCommand } = require('@librechat/api');
const { createModels } = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
runPostgresCommand({
  mongoose,
  createModels,
  connectDb: () => require('~/db').connectDb(),
  loadCustomConfig,
  args: process.argv.slice(2),
  env: process.env,
}).catch(() => {
  console.error('PostgreSQL operation failed. No automatic storage cutover was performed.');
  process.exitCode = 1;
});
