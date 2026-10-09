import fs from 'fs';
import { Readable } from 'stream';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  UploadPartCommand,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type {
  CompletedPart,
  GetObjectCommandInput,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import type { TFile } from 'librechat-data-provider';
import type {
  UploadFileParams,
  SaveBufferParams,
  DownloadURLParams,
  SaveURLResult,
  BatchUpdateFn,
  SaveURLParams,
  GetURLParams,
  UploadResult,
  UrlBuilder,
  S3FileRef,
} from '~/storage/types';
import type { StoredFileRef } from '~/storage/path';
import type { ServerRequest } from '~/types';
import {
  assertRemoteFileURL,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
  createRemoteFileByteLimitTransform,
} from '~/storage/url';
import {
  AVATAR_BASE_PATH,
  DEFAULT_BASE_PATH as defaultBasePath,
  INLINE_AVATAR_PATH_PREFIX,
  INLINE_IMAGE_PATH_PREFIX,
} from '~/storage/constants';
import {
  assertS3FileName,
  assertPathSegment,
  sanitizeContentDispositionFilename,
} from '~/storage/validation';
import { getSafeErrorMetadata } from '~/utils/errors';
import { initializeS3 } from '~/cdn/s3';
import { deleteRagFile } from '~/files';
import { s3Config } from './s3Config';

const {
  AWS_BUCKET_NAME: bucketName,
  AWS_ENDPOINT_URL: endpoint,
  AWS_FORCE_PATH_STYLE: forcePathStyle,
  S3_URL_EXPIRY_SECONDS: s3UrlExpirySeconds,
  S3_REFRESH_EXPIRY_MS: s3RefreshExpiryMs,
} = s3Config;

const MULTIPART_UPLOAD_PART_SIZE = 5 * 1024 * 1024;
const INLINE_STORAGE_PREFIXES = new Map([
  [defaultBasePath, INLINE_IMAGE_PATH_PREFIX],
  [AVATAR_BASE_PATH, INLINE_AVATAR_PATH_PREFIX],
]);

interface S3KeyBase {
  basePath: string;
  userId: string;
  fileName: string;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}

export interface S3KeyParts extends S3KeyBase {
  storageRegion?: string;
  tenantId?: string;
  inlinePathPrefix?: string;
}

export interface S3KeyOptions extends S3KeyBase {
  tenantId?: string | null;
  storageRegion?: string | null;
}

const parseS3PathSegment = (value: string | undefined): string | null => {
  try {
    return assertPathSegment('S3 key segment', value, 'getS3Key');
  } catch {
    return null;
  }
};

const parseS3FileName = (value: string | undefined): string | null => {
  try {
    return assertS3FileName('fileName', value, 'parseS3Key');
  } catch {
    return null;
  }
};

const getParsedPathFlags = (
  storageRegion?: string,
  inlinePathPrefix?: string,
): Pick<S3KeyParts, 'useInlinePath' | 'inlinePathPrefix'> => {
  if (inlinePathPrefix) {
    return { useInlinePath: true, inlinePathPrefix };
  }
  return { useInlinePath: false };
};

const getDefaultStorageRegion = (): string | null =>
  s3Config.AWS_REGION || process.env.AWS_REGION || null;

const getInlinePathPrefix = ({
  basePath,
  useInlinePath,
}: Pick<S3KeyOptions, 'basePath' | 'useInlinePath'>): string | null => {
  const prefix = INLINE_STORAGE_PREFIXES.get(basePath);
  const shouldUseInlinePath = useInlinePath ?? false;
  if (!shouldUseInlinePath) {
    return null;
  }
  if (!prefix) {
    throw new Error(`[getS3Key] inline path is not supported for basePath: "${basePath}"`);
  }
  return prefix;
};

function normalizeS3KeyOptions(
  basePathOrOptions: string | S3KeyOptions,
  userId?: string,
  fileName?: string,
  tenantId?: string | null,
): S3KeyOptions {
  if (typeof basePathOrOptions === 'object') {
    return basePathOrOptions;
  }
  return {
    basePath: basePathOrOptions,
    userId: userId ?? '',
    fileName: fileName ?? '',
    tenantId,
    useInlinePath: false,
  };
}

export function getS3Key(options: S3KeyOptions): string;
export function getS3Key(
  basePath: string,
  userId: string,
  fileName: string,
  tenantId?: string | null,
): string;
export function getS3Key(
  basePathOrOptions: string | S3KeyOptions,
  userId?: string,
  fileName?: string,
  tenantId?: string | null,
): string {
  const options = normalizeS3KeyOptions(basePathOrOptions, userId, fileName, tenantId);
  const { includeRegionInPath = false } = options;
  const safeBasePath = assertPathSegment('basePath', options.basePath, 'getS3Key');
  const safeUserId = assertPathSegment('userId', options.userId, 'getS3Key');
  const safeFileName = assertS3FileName('fileName', options.fileName, 'getS3Key');
  const inlinePathPrefix = getInlinePathPrefix({
    ...options,
    basePath: safeBasePath,
  });

  const pathParts: string[] = [];
  if (inlinePathPrefix) {
    pathParts.push(inlinePathPrefix);
  }
  if (includeRegionInPath) {
    const storageRegion = options.storageRegion ?? getDefaultStorageRegion();
    pathParts.push('r', assertPathSegment('storageRegion', storageRegion, 'getS3Key'));
  }
  if (options.tenantId) {
    pathParts.push('t', assertPathSegment('tenantId', options.tenantId, 'getS3Key'));
  }
  pathParts.push(safeBasePath, safeUserId, safeFileName);
  return pathParts.join('/');
}

const parseS3KeyParts = (
  keyParts: string[],
  storageRegion?: string,
  inlinePathPrefix?: string,
): S3KeyParts | null => {
  if (keyParts[0] === 't') {
    if (keyParts.length < 5) {
      return null;
    }
    const [, tenantId, basePath, userId, ...fileNameParts] = keyParts;
    const safeTenantId = parseS3PathSegment(tenantId);
    const safeBasePath = parseS3PathSegment(basePath);
    const safeUserId = parseS3PathSegment(userId);
    const safeFileName = parseS3FileName(fileNameParts.join('/'));
    if (!safeTenantId || !safeBasePath || !safeUserId || !safeFileName) {
      return null;
    }
    const expectedInlinePrefix = INLINE_STORAGE_PREFIXES.get(safeBasePath);
    if (inlinePathPrefix && expectedInlinePrefix !== inlinePathPrefix) {
      return null;
    }
    return {
      ...(storageRegion ? { storageRegion } : {}),
      ...(storageRegion ? { includeRegionInPath: true } : {}),
      ...getParsedPathFlags(storageRegion, inlinePathPrefix),
      tenantId: safeTenantId,
      basePath: safeBasePath,
      userId: safeUserId,
      fileName: safeFileName,
    };
  }

  if (keyParts.length < 3) {
    return null;
  }
  const [basePath, userId, ...fileNameParts] = keyParts;
  const safeBasePath = parseS3PathSegment(basePath);
  const safeUserId = parseS3PathSegment(userId);
  const safeFileName = parseS3FileName(fileNameParts.join('/'));
  if (!safeBasePath || !safeUserId || !safeFileName) {
    return null;
  }
  const expectedInlinePrefix = INLINE_STORAGE_PREFIXES.get(safeBasePath);
  if (inlinePathPrefix && expectedInlinePrefix !== inlinePathPrefix) {
    return null;
  }
  return {
    ...(storageRegion ? { storageRegion } : {}),
    ...(storageRegion ? { includeRegionInPath: true } : {}),
    ...getParsedPathFlags(storageRegion, inlinePathPrefix),
    basePath: safeBasePath,
    userId: safeUserId,
    fileName: safeFileName,
  };
};

export const parseS3Key = (key: string): S3KeyParts | null => {
  const normalizedKey = key.replace(/^\/+/, '');
  const keyParts = normalizedKey.split('/');
  const inlinePathPrefix =
    keyParts[0] === INLINE_IMAGE_PATH_PREFIX || keyParts[0] === INLINE_AVATAR_PATH_PREFIX
      ? keyParts.shift()
      : undefined;

  if (keyParts[0] === 'r') {
    if (keyParts.length < 5) {
      return null;
    }
    const [, storageRegion, ...remainingParts] = keyParts;
    const safeStorageRegion = parseS3PathSegment(storageRegion);
    if (!safeStorageRegion) {
      return null;
    }
    return parseS3KeyParts(remainingParts, safeStorageRegion, inlinePathPrefix);
  }

  return parseS3KeyParts(keyParts, undefined, inlinePathPrefix);
};

export function getStorageMetadataForKey(
  key: string,
): Pick<SaveURLResult, 'storageKey' | 'storageRegion'> {
  const normalizedKey = key.replace(/^\/+/, '');
  const parsedKey = parseS3Key(normalizedKey);
  if (!parsedKey) {
    return {};
  }
  return {
    storageKey: normalizedKey,
    ...(parsedKey?.storageRegion ? { storageRegion: parsedKey.storageRegion } : {}),
  };
}

export function resolveStoredS3Key(file: StoredFileRef): string {
  return file.storageKey || extractKeyFromS3Url(file.filepath);
}

async function getS3URLForKey({
  key,
  customFilename = null,
  contentType = null,
}: {
  key: string;
  customFilename?: string | null;
  contentType?: string | null;
}): Promise<string> {
  const params: GetObjectCommandInput = { Bucket: bucketName, Key: key };

  if (customFilename) {
    const safeFilename = sanitizeContentDispositionFilename(customFilename);
    params.ResponseContentDisposition = `attachment; filename="${safeFilename}"`;
  }
  if (contentType) {
    params.ResponseContentType = contentType;
  }

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[getS3URL] S3 not initialized');
    }

    return await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: s3UrlExpirySeconds });
  } catch (error) {
    logger.error('[getS3URL] Error getting signed URL from S3:', (error as Error).message);
    throw error;
  }
}

