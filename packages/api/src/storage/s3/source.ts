import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import type { StoredFileSource } from '~/storage/proxy';
import { AVATAR_BASE_PATH } from '~/storage/constants';
import { initializeS3 } from '~/cdn/s3';
import { s3Config } from './s3Config';
import { parseS3Key } from './crud';

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
