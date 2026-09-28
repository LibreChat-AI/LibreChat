const fs = require('fs');
const path = require('path');
const mime = require('mime');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const {
  deleteRagFile,
  assertRemoteFileURL,
  getSafeErrorMetadata,
  getAzureContainerClient,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
} = require('@librechat/api');

const defaultBasePath = 'images';
const { AZURE_STORAGE_PUBLIC_ACCESS = 'true', AZURE_CONTAINER_NAME = 'files' } = process.env;

/**
 * Uploads a buffer to Azure Blob Storage.
 *
 * Files will be stored at the path: {basePath}/{userId}/{fileName} within the container.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {Buffer} params.buffer - The buffer to upload.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob.
 */
async function saveBufferToAzure({
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const access = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true' ? 'blob' : undefined;
    // Create the container if it doesn't exist. This is done per operation.
    await containerClient.createIfNotExists({ access });
    const blobPath = `${basePath}/${userId}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.uploadData(buffer);
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[saveBufferToAzure] Error uploading buffer:', error);
    throw error;
  }
}

/**
 * Saves a file from a URL to Azure Blob Storage.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {string} params.URL - The URL of the file.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob.
 */
async function saveURLToAzure({
  userId,
  URL,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
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

    return await saveBufferToAzure({ userId, buffer, fileName, basePath, containerName });
  } catch (error) {
    logger.error('[saveURLToAzure] Error uploading file from URL:', error);
    throw error;
  }
}

/**
 * Retrieves a blob URL from Azure Blob Storage.
 *
 * @param {Object} params
 * @param {string} params.fileName - The file name.
 * @param {string} [params.basePath='images'] - The base folder used during upload.
 * @param {string} [params.userId] - If files are stored in a user-specific directory.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The blob's URL.
 */
async function getAzureURL({ fileName, basePath = defaultBasePath, userId, containerName }) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const blobPath = userId ? `${basePath}/${userId}/${fileName}` : `${basePath}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[getAzureURL] Error retrieving blob URL:', error);
    throw error;
  }
}

/**
 * Deletes a blob from Azure Blob Storage.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req - The Express request object.
 * @param {MongoFile} params.file - The file object.
 */
async function deleteFileFromAzure(req, file) {
  await deleteRagFile({ userId: req.user.id, file });

  try {
    const containerClient = await getAzureContainerClient(AZURE_CONTAINER_NAME);
    const blobPath = file.filepath.split(`${AZURE_CONTAINER_NAME}/`)[1];
    if (!blobPath.includes(req.user.id)) {
      throw new Error('User ID not found in blob path');
    }
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.delete();
    logger.debug('[deleteFileFromAzure] Blob deleted successfully from Azure Blob Storage');
  } catch (error) {
    logger.error('[deleteFileFromAzure] Error deleting blob:', error);
    if (error.statusCode === 404) {
      return;
    }
    throw error;
  }
}

/**
 * Streams a file from disk directly to Azure Blob Storage without loading
 * the entire file into memory.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {string} params.filePath - The local file path to upload.
 * @param {string} params.fileName - The name of the file in Azure.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob.
 */
async function streamFileToAzure({
  userId,
  filePath,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const access = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true' ? 'blob' : undefined;

    // Create the container if it doesn't exist
    await containerClient.createIfNotExists({ access });

    const blobPath = `${basePath}/${userId}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

    // Get file size for proper content length
    const stats = await fs.promises.stat(filePath);

    // Create read stream from the file
    const fileStream = fs.createReadStream(filePath);

    const blobContentType = mime.getType(fileName);
    await blockBlobClient.uploadStream(
      fileStream,
      undefined, // Use default concurrency (5)
      undefined, // Use default buffer size (8MB)
      {
        blobHTTPHeaders: {
          blobContentType,
        },
        onProgress: (progress) => {
          logger.debug(
            `[streamFileToAzure] Upload progress: ${progress.loadedBytes} bytes of ${stats.size}`,
          );
        },
      },
    );

    return blockBlobClient.url;
  } catch (error) {
    logger.error('[streamFileToAzure] Error streaming file:', error);
    throw error;
  }
}

/**
 * Uploads a file from the local file system to Azure Blob Storage.
 *
 * This function reads the file from disk and then uploads it to Azure Blob Storage
 * at the path: {basePath}/{userId}/{fileName}.
 *
 * @param {Object} params
 * @param {object} params.req - The Express request object.
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file id.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<{ filepath: string, bytes: number }>} An object containing the blob URL and its byte size.
 */
async function uploadFileToAzure({
  req,
  file,
  file_id,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const inputFilePath = file.path;
    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const userId = req.user.id;
    const fileName = `${file_id}__${path.basename(inputFilePath)}`;

    const fileURL = await streamFileToAzure({
      userId,
      filePath: inputFilePath,
      fileName,
      basePath,
      containerName,
    });

    return { filepath: fileURL, bytes };
  } catch (error) {
    logger.error('[uploadFileToAzure] Error uploading file:', error);
    throw error;
  }
}

/**
 * Retrieves a readable stream for a blob from Azure Blob Storage.
 *
 * @param {object} _req - The Express request object.
 * @param {string} fileURL - The URL of the blob.
 * @returns {Promise<ReadableStream>} A readable stream of the blob.
 */
async function getAzureFileStream(_req, fileURL, { signal } = {}) {
  try {
    const url = new URL(fileURL);
    const configuredClient = await getAzureContainerClient();
    const configuredURL = configuredClient.url ? new URL(configuredClient.url) : undefined;
    const configuredPrefix = configuredURL?.pathname.replace(/\/$/, '');
    let containerClient = configuredClient;
    let blobPath;

    if (
      configuredURL &&
      configuredPrefix &&
      url.origin === configuredURL.origin &&
      url.pathname.startsWith(`${configuredPrefix}/`)
    ) {
      /* Azurite puts the account name before the container in the path. The configured
       * container URL already includes both, so resolve the blob relative to it. */
      blobPath = url.pathname.slice(configuredPrefix.length + 1);
    } else {
      const pathSegments = url.pathname.split('/').filter(Boolean);
      const containerName = pathSegments.shift();
      blobPath = pathSegments.join('/');
      if (containerName) {
        containerClient = await getAzureContainerClient(decodeURIComponent(containerName));
      }
    }
    blobPath = blobPath?.split('/').map(decodeURIComponent).join('/');
    if (!blobPath) {
      throw new Error('Invalid Azure Blob URL');
    }
    const response = await containerClient.getBlockBlobClient(blobPath).download(0, undefined, {
      abortSignal: signal,
    });
    if (!response.readableStreamBody) {
      throw new Error('Azure Blob download returned no readable stream');
    }
    return response.readableStreamBody;
  } catch (error) {
    logger.error('[getAzureFileStream] Error getting blob stream:', getSafeErrorMetadata(error));
    throw error;
  }
}

module.exports = {
  saveBufferToAzure,
  saveURLToAzure,
  getAzureURL,
  deleteFileFromAzure,
  uploadFileToAzure,
  getAzureFileStream,
};
