import { Readable } from 'stream';
import { finished } from 'stream/promises';
import type { TFile } from 'librechat-data-provider';
import type { CloudFrontFullConfig } from '~/cdn/cloudfront';
import type { ServerRequest } from '~/types';

const mockGetCloudFrontConfig = jest.fn<CloudFrontFullConfig | null, []>();
const mockGetS3Key = jest.fn();
const mockSaveBufferToS3 = jest.fn();
const mockSaveURLToS3WithMetadata = jest.fn();
const mockUploadFileToS3 = jest.fn();
const mockDeleteFileFromS3 = jest.fn();
const mockGetS3FileStream = jest.fn();
const mockParseS3Key = jest.fn();
const mockExtractKeyFromS3Url = jest.fn<string, [string]>();
const mockResolveStoredS3Key = jest.fn<string, [TFile]>();
const mockCloudFrontSend = jest.fn();
const mockGetSignedUrl = jest.fn<string, [object]>();
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const originalFetch = global.fetch;

jest.mock('~/cdn/cloudfront', () => ({
  getCloudFrontConfig: mockGetCloudFrontConfig,
}));

jest.mock('~/storage/s3/crud', () => ({
  parseS3Key: mockParseS3Key,
  getS3Key: mockGetS3Key,
  saveBufferToS3: mockSaveBufferToS3,
  saveURLToS3WithMetadata: mockSaveURLToS3WithMetadata,
  uploadFileToS3: mockUploadFileToS3,
  deleteFileFromS3: mockDeleteFileFromS3,
  getS3FileStream: mockGetS3FileStream,
  extractKeyFromS3Url: mockExtractKeyFromS3Url,
  resolveStoredS3Key: mockResolveStoredS3Key,
}));

