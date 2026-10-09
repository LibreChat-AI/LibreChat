import { Readable } from 'node:stream';
import { FileSources, VisionModes } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { AttachmentStorageError, encodeAndFormatImages } from './image';
import * as memoryGuard from './memoryGuard';

const imageBytes = Buffer.from('image-content-bytes');
const content = imageBytes.toString('base64');
const dataUrl = `data:image/png;base64,${content}`;
const file = {
  file_id: 'image-1',
  filepath: 'https://storage.example/image.png?signature=secret',
  storageKey: 'images/user/image.png',
  filename: 'image.png',
  type: 'image/png',
  bytes: imageBytes.length,
  height: 10,
  width: 10,
  source: FileSources.s3,
};
const makeReq = (config: Partial<NonNullable<ServerRequest['config']>> = {}) =>
  ({ body: {}, config }) as ServerRequest;

describe('encodeAndFormatImages', () => {
  const getDownloadStream = jest.fn();
  const prepareImagePayload = jest.fn();
  const getStrategyFunctions: jest.MockedFunction<
    Parameters<typeof encodeAndFormatImages>[3]['getStrategyFunctions']
  > = jest.fn();
  const httpClient = { get: jest.fn() };
  const deps = { getStrategyFunctions, httpClient };

  beforeEach(() => {
    jest.resetAllMocks();
    getDownloadStream.mockImplementation(async () => Readable.from(imageBytes));
    prepareImagePayload.mockImplementation(async (_req, image) => [image, content]);
    getStrategyFunctions.mockImplementation(() => ({ getDownloadStream, prepareImagePayload }));
    httpClient.get.mockResolvedValue({ data: imageBytes });
    jest.spyOn(memoryGuard, 'runGuardedEncode');
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([FileSources.s3, FileSources.cloudfront, FileSources.azure_blob, FileSources.firebase])(
    'reads %s by canonical key without entering the legacy payload path',
    async (source) => {
      const result = await encodeAndFormatImages(makeReq(), [{ ...file, source }], {}, deps);

      expect(result.image_urls).toEqual([
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ]);
      expect(result.files).toEqual([
        expect.objectContaining({ file_id: file.file_id, height: 10, width: 10, embedded: false }),
      ]);
      expect(result.files[0]).not.toHaveProperty('storageKey');
      expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), file.storageKey);
      expect(memoryGuard.runGuardedEncode).toHaveBeenCalledWith(file.bytes, expect.any(Function));
      expect(prepareImagePayload).not.toHaveBeenCalled();
      expect(httpClient.get).not.toHaveBeenCalled();
    },
  );

  it('uses the legacy filepath when no canonical key was stored', async () => {
    await encodeAndFormatImages(makeReq(), [{ ...file, storageKey: undefined }], {}, deps);
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), file.filepath);
  });

  it('returns an empty result without acquiring a strategy for absent files', async () => {
    await expect(encodeAndFormatImages(makeReq(), undefined, {}, deps)).resolves.toEqual({
      files: [],
      image_urls: [],
    });
    await expect(encodeAndFormatImages(makeReq(), [], {}, deps)).resolves.toEqual({
      files: [],
      image_urls: [],
    });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('keeps metadata-only attachments without reading storage', async () => {
    const result = await encodeAndFormatImages(
      makeReq(),
      [{ ...file, height: undefined }],
      {},
      deps,
    );
    expect(result.files).toHaveLength(1);
    expect(result.image_urls).toEqual([]);
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('keeps metadata when a stored image has no download reference', async () => {
    const result = await encodeAndFormatImages(
      makeReq(),
      [{ ...file, filepath: '', storageKey: undefined }],
      {},
      deps,
    );
    expect(result.files).toHaveLength(1);
    expect(result.image_urls).toEqual([]);
    expect(getDownloadStream).not.toHaveBeenCalled();
    expect(prepareImagePayload).not.toHaveBeenCalled();
  });

  it('preserves the missing-object error without falling back to an external URL', async () => {
    getDownloadStream.mockRejectedValue({ name: 'NoSuchKey' });
    await expect(encodeAndFormatImages(makeReq(), [file], {}, deps)).rejects.toMatchObject({
      code: 'ATTACHMENT_OBJECT_NOT_FOUND',
      fileId: file.file_id,
    });
    expect(prepareImagePayload).not.toHaveBeenCalled();
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('discards buffered image bytes and hides storage error details', async () => {
    const failure = new Error('private storage path');
    getDownloadStream.mockResolvedValue(
      new Readable({
        read() {
          this.push(imageBytes);
          this.destroy(failure);
        },
      }),
    );
    await expect(encodeAndFormatImages(makeReq(), [file], {}, deps)).rejects.toEqual(
      new AttachmentStorageError(),
    );
    expect(failure).not.toHaveProperty('bufferedData');
    expect(prepareImagePayload).not.toHaveBeenCalled();
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it.each([FileSources.local, undefined])(
    'keeps the unguarded local path for %s',
    async (source) => {
      const result = await encodeAndFormatImages(makeReq(), [{ ...file, source }], {}, deps);
      expect(result.image_urls).toEqual([
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ]);
      expect(prepareImagePayload).toHaveBeenCalled();
      expect(getDownloadStream).not.toHaveBeenCalled();
      expect(memoryGuard.runGuardedEncode).not.toHaveBeenCalled();
    },
  );

  it('keeps legacy external URLs for endpoints that accept them', async () => {
    prepareImagePayload.mockImplementation(async (_req, image) => [image, file.filepath]);
    const result = await encodeAndFormatImages(
      makeReq(),
      [{ ...file, source: FileSources.openai }],
      { endpoint: 'openai' },
      deps,
    );
    expect(result.image_urls).toEqual([
      { type: 'image_url', image_url: { url: file.filepath, detail: 'auto' } },
    ]);
    expect(httpClient.get).not.toHaveBeenCalled();
    expect(memoryGuard.runGuardedEncode).not.toHaveBeenCalled();
  });

  it('guards legacy URL downloads for base64-only endpoints', async () => {
    prepareImagePayload.mockImplementation(async (_req, image) => [image, file.filepath]);
    const result = await encodeAndFormatImages(
      makeReq(),
      [{ ...file, source: FileSources.openai }],
      { endpoint: 'anthropic' },
      deps,
    );
    expect(result.image_urls).toEqual([
      { type: 'image', source: { type: 'base64', media_type: file.type, data: content } },
    ]);
    expect(httpClient.get).toHaveBeenCalledWith(file.filepath, { responseType: 'arraybuffer' });
    expect(memoryGuard.runGuardedEncode).toHaveBeenCalledWith(file.bytes, expect.any(Function));
  });

  it('rejects unsupported legacy strategies instead of silently dropping images', async () => {
    getStrategyFunctions.mockReturnValue({ getDownloadStream });
    await expect(
      encodeAndFormatImages(makeReq(), [{ ...file, source: FileSources.openai }], {}, deps),
    ).rejects.toThrow('Encoding function not implemented for openai');
  });

  it.each([
    [
      'google',
      VisionModes.generative,
      { type: 'image_url', inlineData: { mimeType: file.type, data: content } },
    ],
    ['google', undefined, { type: 'image_url', image_url: dataUrl }],
    [
      'anthropic',
      undefined,
      { type: 'image', source: { type: 'base64', media_type: file.type, data: content } },
    ],
    [
      'anthropic',
      VisionModes.agents,
      { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
    ],
  ])('preserves the %s payload in mode %s', async (provider, mode, expected) => {
    const result = await encodeAndFormatImages(makeReq(), [file], { provider }, deps, mode);
    expect(result.image_urls).toEqual([expected]);
  });

  it.each([
    [undefined, undefined, 'auto'],
    ['low', undefined, 'low'],
    [undefined, 'high', 'high'],
    ['low', 'high', 'high'],
  ] as const)(
    'resolves body detail %s and caller detail %s',
    async (bodyDetail, imageDetail, expected) => {
      const req = makeReq();
      req.body.imageDetail = bodyDetail;
      const result = await encodeAndFormatImages(req, [file], { imageDetail }, deps);
      expect(result.image_urls).toEqual([
        { type: 'image_url', image_url: { url: dataUrl, detail: expected } },
      ]);
    },
  );

  it('reuses each strategy and preserves order across storage and local images', async () => {
    const files = [
      file,
      { ...file, file_id: 'local', source: FileSources.local },
      { ...file, file_id: 'stored-2' },
    ];
    const result = await encodeAndFormatImages(makeReq(), files, {}, deps);
    expect(result.files.map((entry) => entry.file_id)).toEqual(files.map((entry) => entry.file_id));
    expect(result.image_urls).toHaveLength(3);
    expect(getStrategyFunctions).toHaveBeenCalledTimes(2);
    expect(getDownloadStream).toHaveBeenCalledTimes(2);
    expect(prepareImagePayload).toHaveBeenCalledTimes(1);
  });

  it.each([
    { endpoint: 'anthropic' },
    { provider: 'anthropic' },
    { provider: 'openai', endpoint: 'anthropic' },
  ])('resolves the configured size limit for %j', async (params) => {
    const req = makeReq({ fileConfig: { endpoints: { anthropic: { fileSizeLimit: 0.000001 } } } });
    await expect(encodeAndFormatImages(req, [file], params, deps)).rejects.toThrow(
      'Image validation failed for image.png: Image file size',
    );
  });
});
