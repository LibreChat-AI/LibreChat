const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const {
  sanitizeFilename,
  createCustomError,
  FILENAME_SEGMENT_MAX_BYTES,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  mergeFileConfig,
  inferMimeType,
  isAgentsEndpoint,
  getEndpointFileConfig,
  fileConfig: defaultFileConfig,
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

/**
 * Storage for conversation-export uploads. Identical to `storage` except
 * that the stored name is prefixed with the per-upload id: an import job
 * keeps reading its archive long after the upload request ends (inspect →
 * confirm → run, up to the job TTL), so two uploads of the same
 * `conversations.zip` must not resolve to one path; otherwise the second
 * overwrites the archive the first is still importing, and cancelling
 * either deletes the other's file.
 */
const importStorage = multer.diskStorage({
  destination: storage.getDestination,
  filename: function (req, file, cb) {
    req.file_id = crypto.randomUUID();
    try {
      file.originalname = decodeURIComponent(file.originalname);
    } catch {
      return cb(createCustomError(400, 'Invalid filename encoding'));
    }
    /** The id prefix has to come out of the same NAME_MAX budget the
     * sanitizer truncates against. Left at the default, a legitimately long
     * export name sanitizes to a full 255 bytes and the prefix then pushes the
     * component past the limit, so multer fails with ENAMETOOLONG. */
    const prefix = `${req.file_id}-`;
    const budget = FILENAME_SEGMENT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8');
    cb(null, `${prefix}${sanitizeFilename(file.originalname, budget)}`);
  },
});

const IMPORT_EXTENSIONS = new Set(['.json', '.zip']);
const IMPORT_MIME_TYPES = new Set(['application/json', 'text/json']);

/**
 * Accepts `.json` and `.zip` conversation exports. The extension is
 * authoritative for `.zip`: browsers frequently send
 * `application/octet-stream` for archives, so trusting the MIME type alone
 * would let any file through under that generic type.
 *
 * A declared JSON MIME type is accepted without the extension, which API
 * clients and some drag-and-drop sources rely on. That is safe because the
 * upload's actual content is inspected before anything is imported: the
 * filter only decides whether the bytes are worth writing to disk.
 */
const importFileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();
  if (IMPORT_EXTENSIONS.has(extension)) {
    cb(null, true);
    return;
  }
  if (IMPORT_MIME_TYPES.has((file.mimetype || '').toLowerCase())) {
    cb(null, true);
    return;
  }
  cb(createCustomError(415, 'Unsupported import type'), false);
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

const normalizeUploadMimeType = (file) => {
  const mimeType = inferMimeType(file.originalname || '', file.mimetype || '');
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
    const endpointFileConfig = getEndpointFileConfig({
      fileConfig: customFileConfig,
      endpoint,
      endpointType,
    });

    /* An agent upload is validated again under the agent's own provider once the route
     * has resolved and authorized it. That provider's allowlist can be wider than the
     * `agents` entry, and this filter is synchronous so it cannot resolve it, so here the
     * question is only whether any configured endpoint accepts the type. Narrowing to
     * `agents` would make the later provider check able to reject but never to permit. */
    const supportedMimeTypes = isAgentsEndpoint(endpoint)
      ? collectSupportedMimeTypes(customFileConfig, endpointFileConfig)
      : endpointFileConfig.supportedMimeTypes;

    if (!defaultFileConfig.checkType(mimeType, supportedMimeTypes)) {
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
  importStorage,
  importFileFilter,
  createFileFilter,
};