export async function getS3URL({
  userId,
  fileName,
  basePath = defaultBasePath,
  customFilename = null,
  contentType = null,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath = false,
  useInlinePath,
}: GetURLParams): Promise<string> {
  const key = getS3Key({
    basePath,
    userId,
    fileName,
    tenantId,
    storageRegion,
    includeRegionInPath,
    useInlinePath,
  });
  return getS3URLForKey({ key, customFilename, contentType });
}

export async function saveBufferToS3({
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath = false,
  useInlinePath,
  urlBuilder,
}: SaveBufferParams & { urlBuilder?: UrlBuilder }): Promise<string> {
  const key = getS3Key({
    basePath,
    userId,
    fileName,
    tenantId,
    storageRegion,
    includeRegionInPath,
    useInlinePath,
  });
  const params = { Bucket: bucketName, Key: key, Body: buffer };

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[saveBufferToS3] S3 not initialized');
    }

    await s3.send(new PutObjectCommand(params));
    const getUrl = urlBuilder ?? getS3URL;
    return await getUrl({
      userId,
      fileName,
      basePath,
      tenantId,
      storageRegion,
      includeRegionInPath,
      useInlinePath,
    });
  } catch (error) {
    logger.error('[saveBufferToS3] Error uploading buffer to S3:', (error as Error).message);
    throw error;
  }
}

