const fs = require('fs');
const { toFile } = require('openai');
const { sleep } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { FilePurpose } = require('librechat-data-provider');

/**
 * Uploads a file that can be used across various OpenAI services.
 *
 * @param {Object} params - The params object.
 * @param {ServerRequest} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file uploaded to the server via multer.
 * @param {OpenAIClient} params.openai - The initialized OpenAI client.
 * @returns {Promise<OpenAIFile>}
 */
async function uploadOpenAIFile({ req, file, openai }) {
  const { height, width } = req.body;
  const isImage = height && width;
  /* Named from the upload rather than the staged path: staging prefixes a per-request id,
   * and this name is what the provider's file list and citations show. */
  const uploadedFile = await openai.files.create({
    file: await toFile(fs.createReadStream(file.path), file.originalname),
    purpose: isImage ? FilePurpose.Vision : FilePurpose.Assistants,
  });

  logger.debug(
    `[uploadOpenAIFile] User ${req.user.id} successfully uploaded file to OpenAI`,
    uploadedFile,
  );

  if (uploadedFile.status !== 'processed') {
    const sleepTime = 2500;
    logger.debug(
      `[uploadOpenAIFile] File ${
        uploadedFile.id
      } is not yet processed. Waiting for it to be processed (${sleepTime / 1000}s)...`,
    );
    await sleep(sleepTime);
  }

  return isImage ? { ...uploadedFile, height, width } : uploadedFile;
}

/**
 * Deletes a file previously uploaded to OpenAI.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The database representation of the uploaded file.
 * @param {OpenAI} openai - The initialized OpenAI client.
 * @returns {Promise<void>}
 */
async function deleteOpenAIFile(req, file, openai) {
  try {
    const res = await openai.files.del(file.file_id);
    if (!res.deleted) {
      throw new Error('OpenAI returned `false` for deleted status');
    }
    logger.debug(
      `[deleteOpenAIFile] User ${req.user.id} successfully deleted file "${file.file_id}" from OpenAI`,
    );
  } catch (error) {
    logger.error('[deleteOpenAIFile] Error deleting file from OpenAI: ' + error.message);
    throw error;
  }
}

/**
 * Retrieves a readable stream for a file from local storage.
 *
 * @param {string} file_id - The file_id.
 * @param {OpenAI} openai - The initialized OpenAI client.
 * @returns {Promise<ReadableStream>} A readable stream of the file.
 */
async function getOpenAIFileStream(file_id, openai) {
  try {
    return await openai.files.content(file_id);
  } catch (error) {
    logger.error('Error getting OpenAI file download stream:', error);
    throw error;
  }
}

module.exports = { uploadOpenAIFile, deleteOpenAIFile, getOpenAIFileStream };
