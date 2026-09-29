const fs = require('fs');
const path = require('path');
const mime = require('mime');
const { v4 } = require('uuid');
const {
  isUUID,
  megabyte,
  FileContext,
  FileSources,
  imageExtRegex,
  EModelEndpoint,
  EToolResources,
  mergeCodeEnvRef,
  mergeFileConfig,
  AgentCapabilities,
  checkOpenAIStorage,
  removeNullishValues,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  resolveUploadLLMDeliveryPath,
  isNativelyReadableText,
  resolveUploadDestination,
  resolveSandboxFilename,
  canToolResourceConsume,
  isMessageFileUpload,
  isResponsesApiUpload,
  isSpeechProviderConfigured,
} = require('librechat-data-provider');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  sanitizeFilename,
  parseText,
  processAudioFile,
  extractInspectableFileText,
  assertExtractedTextInspectable,
  getFileExtractionLogDetails,
  getUploadExtractedTextPlan,
  UPLOAD_EXTRACTED_TEXT_PLANS,
  inspectContent,
  extractFileContent,
  hasActiveFileFieldPolicy,
  sendUploadSuccess,
  getStorageMetadata,
  contentFilterBlockResponse,
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
  resolveToolRoleGrants,
  createCodeApiRateLimitBudget,
  getCodeApiUploadOptions,
  withCodeApiUploadRecovery,
} = require('@librechat/api');
const {
  convertImage,
  resizeAndConvert,
  resizeImageBuffer,
} = require('~/server/services/Files/images');
const { addResourceFileId, deleteResourceFileId } = require('~/server/controllers/assistants/v2');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { checkCapability } = require('~/server/services/Config');
const { LB_QueueAsyncCall } = require('~/server/utils/queue');
const { getRetentionExpiry, getAgentFileRetentionExpiry } = require('./retention');
const { getStrategyFunctions } = require('./strategies');
const { determineFileType } = require('~/server/utils');
const { STTService } = require('./Audio/STTService');
const db = require('~/models');

/**
 * Creates a modular file upload wrapper that ensures filename sanitization
 * across all storage strategies. This prevents storage-specific implementations
 * from having to handle sanitization individually.
 *
 * @param {Function} uploadFunction - The storage strategy's upload function
 * @returns {Function} - Wrapped upload function with sanitization
 */
const createSanitizedUploadWrapper = (uploadFunction) => {
  return async (params) => {
    const { req, file, file_id, ...restParams } = params;

    // Create a modified file object with sanitized original name
    // This ensures consistent filename handling across all storage strategies
    const sanitizedFile = {
      ...file,
      originalname: sanitizeFilename(file.originalname),
    };

    return uploadFunction({ req, file: sanitizedFile, file_id, ...restParams });
  };
};

const hasCodeEnvRef = (file) =>
  file?.metadata?.codeEnvRef != null || file?.metadata?.codeEnvRefs != null;

const isMissingStorageError = (err) => {
  const code = err?.code ?? err?.status ?? err?.statusCode ?? err?.response?.status;
  if ([404, '404', 'ENOENT', 'NoSuchKey', 'NotFound', 'ResourceNotFound'].includes(code)) {
    return true;
  }

  return /(?:file|object|blob|key|resource) (?:not found|does not exist)|no such (?:file|key)/i.test(
    String(err?.message ?? ''),
  );
};

/**
 * Enqueues the delete operation to the leaky bucket queue if necessary, or adds it directly to promises.
 *
 * @param {object} params - The passed parameters.
 * @param {ServerRequest} params.req - The express request object.
 * @param {MongoFile} params.file - The file object to delete.
 * @param {Function} params.deleteFile - The delete file function.
 * @param {Promise[]} params.promises - The array of promises to await.
 * @param {Set<string>} params.resolvedFileIds - File IDs whose storage delete succeeded.
 * @param {Set<string>} params.failedFileIds - File IDs whose storage delete failed.
 * @param {OpenAI | undefined} [params.openai] - If an OpenAI file, the initialized OpenAI client.
 */
function enqueueDeleteOperation({
  req,
  file,
  deleteFile,
  promises,
  resolvedFileIds,
  failedFileIds,
  openai,
}) {
  if (checkOpenAIStorage(file.source)) {
    // Enqueue to leaky bucket
    promises.push(
      new Promise((resolve, reject) => {
        LB_QueueAsyncCall(
          () => deleteFile(req, file, openai),
          [],
          (err, result) => {
            if (err) {
              if (isMissingStorageError(err)) {
                resolvedFileIds.add(file.file_id);
                logger.warn('File storage was already missing during delete', err);
                resolve(result);
                return;
              }
              failedFileIds.add(file.file_id);
              logger.error('Error deleting file from OpenAI source', err);
              reject(err);
            } else {
              resolvedFileIds.add(file.file_id);
              resolve(result);
            }
          },
        );
      }),
    );
  } else {
    // Add directly to promises
    promises.push(
      deleteFile(req, file)
        .then(() => resolvedFileIds.add(file.file_id))
        .catch((err) => {
          if (isMissingStorageError(err)) {
            resolvedFileIds.add(file.file_id);
            logger.warn('File storage was already missing during delete', err);
            return;
          }
          failedFileIds.add(file.file_id);
          logger.error('Error deleting file', err);
          return Promise.reject(err);
        }),
    );
  }
}

const getDeleteMethod = ({ source, deletionMethods }) => {
  if (deletionMethods[source]) {
    return deletionMethods[source];
  }

  const { deleteFile } = getStrategyFunctions(source);
  if (!deleteFile) {
    throw new Error(`Delete function not implemented for ${source}`);
  }

  deletionMethods[source] = deleteFile;
  return deleteFile;
};

const createDeleteFileWithSecondaryStorage = ({ source, deleteFile, deletionMethods }) => {
  return async (req, file, openai) => {
    const secondaryDeleteMethods = [];
    if (file.embedded === true && source !== FileSources.vectordb) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.vectordb, deletionMethods }),
      );
    }
    if (hasCodeEnvRef(file) && source !== FileSources.execute_code) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.execute_code, deletionMethods }),
      );
    }

    try {
      await deleteFile(req, file, openai);
    } catch (err) {
      if (!isMissingStorageError(err)) {
        throw err;
      }
      logger.warn('Primary file storage was already missing during delete', err);
    }

    await Promise.all(
      secondaryDeleteMethods.map((secondaryDeleteFile) => secondaryDeleteFile(req, file)),
    );
  };
};

