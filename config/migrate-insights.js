require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const path = require('path');
const mongoose = require('mongoose');
const { backfillInsightsAttribution } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');
require('~/db/models');

/**
 * Stores the root agent on messages and usage saved before Insights recorded it, after fixing
 * the root agent of legacy agent conversations. Idempotent; safe to run while the server is up.
 *
 * Usage: npm run migrate:insights [-- --dry-run] [-- --batch-size=1000]
 */
(async () => {
  let exitCode = 0;
  try {
    await connect();
    const dryRun = process.argv.includes('--dry-run');
    const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
    const batchSize = (batchArg && parseInt(batchArg.split('=')[1], 10)) || 1000;
    const results = {};
    for (const collection of ['conversations', 'messages', 'transactions']) {
      const totals = { processed: 0, updated: 0 };
      let after;
      do {
        const result = await backfillInsightsAttribution(mongoose, {
          collection,
          batchSize,
          after,
          apply: !dryRun,
        });
        totals.processed += result.processed;
        totals.updated += result.updated;
        after = result.nextAfter;
      } while (after);
      results[collection] = totals;
    }
    console.log(JSON.stringify({ dryRun, ...results }, null, 2));
  } catch (error) {
    console.error('Insights migration failed:', error);
    exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
  /** Exit explicitly: with Redis enabled, the cache clients opened on connect keep the process alive. */
  process.exit(exitCode);
})();
