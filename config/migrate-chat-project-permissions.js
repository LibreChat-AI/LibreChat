const path = require('path');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { ensureRequiredCollectionsExist } = require('@librechat/api');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { findRoleByIdentifier } = require('~/models');
const { ChatProject, AclEntry } = require('~/db/models');

/**
 * String literals matching `librechat-data-provider` enums so this script
 * runs standalone without requiring a built data-provider package.
 */
const RESOURCE_TYPE_CHAT_PROJECT = 'chatProject';
const ROLE_ID_OWNER = 'chatProject_owner';
const PRINCIPAL_USER = 'user';

/**
 * Grants each existing Chat Project's creator the `chatProject_owner` ACL role. Projects made
 * before sharing existed have no ACL entry; their owners keep full access through the project
 * itself, but cannot open the share dialog until this backfill runs. Idempotent.
 */
async function migrateChatProjectPermissions({ dryRun = true, batchSize = 100 } = {}) {
  await connect();

  return runAsSystem(async () => {
    logger.info('Starting Chat Project Permissions Migration', { dryRun, batchSize });

    const mongoose = require('mongoose');
    /** @type {import('mongoose').mongo.Db | undefined} */
    const db = mongoose.connection.db;
    if (db) {
      await ensureRequiredCollectionsExist(db);
    }

    const ownerRole = await findRoleByIdentifier(ROLE_ID_OWNER);
    if (!ownerRole) {
      throw new Error(
        'Required chatProject role not found (chatProject_owner). Run role seeding first.',
      );
    }

    const ownedFilter = { user: { $type: 'string', $regex: /^[a-f\d]{24}$/i } };
    const totalProjects = await ChatProject.countDocuments({});
    const migratableProjects = await ChatProject.countDocuments(ownedFilter);
    /** The owner role is never granted to anyone but the creator, so each entry is one
     *  already-migrated project. */
    const alreadyMigrated = await AclEntry.countDocuments({
      resourceType: RESOURCE_TYPE_CHAT_PROJECT,
      principalType: PRINCIPAL_USER,
      roleId: ownerRole._id,
    });
    logger.info(`Found ${totalProjects} Chat Projects total`, {
      migratableProjects,
      alreadyMigrated,
    });

    if (dryRun) {
      return {
        migrated: 0,
        errors: 0,
        dryRun: true,
        summary: {
          totalProjects,
          migratableProjects,
          skippedNonObjectIdOwner: totalProjects - migratableProjects,
          alreadyMigrated,
        },
      };
    }

    const results = { migrated: 0, ownerGrants: 0, errors: 0, failedProjectIds: [] };
    const cursor = ChatProject.find(ownedFilter).select('_id user tenantId').lean().cursor();

    async function processBatch(projects) {
      const now = new Date();
      const bulkOps = projects.map((project) => {
        const ownerId = new mongoose.Types.ObjectId(project.user);
        return {
          updateOne: {
            filter: {
              resourceType: RESOURCE_TYPE_CHAT_PROJECT,
              resourceId: project._id,
              principalType: PRINCIPAL_USER,
              principalId: ownerId,
            },
            update: {
              $set: {
                permBits: ownerRole.permBits,
                roleId: ownerRole._id,
                grantedBy: ownerId,
                grantedAt: now,
              },
              $setOnInsert: {
                principalModel: 'User',
                ...(project.tenantId && { tenantId: project.tenantId }),
              },
            },
            upsert: true,
          },
        };
      });

      try {
        const bulkResult = await AclEntry.bulkWrite(bulkOps, { ordered: false });
        results.ownerGrants += bulkResult.upsertedCount;
        results.migrated += projects.length;
      } catch (error) {
        const failed = error.writeErrors?.map((writeError) => writeError.index) ?? [];
        const failedIndexes = failed.length > 0 ? new Set(failed) : null;
        projects.forEach((project, index) => {
          if (failedIndexes == null || failedIndexes.has(index)) {
            results.errors++;
            results.failedProjectIds.push(project._id.toString());
          } else {
            results.migrated++;
          }
        });
        logger.error('Failed to grant Chat Project owner permissions in bulk', {
          error: error.message,
        });
      }
    }

    let batch = [];
    for await (const project of cursor) {
      batch.push(project);
      if (batch.length >= batchSize) {
        await processBatch(batch);
        batch = [];
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (batch.length > 0) {
      await processBatch(batch);
    }

    logger.info('Chat Project migration completed', results);
    return results;
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateChatProjectPermissions({ dryRun, batchSize })
    .then((result) => {
      if (dryRun) {
        console.log('\n=== DRY RUN RESULTS ===');
        console.log(`Total Chat Projects: ${result.summary.totalProjects}`);
        console.log(`- Owned by a user id: ${result.summary.migratableProjects}`);
        console.log(`- Skipped (owner is not a user id): ${result.summary.skippedNonObjectIdOwner}`);
        console.log(`Already migrated (OWNER AclEntries): ${result.summary.alreadyMigrated}`);
        console.log('\nTo run the actual migration, remove the --dry-run flag');
      } else {
        console.log('\n=== MIGRATION RESULTS ===');
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Chat Project migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateChatProjectPermissions };
