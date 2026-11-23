require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const mongoose = require('mongoose');
const { repairAuthorizationDuplicates } = require('@librechat/data-schemas');

(async () => {
  // Preview is the default. Apply needs both an explicit mode and a write-gate acknowledgement.
  const args = process.argv.slice(2);
  const allowed = new Set(['--dry-run', '--apply', '--writers-paused']);
  if (
    args.some((arg) => !allowed.has(arg)) ||
    (args.includes('--apply') && args.includes('--dry-run')) ||
    (args.includes('--apply') && !args.includes('--writers-paused'))
  ) {
    console.error('Use --dry-run or --apply --writers-paused. See UPGRADING.md.');
    process.exitCode = 1;
    return;
  }
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is required');
    }
    // Maintenance owns one primary connection; do not import application bootstrapping or seeders.
    await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: false,
      autoCreate: false,
      readPreference: 'primary',
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 10_000,
    });
    const dryRun = !args.includes('--apply');
    const reports = await repairAuthorizationDuplicates(mongoose.connection, {
      dryRun,
      writersPaused: args.includes('--writers-paused'),
    });
    console.log(JSON.stringify({ dryRun, reports }));
    if (reports.some((report) => report.conflictingGroups > 0)) {
      process.exitCode = 2;
    }
  } catch {
    // Database errors may contain principal identities or source documents.
    console.error(
      'Authorization repair failed. Keep affected writes gated; rerun dry-run and inspect database state securely.',
    );
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