// TODO: refactor as currently only image files can be deleted this way
// as other filetypes will not reside in public path
/**
 * Deletes a list of files from the server filesystem and the database.
 *
 * @param {Object} params - The params object.
 * @param {MongoFile[]} params.files - The file objects to delete.
 * @param {ServerRequest} params.req - The express request object.
 * @param {DeleteFilesBody} params.req.body - The request body.
 * @param {string} [params.req.body.agent_id] - The agent ID if file uploaded is associated to an agent.
 * @param {string} [params.req.body.assistant_id] - The assistant ID if file uploaded is associated to an assistant.
 * @param {string} [params.req.body.tool_resource] - The tool resource if assistant file uploaded is associated to a tool resource.
 *
 * @returns {Promise<{ deletedFileIds: string[], failedFileIds: string[] }>}
 * @throws {Error} When storage deletion cannot be scheduled or file metadata cleanup fails.
 */
const processDeleteRequest = async ({ req, files }) => {
  const appConfig = req.config;
  const resolvedFileIds = new Set();
  const failedFileIds = new Set();
  const deletionMethods = {};
  const promises = [];

  /** @type {Record<string, OpenAI | undefined>} */
  const client = { [FileSources.openai]: undefined, [FileSources.azure]: undefined };
  const initializeClients = async () => {
    if (appConfig.endpoints?.[EModelEndpoint.assistants]) {
      const openAIClient = await getOpenAIClient({
        req,
        overrideEndpoint: EModelEndpoint.assistants,
      });
      client[FileSources.openai] = openAIClient.openai;
    }

    if (!appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      return;
    }

    const azureClient = await getOpenAIClient({
      req,
      overrideEndpoint: EModelEndpoint.azureAssistants,
    });
    client[FileSources.azure] = azureClient.openai;
  };

  if (req.body.assistant_id !== undefined) {
    await initializeClients();
  }

  const agentFiles = [];

  for (const file of files) {
    const source = file.source ?? FileSources.local;
    if (req.body.agent_id && req.body.tool_resource) {
      agentFiles.push({
        tool_resource: req.body.tool_resource,
        file_id: file.file_id,
      });
    }

    if (source === FileSources.text) {
      resolvedFileIds.add(file.file_id);
      continue;
    }

    if (checkOpenAIStorage(source) && !client[source]) {
      await initializeClients();
    }

    const openai = client[source];

    if (req.body.assistant_id && req.body.tool_resource) {
      promises.push(
        deleteResourceFileId({
          req,
          openai,
          file_id: file.file_id,
          assistant_id: req.body.assistant_id,
          tool_resource: req.body.tool_resource,
        }),
      );
    } else if (req.body.assistant_id) {
      promises.push(openai.beta.assistants.files.del(req.body.assistant_id, file.file_id));
    }

    const deleteFile = getDeleteMethod({ source, deletionMethods });
    enqueueDeleteOperation({
      req,
      file,
      deleteFile: createDeleteFileWithSecondaryStorage({ source, deleteFile, deletionMethods }),
      promises,
      resolvedFileIds,
      failedFileIds,
      openai,
    });
  }

  if (agentFiles.length > 0) {
    promises.push(
      db.removeAgentResourceFiles({
        agent_id: req.body.agent_id,
        files: agentFiles,
      }),
    );
  }

  await Promise.allSettled(promises);
  const deletedFileIds = [...resolvedFileIds];
  let metadataDeletedFileIds = deletedFileIds;
  if (deletedFileIds.length > 0) {
    try {
      await db.deleteFiles(deletedFileIds);
    } catch (error) {
      logger.error('Error deleting file metadata after storage deletion', error);
      deletedFileIds.forEach((fileId) => failedFileIds.add(fileId));
      metadataDeletedFileIds = [];
      throw error;
    }
    if (metadataDeletedFileIds.length > 0) {
      try {
        await db.removeAgentResourceFilesFromAllAgents({ file_ids: metadataDeletedFileIds });
      } catch (error) {
        logger.error('Error cleaning up orphaned agent file references', error);
      }
    }
  }

  return {
    deletedFileIds: metadataDeletedFileIds,
    failedFileIds: [...failedFileIds],
  };
};

/**
 * Deletes expired file storage before removing the corresponding File records.
 *
 * Mongo TTL indexes delete only the metadata document, so file retention uses
 * this application sweep for records with `expiredAt` instead.
 *
 * @param {object} params
 * @param {AppConfig} params.appConfig
 * @param {number} [params.limit]
 * @param {() => Promise<AppConfig>} [params.loadAppConfig]
 * @returns {Promise<{ scanned: number, deleted: number, failed: number }>}
 */
async function sweepExpiredFiles(options = {}) {
  return sweepExpiredFilesWithDeps(options, {
    getExpiredFiles: db.getExpiredFiles,
    processDeleteRequest,
    incrementFileDeletionAttempts: db.incrementFileDeletionAttempts,
    deferExpiredFile: db.deferExpiredFile,
    logger,
  });
}

function startExpiredFileSweep(options = {}) {
  return startExpiredFileSweepWithDeps(options, {
    sweepExpiredFiles,
    runAsSystem,
    logger,
  });
}

/**
 * Processes a file URL using a specified file handling strategy. This function accepts a strategy name,
 * fetches the corresponding file processing functions (for saving and retrieving file URLs), and then
 * executes these functions in sequence. It first saves the file using the provided URL and then retrieves
 * the URL of the saved file. If any error occurs during this process, it logs the error and throws an
 * exception with an appropriate message.
 *
 * @param {Object} params - The parameters object.
 * @param {FileSources} params.fileStrategy - The file handling strategy to use.
 * Must be a value from the `FileSources` enum, which defines different file
 * handling strategies (like saving to Firebase, local storage, etc.).
 * @param {string} params.userId - The user's unique identifier. Used for creating user-specific paths or
 * references in the file handling process.
 * @param {string} params.URL - The URL of the file to be processed.
 * @param {string} params.fileName - The name that will be used to save the file (including extension)
 * @param {string} params.basePath - The base path or directory where the file will be saved or retrieved from.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {string} [params.tenantId] - Optional tenant identifier for tenant-prefixed storage paths.
 * @param {ServerRequest} [params.req] - Request context used to apply data retention metadata.
 * @returns {Promise<MongoFile>} A promise that resolves to the DB representation (MongoFile)
 *  of the processed file. It throws an error if the file processing fails at any stage.
 */
