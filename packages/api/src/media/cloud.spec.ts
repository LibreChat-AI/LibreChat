import sharp from 'sharp';
import path from 'node:path';
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMediaMethods } from '@librechat/data-schemas';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';
import type { MediaFileStrategy, MediaStorageSource } from './objects';
import type { GetURLParams } from '~/storage/types';
import { createMediaDerivativeProcessor } from './derivatives';
import { createMediaStrategyObjectStores } from './objects';
import { deleteMediaAwareFile } from './deletion';
import { createMediaStorage } from './storage';
import { getS3Key } from '~/storage/s3/crud';

/** Substitutes the external object service while exercising the host strategy adapter and real Mongo receipts. */
function objectService(source: MediaStorageSource) {
  const objects = new Map<string, Buffer>();
  const storedKey = (value: string): string => {
    if (!value.startsWith('https:')) return value;
    const pathname = new URL(value).pathname;
    if (source === 'firebase') return decodeURIComponent(pathname.split('/o/')[1]);
    return pathname.replace(source === 'azure_blob' ? /^\/files\// : /^\//, '');
  };
  const key = (params: GetURLParams): string => {
    if (source === 's3' || source === 'cloudfront')
      return getS3Key({
        basePath: params.basePath ?? 'images',
        userId: params.userId,
        fileName: params.fileName,
        tenantId: params.tenantId,
        includeRegionInPath: source === 'cloudfront',
        storageRegion: source === 'cloudfront' ? 'us-test-1' : undefined,
        useInlinePath: params.useInlinePath,
      });
    return `${params.tenantId ? `t/${params.tenantId}/` : ''}${params.basePath ?? 'images'}/${params.userId}/${params.fileName}`;
  };
  const url = (value: string) =>
    source === 'firebase'
      ? `https://firebase.test/v0/b/bucket/o/${encodeURIComponent(value)}?token=read`
      : `https://objects.test/${source === 'azure_blob' ? 'files/' : ''}${value}?signed=read`;
  let failAfterUpload = false;
  let failRenditionUpload = false;
  let failDeletion = false;
  const strategy: MediaFileStrategy = {
    async planFile(params) {
      return {
        filepath: url(key(params)),
        storageKey: key(params),
        storageRegion: source === 'cloudfront' ? 'us-test-1' : undefined,
      };
    },
    async saveStream(params) {
      const name = key(params);
      const data = await readFile(params.path);
      objects.set(name, data);
      if (failAfterUpload || (failRenditionUpload && name.includes('.thumbnail.')))
        throw new Error('Upload acknowledgement lost');
      return {
        filepath: url(name),
        bytes: data.length,
        storageKey: name,
        storageRegion: source === 'cloudfront' ? 'us-test-1' : undefined,
      };
    },
    async getDownloadStream(_req, filename, options) {
      const data = objects.get(storedKey(filename));
      if (!data) throw Object.assign(new Error('Object missing'), { code: 'NoSuchKey' });
      const selected = options?.range
        ? data.subarray(options.range.start, options.range.end + 1)
        : data;
      return Readable.from([selected.subarray(0, 13), selected.subarray(13)]);
    },
    async deleteFile(_req, file) {
      if (failDeletion) throw new Error('Deletion unavailable');
      objects.delete(file.storageKey ?? storedKey(file.filepath));
    },
    async deleteStoredFile(_basePath, filename) {
      if (failDeletion) throw new Error('Deletion unavailable');
      objects.delete(filename);
    },
  };
  return {
    objects,
    strategy,
    failUpload() {
      failAfterUpload = true;
    },
    failRenditionAndDeletion() {
      failRenditionUpload = true;
      failDeletion = true;
    },
    restoreDeletion() {
      failDeletion = false;
    },
    url,
  };
}

describe('media storage through existing cloud strategies', () => {
  let mongo: MongoMemoryServer;
  let repository: MediaMethods;
  let directory: string;
  let scope: MediaOwnerScope;
  let png: Buffer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    repository = createMediaMethods(mongoose, { ownerExists: async () => true });
    await repository.ensureMediaIndexes();
    directory = await mkdtemp(path.join(tmpdir(), 'librechat-media-cloud-'));
    png = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#224466' } })
      .png()
      .toBuffer();
  }, 60_000);
  beforeEach(() => {
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: 'tenant-a' };
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const setup = (source: MediaStorageSource) => {
    const remote = objectService(source);
    const storage = createMediaStorage({
      repository,
      imageDirectory: path.join(directory, 'images'),
      uploadDirectory: path.join(directory, 'uploads'),
      now: Date.now,
      stores: createMediaStrategyObjectStores(() => remote.strategy),
      derivatives: createMediaDerivativeProcessor({
        imageOutputType: 'png',
        video: {
          async render() {
            throw new Error('No video in image fixture');
          },
        },
        log: (message, error) => {
          throw error ?? new Error(message);
        },
      }),
    });
    const input = {
      scope,
      outputKey: 'cloud-original',
      type: 'image/png',
      filename: 'original.png',
      config: resolveMediaConfig({ assets: { source } }),
    };
    return { remote, storage, input };
  };

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)(
    'legacy Files deletion removes the %s original and every derivative before retirement',
    async (source) => {
      const { remote, storage, input } = setup(source);
      const asset = await storage.publish({ ...input, stream: Readable.from(png) });
      expect(remote.objects.size).toBe(2);
      const legacyDelete = jest.fn();
      await deleteMediaAwareFile({
        request: {
          user: { id: scope.ownerId, tenantId: scope.tenantId ?? undefined },
          config: {
            paths: {
              imageOutput: path.join(directory, 'images'),
              uploads: path.join(directory, 'uploads'),
            },
          },
        },
        file: asset,
        repository,
        deleteFile: legacyDelete,
        resolveStrategy: () => remote.strategy,
      });
      expect(remote.objects.size).toBe(0);
      expect(legacyDelete).not.toHaveBeenCalled();
      expect(await repository.getMediaAssetContent(scope, asset.file_id)).toBeNull();
    },
  );

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)(
    'checks %s client configuration without probing or writing external objects',
    async (source) => {
      const remote = objectService(source);
      const store = createMediaStrategyObjectStores(() => remote.strategy).find(
        (entry) => entry.source === source,
      )!;
      remote.strategy.getStorageState = async () => null;
      expect(await store.isAvailable?.()).toBe(false);
      remote.strategy.getStorageState = async () => {
        throw new Error('Client configuration is invalid');
      };
      expect(await store.isAvailable?.()).toBe(false);
      remote.strategy.getStorageState = async () => ({});
      expect(await store.isAvailable?.()).toBe(true);
      expect(remote.objects.size).toBe(0);
    },
  );

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)(
    'publishes immutable %s originals and sidecars, replays once, reads ranges, and cleans up together',
    async (source) => {
      const { remote, storage, input } = setup(source);
      const asset = await storage.publish({ ...input, stream: Readable.from(png) });
      const content = await repository.getMediaAssetContent(scope, asset.file_id);
      expect(content).not.toBeNull();
      expect(content?.source).toBe(source);
      expect(content?.storageKey).toContain(scope.ownerId);
      expect(content?.storageKey).toContain('tenant-a');
      expect(content?.mediaRenditions?.thumbnail?.source).toBe(source);
      expect(asset.renditions?.thumbnail?.filepath).toContain(
        `/${asset.file_id}/content?rendition=thumbnail`,
      );
      expect(asset).not.toHaveProperty('mediaRenditions');
      expect(asset.filepath).toContain(`/api/media/assets/${asset.file_id}/content`);
      const original = await storage.read(scope, asset.file_id, png.length);
      expect(original.data).toEqual(png);
      expect(original.asset).toEqual(asset);
      expect(original.asset).not.toHaveProperty('mediaRenditionLocations');
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.open(scope, content!, {
        range: { start: 7, end: 20 },
      }))
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(png.subarray(7, 21));
      expect(remote.objects.size).toBe(2);
      const again = await storage.publish({ ...input, stream: Readable.from(png) });
      expect(again.file_id).toBe(asset.file_id);
      expect(remote.objects.size).toBe(2);
      expect(await storage.remove({ ...scope, tenantId: 'other-tenant' }, asset.file_id)).toBe(
        false,
      );
      expect(await storage.remove(scope, asset.file_id)).toBe(true);
      expect(remote.objects.size).toBe(0);
      expect(
        await readdir(path.join(directory, 'uploads', 'temp', scope.ownerId, 'media')),
      ).toEqual([]);
    },
  );

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)(
    'cleans an unacknowledged %s upload using its predeclared location',
    async (source) => {
      const { remote, storage, input } = setup(source);
      remote.failUpload();
      await expect(storage.publish({ ...input, stream: Readable.from(png) })).rejects.toThrow(
        'Upload acknowledgement lost',
      );
      expect(remote.objects.size).toBe(0);
      expect(
        await repository.getPublishedMediaAsset({
          scope,
          outputKey: input.outputKey,
          rendition: 'original',
        }),
      ).toBeNull();
    },
  );

  it('keeps published bytes after a lost Mongo acknowledgement and resumes from the same immutable receipt', async () => {
    const { remote, storage, input } = setup(FileSources.s3);
    const commit = repository.commitMediaAssetWrite;
    jest.spyOn(repository, 'commitMediaAssetWrite').mockImplementationOnce(async (request) => {
      await commit(request);
      throw new Error('Mongo acknowledgement lost');
    });
    await expect(storage.publish({ ...input, stream: Readable.from(png) })).rejects.toThrow(
      'Mongo acknowledgement lost',
    );
    expect(remote.objects.size).toBe(2);
    const asset = await repository.getPublishedMediaAsset({
      scope,
      outputKey: input.outputKey,
      rendition: 'original',
    });
    expect((await storage.read(scope, asset!.file_id, png.length)).digest).toBe(
      createHash('sha256').update(png).digest('hex'),
    );
  });

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)(
    'keeps a %s original when its sidecar fails and retains cleanup ownership of the partial upload',
    async (source) => {
      const { remote, storage, input } = setup(source);
      remote.failRenditionAndDeletion();
      const asset = await storage.publish({ ...input, stream: Readable.from(png) });
      expect(asset.renditions).toBeUndefined();
      expect((await storage.read(scope, asset.file_id, png.length)).data).toEqual(png);
      expect(remote.objects.size).toBe(2);
      expect(
        (await repository.getMediaAssetContent(scope, asset.file_id))?.mediaRenditionLocations,
      ).toHaveLength(3);
      remote.restoreDeletion();
      expect(await storage.remove(scope, asset.file_id)).toBe(true);
      expect(remote.objects.size).toBe(0);
    },
  );

  it.each([
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
    FileSources.firebase,
  ] as const)('captures an existing %s file into a separate immutable original', async (source) => {
    const { remote, storage, input } = setup(source);
    const key = `t/tenant-a/images/${scope.ownerId}/source.png`;
    remote.objects.set(key, png);
    await mongoose.models.File.create({
      file_id: `source-${scope.ownerId}`,
      user: scope.ownerId,
      tenantId: scope.tenantId,
      source,
      storageKey: key,
      filepath: remote.url(key),
      filename: 'source.png',
      type: 'image/png',
      bytes: png.length,
    });
    const captured = await storage.capture(scope, `source-${scope.ownerId}`, input.config);
    expect((await storage.read(scope, captured.file_id, png.length)).data).toEqual(png);
    expect(remote.objects.get(key)).toEqual(png);
    expect(remote.objects.size).toBe(3);
  });
});
