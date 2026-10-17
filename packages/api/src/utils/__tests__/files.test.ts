import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { readFileAsString, readFileAsBuffer } from '../files';

jest.mock('fs');
jest.mock('fs/promises');

describe('File utilities', () => {
  const mockFilePath = '/test/file.txt';
  const smallContent = 'Hello, World!';
  const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB of 'x'

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readFileAsString', () => {
    it('should read small files directly without streaming', async () => {
      const fileSize = Buffer.byteLength(smallContent);

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });
      (readFile as jest.Mock).mockResolvedValue(smallContent);

      const result = await readFileAsString(mockFilePath);

      expect(result).toEqual({
        content: smallContent,
        bytes: fileSize,
      });
      expect(stat).toHaveBeenCalledWith(mockFilePath);
      expect(readFile).toHaveBeenCalledWith(mockFilePath, 'utf8');
      expect(createReadStream).not.toHaveBeenCalled();
    });

    it('should use provided fileSize to avoid stat call', async () => {
      const fileSize = Buffer.byteLength(smallContent);

      (readFile as jest.Mock).mockResolvedValue(smallContent);

      const result = await readFileAsString(mockFilePath, { fileSize });

      expect(result).toEqual({
        content: smallContent,
        bytes: fileSize,
      });
      expect(stat).not.toHaveBeenCalled();
      expect(readFile).toHaveBeenCalledWith(mockFilePath, 'utf8');
    });

    it('should stream large files', async () => {
      const fileSize = Buffer.byteLength(largeContent);

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });

      // Create a mock readable stream
      const chunks = [
        largeContent.substring(0, 5000000),
        largeContent.substring(5000000, 10000000),
        largeContent.substring(10000000),
      ];

      const mockStream = new Readable({
        read() {
          if (chunks.length > 0) {
            this.push(chunks.shift());
          } else {
            this.push(null); // End stream
          }
        },
      });

      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      const result = await readFileAsString(mockFilePath);

      expect(result).toEqual({
        content: largeContent,
        bytes: fileSize,
      });
      expect(stat).toHaveBeenCalledWith(mockFilePath);
      expect(createReadStream).toHaveBeenCalledWith(mockFilePath, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024,
      });
      expect(readFile).not.toHaveBeenCalled();
    });

    it('should use custom encoding', async () => {
      const fileSize = 100;

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });
      (readFile as jest.Mock).mockResolvedValue(smallContent);

      await readFileAsString(mockFilePath, { encoding: 'latin1' });

      expect(readFile).toHaveBeenCalledWith(mockFilePath, 'latin1');
    });

    it('should respect custom stream threshold', async () => {
      const customThreshold = 1024; // 1KB
      const fileSize = 2048; // 2KB

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });

      const mockStream = new Readable({
        read() {
          this.push('test content');
          this.push(null);
        },
      });

      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      await readFileAsString(mockFilePath, { streamThreshold: customThreshold });

      expect(createReadStream).toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    });

    it('should handle empty files', async () => {
      const fileSize = 0;

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });
      (readFile as jest.Mock).mockResolvedValue('');

      const result = await readFileAsString(mockFilePath);

      expect(result).toEqual({
        content: '',
        bytes: 0,
      });
    });

    it('should propagate read errors', async () => {
      const error = new Error('File not found');

      (stat as jest.Mock).mockResolvedValue({ size: 100 });
      (readFile as jest.Mock).mockRejectedValue(error);

      await expect(readFileAsString(mockFilePath)).rejects.toThrow('File not found');
    });

    it('should propagate stat errors when fileSize not provided', async () => {
      const error = new Error('Permission denied');

      (stat as jest.Mock).mockRejectedValue(error);

      await expect(readFileAsString(mockFilePath)).rejects.toThrow('Permission denied');
    });

    it('should propagate stream errors', async () => {
      const fileSize = 11 * 1024 * 1024; // 11MB

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });

      const mockStream = new Readable({
        read() {
          this.emit('error', new Error('Stream error'));
        },
      });

      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      await expect(readFileAsString(mockFilePath)).rejects.toThrow('Stream error');
    });
  });

  describe('readFileAsBuffer', () => {
    const smallBuffer = Buffer.from(smallContent);
    const largeBuffer = Buffer.from(largeContent);

    it('should read small files directly without streaming', async () => {
      const fileSize = smallBuffer.length;

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });
      (readFile as jest.Mock).mockResolvedValue(smallBuffer);

      const result = await readFileAsBuffer(mockFilePath);

      expect(result).toEqual({
        content: smallBuffer,
        bytes: fileSize,
      });
      expect(stat).toHaveBeenCalledWith(mockFilePath);
      expect(readFile).toHaveBeenCalledWith(mockFilePath);
      expect(createReadStream).not.toHaveBeenCalled();
    });

    it('should use provided fileSize to avoid stat call', async () => {
      const fileSize = smallBuffer.length;

      (readFile as jest.Mock).mockResolvedValue(smallBuffer);

      const result = await readFileAsBuffer(mockFilePath, { fileSize });

      expect(result).toEqual({
        content: smallBuffer,
        bytes: fileSize,
      });
      expect(stat).not.toHaveBeenCalled();
    });

    it('should stream large files', async () => {
      const fileSize = largeBuffer.length;

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });

      // Split large buffer into chunks
      const chunk1 = largeBuffer.slice(0, 5000000);
      const chunk2 = largeBuffer.slice(5000000, 10000000);
      const chunk3 = largeBuffer.slice(10000000);

      const chunks = [chunk1, chunk2, chunk3];

      const mockStream = new Readable({
        read() {
          if (chunks.length > 0) {
            this.push(chunks.shift());
          } else {
            this.push(null);
          }
        },
      });

      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      const result = await readFileAsBuffer(mockFilePath);

      expect(result.bytes).toBe(fileSize);
      expect(Buffer.compare(result.content, largeBuffer)).toBe(0);
      expect(createReadStream).toHaveBeenCalledWith(mockFilePath, {
        highWaterMark: 64 * 1024,
      });
      expect(readFile).not.toHaveBeenCalled();
    });

    it('should respect custom highWaterMark', async () => {
      const fileSize = 11 * 1024 * 1024; // 11MB
      const customHighWaterMark = 128 * 1024; // 128KB

      (stat as jest.Mock).mockResolvedValue({ size: fileSize });

      const mockStream = new Readable({
        read() {
          this.push(Buffer.from('test'));
          this.push(null);
        },
      });

      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      await readFileAsBuffer(mockFilePath, { highWaterMark: customHighWaterMark });

      expect(createReadStream).toHaveBeenCalledWith(mockFilePath, {
        highWaterMark: customHighWaterMark,
      });
    });

    it('should handle empty buffer files', async () => {
      const emptyBuffer = Buffer.alloc(0);

      (stat as jest.Mock).mockResolvedValue({ size: 0 });
      (readFile as jest.Mock).mockResolvedValue(emptyBuffer);

      const result = await readFileAsBuffer(mockFilePath);

      expect(result).toEqual({
        content: emptyBuffer,
        bytes: 0,
      });
    });

    it('should propagate errors', async () => {
      const error = new Error('Access denied');

      (stat as jest.Mock).mockResolvedValue({ size: 100 });
      (readFile as jest.Mock).mockRejectedValue(error);

      await expect(readFileAsBuffer(mockFilePath)).rejects.toThrow('Access denied');
    });
  });
});
