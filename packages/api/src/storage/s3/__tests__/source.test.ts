import { Readable } from 'stream';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { FileSources } from 'librechat-data-provider';
import type * as ClientS3 from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://bucket.s3.amazonaws.com/key?signed=true'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const owner = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const key = `images/${owner}/file-1__photo one.png`;

type Modules = {
  client: typeof ClientS3;
  crud: typeof import('../crud');
  source: typeof import('../source');
  link: typeof import('~/storage/proxy/link');
};

const signedUrl = () => {
  const date = new Date(Date.now() - 60 * 1000).toISOString().replace(/[-:]/g, '').split('.')[0];
  return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Signature=abc&X-Amz-Date=${date}Z&X-Amz-Expires=604800`;
};

describe('S3 with stored file links', () => {
  const originalEnv = { ...process.env };
  let modules: Modules;
  let s3Mock: ReturnType<typeof mockClient>;

  beforeAll(() => {
    jest.isolateModules(() => {
      Object.assign(process.env, {
        AWS_REGION: 'eu-west-2',
        AWS_BUCKET_NAME: 'test-bucket',
        DOMAIN_CLIENT: 'https://chat.example.com',
      });
      modules = {
        /** The isolated registry loads its own client, which is the one to mock. */
        client: jest.requireActual('@aws-sdk/client-s3'),
        crud: jest.requireActual('../crud'),
        source: jest.requireActual('../source'),
        link: jest.requireActual('~/storage/proxy/link'),
      };
    });
    s3Mock = mockClient(modules.client.S3Client);
  });

  beforeEach(() => {
    s3Mock?.reset();
    process.env.STORAGE_PROXY_FILES = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
    s3Mock.restore();
  });

  const storedLink = () => modules.link.getStoredFileURL(FileSources.s3, key);

  describe('strategy', () => {
    it('stores LibreChat links instead of presigned URLs and reads them back to keys', async () => {
      const { getS3URL, extractKeyFromS3Url, needsRefresh } = modules.crud;
      const url = await getS3URL({ userId: owner, fileName: 'file-1__photo one.png' });
      expect(url).toBe(storedLink());
      expect(extractKeyFromS3Url(url)).toBe(key);
      expect(needsRefresh(url, 3600)).toBe(false);
    });

    it('replaces presigned links when the proxy is on, and stored links when it is off', async () => {
      const { needsRefresh, refreshS3Url } = modules.crud;
      expect(needsRefresh(signedUrl(), 0)).toBe(true);
      await expect(refreshS3Url({ source: FileSources.s3, filepath: signedUrl() })).resolves.toBe(
        storedLink(),
      );

      process.env.STORAGE_PROXY_FILES = 'false';
      expect(needsRefresh(storedLink(), 3600)).toBe(true);
      await expect(refreshS3Url({ source: FileSources.s3, filepath: storedLink() })).resolves.toBe(
        'https://bucket.s3.amazonaws.com/key?signed=true',
      );
    });

    it('gives downloads no direct link, so callers stream through their own route', async () => {
      await expect(
        modules.crud.getS3DownloadURL({
          file: { filepath: storedLink() },
          customFilename: 'photo.png',
        } as Parameters<typeof modules.crud.getS3DownloadURL>[0]),
      ).resolves.toBe('');
    });
  });

  describe('s3FileSource', () => {
    const signal = new AbortController().signal;

    it('parses S3 keys, including tenant-scoped ones', () => {
      const { s3FileSource } = modules.source;
      expect(s3FileSource.parseKey(key)).toEqual(
        expect.objectContaining({ basePath: 'images', userId: owner, avatar: false }),
      );
      expect(s3FileSource.parseKey(`t/tenant-a/avatars/${owner}/avatar-1.png`)).toEqual(
        expect.objectContaining({ userId: owner, tenantId: 'tenant-a', avatar: true }),
      );
      expect(s3FileSource.parseKey(owner)).toBeNull();
    });

    it('streams GetObject and answers HEAD with HeadObject', async () => {
      const body = sdkStreamMixin(Readable.from([Buffer.from('image')]));
      s3Mock.on(modules.client.GetObjectCommand).resolves({ Body: body, ContentLength: 5 });
      s3Mock.on(modules.client.HeadObjectCommand).resolves({ ContentLength: 5 });
      const { s3FileSource } = modules.source;

      const object = await s3FileSource.read(key, { head: false, signal });
      expect(object.contentLength).toBe(5);
      expect(s3Mock.commandCalls(modules.client.GetObjectCommand)[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: key,
      });

      await expect(s3FileSource.read(key, { head: true, signal })).resolves.toEqual({
        contentLength: 5,
      });
      expect(s3Mock.commandCalls(modules.client.HeadObjectCommand)).toHaveLength(1);
    });

    it('recognises missing objects', () => {
      const { isNotFound } = modules.source.s3FileSource;
      expect(isNotFound({ name: 'NoSuchKey' })).toBe(true);
      expect(isNotFound({ name: 'NotFound' })).toBe(true);
      expect(isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
      expect(isNotFound(new Error('AccessDenied'))).toBe(false);
    });
  });
});
