const path = require('path');
const { FileContext } = require('librechat-data-provider');
const { logger, runAsSystem } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { File } = require('~/db/models');

/**
 * Cap on the number of per-group entries retained in `results.details`. Larger
 * runs still rename every affected record and still report accurate aggregate
 * counts — we just stop accumulating sample data past this threshold to keep
 * memory bounded on deployments with thousands of legacy duplicates.
 */
const DETAIL_SAMPLE_LIMIT = 50;

/** Mirrors the unique partial index declared on the file schema. */
const INDEX_KEYS = { filename: 1, conversationId: 1, context: 1, tenantId: 1 };
const INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: { context: FileContext.execute_code },
};

/** `report.png` -> `report (2).png`; a name without an extension keeps its shape. */
function suffixFilename(filename, n) {
  const extension = path.extname(filename);
  const base = extension ? filename.slice(0, -extension.length) : filename;
  return `${base} (${n})${extension}`;
}

/**
 * Picks a name that is free within the group's uniqueness scope. `taken` holds
 * both the names already in the database and the ones handed out earlier in
 * this run, so a group with several duplicates can't rename two records onto
 * the same replacement.
 */
function nextAvailableName(filename, taken) {
  for (let n = 1; ; n++) {
    const candidate = suffixFilename(filename, n);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Normalizes code-execution output files that share a filename within one
 * conversation, so the unique partial index on
 * `(filename, conversationId, context, tenantId)` can finish building.
 *
 * That index arrived with atomic file claiming: a regenerated output now
 * converges on ONE record with a cache-busted filepath. Records written before
 * that change instead inserted a second document per regeneration, so any
 * deployment that re-ran a code cell producing the same filename carries
 * duplicates the index cannot span. Mongo then aborts the build with E11000 and
 * the constraint is silently absent — the claim path keeps working, but without
 * its database-level guarantee against concurrent inserts.
 *
 * Renames rather than deletes: every duplicate is a distinct stored object,
 * usually still referenced by a message attachment, so removing one would
 * strip a real artifact out of a user's history. The newest record keeps the
 * canonical name (matching the "latest write wins" behavior of the claim path);
 * older ones gain a ` (n)` suffix. Attachments carry their own filename copy,
 * so rendered history is untouched.
 *
 * Safe to re-run — once each scope is unique, nothing is written.
 *
 * @param {{ dryRun?: boolean, batchSize?: number }} [options]
 */
async function migrateCodeFileDuplicates({ dryRun = true, batchSize = 100 } = {}) {
  await connect();

  logger.info('Starting Code File Duplicate Migration', { dryRun, batchSize });

  /*
   * Scan and heal across every tenant. Without this wrapper the tenant
   * isolation plugin either scopes queries to a (non-existent) tenant or
   * throws under TENANT_ISOLATION_STRICT=true, making the script unusable as
   * the intended remediation path.
   */
  return runAsSystem(async () => {
    const results = {
      dryRun,
      scannedFiles: 0,
      duplicateGroups: 0,
      filesRenamed: 0,
      indexBuilt: false,
      errors: 0,
      details: [],
    };

    results.scannedFiles = await File.countDocuments({ context: FileContext.execute_code });
    logger.info(`Scanning ${results.scannedFiles} code-execution file(s) for duplicates`);

    const groups = await File.aggregate([
      { $match: { context: FileContext.execute_code } },
      {
        $group: {
          _id: {
            filename: '$filename',
            conversationId: '$conversationId',
            tenantId: '$tenantId',
          },
          count: { $sum: 1 },
          files: { $push: { _id: '$_id', file_id: '$file_id', createdAt: '$createdAt' } },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).option({ batchSize });

    results.duplicateGroups = groups.length;

    for (const group of groups) {
      try {
        /* Newest first: it keeps the canonical name, older copies get suffixed. */
        const ordered = [...group.files].sort(
          (a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0),
        );
        const [, ...stale] = ordered;

        /* Reserve every name already used in this uniqueness scope, so a
         * suffixed replacement can't collide with an unrelated record that
         * happens to be called `report (1).png` already. */
        const scopeNames = await File.find(
          {
            context: FileContext.execute_code,
            conversationId: group._id.conversationId ?? null,
            tenantId: group._id.tenantId ?? null,
          },
          { filename: 1, _id: 0 },
        ).lean();
        const taken = new Set(scopeNames.map((file) => file.filename));

        const renames = stale.map((file) => ({
          file_id: file.file_id,
          _id: file._id,
          from: group._id.filename,
          to: nextAvailableName(group._id.filename, taken),
        }));

        if (!dryRun) {
          for (const rename of renames) {
            await File.updateOne({ _id: rename._id }, { $set: { filename: rename.to } });
          }
        }

        results.filesRenamed += renames.length;
        if (results.details.length < DETAIL_SAMPLE_LIMIT) {
          results.details.push({
            filename: group._id.filename,
            conversationId: group._id.conversationId,
            count: group.count,
            renames: renames.map(({ file_id, to }) => ({ file_id, to })),
          });
        }
      } catch (error) {
        results.errors++;
        logger.error(
          `Failed to normalize duplicates for "${group._id.filename}" in conversation ${group._id.conversationId}: ${error.message}`,
        );
      }
    }

    /*
     * Build the index here rather than waiting for the next boot: the operator
     * ran this to fix a failing build, so they should learn immediately whether
     * it now succeeds. Targeted `createIndex` (not `syncIndexes`, which would
     * drop indexes absent from the schema).
     */
    if (!dryRun && results.errors === 0) {
      try {
        await File.collection.createIndex(INDEX_KEYS, { ...INDEX_OPTIONS, background: true });
        results.indexBuilt = true;
      } catch (error) {
        results.errors++;
        logger.error(
          `Duplicates normalized but the unique index still failed to build: ${error.message}`,
        );
      }
    }

    logger.info('Code File Duplicate Migration completed', {
      dryRun,
      scannedFiles: results.scannedFiles,
      duplicateGroups: results.duplicateGroups,
      filesRenamed: results.filesRenamed,
      indexBuilt: results.indexBuilt,
      errors: results.errors,
    });

    return results;
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateCodeFileDuplicates({ dryRun, batchSize })
    .then((result) => {
      console.log(`\n=== ${dryRun ? 'DRY RUN ' : ''}RESULTS ===`);
      console.log(`Code files scanned: ${result.scannedFiles}`);
      console.log(`Duplicate groups: ${result.duplicateGroups}`);
      console.log(`Files ${dryRun ? 'to rename' : 'renamed'}: ${result.filesRenamed}`);
      if (!dryRun && result.duplicateGroups > 0) {
        console.log(`Unique index built: ${result.indexBuilt ? 'yes' : 'no'}`);
      }
      if (result.errors > 0) {
        console.log(`Errors: ${result.errors}`);
      }
      if (result.details.length > 0) {
        console.log('\nAffected files:');
        result.details.forEach((d, i) => {
          console.log(
            `  ${i + 1}. "${d.filename}" in ${d.conversationId} — ${d.count} copies, ${d.renames.length} renamed`,
          );
          d.renames.forEach((r) => console.log(`       ${r.file_id} -> "${r.to}"`));
        });
        if (result.duplicateGroups > result.details.length) {
          console.log(
            `  ... and ${result.duplicateGroups - result.details.length} more (sample capped at ${DETAIL_SAMPLE_LIMIT})`,
          );
        }
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('Code file duplicate migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateCodeFileDuplicates };
