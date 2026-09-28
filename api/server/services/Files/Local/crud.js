const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  deleteRagFile,
  stripCacheBust,
  assertRemoteFileURL,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { resizeImageBuffer } = require('~/server/services/Files/images/resize');
const { getBufferMetadata } = require('~/server/utils');
const paths = require('~/config/paths');

/**
 * Saves a file to a specified output path with a new filename.
 *
 * @param {Express.Multer.File} file - The file object to be saved. Should contain properties like 'originalname' and 'path'.
 * @param {string} outputPath - The path where the file should be saved.
 * @param {string} outputFilename - The new filename for the saved file (without extension).
 * @returns {Promise<string>} The full path of the saved file.
 * @throws Will throw an error if the file saving process fails.
 */
async function saveLocalFile(file, outputPath, outputFilename) {
  try {
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    const fileExtension = path.extname(file.originalname);
    const filenameWithExt = outputFilename + fileExtension;
    const outputFilePath = path.join(outputPath, filenameWithExt);
    fs.copyFileSync(file.path, outputFilePath);
    fs.unlinkSync(file.path);

    return outputFilePath;
  } catch (error) {
    logger.error('[saveFile] Error while saving the file:', error);
    throw error;
  }
}

/**
 * Saves an uploaded image file to a specified directory based on the user's ID and a filename.
 *
 * @param {ServerRequest} req - The Express request object, containing the user's information and app configuration.
 * @param {Express.Multer.File} file - The uploaded file object.
 * @param {string} filename - The new filename to assign to the saved image (without extension).
 * @returns {Promise<void>}
 * @throws Will throw an error if the image saving process fails.
 */
const saveLocalImage = async (req, file, filename) => {
  const appConfig = req.config;
  const imagePath = appConfig.paths.imageOutput;
  const outputPath = path.join(imagePath, req.user.id ?? '');
  await saveLocalFile(file, outputPath, filename);
};

/**
 * Saves a buffer to a specified directory on the local file system.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific directory.
 * @param {Buffer} params.buffer - The buffer to be saved.
 * @param {string} params.fileName - The name of the file to be saved.
 * @param {string} [params.basePath='images'] - Optional. The base path where the file will be stored.
 *                                          Defaults to 'images' if not specified.
 * @returns {Promise<string>} - A promise that resolves to the path of the saved file.
 */
async function saveLocalBuffer({ userId, buffer, fileName, basePath = 'images' }) {
  try {
    const { publicPath, uploads } = paths;

    /**
     * For 'images': save to publicPath/images/userId (images are served statically)
     * For 'uploads': save to uploads/userId (files downloaded via API)
     * */
    const directoryPath =
      basePath === 'images' ? path.join(publicPath, basePath, userId) : path.join(uploads, userId);

    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    const resolvedDir = path.resolve(directoryPath);
    const resolvedPath = path.resolve(resolvedDir, fileName);
    const rel = path.relative(resolvedDir, resolvedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
      throw new Error('Path traversal detected in filename');
    }
    fs.writeFileSync(resolvedPath, buffer);

    const filePath = path.posix.join('/', basePath, userId, fileName);

    return filePath;
  } catch (error) {
    logger.error('[saveLocalBuffer] Error while saving the buffer:', error);
    throw error;
  }
}

/**
 * Saves a file from a given URL to a local directory. The function fetches the file using the provided URL,
 * determines the content type, and saves it to a specified local directory with the correct file extension.
 * If the specified directory does not exist, it is created. The function returns the name of the saved file
 * or null in case of an error.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific path
 *                                 in the local file system.
 * @param {string} params.URL - The URL of the file to be downloaded and saved.
 * @param {string} params.fileName - The desired file name for the saved file. This may be modified to include
 *                                   the correct file extension based on the content type.
 * @param {string} [params.basePath='images'] - Optional. The base directory where the file will be saved.
 *                                              Defaults to 'images' if not specified.
 *
 * @returns {Promise<{ bytes: number, type: string, dimensions: Record<string, number>} | null>}
 *          A promise that resolves to the file metadata if the file is successfully saved, or null if there is an error.
 */