const processFileURL = async ({
  fileStrategy,
  userId,
  URL,
  fileName,
  basePath,
  context,
  tenantId,
  req,
}) => {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const { saveURL, getFileURL } = getStrategyFunctions(fileStrategy);
  try {
    const savedFile = await saveURL({ userId, URL, fileName, basePath, tenantId });
    if (!savedFile) {
      throw new Error(`Strategy "${fileStrategy}" did not save "${fileName}"`);
    }

    const {
      bytes = 0,
      type = '',
      dimensions = {},
    } = typeof savedFile === 'string' ? {} : savedFile;
    const fallbackFileName =
      fileStrategy === FileSources.local || fileStrategy === FileSources.firebase
        ? `${userId}/${fileName}`
        : fileName;
    const filepath =
      typeof savedFile === 'string'
        ? savedFile
        : (savedFile.filepath ??
          (await getFileURL({ userId, fileName: fallbackFileName, basePath, tenantId })));
    if (!filepath) {
      throw new Error(`Strategy "${fileStrategy}" did not return a file URL for "${fileName}"`);
    }
    const storageMetadata = getStorageMetadata({
      filepath,
      source: fileStrategy,
      storageKey: typeof savedFile === 'string' ? undefined : savedFile.storageKey,
      storageRegion: typeof savedFile === 'string' ? undefined : savedFile.storageRegion,
    });

    return await db.createFile(
      {
        user: userId,
        file_id: v4(),
        bytes,
        filepath,
        ...storageMetadata,
        filename: fileName,
        source: fileStrategy,
        type,
        context,
        ...(await retentionExpiryPromise),
        tenantId,
        width: dimensions.width,
        height: dimensions.height,
      },
      true,
    );
  } catch (error) {
    logger.error(`Error while processing the image with ${fileStrategy}:`, error);
    throw new Error(`Failed to process the image with ${fileStrategy}. ${error.message}`);
  }
};

/**
 * Applies the current strategy for image uploads.
 * Saves file metadata to the database with an expiry TTL.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} [params.res] - The Express response object.
 * @param {ImageMetadata} params.metadata - Additional metadata for the file.
 * @param {boolean} params.returnFile - Return the converted file's metadata without persisting it, for a caller that creates its own record.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
const processImageFile = async ({ req, res, metadata, returnFile = false, sseStream }) => {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const { file } = req;
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { handleImageUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id, endpoint } = metadata;
  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  /* The route resolved the agent's provider before validating, so the same endpoint
   * governs delivery routing here. */
  const configEndpoint = metadata.effectiveEndpoint ?? endpoint;
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint: configEndpoint });
  const llmDeliveryPath = resolveUploadLLMDeliveryPath({
    mimeType: file.mimetype,
    endpointConfig,
    fileConfig,
    endpoint: configEndpoint,
    useResponsesApi: isResponsesApiUpload(metadata.useResponsesApi ?? req.body?.useResponsesApi),
    sttConfigured: isSpeechProviderConfigured(appConfig?.speech?.stt),
  });

  const { filepath, bytes, width, height, storageKey, storageRegion } = await handleImageUpload({
    req,
    file,
    file_id,
    endpoint,
  });
  const storageMetadata = getStorageMetadata({ filepath, source, storageKey, storageRegion });

  const fileInfo = {
    user: req.user.id,
    file_id,
    temp_file_id,
    bytes,
    filepath,
    ...storageMetadata,
    filename: file.originalname,
    context: FileContext.message_attachment,
    source,
    type: `image/${appConfig.imageOutputType}`,
    ...(await retentionExpiryPromise),
    width,
    height,
    tenantId: req.user.tenantId,
    llmDeliveryPath,
    /* The image route persists through here directly, so the choice has to be recorded
     * on this path too. Absent, a later turn substitutes its own endpoint's mode. */
    metadata: {
      destinationChosen:
        endpointConfig?.legacyFileUploadUX === true || metadata.tool_resource != null,
      ...(`image/${appConfig.imageOutputType}` !== file.mimetype
        ? { routingMimeType: file.mimetype }
        : {}),
    },
  };

  /* Callers asking for the file are converting an image for a record of their own, under
   * a different id. Persisting here would leave that row referenced by nothing while the
   * converted object it points at is the one they go on to use. */
  if (returnFile) {
    return fileInfo;
  }

  const result = await db.createFile(fileInfo, true);
  sendUploadSuccess(res, sseStream, 'File uploaded and processed successfully', result);
};

/**
 * Applies the current strategy for image uploads and
 * returns minimal file metadata, without saving to the database.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {boolean} [params.resize=true] - Whether to resize and convert the image to target format. Default is `true`.
 * @param {{ buffer: Buffer, width: number, height: number, bytes: number, filename: string, type: string, file_id: string }} [params.metadata] - Required metadata for the file if resize is false.
 * @returns {Promise<{ filepath: string, filename: string, source: string, type: string}>}
 */
const uploadImageBuffer = async ({ req, context, metadata = {}, resize = true }) => {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  let { buffer, width, height, bytes, filename, file_id, type } = metadata;
  if (resize) {
    file_id = v4();
    type = `image/${appConfig.imageOutputType}`;
    ({ buffer, width, height, bytes } = await resizeAndConvert({
      inputBuffer: buffer,
      desiredFormat: appConfig.imageOutputType,
    }));
    filename = `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.${
      appConfig.imageOutputType
    }`;
  }
  const fileName = `${file_id}-${filename}`;
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName,
    buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      user: req.user.id,
      file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename,
      context,
      source,
      type,
      width,
      ...(await retentionExpiryPromise),
      height,
      tenantId: req.user.tenantId,
    },
    true,
  );
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
/**
 * @param {OpenAI} [params.openai] - Client the caller already built (the legacy
 * assistant preflight needs one to authorize). Reused rather than rebuilt, since
 * constructing it re-reads the user's key.
 */
const processFileUpload = async ({ req, res, metadata, sseStream, openai: providedOpenAI }) => {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const appConfig = req.config;
  const isAssistantUpload = isAssistantsEndpoint(metadata.endpoint);
  const assistantSource =
    metadata.endpoint === EModelEndpoint.azureAssistants ? FileSources.azure : FileSources.openai;
  // Use the configured file strategy for regular file uploads (not vectordb)
  const source = isAssistantUpload ? assistantSource : appConfig.fileStrategy;
  const { handleFileUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id = null } = metadata;

  /** @type {OpenAI | undefined} */
  let openai = providedOpenAI;
  if (openai == null && checkOpenAIStorage(source)) {
    ({ openai } = await getOpenAIClient({ req }));
  }

  const { file } = req;
  const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
  const {
    id,
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    embedded,
    height,
    width,
  } = await sanitizedUploadFn({
    req,
    file,
    file_id,
    openai,
  });

  if (isAssistantUpload && !metadata.message_file && !metadata.tool_resource) {
    /** Authorized at the route before any bytes are sent — see
     *  `assertLegacyAssistantUploadAllowed` in `~/server/routes/files/files`. */
    await openai.beta.assistants.files.create(metadata.assistant_id, {
      file_id: id,
    });
  } else if (isAssistantUpload && !metadata.message_file) {
    await addResourceFileId({
      req,
      openai,
      file_id: id,
      assistant_id: metadata.assistant_id,
      tool_resource: metadata.tool_resource,
    });
  }

  let filepath = isAssistantUpload ? `${openai.baseURL}/files/${id}` : _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });
  if (isAssistantUpload && file.mimetype.startsWith('image')) {
    const result = await processImageFile({
      req,
      file,
      metadata: { file_id: v4() },
      returnFile: true,
    });
    filepath = result.filepath;
    storageMetadata = getStorageMetadata({
      filepath,
      source: result.source,
      storageKey: result.storageKey,
      storageRegion: result.storageRegion,
    });
  }

  const result = await db.createFile(
    {
      user: req.user.id,
      file_id: id ?? file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: isAssistantUpload ? FileContext.assistants : FileContext.message_attachment,
      model: isAssistantUpload ? req.body.model : undefined,
      type: file.mimetype,
      ...(await retentionExpiryPromise),
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
    },
    true,
  );
  sendUploadSuccess(res, sseStream, 'File uploaded and processed successfully', result);
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @param {import('@librechat/api').UploadSseStream | null} [params.sseStream] - Active upload SSE stream, if enabled.
 * @returns {Promise<void>}
 */
