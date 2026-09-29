/**
 * S3 Integration Tests
 *
 * These tests run against a REAL S3 bucket. They are skipped when AWS_TEST_BUCKET_NAME is not set.
 *
 * Run with:
 *   AWS_TEST_BUCKET_NAME=my-test-bucket npx jest s3.s3_integration
 *
 * Required env vars:
 *   - AWS_TEST_BUCKET_NAME: Dedicated test bucket (gates test execution)
 *   - AWS_REGION: Defaults to 'us-east-1'
 *   - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY => to avoid error: A dynamic import callback was invoked without -experimental-vm-modules — the AWS SDK credential provider
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ServerRequest } from '~/types';

const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const TEST_BUCKET = process.env.AWS_TEST_BUCKET_NAME;
const TEST_USER_ID = 'test-user-123';
const TEST_RUN_ID = `integration-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_BASE_PATH = TEST_RUN_ID;

async function deleteAllWithPrefix(s3: S3Client, bucket: string, prefix: string): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const response = await s3.send(listCommand);

    if (response.Contents?.length) {
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: response.Contents.filter(
            (obj): obj is typeof obj & { Key: string } => obj.Key !== undefined,
          ).map((obj) => ({ Key: obj.Key })),
        },
      });
      await s3.send(deleteCommand);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
}

describe('S3 Integration Tests', () => {
  if (!TEST_BUCKET) {
    // eslint-disable-next-line jest/expect-expect
    it.skip('Skipped: AWS_TEST_BUCKET_NAME not configured', () => {});
    return;
  }

  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;
  let s3Client: S3Client | null = null;

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Use dedicated test bucket
    process.env.AWS_BUCKET_NAME = TEST_BUCKET;
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

    // Reset modules so the next import picks up the updated env vars.
    // s3Client is retained as a plain instance — it remains valid even though
    // beforeEach/afterEach call resetModules() for per-test isolation.
    jest.resetModules();
    const { initializeS3 } = await import('~/cdn/s3');
    s3Client = initializeS3();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-integration-'));
    jest.resetModules();
  });

  afterEach(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    jest.resetModules();
  });

  afterAll(async () => {
    // Clean up all test files from this run
    if (s3Client && TEST_BUCKET) {
      await deleteAllWithPrefix(s3Client, TEST_BUCKET, TEST_RUN_ID);
    }
    process.env = originalEnv;
    jest.resetModules();
  });

  describe('getS3Key', () => {
    it('constructs key from basePath, userId, and fileName', async () => {
      const { getS3Key } = await import('~/storage/s3/crud');
      const key = getS3Key(TEST_BASE_PATH, TEST_USER_ID, 'test-file.txt');
      expect(key).toBe(`${TEST_BASE_PATH}/${TEST_USER_ID}/test-file.txt`);
    });

    it('handles nested file names', async () => {
      const { getS3Key } = await import('~/storage/s3/crud');
      const key = getS3Key(TEST_BASE_PATH, TEST_USER_ID, 'folder/nested/file.pdf');
      expect(key).toBe(`${TEST_BASE_PATH}/${TEST_USER_ID}/folder/nested/file.pdf`);
    });
  });

  describe('saveBufferToS3 and getS3URL', () => {
    it('uploads buffer and returns signed URL', async () => {
      const { saveBufferToS3 } = await import('~/storage/s3/crud');
      const testContent = 'Hello, S3!';
      const buffer = Buffer.from(testContent);
      const fileName = `test-${Date.now()}.txt`;

      const downloadURL = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      expect(downloadURL).toBeDefined();
      expect(downloadURL).toContain('X-Amz-Signature');
      expect(downloadURL).toContain(fileName);
    });

    it('can get signed URL for existing file', async () => {
      const { saveBufferToS3, getS3URL } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('test content for URL');
      const fileName = `url-test-${Date.now()}.txt`;

      await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const signedUrl = await getS3URL({
        userId: TEST_USER_ID,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      expect(signedUrl).toBeDefined();
      expect(signedUrl).toContain('X-Amz-Signature');
    });

    it('can get signed URL with custom filename and content type', async () => {
      const { saveBufferToS3, getS3URL } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('custom headers test');
      const fileName = `headers-test-${Date.now()}.txt`;

      await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const signedUrl = await getS3URL({
        userId: TEST_USER_ID,
        fileName,
        basePath: TEST_BASE_PATH,
        customFilename: 'download.txt',
        contentType: 'text/plain',
      });

      expect(signedUrl).toContain('response-content-disposition');
      expect(signedUrl).toContain('response-content-type');
    });
  });

  describe('saveURLToS3', () => {
    it('fetches URL content and uploads to S3', async () => {
      const { saveURLToS3WithMetadata } = await import('~/storage/s3/crud');
      const fileName = `url-upload-${Date.now()}.json`;

      const savedFile = await saveURLToS3WithMetadata({
        userId: TEST_USER_ID,
        URL: 'https://raw.githubusercontent.com/LibreChat-AI/LibreChat/main/package.json',
        fileName,
        basePath: TEST_BASE_PATH,
      });

      expect(savedFile.filepath).toBeDefined();
      expect(savedFile.filepath).toContain('X-Amz-Signature');
      expect(savedFile.bytes).toBeGreaterThan(0);
    });
  });

  describe('extractKeyFromS3Url', () => {
    it('extracts key from signed URL', async () => {
      const { saveBufferToS3, extractKeyFromS3Url } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('extract key test');
      const fileName = `extract-key-${Date.now()}.txt`;

      const signedUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const extractedKey = extractKeyFromS3Url(signedUrl);
      expect(extractedKey).toBe(`${TEST_BASE_PATH}/${TEST_USER_ID}/${fileName}`);
    });

    it('returns key as-is when not a URL', async () => {
      const { extractKeyFromS3Url } = await import('~/storage/s3/crud');
      const key = `${TEST_BASE_PATH}/${TEST_USER_ID}/file.txt`;
      expect(extractKeyFromS3Url(key)).toBe(key);
    });
  });

  describe('uploadFileToS3', () => {
    it('uploads file and returns filepath with bytes', async () => {
      const { uploadFileToS3 } = await import('~/storage/s3/crud');
      const testContent = 'File upload test content';
      const testFilePath = path.join(tempDir, 'upload-test.txt');
      fs.writeFileSync(testFilePath, testContent);

      const mockReq = {
        user: { id: TEST_USER_ID },
      } as ServerRequest;

      const mockFile = {
        path: testFilePath,
        originalname: 'upload-test.txt',
        fieldname: 'file',
        encoding: '7bit',
        mimetype: 'text/plain',
        size: Buffer.byteLength(testContent),
        stream: fs.createReadStream(testFilePath),
        destination: tempDir,
        filename: 'upload-test.txt',
        buffer: Buffer.from(testContent),
      } as Express.Multer.File;

      const fileId = `file-${Date.now()}`;

      const result = await uploadFileToS3({
        req: mockReq,
        file: mockFile,
        file_id: fileId,
        basePath: TEST_BASE_PATH,
      });

      expect(result.filepath).toBeDefined();
      expect(result.filepath).toContain('X-Amz-Signature');
      expect(result.bytes).toBe(Buffer.byteLength(testContent));
    });

    it('throws error when user is not authenticated', async () => {
      const { uploadFileToS3 } = await import('~/storage/s3/crud');
      const mockReq = {} as ServerRequest;
      const mockFile = {
        path: '/fake/path.txt',
        originalname: 'test.txt',
      } as Express.Multer.File;

      await expect(
        uploadFileToS3({
          req: mockReq,
          file: mockFile,
          file_id: 'test-id',
          basePath: TEST_BASE_PATH,
        }),
      ).rejects.toThrow('User not authenticated');
    });
  });

  describe('getS3FileStream', () => {
    it('returns readable stream for existing file', async () => {
      const { saveBufferToS3, getS3FileStream } = await import('~/storage/s3/crud');
      const testContent = 'Stream test content';
      const buffer = Buffer.from(testContent);
      const fileName = `stream-test-${Date.now()}.txt`;

      const signedUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const mockReq = {
        user: { id: TEST_USER_ID },
      } as ServerRequest;

      const stream = await getS3FileStream(mockReq, signedUrl);

      expect(stream).toBeInstanceOf(Readable);

      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Uint8Array);
      }
      const downloadedContent = Buffer.concat(chunks).toString();
      expect(downloadedContent).toBe(testContent);
    });
  });

  describe('needsRefresh', () => {
    it('returns false for non-signed URLs', async () => {
      const { needsRefresh } = await import('~/storage/s3/crud');
      expect(needsRefresh('https://example.com/file.png', 3600)).toBe(false);
    });

    it('returns true for expired signed URLs', async () => {
      const { saveBufferToS3, needsRefresh } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('refresh test');
      const fileName = `refresh-test-${Date.now()}.txt`;

      const signedUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const result = needsRefresh(signedUrl, 999999);
      expect(result).toBe(true);
    });

    it('returns false for fresh signed URLs', async () => {
      const { saveBufferToS3, needsRefresh } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('fresh test');
      const fileName = `fresh-test-${Date.now()}.txt`;

      const signedUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const result = needsRefresh(signedUrl, 60);
      expect(result).toBe(false);
    });
  });

  describe('getNewS3URL', () => {
    it('generates signed URL from existing URL', async () => {
      const { saveBufferToS3, getNewS3URL } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('new url test');
      const fileName = `new-url-${Date.now()}.txt`;

      const originalUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const newUrl = await getNewS3URL(originalUrl);

      expect(newUrl).toBeDefined();
      expect(newUrl).toContain('X-Amz-Signature');
      expect(newUrl).toContain(fileName);
    });
  });

  describe('refreshS3Url', () => {
    it('returns original URL for non-S3 source', async () => {
      const { refreshS3Url } = await import('~/storage/s3/crud');
      const fileObj = {
        filepath: 'https://example.com/file.png',
        source: 'local',
      };

      const result = await refreshS3Url(fileObj, 3600);
      expect(result).toBe(fileObj.filepath);
    });

    it('refreshes URL for S3 source when needed', async () => {
      const { saveBufferToS3, refreshS3Url } = await import('~/storage/s3/crud');
      const buffer = Buffer.from('s3 refresh test');
      const fileName = `s3-refresh-${Date.now()}.txt`;

      const originalUrl = await saveBufferToS3({
        userId: TEST_USER_ID,
        buffer,
        fileName,
        basePath: TEST_BASE_PATH,
      });

      const fileObj = {
        filepath: originalUrl,
        source: 's3',
      };

      const newUrl = await refreshS3Url(fileObj, 999999);

      expect(newUrl).toBeDefined();
      expect(newUrl).toContain('X-Amz-Signature');
    });
  });

  describe('ImageService (S3 strategy)', () => {
    it('uploads avatar and returns URL', async () => {
      const { ImageService } = await import('~/storage/images');
      const { saveBufferToS3 } = await import('~/storage/s3/crud');

      const mockDeps = {
        resizeImageBuffer: jest.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          width: 100,
          height: 100,
        })),
        updateUser: jest.fn().mockResolvedValue(undefined),
        updateFile: jest.fn().mockResolvedValue(null),
      };

      const imageService = new ImageService(saveBufferToS3, mockDeps);

      const pngBuffer = MINIMAL_PNG;

      const result = await imageService.processAvatar({
        buffer: pngBuffer,
        userId: TEST_USER_ID,
        manual: 'false',
        basePath: TEST_BASE_PATH,
      });

      expect(result).toBeDefined();
      expect(result).toContain('X-Amz-Signature');
      expect(result).toContain('avatar');
    });

    it('updates user when manual is true', async () => {
      const { ImageService } = await import('~/storage/images');
      const { saveBufferToS3 } = await import('~/storage/s3/crud');

      const mockDeps = {
        resizeImageBuffer: jest.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          width: 100,
          height: 100,
        })),
        updateUser: jest.fn().mockResolvedValue(undefined),
        updateFile: jest.fn().mockResolvedValue(null),
      };

      const imageService = new ImageService(saveBufferToS3, mockDeps);

      const pngBuffer = MINIMAL_PNG;

      await imageService.processAvatar({
        buffer: pngBuffer,
        userId: TEST_USER_ID,
        manual: 'true',
        basePath: TEST_BASE_PATH,
      });

      expect(mockDeps.updateUser).toHaveBeenCalledWith(
        TEST_USER_ID,
        expect.objectContaining({ avatar: expect.any(String) }),
      );
    });

    it('does not update user when agentId is provided', async () => {
      const { ImageService } = await import('~/storage/images');
      const { saveBufferToS3 } = await import('~/storage/s3/crud');

      const mockDeps = {
        resizeImageBuffer: jest.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          width: 100,
          height: 100,
        })),
        updateUser: jest.fn().mockResolvedValue(undefined),
        updateFile: jest.fn().mockResolvedValue(null),
      };

      const imageService = new ImageService(saveBufferToS3, mockDeps);

      const pngBuffer = MINIMAL_PNG;

      await imageService.processAvatar({
        buffer: pngBuffer,
        userId: TEST_USER_ID,
        manual: 'true',
        agentId: 'agent-123',
        basePath: TEST_BASE_PATH,
      });

      expect(mockDeps.updateUser).not.toHaveBeenCalled();
    });

    it('returns tuple with resolved promise and filepath in prepareImageURL', async () => {
      const { ImageService } = await import('~/storage/images');
      const { saveBufferToS3 } = await import('~/storage/s3/crud');

      const mockDeps = {
        resizeImageBuffer: jest.fn().mockImplementation(async (buffer: Buffer) => ({
          buffer,
          width: 100,
          height: 100,
        })),
        updateUser: jest.fn().mockResolvedValue(undefined),
        updateFile: jest.fn().mockResolvedValue(null),
      };

      const imageService = new ImageService(saveBufferToS3, mockDeps);

      const testFile = {
        file_id: 'file-123',
        filepath: 'https://example.com/file.png',
      };

      const result = await imageService.prepareImageURL(testFile);

      expect(Array.isArray(result)).toBe(true);
      expect(result[1]).toBe(testFile.filepath);
      expect(mockDeps.updateFile).toHaveBeenCalledWith({ file_id: 'file-123' });
    });
  });
});
