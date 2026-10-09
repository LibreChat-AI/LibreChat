const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { stripCacheBust } = require('@librechat/api');
const { resizeImageBuffer } = require('../images/resize');
const { updateUser, updateFile } = require('~/models');

/**
 * Converts an image file to the target format. The function first resizes the image based on the specified
 * resolution.
 *
 * If the original image is already in target format, it writes the resized image back. Otherwise,
 * it converts the image to target format before saving.
 *
 * The original image is deleted after conversion.
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {EModelEndpoint} params.endpoint - The params object.
 * @param {string} [params.resolution='high'] - Optional. The desired resolution for the image resizing. Default is 'high'.
 *
 * @returns {Promise<{ filepath: string, bytes: number, width: number, height: number}>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the converted image is saved.
 *            - bytes: The size of the converted image in bytes.
 *            - width: The width of the converted image.
 *            - height: The height of the converted image.
 */
async function uploadLocalImage({ req, file, file_id, endpoint, resolution = 'high' }) {
  const appConfig = req.config;
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const {
    buffer: resizedBuffer,
    width,
    height,
  } = await resizeImageBuffer(inputBuffer, resolution, endpoint);
  const extension = path.extname(inputFilePath);

  const { imageOutput } = appConfig.paths;
  const userPath = path.join(imageOutput, req.user.id);

  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(userPath, { recursive: true });
  }

  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  const newPath = path.join(userPath, fileName);
  const targetExtension = `.${appConfig.imageOutputType}`;

  if (extension.toLowerCase() === targetExtension) {
    const bytes = Buffer.byteLength(resizedBuffer);
    await fs.promises.writeFile(newPath, resizedBuffer);
    const filepath = path.posix.join('/', 'images', req.user.id, path.basename(newPath));
    return { filepath, bytes, width, height };
  }

  const outputFilePath = newPath.replace(extension, targetExtension);
  const data = await sharp(resizedBuffer).toFormat(appConfig.imageOutputType).toBuffer();
  await fs.promises.writeFile(outputFilePath, data);
  const bytes = Buffer.byteLength(data);
  const filepath = path.posix.join('/', 'images', req.user.id, path.basename(outputFilePath));
  await fs.promises.unlink(inputFilePath);
  return { filepath, bytes, width, height };
}

/**
 * Encodes an image file to base64.
 * @param {string} imagePath - The path to the image file.
 * @returns {Promise<string>} A promise that resolves with the base64 encoded image data.
 */
function encodeImage(imagePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(imagePath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data.toString('base64'));
      }
    });
  });
}

/**
 * Local: Updates the file and encodes the image to base64,
 * for image payload handling: tuple order of [filepath, base64].
 * @param {Object} req - The request object.
 * @param {MongoFile} file - The file object.
 * @returns {Promise<[MongoFile, string]>} - A promise that resolves to an array of results from updateFile and encodeImage.
 */
async function prepareImagesLocal(req, file) {
  const appConfig = req.config;
  const { publicPath, imageOutput } = appConfig.paths;
  const userPath = path.join(imageOutput, req.user.id);

  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(userPath, { recursive: true });
  }
  const filepath = path.join(publicPath, stripCacheBust(file.filepath));

  const promises = [];
  promises.push(updateFile({ file_id: file.file_id }));
  promises.push(encodeImage(filepath));
  return await Promise.all(promises);
}

/**
 * Uploads a user's avatar to local server storage and returns the URL.
 * If the 'manual' flag is set to 'true', it also updates the user's avatar URL in the database.
 *
 * @param {object} params - The parameters object.
 * @param {Buffer} params.buffer - The Buffer containing the avatar image.
 * @param {string} params.userId - The user ID.
 * @param {string} params.manual - A string flag indicating whether the update is manual ('true' or 'false').
 * @param {string} [params.agentId] - Optional agent ID if this is an agent avatar.
 * @returns {Promise<string>} - A promise that resolves with the URL of the uploaded avatar.
 * @throws {Error} - Throws an error if Firebase is not initialized or if there is an error in uploading.
 */
async function processLocalAvatar({ buffer, userId, manual, agentId }) {
  const userDir = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'client',
    'public',
    'images',
    userId,
  );

  const metadata = await sharp(buffer).metadata();
  const extension = metadata.format === 'gif' ? 'gif' : 'png';

  const timestamp = new Date().getTime();
  /** Unique filename with timestamp and optional agent ID */
  const fileName = agentId
    ? `agent-${agentId}-avatar-${timestamp}.${extension}`
    : `avatar-${timestamp}.${extension}`;
  const urlRoute = `/images/${userId}/${fileName}`;
  const avatarPath = path.join(userDir, fileName);

  await fs.promises.mkdir(userDir, { recursive: true });
  await fs.promises.writeFile(avatarPath, buffer);

  const isManual = manual === 'true';
  let url = `${urlRoute}?manual=${isManual}`;

  // Only update user record if this is a user avatar (manual === 'true')
  if (isManual && !agentId) {
    await updateUser(userId, { avatar: url });
  }

  return url;
}

module.exports = { uploadLocalImage, encodeImage, prepareImagesLocal, processLocalAvatar };