/** Reader-facing names for the destinations an upload can be rejected against. */
const TOOL_RESOURCE_LABELS = {
  [EToolResources.execute_code]: 'the code interpreter',
  [EToolResources.code_interpreter]: 'the code interpreter',
  [EToolResources.file_search]: 'file search',
  [EToolResources.context]: 'text context',
  [EToolResources.image_edit]: 'image editing',
  [EToolResources.ocr]: 'OCR',
};

/** Capability gate for each tool that can consume a file kept off the model path. */
const CONSUMER_CAPABILITIES = [
  [EToolResources.execute_code, AgentCapabilities.execute_code],
  [EToolResources.file_search, AgentCapabilities.file_search],
];

/**
 * Narrows an agent's tools to those this deployment will actually honor. Filing a file
 * under a disabled capability fails the upload on a rule the agent's tool order picked.
 */
const filterEnabledConsumers = async (req, agentTools, roleGrants) => {
  if (!agentTools?.length) {
    return agentTools;
  }
  const candidates = CONSUMER_CAPABILITIES.filter(([resource]) => agentTools.includes(resource));
  if (candidates.length === 0) {
    return agentTools;
  }
  const enabled = await Promise.all(
    candidates.map(([, capability]) => checkCapability(req, capability)),
  );
  const disabled = new Set(
    candidates
      .filter(([resource], index) => {
        if (!enabled[index]) {
          return true;
        }
        if (resource === EToolResources.execute_code) {
          return roleGrants?.runCode === false;
        }
        return resource === EToolResources.file_search && roleGrants?.fileSearch === false;
      })
      .map(([resource]) => resource),
  );
  return disabled.size > 0 ? agentTools.filter((tool) => !disabled.has(tool)) : agentTools;
};

