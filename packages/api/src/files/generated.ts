import sharp from 'sharp';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileContext, FileStorage } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { SaveBufferParams } from '~/storage/types';
import type { ImageResolution } from './resize';
import { getStorageMetadata } from '~/storage/metadata';
import { resolveImageMimeType } from './mime';
import { resizeImageBuffer } from './resize';
import { getFileStrategy } from './strategy';

export type GeneratedImageFile = {
  file_id: string;
  filename: string;
  filepath: string;
  type: string;
  bytes: number;
  width?: number;
  height?: number;
  source?: string;
  storageKey?: string;
  storageRegion?: string;
};
type GeneratedImageRecord = GeneratedImageFile & {
  user: string;
  tenantId?: string;
  context?: FileContext;
  expiredAt?: Date | null;
};
export type GeneratedImageRequest = {
  config: AppConfig;
  user: { id: string; tenantId?: string };
};
export interface SaveGeneratedImageOptions {
  req: GeneratedImageRequest;
  file_id?: string;
  filename: string;
  endpoint: string;
  context?: FileContext;
  resolution?: ImageResolution;
  /** Native provider signatures refer to the original raster bytes. */
  preserveOriginal?: boolean;
}
export interface GeneratedImageDependencies {
  getExtension(type: string): string | null;
  getRetentionExpiry(req: GeneratedImageRequest): Promise<{ expiredAt?: Date | null }>;
  getStrategy(source: FileStorage): {
    saveBuffer(params: SaveBufferParams): Promise<string | null>;
  };
  createFile(file: GeneratedImageRecord, disableTTL: true): Promise<GeneratedImageFile | null>;
}

/** Shared by ordinary generated-image tools and native chat; both create normal File records. */
export async function saveGeneratedImage(
  url: string,
  options: SaveGeneratedImageOptions,
  deps: GeneratedImageDependencies,
): Promise<GeneratedImageFile> {
  const { req, endpoint, context } = options;
  /** Tool artifacts may send raw base64 or a generic data URL; sharp identifies the real format. */
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  const declaredType = match?.[1] ?? '';
  const data = match ? match[2] : url;
  if (!data || (options.preserveOriginal && !declaredType.startsWith('image/'))) {
    throw new Error('Invalid base64 image');
  }
  const inputBuffer = Buffer.from(data, 'base64');
  const retention = deps.getRetentionExpiry(req);
  const image = options.preserveOriginal
    ? await inspectOriginal(inputBuffer, declaredType)
    : await resizeImageBuffer(
        inputBuffer,
        options.resolution ?? req.config.fileConfig?.imageGeneration ?? 'high',
        endpoint,
      );
  const type = image.type ?? declaredType;
  const file_id = options.file_id ?? randomUUID();
  let filename = `${file_id}-${options.filename}`;
  if (!path.extname(options.filename)) {
    const extension = deps.getExtension(type);
    if (!extension) throw new Error(`Could not determine file extension from MIME type: ${type}`);
    filename += `.${extension}`;
  }
  const source = getFileStrategy(req.config, { isImage: true });
  const filepath = await deps.getStrategy(source).saveBuffer({
    userId: req.user.id,
    fileName: filename,
    buffer: image.buffer,
    tenantId: req.user.tenantId,
  });
  if (!filepath) throw new Error('Generated image storage did not return a location');
  const file = await deps.createFile(
    {
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      type,
      source,
      context,
      file_id,
      filepath,
      ...getStorageMetadata({ filepath, source }),
      filename,
      user: req.user.id,
      tenantId: req.user.tenantId,
      ...(await retention),
    },
    true,
  );
  if (!file) throw new Error('Generated image File could not be saved');
  return file;
}

async function inspectOriginal(
  buffer: Buffer,
  declaredType: string,
): Promise<{
  buffer: Buffer;
  type: string;
  bytes: number;
  width: number;
  height: number;
}> {
  const metadata = await sharp(buffer).metadata();
  const type = resolveImageMimeType(metadata);
  if (
    !type ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(type) ||
    type !== declaredType ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error('Native image bytes must match their raster MIME type');
  }
  return { buffer, type, bytes: buffer.length, width: metadata.width, height: metadata.height };
}