interface PendingUploadBuffers {
  buffers: Buffer[];
  bytes: number;
}

const toUploadBuffer = (chunk: Buffer | string | Uint8Array): Buffer => {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk);
};

const takePendingBytes = (pending: PendingUploadBuffers, size: number): Buffer => {
  const output = Buffer.allocUnsafe(size);
  let offset = 0;

  while (offset < size) {
    const buffer = pending.buffers[0];
    const bytesNeeded = size - offset;

    if (buffer.length <= bytesNeeded) {
      buffer.copy(output, offset);
      offset += buffer.length;
      pending.bytes -= buffer.length;
      pending.buffers.shift();
      continue;
    }

    buffer.copy(output, offset, 0, bytesNeeded);
    pending.buffers[0] = buffer.subarray(bytesNeeded);
    pending.bytes -= bytesNeeded;
    offset += bytesNeeded;
  }

  return output;
};

async function saveReadableToS3({
  userId,
  body,
  fileName,
  basePath = defaultBasePath,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath = false,
  useInlinePath,
  urlBuilder,
}: Omit<SaveBufferParams, 'buffer'> & {
  body: Readable;
  urlBuilder?: UrlBuilder;
}): Promise<{ filepath: string; bytes: number; storageKey?: string; storageRegion?: string }> {
  const key = getS3Key({
    basePath,
    userId,
    fileName,
    tenantId,
    storageRegion,
    includeRegionInPath,
    useInlinePath,
  });
  const pending: PendingUploadBuffers = { buffers: [], bytes: 0 };
  const completedParts: CompletedPart[] = [];
  let totalBytes = 0;
  let partNumber = 1;
  let uploadId: string | undefined;

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[saveReadableToS3] S3 not initialized');
    }

    const createMultipartUpload = async (): Promise<string> => {
      if (uploadId) {
        return uploadId;
      }
      const response = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucketName, Key: key }),
      );
      if (!response.UploadId) {
        throw new Error('[saveReadableToS3] S3 did not return an upload ID');
      }
      uploadId = response.UploadId;
      return uploadId;
    };

    const uploadPart = async (partBody: Buffer): Promise<void> => {
      const currentUploadId = await createMultipartUpload();
      const response = await s3.send(
        new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: currentUploadId,
          PartNumber: partNumber,
          Body: partBody,
        }),
      );
      completedParts.push({ ETag: response.ETag, PartNumber: partNumber });
      partNumber += 1;
    };

    for await (const chunk of body as AsyncIterable<Buffer | string | Uint8Array>) {
      const buffer = toUploadBuffer(chunk);
      pending.buffers.push(buffer);
      pending.bytes += buffer.length;
      totalBytes += buffer.length;

      while (pending.bytes >= MULTIPART_UPLOAD_PART_SIZE) {
        await uploadPart(takePendingBytes(pending, MULTIPART_UPLOAD_PART_SIZE));
      }
    }

    if (!uploadId) {
      const bodyBuffer =
        pending.bytes > 0 ? takePendingBytes(pending, pending.bytes) : Buffer.alloc(0);
      const params: PutObjectCommandInput = { Bucket: bucketName, Key: key, Body: bodyBuffer };
      await s3.send(new PutObjectCommand(params));
    } else {
      if (pending.bytes > 0) {
        await uploadPart(takePendingBytes(pending, pending.bytes));
      }
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: completedParts },
        }),
      );
    }

    const getUrl = urlBuilder ?? getS3URL;
    return {
      filepath: await getUrl({
        userId,
        fileName,
        basePath,
        tenantId,
        storageRegion,
        includeRegionInPath,
        useInlinePath,
      }),
      bytes: totalBytes,
      ...getStorageMetadataForKey(key),
    };
  } catch (error) {
    if (uploadId) {
      try {
        await initializeS3()?.send(
          new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId }),
        );
      } catch (abortError) {
        logger.warn('[saveReadableToS3] Error aborting multipart upload:', abortError);
      }
    }
    logger.error('[saveReadableToS3] Error uploading stream to S3:', (error as Error).message);
    throw error;
  }
}