async function saveFileFromURL({ userId, URL, fileName, basePath = 'images' }) {
  try {
    const maxBytes = getRemoteFileFetchMaxBytes();
    const response = await axios({
      url: assertRemoteFileURL(URL),
      responseType: 'arraybuffer',
      timeout: getRemoteFileFetchTimeoutMs(),
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
    });
    assertRemoteFileContentLength(response.headers, maxBytes);

    const buffer = Buffer.from(response.data, 'binary');
    if (buffer.length > maxBytes) {
      throw new Error(`Remote file response too large: ${buffer.length} bytes`);
    }

    const { bytes, type, dimensions, extension } = await getBufferMetadata(buffer);

    // Construct the outputPath based on the basePath and userId
    const outputPath = path.join(paths.publicPath, basePath, userId.toString());

    // Check if the output directory exists, if not, create it
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    // Replace or append the correct extension
    const extRegExp = new RegExp(path.extname(fileName) + '$');
    fileName = fileName.replace(extRegExp, `.${extension}`);
    if (!path.extname(fileName)) {
      fileName += `.${extension}`;
    }

    // Save the file to the output path
    const outputFilePath = path.join(outputPath, fileName);
    fs.writeFileSync(outputFilePath, buffer);

    return {
      bytes,
      type,
      dimensions,
    };
  } catch (error) {
    logger.error('[saveFileFromURL] Error while saving the file:', error);
    return null;
  }
}

/**
 * Constructs a local file path for a given file name and base path. This function simply joins the base
 * path and the file name to create a file path. It does not check for the existence of the file at the path.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.fileName - The name of the file for which the path is to be constructed. This should
 *                                   include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base directory to be used for constructing the file path.
 *                                              Defaults to 'images' if not specified.
 *
 * @returns {string}
 *          The constructed local file path.
 */
async function getLocalFileURL({ fileName, basePath = 'images' }) {
  return path.posix.join('/', basePath, fileName);
}

/**
 * Validates that a filepath is strictly contained within a subdirectory under a base path,
 * using path.relative to prevent prefix-collision bypasses.
 *
 * @param {ServerRequest} req - The request object from Express. It should contain a `user` property with an `id`.
 * @param {string} base - The base directory path.
 * @param {string} subfolder - The subdirectory under the base path.
 * @param {string} filepath - The complete file path to be validated.
 *
 * @returns {boolean}
 *          Returns true if the filepath is within the specified base and subfolder, false otherwise.
 */
const isValidPath = (req, base, subfolder, filepath) => {
  const normalizedBase = path.resolve(base, subfolder, req.user.id);
  const normalizedFilepath = path.resolve(filepath);
  const rel = path.relative(normalizedBase, normalizedFilepath);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(`..${path.sep}`);
};

/**
 * @param {string} filepath
 */
/**
 * A file whose bytes are still on disk must not be reported as deleted: callers use the resolved
 * promise to decide that a record may lose its metadata and its agent references. Storage that was
 * already gone is the one benign case, and `processDeleteRequest` treats it as deleted by design.
 */
const unlinkFile = async (filepath) => {
  try {
    await fs.promises.unlink(filepath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      logger.warn('Local file was already missing during delete:', error);
      return;
    }
    logger.error('Error deleting file:', error);
    throw error;
  }
};

/**
 * Deletes a file from the filesystem. This function takes a file object, constructs the full path, and
 * verifies the path's validity before deleting the file. If the path is invalid, an error is thrown.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The file object to be deleted. It should have a `filepath` property that is
 *                           a string representing the path of the file relative to the publicPath.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted, or throws an error if the
 *          file path is invalid or if there is an error in deletion.
 */
