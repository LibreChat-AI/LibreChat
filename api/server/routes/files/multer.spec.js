/* eslint-disable no-unused-vars */
/* eslint-disable jest/no-done-callback */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const express = require('express');
const request = require('supertest');
const { ErrorController } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  createMulterInstance,
  createStorage,
  storage,
  importFileFilter,
  createFileFilter,
} = require('./multer');

// Mock only the config service that requires external dependencies
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

describe('Multer Configuration', () => {
  let tempDir;
  let mockReq;
  let mockFile;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multer-test-'));

    mockReq = {
      user: { id: 'test-user-123' },
      body: {},
      originalUrl: '/api/files/upload',
      config: {
        paths: {
          uploads: tempDir,
        },
      },
    };

    mockFile = {
      originalname: 'test-file.jpg',
      mimetype: 'image/jpeg',
      size: 1024,
    };

    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Storage Configuration', () => {
    describe('destination function', () => {
      it('should create the correct destination path', (done) => {
        const cb = jest.fn((err, destination) => {
          expect(err).toBeNull();
          expect(destination).toBe(path.join(tempDir, 'temp', 'test-user-123'));
          expect(fs.existsSync(destination)).toBe(true);
          done();
        });

        storage.getDestination(mockReq, mockFile, cb);
      });

      it("should create directory recursively if it doesn't exist", (done) => {
        const deepPath = path.join(tempDir, 'deep', 'nested', 'path');
        mockReq.config.paths.uploads = deepPath;

        const cb = jest.fn((err, destination) => {
          expect(err).toBeNull();
          expect(destination).toBe(path.join(deepPath, 'temp', 'test-user-123'));
          expect(fs.existsSync(destination)).toBe(true);
          done();
        });

        storage.getDestination(mockReq, mockFile, cb);
      });
    });

    describe('filename function', () => {
      it('uses the request file ID to make management staging paths unique', (done) => {
        const uniqueStorage = createStorage({ uniqueTempPath: true });

        uniqueStorage.getFilename(mockReq, mockFile, (err, filename) => {
          expect(err).toBeNull();
          expect(filename).toBe(`${mockReq.file_id}-test-file.jpg`);
          done();
        });
      });

      it('should generate a UUID for req.file_id', (done) => {
        const cb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          expect(mockReq.file_id).toBeDefined();
          expect(mockReq.file_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          );
          done();
        });

        storage.getFilename(mockReq, mockFile, cb);
      });

      it('should decode URI components in filename', (done) => {
        const encodedFile = {
          ...mockFile,
          originalname: encodeURIComponent('test file with spaces.jpg'),
        };

        const cb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          expect(encodedFile.originalname).toBe('test file with spaces.jpg');
          done();
        });

        storage.getFilename(mockReq, encodedFile, cb);
      });

      it('returns a controlled error for malformed URI encoding', (done) => {
        const malformedFile = { ...mockFile, originalname: '%.json' };

        storage.getFilename(mockReq, malformedFile, (err, filename) => {
          expect(err).toMatchObject({
            statusCode: 400,
            body: { message: 'Invalid filename encoding' },
          });
          expect(filename).toBeUndefined();
          done();
        });
      });

      it('should call real sanitizeFilename with properly encoded filename', (done) => {
        // Test with a properly URI-encoded filename that needs sanitization
        const unsafeFile = {
          ...mockFile,
          originalname: encodeURIComponent('test@#$%^&*()file with spaces!.jpg'),
        };

        const cb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          // The actual sanitizeFilename should have cleaned this up after decoding
          expect(filename).not.toContain('@');
          expect(filename).not.toContain('#');
          expect(filename).not.toContain('*');
          expect(filename).not.toContain('!');
          // Should still preserve dots and hyphens
          expect(filename).toContain('.jpg');
          done();
        });

        storage.getFilename(mockReq, unsafeFile, cb);
      });

      it('should handle very long filenames with actual crypto', (done) => {
        const longFile = {
          ...mockFile,
          originalname: 'a'.repeat(300) + '.jpg',
        };

        const cb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          expect(filename.length).toBeLessThanOrEqual(255);
          expect(filename).toMatch(/\.jpg$/); // Should still end with .jpg
          // Should contain a hex suffix if truncated
          if (filename.length === 255) {
            expect(filename).toMatch(/-[a-f0-9]{6}\.jpg$/);
          }
          done();
        });

        storage.getFilename(mockReq, longFile, cb);
      });

      it('should generate unique file_id for each call', (done) => {
        let firstFileId;

        const firstCb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          firstFileId = mockReq.file_id;

          // Reset req for second call
          delete mockReq.file_id;

          const secondCb = jest.fn((err, filename) => {
            expect(err).toBeNull();
            expect(mockReq.file_id).toBeDefined();
            expect(mockReq.file_id).not.toBe(firstFileId);
            done();
          });

          storage.getFilename(mockReq, mockFile, secondCb);
        });

        storage.getFilename(mockReq, mockFile, firstCb);
      });
    });
  });

  describe('Import File Filter', () => {
    it('should accept JSON files by mimetype', (done) => {
      const jsonFile = {
        ...mockFile,
        mimetype: 'application/json',
        originalname: 'data.json',
      };

      const cb = jest.fn((err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });

      importFileFilter(mockReq, jsonFile, cb);
    });

    it('should accept files with .json extension', (done) => {
      const jsonFile = {
        ...mockFile,
        mimetype: 'text/plain',
        originalname: 'data.json',
      };

      const cb = jest.fn((err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });

      importFileFilter(mockReq, jsonFile, cb);
    });

    it('should reject non-JSON files', (done) => {
      const textFile = {
        ...mockFile,
        mimetype: 'text/plain',
        originalname: 'document.txt',
      };

      const cb = jest.fn((err, result) => {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Only JSON files are allowed');
        expect(err.statusCode).toBe(415);
        expect(err.body).toEqual({ message: 'Only JSON files are allowed' });
        expect(result).toBe(false);
        done();
      });

      importFileFilter(mockReq, textFile, cb);
    });

    it('should handle files with uppercase .JSON extension', (done) => {
      const jsonFile = {
        ...mockFile,
        mimetype: 'text/plain',
        originalname: 'DATA.JSON',
      };

      const cb = jest.fn((err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });

      importFileFilter(mockReq, jsonFile, cb);
    });
  });

  describe('File Filter with Real defaultFileConfig', () => {
    it('should use real fileConfig.checkType for validation', async () => {
      // Test with actual librechat-data-provider functions
      const {
        fileConfig,
        imageMimeTypes,
        applicationMimeTypes,
      } = require('librechat-data-provider');

      // Test that the real checkType function works with regex patterns
      expect(fileConfig.checkType('image/jpeg', [imageMimeTypes])).toBe(true);
      expect(fileConfig.checkType('video/mp4', [imageMimeTypes])).toBe(false);
      expect(fileConfig.checkType('application/pdf', [applicationMimeTypes])).toBe(true);
      expect(fileConfig.checkType('application/pdf', [])).toBe(false);
    });

    it('should handle audio files for speech-to-text endpoint with real config', async () => {
      mockReq.originalUrl = '/api/speech/stt';

      const multerInstance = await createMulterInstance();
      expect(multerInstance).toBeDefined();
      expect(typeof multerInstance.single).toBe('function');
    });

    it('should reject unsupported file types using real config', async () => {
      // Mock defaultFileConfig for this specific test
      const originalCheckType = require('librechat-data-provider').fileConfig.checkType;
      const mockCheckType = jest.fn().mockReturnValue(false);
      require('librechat-data-provider').fileConfig.checkType = mockCheckType;

      try {
        const multerInstance = await createMulterInstance();
        expect(multerInstance).toBeDefined();

        // Test the actual file filter behavior would reject unsupported files
        expect(mockCheckType).toBeDefined();
      } finally {
        // Restore original function
        require('librechat-data-provider').fileConfig.checkType = originalCheckType;
      }
    });

    it('should infer ZIP MIME type when multipart upload omits it', (done) => {
      const { mergeFileConfig } = require('librechat-data-provider');
      const fileFilter = createFileFilter(mergeFileConfig());
      const zipFile = {
        ...mockFile,
        originalname: 'archive.zip',
        mimetype: '',
      };

      const cb = jest.fn((err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        expect(zipFile.mimetype).toBe('application/zip');
        done();
      });

      fileFilter(mockReq, zipFile, cb);
    });

    it('uses a server-selected endpoint before multipart fields are parsed', (done) => {
      const { mergeFileConfig } = require('librechat-data-provider');
      const fileFilter = createFileFilter(
        mergeFileConfig({
          endpoints: {
            agents: { supportedMimeTypes: ['text/plain'] },
            default: { supportedMimeTypes: ['application/pdf'] },
          },
        }),
        () => ({ endpoint: 'agents' }),
      );
      const textFile = {
        ...mockFile,
        originalname: 'notes.txt',
        mimetype: 'text/plain',
      };

      fileFilter({ ...mockReq, body: {} }, textFile, (err, result) => {
        expect(err).toBeNull();
        expect(result).toBe(true);
        done();
      });
    });

    it.each(['application/x-shellscript', 'text/x-shellscript'])(
      'should normalize %s to application/x-sh and accept the upload',
      (reportedType) => {
        const { mergeFileConfig } = require('librechat-data-provider');
        const fileFilter = createFileFilter(mergeFileConfig());
        const shellFile = {
          ...mockFile,
          originalname: 'script.sh',
          mimetype: reportedType,
        };

        const cb = jest.fn();
        fileFilter(mockReq, shellFile, cb);

        expect(cb).toHaveBeenCalledWith(null, true);
        expect(shellFile.mimetype).toBe('application/x-sh');
      },
    );

    /** Normalization runs before the allowlist check, so an admin who applied one of the documented
     *  `.sh` workarounds must not be broken by it. Both recipes target `application/x-sh`, which is
     *  exactly what the alias now produces. */
    it.each([
      ['the canonical type (#4660, #5689, #6297)', ['application/x-sh']],
      ['broad patterns (#14804)', ['image/.*', 'text/.*', 'application/.*']],
    ])(
      'should keep accepting .sh for an existing workaround config allowing %s',
      (_label, supportedMimeTypes) => {
        const { mergeFileConfig } = require('librechat-data-provider');
        const fileFilter = createFileFilter(
          mergeFileConfig({ endpoints: { agents: { supportedMimeTypes } } }),
        );
        mockReq.body.endpoint = 'agents';
        const shellFile = {
          ...mockFile,
          originalname: 'script.sh',
          mimetype: 'application/x-shellscript',
        };

        const cb = jest.fn();
        fileFilter(mockReq, shellFile, cb);

        expect(cb).toHaveBeenCalledWith(null, true);
      },
    );

    it('should reject an unsupported type with a 415 the client can surface', () => {
      const { mergeFileConfig } = require('librechat-data-provider');
      const fileFilter = createFileFilter(mergeFileConfig());
      const binaryFile = {
        ...mockFile,
        originalname: 'program.exe',
        mimetype: 'application/x-msdownload',
      };

      const cb = jest.fn();
      fileFilter(mockReq, binaryFile, cb);

      expect(cb).toHaveBeenCalledTimes(1);
      const [error, result] = cb.mock.calls[0];
      expect(result).toBe(false);
      expect(error).toBeInstanceOf(Error);
      expect(error.statusCode).toBe(415);
      expect(error.body).toEqual({ message: 'Unsupported file type: application/x-msdownload' });
    });

    it('should use real mergeFileConfig function', async () => {
      const { mergeFileConfig, mbToBytes } = require('librechat-data-provider');

      // Test with actual merge function - note that it converts MB to bytes
      const testConfig = {
        serverFileSizeLimit: 5, // 5 MB
        endpoints: {
          custom: {
            supportedMimeTypes: ['text/plain'],
          },
        },
      };

      const result = mergeFileConfig(testConfig);

      // The function converts MB to bytes, so 5 MB becomes 5 * 1024 * 1024 bytes
      expect(result.serverFileSizeLimit).toBe(mbToBytes(5));
      expect(result.endpoints.custom.supportedMimeTypes).toBeDefined();
      // Should still have the default endpoints
      expect(result.endpoints.default).toBeDefined();
    });
  });

  describe('createMulterInstance with Real Functions', () => {
    it('should create a multer instance with correct configuration', async () => {
      const multerInstance = await createMulterInstance();

      expect(multerInstance).toBeDefined();
      expect(typeof multerInstance.single).toBe('function');
      expect(typeof multerInstance.array).toBe('function');
      expect(typeof multerInstance.fields).toBe('function');
    });

    it('should use real config merging', async () => {
      const { getAppConfig } = require('~/server/services/Config');

      const multerInstance = await createMulterInstance();

      expect(getAppConfig).toHaveBeenCalled();
      expect(multerInstance).toBeDefined();
    });

    it('should create multer instance with expected interface', async () => {
      const multerInstance = await createMulterInstance();

      expect(multerInstance).toBeDefined();
      expect(typeof multerInstance.single).toBe('function');
      expect(typeof multerInstance.array).toBe('function');
      expect(typeof multerInstance.fields).toBe('function');
    });
  });

  describe('Real Crypto Integration', () => {
    it('should use actual crypto.randomUUID()', (done) => {
      // Spy on crypto.randomUUID to ensure it's called
      const uuidSpy = jest.spyOn(crypto, 'randomUUID');

      const cb = jest.fn((err, filename) => {
        expect(err).toBeNull();
        expect(uuidSpy).toHaveBeenCalled();
        expect(mockReq.file_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        uuidSpy.mockRestore();
        done();
      });

      storage.getFilename(mockReq, mockFile, cb);
    });

    it('should generate different UUIDs on subsequent calls', (done) => {
      const uuids = [];
      let callCount = 0;
      const totalCalls = 5;

      const cb = jest.fn((err, filename) => {
        expect(err).toBeNull();
        uuids.push(mockReq.file_id);
        callCount++;

        if (callCount === totalCalls) {
          // Check that all UUIDs are unique
          const uniqueUuids = new Set(uuids);
          expect(uniqueUuids.size).toBe(totalCalls);
          done();
        } else {
          // Reset for next call
          delete mockReq.file_id;
          storage.getFilename(mockReq, mockFile, cb);
        }
      });

      // Start the chain
      storage.getFilename(mockReq, mockFile, cb);
    });

    it('should generate cryptographically secure UUIDs', (done) => {
      const generatedUuids = new Set();
      let callCount = 0;
      const totalCalls = 10;

      const cb = jest.fn((err, filename) => {
        expect(err).toBeNull();

        // Verify UUID format and uniqueness
        expect(mockReq.file_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );

        generatedUuids.add(mockReq.file_id);
        callCount++;

        if (callCount === totalCalls) {
          // All UUIDs should be unique
          expect(generatedUuids.size).toBe(totalCalls);
          done();
        } else {
          // Reset for next call
          delete mockReq.file_id;
          storage.getFilename(mockReq, mockFile, cb);
        }
      });

      // Start the chain
      storage.getFilename(mockReq, mockFile, cb);
    });
  });

  describe('Error Handling', () => {
    it('should handle CVE-2024-28870: empty field name DoS vulnerability', async () => {
      // Test for the CVE where empty field name could cause unhandled exception
      const multerInstance = await createMulterInstance();

      // Create a mock request with empty field name (the vulnerability scenario)
      const mockReqWithEmptyField = {
        ...mockReq,
        headers: {
          'content-type': 'multipart/form-data',
        },
      };

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        end: jest.fn(),
      };

      // This should not crash or throw unhandled exceptions
      const uploadMiddleware = multerInstance.single(''); // Empty field name

      const mockNext = jest.fn((err) => {
        // If there's an error, it should be handled gracefully, not crash
        if (err) {
          expect(err).toBeInstanceOf(Error);
          // The error should be handled, not crash the process
        }
      });

      // This should complete without crashing the process
      expect(() => {
        uploadMiddleware(mockReqWithEmptyField, mockRes, mockNext);
      }).not.toThrow();
    });

    it('should report file system errors through the storage callback', (done) => {
      const loggerError = jest.spyOn(logger, 'error').mockImplementation();
      const filesystemError = new Error('permission denied');
      const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
        throw filesystemError;
      });

      storage.getDestination(mockReq, mockFile, (err, destination) => {
        expect(err).toMatchObject({
          statusCode: 500,
          body: { message: 'Failed to prepare upload directory' },
          cause: filesystemError,
        });
        expect(destination).toBeUndefined();
        expect(loggerError).toHaveBeenCalledWith(
          'Failed to prepare upload directory: permission denied',
        );
        mkdir.mockRestore();
        loggerError.mockRestore();
        done();
      });
    });

    it('keeps the upload server alive after rejecting a malformed filename', async () => {
      const app = express();
      const upload = multer({ storage });
      app.use((req, res, next) => {
        req.user = mockReq.user;
        req.config = mockReq.config;
        next();
      });
      app.post('/upload', upload.single('file'), (req, res) => {
        res.status(201).json({
          originalname: req.file.originalname,
          filename: req.file.filename,
        });
      });
      app.use(ErrorController);

      const malformed = await request(app).post('/upload').attach('file', Buffer.from('{}'), {
        filename: '%.json',
        contentType: 'application/json',
      });

      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ message: 'Invalid filename encoding' });
      const outputPath = path.join(tempDir, 'temp', 'test-user-123');
      expect(fs.readdirSync(outputPath)).toEqual([]);

      const healthy = await request(app).post('/upload').attach('file', Buffer.from('{}'), {
        filename: 'healthy%20upload.json',
        contentType: 'application/json',
      });

      expect(healthy.status).toBe(201);
      expect(healthy.body.originalname).toBe('healthy upload.json');
      expect(fs.existsSync(path.join(outputPath, healthy.body.filename))).toBe(true);
    });

    it('should handle malformed filenames with real sanitization', (done) => {
      const malformedFile = {
        ...mockFile,
        originalname: null, // This should be handled gracefully
      };

      const cb = jest.fn((err, filename) => {
        // The function should handle this gracefully
        expect(typeof err === 'object' || err === null).toBe(true);
        done();
      });

      try {
        storage.getFilename(mockReq, malformedFile, cb);
      } catch (error) {
        // If it throws, that's also acceptable behavior
        done();
      }
    });

    it('should handle edge cases in filename sanitization', (done) => {
      const edgeCaseFiles = [
        { originalname: '', expected: /_/ },
        { originalname: '.hidden', expected: /^_\.hidden/ },
        { originalname: '../../../etc/passwd', expected: /passwd/ },
        { originalname: 'file\x00name.txt', expected: /file_name\.txt/ },
      ];

      let testCount = 0;

      const testNextFile = (fileData) => {
        const fileToTest = { ...mockFile, originalname: fileData.originalname };

        const cb = jest.fn((err, filename) => {
          expect(err).toBeNull();
          expect(filename).toMatch(fileData.expected);

          testCount++;
          if (testCount === edgeCaseFiles.length) {
            done();
          } else {
            testNextFile(edgeCaseFiles[testCount]);
          }
        });

        storage.getFilename(mockReq, fileToTest, cb);
      };

      testNextFile(edgeCaseFiles[0]);
    });
  });

  describe('Real Configuration Testing', () => {
    it('should handle missing custom config gracefully with real mergeFileConfig', async () => {
      const { getAppConfig } = require('~/server/services/Config');

      // Mock getAppConfig to return undefined
      getAppConfig.mockResolvedValueOnce(undefined);

      const multerInstance = await createMulterInstance();
      expect(multerInstance).toBeDefined();
      expect(typeof multerInstance.single).toBe('function');
    });

    it('should properly integrate real fileConfig with custom endpoints', async () => {
      const { getAppConfig } = require('~/server/services/Config');

      // Mock appConfig with fileConfig
      getAppConfig.mockResolvedValueOnce({
        paths: {
          uploads: tempDir,
        },
        fileConfig: {
          endpoints: {
            anthropic: {
              supportedMimeTypes: ['text/plain', 'image/png'],
            },
          },
          serverFileSizeLimit: 20971520, // 20 MB in bytes (mergeFileConfig converts)
        },
      });

      const multerInstance = await createMulterInstance();
      expect(multerInstance).toBeDefined();

      // Verify that getAppConfig was called
      expect(getAppConfig).toHaveBeenCalled();
    });
  });

  describe('agent uploads and provider allowlists', () => {
    const configWithWiderProvider = () => {
      const { mergeFileConfig } = require('librechat-data-provider');
      return mergeFileConfig({
        endpoints: {
          agents: { supportedMimeTypes: ['^application/pdf$'] },
          'Custom Provider': { supportedMimeTypes: ['^application/pdf$', '^video/mp4$'] },
        },
      });
    };

    it('accepts a type only the agent provider allows', (done) => {
      /* This filter is synchronous and runs before the agent read, so narrowing to the
       * agents entry would make the later provider check able to reject but never
       * permit. The route validates again under the resolved provider. */
      const fileFilter = createFileFilter(configWithWiderProvider());
      mockReq.body = { endpoint: 'agents' };

      fileFilter(
        mockReq,
        { ...mockFile, originalname: 'clip.mp4', mimetype: 'video/mp4' },
        (err, accepted) => {
          expect(err).toBeNull();
          expect(accepted).toBe(true);
          done();
        },
      );
    });

    it('still refuses a type no configured endpoint allows', (done) => {
      const fileFilter = createFileFilter(configWithWiderProvider());
      mockReq.body = { endpoint: 'agents' };

      fileFilter(
        mockReq,
        { ...mockFile, originalname: 'installer.exe', mimetype: 'application/x-msdownload' },
        (err, accepted) => {
          expect(err).toBeTruthy();
          expect(accepted).toBe(false);
          done();
        },
      );
    });

    it('keeps a non-agent endpoint judged by its own allowlist alone', (done) => {
      const fileFilter = createFileFilter(configWithWiderProvider());
      mockReq.body = { endpoint: 'agents-lookalike' };

      fileFilter(
        mockReq,
        { ...mockFile, originalname: 'clip.mp4', mimetype: 'video/mp4' },
        (err, accepted) => {
          expect(err).toBeTruthy();
          expect(accepted).toBe(false);
          done();
        },
      );
    });
  });
});
