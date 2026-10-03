const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { sanitizeFilename, createCustomError, isAdmissibleUploadType } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  mergeFileConfig,
  isAgentsEndpoint,
  resolveEffectiveMimeType,
  getEndpointFileConfig,
} = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');

const createStorage = ({ uniqueTempPath = false } = {}) =>
  multer.diskStorage({
    destination: function (req, file, cb) {
      const appConfig = req.config;
      const outputPath = path.join(appConfig.paths.uploads, 'temp', req.user.id);
      try {
        if (!fs.existsSync(outputPath)) {
          fs.mkdirSync(outputPath, { recursive: true });
        }
      } catch (error) {
        logger.error(
          `Failed to prepare upload directory: ${error instanceof Error ? error.message : String(error)}`,
        );
        const uploadError = createCustomError(500, 'Failed to prepare upload directory');
        uploadError.cause = error;
        return cb(uploadError);
      }
      cb(null, outputPath);
    },
    filename: function (req, file, cb) {
      req.file_id = crypto.randomUUID();
      try {
        file.originalname = decodeURIComponent(file.originalname);
      } catch {
        return cb(createCustomError(400, 'Invalid filename encoding'));
      }
      const sanitizedFilename = sanitizeFilename(file.originalname);
      const stagedFilename = uniqueTempPath
        ? sanitizeFilename(`${req.file_id}-${sanitizedFilename}`)
        : sanitizedFilename;
      cb(null, stagedFilename);
    },
  });

const storage = createStorage();

const importFileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/json') {
    cb(null, true);
  } else if (path.extname(file.originalname).toLowerCase() === '.json') {
    cb(null, true);
  } else {
    cb(createCustomError(415, 'Only JSON files are allowed'), false);
  }
};

/** Every type some configured endpoint accepts, for a request whose real endpoint is only
 *  known after an agent read this filter cannot make. */
const collectSupportedMimeTypes = (customFileConfig, endpointFileConfig) => {
  const merged = [...(endpointFileConfig.supportedMimeTypes ?? [])];
  for (const config of Object.values(customFileConfig?.endpoints ?? {})) {
    for (const mimeType of config?.supportedMimeTypes ?? []) {
      merged.push(mimeType);
    }
  }
  return merged;
};

/**
 * Admission reads the upload exactly as routing does. A client that types by magic bytes
 * calls a `.docx` an archive, and resolving that here keeps a narrowed endpoint allowlist
 * from refusing a document the parser downstream would have accepted.
 */
const normalizeUploadMimeType = (file) => {
  const mimeType = resolveEffectiveMimeType(file.originalname || '', file.mimetype || '');
  if (mimeType && file.mimetype !== mimeType) {
    file.mimetype = mimeType;
  }
  return mimeType;
};

/**
 *
 * @param {import('librechat-data-provider').FileConfig | undefined} customFileConfig
 */
const createFileFilter = (customFileConfig, resolveEndpoint) => {
  /**
   * @param {ServerRequest} req
   * @param {Express.Multer.File}
   * @param {import('multer').FileFilterCallback} cb
   */
  const fileFilter = (req, file, cb) => {
    if (!file) {
      return cb(createCustomError(400, 'No file provided'), false);
    }

    const mimeType = normalizeUploadMimeType(file);

    if (req.originalUrl.endsWith('/speech/stt') && mimeType.startsWith('audio/')) {
      return cb(null, true);
    }

    const resolved = resolveEndpoint?.(req);
    const endpoint = resolved?.endpoint ?? req.body.endpoint;
    const endpointType = resolved?.endpointType ?? req.body.endpointType;
    /* The principal-merged config, which `configMiddleware` puts on the request before
     * this route runs. The instance-level one was resolved once at startup, so a tenant,
     * role or user override would be invisible here and the upload refused before the
     * post-upload gate could apply the configuration that actually governs it. */
    const effectiveFileConfig = req.config?.fileConfig
      ? mergeFileConfig(req.config.fileConfig)
      : customFileConfig;
    const endpointFileConfig = getEndpointFileConfig({
      fileConfig: effectiveFileConfig,
      endpoint,
      endpointType,
    });

    /* An agent upload is validated again under the agent's own provider once the route
     * has resolved and authorized it. That provider's allowlist can be wider than the
     * `agents` entry, and this filter is synchronous so it cannot resolve it, so here the
     * question is only whether any configured endpoint accepts the type. Narrowing to
     * `agents` would make the later provider check able to reject but never to permit. */
    const supportedMimeTypes = isAgentsEndpoint(endpoint)
      ? collectSupportedMimeTypes(effectiveFileConfig, endpointFileConfig)
      : endpointFileConfig.supportedMimeTypes;

    /* An admin who names a type in `documentParser.supportedMimeTypes` has said the
     * server parses it, so this filter admits those too. Deliberately not scoped to
     * context uploads here: this runs while the file part is still streaming, before the
     * fields that follow it have been parsed, and a multipart client may legally send
     * `tool_resource` after the file. `filterFile` applies that scope on a complete body
     * a moment later, before any provider is handed the upload, so the only thing this
     * admits is a temporary file that the next gate deletes. */
    const admitted = isAdmissibleUploadType({
      mimeType,
      fileConfig: effectiveFileConfig,
      endpointMimeTypes: supportedMimeTypes,
      admitParserTypes: true,
    });

    if (!admitted) {
      return cb(
        createCustomError(415, 'Unsupported file type: ' + (file.mimetype || mimeType)),
        false,
      );
    }

    cb(null, true);
  };

  return fileFilter;
};

const createMulterInstance = async (options = {}) => {
  const { resolveEndpoint, uniqueTempPath = false } = options;
  const appConfig = Object.prototype.hasOwnProperty.call(options, 'fileConfig')
    ? null
    : await getAppConfig();
  const fileConfig = mergeFileConfig(options.fileConfig ?? appConfig?.fileConfig);
  const fileFilter = createFileFilter(fileConfig, resolveEndpoint);
  return multer({
    storage: uniqueTempPath ? createStorage({ uniqueTempPath: true }) : storage,
    fileFilter,
    limits: { fileSize: fileConfig.serverFileSizeLimit },
  });
};

module.exports = {
  createMulterInstance,
  createStorage,
  storage,
  importFileFilter,
  createFileFilter,
};
