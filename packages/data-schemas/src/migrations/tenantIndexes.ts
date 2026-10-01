import type { IndexSpecification } from 'mongodb';
import type { Connection } from 'mongoose';
import conversationTagSchema from '~/schema/conversationTag';
import skillSyncStatusSchema from '~/schema/skillSyncStatus';
import agentCategorySchema from '~/schema/agentCategory';
import { buildIndexWithRetry } from '~/utils/retry';
import accessRoleSchema from '~/schema/accessRole';
import mcpServerSchema from '~/schema/mcpServer';
import messageSchema from '~/schema/message';
import presetSchema from '~/schema/preset';
import agentSchema from '~/schema/agent';
import convoSchema from '~/schema/convo';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';
import roleSchema from '~/schema/role';
import fileSchema from '~/schema/file';
import logger from '~/config/winston';

const TENANT_SCHEMAS = {
  users: userSchema,
  roles: roleSchema,
  agents: agentSchema,
  conversations: convoSchema,
  messages: messageSchema,
  presets: presetSchema,
  agentcategories: agentCategorySchema,
  accessroles: accessRoleSchema,
  conversationtags: conversationTagSchema,
  mcpservers: mcpServerSchema,
  files: fileSchema,
  groups: groupSchema,
  skillsyncstatuses: skillSyncStatusSchema,
};

/**
 * Indexes that were superseded by compound tenant-scoped indexes.
 * Each entry maps a collection name to the old index names that must be dropped
 * before multi-tenancy can function (old unique indexes enforce global uniqueness,
 * blocking same-value-different-tenant writes).
 *
 * These are only the indexes whose uniqueness constraints conflict with multi-tenancy.
 * Non-unique indexes that were extended with tenantId are harmless (queries still work,
 * just with slightly less optimal plans) and are not included here.
 */
const SUPERSEDED_INDEXES: Record<string, string[]> = {
  users: [
    'email_1',
    'googleId_1',
    'facebookId_1',
    'openidId_1',
    'openidId_1_tenantId_1',
    'samlId_1',
    'ldapId_1',
    'githubId_1',
    'discordId_1',
    'appleId_1',
  ],
  roles: ['name_1'],
  agents: ['id_1'],
  conversations: ['conversationId_1', 'conversationId_1_user_1'],
  messages: ['messageId_1', 'messageId_1_user_1'],
  presets: ['presetId_1'],
  agentcategories: ['value_1'],
  accessroles: ['accessRoleId_1'],
  conversationtags: ['tag_1_user_1'],
  mcpservers: ['serverName_1'],
  files: ['filename_1_conversationId_1_context_1'],
  groups: ['idOnTheSource_1_source_1'],
  skillsyncstatuses: ['provider_1_sourceId_1'],
};

interface MigrationResult {
  planned: string[];
  dropped: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Drops superseded unique indexes that block multi-tenant operation.
 * Idempotent — skips indexes that don't exist. Safe to run on fresh databases.
 *
 * Call this before enabling multi-tenant middleware on an existing deployment.
 * On a fresh database (no pre-existing data), this is a no-op.
 */
export async function dropSupersededTenantIndexes(
  connection: Connection,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { planned: [], dropped: [], skipped: [], errors: [] };

  for (const [collectionName, indexNames] of Object.entries(SUPERSEDED_INDEXES)) {
    const collection = connection.db!.collection(collectionName);

    let existingIndexes: Array<{ name?: string; unique?: boolean }>;
    try {
      existingIndexes = await collection.indexes();
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 26) {
        result.skipped.push(
          ...indexNames.map((idx) => `${collectionName}.${idx} (collection does not exist)`),
        );
        continue;
      }
      const msg = `${collectionName}: ${(err as Error).message}`;
      result.errors.push(msg);
      logger.error(`[TenantMigration] Failed to list indexes: ${msg}`);
      continue;
    }

    const existingNames = new Set(
      existingIndexes.filter((idx) => idx.unique).map((idx) => idx.name),
    );

    for (const indexName of indexNames) {
      if (!existingNames.has(indexName)) {
        result.skipped.push(`${collectionName}.${indexName}`);
        continue;
      }

      result.planned.push(`${collectionName}.${indexName}`);
      if (dryRun) {
        logger.info(`[TenantMigration] Would drop: ${collectionName}.${indexName}`);
        continue;
      }

      try {
        await collection.dropIndex(indexName);
        result.dropped.push(`${collectionName}.${indexName}`);
        logger.info(`[TenantMigration] Dropped superseded index: ${collectionName}.${indexName}`);
      } catch (err) {
        const msg = `${collectionName}.${indexName}: ${(err as Error).message}`;
        result.errors.push(msg);
        logger.error(`[TenantMigration] Failed to drop index: ${msg}`);
      }
    }
  }

  logger.info(
    `[TenantMigration] ${dryRun ? 'Dry run' : 'Index cleanup'} complete: ` +
      `${result.planned.length} planned, ${result.dropped.length} dropped, ${result.errors.length} errors.`,
  );

  return result;
}

/** Suggest the offline migration only for index conflicts in collections it covers. */
export function getTenantIndexMigrationHint(
  collectionName: string,
  error: Error,
): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(SUPERSEDED_INDEXES, collectionName) ||
    !('code' in error) ||
    (error.code !== 85 && error.code !== 86)
  ) {
    return;
  }

  return (
    'This may be a legacy tenant-index conflict. See UPGRADING.md: back up MongoDB, ' +
    'stop all API replicas and other database writers, then run ' +
    '`npm run migrate:tenant-indexes:dry-run` and `npm run migrate:tenant-indexes` ' +
    'from the updated application root. Keep writers stopped until the migration succeeds.'
  );
}

/** Exported for testing — the raw index map */
export { SUPERSEDED_INDEXES };

/**
 * Offline upgrade: build tenant constraints before removing global constraints,
 * then explicitly create current indexes even when MONGO_AUTO_INDEX is disabled.
 * The caller must connect with autoIndex and autoCreate disabled and stop writers.
 */
export async function migrateTenantIndexes(
  connection: Connection,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  if (dryRun) {
    return dropSupersededTenantIndexes(connection, { dryRun });
  }

  const indexes = Object.entries(TENANT_SCHEMAS).flatMap(([name, schema]) =>
    schema.indexes().map(([keys, options]) => ({
      collection: connection.db!.collection(name),
      tenantScoped: 'tenantId' in keys,
      keys: keys as IndexSpecification,
      options: {
        ...options,
        unique: Boolean(options.unique),
      },
    })),
  );
  logger.info('[TenantMigration] Building tenant-scoped unique indexes before cleanup.');
  for (const { collection, keys, options, tenantScoped } of indexes) {
    if (options.unique && tenantScoped) {
      await buildIndexWithRetry(
        () => collection.createIndex(keys, options),
        `createIndex(${collection.collectionName}.${JSON.stringify(keys)})`,
      );
    }
  }

  const result = await dropSupersededTenantIndexes(connection);
  if (result.errors.length > 0) {
    return result;
  }
  logger.info('[TenantMigration] Creating current schema indexes.');
  for (const { collection, keys, options } of indexes) {
    await buildIndexWithRetry(
      () => collection.createIndex(keys, options),
      `createIndex(${collection.collectionName}.${JSON.stringify(keys)})`,
    );
  }
  logger.info('[TenantMigration] Migration complete.');
  return result;
}
