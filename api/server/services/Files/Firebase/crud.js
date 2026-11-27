const axios = require('axios');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const {
  deleteRagFile,
  createFirebaseUploads,
  createOwnedBlobFileDeleter,
  extractFirebaseBlobPath,
  getFirebaseStorage,
  assertRemoteFileURL,
  getSafeErrorMetadata,
  getOutboundTimeoutMs,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
} = require('@librechat/api');
const { ref, uploadBytes, deleteObject } = require('firebase/storage');
const { getBufferMetadata } = require('~/server/utils');

const { getFirebaseURL, saveBufferToFirebase, uploadFileToFirebase, deleteFirebaseObject } =
  createFirebaseUploads({ getStorage: getFirebaseStorage });

/**
 * Deletes a file from Firebase Storage.
 * @param {string} directory - The directory name
 * @param {string} fileName - The name of the file to delete.
 * @returns {Promise<void>} A promise that resolves when the file is deleted.
 */
async function deleteFile(basePath, fileName) {
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot delete file from Firebase Storage.');
    throw new Error('Firebase is not initialized');
  }

  const storageRef = ref(storage, `${basePath}/${fileName}`);

  try {
    await deleteObject(storageRef);
    logger.debug('File deleted successfully from Firebase Storage');
  } catch (error) {
    logger.error('Error deleting file from Firebase Storage:', error.message);
    throw error;
  }
}

/**
 * Saves an file from a given URL to Firebase Storage. The function first initializes the Firebase Storage
 * reference, then uploads the file to a specified basePath in the Firebase Storage. It handles initialization
 * errors and upload errors, logging them to the console. If the upload is successful, the file name is returned.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific basePath
 *                                 in Firebase Storage.
 * @param {string} params.URL - The URL of the file to be uploaded. The file at this URL will be fetched
 *                              and uploaded to Firebase Storage.
 * @param {string} params.fileName - The name that will be used to save the file in Firebase Storage. This
 *                                   should include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in Firebase Storage where the file will
 *                                          be stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<{ bytes: number, type: string, dimensions: Record<string, number>} | null>}
 *          A promise that resolves to the file metadata if the file is successfully saved, or null if there is an error.
 */
async function saveURLToFirebase({ userId, URL, fileName, basePath = 'images' }) {
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot save file to Firebase Storage.');
    return null;
  }

  const storageRef = ref(storage, `${basePath}/${userId.toString()}/${fileName}`);
  const maxBytes = getRemoteFileFetchMaxBytes();
  const response = await fetch(assertRemoteFileURL(URL), {
    timeout: getRemoteFileFetchTimeoutMs(),
    size: maxBytes,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  assertRemoteFileContentLength(response.headers, maxBytes);
  const buffer = await response.buffer();
  if (buffer.length > maxBytes) {
    throw new Error(`Remote file response too large: ${buffer.length} bytes`);
  }

  try {
    await uploadBytes(storageRef, buffer);
    return await getBufferMetadata(buffer);
  } catch (error) {
    logger.error('Error uploading file to Firebase Storage:', error.message);
    return null;
  }
}

/**
 * Extracts and decodes the file path from a Firebase Storage URL.
 *
 * @param {string} urlString - The Firebase Storage URL.
 * @returns {string} The decoded file path.
 */
/**
 * Deletes a file from Firebase storage. This function determines the filepath from the
 * Firebase storage URL via regex for deletion. Validated by the user's ID.
 *
 * @param {ServerRequest} req - The request object from Express.
 * It should contain a `user` object with an `id` property.
 * @param {MongoFile} file - The file object to be deleted.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted from Firebase storage.
 *          Throws an error if there is an issue with deletion.
 */
const deleteFirebaseFile = (req, file) =>
  createOwnedBlobFileDeleter({
    extractPath: extractFirebaseBlobPath,
    deleteBlob: (filepath) => deleteFile('', filepath),
    isMissing: (error) => error?.code === 'storage/object-not-found',
    deleteRagFile,
  })(req, file);

/**
 * Retrieves a readable stream for a file from Firebase storage.
 *
 * @param {ServerRequest} req
 * @param {string} filepath - The filepath.
 * @returns {Promise<ReadableStream>} A readable stream of the file.
 */
async function getFirebaseFileStream(req, filepath, { signal } = {}) {
  try {
    const storage = getFirebaseStorage();
    if (!storage) {
      throw new Error('Firebase is not initialized');
    }

    const response = await axios({
      method: 'get',
      url: filepath,
      responseType: 'stream',
      /** Idle socket time only: a long download that keeps flowing is not cut off. */
      timeout: getOutboundTimeoutMs(req?.config, 'imageFetchMs'),
      signal,
    });

    return response.data;
  } catch (error) {
    logger.error('Error getting Firebase file stream:', getSafeErrorMetadata(error));
    throw error;
  }
}

module.exports = {
  deleteFile,
  getFirebaseURL,
  saveURLToFirebase,
  deleteFirebaseFile,
  uploadFileToFirebase,
  saveBufferToFirebase,
  deleteFirebaseObject,
  getFirebaseFileStream,
};
