const path = require('path');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  s3Relinker,
  relinkLink,
  relinkMessage,
  relinkFileRef,
  createAzureRelinker,
  STORED_FILES_ROUTE,
  getAzureContainerClient,
  getKeyFromStoredFileURL,
  isStoredFileProxyEnabled,
} = require('@librechat/api');
const { FileSources } = require('librechat-data-provider');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { File, Message, ToolCall, Agent, User } = require('~/db/models');

/** The relinkers for every storage service this deployment has configured. */
async function getConfiguredRelinkers() {
  const relinkers = [];
  if (process.env.AWS_BUCKET_NAME) {
    relinkers.push(s3Relinker);
  }
  if (process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_ACCOUNT_NAME) {
    const container = await getAzureContainerClient();
    if (container?.url) {
      relinkers.push(createAzureRelinker(container.url));
    }
  }
  return relinkers;
}

/**
 * Walks one collection in batches, applying `relink` to each document and
 * writing the fields it returns. Returns how many documents changed.
 */
async function relinkCollection({ model, filter, select, relink, dryRun, batchSize }) {
  let changed = 0;
  let operations = [];
  const flush = async () => {
    if (!dryRun && operations.length > 0) {
      await model.bulkWrite(operations, { ordered: false });
    }
    operations = [];
  };
  const cursor = model.find(filter).select(select).lean().cursor({ batchSize });
  for await (const doc of cursor) {
    const set = await relink(doc);
    if (!set || Object.keys(set).length === 0) {
      continue;
    }
    changed++;
    operations.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
    if (operations.length >= batchSize) {
      await flush();
    }
  }
  await flush();
  return changed;
}

/**
 * Rewrites stored file links for `STORAGE_PROXY_FILES`. Files written before the
 * proxy was turned on hold presigned S3 URLs or Azure blob URLs, in file records
 * and in every copy made of them: messages' files, attachments and content parts,
 * tool-call attachments, and agent and user avatars. This replaces them with
 * LibreChat's links, so they stop expiring and browsers stop reaching the storage
 * service. With `revert`, it writes the storage service's links back, for turning
 * the proxy off. File lists and S3 avatars also convert on their own as they load;
 * nothing else does.
 *
 * Idempotent: a link already in the target form is left alone.
 *
 * @param {{ dryRun?: boolean, batchSize?: number, revert?: boolean, relinkers?: import('@librechat/api').Relinker[] }} [options]
 */
async function migrateStoredFileLinks({
  dryRun = true,
  batchSize = 100,
  revert = false,
  relinkers,
} = {}) {
  if (revert === isStoredFileProxyEnabled()) {
    throw new Error(
      revert
        ? 'Turn STORAGE_PROXY_FILES off before reverting, so links are signed by the storage service.'
        : 'Turn STORAGE_PROXY_FILES on first: the links this writes are served only while it is on.',
    );
  }

  await connect();
  const direction = revert ? 'storage' : 'stored';
  const active = relinkers ?? (await getConfiguredRelinkers());
  logger.info('Starting Stored File Link Migration', {
    dryRun,
    batchSize,
    direction,
    sources: active.map((relinker) => relinker.source),
  });

  const results = { dryRun, direction, files: 0, messages: 0, toolCalls: 0, agents: 0, users: 0 };
  if (active.length === 0) {
    logger.warn('No S3 bucket or Azure container is configured; nothing to migrate.');
    return results;
  }

  const sources = { $in: active.map((relinker) => relinker.source) };
  const options = { dryRun, batchSize };

  /* Every tenant's records, as the other cross-tenant migrations do. */
  return runAsSystem(async () => {
    results.files = await relinkCollection({
      ...options,
      model: File,
      filter: { source: sources },
      select: '_id source filepath storageKey',
      relink: async (file) => {
        if (!(await relinkFileRef(file, direction, active))) {
          return null;
        }
        const set = { filepath: file.filepath };
        /* The stored-file route finds a file's record by its key. */
        if (!revert && file.source === FileSources.s3 && !file.storageKey) {
          set.storageKey = getKeyFromStoredFileURL(file.filepath, FileSources.s3);
        }
        return set;
      },
    });

    results.messages = await relinkCollection({
      ...options,
      model: Message,
      filter: {
        $or: [
          { 'files.source': sources },
          { 'attachments.source': sources },
          { 'content.files.source': sources },
          { 'content.image_file.source': sources },
        ],
      },
      select: '_id files attachments content',
      relink: (message) => relinkMessage(message, direction, active),
    });

    results.toolCalls = await relinkCollection({
      ...options,
      model: ToolCall,
      filter: { 'attachments.source': sources },
      select: '_id attachments',
      relink: (toolCall) => relinkMessage(toolCall, direction, active),
    });

    results.agents = await relinkCollection({
      ...options,
      model: Agent,
      filter: { 'avatar.source': sources },
      select: '_id avatar',
      relink: async (agent) =>
        (await relinkFileRef(agent.avatar, direction, active)) ? { avatar: agent.avatar } : null,
    });

    /* A user's avatar is a bare link; each relinker recognises its own. */
    results.users = await relinkCollection({
      ...options,
      model: User,
      filter: revert
        ? { avatar: { $regex: STORED_FILES_ROUTE.replace(/[/-]/g, '\\$&') } }
        : { avatar: { $type: 'string', $ne: '' } },
      select: '_id avatar',
      relink: async (user) => {
        const avatar = await relinkLink(user.avatar, direction, active);
        return avatar ? { avatar } : null;
      },
    });

    return results;
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const revert = process.argv.includes('--revert');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;

  migrateStoredFileLinks({ dryRun, batchSize, revert })
    .then((result) => {
      const verb = dryRun ? 'to update' : 'updated';
      console.log(`\n=== ${dryRun ? 'DRY RUN ' : ''}RESULTS (${result.direction} links) ===`);
      console.log(`Files ${verb}: ${result.files}`);
      console.log(`Messages ${verb}: ${result.messages}`);
      console.log(`Tool calls ${verb}: ${result.toolCalls}`);
      console.log(`Agents ${verb}: ${result.agents}`);
      console.log(`Users ${verb}: ${result.users}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Stored file link migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateStoredFileLinks };
