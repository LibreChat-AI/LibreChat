const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { ensureRequiredCollectionsExist } = require('@librechat/api');
const { AccessRoleIds, ResourceType, PrincipalType } = require('librechat-data-provider');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { grantPermission } = require('~/server/services/PermissionService');
const { findRoleByIdentifier } = require('~/models');
const { PromptGroup, AclEntry } = require('~/db/models');

const GLOBAL_PROJECT_NAME = 'instance';

/** Queries the raw `projects` collection (which may still exist in the DB even though the model is removed) */
async function getGlobalProjectPromptGroupIds(db) {
  const project = await db
    .collection('projects')
    .findOne({ name: GLOBAL_PROJECT_NAME }, { projection: { promptGroupIds: 1 } });
  return new Set((project?.promptGroupIds || []).map((id) => id.toString()));
}

async function migrateToPromptGroupPermissions({ dryRun = true, batchSize = 100 } = {}) {
  await connect();

  logger.info('Starting PromptGroup Permissions Migration', { dryRun, batchSize });

  const mongoose = require('mongoose');
  /** @type {import('mongoose').mongo.Db | undefined} */
  const db = mongoose.connection.db;
  if (db) {
    await ensureRequiredCollectionsExist(db);
  }

  const ownerRole = await findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_OWNER);
  const viewerRole = await findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);
  const editorRole = await findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_EDITOR);

  if (!ownerRole || !viewerRole || !editorRole) {
    throw new Error('Required promptGroup roles not found. Run role seeding first.');
  }

  const globalPromptGroupIds = db ? await getGlobalProjectPromptGroupIds(db) : new Set();

  logger.info(`Found ${globalPromptGroupIds.size} prompt groups in global project`);

  const migratedGroupIds = await AclEntry.distinct('resourceId', {
    resourceType: ResourceType.PROMPTGROUP,
    principalType: PrincipalType.USER,
  });

  const promptGroupsToMigrate = await PromptGroup.find({
    _id: { $nin: migratedGroupIds },
    author: { $exists: true, $ne: null },
    source: { $in: [null, 'native'] },
  })
    .select('_id name author authorName category')
    .lean();

  const categories = {
    globalViewAccess: [],
    privateGroups: [],
  };

  promptGroupsToMigrate.forEach((group) => {
    const isGlobalGroup = globalPromptGroupIds.has(group._id.toString());

    if (isGlobalGroup) {
      categories.globalViewAccess.push(group);
    } else {
      categories.privateGroups.push(group);
    }
  });

  logger.info(
    'PromptGroup categorization:\n' +
      JSON.stringify(
        {
          globalViewAccess: categories.globalViewAccess.length,
          privateGroups: categories.privateGroups.length,
          total: promptGroupsToMigrate.length,
        },
        null,
        2,
      ),
  );

  if (dryRun) {
    return {
      migrated: 0,
      errors: 0,
      dryRun: true,
      summary: {
        globalViewAccess: categories.globalViewAccess.length,
        privateGroups: categories.privateGroups.length,
        total: promptGroupsToMigrate.length,
      },
      details: {
        globalViewAccess: categories.globalViewAccess.map((g) => ({
          name: g.name,
          _id: g._id,
          category: g.category || 'uncategorized',
          permissions: 'Owner + Public VIEW',
        })),
        privateGroups: categories.privateGroups.map((g) => ({
          name: g.name,
          _id: g._id,
          category: g.category || 'uncategorized',
          permissions: 'Owner only',
        })),
      },
    };
  }

  const results = {
    migrated: 0,
    errors: 0,
    publicViewGrants: 0,
    ownerGrants: 0,
  };

  for (let i = 0; i < promptGroupsToMigrate.length; i += batchSize) {
    const batch = promptGroupsToMigrate.slice(i, i + batchSize);

    logger.info(
      `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(promptGroupsToMigrate.length / batchSize)}`,
    );

    for (const group of batch) {
      try {
        const isGlobalGroup = globalPromptGroupIds.has(group._id.toString());

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: group.author,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: group.author,
        });
        results.ownerGrants++;

        if (isGlobalGroup) {
          await grantPermission({
            principalType: PrincipalType.PUBLIC,
            principalId: null,
            resourceType: ResourceType.PROMPTGROUP,
            resourceId: group._id,
            accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
            grantedBy: group.author,
          });
          results.publicViewGrants++;
        }

        results.migrated++;
        logger.debug(
          `Migrated promptGroup "${group.name}" [${isGlobalGroup ? 'Global View' : 'Private'}]`,
          {
            groupId: group._id,
            author: group.author,
            isGlobalGroup,
          },
        );
      } catch (error) {
        results.errors++;
        logger.error(`Failed to migrate promptGroup "${group.name}"`, {
          groupId: group._id,
          author: group.author,
          error: error.message,
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info('PromptGroup migration completed', results);
  return results;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateToPromptGroupPermissions({ dryRun, batchSize })
    .then((result) => {
      if (dryRun) {
        console.log('\n=== DRY RUN RESULTS ===');
        console.log(`Total promptGroups to migrate: ${result.summary.total}`);
        console.log(`- Global View Access: ${result.summary.globalViewAccess} promptGroups`);
        console.log(`- Private PromptGroups: ${result.summary.privateGroups} promptGroups`);

        if (result.details.globalViewAccess.length > 0) {
          console.log('\nGlobal View Access promptGroups (first 10):');
          result.details.globalViewAccess.slice(0, 10).forEach((group, i) => {
            console.log(`  ${i + 1}. "${group.name}" [${group.category}] (${group._id})`);
          });
        }

        if (result.details.privateGroups.length > 0) {
          console.log('\nPrivate promptGroups (first 10):');
          result.details.privateGroups.slice(0, 10).forEach((group, i) => {
            console.log(`  ${i + 1}. "${group.name}" [${group.category}] (${group._id})`);
          });
        }

        console.log('\nTo run the actual migration, remove the --dry-run flag');
      } else {
        console.log('\nMigration Results:', JSON.stringify(result, null, 2));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('PromptGroup migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateToPromptGroupPermissions };
