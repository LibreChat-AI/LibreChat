import sharp from 'sharp';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { toMediaAsset } from '@librechat/data-schemas';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm, rename, readFile } from 'node:fs/promises';
import type {
  MediaAssetContent,
  MediaMethods,
  MediaOwnerScope,
  MediaRenditionContent,
  MediaRenditionLocation,
} from '@librechat/data-schemas';
import type { MediaAsset, MediaConfig, MediaRenditionKind } from 'librechat-data-provider';
import type { Readable, TransformCallback } from 'node:stream';
import type { Hash } from 'node:crypto';
import type { MediaObjectLocation, MediaObjectReadOptions, MediaObjectStore } from './objects';
import type { MediaDerivativeProcessor } from './derivatives';
import type { MediaContext } from './context';
import {
  mediaContentByteLimit,
  mediaContentExtension,
  normalizeMediaContentType,
  validateMediaAudio,
  validateMediaSvg,
} from './content';
import { createLocalMediaObjectStore, removeMediaObjectLocations } from './objects';
import { mediaTemporaryDirectory } from './temporary';
import { resolveImageMimeType } from '~/files/mime';
import { sanitizeFilename } from '~/utils/files';
import { removeMediaAsset } from './deletion';
import { MediaServiceError } from './errors';

export function resolveMediaStorageSource({
  config,
  appConfig,
}: Pick<MediaContext, 'config' | 'appConfig'>): string {
  return (
    config.assets.source ??
    appConfig.fileStrategies?.image ??
    appConfig.fileStrategies?.default ??
    appConfig.fileStrategy
  );
}
export function assertMediaStorage(context: MediaContext): void {
  const source = resolveMediaStorageSource(context);
  if (
    !['local', 's3', 'cloudfront', 'azure_blob', 'firebase'].includes(source) ||
    (context.storageSources && !context.storageSources.some((available) => available === source))
  )
    throw new MediaServiceError('unsupported', 422, 'This media storage adapter is not available.');
  if (context.storageReady === false)
    throw new MediaServiceError('not_ready', 503, 'Media storage is not configured.');
}
export interface MediaStorage {
  publish(input: {
    scope: MediaOwnerScope;
    outputKey: string;
    stream: Readable;
    type: string;
    filename: string;
    config: MediaConfig;
    expiredAt?: string | null;
    hardExpiresAt?: string | null;
  }): Promise<MediaAsset>;
  read(
    scope: MediaOwnerScope,
    fileId: string,
    maxBytes: number,
  ): Promise<{ asset: MediaAsset; data: Buffer; digest: string }>;
  /** Content must have been loaded through the repository under this scope. */
  open(
    scope: MediaOwnerScope,
    content: MediaAssetContent,
    options?: MediaObjectReadOptions & { rendition?: MediaRenditionKind },
  ): Promise<Readable>;
  remove(scope: MediaOwnerScope, fileId: string): Promise<boolean>;
  discardWrite(scope: MediaOwnerScope, writeId: string, staleBefore: string): Promise<boolean>;
  capture(scope: MediaOwnerScope, fileId: string, config: MediaConfig): Promise<MediaAsset>;
}
export class MediaByteCounter extends Transform {
  bytes = 0;
  readonly hash: Hash = createHash('sha256');
  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(
        new MediaServiceError('invalid_request', 413, 'Media exceeds the configured file limit.'),
      );
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}
async function readHeader(location: string): Promise<Buffer> {
  const file = await open(location, 'r');
  const header = Buffer.alloc(12);
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
function matchesRasterHeader(header: Buffer, type: string): boolean {
  if (type === 'image/png')
    return header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  return (
    type === 'image/webp' &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  );
}
async function inspect(
  location: string,
  type: string,
): Promise<{ width?: number; height?: number }> {
  if (type.startsWith('audio/')) {
    validateMediaAudio(await readFile(location), type);
    return {};
  }
  if (type.startsWith('video/')) {
    const header = await readHeader(location);
    const valid =
      header.length >= 12 &&
      (type === 'video/mp4'
        ? header.toString('ascii', 4, 8) === 'ftyp'
        : type === 'video/webm' && header.readUInt32BE(0) === 0x1a45dfa3);
    if (!valid) throw new MediaServiceError('unsupported', 422, 'Unsupported video content.');
    return {};
  }
  if (type === 'image/svg+xml') validateMediaSvg(await readFile(location));
  else if (!matchesRasterHeader(await readHeader(location), type))
    throw new MediaServiceError(
      'invalid_request',
      422,
      'Image content does not match its media type.',
    );
  const metadata = await sharp(await readFile(location)).metadata();
  const mime = metadata.format === 'svg' ? 'image/svg+xml' : resolveImageMimeType(metadata);
  if (!mime) throw new MediaServiceError('unsupported', 422, 'Unsupported image content.');
  if (mime !== type)
    throw new MediaServiceError(
      'invalid_request',
      422,
      'Image content does not match its media type.',
    );
  return { width: metadata.width, height: metadata.height };
}
async function digestStream(stream: Readable, maxBytes: number): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes)
      throw new MediaServiceError('invalid_request', 413, 'Media input is too large.');
    hash.update(buffer);
  }
  return hash.digest('hex');
}
export function createMediaStorage({
  repository,
  imageDirectory,
  uploadDirectory,
  now,
  stores = [],
  derivatives,
  imageOutputType = 'png',
  log,
}: {
  repository: MediaMethods;
  imageDirectory: string;
  uploadDirectory: string;
  now: () => number;
  stores?: readonly MediaObjectStore[];
  derivatives?: MediaDerivativeProcessor;
  imageOutputType?: string;
  log?(message: string, error?: Error): void;
}): MediaStorage {
  const objects = new Map<string, MediaObjectStore>(
    [createLocalMediaObjectStore({ imageDirectory, uploadDirectory }), ...stores].map((store) => [
      store.source,
      store,
    ]),
  );
  const objectStore = (source: string): MediaObjectStore => {
    const store = objects.get(source);
    if (!store)
      throw new MediaServiceError(
        'unsupported',
        422,
        'This media storage adapter is not available.',
      );
    return store;
  };
  const imageExtension = ['png', 'jpeg', 'webp'].includes(imageOutputType)
    ? imageOutputType
    : 'png';
  const stagingRoot = path.resolve(uploadDirectory, 'temp');
  const cleanupLocations = (scope: MediaOwnerScope, locations: MediaObjectLocation[]) =>
    removeMediaObjectLocations(scope, locations, objectStore);
  const storage: MediaStorage = {
    async publish(input) {
      const type = normalizeMediaContentType(input.type);
      const extension = mediaContentExtension(type);
      if (!extension)
        throw new MediaServiceError('unsupported', 422, 'Unsupported media content type.');
      const store = objectStore(input.config.assets.source ?? 'local');
      const ingestToken = randomUUID();
      const originalName = `${ingestToken}.${extension}`;
      const location = await store.plan(input.scope, originalName, type);
      const derivativePlans = derivatives
        ? await Promise.all(
            (
              [
                ['thumbnail', imageExtension, `image/${imageExtension}`],
                ['poster', imageExtension, `image/${imageExtension}`],
                ['playback', 'mp4', 'video/mp4'],
              ] as const
            ).map(
              async ([kind, ext, contentType]): Promise<MediaRenditionLocation> => ({
                ...(await store.plan(input.scope, `${ingestToken}.${kind}.${ext}`, contentType)),
                kind,
                source: store.source,
              }),
            ),
          )
        : [];
      const receipt = await repository.reserveMediaAssetWrite({
        scope: input.scope,
        outputKey: input.outputKey,
        rendition: 'original',
        ingestToken,
        fingerprint: createHash('sha256').update(input.outputKey).digest('hex'),
        ...location,
        source: store.source,
        renditionLocations: derivativePlans,
      });
      const directory = path.join(
        mediaTemporaryDirectory(stagingRoot, input.scope.ownerId),
        ingestToken,
      );
      const stagedPath = path.join(directory, originalName);
      const counter = new MediaByteCounter(mediaContentByteLimit(type, input.config));
      let publicationAttempted = false;
      try {
        await mkdir(directory, { recursive: true });
        await pipeline(
          input.stream,
          counter,
          createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }),
        );
        const dimensions = await inspect(stagedPath, type);
        const generated =
          (await derivatives
            ?.generate({
              path: stagedPath,
              type,
              config: input.config,
              outputDirectory: directory,
            })
            .catch((error: unknown) => {
              log?.(
                '[media] Derivative generation failed.',
                error instanceof Error ? error : new Error('Media derivative generation failed.'),
              );
              return [];
            })) ?? [];
        const original = await store.put(input.scope, location, stagedPath, type);
        const mediaRenditions: Partial<Record<MediaRenditionKind, MediaRenditionContent>> = {};
        for (const derivative of generated) {
          const plan = derivativePlans.find((item) => item.kind === derivative.kind);
          try {
            const generatedPath = path.resolve(derivative.path);
            const relative = path.relative(directory, generatedPath);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
              throw new MediaServiceError(
                'storage_failed',
                409,
                'Media rendition escaped its staging directory.',
              );
            }
            if (!plan)
              throw new MediaServiceError(
                'storage_failed',
                409,
                'An unplanned media rendition cannot be published.',
              );
            const renditionPath = path.join(
              directory,
              `${ingestToken}.${derivative.kind}.${derivative.kind === 'playback' ? 'mp4' : imageExtension}`,
            );
            await rename(generatedPath, renditionPath);
            const uploaded = await store.put(
              input.scope,
              { ...plan, filepath: plan.filepath ?? plan.storageKey },
              renditionPath,
              derivative.type,
            );
            mediaRenditions[derivative.kind] = {
              ...uploaded,
              source: store.source,
              storageKey: plan.storageKey,
              type: derivative.type,
              bytes: derivative.bytes,
              width: derivative.width,
              height: derivative.height,
              durationSeconds: derivative.durationSeconds,
              contentDigest: await digestStream(
                createReadStream(renditionPath),
                mediaContentByteLimit(derivative.type, input.config),
              ),
            };
          } catch (error) {
            if (plan)
              await store
                .remove(input.scope, { ...plan, filepath: plan.filepath ?? plan.storageKey })
                .catch(() => undefined);
            log?.(
              '[media] Rendition publication failed.',
              error instanceof Error ? error : new Error('Media rendition publication failed.'),
            );
          }
        }
        publicationAttempted = true;
        const asset = await repository.commitMediaAssetWrite({
          scope: input.scope,
          writeId: receipt.writeId,
          content: {
            ...original,
            file_id: receipt.fileId,
            filename: sanitizeFilename(input.filename),
            type,
            bytes: counter.bytes,
            contentDigest: counter.hash.digest('hex'),
            ...dimensions,
            expiredAt: input.expiredAt,
            hardExpiresAt: input.hardExpiresAt,
            ...(Object.keys(mediaRenditions).length ? { mediaRenditions } : {}),
          },
        });
        if (asset.file_id !== receipt.fileId)
          await storage.discardWrite(input.scope, receipt.writeId, new Date(now()).toISOString());
        return asset;
      } catch (error) {
        if (!publicationAttempted)
          await cleanupLocations(input.scope, [
            location,
            ...derivativePlans.map((plan) => ({
              ...plan,
              filepath: plan.filepath ?? plan.storageKey,
            })),
          ]).catch(() => undefined);
        await storage
          .discardWrite(input.scope, receipt.writeId, new Date(now()).toISOString())
          .catch(() => undefined);
        throw error;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async open(scope, content, options) {
      const rendition = options?.rendition
        ? content.mediaRenditions?.[options.rendition]
        : undefined;
      if (options?.rendition && !rendition)
        throw new MediaServiceError('not_found', 404, 'Media rendition is unavailable.');
      const location = rendition ?? content;
      return objectStore(location.source).open(scope, location, options);
    },
    async read(scope, fileId, maxBytes) {
      const content = await repository.getMediaAssetContent(scope, fileId);
      if (!content) throw new MediaServiceError('not_found', 404, 'Media input is unavailable.');
      if (content.bytes > maxBytes)
        throw new MediaServiceError('invalid_request', 413, 'Media input is too large.');
      const chunks: Buffer[] = [];
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of await storage.open(scope, content)) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes)
          throw new MediaServiceError('invalid_request', 413, 'Media input is too large.');
        hash.update(buffer);
        chunks.push(buffer);
      }
      const digest = hash.digest('hex');
      if (digest !== content.contentDigest)
        throw new MediaServiceError('storage_failed', 409, 'The media original changed.');
      return { asset: toMediaAsset(content), data: Buffer.concat(chunks), digest };
    },
    async discardWrite(scope, writeId, staleBefore) {
      const token = randomUUID();
      const write = await repository.claimMediaAssetWriteDeletion({
        scope,
        writeId,
        token,
        staleBefore,
      });
      if (!write) return false;
      await cleanupLocations(scope, [
        ...(write.renditionLocations ?? []).map((location) => ({
          ...location,
          filepath: location.filepath ?? location.storageKey,
        })),
        {
          source: write.source ?? 'local',
          storageKey: write.storageKey,
          storageRegion: write.storageRegion,
          filepath: write.filepath ?? `/${write.storageKey}`,
        },
      ]);
      return repository.completeMediaAssetWriteDeletion({ scope, writeId, token });
    },
    async remove(scope, fileId) {
      return removeMediaAsset({ repository, scope, fileId, removeLocations: cleanupLocations });
    },
    async capture(scope, fileId, config) {
      const existing = await repository.getMediaAsset(scope, fileId);
      if (existing) return existing;
      const source = await repository.getMediaSourceFile(scope, fileId);
      if (!source) throw new MediaServiceError('not_found', 404, 'The source file is unavailable.');
      const store = objectStore(source.source);
      const before = await store.revision?.(scope, source);
      const counter = new MediaByteCounter(mediaContentByteLimit(source.type, config));
      const sourceStream = await store.open(scope, source);
      const sourcePipeline = pipeline(sourceStream, counter);
      sourcePipeline.catch(() => undefined);
      let captured: MediaAsset;
      try {
        captured = await storage.publish({
          scope,
          outputKey: `capture:${fileId}:${source.sourceRevision}`,
          stream: counter,
          type: source.type,
          filename: source.filename,
          config,
          expiredAt:
            source.expiredAt ?? new Date(now() + config.assets.orphanRetentionMs).toISOString(),
          hardExpiresAt: source.hardExpiresAt ?? source.expiredAt,
        });
      } catch (error) {
        sourceStream.destroy();
        counter.destroy();
        await sourcePipeline.catch(() => undefined);
        throw error;
      }
      await sourcePipeline;
      const digest = counter.hash.digest('hex');
      const [after, current] = await Promise.all([
        store.revision
          ? store.revision(scope, source)
          : digestStream(
              await store.open(scope, source),
              mediaContentByteLimit(source.type, config),
            ),
        repository.getMediaSourceFile(scope, fileId),
      ]);
      if (
        !current ||
        current.sourceRevision !== source.sourceRevision ||
        (before !== undefined ? before !== after : digest !== after)
      )
        throw new MediaServiceError(
          'version_conflict',
          409,
          'The source changed while it was imported.',
        );
      return captured;
    },
  };
  return storage;
}
