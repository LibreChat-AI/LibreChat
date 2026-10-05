require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const mongoose = require('mongoose');
const {
  createModels,
  runAsSystem,
  migrateScheduledOboGrantProvenance,
} = require('@librechat/data-schemas');
const connect = require('./connect');

(async () => {
  try {
    await connect();
    const { Token } = createModels(mongoose);
    const batch = process.argv.find((arg) => arg.startsWith('--batch-size='));
    const result = await runAsSystem(() =>
      migrateScheduledOboGrantProvenance(Token, {
        apply: process.argv.includes('--apply'),
        batchSize: batch ? Number(batch.slice('--batch-size='.length)) : undefined,
      }),
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    console.error('Scheduled OBO provenance inventory failed. No rollout approval.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
