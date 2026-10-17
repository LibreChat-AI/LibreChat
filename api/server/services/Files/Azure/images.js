const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { logger } = require('@librechat/data-schemas');
const { resizeImageBuffer } = require('../images/resize');
const { updateUser, updateFile } = require('~/models');
const { saveBufferToAzure } = require('./crud');

/**
 * Uploads an image file to Azure Blob Storage.
 * It resizes and converts the image similar to your Firebase implementation.
 *
 * @param {Object} params
 * @param {object} params.req - The Express request object.
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file id.
 * @param {EModelEndpoint} params.endpoint - The endpoint parameters.
 * @param {string} [params.resolution='high'] - The image resolution.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<{ filepath: string, bytes: number, width: number, height: number }>}
 */
async function uploadImageToAzure({
  req,
  file,
  file_id,
  endpoint,
  resolution = 'high',
  basePath = 'images',
  containerName,
}) {
  try {
    const appConfig = req.config;
    const inputFilePath = file.path;
    const inputBuffer = await fs.promises.readFile(inputFilePath);
    const {
      buffer: resizedBuffer,
      width,
      height,
      type,
    } = await resizeImageBuffer(inputBuffer, resolution, endpoint);
    const extension = path.extname(inputFilePath);
    const userId = req.user.id;
    let webPBuffer;
    let fileName = `${file_id}__${path.basename(inputFilePath)}`;
    const targetExtension = `.${appConfig.imageOutputType}`;

    /* The name is only a claim about the contents; the bytes have to agree before conversion is
     * skipped, or the record is typed from a name that misdescribes what was stored. */
    if (
      extension.toLowerCase() === targetExtension &&
      type === `image/${appConfig.imageOutputType}`
    ) {
      webPBuffer = resizedBuffer;
    } else {
      webPBuffer = await sharp(resizedBuffer).toFormat(appConfig.imageOutputType).toBuffer();
      const extRegExp = new RegExp(path.extname(fileName) + '$');
      fileName = fileName.replace(extRegExp, targetExtension);
      if (!path.extname(fileName)) {
        fileName += targetExtension;
      }
    }
    const downloadURL = await saveBufferToAzure({
      userId,
      buffer: webPBuffer,
      fileName,
      basePath,
      containerName,
    });
    await fs.promises.unlink(inputFilePath);
    const bytes = Buffer.byteLength(webPBuffer);
    return { filepath: downloadURL, bytes, width, height };
  } catch (error) {
    logger.error('[uploadImageToAzure] Error uploading image:', error);
    throw error;
  }
}

/**
 * Prepares the image URL and updates the file record.
 *
 * @param {object} req - The Express request object.
 * @param {MongoFile} file - The file object.
 * @returns {Promise<[MongoFile, string]>}
 */
async function prepareAzureImageURL(req, file) {
  const { filepath } = file;
  const promises = [];
  promises.push(updateFile({ file_id: file.file_id }));
  promises.push(filepath);
  return await Promise.all(promises);
}

/**
 * Uploads and processes a user's avatar to Azure Blob Storage.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - The avatar image buffer.
 * @param {string} params.userId - The user's id.
 * @param {string} params.manual - Flag to indicate manual update.
 * @param {string} [params.agentId] - Optional agent ID if this is an agent avatar.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the avatar.
 */
async function processAzureAvatar({
  buffer,
  userId,
  manual,
  agentId,
  basePath = 'images',
  containerName,
}) {
  try {
    const metadata = await sharp(buffer).metadata();
    const extension = metadata.format === 'gif' ? 'gif' : 'png';
    const timestamp = new Date().getTime();

    /** Unique filename with timestamp and optional agent ID */
    const fileName = agentId
      ? `agent-${agentId}-avatar-${timestamp}.${extension}`
      : `avatar-${timestamp}.${extension}`;

    const downloadURL = await saveBufferToAzure({
      userId,
      buffer,
      fileName,
      basePath,
      containerName,
    });
    const isManual = manual === 'true';
    const url = `${downloadURL}?manual=${isManual}`;

    // Only update user record if this is a user avatar (manual === 'true')
    if (isManual && !agentId) {
      await updateUser(userId, { avatar: url });
    }

    return url;
  } catch (error) {
    logger.error('[processAzureAvatar] Error uploading profile picture to Azure:', error);
    throw error;
  }
}

module.exports = {
  uploadImageToAzure,
  prepareAzureImageURL,
  processAzureAvatar,
};
