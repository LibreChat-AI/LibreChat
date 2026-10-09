import fs from 'fs';
import sharp from 'sharp';
import type { ServerRequest } from '~/types';
import type { SaveBufferFn } from '~/storage/types';
import type { ImageServiceDeps } from '~/storage/images';
import { ImageService } from '~/storage/images';

jest.mock('fs', () => {
  const actualFs = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      readFile: jest.fn(),
      unlink: jest.fn(),
    },
  };
});

jest.mock('sharp', () => {
  const mockSharp = jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ format: 'png', width: 100, height: 100 }),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed')),
  }));
  return mockSharp;
});

describe('ImageService', () => {
  let mockSaveBuffer: jest.MockedFunction<SaveBufferFn>;
  let mockDeps: ImageServiceDeps;
  let service: ImageService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSaveBuffer = jest
      .fn()
      .mockResolvedValue('https://storage.example.com/images/user123/file.webp');

    mockDeps = {
      resizeImageBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from('resized'),
        width: 800,
        height: 600,
      }),
      updateUser: jest.fn().mockResolvedValue(undefined),
      updateFile: jest.fn().mockResolvedValue(null),
    };

    service = new ImageService(mockSaveBuffer, mockDeps);
  });

  describe('uploadImage', () => {
    const mockReq = {
      user: { id: 'user123' },
      config: { imageOutputType: 'webp' },
    };

    const mockFile = {
      path: '/tmp/upload-123.jpg',
      originalname: 'photo.jpg',
    } as Express.Multer.File;

    beforeEach(() => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from('original'));
      (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);
    });

    it('uploads and processes an image successfully', async () => {
      const result = await service.uploadImage({
        req: mockReq as ServerRequest,
        file: mockFile,
        file_id: 'file-456',
        endpoint: 'openAI',
      });

      expect(result).toEqual({
        filepath: 'https://storage.example.com/images/user123/file.webp',
        bytes: expect.any(Number),
        width: 800,
        height: 600,
      });

      expect(mockDeps.resizeImageBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'high', 'openAI');

      expect(mockSaveBuffer).toHaveBeenCalledWith({
        userId: 'user123',
        buffer: expect.any(Buffer),
        fileName: expect.stringContaining('file-456__'),
        basePath: 'images',
        tenantId: null,
      });

      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/upload-123.jpg');
    });

    it('throws error when user not authenticated', async () => {
      const reqNoUser = { config: {} };

      await expect(
        service.uploadImage({
          req: reqNoUser as ServerRequest,
          file: mockFile,
          file_id: 'file-456',
          endpoint: 'openAI',
        }),
      ).rejects.toThrow('User not authenticated');
    });

    it('skips format conversion when extension matches target', async () => {
      const webpFile = {
        path: '/tmp/upload-123.webp',
        originalname: 'photo.webp',
      } as Express.Multer.File;

      await service.uploadImage({
        req: mockReq as ServerRequest,
        file: webpFile,
        file_id: 'file-456',
        endpoint: 'openAI',
      });

      expect(sharp).not.toHaveBeenCalled();
    });

    it('uses custom resolution when provided', async () => {
      await service.uploadImage({
        req: mockReq as ServerRequest,
        file: mockFile,
        file_id: 'file-456',
        endpoint: 'openAI',
        resolution: 'low',
      });

      expect(mockDeps.resizeImageBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'low', 'openAI');
    });

    it('uses custom basePath when provided', async () => {
      await service.uploadImage({
        req: mockReq as ServerRequest,
        file: mockFile,
        file_id: 'file-456',
        endpoint: 'openAI',
        basePath: 'avatars',
      });

      expect(mockSaveBuffer).toHaveBeenCalledWith(expect.objectContaining({ basePath: 'avatars' }));
    });

    it('defaults to webp when imageOutputType not configured', async () => {
      const reqNoConfig = { user: { id: 'user123' }, config: {} };

      await service.uploadImage({
        req: reqNoConfig as ServerRequest,
        file: mockFile,
        file_id: 'file-456',
        endpoint: 'openAI',
      });

      expect(mockSaveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.stringContaining('.webp'),
        }),
      );
    });

    it('deletes temp file when readFile throws', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        service.uploadImage({
          req: mockReq as ServerRequest,
          file: mockFile,
          file_id: 'file-456',
          endpoint: 'openAI',
        }),
      ).rejects.toThrow('ENOENT');

      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/upload-123.jpg');
    });

    it('deletes temp file when resize throws', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from('raw'));
      (mockDeps.resizeImageBuffer as jest.Mock).mockRejectedValueOnce(new Error('Resize failed'));

      await expect(
        service.uploadImage({
          req: mockReq as ServerRequest,
          file: mockFile,
          file_id: 'file-456',
          endpoint: 'openAI',
        }),
      ).rejects.toThrow('Resize failed');

      expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/upload-123.jpg');
    });
  });

  describe('prepareImageURL', () => {
    it('updates file and returns the updated document alongside its filepath', async () => {
      const file = { file_id: 'file-123', filepath: 'https://example.com/image.webp' };

      const result = await service.prepareImageURL(file);

      expect(result).toEqual([null, 'https://example.com/image.webp']);
      expect(mockDeps.updateFile).toHaveBeenCalledWith({ file_id: 'file-123' });
    });

    it('returns the updated MongoFile as the first element when found', async () => {
      const mongoFile = { file_id: 'file-123', filepath: 'https://example.com/image.webp' };
      (mockDeps.updateFile as jest.Mock).mockResolvedValue(mongoFile);

      const file = { file_id: 'file-123', filepath: 'https://example.com/image.webp' };
      const result = await service.prepareImageURL(file);

      expect(result[0]).toEqual(mongoFile);
      expect(result[1]).toBe('https://example.com/image.webp');
    });
  });

  describe('processAvatar', () => {
    it('processes and uploads avatar for user', async () => {
      const buffer = Buffer.from('avatar-data');

      const result = await service.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'true',
      });

      expect(result).toBe('https://storage.example.com/images/user123/file.webp');
      expect(mockSaveBuffer).toHaveBeenCalledWith({
        userId: 'user123',
        buffer,
        fileName: expect.stringMatching(/^avatar-\d+\.png$/),
        basePath: 'avatars',
        tenantId: null,
      });
      expect(mockDeps.updateUser).toHaveBeenCalledWith('user123', {
        avatar: 'https://storage.example.com/images/user123/file.webp',
      });
    });

    it('does not update user when manual is false', async () => {
      const buffer = Buffer.from('avatar-data');

      await service.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'false',
      });

      expect(mockDeps.updateUser).not.toHaveBeenCalled();
    });

    it('creates agent avatar with correct filename and skips user update', async () => {
      const buffer = Buffer.from('avatar-data');

      await service.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'true',
        agentId: 'agent-456',
      });

      expect(mockSaveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.stringMatching(/^agent-agent-456-avatar-\d+\.png$/),
        }),
      );
      expect(mockDeps.updateUser).not.toHaveBeenCalled();
    });

    it('passes tenantId through for avatar storage', async () => {
      const buffer = Buffer.from('avatar-data');

      await service.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'false',
        tenantId: 'tenantA',
      });

      expect(mockSaveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'avatars',
          tenantId: 'tenantA',
        }),
      );
    });

    it('appends manual param when config.appendManualParam is true', async () => {
      const serviceWithManualParam = new ImageService(mockSaveBuffer, mockDeps, {
        appendManualParam: true,
      });

      const buffer = Buffer.from('avatar-data');

      const result = await serviceWithManualParam.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'true',
      });

      expect(result).toBe('https://storage.example.com/images/user123/file.webp?manual=true');
    });

    it('uses gif extension for animated images', async () => {
      (sharp as unknown as jest.Mock).mockImplementationOnce(() => ({
        metadata: jest.fn().mockResolvedValue({ format: 'gif' }),
      }));

      const buffer = Buffer.from('gif-data');

      await service.processAvatar({
        buffer,
        userId: 'user123',
        manual: 'false',
      });

      expect(mockSaveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.stringMatching(/\.gif$/),
        }),
      );
    });
  });
});