jest.mock('@aws-sdk/cloudfront-signer', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

jest.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: jest.fn().mockImplementation(() => ({ send: mockCloudFrontSend })),
  CreateInvalidationCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@librechat/data-schemas', () => ({ logger: mockLogger }));

jest.mock('~/storage/s3/s3Config', () => ({
  s3Config: { S3_URL_EXPIRY_SECONDS: 900, AWS_REGION: 'us-east-1' },
}));

function makeConfig(overrides: Partial<CloudFrontFullConfig> = {}): CloudFrontFullConfig {
  return {
    domain: 'https://d123.cloudfront.net',
    invalidateOnDelete: false,
    imageSigning: 'none',
    urlExpiry: 3600,
    cookieExpiry: 1800,
    includeRegionInPath: false,
    requireSignedAccess: false,
    privateKey: null,
    keyPairId: null,
    ...overrides,
  };
}

describe('CloudFront CRUD', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetS3Key.mockImplementation(
      ({ basePath, userId, fileName, tenantId, storageRegion, useInlinePath }) => {
        let inlinePrefix = null;
        if (useInlinePath) {
          inlinePrefix = basePath === 'avatars' ? 'a' : 'i';
        }
        const prefix = inlinePrefix ? `${inlinePrefix}/` : '';
        if (storageRegion) {
          return tenantId
            ? `${prefix}r/${storageRegion}/t/${tenantId}/${basePath}/${userId}/${fileName}`
            : `${prefix}r/${storageRegion}/${basePath}/${userId}/${fileName}`;
        }
        return tenantId
          ? `${prefix}t/${tenantId}/${basePath}/${userId}/${fileName}`
          : `${prefix}${basePath}/${userId}/${fileName}`;
      },
    );
    mockGetCloudFrontConfig.mockReturnValue(makeConfig());
  });

  describe('getCloudFrontURL', () => {
    it('returns plain CloudFront URL when sign is false (default)', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'photo.webp' });
      expect(url).toBe('https://d123.cloudfront.net/i/images/user1/photo.webp');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('percent-encodes non-ASCII characters in the key', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'Ársreikningur.pdf' });
      expect(url).toBe('https://d123.cloudfront.net/i/images/user1/%C3%81rsreikningur.pdf');
    });

    it('percent-encodes a literal % so it cannot be read back as an escape', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'report%20final.pdf' });
      expect(url).toBe('https://d123.cloudfront.net/i/images/user1/report%2520final.pdf');
    });

    it('leaves path separators literal', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'doc.pdf',
        basePath: 'documents',
      });
      expect(url).toBe('https://d123.cloudfront.net/documents/user1/doc.pdf');
    });

    it('uses custom basePath when provided', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'doc.pdf',
        basePath: 'documents',
      });
      expect(url).toBe('https://d123.cloudfront.net/documents/user1/doc.pdf');
    });

    it('uses tenant-prefixed keys when tenantId is provided', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'doc.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
      });
      expect(url).toBe('https://d123.cloudfront.net/t/tenantA/documents/user1/doc.pdf');
      expect(mockGetS3Key).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'documents',
          userId: 'user1',
          fileName: 'doc.pdf',
          tenantId: 'tenantA',
        }),
      );
    });

    it('uses region-prefixed keys when configured', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ storageRegion: 'us-east-2', includeRegionInPath: true }),
      );
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'doc.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
      });
      expect(url).toBe('https://d123.cloudfront.net/r/us-east-2/t/tenantA/documents/user1/doc.pdf');
      expect(mockGetS3Key).toHaveBeenCalledWith(
        expect.objectContaining({
          storageRegion: 'us-east-2',
          includeRegionInPath: true,
        }),
      );
    });

    it('uses region-aware private inline image keys when configured', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ storageRegion: 'eu-central-1', includeRegionInPath: true }),
      );
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'photo.webp',
        tenantId: 'tenantA',
      });
      expect(url).toBe(
        'https://d123.cloudfront.net/i/r/eu-central-1/t/tenantA/images/user1/photo.webp',
      );
      expect(mockGetS3Key).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'images',
          useInlinePath: true,
        }),
      );
    });

    it('uses avatar cookie namespace for avatar URLs', async () => {
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'avatar.png',
        basePath: 'avatars',
        tenantId: 'tenantA',
      });
      expect(url).toBe('https://d123.cloudfront.net/a/t/tenantA/avatars/user1/avatar.png');
      expect(mockGetS3Key).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'avatars',
          useInlinePath: true,
        }),
      );
    });

    it('strips trailing slash from domain', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ domain: 'https://d123.cloudfront.net/' }),
      );
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'photo.webp' });
      expect(url).toBe('https://d123.cloudfront.net/i/images/user1/photo.webp');
    });

    it('strips multiple trailing slashes from domain', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ domain: 'https://d123.cloudfront.net///' }),
      );
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'photo.webp' });
      expect(url).toBe('https://d123.cloudfront.net/i/images/user1/photo.webp');
    });

    it('strips leading slash from S3 key', async () => {
      mockGetS3Key.mockReturnValue('/images/user1/photo.webp');
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'photo.webp' });
      expect(url).toBe('https://d123.cloudfront.net/images/user1/photo.webp');
    });

    it('strips multiple leading slashes from S3 key', async () => {
      mockGetS3Key.mockReturnValue('///images/user1/photo.webp');
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({ userId: 'user1', fileName: 'photo.webp' });
      expect(url).toBe('https://d123.cloudfront.net/images/user1/photo.webp');
    });

    it('returns signed URL when sign is true', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk-secret', keyPairId: 'K123' }),
      );
      mockGetSignedUrl.mockReturnValue(
        'https://d123.cloudfront.net/doc.pdf?Policy=abc&Signature=xyz',
      );
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      const url = await getCloudFrontURL({
        userId: 'user1',
        fileName: 'doc.pdf',
        basePath: 'documents',
        sign: true,
      });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://d123.cloudfront.net/documents/user1/doc.pdf',
          keyPairId: 'K123',
          privateKey: 'pk-secret',
          dateLessThan: expect.any(String),
        }),
      );
      expect(url).toContain('Policy=abc');
    });

    it('uses urlExpiry from config for signed URL', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk', keyPairId: 'K1', urlExpiry: 7200 }),
      );
      mockGetSignedUrl.mockReturnValue('https://d123.cloudfront.net/doc.pdf?signed');
      const before = Date.now();
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      await getCloudFrontURL({ userId: 'u', fileName: 'f.pdf', sign: true });
      const after = Date.now();

      const { dateLessThan } = mockGetSignedUrl.mock.calls[0][0] as { dateLessThan: string };
      const expiry = new Date(dateLessThan).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 7200 * 1000);
      expect(expiry).toBeLessThanOrEqual(after + 7200 * 1000 + 100);
    });

    it('falls back to s3Config expiry when urlExpiry not set', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk', keyPairId: 'K1', urlExpiry: undefined as never }), // intentionally invalid input to test runtime guard
      );
      mockGetSignedUrl.mockReturnValue('https://d123.cloudfront.net/doc.pdf?signed');
      const before = Date.now();
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      await getCloudFrontURL({ userId: 'u', fileName: 'f.pdf', sign: true });
      const after = Date.now();

      const { dateLessThan } = mockGetSignedUrl.mock.calls[0][0] as { dateLessThan: string };
      const expiry = new Date(dateLessThan).getTime();
      // 900s fallback from mocked s3Config
      expect(expiry).toBeGreaterThanOrEqual(before + 900 * 1000);
      expect(expiry).toBeLessThanOrEqual(after + 900 * 1000 + 100);
    });

    it('throws when CloudFront is not initialized', async () => {
      mockGetCloudFrontConfig.mockReturnValue(null);
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      await expect(getCloudFrontURL({ userId: 'u', fileName: 'f.png' })).rejects.toThrow(
        'CloudFront not initialized',
      );
    });

    it('throws when signing requested but keys not configured', async () => {
      // config with no keys
      mockGetCloudFrontConfig.mockReturnValue(makeConfig({ privateKey: null, keyPairId: null }));
      const { getCloudFrontURL } = await import('~/storage/cloudfront/crud');
      await expect(
        getCloudFrontURL({ userId: 'u', fileName: 'doc.pdf', sign: true }),
      ).rejects.toThrow('Signing keys not configured');
    });
  });

  describe('saveBufferToCloudFront', () => {
    it('calls saveBufferToS3 with correct params and urlBuilder', async () => {
      mockSaveBufferToS3.mockResolvedValue('https://d123.cloudfront.net/images/u/f.webp');
      const { saveBufferToCloudFront } = await import('~/storage/cloudfront/crud');
      const result = await saveBufferToCloudFront({
        userId: 'u',
        buffer: Buffer.from('data'),
        fileName: 'f.webp',
        basePath: 'images',
      });

      expect(mockSaveBufferToS3).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u',
          buffer: Buffer.from('data'),
          fileName: 'f.webp',
          basePath: 'images',
          useInlinePath: true,
          urlBuilder: expect.any(Function),
        }),
      );
      expect(result).toBe('https://d123.cloudfront.net/images/u/f.webp');
    });

    it('passes sign=false to urlBuilder by default', async () => {
      let capturedUrlBuilder: ((p: object) => Promise<string>) | null = null;
      mockSaveBufferToS3.mockImplementation(
        ({ urlBuilder }: { urlBuilder: (p: object) => Promise<string> }) => {
          capturedUrlBuilder = urlBuilder;
          return Promise.resolve('https://d123.cloudfront.net/images/u/f.webp');
        },
      );

      const { saveBufferToCloudFront } = await import('~/storage/cloudfront/crud');
      await saveBufferToCloudFront({ userId: 'u', buffer: Buffer.from('x'), fileName: 'f.webp' });

      // urlBuilder invoked without sign should not call getSignedUrl
      await capturedUrlBuilder!({ userId: 'u', fileName: 'f.webp', basePath: 'images' });
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('passes sign=true to urlBuilder when requested', async () => {
      mockGetCloudFrontConfig.mockReturnValue(makeConfig({ privateKey: 'pk', keyPairId: 'K1' }));
      mockGetSignedUrl.mockReturnValue('https://d123.cloudfront.net/images/u/f.webp?signed');

      let capturedUrlBuilder: ((p: object) => Promise<string>) | null = null;
      mockSaveBufferToS3.mockImplementation(
        ({ urlBuilder }: { urlBuilder: (p: object) => Promise<string> }) => {
          capturedUrlBuilder = urlBuilder;
          return Promise.resolve('https://d123.cloudfront.net/images/u/f.webp?signed');
        },
      );

      const { saveBufferToCloudFront } = await import('~/storage/cloudfront/crud');
      await saveBufferToCloudFront({
        userId: 'u',
        buffer: Buffer.from('x'),
        fileName: 'f.webp',
        sign: true,
      });

      await capturedUrlBuilder!({ userId: 'u', fileName: 'f.webp', basePath: 'images' });
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });
  });

  describe('saveURLToCloudFront', () => {
    it('returns the saved filepath for public API compatibility', async () => {
      const savedFile = {
        filepath: 'https://d123.cloudfront.net/images/u/f.webp',
        bytes: 128,
        type: 'image/webp',
        dimensions: {},
      };
      mockSaveURLToS3WithMetadata.mockResolvedValue(savedFile);
      const { saveURLToCloudFront } = await import('~/storage/cloudfront/crud');
      const result = await saveURLToCloudFront({
        userId: 'u',
        URL: 'https://external.com/image.jpg',
        fileName: 'f.webp',
      });

      expect(mockSaveURLToS3WithMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u',
          URL: 'https://external.com/image.jpg',
          fileName: 'f.webp',
          urlBuilder: expect.any(Function),
        }),
      );
      expect(result).toBe(savedFile.filepath);
    });

    it('returns metadata from the explicit metadata variant', async () => {
      const savedFile = {
        filepath: 'https://d123.cloudfront.net/images/u/f.webp',
        bytes: 128,
        type: 'image/webp',
        dimensions: {},
      };
      mockSaveURLToS3WithMetadata.mockResolvedValue(savedFile);
      const { saveURLToCloudFrontWithMetadata } = await import('~/storage/cloudfront/crud');
      const result = await saveURLToCloudFrontWithMetadata({
        userId: 'u',
        URL: 'https://external.com/image.jpg',
        fileName: 'f.webp',
      });

      expect(result).toBe(savedFile);
    });
  });

  describe('uploadFileToCloudFront', () => {
    it('keeps document uploads outside the inline cookie namespaces', async () => {
      const uploadResult = { filepath: 'https://d123.cloudfront.net/uploads/u/f.pdf', bytes: 1024 };
      mockUploadFileToS3.mockResolvedValue(uploadResult);

      const mockReq = { user: { id: 'u' } } as ServerRequest;
      const mockFile = {
        path: '/tmp/f.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const { uploadFileToCloudFront } = await import('~/storage/cloudfront/crud');
      const result = await uploadFileToCloudFront({
        req: mockReq,
        file: mockFile,
        file_id: 'fid-1',
        basePath: 'uploads',
      });

      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        expect.objectContaining({
          req: mockReq,
          file: mockFile,
          file_id: 'fid-1',
          basePath: 'uploads',
          useInlinePath: false,
          urlBuilder: expect.any(Function),
        }),
      );
      expect(result).toEqual(uploadResult);
    });

    it('keeps image uploads in the private inline namespace', async () => {
      const uploadResult = { filepath: 'https://d123.cloudfront.net/i/images/u/f.png', bytes: 512 };
      mockUploadFileToS3.mockResolvedValue(uploadResult);

      const mockReq = { user: { id: 'u' } } as ServerRequest;
      const mockFile = { path: '/tmp/f.png', mimetype: 'image/png' } as Express.Multer.File;

      const { uploadFileToCloudFront } = await import('~/storage/cloudfront/crud');
      const result = await uploadFileToCloudFront({
        req: mockReq,
        file: mockFile,
        file_id: 'fid-1',
      });

      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        expect.objectContaining({
          useInlinePath: true,
        }),
      );
      expect(result).toEqual(uploadResult);
    });
  });

  describe('deleteFileFromCloudFront', () => {
    const mockReq = { user: { id: 'u' } } as ServerRequest;
    const mockFile = {
      file_id: 'fid-1',
      filepath: 'https://d123.cloudfront.net/images/u/file.webp',
      source: 'cloudfront',
    } as unknown as TFile;

    beforeEach(() => {
      mockDeleteFileFromS3.mockResolvedValue(undefined);
      mockExtractKeyFromS3Url.mockReturnValue('images/u/file.webp');
      mockResolveStoredS3Key.mockReturnValue('images/u/file.webp');
    });

    it('calls deleteFileFromS3 to remove the file', async () => {
      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);
      expect(mockDeleteFileFromS3).toHaveBeenCalledWith(mockReq, mockFile);
    });

    it('does not create invalidation when invalidateOnDelete is false', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: false, distributionId: 'E123' }),
      );
      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it('does not create invalidation when distributionId is missing', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: undefined }),
      );
      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);
      expect(mockCloudFrontSend).not.toHaveBeenCalled();
    });

    it('creates CloudFront invalidation when invalidateOnDelete is true', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: 'E123ABC' }),
      );
      mockCloudFrontSend.mockResolvedValue({});
      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);

      expect(mockCloudFrontSend).toHaveBeenCalledTimes(1);
      const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
      expect(CreateInvalidationCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DistributionId: 'E123ABC',
          InvalidationBatch: expect.objectContaining({
            Paths: { Quantity: 1, Items: ['/images/u/file.webp'] },
          }),
        }),
      );
    });

    it('encodes the invalidation path the same way as the viewer URL', async () => {
      mockResolveStoredS3Key.mockReturnValue('images/u/report%20final \u0151.webp');
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: 'E123' }),
      );
      mockCloudFrontSend.mockResolvedValue({});

      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);

      const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
      expect(CreateInvalidationCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          InvalidationBatch: expect.objectContaining({
            Paths: { Quantity: 1, Items: ['/images/u/report%2520final%20%C5%91.webp'] },
          }),
        }),
      );
    });

    it('prefixes key with / for invalidation path', async () => {
      mockResolveStoredS3Key.mockReturnValue('images/u/file.webp'); // no leading slash
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: 'E123' }),
      );
      mockCloudFrontSend.mockResolvedValue({});

      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);

      const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
      expect(CreateInvalidationCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          InvalidationBatch: expect.objectContaining({
            Paths: expect.objectContaining({ Items: ['/images/u/file.webp'] }),
          }),
        }),
      );
    });

    it('does not re-prefix path that already has leading slash', async () => {
      mockResolveStoredS3Key.mockReturnValue('/images/u/file.webp'); // already has slash
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: 'E123' }),
      );
      mockCloudFrontSend.mockResolvedValue({});

      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await deleteFileFromCloudFront(mockReq, mockFile);

      const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
      expect(CreateInvalidationCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          InvalidationBatch: expect.objectContaining({
            Paths: expect.objectContaining({ Items: ['/images/u/file.webp'] }),
          }),
        }),
      );
    });

    it('logs error and continues when invalidation fails', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ invalidateOnDelete: true, distributionId: 'E123' }),
      );
      mockCloudFrontSend.mockRejectedValue(new Error('Access denied'));

      const { deleteFileFromCloudFront } = await import('~/storage/cloudfront/crud');
      await expect(deleteFileFromCloudFront(mockReq, mockFile)).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[deleteFileFromCloudFront] Cache invalidation failed:'),
        'Access denied',
      );
    });
  });

  describe('getCloudFrontFileStream', () => {
    const remoteKey = 'i/r/eu-west-1/images/u/f.webp';
    const responseFor = (body: Readable) =>
      new Response(Readable.toWeb(body) as unknown as BodyInit);

    beforeEach(() => {
      mockExtractKeyFromS3Url.mockReturnValue(remoteKey);
      mockParseS3Key.mockReturnValue({ storageRegion: 'eu-west-1' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('forwards a body error to the returned stream', async () => {
      const body = new Readable({ read() {} });
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFor(body));
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream({} as ServerRequest, remoteKey);
      const result = finished(stream);
      body.destroy(new Error('terminated'));
      await expect(result).rejects.toThrow('terminated');
    });

    it('forwards caller cancellation after headers and cancels the body', async () => {
      const body = new Readable({ read() {} });
      const controller = new AbortController();
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFor(body));
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream({} as ServerRequest, remoteKey, {
        signal: controller.signal,
      });
      const result = finished(stream);
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(body.destroyed).toBe(true);
    });

    it('cancels the body when the returned stream is destroyed', async () => {
      const body = new Readable({ read() {} });
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFor(body));
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream({} as ServerRequest, remoteKey);
      const result = finished(stream);
      stream.destroy();
      await expect(result).rejects.toThrow('Premature close');
      expect(body.destroyed).toBe(true);
    });

    it('cancels the body when the streamed byte limit is exceeded', async () => {
      const limits = await import('~/storage/url');
      jest.spyOn(limits, 'getRemoteFileFetchMaxBytes').mockReturnValue(3);
      const body = new Readable({ read() {} });
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFor(body));
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream({} as ServerRequest, remoteKey);
      const result = finished(stream);
      stream.resume();
      body.push('large');
      await expect(result).rejects.toThrow('Remote file response too large');
      expect(body.destroyed).toBe(true);
    });

    it('preserves caller cancellation before headers and clears the timeout', async () => {
      jest.useFakeTimers();
      jest.spyOn(global, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const controller = new AbortController();
      const result = getCloudFrontFileStream({} as ServerRequest, remoteKey, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([false, true])(
      'times out response headers with caller signal=%s',
      async (withSignal) => {
        jest.useFakeTimers();
        jest.spyOn(global, 'fetch').mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        );
        const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
        const { getRemoteFileFetchTimeoutMs } = await import('~/storage/url');
        const controller = new AbortController();
        const result = getCloudFrontFileStream(
          {} as ServerRequest,
          remoteKey,
          withSignal ? { signal: controller.signal } : undefined,
        );
        await Promise.all([
          expect(result).rejects.toMatchObject({ name: 'AbortError' }),
          jest.advanceTimersByTimeAsync(getRemoteFileFetchTimeoutMs()),
        ]);
        expect(controller.signal.aborted).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
      },
    );

    it('clears the header timeout while the body is still streaming', async () => {
      jest.useFakeTimers();
      const body = new Readable({ read() {} });
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFor(body));
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream({} as ServerRequest, remoteKey);
      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
      const result = finished(stream);
      stream.resume();
      body.push('remote');
      body.push(null);
      await result;
    });

    it('reads a local-region key directly from S3', async () => {
      const readable = new Readable();
      mockGetS3FileStream.mockResolvedValue(readable);
      mockExtractKeyFromS3Url.mockReturnValue('r/us-east-1/images/u/f.webp');
      mockParseS3Key.mockReturnValue({ storageRegion: 'us-east-1' });

      const mockReq = { user: { id: 'u' } } as ServerRequest;
      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const result = await getCloudFrontFileStream(
        mockReq,
        'https://d123.cloudfront.net/images/u/f.webp',
      );

      expect(mockGetS3FileStream).toHaveBeenCalledWith(
        mockReq,
        'r/us-east-1/images/u/f.webp',
        undefined,
      );
      expect(result).toBe(readable);
    });

    it('reads a cross-region key through CloudFront', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk-secret', keyPairId: 'K123' }),
      );
      mockExtractKeyFromS3Url.mockReturnValue('i/r/eu-west-1/images/u/f.webp');
      mockParseS3Key.mockReturnValue({ storageRegion: 'eu-west-1' });
      mockGetSignedUrl.mockReturnValue(
        'https://d123.cloudfront.net/i/r/eu-west-1/images/u/f.webp?Policy=abc',
      );
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => '6' },
        body: Readable.toWeb(Readable.from('remote')),
      }) as unknown as typeof fetch;

      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      const stream = await getCloudFrontFileStream(
        { user: { id: 'u' } } as ServerRequest,
        'i/r/eu-west-1/images/u/f.webp',
      );
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks).toString()).toBe('remote');
      expect(mockGetS3FileStream).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://d123.cloudfront.net/i/r/eu-west-1/images/u/f.webp?Policy=abc',
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });

    it('preserves a cross-region CloudFront 404 for missing-attachment handling', async () => {
      mockExtractKeyFromS3Url.mockReturnValue('i/r/eu-west-1/images/u/missing.webp');
      mockParseS3Key.mockReturnValue({ storageRegion: 'eu-west-1' });
      const cancel = jest.fn().mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { cancel },
      }) as unknown as typeof fetch;

      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      await expect(
        getCloudFrontFileStream(
          { user: { id: 'u' } } as ServerRequest,
          'i/r/eu-west-1/images/u/missing.webp',
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(cancel).toHaveBeenCalled();
    });

    it('cancels an oversized cross-region response', async () => {
      mockExtractKeyFromS3Url.mockReturnValue('i/r/eu-west-1/images/u/large.webp');
      mockParseS3Key.mockReturnValue({ storageRegion: 'eu-west-1' });
      const cancel = jest.fn().mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => String(513 * 1024 * 1024) },
        body: { cancel },
      }) as unknown as typeof fetch;

      const { getCloudFrontFileStream } = await import('~/storage/cloudfront/crud');
      await expect(
        getCloudFrontFileStream(
          { user: { id: 'u' } } as ServerRequest,
          'i/r/eu-west-1/images/u/large.webp',
        ),
      ).rejects.toThrow('Remote file response too large');
      expect(cancel).toHaveBeenCalled();
    });
  });

  describe('getCloudFrontDownloadURL', () => {
    it('returns a signed CloudFront URL for an existing file path', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk-secret', keyPairId: 'K123' }),
      );
      mockResolveStoredS3Key.mockReturnValue('t/tenantA/uploads/user1/doc.pdf');
      mockGetSignedUrl.mockReturnValue(
        'https://d123.cloudfront.net/t/tenantA/uploads/user1/doc.pdf?Policy=abc',
      );

      const { getCloudFrontDownloadURL } = await import('~/storage/cloudfront/crud');
      const result = await getCloudFrontDownloadURL({
        req: { user: { id: 'user1', tenantId: 'tenantA' } } as ServerRequest,
        file: {
          filepath: 'https://d123.cloudfront.net/t/tenantA/uploads/user1/doc.pdf',
        } as TFile,
      });

      expect(result).toContain('Policy=abc');
      expect(mockResolveStoredS3Key).toHaveBeenCalledWith(
        expect.objectContaining({
          filepath: 'https://d123.cloudfront.net/t/tenantA/uploads/user1/doc.pdf',
        }),
      );
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://d123.cloudfront.net/t/tenantA/uploads/user1/doc.pdf',
          keyPairId: 'K123',
          privateKey: 'pk-secret',
        }),
      );
    });

    it('includes response header overrides before signing download URLs', async () => {
      mockGetCloudFrontConfig.mockReturnValue(
        makeConfig({ privateKey: 'pk-secret', keyPairId: 'K123' }),
      );
      mockResolveStoredS3Key.mockReturnValue('uploads/user1/report.pdf');
      mockGetSignedUrl.mockReturnValue('signed-url');

      const { getCloudFrontDownloadURL } = await import('~/storage/cloudfront/crud');
      const result = await getCloudFrontDownloadURL({
        file: { filepath: 'https://d123.cloudfront.net/uploads/user1/report.pdf' } as TFile,
        customFilename: 'report";\\bad.pdf',
        contentType: 'application/pdf',
      });

      expect(result).toBe('signed-url');
      const signedInputUrl = new URL((mockGetSignedUrl.mock.calls[0][0] as { url: string }).url);
      expect(signedInputUrl.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="reportbad.pdf"',
      );
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('response-content-disposition=attachment'),
        }),
      );
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('response-content-type=application%2Fpdf'),
        }),
      );
      const signingInput = mockGetSignedUrl.mock.calls[0][0] as { policy: string };
      const policy = JSON.parse(signingInput.policy) as {
        Statement: Array<{
          Resource: string;
          Condition: { DateLessThan: { 'AWS:EpochTime': number } };
        }>;
      };
      expect(policy.Statement[0].Resource).toBe(
        'https://d123.cloudfront.net/uploads/user1/report.pdf?*',
      );
      expect(policy.Statement[0].Condition.DateLessThan['AWS:EpochTime']).toEqual(
        expect.any(Number),
      );
    });

    it('throws when signing keys are missing', async () => {
      mockGetCloudFrontConfig.mockReturnValue(makeConfig({ privateKey: null, keyPairId: null }));
      mockResolveStoredS3Key.mockReturnValue('uploads/user1/doc.pdf');

      const { getCloudFrontDownloadURL } = await import('~/storage/cloudfront/crud');
      await expect(
        getCloudFrontDownloadURL({
          req: { user: { id: 'user1' } } as ServerRequest,
          file: { filepath: 'https://d123.cloudfront.net/uploads/user1/doc.pdf' } as TFile,
        }),
      ).rejects.toThrow('Signing keys not configured');
    });
  });
});
