const { nanoid } = require('nanoid');
const { checkAccess } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { applyCitationLimits, selectFileCitationSources } = require('@librechat/api');
const {
  Tools,
  Permissions,
  FileSources,
  EModelEndpoint,
  PermissionTypes,
} = require('librechat-data-provider');
const { getRoleByName, getFiles } = require('~/models');

/**
 * Process file search results from tool calls
 * @param {Object} options
 * @param {IUser} options.user - The user object
 * @param {AppConfig} options.appConfig - The app configuration object
 * @param {GraphRunnableConfig['configurable']} options.metadata - The metadata
 * @param {{ [Tools.file_search]: { sources: Object[]; fileCitations: boolean } }} options.toolArtifact - The tool artifact containing structured data
 * @param {string} options.toolCallId - The tool call ID
 * @returns {Promise<Object|null>} The file search attachment or null
 */
async function processFileCitations({ user, appConfig, toolArtifact, toolCallId, metadata }) {
  try {
    if (!toolArtifact?.[Tools.file_search]?.sources) {
      return null;
    }

    if (user) {
      try {
        const hasFileCitationsAccess =
          toolArtifact?.[Tools.file_search]?.fileCitations ??
          (await checkAccess({
            user,
            permissionType: PermissionTypes.FILE_CITATIONS,
            permissions: [Permissions.USE],
            getRoleByName,
          }));

        if (!hasFileCitationsAccess) {
          logger.debug(
            `[processFileCitations] User ${user.id} does not have FILE_CITATIONS permission`,
          );
          return null;
        }
      } catch (error) {
        logger.error(
          `[processFileCitations] Permission check failed for FILE_CITATIONS: ${error.message}`,
        );
        logger.warn(
          '[processFileCitations] Returning null citations due to permission check error — citations will not be shown for this message',
        );
        return null;
      }
    }

    const selectedSources = selectFileCitationSources(toolArtifact[Tools.file_search].sources, {
      maxCitations: appConfig.endpoints?.[EModelEndpoint.agents]?.maxCitations,
      maxCitationsPerFile: appConfig.endpoints?.[EModelEndpoint.agents]?.maxCitationsPerFile,
      minRelevanceScore: appConfig.endpoints?.[EModelEndpoint.agents]?.minRelevanceScore,
    });
    if (selectedSources.length === 0) {
      return null;
    }

    const enhancedSources = await enhanceSourcesWithMetadata(selectedSources, appConfig);

    if (enhancedSources.length > 0) {
      const fileSearchAttachment = {
        type: Tools.file_search,
        [Tools.file_search]: { sources: enhancedSources },
        toolCallId: toolCallId,
        messageId: metadata.run_id,
        conversationId: metadata.thread_id,
        name: `${Tools.file_search}_file_search_results_${nanoid()}`,
      };

      return fileSearchAttachment;
    }

    return null;
  } catch (error) {
    logger.error('[processFileCitations] Error processing file citations:', error);
    return null;
  }
}

/**
 * Enhance sources with file metadata from database
 * @param {Array} sources - Selected sources
 * @param {AppConfig} appConfig - Custom configuration
 * @returns {Promise<Array>} Enhanced sources
 */
async function enhanceSourcesWithMetadata(sources, appConfig) {
  const fileIds = [...new Set(sources.map((source) => source.fileId))];

  let fileMetadataMap = {};
  try {
    const files = await getFiles({ file_id: { $in: fileIds } });
    fileMetadataMap = files.reduce((map, file) => {
      map[file.file_id] = file;
      return map;
    }, {});
  } catch (error) {
    logger.error('[enhanceSourcesWithMetadata] Error looking up file metadata:', error);
  }

  return sources.map((source) => {
    const fileRecord = fileMetadataMap[source.fileId] || {};
    const configuredStorageType = fileRecord.source || appConfig?.fileStrategy || FileSources.local;

    return {
      ...source,
      fileName: fileRecord.filename || source.fileName || 'Unknown File',
      metadata: {
        ...source.metadata,
        storageType: configuredStorageType,
        fileType: fileRecord.type || undefined,
        fileBytes: fileRecord.bytes || undefined,
      },
    };
  });
}

module.exports = {
  selectFileCitationSources,
  applyCitationLimits,
  processFileCitations,
  enhanceSourcesWithMetadata,
};
