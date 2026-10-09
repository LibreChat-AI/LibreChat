import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { SaveURLResult } from './types';
import { extractKeyFromS3Url, getStorageMetadataForKey } from './s3/crud';

type StorageMetadataInput = {
  filepath?: string | null;
  source?: string | null;
  storageKey?: string | null;
  storageRegion?: string | null;
};

export function getStorageMetadata({
  filepath,
  source,
  storageKey,
  storageRegion,
}: StorageMetadataInput): Pick<SaveURLResult, 'storageKey' | 'storageRegion'> {
  if (source !== FileSources.s3 && source !== FileSources.cloudfront) {
    return {};
  }

  let key = storageKey ?? '';
  if (!key && filepath) {
    try {
      key = extractKeyFromS3Url(filepath);
    } catch (error) {
      logger.warn('[getStorageMetadata] Unable to extract storage key from filepath', error);
      return {};
    }
  }
  if (!key) {
    return {};
  }

  const metadata = getStorageMetadataForKey(key);
  if (!metadata.storageKey) {
    return {};
  }

  if (storageRegion && metadata.storageRegion && storageRegion !== metadata.storageRegion) {
    logger.warn(
      `[getStorageMetadata] storageRegion "${storageRegion}" does not match key region "${metadata.storageRegion}".`,
    );
  }

  return {
    ...metadata,
    ...(storageRegion ? { storageRegion } : {}),
  };
}
