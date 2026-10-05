import crypto from 'crypto';
import { Readable, pipeline } from 'stream';
import { logger } from '@librechat/data-schemas';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import type { TFile } from 'librechat-data-provider';
import type {
  SaveBufferParams,
  GetURLParams,
  SaveURLParams,
  UploadFileParams,
  DownloadURLParams,
  SaveURLResult,
  UploadResult,
} from '~/storage/types';
import type { SaveStreamParams, StorageFileLocation } from '~/storage/types';
import type { ServerRequest } from '~/types';
import {
  parseS3Key,
  getS3Key,
  extractKeyFromS3Url,
  saveBufferToS3,
  saveURLToS3WithMetadata,
  uploadFileToS3,
  deleteFileFromS3,
  getS3FileStream,
  resolveStoredS3Key,
} from '~/storage/s3/crud';
import {
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
  createRemoteFileByteLimitTransform,
} from '~/storage/url';
import { AVATAR_BASE_PATH, DEFAULT_BASE_PATH as defaultBasePath } from '~/storage/constants';
import { sanitizeContentDispositionFilename } from '~/storage/validation';
import { planS3File, saveStreamToS3 } from '~/storage/s3/crud';
import { getCloudFrontConfig } from '~/cdn/cloudfront';
import { s3Config } from '~/storage/s3/s3Config';

let _cloudFrontClient: CloudFrontClient | null = null;

function getOrCreateCloudFrontClient(): CloudFrontClient {
  if (!_cloudFrontClient) {
    const region = s3Config.AWS_REGION || process.env.AWS_REGION;
    if (!region) {
      throw new Error('[CloudFront] AWS_REGION is required for cache invalidation');
    }
    _cloudFrontClient = new CloudFrontClient({ region });
  }
  return _cloudFrontClient;
}

export interface CloudFrontURLParams extends GetURLParams {
  sign?: boolean;
}

function getRegionPathOptions({
  basePath = defaultBasePath,
  storageRegion = null,
  includeRegionInPath,
  useInlinePath,
}: {
  basePath?: string;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}): Pick<GetURLParams, 'storageRegion' | 'includeRegionInPath' | 'useInlinePath'> {
  const config = getCloudFrontConfig();
  const shouldIncludeRegion = includeRegionInPath ?? config?.includeRegionInPath ?? false;
  return {
    includeRegionInPath: shouldIncludeRegion,
    storageRegion: shouldIncludeRegion
      ? (storageRegion ?? config?.storageRegion ?? s3Config.AWS_REGION ?? process.env.AWS_REGION)
      : (storageRegion ?? config?.storageRegion),
    useInlinePath: useInlinePath ?? (basePath === defaultBasePath || basePath === AVATAR_BASE_PATH),
  };
}

function isInlineFileUpload({ basePath, file, useInlinePath }: UploadFileParams): boolean {
  if (useInlinePath != null) {
    return useInlinePath;
  }
  if (basePath === AVATAR_BASE_PATH) {
    return true;
  }
  return (basePath ?? defaultBasePath) === defaultBasePath && file.mimetype?.startsWith('image/');
}

/**
 * Percent-encodes each path segment of an S3 key (the separators stay literal). Without this a
 * CloudFront URL carries the raw key while an SDK-generated S3 URL carries an encoded one, so the
 * two forms of `file.filepath` disagree about what a `%` means: a key containing the literal text
 * `%20` would be indistinguishable from a key containing a space. Encoding here keeps both
 * producers consistent, which is what lets `extractKeyFromS3Url` decode unconditionally. The
 * invalidation path must use the same encoding, or it no longer matches the cached viewer URL.
 */
