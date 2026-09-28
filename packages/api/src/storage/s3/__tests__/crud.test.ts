import fs from 'fs';
import { Readable } from 'stream';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import { FileSources } from 'librechat-data-provider';
import {
  S3Client,
  UploadPartCommand,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { TFile } from 'librechat-data-provider';
import type { S3FileRef } from '~/storage/types';
import type { ServerRequest } from '~/types';

const s3Mock = mockClient(S3Client);

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    stat: jest.fn(),
    unlink: jest.fn(),
  },
  createReadStream: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://bucket.s3.amazonaws.com/test-key?signed=true'),
}));

jest.mock('~/files', () => ({
  deleteRagFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { deleteRagFile } from '~/files';
import { logger } from '@librechat/data-schemas';

describe('S3 CRUD', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_BUCKET_NAME = 'test-bucket';
    process.env.S3_URL_EXPIRY_SECONDS = '120';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-123' });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"part-etag"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const stream = new Readable();
    stream.push('test content');
    stream.push(null);
    const sdkStream = sdkStreamMixin(stream);
    s3Mock.on(GetObjectCommand).resolves({ Body: sdkStream });

    jest.clearAllMocks();
  });

  describe('getS3Key', () => {
    it('constructs key from basePath, userId, and fileName', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key('images', 'user123', 'file.png');
      expect(key).toBe('images/user123/file.png');
    });

    it('keeps the legacy positional overload outside inline cookie namespaces', async () => {
      const { getS3Key } = await import('../crud');
      expect(getS3Key('images', 'user123', 'file.png', 'tenantA')).toBe(
        't/tenantA/images/user123/file.png',
      );
      expect(getS3Key('avatars', 'user123', 'avatar.png')).toBe('avatars/user123/avatar.png');
    });

    it('keeps object-form image and avatar keys outside inline cookie namespaces by default', async () => {
      const { getS3Key } = await import('../crud');
      expect(
        getS3Key({
          basePath: 'images',
          userId: 'user123',
          fileName: 'file.png',
        }),
      ).toBe('images/user123/file.png');
      expect(
        getS3Key({
          basePath: 'avatars',
          userId: 'user123',
          fileName: 'avatar.png',
        }),
      ).toBe('avatars/user123/avatar.png');
    });

    it('uses inline cookie namespaces only when explicitly requested', async () => {
      const { getS3Key } = await import('../crud');
      expect(
        getS3Key({
          basePath: 'images',
          userId: 'user123',
          fileName: 'file.png',
          useInlinePath: true,
        }),
      ).toBe('i/images/user123/file.png');
      expect(
        getS3Key({
          basePath: 'avatars',
          userId: 'user123',
          fileName: 'avatar.png',
          useInlinePath: true,
        }),
      ).toBe('a/avatars/user123/avatar.png');
    });

    it('handles nested file names', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key('files', 'user456', 'folder/subfolder/doc.pdf');
      expect(key).toBe('files/user456/folder/subfolder/doc.pdf');
    });

    it('constructs tenant-prefixed keys when tenantId is provided', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key('images', 'user123', 'file.png', 'tenantA');
      expect(key).toBe('t/tenantA/images/user123/file.png');
    });

    it('keeps region-prefixed image keys outside inline namespaces by default', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key({
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
      });
      expect(key).toBe('r/us-east-2/images/user123/file.png');
    });

    it('constructs region-prefixed inline image keys when requested', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key({
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
        useInlinePath: true,
      });
      expect(key).toBe('i/r/us-east-2/images/user123/file.png');
    });

    it('constructs region and tenant-prefixed keys together', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key({
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
        tenantId: 'tenantA',
        storageRegion: 'eu-central-1',
        includeRegionInPath: true,
        useInlinePath: true,
      });
      expect(key).toBe('i/r/eu-central-1/t/tenantA/images/user123/file.png');
    });

    it('constructs avatar-prefixed region keys under the avatar cookie namespace', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key({
        basePath: 'avatars',
        userId: 'user123',
        fileName: 'avatar.png',
        tenantId: 'tenantA',
        storageRegion: 'ap-southeast-1',
        includeRegionInPath: true,
        useInlinePath: true,
      });
      expect(key).toBe('a/r/ap-southeast-1/t/tenantA/avatars/user123/avatar.png');
    });

    it('keeps uploads outside the inline cookie namespaces when region pathing is enabled', async () => {
      const { getS3Key } = await import('../crud');
      const key = getS3Key({
        basePath: 'uploads',
        userId: 'user123',
        fileName: 'report.pdf',
        tenantId: 'tenantA',
        storageRegion: 'eu-central-1',
        includeRegionInPath: true,
      });
      expect(key).toBe('r/eu-central-1/t/tenantA/uploads/user123/report.pdf');
    });

    it('throws if storageRegion contains unsafe path characters', async () => {
      const { getS3Key } = await import('../crud');
      expect(() =>
        getS3Key({
          basePath: 'images',
          userId: 'user123',
          fileName: 'file.png',
          storageRegion: 'us/east/2',
          includeRegionInPath: true,
        }),
      ).toThrow('[getS3Key] storageRegion must not contain slashes: "us/east/2"');
    });

    it('throws if basePath contains a slash', async () => {
      const { getS3Key } = await import('../crud');
      expect(() => getS3Key('a/b', 'user123', 'file.png')).toThrow(
        '[getS3Key] basePath must not contain slashes: "a/b"',
      );
    });

    it('throws if tenantId contains path traversal characters', async () => {
      const { getS3Key } = await import('../crud');
      expect(() => getS3Key('images', 'user123', 'file.png', '../tenantB')).toThrow(
        '[getS3Key] tenantId must not contain slashes: "../tenantB"',
      );
    });

    it('throws if userId contains path traversal characters', async () => {
      const { getS3Key } = await import('../crud');
      expect(() => getS3Key('images', 'user/123', 'file.png')).toThrow(
        '[getS3Key] userId must not contain slashes: "user/123"',
      );
    });

    it('throws if fileName contains traversal or unsafe path characters', async () => {
      const { getS3Key } = await import('../crud');
      expect(() => getS3Key('images', 'user123', '../file.png')).toThrow(
        '[getS3Key] fileName must not contain path traversal: "../file.png"',
      );
      expect(() => getS3Key('images', 'user123', 'folder//file.png')).toThrow(
        '[getS3Key] fileName must not contain empty path components',
      );
      expect(() => getS3Key('images', 'user123', 'file\u0000.png')).toThrow(
        '[getS3Key] fileName contains unsafe path characters',
      );
    });
  });

  describe('parseS3Key', () => {
    it('parses legacy keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('images/user123/folder/file.png')).toEqual({
        useInlinePath: false,
        basePath: 'images',
        userId: 'user123',
        fileName: 'folder/file.png',
      });
    });

    it('parses tenant-prefixed keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('t/tenantA/images/user123/file.png')).toEqual({
        useInlinePath: false,
        tenantId: 'tenantA',
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
      });
    });

    it('round-trips legacy image and avatar keys without adding inline prefixes', async () => {
      const { getS3Key, parseS3Key } = await import('../crud');
      const imageKey = parseS3Key('images/user123/file.png');
      const avatarKey = parseS3Key('avatars/user123/avatar.png');

      expect(imageKey).not.toBeNull();
      expect(avatarKey).not.toBeNull();
      expect(getS3Key(imageKey!)).toBe('images/user123/file.png');
      expect(getS3Key(avatarKey!)).toBe('avatars/user123/avatar.png');
    });

    it('parses region-prefixed keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('i/r/us-east-2/images/user123/file.png')).toEqual({
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
        useInlinePath: true,
        inlinePathPrefix: 'i',
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
      });
    });

    it('parses non-region inline-prefixed keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('i/t/tenantA/images/user123/file.png')).toEqual({
        useInlinePath: true,
        inlinePathPrefix: 'i',
        tenantId: 'tenantA',
        basePath: 'images',
        userId: 'user123',
        fileName: 'file.png',
      });
      expect(parseS3Key('a/avatars/user123/avatar.png')).toEqual({
        useInlinePath: true,
        inlinePathPrefix: 'a',
        basePath: 'avatars',
        userId: 'user123',
        fileName: 'avatar.png',
      });
    });

    it('parses region-prefixed avatar keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('a/r/us-east-2/t/tenantA/avatars/user123/avatar.png')).toEqual({
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
        useInlinePath: true,
        inlinePathPrefix: 'a',
        tenantId: 'tenantA',
        basePath: 'avatars',
        userId: 'user123',
        fileName: 'avatar.png',
      });
    });

    it('parses region and tenant-prefixed keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('r/ap-southeast-1/t/tenantA/uploads/user123/report.pdf')).toEqual({
        storageRegion: 'ap-southeast-1',
        includeRegionInPath: true,
        useInlinePath: false,
        tenantId: 'tenantA',
        basePath: 'uploads',
        userId: 'user123',
        fileName: 'report.pdf',
      });
    });

    it('rejects malformed inline-prefixed keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('i/r/us-east-2/uploads/user123/file.pdf')).toBeNull();
      expect(parseS3Key('a/r/us-east-2/images/user123/file.png')).toBeNull();
      expect(parseS3Key('i/r/us-east-2/images/user123')).toBeNull();
    });

    it('returns null for incomplete keys', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('images/user123')).toBeNull();
      expect(parseS3Key('t/tenantA/images/user123')).toBeNull();
    });

    it('returns null for unsafe tenant or user segments', async () => {
      const { parseS3Key } = await import('../crud');
      expect(parseS3Key('t/../images/user123/file.png')).toBeNull();
      expect(parseS3Key('images/../file.png')).toBeNull();
      expect(parseS3Key('r/us\u0000east/images/user123/file.png')).toBeNull();
      expect(parseS3Key('r/us-east-2/images/user123/../file.png')).toBeNull();
    });
  });

  describe('saveBufferToS3', () => {
    it('uploads buffer and returns signed URL', async () => {
      const { saveBufferToS3 } = await import('../crud');
      const result = await saveBufferToS3({
        userId: 'user123',
        buffer: Buffer.from('test'),
        fileName: 'test.txt',
        basePath: 'files',
      });
      expect(result).toContain('signed=true');
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });

    it('calls PutObjectCommand with correct parameters', async () => {
      const { saveBufferToS3 } = await import('../crud');
      await saveBufferToS3({
        userId: 'user123',
        buffer: Buffer.from('test content'),
        fileName: 'document.pdf',
        basePath: 'documents',
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: 'documents/user123/document.pdf',
        Body: Buffer.from('test content'),
      });
    });

    it('uses tenant-prefixed key and URL params when tenantId is provided', async () => {
      const urlBuilder = jest.fn().mockResolvedValue('https://cdn.example.com/t/tenantA/file.txt');
      const { saveBufferToS3 } = await import('../crud');
      await saveBufferToS3({
        userId: 'user123',
        buffer: Buffer.from('test content'),
        fileName: 'document.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
        urlBuilder,
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('t/tenantA/documents/user123/document.pdf');
      expect(urlBuilder).toHaveBeenCalledWith({
        userId: 'user123',
        fileName: 'document.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
        storageRegion: null,
        includeRegionInPath: false,
        useInlinePath: undefined,
      });
    });

    it('uses region-prefixed key and URL params when region pathing is enabled', async () => {
      const urlBuilder = jest
        .fn()
        .mockResolvedValue('https://cdn.example.com/r/us-east-2/file.txt');
      const { saveBufferToS3 } = await import('../crud');
      await saveBufferToS3({
        userId: 'user123',
        buffer: Buffer.from('test content'),
        fileName: 'document.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
        urlBuilder,
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.Key).toBe(
        'r/us-east-2/t/tenantA/documents/user123/document.pdf',
      );
      expect(urlBuilder).toHaveBeenCalledWith({
        userId: 'user123',
        fileName: 'document.pdf',
        basePath: 'documents',
        tenantId: 'tenantA',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
        useInlinePath: undefined,
      });
    });

    it('uses default basePath if not provided', async () => {
      const { saveBufferToS3 } = await import('../crud');
      await saveBufferToS3({
        userId: 'user123',
        buffer: Buffer.from('test'),
        fileName: 'test.txt',
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('images/user123/test.txt');
    });

    it('handles S3 upload errors', async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error('S3 upload failed'));

      const { saveBufferToS3 } = await import('../crud');
      await expect(
        saveBufferToS3({
          userId: 'user123',
          buffer: Buffer.from('test'),
          fileName: 'test.txt',
        }),
      ).rejects.toThrow('S3 upload failed');

      expect(logger.error).toHaveBeenCalledWith(
        '[saveBufferToS3] Error uploading buffer to S3:',
        'S3 upload failed',
      );
    });
  });

  describe('getS3URL', () => {
    it('returns signed URL', async () => {
      const { getS3URL } = await import('../crud');
      const result = await getS3URL({
        userId: 'user123',
        fileName: 'test.txt',
        basePath: 'files',
      });
      expect(result).toContain('signed=true');
    });

    it('adds custom filename to Content-Disposition header', async () => {
      const { getS3URL } = await import('../crud');
      await getS3URL({
        userId: 'user123',
        fileName: 'test.pdf',
        customFilename: 'custom-name.pdf',
      });

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            ResponseContentDisposition: 'attachment; filename="custom-name.pdf"',
          }),
        }),
        expect.anything(),
      );
    });

    it('adds custom content type', async () => {
      const { getS3URL } = await import('../crud');
      await getS3URL({
        userId: 'user123',
        fileName: 'test.pdf',
        contentType: 'application/pdf',
      });

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            ResponseContentType: 'application/pdf',
          }),
        }),
        expect.anything(),
      );
    });

    it('handles errors when getting signed URL', async () => {
      (getSignedUrl as jest.Mock).mockRejectedValueOnce(new Error('Failed to sign URL'));

      const { getS3URL } = await import('../crud');
      await expect(
        getS3URL({
          userId: 'user123',
          fileName: 'file.pdf',
        }),
      ).rejects.toThrow('Failed to sign URL');

      expect(logger.error).toHaveBeenCalledWith(
        '[getS3URL] Error getting signed URL from S3:',
        'Failed to sign URL',
      );
    });
  });

  describe('saveURLToS3', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) =>
            ({
              'content-length': '8',
              'content-type': 'image/jpeg',
            })[name.toLowerCase()] ?? null,
        },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
      }) as unknown as typeof fetch;
    });

    it('fetches file from URL and returns the saved filepath', async () => {
      const { saveURLToS3 } = await import('../crud');
      const result = await saveURLToS3({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/image.jpg',
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(result).toBe('https://bucket.s3.amazonaws.com/test-key?signed=true');
    });

    it('fetches file from URL and returns metadata when requested', async () => {
      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/image.jpg',
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(result).toEqual({
        filepath: 'https://bucket.s3.amazonaws.com/test-key?signed=true',
        storageKey: 'images/user123/downloaded.jpg',
        bytes: 8,
        type: 'image/jpeg',
        dimensions: {},
      });
    });

    it('returns storage metadata for region-prefixed URL saves', async () => {
      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
        tenantId: 'tenantA',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
      });

      expect(result).toMatchObject({
        storageKey: 'r/us-east-2/t/tenantA/images/user123/downloaded.jpg',
        storageRegion: 'us-east-2',
      });
      expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key).toBe(
        'r/us-east-2/t/tenantA/images/user123/downloaded.jpg',
      );
    });

    it('uses the downloaded buffer size instead of a stale content-length header', async () => {
      (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            ({
              'content-length': '999',
              'content-type': 'image/jpeg',
            })[name.toLowerCase()] ?? null,
        },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
      });

      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(result.bytes).toBe(8);
    });

    it('streams response bodies into S3 when fetch provides a stream', async () => {
      const streamedBody = Buffer.from('streamed');
      const arrayBuffer = jest.fn();
      (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            ({
              'content-length': String(streamedBody.byteLength),
              'content-type': 'image/png',
            })[name.toLowerCase()] ?? null,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(streamedBody);
            controller.close();
          },
        }),
        arrayBuffer,
      });

      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        bytes: streamedBody.byteLength,
        type: 'image/png',
      });
      const putInput = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
      expect(putInput.Body).toBeInstanceOf(Buffer);
      expect(putInput.ContentLength).toBeUndefined();
      expect((putInput.Body as Buffer).toString()).toBe('streamed');
    });

    it('uses multipart upload for streamed responses larger than one part', async () => {
      const firstPart = Buffer.alloc(5 * 1024 * 1024, 'a');
      const finalPart = Buffer.from('tail');
      const uploadedParts: Buffer[] = [];
      (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            ({
              'content-length': String(firstPart.length + finalPart.length),
              'content-type': 'image/png',
            })[name.toLowerCase()] ?? null,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstPart);
            controller.enqueue(finalPart);
            controller.close();
          },
        }),
        arrayBuffer: jest.fn(),
      });
      s3Mock.on(UploadPartCommand).callsFake(async (input) => {
        uploadedParts.push(input.Body as Buffer);
        return { ETag: `"part-${input.PartNumber}"` };
      });

      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(result.bytes).toBe(firstPart.length + finalPart.length);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(2);
      expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
      expect(uploadedParts[0]).toEqual(firstPart);
      expect(uploadedParts[1]).toEqual(finalPart);
    });

    it('does not trust remote ContentLength for streamed uploads', async () => {
      (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) =>
            ({
              'content-length': '4',
              'content-type': 'image/png',
            })[name.toLowerCase()] ?? null,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('decoded'));
            controller.close();
          },
        }),
        arrayBuffer: jest.fn(),
      });

      const { saveURLToS3WithMetadata } = await import('../crud');
      const result = await saveURLToS3WithMetadata({
        userId: 'user123',
        URL: 'https://example.com/image.jpg',
        fileName: 'downloaded.jpg',
      });

      expect(result.bytes).toBe(Buffer.byteLength('decoded'));
      const putInput = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
      expect(putInput.ContentLength).toBeUndefined();
      expect(putInput.Body).toEqual(Buffer.from('decoded'));
    });

    it('throws error on non-ok response', async () => {
      (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
      });

      const { saveURLToS3 } = await import('../crud');
      await expect(
        saveURLToS3({
          userId: 'user123',
          URL: 'https://example.com/missing.jpg',
          fileName: 'missing.jpg',
        }),
      ).rejects.toThrow('Failed to fetch URL');
    });

    it('rejects non-http remote file URLs before fetching', async () => {
      const { saveURLToS3 } = await import('../crud');
      await expect(
        saveURLToS3({
          userId: 'user123',
          URL: 'file:///etc/passwd',
          fileName: 'passwd',
        }),
      ).rejects.toThrow('Refusing to fetch remote file over file:');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects remote responses larger than the configured cap', async () => {
      process.env.REMOTE_FILE_FETCH_MAX_BYTES = '4';
      try {
        (global.fetch as unknown as jest.Mock).mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (name: string) =>
              ({
                'content-length': '8',
                'content-type': 'image/jpeg',
              })[name.toLowerCase()] ?? null,
          },
          arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
        });

        const { saveURLToS3 } = await import('../crud');
        await expect(
          saveURLToS3({
            userId: 'user123',
            URL: 'https://example.com/image.jpg',
            fileName: 'downloaded.jpg',
          }),
        ).rejects.toThrow('Remote file response too large: 8 bytes');
      } finally {
        delete process.env.REMOTE_FILE_FETCH_MAX_BYTES;
      }
    });

    it('handles fetch errors', async () => {
      (global.fetch as unknown as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const { saveURLToS3 } = await import('../crud');
      await expect(
        saveURLToS3({
          userId: 'user123',
          URL: 'https://example.com/image.jpg',
          fileName: 'downloaded.jpg',
        }),
      ).rejects.toThrow('Network error');

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('deleteFileFromS3', () => {
    const mockReq = { user: { id: 'user123' } } as ServerRequest;

    it('deletes a file from S3', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      s3Mock.on(HeadObjectCommand).resolvesOnce({});

      const { deleteFileFromS3 } = await import('../crud');
      await deleteFileFromS3(mockReq, mockFile);

      expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user123', file: mockFile });
      expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    });

    it('uses the file owner for RAG cleanup when a different authorized user deletes', async () => {
      const requesterReq = { user: { id: 'sharedUser' } } as ServerRequest;
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      s3Mock.on(HeadObjectCommand).resolvesOnce({});

      const { deleteFileFromS3 } = await import('../crud');
      await deleteFileFromS3(requesterReq, mockFile);

      expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user123', file: mockFile });
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    });

    it('deletes a region-prefixed tenant file when owner and tenant match', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/r/us-east-2/t/tenantA/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
        tenantId: 'tenantA',
      } as TFile;

      s3Mock.on(HeadObjectCommand).resolvesOnce({});

      const { deleteFileFromS3 } = await import('../crud');
      await deleteFileFromS3(mockReq, mockFile);

      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
        'r/us-east-2/t/tenantA/images/user123/file.jpg',
      );
      expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user123', file: mockFile });
    });

    it('prefers storageKey when deleting legacy filepath records', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/legacy.jpg',
        storageKey: 'r/us-east-2/t/tenantA/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
        tenantId: 'tenantA',
      } as TFile;

      s3Mock.on(HeadObjectCommand).resolvesOnce({});

      const { deleteFileFromS3 } = await import('../crud');
      await deleteFileFromS3(mockReq, mockFile);

      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
        'r/us-east-2/t/tenantA/images/user123/file.jpg',
      );
    });

    it('handles file not found gracefully and cleans up RAG', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/nonexistent.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound' });

      const { deleteFileFromS3 } = await import('../crud');
      await deleteFileFromS3(mockReq, mockFile);

      expect(logger.warn).toHaveBeenCalled();
      expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user123', file: mockFile });
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });

    it('throws error if user ID does not match', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/different-user/file.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      const { deleteFileFromS3 } = await import('../crud');
      await expect(deleteFileFromS3(mockReq, mockFile)).rejects.toThrow('File owner mismatch');
      expect(logger.error).toHaveBeenCalled();
    });

    it('throws error if tenant ID does not match', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/t/tenantB/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
        tenantId: 'tenantA',
      } as TFile;

      const { deleteFileFromS3 } = await import('../crud');
      await expect(deleteFileFromS3(mockReq, mockFile)).rejects.toThrow('Tenant ID mismatch');
      expect(logger.error).toHaveBeenCalled();
    });

    it('handles NoSuchKey error and cleans up RAG', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      s3Mock.on(HeadObjectCommand).resolvesOnce({});
      const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      s3Mock.on(DeleteObjectCommand).rejects(noSuchKeyError);

      const { deleteFileFromS3 } = await import('../crud');
      await expect(deleteFileFromS3(mockReq, mockFile)).resolves.toBeUndefined();
      expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'user123', file: mockFile });
    });

    it('rejects tenant-prefixed keys when the file record lacks tenantId', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/t/tenantA/images/user123/file.jpg',
        file_id: 'file123',
        user: 'user123',
      } as TFile;

      const { deleteFileFromS3 } = await import('../crud');
      await expect(deleteFileFromS3(mockReq, mockFile)).rejects.toThrow('Tenant ID mismatch');
    });

    it('rejects file records without an owner', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/file.jpg',
        file_id: 'file123',
      } as TFile;

      const { deleteFileFromS3 } = await import('../crud');
      await expect(deleteFileFromS3(mockReq, mockFile)).rejects.toThrow('File record has no owner');
    });
  });

  describe('uploadFileToS3', () => {
    const mockReq = { user: { id: 'user123' } } as ServerRequest;

    it('uploads a file from disk to S3', async () => {
      const mockFile = {
        path: '/tmp/upload.jpg',
        originalname: 'photo.jpg',
      } as Express.Multer.File;

      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 1024 });
      (fs.createReadStream as jest.Mock).mockReturnValue(new Readable());

      const { uploadFileToS3 } = await import('../crud');
      const result = await uploadFileToS3({
        req: mockReq,
        file: mockFile,
        file_id: 'file123',
        basePath: 'images',
      });

      expect(result).toEqual({
        filepath: expect.stringContaining('signed=true'),
        storageKey: 'images/user123/file123__photo.jpg',
        bytes: 1024,
      });
      expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/upload.jpg');
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('uses tenantId from request when uploading a file', async () => {
      const mockReqWithTenant = {
        user: { id: 'user123', tenantId: 'tenantA' },
      } as ServerRequest;
      const mockFile = {
        path: '/tmp/upload.jpg',
        originalname: 'photo.jpg',
      } as Express.Multer.File;

      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 1024 });
      (fs.createReadStream as jest.Mock).mockReturnValue(new Readable());

      const { uploadFileToS3 } = await import('../crud');
      await uploadFileToS3({
        req: mockReqWithTenant,
        file: mockFile,
        file_id: 'file123',
        basePath: 'images',
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('t/tenantA/images/user123/file123__photo.jpg');
    });

    it('uses region-prefixed keys when uploading a file from disk', async () => {
      const mockFile = {
        path: '/tmp/upload.jpg',
        originalname: 'photo.jpg',
      } as Express.Multer.File;

      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 1024 });
      (fs.createReadStream as jest.Mock).mockReturnValue(new Readable());

      const { uploadFileToS3 } = await import('../crud');
      const result = await uploadFileToS3({
        req: mockReq,
        file: mockFile,
        file_id: 'file123',
        basePath: 'images',
        storageRegion: 'us-east-2',
        includeRegionInPath: true,
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('r/us-east-2/images/user123/file123__photo.jpg');
      expect(result).toMatchObject({
        storageKey: 'r/us-east-2/images/user123/file123__photo.jpg',
        storageRegion: 'us-east-2',
      });
    });

    it('handles upload errors and cleans up temp file', async () => {
      const mockFile = {
        path: '/tmp/upload.jpg',
        originalname: 'photo.jpg',
      } as Express.Multer.File;

      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 1024 });
      (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.createReadStream as jest.Mock).mockReturnValue(new Readable());
      s3Mock.on(PutObjectCommand).rejects(new Error('Upload failed'));

      const { uploadFileToS3 } = await import('../crud');
      await expect(
        uploadFileToS3({
          req: mockReq,
          file: mockFile,
          file_id: 'file123',
        }),
      ).rejects.toThrow('Upload failed');

      expect(logger.error).toHaveBeenCalledWith(
        '[uploadFileToS3] Error streaming file to S3:',
        expect.any(Error),
      );
      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/upload.jpg');
    });
  });

  describe('getS3FileStream', () => {
    it('returns a readable stream for a file', async () => {
      const { getS3FileStream } = await import('../crud');
      const result = await getS3FileStream(
        {} as ServerRequest,
        'https://bucket.s3.amazonaws.com/images/user123/file.pdf',
      );

      expect(result).toBeInstanceOf(Readable);
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    });

    it('requests the decoded key for a non-ASCII file name', async () => {
      const { getS3FileStream } = await import('../crud');
      await getS3FileStream(
        {} as ServerRequest,
        'https://test-bucket.s3.amazonaws.com/images/user123/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.pdf',
      );

      const [call] = s3Mock.commandCalls(GetObjectCommand);
      expect(call.args[0].input.Key).toBe(
        'images/user123/\u0414\u043e\u0433\u043e\u0432\u043e\u0440.pdf',
      );
    });

    it('streams by the recorded key even when the stored URL no longer parses', async () => {
      const { getS3FileStream } = await import('../crud');
      const { resolveDownloadPath } = await import('~/storage/path');
      const file = {
        filepath: 'not a url: presigned link expired and was overwritten',
        storageKey: 'uploads/user123/Ársreikningur 2025.pdf',
      };

      await getS3FileStream({} as ServerRequest, resolveDownloadPath(file));

      const [call] = s3Mock.commandCalls(GetObjectCommand);
      expect(call.args[0].input.Key).toBe(file.storageKey);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('handles errors when retrieving stream', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('Stream error'));

      const { getS3FileStream } = await import('../crud');
      await expect(getS3FileStream({} as ServerRequest, 'images/user123/file.pdf')).rejects.toThrow(
        'Stream error',
      );
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('getS3DownloadURL', () => {
    it('returns a signed URL for an existing file path', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/t/tenantA/uploads/user123/file.pdf',
        filename: 'file.pdf',
      } as TFile;

      const { getS3DownloadURL } = await import('../crud');
      const result = await getS3DownloadURL({
        req: {} as ServerRequest,
        file: mockFile,
        customFilename: 'download";\\bad.pdf',
        contentType: 'application/pdf',
      });

      expect(result).toContain('signed=true');
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 't/tenantA/uploads/user123/file.pdf',
            ResponseContentDisposition: 'attachment; filename="downloadbad.pdf"',
            ResponseContentType: 'application/pdf',
          }),
        }),
        expect.anything(),
      );
    });

    it('prefers storageKey when present', async () => {
      const mockFile = {
        filepath: 'https://bucket.s3.amazonaws.com/images/user123/legacy.pdf',
        storageKey: 'r/eu-central-1/t/tenantA/uploads/user123/file.pdf',
        filename: 'file.pdf',
      } as TFile;

      const { getS3DownloadURL } = await import('../crud');
      await getS3DownloadURL({
        req: {} as ServerRequest,
        file: mockFile,
      });

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'r/eu-central-1/t/tenantA/uploads/user123/file.pdf',
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe('needsRefresh', () => {
    it('returns false for non-signed URLs', async () => {
      const { needsRefresh } = await import('../crud');
      const result = needsRefresh('https://example.com/file.png', 3600);
      expect(result).toBe(false);
    });

    it('returns true when URL is expired', async () => {
      const { needsRefresh } = await import('../crud');
      const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const dateStr = pastDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const url = `https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=3600`;
      const result = needsRefresh(url, 3600);
      expect(result).toBe(true);
    });

    it('returns false when URL is not close to expiration', async () => {
      const { needsRefresh } = await import('../crud');
      const futureDate = new Date(Date.now() + 10 * 60 * 1000);
      const dateStr = futureDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const url = `https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=7200`;
      const result = needsRefresh(url, 60);
      expect(result).toBe(false);
    });

    it('returns true when missing expiration parameters', async () => {
      const { needsRefresh } = await import('../crud');
      const url = 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc';
      const result = needsRefresh(url, 3600);
      expect(result).toBe(true);
    });

    it('returns true for malformed URLs', async () => {
      const { needsRefresh } = await import('../crud');
      const result = needsRefresh('not-a-valid-url', 3600);
      expect(result).toBe(true);
    });
  });

  describe('getNewS3URL', () => {
    it('generates a new URL from an existing S3 URL', async () => {
      const { getNewS3URL } = await import('../crud');
      const result = await getNewS3URL(
        'https://bucket.s3.amazonaws.com/images/user123/file.jpg?signature=old',
      );

      expect(result).toContain('signed=true');
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'images/user123/file.jpg',
          }),
        }),
        expect.anything(),
      );
    });

    it('generates a new URL from a tenant-prefixed S3 URL', async () => {
      const { getNewS3URL } = await import('../crud');
      await getNewS3URL(
        'https://bucket.s3.amazonaws.com/t/tenantA/images/user123/file.jpg?signature=old',
      );

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 't/tenantA/images/user123/file.jpg',
          }),
        }),
        expect.anything(),
      );
    });

    it('returns undefined for invalid URLs', async () => {
      const { getNewS3URL } = await import('../crud');
      const result = await getNewS3URL('simple-file.txt');
      expect(result).toBeUndefined();
    });

    it('returns undefined when key has insufficient parts', async () => {
      const { getNewS3URL } = await import('../crud');
      // Key with only 2 parts (basePath/userId but no fileName)
      const result = await getNewS3URL('https://bucket.s3.amazonaws.com/images/user123');
      expect(result).toBeUndefined();
    });
  });

  describe('refreshS3FileUrls', () => {
    it('refreshes expired URLs for multiple files', async () => {
      const { refreshS3FileUrls } = await import('../crud');

      const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const dateStr = pastDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      const files = [
        {
          file_id: 'file1',
          source: FileSources.s3,
          filepath: `https://bucket.s3.amazonaws.com/images/user123/file1.jpg?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=60`,
        },
        {
          file_id: 'file2',
          source: FileSources.s3,
          filepath: `https://bucket.s3.amazonaws.com/images/user456/file2.jpg?X-Amz-Signature=def&X-Amz-Date=${dateStr}&X-Amz-Expires=60`,
        },
      ];

      const mockBatchUpdate = jest.fn().mockResolvedValue(undefined);

      const result = await refreshS3FileUrls(files as TFile[], mockBatchUpdate, 60);

      expect(result[0].filepath).toContain('signed=true');
      expect(result[1].filepath).toContain('signed=true');
      expect(getSignedUrl).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'images/user123/file1.jpg',
          }),
        }),
        expect.anything(),
      );
      expect(getSignedUrl).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            Key: 'images/user456/file2.jpg',
          }),
        }),
        expect.anything(),
      );
      expect(mockBatchUpdate).toHaveBeenCalledWith([
        {
          file_id: 'file1',
          filepath: expect.stringContaining('signed=true'),
          storageKey: 'images/user123/file1.jpg',
        },
        {
          file_id: 'file2',
          filepath: expect.stringContaining('signed=true'),
          storageKey: 'images/user456/file2.jpg',
        },
      ]);
    });

    it('skips non-S3 files', async () => {
      const { refreshS3FileUrls } = await import('../crud');

      const files = [
        {
          file_id: 'file1',
          source: 'local',
          filepath: '/local/path/file.jpg',
        },
      ];

      const mockBatchUpdate = jest.fn();

      const result = await refreshS3FileUrls(files as TFile[], mockBatchUpdate);

      expect(result).toEqual(files);
      expect(mockBatchUpdate).not.toHaveBeenCalled();
    });

    it('handles empty or invalid input', async () => {
      const { refreshS3FileUrls } = await import('../crud');
      const mockBatchUpdate = jest.fn();

      const result1 = await refreshS3FileUrls(null, mockBatchUpdate);
      expect(result1).toEqual([]);

      const result2 = await refreshS3FileUrls(undefined, mockBatchUpdate);
      expect(result2).toEqual([]);

      const result3 = await refreshS3FileUrls([], mockBatchUpdate);
      expect(result3).toEqual([]);

      expect(mockBatchUpdate).not.toHaveBeenCalled();
    });
  });

  describe('refreshS3Url', () => {
    it('refreshes an expired S3 URL', async () => {
      const { refreshS3Url } = await import('../crud');

      const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const dateStr = pastDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      const fileObj: S3FileRef = {
        source: FileSources.s3,
        filepath: `https://bucket.s3.amazonaws.com/images/user123/file.jpg?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=60`,
      };

      const result = await refreshS3Url(fileObj, 60);

      expect(result).toContain('signed=true');
    });

    it('returns original URL if not expired', async () => {
      const { refreshS3Url } = await import('../crud');

      const fileObj: S3FileRef = {
        source: FileSources.s3,
        filepath: 'https://example.com/proxy/file.jpg',
      };

      const result = await refreshS3Url(fileObj, 3600);

      expect(result).toBe(fileObj.filepath);
    });

    it('returns empty string for null input', async () => {
      const { refreshS3Url } = await import('../crud');
      const result = await refreshS3Url(null as unknown as S3FileRef);
      expect(result).toBe('');
    });

    it('returns original URL for non-S3 files', async () => {
      const { refreshS3Url } = await import('../crud');

      const fileObj: S3FileRef = {
        source: 'local',
        filepath: '/local/path/file.jpg',
      };

      const result = await refreshS3Url(fileObj);

      expect(result).toBe(fileObj.filepath);
    });

    it('handles errors and returns original URL', async () => {
      (getSignedUrl as jest.Mock).mockRejectedValueOnce(new Error('Refresh failed'));

      const { refreshS3Url } = await import('../crud');

      const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const dateStr = pastDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

      const fileObj: S3FileRef = {
        source: FileSources.s3,
        filepath: `https://bucket.s3.amazonaws.com/images/user123/file.jpg?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=60`,
      };

      const result = await refreshS3Url(fileObj, 60);

      expect(result).toBe(fileObj.filepath);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('extractKeyFromS3Url', () => {
    it('extracts key from virtual-hosted-style URL', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('https://bucket.s3.amazonaws.com/images/user123/file.png');
      expect(key).toBe('images/user123/file.png');
    });

    it('returns key as-is when not a URL', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('images/user123/file.png');
      expect(key).toBe('images/user123/file.png');
    });

    it('throws on empty input', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      expect(() => extractKeyFromS3Url('')).toThrow('Invalid input: URL or key is empty');
    });

    it('handles URL with query parameters', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const signedUrl =
        'https://bucket.s3.amazonaws.com/images/user123/file.png?X-Amz-Signature=abc';
      const key = extractKeyFromS3Url(signedUrl);
      expect(key).toBe('images/user123/file.png');
      expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain(signedUrl);
      expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain(key);
    });

    it('decodes percent-encoded keys from virtual-hosted-style URLs', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://bucket.s3.amazonaws.com/uploads/user123/abc__%C3%81rsreikningur_2025.pdf',
      );
      expect(key).toBe('uploads/user123/abc__Ársreikningur_2025.pdf');
    });

    it('decodes percent-encoded keys from path-style URLs', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://s3.us-west-2.amazonaws.com/test-bucket/uploads/user123/%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf',
      );
      expect(key).toBe('uploads/user123/日本語.pdf');
    });

    it('preserves a literal percent in a filename (round-trip through %25)', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('https://bucket.s3.amazonaws.com/uploads/100%25_done.pdf');
      expect(key).toBe('uploads/100%_done.pdf');
    });

    it('returns a raw key untouched even when it contains a percent sign', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = 'uploads/user123/100%_done.pdf';
      expect(extractKeyFromS3Url(key)).toBe(key);
    });

    it('falls back to the raw value on a malformed escape sequence', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('https://bucket.s3.amazonaws.com/uploads/bad%E0%A4A.pdf');
      expect(key).toBe('uploads/bad%E0%A4A.pdf');
    });

    it('extracts key from path-style regional endpoint', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://s3.us-west-2.amazonaws.com/test-bucket/dogs/puppy.jpg',
      );
      expect(key).toBe('dogs/puppy.jpg');
    });

    it('extracts key from virtual-hosted regional endpoint', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://test-bucket.s3.us-west-2.amazonaws.com/dogs/puppy.png',
      );
      expect(key).toBe('dogs/puppy.png');
    });

    it('extracts key from legacy s3-region format', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://test-bucket.s3-us-west-2.amazonaws.com/cats/kitten.png',
      );
      expect(key).toBe('cats/kitten.png');
    });

    it('extracts key from legacy global endpoint', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('https://test-bucket.s3.amazonaws.com/dogs/puppy.png');
      expect(key).toBe('dogs/puppy.png');
    });

    it('handles key with leading slash by removing it', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('/images/user123/file.jpg');
      expect(key).toBe('images/user123/file.jpg');
    });

    it('handles simple key without slashes', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('simple-file.txt');
      expect(key).toBe('simple-file.txt');
    });

    it('handles key with only two parts', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('folder/file.txt');
      expect(key).toBe('folder/file.txt');
    });

    it('decodes URLs with encoded characters back to the stored key', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://bucket.s3.amazonaws.com/test-bucket/images/user123/my%20file%20name.jpg',
      );
      /** The object was stored under `my file name.jpg`; `%20` is URL transport, not part of the key. */
      expect(key).toBe('images/user123/my file name.jpg');
    });

    it('handles deep nested paths', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://bucket.s3.amazonaws.com/test-bucket/a/b/c/d/e/f/file.jpg',
      );
      expect(key).toBe('a/b/c/d/e/f/file.jpg');
    });

    it('returns empty string for URL with only bucket (no key)', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url('https://s3.us-west-2.amazonaws.com/my-bucket');
      expect(key).toBe('');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('handles malformed URL and returns input', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const malformedUrl = 'https://invalid url with spaces.com/key';
      const result = extractKeyFromS3Url(malformedUrl);

      expect(logger.error).toHaveBeenCalled();
      expect(result).toBe(malformedUrl);
    });

    it('decodes a signed path-style custom endpoint URL for a legacy record', async () => {
      const { extractKeyFromS3Url } = await import('../crud');
      const key = extractKeyFromS3Url(
        'https://minio.example.com/test-bucket/images/user123/my%20file.jpg?X-Amz-Credential=secret&X-Amz-Signature=signed',
      );
      expect(key).toBe('images/user123/my file.jpg');
    });
  });

  describe('needsRefresh with S3_REFRESH_EXPIRY_MS set', () => {
    beforeEach(() => {
      process.env.S3_REFRESH_EXPIRY_MS = '60000'; // 1 minute
      jest.resetModules();
    });

    afterEach(() => {
      delete process.env.S3_REFRESH_EXPIRY_MS;
    });

    it('returns true when URL age exceeds S3_REFRESH_EXPIRY_MS', async () => {
      const { needsRefresh } = await import('../crud');
      // URL created 2 minutes ago
      const oldDate = new Date(Date.now() - 2 * 60 * 1000);
      const dateStr = oldDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const url = `https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=3600`;

      const result = needsRefresh(url, 60);
      expect(result).toBe(true);
    });

    it('returns false when URL age is under S3_REFRESH_EXPIRY_MS', async () => {
      const { needsRefresh } = await import('../crud');
      // URL created 30 seconds ago
      const recentDate = new Date(Date.now() - 30 * 1000);
      const dateStr = recentDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      const url = `https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc&X-Amz-Date=${dateStr}&X-Amz-Expires=3600`;

      const result = needsRefresh(url, 60);
      expect(result).toBe(false);
    });
  });
});