const processAgentFileUpload = async ({ req, res, metadata, sseStream }) => {
  const { file } = req;
  const appConfig = req.config;
  const { agent_id, tool_resource, file_id, temp_file_id = null } = metadata;

  let messageAttachment = isMessageFileUpload(metadata.message_file);

  let effectiveToolResource;

  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  const endpoint = metadata.effectiveEndpoint ?? req.body?.endpoint;
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint });

  /* Recorded on the file below, both ways: the endpoint setting can differ on a later
   * turn, but the user's decision about this file does not change with it. An absent
   * marker means a record written before this was tracked, not an inferred destination.
   *
   * A destination is the user's whenever they named one, which the chooser always does
   * and a request naming a tool resource does too. Recording the endpoint mode instead
   * would treat an explicitly sandbox-only upload in unified mode as inferred. */
  const legacyUploadUX = endpointConfig?.legacyFileUploadUX === true;
  const uploadChoiceMetadata = { destinationChosen: legacyUploadUX || tool_resource != null };

  if (agent_id && !tool_resource && !messageAttachment) {
    if (legacyUploadUX) {
      throw new Error('No tool resource provided for agent file upload');
    }
  }

  const llmDeliveryPath = resolveUploadLLMDeliveryPath({
    toolResource: tool_resource,
    mimeType: file.mimetype,
    endpointConfig,
    fileConfig,
    endpoint,
    useResponsesApi: isResponsesApiUpload(metadata.useResponsesApi ?? req.body?.useResponsesApi),
    sttConfigured: isSpeechProviderConfigured(appConfig?.speech?.stt),
  });

  /* Destination and acceptability are one decision, made by shared policy rather than
   * rebuilt here. `agentTools` is undefined when no agent record backs the upload. */
  /* Only a permanent agent upload can land on a context resource, so the capability is
   * looked up only there and the common attachment path pays nothing for it. */
  const contextEnabled =
    messageAttachment || agent_id == null
      ? undefined
      : await checkCapability(req, AgentCapabilities.context);
  const hasRoleGatedConsumer =
    tool_resource === EToolResources.execute_code ||
    tool_resource === EToolResources.file_search ||
    metadata.agentTools?.some(
      (tool) => tool === EToolResources.execute_code || tool === EToolResources.file_search,
    );
  const toolRoleGrants = hasRoleGatedConsumer
    ? await resolveToolRoleGrants({
        req,
        getRoleByName: db.getRoleByName,
        context: 'fileUpload',
      })
    : undefined;
  const destination = resolveUploadDestination({
    toolResource: tool_resource,
    deliveryPath: llmDeliveryPath,
    mimeType: file.mimetype,
    agentTools: await filterEnabledConsumers(req, metadata.agentTools, toolRoleGrants),
    hasAgent: agent_id != null,
    isMessageAttachment: messageAttachment,
    /* A message attachment can acquire a file-tool consumer later in the same draft or
     * on a later turn. This deliberately includes saved agents whose persisted tools are
     * empty: skills and per-turn tool selection are not represented by agent.tools.
     * Audio has no deferred file-tool contract and still requires STT. Permanent agent
     * uploads must be filed under a durable resource before returning. */
    allowUnknownMessageConsumer: messageAttachment && !file.mimetype.startsWith('audio/'),
    contextEnabled,
  });

  if (destination.rejection === 'no-consumer') {
    throw new Error(
      `Files of type ${file.mimetype} are not sent to the model here, and this conversation has no agent whose tools could read them. Attach it to an agent with the code interpreter or file search enabled, or upload a supported file type.`,
    );
  }
  if (destination.rejection === 'context-disabled') {
    throw new Error(
      `Files of type ${file.mimetype} are saved to an agent as extracted text, and the context capability is disabled. Enable it for Agents, or attach the file to a message instead.`,
    );
  }
  if (destination.rejection === 'no-agent-resource') {
    throw new Error(
      `Files of type ${file.mimetype} cannot be saved to an agent on their own. Attach the file to a message, or enable the code interpreter or file search so the agent has somewhere to keep it.`,
    );
  }
  effectiveToolResource = destination.toolResource;

  if (effectiveToolResource && !canToolResourceConsume(effectiveToolResource, file.mimetype)) {
    throw new Error(
      `Files of type ${file.mimetype} cannot be read by ${TOOL_RESOURCE_LABELS[effectiveToolResource] ?? effectiveToolResource}.`,
    );
  }

  if (!messageAttachment && !agent_id) {
    throw new Error('No agent ID provided for agent file upload');
  }

  const retentionExpiryPromise = getAgentFileRetentionExpiry({
    req,
    messageAttachment,
    tool_resource: effectiveToolResource,
  });

  const isImage = file.mimetype.startsWith('image');
  let fileInfoMetadata;
  const entity_id = messageAttachment === true ? undefined : agent_id;
  const basePath = mime.getType(file.originalname)?.startsWith('image') ? 'images' : 'uploads';
  let shouldUploadToCodeEnv = effectiveToolResource === EToolResources.execute_code;
  if (effectiveToolResource === EToolResources.execute_code) {
    const isCodeEnabled =
      (await checkCapability(req, AgentCapabilities.execute_code)) &&
      toolRoleGrants?.runCode === true;
    if (!isCodeEnabled) {
      throw new Error('Code execution is not enabled for Agents');
    }
    /* Only an explicit choice uploads here. A promoted destination has no user decision
     * behind it and the agent's code deployment is resolved per turn, so uploading now
     * would name the default route and be uploaded again at execution, or fail outright
     * where only a stateful deployment exists. Deferred provisioning does it with the
     * route the turn actually runs on. */
    if (tool_resource == null) {
      shouldUploadToCodeEnv = false;
    }
  }

  if (effectiveToolResource === EToolResources.file_search) {
    const isFileSearchEnabled =
      (await checkCapability(req, AgentCapabilities.file_search)) &&
      toolRoleGrants?.fileSearch === true;
    if (!isFileSearchEnabled) {
      throw new Error('File search is not enabled for Agents');
    }
    // Note: File search processing continues to dual storage logic below
  } else if (effectiveToolResource === EToolResources.context) {
    const { file_id, temp_file_id = null } = metadata;
    const getExtractionLogDetails = (error) =>
      getFileExtractionLogDetails({
        filters: appConfig?.filters,
        filename: file.originalname,
        fileId: file_id,
        error,
      });
    const { fileLabel: extractionFileLabel } = getExtractionLogDetails(undefined);

    /**
     * @param {object} params
     * @param {string} params.text
     * @param {boolean} params.isTranscript
     * @return {Promise<void>}
     */
    const createTextFile = async ({ text, isTranscript = false }) => {
      if (!isTranscript) {
        assertExtractedTextInspectable({
          filters: appConfig?.filters,
          text,
        });
      }
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes > 15 * megabyte) {
        throw new Error(
          `Extracted text from "${file.originalname}" exceeds the 15MB storage limit (${Math.round(textBytes / megabyte)}MB). Try a shorter document.`,
        );
      }
      if (
        hasActiveFileFieldPolicy(appConfig?.filters, [
          isTranscript ? 'transcript' : 'extracted_text',
        ])
      ) {
        const content = isTranscript ? { transcript: text } : { extractedText: text };
        const finding = inspectContent(extractFileContent(content), {
          filters: appConfig.filters,
        });
        if (finding != null) {
          const blockResponse = contentFilterBlockResponse(finding);
          if (sseStream) {
            sseStream.sendError({
              ...blockResponse,
              code: 400,
              temp_file_id,
              tool_resource,
              display_to_user: true,
            });
          } else {
            res.status(400).json(blockResponse);
          }
          return;
        }
      }
      const isImageFile = file.mimetype.startsWith('image');
      const source = getFileStrategy(appConfig, { isImage: isImageFile });
      const { handleFileUpload } = getStrategyFunctions(source);
      const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
      const storageResult = await sanitizedUploadFn({
        req,
        file,
        file_id,
        basePath,
        entity_id,
      });
      const { bytes, filename, filepath, embedded, height, width } = storageResult;

      const retentionExpiry = await retentionExpiryPromise;
      const fileInfo = {
        ...removeNullishValues({
          text,
          bytes,
          file_id,
          temp_file_id,
          user: req.user.id,
          type: file.mimetype,
          filepath,
          source,
          filename: filename ?? sanitizeFilename(file.originalname),
          model: messageAttachment ? undefined : req.body.model,
          context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
          tenantId: req.user.tenantId,
          embedded,
          height,
          width,
          llmDeliveryPath: 'text',
        }),
        metadata: uploadChoiceMetadata,
        ...retentionExpiry,
      };

      if (!messageAttachment && effectiveToolResource) {
        await db.addAgentResourceFile({
          file_id,
          agent_id,
          tool_resource: effectiveToolResource,
          updatingUserId: req?.user?.id,
        });
      }
      const result = await db.createFile(fileInfo, true);
      sendUploadSuccess(res, sseStream, 'Agent file uploaded and processed successfully', result);
    };

    const fileConfig = mergeFileConfig(appConfig.fileConfig);
    const extractedTextPlan = getUploadExtractedTextPlan({
      endpoint: metadata.endpoint,
      toolResource: effectiveToolResource,
      mimeType: file.mimetype,
      fileConfig,
      ocrConfigured: appConfig?.ocr != null,
      ragConfigured: !!process.env.RAG_API_URL,
    });
    const shouldUseConfiguredOCR = extractedTextPlan === UPLOAD_EXTRACTED_TEXT_PLANS.configuredOCR;
    const shouldUseConfiguredText = extractedTextPlan === UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG;
    const shouldUseDocumentParser =
      extractedTextPlan === UPLOAD_EXTRACTED_TEXT_PLANS.documentParser;

    const shouldUseOCR = shouldUseConfiguredOCR || shouldUseDocumentParser;

    const resolveDocumentText = async () => {
      if (shouldUseConfiguredOCR) {
        try {
          const ocrStrategy = appConfig?.ocr?.strategy ?? FileSources.document_parser;
          const { handleFileUpload } = getStrategyFunctions(ocrStrategy);
          return await handleFileUpload({ req, file, loadAuthValues });
        } catch (err) {
          const { errorMetadata } = getExtractionLogDetails(err);
          logger.error(
            `[processAgentFileUpload] Configured OCR failed for ${extractionFileLabel}, falling back to document_parser:`,
            errorMetadata,
          );
        }
      }
      try {
        const { handleFileUpload } = getStrategyFunctions(FileSources.document_parser);
        return await handleFileUpload({ req, file, loadAuthValues });
      } catch (err) {
        const { errorMetadata } = getExtractionLogDetails(err);
        logger.error(
          `[processAgentFileUpload] Document parser failed for ${extractionFileLabel}:`,
          errorMetadata,
        );
        throw err;
      }
    };

    if (shouldUseConfiguredOCR && !(await checkCapability(req, AgentCapabilities.ocr))) {
      throw new Error('OCR capability is not enabled for Agents');
    }

    if (shouldUseOCR) {
      const ocrResult = await extractInspectableFileText({
        filters: appConfig?.filters,
        extract: resolveDocumentText,
      });
      if (ocrResult) {
        const { text } = ocrResult;
        return await createTextFile({ text });
      }
      throw new Error(
        `Unable to extract text from "${file.originalname}". The document may be image-based and requires an OCR service to process.`,
      );
    }

    const shouldUseSTT = fileConfig.checkType(
      file.mimetype,
      fileConfig.stt?.supportedMimeTypes || [],
    );

    if (shouldUseSTT) {
      const sttService = await STTService.getInstance();
      const { text } = await processAudioFile({ req, file, sttService });
      return await createTextFile({ text, isTranscript: true });
    }

    const shouldUseText = fileConfig.checkType(
      file.mimetype,
      fileConfig.text?.supportedMimeTypes || [],
    );

    if (!shouldUseText) {
      throw new Error(`File type ${file.mimetype} is not supported for text parsing.`);
    }

    /**
     * A document type the admin routed to configured text extraction: prefer RAG `/text`, but fall
     * back to the built-in document parser (not raw native text) when RAG is unavailable, so a
     * transient outage doesn't degrade a docx/pdf to unreadable bytes. Only the RAG extraction is
     * inside the fallback catch: a downstream persistence failure (size guard, DB, agent-resource
     * mutation) must surface as itself, not trigger a second extraction attempt.
     */
    if (shouldUseConfiguredText) {
      let configuredText;
      try {
        configuredText = await parseText({ req, file, file_id, allowNativeFallback: false });
      } catch (err) {
        const { errorMetadata } = getExtractionLogDetails(err);
        logger.warn(
          `[processAgentFileUpload] Configured RAG text extraction unavailable for ${extractionFileLabel}, using built-in document parser:`,
          errorMetadata,
        );
        const documentText = await extractInspectableFileText({
          filters: appConfig?.filters,
          extract: resolveDocumentText,
        });
        if (!documentText) {
          throw new Error(
            `Unable to extract text from "${file.originalname}". RAG text extraction was unavailable and the built-in parser produced no result.`,
          );
        }
        const { text } = documentText;
        return await createTextFile({ text });
      }
      return await createTextFile({ text: configuredText.text });
    }

    /* The native reader decodes whatever bytes it is given as UTF-8, which is meaningful
     * only for types that are already text. For anything else, a raster image on a
     * deployment without OCR being the case in point, it would store mojibake as the
     * file's text, so a real extractor is required and its absence surfaces as an error
     * rather than as nonsense content. */
    const { text } = await extractInspectableFileText({
      filters: appConfig?.filters,
      extract: () =>
        parseText({
          req,
          file,
          file_id,
          allowNativeFallback: isNativelyReadableText(file.mimetype),
        }),
    });
    return await createTextFile({ text });
  }

  // Dual storage pattern for RAG files: Storage + Vector DB
  let storageResult, embeddingResult;
  let storedType = file.mimetype;
  const isImageFile = file.mimetype.startsWith('image');
  const source = getFileStrategy(appConfig, { isImage: isImageFile });

  if (
    effectiveToolResource === EToolResources.file_search &&
    tool_resource === EToolResources.file_search
  ) {
    // FIRST: Upload to Storage for permanent backup (S3/local/etc.)
    const { handleFileUpload } = getStrategyFunctions(source);
    const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
    storageResult = await sanitizedUploadFn({
      req,
      file,
      file_id,
      basePath,
      entity_id,
    });

    // SECOND: Upload to Vector DB
    const { uploadVectors } = require('./VectorDB/crud');

    embeddingResult = await uploadVectors({
      req,
      file,
      file_id,
      entity_id,
    });

    /* Vectors live under the entity that embedded them, and priming asks which namespaces
     * hold them rather than reading the root flag. Omitting it here re-embeds the file on
     * the first search, and aborts that search if RAG is briefly unavailable. */
    fileInfoMetadata = entity_id != null ? { embeddedEntities: [entity_id] } : {};
  } else if (isImage) {
    /* The conversion is this file's storage step. Uploading the original first left a
     * second object nothing references, and the record's size and dimensions describing
     * bytes that were replaced. Only the storage fields are kept: the record below is
     * built here, and its filename goes through the sanitizer. */
    const converted = await processImageFile({
      req,
      file,
      metadata: { file_id },
      returnFile: true,
    });
    storedType = converted.type ?? storedType;
    storageResult = {
      bytes: converted.bytes,
      filepath: converted.filepath,
      storageKey: converted.storageKey,
      storageRegion: converted.storageRegion,
      height: converted.height,
      width: converted.width,
    };
  } else {
    // Standard single storage for non-RAG files
    const { handleFileUpload } = getStrategyFunctions(source);
    const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
    storageResult = await sanitizedUploadFn({
      req,
      file,
      file_id,
      basePath,
      entity_id,
    });
  }

  if (shouldUploadToCodeEnv) {
    const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(FileSources.execute_code);
    const { getDownloadStream } = getStrategyFunctions(source);
    if (!getDownloadStream && source !== FileSources.local) {
      throw new Error(`No download stream available for ${source} storage`);
    }
    /* Upload from the persisted representation. Images have already been converted here,
     * so both the bytes and extension advertised to the sandbox describe the same file. */
    const downloadPath = storageResult.storageKey ?? storageResult.filepath;
    const codeKind = messageAttachment === true ? 'user' : 'agent';
    const codeId = messageAttachment === true ? req.user.id : agent_id;
    const sandboxFilename = resolveSandboxFilename(sanitizeFilename(file.originalname), storedType);
    const uploadOptions = getCodeApiUploadOptions(req, 'default');
    let uploaded;
    try {
      uploaded = await withCodeApiUploadRecovery({
        registry: req.app?.locals?.codeApiUploadRegistry,
        scope: uploadOptions.scope,
        concurrency: uploadOptions.concurrency,
        label: `uploading "${sandboxFilename}" to the code environment`,
        budget: createCodeApiRateLimitBudget(uploadOptions.retryWaitMs),
        onWait: (waitMs) =>
          logger.warn(
            `[processAgentFileUpload] Rate-limited Code API upload; retrying in ${waitMs}ms`,
          ),
        openSource: () =>
          getDownloadStream
            ? getDownloadStream(req, downloadPath)
            : Promise.resolve(fs.createReadStream(file.path)),
        upload: (stream) =>
          uploadCodeEnvFile({
            req,
            stream,
            filename: sandboxFilename,
            kind: codeKind,
            id: codeId,
          }),
      });
    } catch (error) {
      const { deleteFile } = getStrategyFunctions(source);
      if (deleteFile) {
        try {
          await deleteFile(req, {
            file_id,
            filepath: storageResult.filepath,
            storageKey: storageResult.storageKey,
            storageRegion: storageResult.storageRegion,
            source,
          });
        } catch (cleanupError) {
          logger.error('[processAgentFileUpload] Failed to clean up stored file', cleanupError);
        }
      }
      throw error;
    }
    fileInfoMetadata = mergeCodeEnvRef(undefined, {
      kind: codeKind,
      id: codeId,
      storage_session_id: uploaded.storage_session_id,
      file_id: uploaded.file_id,
      executionProfile: 'default',
      provisionedAt: Date.now(),
    });
  }

  let {
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    height,
    width,
  } = storageResult;
  // For RAG files, use embedding result; for others, use storage result
  let embedded = storageResult.embedded;
  if (
    effectiveToolResource === EToolResources.file_search &&
    tool_resource === EToolResources.file_search
  ) {
    embedded = embeddingResult?.embedded;
    filename = embeddingResult?.filename || filename;
  }

  let filepath = _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });

  if (!messageAttachment && effectiveToolResource) {
    await db.addAgentResourceFile({
      file_id,
      agent_id,
      tool_resource: effectiveToolResource,
      updatingUserId: req?.user?.id,
    });
  }

  const retentionExpiry = await retentionExpiryPromise;
  const fileInfo = {
    ...removeNullishValues({
      user: req.user.id,
      file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
      model: messageAttachment ? undefined : req.body.model,
      metadata: {
        ...(fileInfoMetadata ?? {}),
        ...uploadChoiceMetadata,
        /* The route was resolved against the upload's own type, and delivery re-resolves
         * it later. Conversion changes `type`, so without this the second answer is drawn
         * from a format the administrator never configured a route for. */
        ...(storedType !== file.mimetype ? { routingMimeType: file.mimetype } : {}),
      },
      type: storedType,
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
      llmDeliveryPath,
    }),
    ...retentionExpiry,
  };

  const result = await db.createFile(fileInfo, true);

  sendUploadSuccess(res, sseStream, 'Agent file uploaded and processed successfully', result);
};

