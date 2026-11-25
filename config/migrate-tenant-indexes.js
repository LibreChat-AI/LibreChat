require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const mongoose = require('mongoose');
const { migrateTenantIndexes } = require('@librechat/data-schemas');
const connect = require('./connect');

(async () => {
  try {
    await connect();
    const result = await migrateTenantIndexes(mongoose.connection, {
      dryRun: process.argv.includes('--dry-run'),
    });
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error('Tenant index migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
