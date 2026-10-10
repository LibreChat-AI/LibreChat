import { FileSources } from 'librechat-data-provider';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import type { StoredFileSource } from '~/storage/proxy';
import type { Relinker } from '~/storage/proxy/relink';
import { getKeyFromStoredFileURL, getStoredFileURL } from '~/storage/proxy/link';
import { parseS3Key, getS3URL, extractKeyFromS3Url } from './crud';
import { AVATAR_BASE_PATH } from '~/storage/constants';
import { initializeS3 } from '~/cdn/s3';
import { s3Config } from './s3Config';

/** Serves S3 objects through LibreChat's stored-file route. */
export const s3FileSource: StoredFileSource = {
  parseKey(key) {
    const parsed = parseS3Key(key);
    return parsed && { ...parsed, avatar: parsed.basePath === AVATAR_BASE_PATH };
  },
  async read(key, { head, signal }) {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[s3FileSource] S3 not initialized');
    }
    const params = { Bucket: s3Config.AWS_BUCKET_NAME, Key: key };
    if (head) {
      const data = await s3.send(new HeadObjectCommand(params), { abortSignal: signal });
      return { contentLength: data.ContentLength };
    }
    const data = await s3.send(new GetObjectCommand(params), { abortSignal: signal });
    return { body: data.Body as Readable | undefined, contentLength: data.ContentLength };
  },
  isNotFound(error) {
    const { name, $metadata } = (error ?? {}) as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
  },
};

/**
 * Converts S3 links for `migrate:stored-file-links`. S3 links are always presigned,
 * so a presigned URL identifies one even on a record without a source (an avatar).
 * `toStorage` signs a new URL, so it needs `STORAGE_PROXY_FILES` off.
 */
export const s3Relinker: Relinker = {
  source: FileSources.s3,
  toStored(link, storageKey) {
    if (!link.includes('X-Amz-Signature')) {
      return null;
    }
    const key = storageKey || extractKeyFromS3Url(link);
    return key && parseS3Key(key) ? getStoredFileURL(FileSources.s3, key) : null;
  },
  async toStorage(link) {
    const key = getKeyFromStoredFileURL(link, FileSources.s3);
    const parsed = key ? parseS3Key(key) : null;
    return parsed ? getS3URL(parsed) : null;
  },
};
