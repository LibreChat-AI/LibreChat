jest.mock('@librechat/api', () => ({
  stripCacheBust: jest.requireActual('../../../../../../packages/api/src/storage/path')
    .stripCacheBust,
  createLocalStreamStorage: jest.requireActual('../../../../../../packages/api/src/storage/write')
    .createLocalStreamStorage,
}));
jest.mock('~/config/paths', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/Files/images/resize', () => ({}));

const path = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { FileSources } = require('librechat-data-provider');
const { readNativeMessageImage } = require('../../../../../../packages/api/src/media/nativeFiles');
const { getLocalFileStream } = require('../crud');

describe('native Message image replay through existing File storage', () => {
  let directory;
  let request;
  const scope = { ownerId: 'owner', tenantId: 'tenant' };
  const bytes = Buffer.from('exact signed image bytes');
  const file = {
    file_id: 'file-id',
    filename: 'original.png',
    filepath: '/images/t/tenant/owner/original.png?v=1',
    type: 'image/png',
    bytes: bytes.length,
    source: FileSources.local,
  };
  const strategy = (read) => ({ getDownloadStream: read });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'native-file-replay-'));
    const imageOutput = path.join(directory, 'configured-images');
    await mkdir(path.join(imageOutput, 't/tenant/owner'), { recursive: true });
    await writeFile(path.join(imageOutput, 't/tenant/owner/original.png'), bytes);
    request = {
      user: { id: 'request-owner', tenantId: 'request-tenant' },
      config: {
        paths: { imageOutput, uploads: path.join(directory, 'uploads'), publicPath: directory },
      },
    };
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the original from the loaded config and scopes the request without mutating it', async () => {
    const read = jest.fn(async (req, filepath) => {
      expect(req.config).toBe(request.config);
      expect(req.user).toEqual({ id: scope.ownerId, tenantId: scope.tenantId });
      return getLocalFileStream(req, filepath);
    });
    await expect(
      readNativeMessageImage(() => strategy(read), request, scope, file, bytes.length),
    ).resolves.toEqual(bytes);
    expect(read).toHaveBeenCalledTimes(1);
    expect(request.user).toEqual({ id: 'request-owner', tenantId: 'request-tenant' });
  });

  it.each([FileSources.s3, FileSources.cloudfront])(
    'passes the recorded object key to %s rather than an expired public URL',
    async (source) => {
      const read = jest.fn(async () => Readable.from(bytes));
      const storageKey = 'region/tenant/images/owner/original.png';
      await expect(
        readNativeMessageImage(
          () => strategy(read),
          request,
          scope,
          { ...file, source, filepath: 'https://expired.example/original.png', storageKey },
          bytes.length,
        ),
      ).resolves.toEqual(bytes);
      expect(read).toHaveBeenCalledWith(expect.anything(), storageKey);
    },
  );

  it('bounds actual streamed bytes even when the File record understates its size', async () => {
    const stream = Readable.from(bytes);
    await expect(
      readNativeMessageImage(
        () => strategy(async () => stream),
        request,
        scope,
        { ...file, bytes: 1 },
        bytes.length - 1,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 413 });
    expect(stream.destroyed).toBe(true);
  });
});