/**
 * @param {object} params - The params object.
 * @param {OpenAI} params.openai - The OpenAI client instance.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} params.userId - The user ID.
 * @param {string} [params.filename] - The name of the file. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.saveFile=false] - Whether to save the file metadata to the database.
 * @param {boolean} [params.updateUsage=false] - Whether to update file usage in database.
 */
const processOpenAIFile = async ({
  openai,
  file_id,
  userId,
  filename,
  saveFile = false,
  updateUsage = false,
}) => {
  const retentionExpiryPromise = saveFile ? getRetentionExpiry(openai.req) : null;
  const _file = await openai.files.retrieve(file_id);
  const originalName = filename ?? (_file.filename ? path.basename(_file.filename) : undefined);
  const filepath = `${openai.baseURL}/files/${userId}/${file_id}${
    originalName ? `/${originalName}` : ''
  }`;
  const type = mime.getType(originalName ?? file_id);
  const source =
    openai.req.body.endpoint === EModelEndpoint.azureAssistants
      ? FileSources.azure
      : FileSources.openai;
  const file = {
    ..._file,
    type,
    file_id,
    filepath,
    usage: 1,
    user: userId,
    context: _file.purpose,
    source,
    model: openai.req.body.model,
    filename: originalName ?? file_id,
    ...(await retentionExpiryPromise),
    tenantId: openai.req?.user?.tenantId,
  };

  if (saveFile) {
    await db.createFile(file, true);
  } else if (updateUsage) {
    try {
      await db.updateFileUsage({
        file_id,
        user: userId,
        tenantId: openai.req?.user?.tenantId,
      });
    } catch (error) {
      logger.error('Error updating file usage', error);
    }
  }

  return file;
};

