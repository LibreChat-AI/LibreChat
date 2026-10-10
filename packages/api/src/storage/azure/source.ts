import { FileSources } from 'librechat-data-provider';
import type { Readable } from 'stream';
import type { StoredFileSource } from '~/storage/proxy';
import {
  getStoredFileURL,
  getKeyFromStoredFileURL,
  isStoredFileProxyEnabled,
} from '~/storage/proxy/link';
import { getAzureContainerClient } from '~/cdn/azure';

/** Azure keeps user and agent avatars beside other images, named by these patterns. */
const AVATAR_FILE_PATTERN = /^(?:agent-.+-)?avatar-\d+\.[^/]+$/;

const defaultContainer = () => process.env.AZURE_CONTAINER_NAME || 'files';

/**
 * The link to store for a blob: LibreChat's own when `STORAGE_PROXY_FILES` is on,
 * otherwise the blob's URL. Stored links name no container, so a blob in any
 * container but the configured one keeps its URL.
 */
export function getAzureFileLink(
  blobURL: string,
  blobPath: string,
  containerName?: string | null,
): string {
  if (!isStoredFileProxyEnabled() || (containerName && containerName !== defaultContainer())) {
    return blobURL;
  }
  return getStoredFileURL(FileSources.azure_blob, blobPath);
}

/** The blob path behind one of LibreChat's links to Azure, or `null` for a blob URL. */
export function getAzureBlobPath(link: string): string | null {
  return getKeyFromStoredFileURL(link, FileSources.azure_blob);
}

/** Serves blobs of the configured container through LibreChat's stored-file route. */
export const azureFileSource: StoredFileSource = {
  parseKey(key) {
    const [, userId, ...rest] = key.split('/');
    const fileName = rest.join('/');
    if (!userId || !fileName) {
      return null;
    }
    return { userId, fileName, avatar: AVATAR_FILE_PATTERN.test(fileName) };
  },
  async read(key, { head, signal }) {
    const containerClient = await getAzureContainerClient();
    if (!containerClient) {
      throw new Error('[azureFileSource] Azure Blob Storage not initialized');
    }
    const blob = containerClient.getBlockBlobClient(key);
    if (head) {
      const properties = await blob.getProperties({ abortSignal: signal });
      return { contentLength: properties.contentLength };
    }
    const response = await blob.download(0, undefined, { abortSignal: signal });
    return {
      body: response.readableStreamBody as Readable | undefined,
      contentLength: response.contentLength,
    };
  },
  isNotFound(error) {
    const { statusCode, code } = (error ?? {}) as { statusCode?: number; code?: string };
    return statusCode === 404 || code === 'BlobNotFound';
  },
};
