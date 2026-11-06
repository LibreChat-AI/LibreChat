const fs = require('fs');
const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { getStorageMetadata, convertImageBuffer } = require('@librechat/api');
const { getStrategyFunctions } = require('../strategies');
const { resizeImageBuffer } = require('./resize');

/**
 * Converts an image file or buffer to target output type with specified resolution.
 *
 * @param {ServerRequest} req - The request object, containing user and app configuration data.
 * @param {Buffer | Express.Multer.File} file - The file object, containing either a path or a buffer.
 * @param {'low' | 'high'} [resolution='high'] - The desired resolution for the output image.
 * @param {string} [basename=''] - The basename of the input file, if it is a buffer.
 * @returns {Promise<{filepath: string, bytes: number, width: number, height: number, storageKey?: string, storageRegion?: string}>} An object containing the path, size, dimensions, and optional storage metadata of the converted image.
 * @throws Throws an error if there is an issue during the conversion process.
 */
async function convertImage(req, file, resolution = 'high', basename = '') {
  try {
    const appConfig = req.config;
    let inputBuffer;

    // Check if the input is a buffer or a file path
    if (Buffer.isBuffer(file)) {
      inputBuffer = file;
    } else if (file && file.path) {
      const inputFilePath = file.path;
      inputBuffer = await fs.promises.readFile(inputFilePath);
    } else {
      throw new Error('Invalid input: file must be a buffer or contain a valid path.');
    }

    // Resize the image buffer
    const {
      buffer: resizedBuffer,
      width,
      height,
      type,
    } = await resizeImageBuffer(inputBuffer, resolution);

    const { buffer: outputBuffer, fileName: newFileName } = await convertImageBuffer({
      buffer: resizedBuffer,
      type,
      fileName: path.basename(file.path ?? basename),
      outputType: appConfig.imageOutputType,
    });

    const { saveBuffer } = getStrategyFunctions(appConfig.fileStrategy);

    const savedFilePath = await saveBuffer({
      userId: req.user.id,
      buffer: outputBuffer,
      fileName: newFileName,
      tenantId: req.user.tenantId,
    });
    const storageMetadata = getStorageMetadata({
      filepath: savedFilePath,
      source: appConfig.fileStrategy,
    });

    const bytes = Buffer.byteLength(outputBuffer);
    return { filepath: savedFilePath, ...storageMetadata, bytes, width, height };
  } catch (err) {
    logger.error(err);
    throw err;
  }
}

module.exports = { convertImage };