/**
 * Process OpenAI image files, convert to target format, save and return file metadata.
 * @param {object} params - The params object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Buffer} params.buffer - The image buffer.
 * @param {string} params.file_id - The file ID.
 * @param {string} params.filename - The filename.
 * @param {string} params.fileExt - The file extension.
 * @returns {Promise<MongoFile>} The file metadata.
 */
const processOpenAIImageOutput = async ({ req, buffer, file_id, filename, fileExt }) => {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const currentDate = new Date();
  const formattedDate = currentDate.toISOString();
  const appConfig = req.config;
  const _file = await convertImage(req, buffer, undefined, `${file_id}${fileExt}`);

  // Create only one file record with the correct information
  const file = {
    ..._file,
    usage: 1,
    user: req.user.id,
    type: mime.getType(fileExt),
    createdAt: formattedDate,
    updatedAt: formattedDate,
    source: getFileStrategy(appConfig, { isImage: true }),
    context: FileContext.assistants_output,
    file_id,
    filename,
    ...(await retentionExpiryPromise),
    tenantId: req.user.tenantId,
  };
  try {
    await db.createFile(file, true);
  } catch (error) {
    logger.warn('Error saving OpenAI image output file metadata', error);
  }
  return file;
};

/**
 * Retrieves and processes an OpenAI file based on its type.
 *
 * @param {Object} params - The params passed to the function.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {RunClient} params.client - The LibreChat client instance: either refers to `openai` or `streamRunManager`.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} [params.basename] - The basename of the file (if image); e.g., 'image.jpg'. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.unknownType] - Whether the file type is unknown.
 * @returns {Promise<{file_id: string, filepath: string, source: string, bytes?: number, width?: number, height?: number} | null>}
 * - Returns null if `file_id` is not defined; else, the file metadata if successfully retrieved and processed.
 */
