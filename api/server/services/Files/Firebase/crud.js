const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const {
  deleteRagFile,
  getFirebaseStorage,
  assertRemoteFileURL,
  getSafeErrorMetadata,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
} = require('@librechat/api');
const { ref, uploadBytes, getDownloadURL, deleteObject } = require('firebase/storage');
const { getBufferMetadata } = require('~/server/utils');

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
 * Retrieves the download URL for a specified file from Firebase Storage. This function initializes the
 * Firebase Storage and generates a reference to the file based on the provided basePath and file name. If
 * Firebase Storage is not initialized or if there is an error in fetching the URL, the error is logged
 * to the console.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.fileName - The name of the file for which the URL is to be retrieved. This should
 *                                   include the file extension.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in Firebase Storage where the file is
 *                                          stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<string|null>}
 *          A promise that resolves to the download URL of the file if successful, or null if there is an
 *          error in initialization or fetching the URL.
 */
async function getFirebaseURL({ fileName, basePath = 'images' }) {
  const storage = getFirebaseStorage();
  if (!storage) {
    logger.error('Firebase is not initialized. Cannot get image URL from Firebase Storage.');
    return null;
  }

  const storageRef = ref(storage, `${basePath}/${fileName}`);

  try {
    return await getDownloadURL(storageRef);
  } catch (error) {
    logger.error('Error fetching file URL from Firebase Storage:', error.message);
    return null;
  }
}

/**
 * Uploads a buffer to Firebase Storage.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The user's unique identifier. This is used to create a user-specific basePath
 *                                 in Firebase Storage.
 * @param {string} params.fileName - The name of the file to be saved in Firebase Storage.
 * @param {string} params.buffer - The buffer to be uploaded.
 * @param {string} [params.basePath='images'] - Optional. The base basePath in Firebase Storage where the file will
 *                                          be stored. Defaults to 'images' if not specified.
 *
 * @returns {Promise<string>} - A promise that resolves to the download URL of the uploaded file.
 */
async function saveBufferToFirebase({ userId, buffer, fileName, basePath = 'images' }) {
  const storage = getFirebaseStorage();
  if (!storage) {
    throw new Error('Firebase is not initialized');
  }

  const storageRef = ref(storage, `${basePath}/${userId}/${fileName}`);
  await uploadBytes(storageRef, buffer);

  // Assuming you have a function to get the download URL
  return await getFirebaseURL({ fileName, basePath: `${basePath}/${userId}` });
}

/**
 * Extracts and decodes the file path from a Firebase Storage URL.
 *
 * @param {string} urlString - The Firebase Storage URL.
 * @returns {string} The decoded file path.
 */
function extractFirebaseFilePath(urlString) {
  try {
    const url = new URL(urlString);
    const pathRegex = /\/o\/(.+?)(\?|$)/;
    const match = url.pathname.match(pathRegex);

    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }

    return '';
  } catch {
    logger.debug(
      '[extractFirebaseFilePath] Failed to extract Firebase file path from URL, returning empty string',
    );
    // If URL parsing fails, return an empty string
    return '';
  }
}

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
const deleteFirebaseFile = async (req, file) => {
  await deleteRagFile({ userId: req.user.id, file });

  const fileName = extractFirebaseFilePath(file.filepath);
  if (!fileName.includes(req.user.id)) {
    throw new Error('Invalid file path');
  }
  try {
    await deleteFile('', fileName);
  } catch (error) {
    logger.error('Error deleting file from Firebase:', error);
    if (error.code === 'storage/object-not-found') {
      return;
    }
    throw error;
  }
};

/**
 * Uploads a file to Firebase Storage.
 *
 * @param {Object} params - The params object.
 * @param {ServerRequest} params.req - The request object from Express. It should have a `user` property with an `id`
 *                       representing the user.
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The download URL of the uploaded file.
 *            - bytes: The size of the uploaded file in bytes.
 */
async function uploadFileToFirebase({ req, file, file_id }) {
  const inputFilePath = file.path;
  const inputBuffer = await fs.promises.readFile(inputFilePath);
  const bytes = Buffer.byteLength(inputBuffer);
  const userId = req.user.id;
  const fileName = `${file_id}__${path.basename(inputFilePath)}`;
  try {
    const downloadURL = await saveBufferToFirebase({ userId, buffer: inputBuffer, fileName });
    return { filepath: downloadURL, bytes };
  } catch (err) {
    logger.error('[uploadFileToFirebase] Error saving file buffer to Firebase:', err);
    try {
      if (file && file.path) {
        await fs.promises.unlink(file.path);
      }
    } catch (unlinkError) {
      logger.error(
        '[uploadFileToFirebase] Error deleting temporary file, likely already deleted:',
        unlinkError.message,
      );
    }
    throw err;
  }
}

/**
 * Retrieves a readable stream for a file from Firebase storage.
 *
 * @param {ServerRequest} _req
 * @param {string} filepath - The filepath.
 * @returns {Promise<ReadableStream>} A readable stream of the file.
 */
async function getFirebaseFileStream(_req, filepath, { signal } = {}) {
  try {
    const storage = getFirebaseStorage();
    if (!storage) {
      throw new Error('Firebase is not initialized');
    }

    const response = await axios({
      method: 'get',
      url: filepath,
      responseType: 'stream',
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
  getFirebaseFileStream,
};
