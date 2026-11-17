require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const mongoose = require('mongoose');
const { migrateMCPReservationIndex } = require('@librechat/data-schemas');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !process.argv.includes('--writers-upgraded')) {
    console.error(
      'Refusing migration: first upgrade every writer to tenant-aware MCP reservations, then pass --writers-upgraded. See UPGRADING.md.',
    );
    process.exitCode = 1;
    return;
  }
  try {
    const connect = require('./connect');
    await connect();
    const result = await migrateMCPReservationIndex(mongoose.connection, { dryRun });
    console.log({ dryRun, ...result });
  } catch (error) {
    console.error('MCP reservation index migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