export async function saveURLToS3WithMetadata({
  userId,
  URL,
  fileName,
  basePath = defaultBasePath,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath = false,
  useInlinePath,
  urlBuilder,
}: SaveURLParams & { urlBuilder?: UrlBuilder }): Promise<SaveURLResult> {
  try {
    const maxBytes = getRemoteFileFetchMaxBytes();
    const response = await fetch(assertRemoteFileURL(URL), {
      signal: AbortSignal.timeout(getRemoteFileFetchTimeoutMs()),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }
    assertRemoteFileContentLength(response.headers, maxBytes);

    const contentType = response.headers.get('content-type') ?? '';
    if (response.body) {
      const source = Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ).pipe(createRemoteFileByteLimitTransform(maxBytes));
      const result = await saveReadableToS3({
        userId,
        body: source,
        fileName,
        basePath,
        tenantId,
        storageRegion,
        includeRegionInPath,
        useInlinePath,
        urlBuilder,
      });
      return {
        filepath: result.filepath,
        storageKey: result.storageKey,
        storageRegion: result.storageRegion,
        bytes: result.bytes,
        type: contentType,
        dimensions: {},
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Remote file response too large: ${buffer.length} bytes`);
    }

    const filepath = await saveBufferToS3({
      userId,
      buffer,
      fileName,
      basePath,
      tenantId,
      storageRegion,
      includeRegionInPath,
      useInlinePath,
      urlBuilder,
    });
    const key = getS3Key({
      basePath,
      userId,
      fileName,
      tenantId,
      storageRegion,
      includeRegionInPath,
      useInlinePath,
    });
    return {
      filepath,
      ...getStorageMetadataForKey(key),
      bytes: buffer.byteLength,
      type: contentType,
      dimensions: {},
    };
  } catch (error) {
    logger.error('[saveURLToS3] Error uploading file from URL to S3:', (error as Error).message);
    throw error;
  }
}

export async function saveURLToS3(
  params: SaveURLParams & { urlBuilder?: UrlBuilder },
): Promise<string> {
  const { filepath } = await saveURLToS3WithMetadata(params);
  return filepath;
}

/**
 * Decodes a key taken from a URL path.
 *
 * `URL.pathname` is percent-encoded, but S3 object keys are raw UTF-8 and the AWS SDK encodes
 * them again when it signs the request. Returning the encoded pathname therefore asks S3 for a
 * literally different key (`%C3%81rsreikningur.pdf` instead of `Ársreikningur.pdf`) and every
 * read of a file whose name contains a non-ASCII character fails with `NoSuchKey`. Keys made of
 * ASCII are unaffected, which is why this only shows up for non-English filenames.
 *
 * Malformed sequences fall back to the raw value rather than throwing — a key that cannot be
 * decoded is still worth attempting.
 */
function decodeKeyFromUrlPath(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    logger.warn('[extractKeyFromS3Url] Could not decode key, using it as-is');
    return key;
  }
}

export function extractKeyFromS3Url(fileUrlOrKey: string): string {
  if (!fileUrlOrKey) {
    throw new Error('Invalid input: URL or key is empty');
  }

  if (!fileUrlOrKey.startsWith('http://') && !fileUrlOrKey.startsWith('https://')) {
    return fileUrlOrKey.startsWith('/') ? fileUrlOrKey.substring(1) : fileUrlOrKey;
  }

  try {
    const url = new URL(fileUrlOrKey);
    const hostname = url.hostname;
    const pathname = url.pathname.substring(1);

    if (endpoint && forcePathStyle) {
      const endpointUrl = new URL(endpoint);
      const startPos =
        endpointUrl.pathname.length +
        (endpointUrl.pathname.endsWith('/') ? 0 : 1) +
        bucketName.length +
        1;
      const key = decodeKeyFromUrlPath(url.pathname.substring(startPos));
      if (!key) {
        logger.warn('[extractKeyFromS3Url] Extracted key is empty for endpoint path-style URL');
      }
      return key;
    }

    if (
      hostname === 's3.amazonaws.com' ||
      hostname.match(/^s3[-.][a-z0-9-]+\.amazonaws\.com$/) ||
      (bucketName && pathname.startsWith(`${bucketName}/`))
    ) {
      const firstSlashIndex = pathname.indexOf('/');
      if (firstSlashIndex > 0) {
        const key = decodeKeyFromUrlPath(pathname.substring(firstSlashIndex + 1));
        if (key === '') {
          logger.warn('[extractKeyFromS3Url] Extracted key is empty after removing bucket name');
        }
        return key;
      }
      logger.warn('[extractKeyFromS3Url] Unable to extract key from path-style URL');
      return '';
    }

    const key = decodeKeyFromUrlPath(pathname);
    return key;
  } catch {
    logger.error('[extractKeyFromS3Url] Error parsing URL');
    return fileUrlOrKey;
  }
}

export async function deleteFileFromS3(req: ServerRequest, file: TFile): Promise<void> {
  if (!req.user) {
    throw new Error('[deleteFileFromS3] User not authenticated');
  }

  const key = resolveStoredS3Key(file);
  const parsedKey = parseS3Key(key);
  const ownerId = file.user?.toString?.();
  const fileTenantId = file.tenantId?.toString?.() ?? null;

  if (!ownerId) {
    const message = `[deleteFileFromS3] File record has no owner: ${key}`;
    logger.error(message);
    throw new Error(message);
  }

  if (!parsedKey || parsedKey.userId !== ownerId) {
    const message = `[deleteFileFromS3] File owner mismatch: ${ownerId} vs ${key}`;
    logger.error(message);
    throw new Error(message);
  }
  if ((parsedKey.tenantId ?? null) !== fileTenantId) {
    const message = `[deleteFileFromS3] Tenant ID mismatch: ${fileTenantId} vs ${key}`;
    logger.error(message);
    throw new Error(message);
  }

  const s3 = initializeS3();
  if (!s3) {
    throw new Error('[deleteFileFromS3] S3 not initialized');
  }

  const params = { Bucket: bucketName, Key: key };

  try {
    try {
      const headCommand = new HeadObjectCommand(params);
      await s3.send(headCommand);
      logger.debug('[deleteFileFromS3] File exists, proceeding with deletion');
    } catch (headErr) {
      if ((headErr as { name?: string }).name === 'NotFound') {
        logger.warn(`[deleteFileFromS3] File does not exist: ${key}`);
        await deleteRagFile({ userId: ownerId, file });
        return;
      }
      throw headErr;
    }

    await s3.send(new DeleteObjectCommand(params));
    await deleteRagFile({ userId: ownerId, file });
    logger.debug('[deleteFileFromS3] S3 File deletion completed');
  } catch (error) {
    logger.error(`[deleteFileFromS3] Error deleting file from S3: ${(error as Error).message}`);
    logger.error((error as Error).stack);

    if ((error as { name?: string }).name === 'NoSuchKey') {
      await deleteRagFile({ userId: ownerId, file });
      return;
    }
    throw error;
  }
}

export async function uploadFileToS3({
  req,
  file,
  file_id,
  basePath = defaultBasePath,
  tenantId = null,
  storageRegion = null,
  includeRegionInPath = false,
  useInlinePath,
  urlBuilder,
}: UploadFileParams & { urlBuilder?: UrlBuilder }): Promise<UploadResult> {
  if (!req.user) {
    throw new Error('[uploadFileToS3] User not authenticated');
  }

  try {
    const inputFilePath = file.path;
    const userId = req.user.id;
    const resolvedTenantId = tenantId ?? req.user.tenantId ?? null;
    const fileName = `${file_id}__${file.originalname}`;
    const key = getS3Key({
      basePath,
      userId,
      fileName,
      tenantId: resolvedTenantId,
      storageRegion,
      includeRegionInPath,
      useInlinePath,
    });

    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const fileStream = fs.createReadStream(inputFilePath);

    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[uploadFileToS3] S3 not initialized');
    }

    const uploadParams = {
      Bucket: bucketName,
      Key: key,
      Body: fileStream,
    };

    await s3.send(new PutObjectCommand(uploadParams));
    const getUrl = urlBuilder ?? getS3URL;
    const fileURL = await getUrl({
      userId,
      fileName,
      basePath,
      tenantId: resolvedTenantId,
      storageRegion,
      includeRegionInPath,
      useInlinePath,
    });
    // NOTE: temp file is intentionally NOT deleted on the success path.
    // The caller (processAgentFileUpload) reads file.path after this returns
    // to stream the file to the RAG vector embedding service (POST /embed).
    // Temp file lifecycle on success is the caller's responsibility.
    return { filepath: fileURL, bytes, ...getStorageMetadataForKey(key) };
  } catch (error) {
    logger.error('[uploadFileToS3] Error streaming file to S3:', error);
    if (file?.path) {
      await fs.promises
        .unlink(file.path)
        .catch((e: unknown) =>
          logger.error('[uploadFileToS3] Failed to delete temp file:', (e as Error).message),
        );
    }
    throw error;
  }
}

export async function getS3FileStream(
  _req: ServerRequest,
  filePath: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Readable> {
  try {
    const Key = extractKeyFromS3Url(filePath);
    const params = { Bucket: bucketName, Key };

    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[getS3FileStream] S3 not initialized');
    }

    const data = await s3.send(new GetObjectCommand(params), { abortSignal: signal });
    if (!data.Body) {
      throw new Error('[getS3FileStream] S3 response body is empty');
    }
    return data.Body as Readable;
  } catch (error) {
    logger.error('[getS3FileStream] Error retrieving S3 file stream', getSafeErrorMetadata(error));
    throw error;
  }
}

export async function getS3DownloadURL({
  file,
  customFilename = null,
  contentType = null,
}: DownloadURLParams): Promise<string> {
  const key = resolveStoredS3Key(file);
  if (!key) {
    throw new Error('[getS3DownloadURL] Unable to extract S3 key from file path');
  }
  return getS3URLForKey({ key, customFilename, contentType });
}

export function needsRefresh(signedUrl: string, bufferSeconds: number): boolean {
  try {
    const url = new URL(signedUrl);

    if (!url.searchParams.has('X-Amz-Signature')) {
      return false;
    }

    const expiresParam = url.searchParams.get('X-Amz-Expires');
    const dateParam = url.searchParams.get('X-Amz-Date');

    if (!expiresParam || !dateParam) {
      return true;
    }

    const year = dateParam.substring(0, 4);
    const month = dateParam.substring(4, 6);
    const day = dateParam.substring(6, 8);
    const hour = dateParam.substring(9, 11);
    const minute = dateParam.substring(11, 13);
    const second = dateParam.substring(13, 15);

    const dateObj = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    const now = new Date();

    if (s3RefreshExpiryMs !== null) {
      const urlAge = now.getTime() - dateObj.getTime();
      return urlAge >= s3RefreshExpiryMs;
    }

    const expiresAtDate = new Date(dateObj.getTime() + parseInt(expiresParam) * 1000);
    const bufferTime = new Date(now.getTime() + bufferSeconds * 1000);
    return expiresAtDate <= bufferTime;
  } catch (error) {
    logger.error('Error checking URL expiration:', error);
    return true;
  }
}

export async function getNewS3URL(
  currentURL: string,
  storageKey?: string | null,
): Promise<string | undefined> {
  try {
    const s3Key = storageKey || extractKeyFromS3Url(currentURL);
    if (!s3Key) {
      return;
    }

    const parsedKey = parseS3Key(s3Key);
    if (!parsedKey) {
      return;
    }

    return getS3URL(parsedKey);
  } catch (error) {
    logger.error('Error getting new S3 URL:', error);
  }
}

export async function refreshS3FileUrls(
  files: TFile[] | null | undefined,
  batchUpdateFiles: BatchUpdateFn,
  bufferSeconds = 3600,
): Promise<TFile[]> {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  const filesToUpdate: Array<{
    file_id: string;
    filepath: string;
    storageKey?: string;
    storageRegion?: string;
  }> = [];
  const updatedFiles = [...files];

  for (let i = 0; i < updatedFiles.length; i++) {
    const file = updatedFiles[i];
    if (!file?.file_id) {
      continue;
    }
    if (file.source !== FileSources.s3) {
      continue;
    }
    if (!file.filepath) {
      continue;
    }
    if (!needsRefresh(file.filepath, bufferSeconds)) {
      continue;
    }

    try {
      const newURL = await getNewS3URL(file.filepath, file.storageKey);
      if (!newURL) {
        continue;
      }
      const storageMetadata = file.storageKey
        ? getStorageMetadataForKey(file.storageKey)
        : getStorageMetadataForKey(extractKeyFromS3Url(file.filepath));
      filesToUpdate.push({
        file_id: file.file_id,
        filepath: newURL,
        ...storageMetadata,
      });
      updatedFiles[i] = { ...file, filepath: newURL, ...storageMetadata };
    } catch (error) {
      logger.error(`Error refreshing S3 URL for file ${file.file_id}:`, error);
    }
  }

  if (filesToUpdate.length > 0) {
    await batchUpdateFiles(filesToUpdate);
  }

  return updatedFiles;
}

export async function refreshS3Url(fileObj: S3FileRef, bufferSeconds = 3600): Promise<string> {
  if (!fileObj || fileObj.source !== FileSources.s3 || !fileObj.filepath) {
    return fileObj?.filepath || '';
  }

  if (!needsRefresh(fileObj.filepath, bufferSeconds)) {
    return fileObj.filepath;
  }

  try {
    const s3Key = fileObj.storageKey || extractKeyFromS3Url(fileObj.filepath);
    if (!s3Key) {
      logger.warn(`Unable to extract S3 key from URL: ${fileObj.filepath}`);
      return fileObj.filepath;
    }

    const parsedKey = parseS3Key(s3Key);
    if (!parsedKey) {
      logger.warn(`Invalid S3 key format: ${s3Key}`);
      return fileObj.filepath;
    }

    const newUrl = await getS3URL(parsedKey);
    logger.debug(`Refreshed S3 URL for key: ${s3Key}`);
    return newUrl;
  } catch (error) {
    logger.error(`Error refreshing S3 URL: ${(error as Error).message}`);
    return fileObj.filepath;
  }
}