const deleteLocalFile = async (req, file) => {
  const appConfig = req.config;
  const { publicPath, uploads } = appConfig.paths;

  /** Filepath stripped of query parameters (e.g., ?manual=true, ?v=<timestamp>) */
  const cleanFilepath = stripCacheBust(file.filepath);

  await deleteRagFile({ userId: req.user.id, file });

  if (cleanFilepath.startsWith(`/uploads/${req.user.id}`)) {
    const userUploadDir = path.join(uploads, req.user.id);
    const basePath = cleanFilepath.split(`/uploads/${req.user.id}/`)[1];

    if (!basePath) {
      throw new Error(`Invalid file path: ${cleanFilepath}`);
    }

    const filepath = path.join(userUploadDir, basePath);

    const rel = path.relative(userUploadDir, filepath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
      throw new Error(`Invalid file path: ${cleanFilepath}`);
    }

    await unlinkFile(filepath);
    return;
  }

  const parts = cleanFilepath.split(path.sep);
  const subfolder = parts[1];
  if (!subfolder && parts[0] === EModelEndpoint.agents) {
    logger.warn(`Agent File ${file.file_id} is missing filepath, may have been deleted already`);
    return;
  }
  const filepath = path.join(publicPath, cleanFilepath);

  if (!isValidPath(req, publicPath, subfolder, filepath)) {
    throw new Error('Invalid file path');
  }

  await unlinkFile(filepath);
};

/**
 * Uploads a file to the specified upload directory.
 *
 * @param {Object} params - The params object.
 * @param {ServerRequest} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadLocalFile({ req, file, file_id }) {
  const appConfig = req.config;
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const bytes = Buffer.byteLength(inputBuffer);

  const { uploads } = appConfig.paths;
  const userPath = path.join(uploads, req.user.id);

  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(userPath, { recursive: true });
  }

  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  const newPath = path.join(userPath, fileName);

  await fs.promises.writeFile(newPath, inputBuffer);
  const filepath = path.posix.join('/', 'uploads', req.user.id, path.basename(newPath));

  let height, width;
  if (file.mimetype && file.mimetype.startsWith('image/')) {
    try {
      const { width: imgWidth, height: imgHeight } = await resizeImageBuffer(inputBuffer, 'high');
      height = imgHeight;
      width = imgWidth;
    } catch (error) {
      logger.warn('[uploadLocalFile] Could not get image dimensions:', error.message);
    }
  }

  return { filepath, bytes, height, width };
}

/**
 * Retrieves a readable stream for a file from local storage.
 *
 * @param {ServerRequest} req - The request object from Express
 * @param {string} requestedFilepath - The filepath, which may carry a cache-busting query string.
 * @returns {ReadableStream} A readable stream of the file.
 */
async function getLocalFileStream(req, requestedFilepath) {
  try {
    const appConfig = req.config;
    /** Reused code outputs persist a `?v=<timestamp>` suffix that no file on disk carries */
    const filepath = stripCacheBust(requestedFilepath);
    if (filepath.includes('/uploads/')) {
      const basePath = filepath.split('/uploads/')[1];

      if (!basePath) {
        logger.warn(`Invalid base path: ${filepath}`);
        throw new Error(`Invalid file path: ${filepath}`);
      }

      const fullPath = path.join(appConfig.paths.uploads, basePath);
      const uploadsDir = appConfig.paths.uploads;

      const rel = path.relative(uploadsDir, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
        logger.warn(`Invalid relative file path: ${filepath}`);
        throw new Error(`Invalid file path: ${filepath}`);
      }

      return fs.createReadStream(fullPath);
    } else if (filepath.includes('/images/')) {
      const basePath = filepath.split('/images/')[1];

      if (!basePath) {
        logger.warn(`Invalid base path: ${filepath}`);
        throw new Error(`Invalid file path: ${filepath}`);
      }

      const fullPath = path.join(appConfig.paths.imageOutput, basePath);
      const publicDir = appConfig.paths.imageOutput;

      const rel = path.relative(publicDir, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
        logger.warn(`Invalid relative file path: ${filepath}`);
        throw new Error(`Invalid file path: ${filepath}`);
      }

      return fs.createReadStream(fullPath);
    }
    return fs.createReadStream(filepath);
  } catch (error) {
    logger.error('Error getting local file stream:', error);
    throw error;
  }
}

module.exports = {
  saveLocalFile,
  saveLocalImage,
  saveLocalBuffer,
  saveFileFromURL,
  getLocalFileURL,
  deleteLocalFile,
  uploadLocalFile,
  getLocalFileStream,
};
