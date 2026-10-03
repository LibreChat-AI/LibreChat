require('dotenv').config();
const mongoose = require('mongoose');
const { backfillSearchTokens } = require('@librechat/data-schemas');
const connect = require('./connect');

/**
 * Backfills the word-prefix search tokens on users and groups saved before they existed.
 * Idempotent; safe to run while the server is up.
 *
 * Usage: npm run migrate:search-tokens [-- --dry-run] [-- --batch-size=500]
 */
(async () => {
  try {
    await connect();
    const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
    const result = await backfillSearchTokens(mongoose.connection, {
      dryRun: process.argv.includes('--dry-run'),
      batchSize: batchArg ? parseInt(batchArg.split('=')[1], 10) || undefined : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error('Search token migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
