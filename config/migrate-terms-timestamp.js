const path = require('path');
const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
const { countUsers } = require('@librechat/data-schemas').createMethods(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

/**
 * Migration script for Terms Acceptance Timestamp Tracking
 *
 * This script migrates existing users who have termsAccepted: true but no termsAcceptedAt timestamp.
 * For these users, it sets termsAcceptedAt to their account creation date (createdAt) as a fallback.
 *
 * Usage: npm run migrate:terms-timestamp
 */
(async () => {
  await connect();

  console.purple('--------------------------');
  console.purple('Migrate Terms Acceptance Timestamps');
  console.purple('--------------------------');

  // Count users that need migration. This script spans every tenant, so run
  // it under system context or the tenant isolation plugin throws under
  // TENANT_ISOLATION_STRICT=true and scopes to a non-existent tenant otherwise.
  const usersToMigrate = await runAsSystem(() =>
    countUsers({
      termsAccepted: true,
      $or: [{ termsAcceptedAt: null }, { termsAcceptedAt: { $exists: false } }],
    }),
  );

  if (usersToMigrate === 0) {
    console.green(
      'No users need migration. All users with termsAccepted: true already have a termsAcceptedAt timestamp.',
    );
    silentExit(0);
  }

  console.yellow(
    `Found ${usersToMigrate} user(s) with termsAccepted: true but no termsAcceptedAt timestamp.`,
  );
  console.yellow(
    'These users will have their termsAcceptedAt set to their account creation date (createdAt).',
  );

  const confirm = await askQuestion('Are you sure you want to proceed? (y/n): ');

  if (confirm.toLowerCase() !== 'y') {
    console.yellow('Operation cancelled.');
    silentExit(0);
  }

  try {
    // Scan and update across every tenant under system context, matching the
    // other cross-tenant migrations, so the tenant isolation plugin does not
    // throw or scope queries to a non-existent tenant.
    await runAsSystem(async () => {
      const cursor = User.find({
        termsAccepted: true,
        $or: [{ termsAcceptedAt: null }, { termsAcceptedAt: { $exists: false } }],
      }).cursor();

      let migratedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for await (const user of cursor) {
        try {
          // Use createdAt as fallback for termsAcceptedAt
          const termsAcceptedAt = user.createdAt || new Date();
          if (!user.createdAt) {
            console.yellow(
              `Warning: User ${user._id} has no createdAt, using current date for termsAcceptedAt`,
            );
          }
          // Only backfill users who are still accepted and have no timestamp.
          // If they accept through the API or get reset between the cursor read
          // and this write, the filter no longer matches and their state is kept.
          const result = await User.updateOne(
            {
              _id: user._id,
              termsAccepted: true,
              $or: [{ termsAcceptedAt: null }, { termsAcceptedAt: { $exists: false } }],
            },
            { $set: { termsAcceptedAt } },
          );

          if (result.modifiedCount > 0) {
            migratedCount++;
            if (migratedCount % 100 === 0) {
              console.yellow(`Migrated ${migratedCount} users...`);
            }
          } else {
            skippedCount++;
          }
        } catch (error) {
          console.red(`Error migrating user ${user._id}: ${error.message}`);
          errorCount++;
        }
      }

      console.green(`Migration complete!`);
      console.green(`Successfully migrated: ${migratedCount} user(s)`);
      if (skippedCount > 0) {
        console.yellow(
          `Skipped ${skippedCount} user(s) whose terms state changed during migration.`,
        );
      }
      if (errorCount > 0) {
        console.red(`Errors encountered: ${errorCount}`);
        silentExit(1);
      }
    });
  } catch (error) {
    console.red('Error during migration:', error);
    silentExit(1);
  }

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
