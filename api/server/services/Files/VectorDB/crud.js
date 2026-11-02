const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const {
  logAxiosError,
  generateShortLivedToken,
  createVectorFileDeleter,
  dispatchFileStorageOperation,
} = require('@librechat/api');

const deleteVectors = (req, file) =>
  createVectorFileDeleter({
    baseUrl: process.env.RAG_API_URL,
    httpClient: axios,
    generateToken: generateShortLivedToken,
    ownershipTrackingStart: req.config?.fileConfig?.vectorOwnershipTrackingStart,
    namespaceConcurrency: req.config?.fileConfig?.vectorDeletionConcurrency,
  })(req, file);

/**
 * Uploads a file to the configured Vector database
 *
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {string} [params.entity_id] - The entity ID for shared resources.
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadVectors({
  req,
  file,
  file_id,
  entity_id,
  storageMetadata,
  signal,
  onUploadStart,
}) {
  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', fs.createReadStream(file.path));
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    // Include storage metadata for RAG API to store with embeddings
    if (storageMetadata) {
      formData.append('storage_metadata', JSON.stringify(storageMetadata));
    }

    const formHeaders = formData.getHeaders();

    const response = await dispatchFileStorageOperation(onUploadStart, () =>
      axios.post(`${process.env.RAG_API_URL}/embed`, formData, {
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          accept: 'application/json',
          ...formHeaders,
        },
      }),
    );

    const responseData = response.data;
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      throw new Error('File embedding failed.');
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      filepath: FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.', { cause: error });
  }
}

module.exports = {
  deleteVectors,
  uploadVectors,
};