function encodeKeyPath(s3Key: string): string {
  return s3Key.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

function buildCloudFrontUrl(s3Key: string): string {
  const config = getCloudFrontConfig();
  if (!config?.domain) {
    throw new Error('[buildCloudFrontUrl] CloudFront not initialized.');
  }
  const cleanDomain = config.domain.replace(/\/+$/, '');
  return `${cleanDomain}/${encodeKeyPath(s3Key)}`;
}

function signUrl(url: string | URL): string {
  const config = getCloudFrontConfig();
  if (!config?.privateKey || !config?.keyPairId) {
    throw new Error('[signUrl] Signing keys not configured.');
  }

  const expiry = config.urlExpiry ?? s3Config.S3_URL_EXPIRY_SECONDS;
  const expiresAtMs = Date.now() + expiry * 1000;
  const expiresAtEpoch = Math.floor(expiresAtMs / 1000);

  const urlString = url.toString();
  const parsedUrl = url instanceof URL ? url : new URL(urlString);
  if (parsedUrl.search) {
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `${parsedUrl.origin}${parsedUrl.pathname}?*`,
          Condition: {
            DateLessThan: {
              'AWS:EpochTime': expiresAtEpoch,
            },
          },
        },
      ],
    });

    return getSignedUrl({
      url: urlString,
      keyPairId: config.keyPairId,
      privateKey: config.privateKey,
      policy,
    });
  }

  return getSignedUrl({
    url: urlString,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan: new Date(expiresAtMs).toISOString(),
  });
}

function appendDownloadOverrides(
  url: string,
  customFilename: string | null,
  contentType: string | null,
): URL {
  const downloadUrl = new URL(url);

  if (customFilename) {
    const safeFilename = sanitizeContentDispositionFilename(customFilename);
    downloadUrl.searchParams.set(
      'response-content-disposition',
      `attachment; filename="${safeFilename}"`,
    );
  }
  if (contentType) {
    downloadUrl.searchParams.set('response-content-type', contentType);
  }

  return downloadUrl;
}

/**
 * Get CloudFront URL for a file.
 * @param sign - If true, returns a signed URL. Caller (strategy) decides based on config.
 */
export async function getCloudFrontURL({
  userId,
  fileName,
  basePath = defaultBasePath,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath,
  useInlinePath,
  sign = false,
}: CloudFrontURLParams): Promise<string> {
  const key = getS3Key({
    basePath,
    userId,
    fileName,
    tenantId,
    ...getRegionPathOptions({ basePath, storageRegion, includeRegionInPath, useInlinePath }),
  });
  const url = buildCloudFrontUrl(key);
  return sign ? signUrl(url) : url;
}

/** Save buffer to S3 and return CloudFront URL. */
export async function saveBufferToCloudFront(
  params: SaveBufferParams & { sign?: boolean },
): Promise<string> {
  const { sign = false, ...rest } = params;
  const regionOptions = getRegionPathOptions(rest);
  return saveBufferToS3({
    ...rest,
    ...regionOptions,
    urlBuilder: (p) => getCloudFrontURL({ ...p, ...regionOptions, sign }),
  });
}

/** Save file from URL to S3 and return CloudFront URL. */
export async function saveURLToCloudFront(
  params: SaveURLParams & { sign?: boolean },
): Promise<string> {
  const { filepath } = await saveURLToCloudFrontWithMetadata(params);
  return filepath;
}

/** Save file from URL to S3 and return CloudFront URL with fetched metadata. */
export async function saveURLToCloudFrontWithMetadata(
  params: SaveURLParams & { sign?: boolean },
): Promise<SaveURLResult> {
  const { sign = false, ...rest } = params;
  const regionOptions = getRegionPathOptions(rest);
  return saveURLToS3WithMetadata({
    ...rest,
    ...regionOptions,
    urlBuilder: (p) => getCloudFrontURL({ ...p, ...regionOptions, sign }),
  });
}

export async function planCloudFrontFile(
  params: GetURLParams & { sign?: boolean },
): Promise<StorageFileLocation> {
  const { sign = false, ...rest } = params;
  const regionOptions = getRegionPathOptions(rest);
  return planS3File({
    ...rest,
    ...regionOptions,
    urlBuilder: (p) => getCloudFrontURL({ ...p, ...regionOptions, sign }),
  });
}

