import { CacheKeys, FileSources, Time } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';

/** Default maximum number of files returned for an explicitly limited list request. */
export const DEFAULT_FILE_LIST_LIMIT = 100;

export type FileListCache = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: boolean, ttl: number) => Promise<unknown>;
};

export type FileListLogger = {
  warn: (message: string, error?: unknown) => void;
};

export type FileListDependencies = {
  getFiles: (
    filter: { user: string },
    projection: null,
    options: null,
    limit?: number,
  ) => Promise<TFile[] | null | undefined>;
  batchUpdateFiles: (...args: unknown[]) => Promise<unknown>;
  refreshS3FileUrls: (
    files: TFile[] | null | undefined,
    batchUpdateFiles: FileListDependencies['batchUpdateFiles'],
  ) => Promise<TFile[]>;
  getLogStores: (key: string) => FileListCache;
  logger: FileListLogger;
};

export type FileListRequest = {
  userId: string;
  rawLimit?: unknown;
  fileStrategy?: string;
  maxLimit?: number;
  dependencies: FileListDependencies;
};

const resolveMaxLimit = (maxLimit: number | undefined): number => {
  if (Number.isFinite(maxLimit) && maxLimit != null && maxLimit > 0) {
    return Math.floor(maxLimit);
  }
  return DEFAULT_FILE_LIST_LIMIT;
};

const parseLimit = (rawLimit: unknown, maxLimit: number): number | undefined => {
  const numericLimit = Number(rawLimit);
  return Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.min(Math.floor(numericLimit), maxLimit)
    : undefined;
};

/**
 * Loads one user's files and applies the list endpoint's query and S3 refresh policy.
 * An omitted or invalid query limit remains an unlimited request, while an explicit
 * positive limit is bounded by the deployment's configured `maxLimit`.
 */
export async function handleFileListRequest({
  userId,
  rawLimit,
  fileStrategy,
  maxLimit,
  dependencies,
}: FileListRequest): Promise<TFile[] | null | undefined> {
  const limit = parseLimit(rawLimit, resolveMaxLimit(maxLimit));
  const files = await dependencies.getFiles({ user: userId }, null, null, limit);

  let responseFiles = files;
  if (fileStrategy === FileSources.s3) {
    try {
      const cache = dependencies.getLogStores(CacheKeys.S3_EXPIRY_INTERVAL);
      const alreadyChecked = await cache.get(userId);
      if (!alreadyChecked) {
        responseFiles = await dependencies.refreshS3FileUrls(files, dependencies.batchUpdateFiles);
        /** A limited palette refresh must not mark the user's full list as checked. */
        if (limit == null) {
          await cache.set(userId, true, Time.THIRTY_MINUTES);
        }
      }
    } catch (error) {
      dependencies.logger.warn('[/files] Error refreshing S3 file URLs:', error);
    }
  }

  return responseFiles;
}