async function retrieveAndProcessFile({
  openai,
  client,
  file_id,
  basename: _basename,
  unknownType,
}) {
  if (!file_id) {
    return null;
  }

  let basename = _basename;
  const processArgs = { openai, file_id, filename: basename, userId: client.req.user.id };

  // If no basename provided, return only the file metadata
  if (!basename) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  const fileExt = path.extname(basename);
  if (client.attachedFileIds?.has(file_id) || client.processedFileIds?.has(file_id)) {
    return processOpenAIFile({ ...processArgs, updateUsage: true });
  }

  // Prime both consumers before downloading content; each reuses its request's cached lookup.
  void getRetentionExpiry(client.req);
  if (openai.req !== client.req) {
    void getRetentionExpiry(openai.req);
  }

  /**
   * @returns {Promise<Buffer>} The file data buffer.
   */
  const getDataBuffer = async () => {
    const response = await openai.files.content(file_id);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  let dataBuffer;
  if (unknownType || !fileExt || imageExtRegex.test(basename)) {
    try {
      dataBuffer = await getDataBuffer();
    } catch (error) {
      logger.error('Error downloading file from OpenAI:', error);
      dataBuffer = null;
    }
  }

  if (!dataBuffer) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  // If the filetype is unknown, inspect the file
  if (dataBuffer && (unknownType || !fileExt)) {
    const detectedExt = await determineFileType(dataBuffer);
    const isImageOutput = detectedExt && imageExtRegex.test('.' + detectedExt);

    if (!isImageOutput) {
      return await processOpenAIFile({ ...processArgs, saveFile: true });
    }

    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt: detectedExt,
    });
  } else if (dataBuffer && imageExtRegex.test(basename)) {
    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt,
    });
  } else {
    logger.debug(`[retrieveAndProcessFile] Non-image file type detected: ${basename}`);
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }
}

/**
 * Converts a base64 string to a buffer.
 * @param {string} base64String
 * @returns {Buffer<ArrayBufferLike>}
 */
function base64ToBuffer(base64String) {
  try {
    const typeMatch = base64String.match(/^data:([A-Za-z-+/]+);base64,/);
    const type = typeMatch ? typeMatch[1] : '';

    const base64Data = base64String.replace(/^data:([A-Za-z-+/]+);base64,/, '');

    if (!base64Data) {
      throw new Error('Invalid base64 string');
    }

    return {
      buffer: Buffer.from(base64Data, 'base64'),
      type,
    };
  } catch (error) {
    throw new Error(`Failed to convert base64 to buffer: ${error.message}`);
  }
}

async function saveBase64Image(
  url,
  { req, file_id: _file_id, filename: _filename, endpoint, context, resolution },
) {
  const retentionExpiryPromise = getRetentionExpiry(req);
  const appConfig = req.config;
  const effectiveResolution = resolution ?? appConfig.fileConfig?.imageGeneration ?? 'high';
  const file_id = _file_id ?? v4();
  let filename = `${file_id}-${_filename}`;
  const { buffer: inputBuffer, type: declaredType } = base64ToBuffer(url);

  const image = await resizeImageBuffer(inputBuffer, effectiveResolution, endpoint);
  /** Sharp re-encodes what it resizes, so the bytes being saved are not necessarily in the
   * format the data URL declared — an SVG arrives here and is rasterized to PNG. The record has
   * to describe the bytes, because `file.type` is handed to providers verbatim as `media_type`
   * (Anthropic), `inlineData.mimeType` (Google), and the `data:` prefix (OpenAI). */
  const type = image.type ?? declaredType;
  if (!path.extname(_filename)) {
    const extension = mime.getExtension(type);
    if (extension) {
      filename += `.${extension}`;
    } else {
      throw new Error(`Could not determine file extension from MIME type: ${type}`);
    }
  }
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName: filename,
    buffer: image.buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      type,
      source,
      context,
      file_id,
      filepath,
      ...storageMetadata,
      filename,
      user: req.user.id,
      bytes: image.bytes,
      width: image.width,
      ...(await retentionExpiryPromise),
      height: image.height,
      tenantId: req.user.tenantId,
    },
    true,
  );
}

/**
 * Filters a file based on its size and the endpoint origin.
 *
 * @param {Object} params - The parameters for the function.
 * @param {ServerRequest} params.req - The request object from Express.
 * @param {string} [params.req.endpoint]
 * @param {string} [params.req.file_id]
 * @param {number} [params.req.width]
 * @param {number} [params.req.height]
 * @param {number} [params.req.version]
 * @param {boolean} [params.image] - Whether the file expected is an image.
 * @param {boolean} [params.isAvatar] - Whether the file expected is a user or entity avatar.
 * @returns {void}
 *
 * @throws {Error} If a file exception is caught (invalid file size or type, lack of metadata).
 */
/**
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {boolean} [params.image]
 * @param {boolean} [params.isAvatar]
 * @param {string} [params.endpoint] Effective endpoint for this upload. Agent uploads
 *   arrive as `agents` but route by the agent's own provider, so validation has to be
 *   told which configuration governs, or it admits files the provider rejects and
 *   rejects files the provider allows.
 */
function filterFile({ req, image, isAvatar, endpoint: endpointOverride }) {
  const { file } = req;
  const {
    endpoint: requestEndpoint,
    endpointType: requestEndpointType,
    file_id,
    width,
    height,
  } = req.body;
  const endpoint = endpointOverride ?? requestEndpoint;
  /* getEndpointFileConfig consults endpointType ahead of endpoint, so a composer upload
   * carrying `agents` would keep the Agents policy and shadow the provider the override
   * names. The override replaces both or neither. */
  const endpointType = endpointOverride != null ? undefined : requestEndpointType;

  if (!file_id && !isAvatar) {
    throw new Error('No file_id provided');
  }

  if (file.size === 0) {
    throw new Error('Empty file uploaded');
  }

  /* parse to validate api call, throws error on fail */
  if (!isAvatar) {
    isUUID.parse(file_id);
  }

  if (!endpoint && !isAvatar) {
    throw new Error('No endpoint provided');
  }

  const appConfig = req.config;
  const fileConfig = mergeFileConfig(appConfig.fileConfig);

  const endpointFileConfig = getEndpointFileConfig({
    endpoint,
    fileConfig,
    endpointType,
  });
  if (isAvatar !== true && endpointFileConfig?.disabled === true) {
    throw new Error(`File uploads are disabled for ${endpoint} endpoint`);
  }
  const fileSizeLimit =
    isAvatar === true ? fileConfig.avatarSizeLimit : endpointFileConfig.fileSizeLimit;

  if (file.size > fileSizeLimit) {
    throw new Error(
      `File size limit of ${fileSizeLimit / megabyte} MB exceeded for ${
        isAvatar ? 'avatar upload' : `${endpoint} endpoint`
      }`,
    );
  }

  const isSupportedMimeType = fileConfig.checkType(
    file.mimetype,
    endpointFileConfig.supportedMimeTypes,
  );

  if (!isSupportedMimeType) {
    throw new Error('Unsupported file type');
  }

  if (!image || isAvatar === true) {
    return;
  }

  if (!width) {
    throw new Error('No width provided');
  }

  if (!height) {
    throw new Error('No height provided');
  }
}

module.exports = {
  filterFile,
  processFileURL,
  saveBase64Image,
  processImageFile,
  uploadImageBuffer,
  sweepExpiredFiles,
  startExpiredFileSweep,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
  retrieveAndProcessFile,
};
