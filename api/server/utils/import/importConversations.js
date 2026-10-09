const fs = require('fs').promises;
const { resolveImportMaxFileSize } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getImporter } = require('./importers');
const { createImportBatchBuilder } = require('./importBatchBuilder');

const maxFileSize = resolveImportMaxFileSize();

/**
 * Job definition for importing a conversation.
 * @param {{ filepath: string, requestUserId: string, userRole?: string, interfaceConfig?: object, filters?: object, legacyPii?: object }} job
 */
const importConversations = async (job) => {
  const { filepath, requestUserId, userRole, interfaceConfig, filters, legacyPii } = job;
  try {
    logger.debug(`user: ${requestUserId} | Importing conversation(s) from file...`);

    const fileInfo = await fs.stat(filepath);
    if (fileInfo.size > maxFileSize) {
      throw new Error(
        `File size is ${fileInfo.size} bytes. It exceeds the maximum limit of ${maxFileSize} bytes.`,
      );
    }

    const fileData = await fs.readFile(filepath, 'utf8');
    const jsonData = JSON.parse(fileData);
    const importer = getImporter(jsonData);
    await importer(
      jsonData,
      requestUserId,
      (userId) =>
        legacyPii == null
          ? createImportBatchBuilder(userId, interfaceConfig, filters)
          : createImportBatchBuilder(userId, interfaceConfig, filters, legacyPii),
      userRole,
    );
    logger.debug(`user: ${requestUserId} | Finished importing conversations`);
  } catch (error) {
    logger.error(`user: ${requestUserId} | Failed to import conversation: `, error);
    throw error; // throw error all the way up so request does not return success
  } finally {
    try {
      await fs.unlink(filepath);
    } catch (error) {
      logger.error(`user: ${requestUserId} | Failed to delete file: ${filepath}`, error);
    }
  }
};

module.exports = importConversations;