export async function saveStreamToCloudFront(
  params: SaveStreamParams & { sign?: boolean },
): Promise<UploadResult> {
  const { sign = false, ...rest } = params;
  const regionOptions = getRegionPathOptions(rest);
  return saveStreamToS3({
    ...rest,
    ...regionOptions,
    urlBuilder: (p) => getCloudFrontURL({ ...p, ...regionOptions, sign }),
  });
}

/** Upload file to S3 and return CloudFront URL. */
export async function uploadFileToCloudFront(
  params: UploadFileParams & { sign?: boolean },
): Promise<UploadResult> {
  const { sign = false, ...rest } = params;
  const regionOptions = getRegionPathOptions({
    ...rest,
    useInlinePath: isInlineFileUpload(rest),
  });
  return uploadFileToS3({
    ...rest,
    ...regionOptions,
    urlBuilder: (p) => getCloudFrontURL({ ...p, ...regionOptions, sign }),
  });
}

/** Delete file from S3 and optionally invalidate CloudFront cache. */
export async function deleteFileFromCloudFront(req: ServerRequest, file: TFile): Promise<void> {
  const config = getCloudFrontConfig();

  await deleteFileFromS3(req, file);

  if (config?.invalidateOnDelete && config.distributionId) {
    try {
      const client = getOrCreateCloudFrontClient();
      // CloudFront URL pathname matches S3 key when no origin path prefix is configured
      const path = `/${encodeKeyPath(resolveStoredS3Key(file))}`;

      await client.send(
        new CreateInvalidationCommand({
          DistributionId: config.distributionId,
          InvalidationBatch: {
            CallerReference: crypto.randomUUID(),
            Paths: { Quantity: 1, Items: [path] },
          },
        }),
      );
      logger.debug(`[deleteFileFromCloudFront] Invalidation created for: ${path}`);
    } catch (error) {
      logger.error(
        '[deleteFileFromCloudFront] Cache invalidation failed:',
        (error as Error).message,
      );
    }
  }
}

/** Get a file stream from its owning regional origin. */
export async function getCloudFrontFileStream(
  req: ServerRequest,
  filePath: string,
  options?: Parameters<typeof getS3FileStream>[2],
): Promise<Readable> {
  const key = extractKeyFromS3Url(filePath);
  const storageRegion = parseS3Key(key)?.storageRegion;
  const localStorageRegion = getCloudFrontConfig()?.storageRegion ?? s3Config.AWS_REGION;

  if (!storageRegion || storageRegion === localStorageRegion) {
    return getS3FileStream(req, key, options);
  }

  const maxBytes = getRemoteFileFetchMaxBytes();
  const unsignedUrl = buildCloudFrontUrl(key);
  const config = getCloudFrontConfig();
  const url = config?.privateKey && config.keyPairId ? signUrl(unsignedUrl) : unsignedUrl;
  const controller = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), getRemoteFileFetchTimeoutMs());
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const error = new Error(
      `[getCloudFrontFileStream] CloudFront returned ${response.status} ${response.statusText}`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  if (!response.body) {
    throw new Error('[getCloudFrontFileStream] CloudFront response body is empty');
  }

  try {
    assertRemoteFileContentLength(response.headers, maxBytes);
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  const stream = createRemoteFileByteLimitTransform(maxBytes);
  pipeline(
    Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0], {
      signal,
    }),
    stream,
    () => {
      /** Pipeline forwards failures to the returned stream and closes both ends. */
    },
  );
  return stream;
}

/** Get a signed CloudFront URL for an authorized file download. */
export async function getCloudFrontDownloadURL({
  file,
  customFilename = null,
  contentType = null,
}: DownloadURLParams): Promise<string> {
  const key = resolveStoredS3Key(file);
  if (!key) {
    throw new Error('[getCloudFrontDownloadURL] Unable to extract S3 key from file path');
  }
  const url = appendDownloadOverrides(buildCloudFrontUrl(key), customFilename, contentType);
  return signUrl(url);
}
