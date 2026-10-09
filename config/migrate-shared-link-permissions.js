const path = require('path');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { ensureRequiredCollectionsExist } = require('@librechat/api');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { findRoleByIdentifier } = require('~/models');
const { SharedLink, AclEntry } = require('~/db/models');

/**
 * String literals matching `librechat-data-provider` enums so this script
 * runs standalone without requiring a built data-provider package.
 */
const RESOURCE_TYPE_SHARED_LINK = 'sharedLink';
const ROLE_ID_OWNER = 'sharedLink_owner';
const ROLE_ID_VIEWER = 'sharedLink_viewer';
const PRINCIPAL_USER = 'user';
const PRINCIPAL_PUBLIC = 'public';

async function migrateSharedLinkPermissions({
  dryRun = true,
  batchSize = 100,
  force = false,
} = {}) {
  await connect();

  return runAsSystem(async () => {
    logger.info('Starting SharedLink Permissions Migration', { dryRun, batchSize, force });

    const mongoose = require('mongoose');
    /** @type {import('mongoose').mongo.Db | undefined} */
    const db = mongoose.connection.db;
    if (db) {
      await ensureRequiredCollectionsExist(db);
    }

    const ownerRole = await findRoleByIdentifier(ROLE_ID_OWNER);
    const viewerRole = await findRoleByIdentifier(ROLE_ID_VIEWER);

    if (!ownerRole || !viewerRole) {
      throw new Error(
        'Required sharedLink roles not found (sharedLink_owner, sharedLink_viewer). Run role seeding first.',
      );
    }

    logger.info('Roles resolved', {
      owner: { id: ownerRole._id, permBits: ownerRole.permBits },
      viewer: { id: viewerRole._id, permBits: viewerRole.permBits },
    });

    // --- Safety check: abort if isPublic: false documents exist (unless --force) ---
    // Raw driver bypasses mongoose strictQuery: true, which silently strips query
    // keys absent from the schema. isPublic was removed from the schema by this
    // migration, so Mongoose queries like { isPublic: false } become {} (match all).
    const rawCollection = mongoose.connection.db.collection('sharedlinks');
    const isPublicFalseCount = await rawCollection.countDocuments({ isPublic: false });
    if (!dryRun && isPublicFalseCount > 0 && !force) {
      const sample = await rawCollection
        .find({ isPublic: false })
        .project({ _id: 1, shareId: 1, user: 1 })
        .limit(20)
        .toArray();

      const sampleIds = sample.map((doc) => doc._id.toString());
      logger.error(
        `Found ${isPublicFalseCount} SharedLink documents with isPublic: false. ` +
          'These may have been intentionally marked non-public. ' +
          'Use --force to proceed anyway (they will NOT receive a PUBLIC VIEWER grant).',
        { sampleIds },
      );
      return {
        aborted: true,
        reason: 'isPublic: false documents found',
        isPublicFalseCount,
        sampleIds,
      };
    }

    // --- Count totals for progress reporting ---
    const totalLinks = await SharedLink.countDocuments({});
    logger.info(`Found ${totalLinks} SharedLink documents total`);

    if (totalLinks === 0) {
      logger.info('No SharedLink documents to migrate');
      return { migrated: 0, errors: 0, skipped: 0, dryRun };
    }

    // --- Dry run: scan and categorize ---
    if (dryRun) {
      const withUser = await SharedLink.countDocuments({ user: { $exists: true, $ne: null } });
      const withoutUser = await SharedLink.countDocuments({
        $or: [{ user: { $exists: false } }, { user: null }],
      });
      const withIsPublicTrue = await rawCollection.countDocuments({ isPublic: true });
      const withIsPublicFalse = isPublicFalseCount;
      const withIsPublicField = await rawCollection.countDocuments({ isPublic: { $exists: true } });

      const alreadyMigratedOwner = await AclEntry.countDocuments({
        resourceType: RESOURCE_TYPE_SHARED_LINK,
        principalType: PRINCIPAL_USER,
      });
      const alreadyMigratedPublic = await AclEntry.countDocuments({
        resourceType: RESOURCE_TYPE_SHARED_LINK,
        principalType: PRINCIPAL_PUBLIC,
      });

      return {
        migrated: 0,
        errors: 0,
        dryRun: true,
        summary: {
          totalLinks,
          withUser,
          withoutUser,
          withIsPublicTrue,
          withIsPublicFalse,
          withIsPublicField,
          alreadyMigratedOwner,
          alreadyMigratedPublic,
        },
      };
    }

    // --- Live migration: cursor-based batch processing ---
    const failedLinkIds = new Set();

    const results = {
      migrated: 0,
      errors: 0,
      skipped: 0,
      ownerGrants: 0,
      ownerSkipped: 0,
      publicViewerGrants: 0,
      publicViewerSkipped: 0,
      missingUserWarnings: 0,
    };

    const cursor = SharedLink.find({})
      .select('_id user isPublic tenantId expiredAt')
      .lean()
      .cursor();

    let batch = [];
    let batchIndex = 0;

    /**
     * Process a single batch of SharedLink documents.
     * Collects upsert operations into a single bulkWrite for efficiency.
     * Tracks which op indices map to which link IDs so write failures
     * can be attributed to specific links.
     */
    async function processBatch(links) {
      const bulkOps = [];
      const opIndexToLinkId = [];

      for (const link of links) {
        const linkId = link._id;
        const userId = link.user;
        const tenantId = link.tenantId;
        const expiredAt = link.expiredAt;
        const now = new Date();

        if (userId) {
          opIndexToLinkId.push(linkId);
          bulkOps.push({
            updateOne: {
              filter: {
                resourceType: RESOURCE_TYPE_SHARED_LINK,
                resourceId: linkId,
                principalType: PRINCIPAL_USER,
                principalId: new mongoose.Types.ObjectId(userId),
              },
              update: {
                $set: {
                  permBits: ownerRole.permBits,
                  roleId: ownerRole._id,
                  grantedBy: new mongoose.Types.ObjectId(userId),
                  grantedAt: now,
                  ...(expiredAt && { expiredAt }),
                },
                $setOnInsert: {
                  principalModel: 'User',
                  ...(tenantId && { tenantId }),
                },
              },
              upsert: true,
            },
          });
        } else {
          results.missingUserWarnings++;
          logger.warn('SharedLink has no user field, skipping OWNER grant', {
            linkId: linkId.toString(),
          });
        }

        const hasIsPublic = link.isPublic !== undefined;
        if (hasIsPublic && link.isPublic === false) {
          results.publicViewerSkipped++;
        } else if (hasIsPublic) {
          const publicUpdateSet = {
            permBits: viewerRole.permBits,
            roleId: viewerRole._id,
            grantedAt: now,
            ...(expiredAt && { expiredAt }),
          };
          if (userId) {
            publicUpdateSet.grantedBy = new mongoose.Types.ObjectId(userId);
          }

          opIndexToLinkId.push(linkId);
          bulkOps.push({
            updateOne: {
              filter: {
                resourceType: RESOURCE_TYPE_SHARED_LINK,
                resourceId: linkId,
                principalType: PRINCIPAL_PUBLIC,
              },
              update: {
                $set: publicUpdateSet,
                $setOnInsert: {
                  ...(tenantId && { tenantId }),
                },
              },
              upsert: true,
            },
          });
        }

        results.migrated++;
      }

      if (bulkOps.length > 0) {
        try {
          const bulkResult = await AclEntry.bulkWrite(bulkOps, { ordered: false });
          results.ownerGrants += bulkResult.upsertedCount;
        } catch (error) {
          if (error.writeErrors) {
            results.errors += error.writeErrors.length;
            for (const writeError of error.writeErrors) {
              const failedId = opIndexToLinkId[writeError.index];
              if (failedId) {
                failedLinkIds.add(failedId);
              }
              logger.error('Failed to migrate SharedLink in bulk', {
                error: writeError.errmsg,
                linkId: failedId?.toString(),
              });
            }
          } else {
            results.errors += links.length;
            for (const link of links) {
              failedLinkIds.add(link._id);
            }
            logger.error('Bulk write failed entirely', { error: error.message });
          }
        }
      }
    }

    for await (const doc of cursor) {
      batch.push(doc);

      if (batch.length >= batchSize) {
        batchIndex++;
        const totalBatches = Math.ceil(totalLinks / batchSize);

        if (batchIndex % 5 === 0 || batchIndex === 1) {
          logger.info(`Processing batch ${batchIndex}/${totalBatches}`, {
            migrated: results.migrated,
            errors: results.errors,
          });
        }

        await processBatch(batch);
        batch = [];
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Process remaining documents
    if (batch.length > 0) {
      batchIndex++;
      const totalBatches = Math.ceil(totalLinks / batchSize);
      logger.info(`Processing final batch ${batchIndex}/${totalBatches}`, {
        remaining: batch.length,
      });
      await processBatch(batch);
    }

    // --- $unset isPublic only from successfully migrated documents ---
    const unsetFilter = { isPublic: { $exists: true } };
    if (failedLinkIds.size > 0) {
      unsetFilter._id = { $nin: [...failedLinkIds] };
      logger.warn(
        `Skipping isPublic removal for ${failedLinkIds.size} links with failed ACL grants`,
        { failedLinkIds: [...failedLinkIds].map((id) => id.toString()) },
      );
    }

    logger.info('Removing isPublic field from successfully migrated SharedLink documents...');
    const unsetResult = await rawCollection.updateMany(unsetFilter, { $unset: { isPublic: 1 } });
    logger.info(`Removed isPublic field from ${unsetResult.modifiedCount} documents`);

    results.isPublicFieldsRemoved = unsetResult.modifiedCount;
    results.failedLinkCount = failedLinkIds.size;

    logger.info('SharedLink migration completed', results);
    return results;
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateSharedLinkPermissions({ dryRun, batchSize, force })
    .then((result) => {
      if (result.aborted) {
        console.log('\n=== MIGRATION ABORTED ===');
        console.log(`Reason: ${result.reason}`);
        console.log(`Documents with isPublic: false: ${result.isPublicFalseCount}`);
        console.log(`Sample IDs: ${result.sampleIds.join(', ')}`);
        console.log('\nUse --force to proceed anyway');
        process.exit(1);
      }

      if (dryRun) {
        console.log('\n=== DRY RUN RESULTS ===');
        console.log(`Total SharedLink documents: ${result.summary.totalLinks}`);
        console.log(`- With user field: ${result.summary.withUser}`);
        console.log(`- Without user field: ${result.summary.withoutUser}`);
        console.log(`- With isPublic: true: ${result.summary.withIsPublicTrue}`);
        console.log(`- With isPublic: false: ${result.summary.withIsPublicFalse}`);
        console.log(`- With isPublic field present: ${result.summary.withIsPublicField}`);
        console.log(
          `\nAlready migrated (OWNER AclEntries): ${result.summary.alreadyMigratedOwner}`,
        );
        console.log(
          `Already migrated (PUBLIC AclEntries): ${result.summary.alreadyMigratedPublic}`,
        );
        console.log('\nTo run the actual migration, remove the --dry-run flag');
      } else {
        console.log('\n=== MIGRATION RESULTS ===');
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('SharedLink migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateSharedLinkPermissions };
