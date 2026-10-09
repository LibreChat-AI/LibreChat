// Mock setup must be hoisted
jest.mock('fs');
jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    getHeaders: jest
      .fn()
      .mockReturnValue({ 'content-type': 'multipart/form-data; boundary=---boundary' }),
    getBuffer: jest.fn().mockReturnValue(Buffer.from('mock-form-data')),
    getLength: jest.fn().mockReturnValue(100),
  }));
});
jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn().mockImplementation((url) => ({ proxyUrl: url })),
}));
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createSign: jest.fn(() => ({
    update: jest.fn(),
    end: jest.fn(),
    sign: jest.fn(() => 'mock-signature'),
  })),
}));
jest.mock('axios', () => {
  const mockAxiosInstance = {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    put: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn(), clear: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn(), clear: jest.fn() },
    },
    defaults: {
      proxy: null,
    },
  };

  return {
    ...mockAxiosInstance,
    create: jest.fn().mockReturnValue(mockAxiosInstance),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn(),
  isEncryptedSecretPayload: jest.fn(),
}));

jest.mock('~/utils/axios', () => ({
  createAxiosInstance: () => jest.requireMock('axios'),
  logAxiosError: jest.fn(({ message }) => message || 'Error'),
}));

jest.mock('~/utils/files', () => ({
  readFileAsBuffer: jest.fn(),
}));

jest.mock('~/utils/key', () => ({
  loadServiceKey: jest.fn(),
}));

import * as fs from 'fs';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Readable } from 'stream';
import type {
  MistralFileUploadResponse,
  MistralSignedUrlResponse,
  ServerRequest,
  OCRResult,
} from '~/types';
import { logger as mockLogger } from '@librechat/data-schemas';
import { decryptConfigSecret, isEncryptedSecretPayload } from '~/admin/secrets';
import { logAxiosError } from '~/utils/axios';
import { readFileAsBuffer } from '~/utils/files';
import { loadServiceKey } from '~/utils/key';
import {
  uploadDocumentToMistral,
  uploadAzureMistralOCR,
  uploadGoogleVertexMistralOCR,
  deleteMistralFile,
  uploadMistralOCR,
  getSignedUrl,
  performOCR,
} from './crud';

interface MockReadStream extends Partial<Readable> {
  on: jest.Mock;
  pipe: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  emit: jest.Mock;
  once: jest.Mock;
  destroy: jest.Mock;
  path?: string;
  fd?: number;
  flags?: string;
  mode?: number;
  autoClose?: boolean;
  bytesRead?: number;
  closed?: boolean;
  pending?: boolean;
}

const mockAxios = jest.mocked(axios);
const mockedLogAxiosError = jest.mocked(logAxiosError);

const mockLoadAuthValues = jest.fn();
const protectedFilters = {
  files: {
    pii: {
      fields: ['extracted_text'],
      starterPatterns: [],
      uninspectable: 'block',
    },
  },
};

const privateProviderError = () =>
  Object.assign(new Error('PRIVATE provider message'), {
    response: {
      status: 502,
      data: {
        detail: 'PRIVATE document detail',
        message: 'PRIVATE extracted content',
      },
    },
  });

describe('MistralOCR Service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('uploadDocumentToMistral', () => {
    beforeEach(() => {
      // Create a more complete mock for file streams that FormData can work with
      const mockReadStream: MockReadStream = {
        on: jest.fn().mockImplementation(function (
          this: MockReadStream,
          event: string,
          handler: () => void,
        ) {
          // Simulate immediate 'end' event to make FormData complete processing
          if (event === 'end') {
            handler();
          }
          return this;
        }),
        pipe: jest.fn().mockImplementation(function (this: MockReadStream) {
          return this;
        }),
        pause: jest.fn(),
        resume: jest.fn(),
        emit: jest.fn(),
        once: jest.fn(),
        destroy: jest.fn(),
        path: '/path/to/test.pdf',
        fd: 1,
        flags: 'r',
        mode: 0o666,
        autoClose: true,
        bytesRead: 0,
        closed: false,
        pending: false,
      };

      (jest.mocked(fs).createReadStream as jest.Mock).mockReturnValue(mockReadStream);
    });

    it('destroys the upload stream when the request fails (async SSRF block)', async () => {
      const err = Object.assign(new Error('SSRF protection'), { code: 'ESSRF' });
      mockAxios.post!.mockRejectedValueOnce(err);

      await expect(
        uploadDocumentToMistral({ filePath: '/path/to/test.pdf', apiKey: 'k' }),
      ).rejects.toBe(err);

      const stream = (jest.mocked(fs).createReadStream as jest.Mock).mock.results[0].value;
      expect(stream.destroy).toHaveBeenCalled();
    });

    it('should upload a document to Mistral API using file streaming', async () => {
      const mockResponse: { data: MistralFileUploadResponse } = {
        data: {
          id: 'file-123',
          object: 'file',
          bytes: 1024,
          created_at: Date.now(),
          filename: 'test.pdf',
          purpose: 'ocr',
        },
      };
      mockAxios.post!.mockResolvedValueOnce(mockResponse);

      try {
        const result = await uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        });

        // Check that createReadStream was called with the correct file path
        expect(jest.mocked(fs).createReadStream).toHaveBeenCalledWith('/path/to/test.pdf');

        // Since we're mocking FormData, we'll just check that axios was called correctly
        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files',
          expect.anything(),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-api-key',
            }),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            maxRedirects: 0,
            httpAgent: expect.anything(),
            httpsAgent: expect.anything(),
          }),
        );
        expect(result).toEqual(mockResponse.data);
      } catch (error) {
        console.error('Test error:', error);
        throw error;
      }
    });

    it('should handle errors during document upload', async () => {
      const errorMessage = 'API error';
      mockAxios.post!.mockRejectedValueOnce(new Error(errorMessage));

      await expect(
        uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        }),
      ).rejects.toThrow(errorMessage);
    });
  });

  describe('getSignedUrl', () => {
    it('should fetch signed URL from Mistral API', async () => {
      const mockResponse: { data: MistralSignedUrlResponse } = {
        data: {
          url: 'https://document-url.com',
          expires_at: Date.now() + 86400000,
        },
      };
      mockAxios.get!.mockResolvedValueOnce(mockResponse);

      const result = await getSignedUrl({
        fileId: 'file-123',
        apiKey: 'test-api-key',
      });

      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/files/file-123/url?expiry=24',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-api-key',
          },
          maxRedirects: 0,
          httpAgent: expect.anything(),
          httpsAgent: expect.anything(),
        }),
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors when fetching signed URL', async () => {
      const errorMessage = 'API error';
      mockAxios.get!.mockRejectedValueOnce(new Error(errorMessage));

      await expect(
        getSignedUrl({
          fileId: 'file-123',
          apiKey: 'test-api-key',
        }),
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith('Error fetching signed URL:', errorMessage);
    });

    it('omits provider error content when protected logging is active', async () => {
      mockAxios.get!.mockRejectedValueOnce(privateProviderError());

      await expect(
        getSignedUrl({
          fileId: 'file-123',
          apiKey: 'test-api-key',
          contentProtected: true,
        }),
      ).rejects.toThrow('Error fetching signed URL.');

      expect(mockLogger.error).toHaveBeenCalledWith('Error fetching signed URL.', {
        type: 'Error',
        status: 502,
      });
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });
  });

  describe('deleteMistralFile', () => {
    it('should delete a file from Mistral API', async () => {
      mockAxios.delete!.mockResolvedValueOnce({ data: {} });

      await deleteMistralFile({
        fileId: 'file-123',
        apiKey: 'test-api-key',
        baseURL: 'https://api.mistral.ai/v1',
      });

      expect(mockAxios.delete).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/files/file-123',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-api-key',
          },
          maxRedirects: 0,
          httpAgent: expect.anything(),
          httpsAgent: expect.anything(),
        }),
      );
    });

    it('should use default baseURL when not provided', async () => {
      mockAxios.delete!.mockResolvedValueOnce({ data: {} });

      await deleteMistralFile({
        fileId: 'file-456',
        apiKey: 'test-api-key',
      });

      expect(mockAxios.delete).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/files/file-456',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-api-key',
          },
        }),
      );
    });

    it('should not throw when deletion fails', async () => {
      mockAxios.delete!.mockRejectedValueOnce(new Error('Delete failed'));

      // Should not throw
      await expect(
        deleteMistralFile({
          fileId: 'file-789',
          apiKey: 'test-api-key',
        }),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error deleting Mistral file file-789:',
        expect.any(Error),
      );
    });

    it('omits provider response data when protected cleanup logging is active', async () => {
      mockAxios.delete!.mockRejectedValueOnce(privateProviderError());

      await expect(
        deleteMistralFile({
          fileId: 'file-789',
          apiKey: 'test-api-key',
          contentProtected: true,
        }),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith('Error deleting Mistral file file-789.', {
        type: 'Error',
        status: 502,
      });
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });
  });

  describe('performOCR', () => {
    it('should perform OCR using Mistral API (document_url)', async () => {
      const mockResponse: { data: OCRResult } = {
        data: {
          model: 'mistral-ocr-latest',
          pages: [
            {
              index: 0,
              markdown: 'Page 1 content',
              images: [],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
            {
              index: 1,
              markdown: 'Page 2 content',
              images: [],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 2,
            doc_size_bytes: 1024,
          },
        },
      };
      mockAxios.post!.mockResolvedValueOnce(mockResponse);

      const result = await performOCR({
        apiKey: 'test-api-key',
        url: 'https://document-url.com',
        model: 'mistral-ocr-latest',
        documentType: 'document_url',
      });

      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/ocr',
        {
          model: 'mistral-ocr-latest',
          include_image_base64: false,
          image_limit: 0,
          document: {
            type: 'document_url',
            document_url: 'https://document-url.com',
          },
        },
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          },
          maxRedirects: 0,
          httpAgent: expect.anything(),
          httpsAgent: expect.anything(),
        }),
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should perform OCR using Mistral API (image_url)', async () => {
      const mockResponse: { data: OCRResult } = {
        data: {
          model: 'mistral-ocr-latest',
          pages: [
            {
              index: 0,
              markdown: 'Image OCR content',
              images: [],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 1,
            doc_size_bytes: 2048,
          },
        },
      };
      mockAxios.post!.mockResolvedValueOnce(mockResponse);

      const result = await performOCR({
        apiKey: 'test-api-key',
        url: 'https://image-url.com/image.png',
        model: 'mistral-ocr-latest',
        documentType: 'image_url',
      });

      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/ocr',
        {
          model: 'mistral-ocr-latest',
          include_image_base64: false,
          image_limit: 0,
          document: {
            type: 'image_url',
            image_url: 'https://image-url.com/image.png',
          },
        },
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          },
        }),
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors during OCR processing', async () => {
      const errorMessage = 'OCR processing error';
      mockAxios.post!.mockRejectedValueOnce(new Error(errorMessage));

      await expect(
        performOCR({
          apiKey: 'test-api-key',
          url: 'https://document-url.com',
        }),
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith('Error performing OCR:', errorMessage);
    });

    it('omits provider response data when protected OCR logging is active', async () => {
      mockAxios.post!.mockRejectedValueOnce(privateProviderError());

      await expect(
        performOCR({
          apiKey: 'test-api-key',
          url: 'https://document-url.com',
          contentProtected: true,
        }),
      ).rejects.toThrow('Error performing OCR.');

      expect(mockLogger.error).toHaveBeenCalledWith('Error performing OCR.', {
        type: 'Error',
        status: 502,
      });
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });
  });

  describe('uploadMistralOCR', () => {
    beforeEach(() => {
      const mockReadStream: MockReadStream = {
        on: jest.fn().mockImplementation(function (
          this: MockReadStream,
          event: string,
          handler: () => void,
        ) {
          // Simulate immediate 'end' event to make FormData complete processing
          if (event === 'end') {
            handler();
          }
          return this;
        }),
        pipe: jest.fn().mockImplementation(function (this: MockReadStream) {
          return this;
        }),
        pause: jest.fn(),
        resume: jest.fn(),
        emit: jest.fn(),
        once: jest.fn(),
        destroy: jest.fn(),
        path: '/tmp/upload/file.pdf',
        fd: 1,
        flags: 'r',
        mode: 0o666,
        autoClose: true,
        bytesRead: 0,
        closed: false,
        pending: false,
      };

      (jest.mocked(fs).createReadStream as jest.Mock).mockReturnValue(mockReadStream);
    });

    it('should process OCR for a file with standard configuration', async () => {
      // Setup mocks
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'test-api-key',
        OCR_BASEURL: 'https://api.mistral.ai/v1',
      });

      // Mock file upload response
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          object: 'file',
          bytes: 1024,
          created_at: Date.now(),
          filename: 'document.pdf',
          purpose: 'ocr',
        } as MistralFileUploadResponse,
      });

      // Mock signed URL response
      mockAxios.get!.mockResolvedValueOnce({
        data: {
          url: 'https://signed-url.com',
          expires_at: Date.now() + 86400000,
        } as MistralSignedUrlResponse,
      });

      // Mock OCR response with text and images
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          model: 'mistral-medium',
          pages: [
            {
              index: 0,
              markdown: 'Page 1 content',
              images: [
                {
                  id: 'img1',
                  top_left_x: 0,
                  top_left_y: 0,
                  bottom_right_x: 100,
                  bottom_right_y: 100,
                  image_base64: 'base64image1',
                  image_annotation: '',
                },
              ],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
            {
              index: 1,
              markdown: 'Page 2 content',
              images: [
                {
                  id: 'img2',
                  top_left_x: 0,
                  top_left_y: 0,
                  bottom_right_x: 100,
                  bottom_right_y: 100,
                  image_base64: 'base64image2',
                  image_annotation: '',
                },
              ],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 2,
            doc_size_bytes: 1024,
          },
        },
      });

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            // Use environment variable syntax to ensure loadAuthValues is called
            apiKey: '${OCR_API_KEY}',
            baseURL: '${OCR_BASEURL}',
            mistralModel: 'mistral-medium',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      expect(mockLoadAuthValues).toHaveBeenCalledWith({
        userId: 'user123',
        authFields: ['OCR_BASEURL', 'OCR_API_KEY'],
        optional: expect.any(Set),
      });

      // Verify OCR result
      expect(result).toEqual({
        filename: 'document.pdf',
        bytes: expect.any(Number),
        filepath: 'mistral_ocr',
        text: expect.stringContaining('# PAGE 1'),
        images: ['base64image1', 'base64image2'],
      });
    });

    it('should process OCR for an image file and use image_url type', async () => {
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'test-api-key',
        OCR_BASEURL: 'https://api.mistral.ai/v1',
      });

      // Mock file upload response
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          id: 'file-456',
          object: 'file',
          bytes: 2048,
          created_at: Date.now(),
          filename: 'image.png',
          purpose: 'ocr',
        } as MistralFileUploadResponse,
      });

      // Mock signed URL response
      mockAxios.get!.mockResolvedValueOnce({
        data: {
          url: 'https://signed-url.com/image.png',
          expires_at: Date.now() + 86400000,
        } as MistralSignedUrlResponse,
      });

      // Mock OCR response for image
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          model: 'mistral-medium',
          pages: [
            {
              index: 0,
              markdown: 'Image OCR result',
              images: [
                {
                  id: 'img1',
                  top_left_x: 0,
                  top_left_y: 0,
                  bottom_right_x: 100,
                  bottom_right_y: 100,
                  image_base64: 'imgbase64',
                  image_annotation: '',
                },
              ],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 1,
            doc_size_bytes: 2048,
          },
        },
      });

      const req = {
        user: { id: 'user456' },
        config: {
          ocr: {
            apiKey: '${OCR_API_KEY}',
            baseURL: '${OCR_BASEURL}',
            mistralModel: 'mistral-medium',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/image.png',
        originalname: 'image.png',
        mimetype: 'image/png',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/image.png',
      );

      expect(mockLoadAuthValues).toHaveBeenCalledWith({
        userId: 'user456',
        authFields: ['OCR_BASEURL', 'OCR_API_KEY'],
        optional: expect.any(Set),
      });

      // Check that the OCR API was called with image_url type
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/ocr',
        expect.objectContaining({
          document: expect.objectContaining({
            type: 'image_url',
            image_url: 'https://signed-url.com/image.png',
          }),
        }),
        expect.any(Object),
      );

      expect(result).toEqual({
        filename: 'image.png',
        bytes: expect.any(Number),
        filepath: 'mistral_ocr',
        text: expect.stringContaining('Image OCR result'),
        images: ['imgbase64'],
      });
    });

    it('should process variable references in configuration', async () => {
      // Setup mocks with environment variables
      mockLoadAuthValues.mockResolvedValue({
        CUSTOM_API_KEY: 'custom-api-key',
        CUSTOM_BASEURL: 'https://custom-api.mistral.ai/v1',
      });

      // Mock API responses
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          object: 'file',
          bytes: 1024,
          created_at: Date.now(),
          filename: 'document.pdf',
          purpose: 'ocr',
        } as MistralFileUploadResponse,
      });
      mockAxios.get!.mockResolvedValueOnce({
        data: {
          url: 'https://signed-url.com',
          expires_at: Date.now() + 86400000,
        } as MistralSignedUrlResponse,
      });
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          model: 'mistral-large',
          pages: [
            {
              index: 0,
              markdown: 'Content from custom API',
              images: [],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 1,
            doc_size_bytes: 1024,
          },
        },
      });

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            apiKey: '${CUSTOM_API_KEY}',
            baseURL: '${CUSTOM_BASEURL}',
            mistralModel: '${CUSTOM_MODEL}',
          },
        },
      } as unknown as ServerRequest;

      // Set environment variable for model
      process.env.CUSTOM_MODEL = 'mistral-large';

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      // Verify that custom environment variables were extracted and used
      expect(mockLoadAuthValues).toHaveBeenCalledWith({
        userId: 'user123',
        authFields: ['CUSTOM_BASEURL', 'CUSTOM_API_KEY'],
        optional: expect.any(Set),
      });

      // Check that mistral-large was used in the OCR API call
      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          model: 'mistral-large',
        }),
        expect.anything(),
      );

      expect(result.text).toEqual('Content from custom API\n\n');
    });

    it('should fall back to default values when variables are not properly formatted', async () => {
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'default-api-key',
        OCR_BASEURL: undefined, // Testing optional parameter
      });

      mockAxios.post!.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          object: 'file',
          bytes: 1024,
          created_at: Date.now(),
          filename: 'document.pdf',
          purpose: 'ocr',
        } as MistralFileUploadResponse,
      });
      mockAxios.get!.mockResolvedValueOnce({
        data: {
          url: 'https://signed-url.com',
          expires_at: Date.now() + 86400000,
        } as MistralSignedUrlResponse,
      });
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          model: 'mistral-ocr-latest',
          pages: [
            {
              index: 0,
              markdown: 'Default API result',
              images: [],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 1,
            doc_size_bytes: 1024,
          },
        },
      });

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            // Use environment variable syntax to ensure loadAuthValues is called
            apiKey: '${INVALID_FORMAT}', // Using valid env var format but with an invalid name
            baseURL: '${OCR_BASEURL}', // Using valid env var format
            mistralModel: 'mistral-ocr-latest', // Plain string value
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      // Should use the default values
      expect(mockLoadAuthValues).toHaveBeenCalledWith({
        userId: 'user123',
        authFields: ['OCR_BASEURL', 'INVALID_FORMAT'],
        optional: expect.any(Set),
      });

      // Should use the default model when not using environment variable format
      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          model: 'mistral-ocr-latest',
        }),
        expect.anything(),
      );
    });

    it('should handle API errors during OCR process', async () => {
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'test-api-key',
      });

      // Mock file upload to fail
      mockAxios.post!.mockRejectedValueOnce(new Error('Upload failed'));

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            apiKey: '${OCR_API_KEY}',
            baseURL: '${OCR_BASEURL}',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      await expect(
        uploadMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        }),
      ).rejects.toThrow('Error uploading document to Mistral OCR API');
      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );
    });

    it('derives protected logging from file policy before handling provider failures', async () => {
      mockAxios.post!.mockRejectedValueOnce(privateProviderError());
      const req = {
        user: { id: 'user123' },
        config: {
          filters: protectedFilters,
          ocr: {
            apiKey: 'test-api-key',
            baseURL: 'https://api.mistral.ai/v1',
          },
        },
      } as unknown as ServerRequest;
      const file = {
        path: '/tmp/upload/private.pdf',
        originalname: 'PRIVATE-document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      let thrownError: unknown;
      try {
        await uploadMistralOCR({ req, file, loadAuthValues: mockLoadAuthValues });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe('Error uploading document to Mistral OCR API:');
      expect(mockedLogAxiosError).not.toHaveBeenCalled();
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });

    it('should handle single page documents without page numbering', async () => {
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'test-api-key',
        OCR_BASEURL: 'https://api.mistral.ai/v1', // Make sure this is included
      });

      // Clear all previous mocks
      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();

      // 1. First mock: File upload response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            id: 'file-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'single-page.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        }),
      );

      // 2. Second mock: Signed URL response
      mockAxios.get!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        }),
      );

      // 3. Third mock: OCR response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Single page content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        }),
      );

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            apiKey: '${OCR_API_KEY}',
            baseURL: '${OCR_BASEURL}',
            mistralModel: 'mistral-ocr-latest',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'single-page.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      // Verify that single page documents don't include page numbering
      expect(result.text).not.toContain('# PAGE');
      expect(result.text).toEqual('Single page content\n\n');
    });

    it('should use literal values in configuration when provided directly', async () => {
      // We'll still mock this but it should not be used for literal values
      mockLoadAuthValues.mockResolvedValue({});

      // Clear all previous mocks
      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();

      // 1. First mock: File upload response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            id: 'file-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'direct-values.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        }),
      );

      // 2. Second mock: Signed URL response
      mockAxios.get!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        }),
      );

      // 3. Third mock: OCR response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            model: 'mistral-direct-model',
            pages: [
              {
                index: 0,
                markdown: 'Processed with literal config values',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        }),
      );

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            // Direct values that should be used as-is, without variable substitution
            apiKey: 'actual-api-key-value',
            baseURL: 'https://direct-api-url.mistral.ai/v1',
            mistralModel: 'mistral-direct-model',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'direct-values.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      // Verify the correct URL was used with the direct baseURL value
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://direct-api-url.mistral.ai/v1/files',
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer actual-api-key-value',
          }),
        }),
      );

      // Check the OCR call was made with the direct model value
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://direct-api-url.mistral.ai/v1/ocr',
        expect.objectContaining({
          model: 'mistral-direct-model',
        }),
        expect.any(Object),
      );

      // Verify the result
      expect(result.text).toEqual('Processed with literal config values\n\n');

      // Verify loadAuthValues was never called since we used direct values
      expect(mockLoadAuthValues).not.toHaveBeenCalled();
    });

    it('should fail closed to env-var loading instead of sending a corrupted ciphertext as the apiKey', async () => {
      // Simulates a stored v3 ciphertext that fails to decrypt (e.g. corrupted at rest).
      const corruptedCiphertext = 'v3:corrupted-ciphertext';
      (isEncryptedSecretPayload as jest.Mock).mockReturnValueOnce(true);
      (decryptConfigSecret as jest.Mock).mockReturnValueOnce(undefined);

      mockLoadAuthValues.mockResolvedValue({ OCR_API_KEY: 'env-fallback-key' });

      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();

      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            id: 'file-456',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'corrupted-key.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        }),
      );
      mockAxios.get!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        }),
      );
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Processed with the env-fallback key',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: { pages_processed: 1, doc_size_bytes: 1024 },
          },
        }),
      );

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            apiKey: corruptedCiphertext,
            baseURL: 'https://api.mistral.ai/v1',
            mistralModel: 'mistral-ocr-latest',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'corrupted-key.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      await uploadMistralOCR({ req, file, loadAuthValues: mockLoadAuthValues });

      // The corrupted ciphertext must never be sent as the credential.
      expect(mockAxios.post).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining(corruptedCiphertext),
          }),
        }),
      );

      // Treated as empty, so it fails over to loading OCR_API_KEY from the environment.
      expect(mockLoadAuthValues).toHaveBeenCalledWith(
        expect.objectContaining({ authFields: expect.arrayContaining(['OCR_API_KEY']) }),
      );
      expect(mockAxios.post).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer env-fallback-key',
          }),
        }),
      );
    });

    it('should handle empty configuration values and use defaults', async () => {
      // Set up the mock values to be returned by loadAuthValues
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'default-from-env-key',
        OCR_BASEURL: 'https://default-from-env.mistral.ai/v1',
      });

      // Clear all previous mocks
      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();

      // 1. First mock: File upload response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            id: 'file-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'empty-config.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        }),
      );

      // 2. Second mock: Signed URL response
      mockAxios.get!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        }),
      );

      // 3. Third mock: OCR response
      mockAxios.post!.mockImplementationOnce(() =>
        Promise.resolve({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Content from default configuration',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        }),
      );

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            // Empty string values - should fall back to defaults
            apiKey: '',
            baseURL: '',
            mistralModel: '',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/file.pdf',
        originalname: 'empty-config.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect((fs as jest.Mocked<typeof fs>).createReadStream).toHaveBeenCalledWith(
        '/tmp/upload/file.pdf',
      );

      // Verify loadAuthValues was called with the default variable names
      expect(mockLoadAuthValues).toHaveBeenCalledWith({
        userId: 'user123',
        authFields: ['OCR_BASEURL', 'OCR_API_KEY'],
        optional: expect.any(Set),
      });

      // Verify the API calls used the default values from loadAuthValues
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://default-from-env.mistral.ai/v1/files',
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer default-from-env-key',
          }),
        }),
      );

      // Verify the OCR model defaulted to mistral-ocr-latest
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://default-from-env.mistral.ai/v1/ocr',
        expect.objectContaining({
          model: 'mistral-ocr-latest',
        }),
        expect.any(Object),
      );

      // Check result
      expect(result.text).toEqual('Content from default configuration\n\n');
    });

    describe('Mixed env var and hardcoded configuration', () => {
      beforeEach(() => {
        // Clean up any PROXY env var from previous tests
        delete process.env.PROXY;
        const mockReadStream: MockReadStream = {
          on: jest.fn().mockImplementation(function (
            this: MockReadStream,
            event: string,
            handler: () => void,
          ) {
            // Simulate immediate 'end' event to make FormData complete processing
            if (event === 'end') {
              handler();
            }
            return this;
          }),
          pipe: jest.fn().mockImplementation(function (this: MockReadStream) {
            return this;
          }),
          pause: jest.fn(),
          resume: jest.fn(),
          emit: jest.fn(),
          once: jest.fn(),
          destroy: jest.fn(),
          path: '/tmp/upload/file.pdf',
          fd: 1,
          flags: 'r',
          mode: 0o666,
          autoClose: true,
          bytesRead: 0,
          closed: false,
          pending: false,
        };

        (jest.mocked(fs).createReadStream as jest.Mock).mockReturnValue(mockReadStream);
      });

      it('should preserve hardcoded baseURL when only apiKey is an env var', async () => {
        // This test demonstrates the current bug
        mockLoadAuthValues.mockResolvedValue({
          AZURE_MISTRAL_OCR_API_KEY: 'test-api-key-from-env',
          // Note: OCR_BASEURL is not returned, simulating it not being set
        });

        // Mock file upload response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            id: 'file-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'document.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        });

        // Mock signed URL response
        mockAxios.get!.mockResolvedValueOnce({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-2503',
            pages: [
              {
                index: 0,
                markdown: 'Test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${AZURE_MISTRAL_OCR_API_KEY}',
              baseURL: 'https://endpoint.models.ai.azure.com/v1',
              mistralModel: 'mistral-ocr-2503',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        // Check that loadAuthValues was called only with the env var field
        expect(mockLoadAuthValues).toHaveBeenCalledWith({
          userId: 'user123',
          authFields: ['AZURE_MISTRAL_OCR_API_KEY'],
          optional: expect.any(Set),
        });

        // The fix: baseURL should be the hardcoded value
        const uploadCall = mockAxios.post!.mock.calls[0];
        expect(uploadCall[0]).toBe('https://endpoint.models.ai.azure.com/v1/files');
      });

      it('should preserve hardcoded apiKey when only baseURL is an env var', async () => {
        // This test demonstrates the current bug
        mockLoadAuthValues.mockResolvedValue({
          CUSTOM_OCR_BASEURL: 'https://custom-ocr-endpoint.com/v1',
          // Note: OCR_API_KEY is not returned, simulating it not being set
        });

        // Mock file upload response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            id: 'file-456',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'document.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        });

        // Mock signed URL response
        mockAxios.get!.mockResolvedValueOnce({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        const req = {
          user: { id: 'user456' },
          config: {
            ocr: {
              apiKey: 'hardcoded-api-key-12345',
              baseURL: '${CUSTOM_OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        // Check that loadAuthValues was called only with the env var field
        expect(mockLoadAuthValues).toHaveBeenCalledWith({
          userId: 'user456',
          authFields: ['CUSTOM_OCR_BASEURL'],
          optional: expect.any(Set),
        });

        // The fix: apiKey should be the hardcoded value
        const uploadCall = mockAxios.post!.mock.calls[0];
        const authHeader = uploadCall[2]?.headers?.Authorization;
        expect(authHeader).toBe('Bearer hardcoded-api-key-12345');
      });
    });

    describe('File cleanup', () => {
      beforeEach(() => {
        const mockReadStream: MockReadStream = {
          on: jest.fn().mockImplementation(function (
            this: MockReadStream,
            event: string,
            handler: () => void,
          ) {
            if (event === 'end') {
              handler();
            }
            return this;
          }),
          pipe: jest.fn().mockImplementation(function (this: MockReadStream) {
            return this;
          }),
          pause: jest.fn(),
          resume: jest.fn(),
          emit: jest.fn(),
          once: jest.fn(),
          destroy: jest.fn(),
          path: '/tmp/upload/file.pdf',
          fd: 1,
          flags: 'r',
          mode: 0o666,
          autoClose: true,
          bytesRead: 0,
          closed: false,
          pending: false,
        };

        (jest.mocked(fs).createReadStream as jest.Mock).mockReturnValue(mockReadStream);
        // Clear all mocks before each test
        mockAxios.delete!.mockClear();
      });

      it('should delete the uploaded file after successful OCR processing', async () => {
        mockLoadAuthValues.mockResolvedValue({
          OCR_API_KEY: 'test-api-key',
          OCR_BASEURL: 'https://api.mistral.ai/v1',
        });

        // Mock file upload response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            id: 'file-cleanup-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'document.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        });

        // Mock signed URL response
        mockAxios.get!.mockResolvedValueOnce({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'OCR content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        // Mock delete file response
        mockAxios.delete!.mockResolvedValueOnce({ data: {} });

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${OCR_API_KEY}',
              baseURL: '${OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        // Verify delete was called with correct parameters
        expect(mockAxios.delete).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files/file-cleanup-123',
          expect.objectContaining({
            headers: {
              Authorization: 'Bearer test-api-key',
            },
          }),
        );
        expect(mockAxios.delete).toHaveBeenCalledTimes(1);
      });

      it('should delete the uploaded file even when OCR processing fails', async () => {
        mockLoadAuthValues.mockResolvedValue({
          OCR_API_KEY: 'test-api-key',
          OCR_BASEURL: 'https://api.mistral.ai/v1',
        });

        // Mock file upload response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            id: 'file-cleanup-456',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'document.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        });

        // Mock signed URL response
        mockAxios.get!.mockResolvedValueOnce({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        });

        // Mock OCR to fail
        mockAxios.post!.mockRejectedValueOnce(new Error('OCR processing failed'));

        // Mock delete file response
        mockAxios.delete!.mockResolvedValueOnce({ data: {} });

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${OCR_API_KEY}',
              baseURL: '${OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await expect(
          uploadMistralOCR({
            req,
            file,
            loadAuthValues: mockLoadAuthValues,
          }),
        ).rejects.toThrow('Error uploading document to Mistral OCR API');

        // Verify delete was still called despite the error
        expect(mockAxios.delete).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files/file-cleanup-456',
          expect.objectContaining({
            headers: {
              Authorization: 'Bearer test-api-key',
            },
          }),
        );
        expect(mockAxios.delete).toHaveBeenCalledTimes(1);
      });

      it('should handle deletion errors gracefully without throwing', async () => {
        mockLoadAuthValues.mockResolvedValue({
          OCR_API_KEY: 'test-api-key',
          OCR_BASEURL: 'https://api.mistral.ai/v1',
        });

        // Mock file upload response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            id: 'file-cleanup-789',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'document.pdf',
            purpose: 'ocr',
          } as MistralFileUploadResponse,
        });

        // Mock signed URL response
        mockAxios.get!.mockResolvedValueOnce({
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          } as MistralSignedUrlResponse,
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'OCR content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        // Mock delete to fail
        mockAxios.delete!.mockRejectedValueOnce(new Error('Delete failed'));

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${OCR_API_KEY}',
              baseURL: '${OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        // Should not throw even if delete fails
        const result = await uploadMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(result).toEqual({
          filename: 'document.pdf',
          bytes: expect.any(Number),
          filepath: 'mistral_ocr',
          text: 'OCR content\n\n',
          images: [],
        });

        // Verify delete was attempted
        expect(mockAxios.delete).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files/file-cleanup-789',
          expect.objectContaining({
            headers: {
              Authorization: 'Bearer test-api-key',
            },
          }),
        );

        // Verify error was logged
        expect(mockLogger.error).toHaveBeenCalledWith(
          'Error deleting Mistral file file-cleanup-789:',
          expect.any(Error),
        );
      });

      it('should not attempt cleanup if file upload fails', async () => {
        mockLoadAuthValues.mockResolvedValue({
          OCR_API_KEY: 'test-api-key',
          OCR_BASEURL: 'https://api.mistral.ai/v1',
        });

        // Mock file upload to fail
        mockAxios.post!.mockRejectedValueOnce(new Error('Upload failed'));

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${OCR_API_KEY}',
              baseURL: '${OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await expect(
          uploadMistralOCR({
            req,
            file,
            loadAuthValues: mockLoadAuthValues,
          }),
        ).rejects.toThrow('Error uploading document to Mistral OCR API');

        // Verify delete was NOT called since upload failed
        expect(mockAxios.delete).not.toHaveBeenCalled();
      });
    });
  });

  describe('Proxy Configuration', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const originalNoProxy = process.env.NO_PROXY;

    beforeEach(() => {
      // Reset the HttpsProxyAgent mock to its default implementation
      (HttpsProxyAgent as unknown as jest.Mock).mockImplementation((url) => ({ proxyUrl: url }));
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      // Clear any previous axios mock calls
      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();
      mockAxios.delete!.mockClear();
    });

    afterEach(() => {
      if (originalProxy) {
        process.env.PROXY = originalProxy;
      } else {
        delete process.env.PROXY;
      }
      if (originalHttpProxy) {
        process.env.HTTP_PROXY = originalHttpProxy;
      } else {
        delete process.env.HTTP_PROXY;
      }
      if (originalHttpsProxy) {
        process.env.HTTPS_PROXY = originalHttpsProxy;
      } else {
        delete process.env.HTTPS_PROXY;
      }
      if (originalNoProxy) {
        process.env.NO_PROXY = originalNoProxy;
      } else {
        delete process.env.NO_PROXY;
      }
      // Clear mocks after each test to prevent leaking
      mockAxios.post!.mockClear();
      mockAxios.get!.mockClear();
      mockAxios.delete!.mockClear();
    });

    describe('uploadDocumentToMistral with proxy', () => {
      beforeEach(() => {
        const mockReadStream: MockReadStream = {
          on: jest.fn().mockImplementation(function (
            this: MockReadStream,
            event: string,
            handler: () => void,
          ) {
            if (event === 'end') {
              handler();
            }
            return this;
          }),
          pipe: jest.fn().mockImplementation(function (this: MockReadStream) {
            return this;
          }),
          pause: jest.fn(),
          resume: jest.fn(),
          emit: jest.fn(),
          once: jest.fn(),
          destroy: jest.fn(),
          path: '/path/to/test.pdf',
          fd: 1,
          flags: 'r',
          mode: 0o666,
          autoClose: true,
          bytesRead: 0,
          closed: false,
          pending: false,
        };

        (jest.mocked(fs).createReadStream as jest.Mock).mockReturnValue(mockReadStream);
      });

      it('should use proxy configuration when PROXY env var is set', async () => {
        process.env.PROXY = 'http://proxy.example.com:8080';

        const mockResponse: { data: MistralFileUploadResponse } = {
          data: {
            id: 'file-proxy-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'test.pdf',
            purpose: 'ocr',
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        });

        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files',
          expect.anything(),
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'http://proxy.example.com:8080',
            }),
          }),
        );
      });

      it('should handle proxy URL with authentication', async () => {
        process.env.PROXY = 'http://user:pass@proxy.example.com:8080';

        const mockResponse: { data: MistralFileUploadResponse } = {
          data: {
            id: 'file-proxy-auth-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'test.pdf',
            purpose: 'ocr',
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        });

        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files',
          expect.anything(),
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'http://user:pass@proxy.example.com:8080',
            }),
          }),
        );
      });

      it('should handle IPv6 proxy addresses', async () => {
        process.env.PROXY = 'http://[::1]:8080';

        const mockResponse: { data: MistralFileUploadResponse } = {
          data: {
            id: 'file-proxy-ipv6-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'test.pdf',
            purpose: 'ocr',
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        });

        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files',
          expect.anything(),
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'http://[::1]:8080',
            }),
          }),
        );
      });

      it('should not use proxy when PROXY env var is not set', async () => {
        delete process.env.PROXY;

        const mockResponse: { data: MistralFileUploadResponse } = {
          data: {
            id: 'file-no-proxy-123',
            object: 'file',
            bytes: 1024,
            created_at: Date.now(),
            filename: 'test.pdf',
            purpose: 'ocr',
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await uploadDocumentToMistral({
          filePath: '/path/to/test.pdf',
          fileName: 'test.pdf',
          apiKey: 'test-api-key',
        });

        const config = mockAxios.post!.mock.calls[0][2] as {
          maxRedirects?: number;
          httpsAgent?: { proxyUrl?: string };
        };
        expect(config.maxRedirects).toBe(0);
        expect(config.httpsAgent).toBeDefined();
        expect(config.httpsAgent?.proxyUrl).toBeUndefined();
      });
    });

    describe('performOCR with proxy', () => {
      it('should use proxy configuration when PROXY env var is set', async () => {
        process.env.PROXY = 'http://proxy.example.com:3128';

        const mockResponse: { data: OCRResult } = {
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Proxy test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await performOCR({
          apiKey: 'test-api-key',
          url: 'https://document-url.com',
          model: 'mistral-ocr-latest',
          documentType: 'document_url',
        });

        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/ocr',
          expect.anything(),
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'http://proxy.example.com:3128',
            }),
          }),
        );
      });

      it('should handle malformed proxy URLs gracefully', async () => {
        (HttpsProxyAgent as unknown as jest.Mock).mockImplementationOnce(() => {
          throw new Error('Invalid URL');
        });
        process.env.PROXY = 'not-a-valid-url';

        const mockResponse: { data: OCRResult } = {
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        };
        mockAxios.post!.mockResolvedValueOnce(mockResponse);

        await expect(
          performOCR({
            apiKey: 'test-api-key',
            url: 'https://document-url.com',
          }),
        ).rejects.toThrow('Invalid URL');
      });
    });

    describe('Azure Mistral OCR with proxy', () => {
      beforeEach(() => {
        (readFileAsBuffer as jest.Mock).mockResolvedValue({
          content: Buffer.from('mock-file-content'),
          bytes: Buffer.from('mock-file-content').length,
        });
      });

      it('should use proxy for Azure Mistral OCR requests', async () => {
        process.env.PROXY = 'http://proxy.example.com:8080';

        mockLoadAuthValues.mockResolvedValue({
          OCR_API_KEY: 'azure-api-key',
          OCR_BASEURL: 'https://azure.mistral.ai/v1',
        });

        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Azure OCR with proxy',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${OCR_API_KEY}',
              baseURL: '${OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/azure-file.pdf',
          originalname: 'azure-document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadAzureMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        expect(mockAxios.post).toHaveBeenCalledWith(
          'https://azure.mistral.ai/v1/ocr',
          expect.anything(),
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'http://proxy.example.com:8080',
            }),
          }),
        );
      });
    });

    describe('getSignedUrl with proxy', () => {
      it('should use proxy configuration when PROXY env var is set', async () => {
        process.env.PROXY = 'https://secure-proxy.example.com:443';

        const mockResponse: { data: MistralSignedUrlResponse } = {
          data: {
            url: 'https://signed-url.com',
            expires_at: Date.now() + 86400000,
          },
        };
        mockAxios.get!.mockResolvedValueOnce(mockResponse);

        await getSignedUrl({
          fileId: 'file-123',
          apiKey: 'test-api-key',
        });

        expect(mockAxios.get).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files/file-123/url?expiry=24',
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'https://secure-proxy.example.com:443',
            }),
          }),
        );
      });
    });

    describe('deleteMistralFile with proxy', () => {
      it('should use proxy configuration when PROXY env var is set', async () => {
        process.env.PROXY = 'socks5://proxy.example.com:1080';

        mockAxios.delete!.mockResolvedValueOnce({ data: {} });

        await deleteMistralFile({
          fileId: 'file-123',
          apiKey: 'test-api-key',
        });

        expect(mockAxios.delete).toHaveBeenCalledWith(
          'https://api.mistral.ai/v1/files/file-123',
          expect.objectContaining({
            httpsAgent: expect.objectContaining({
              proxyUrl: 'socks5://proxy.example.com:1080',
            }),
          }),
        );
      });
    });
  });

  describe('uploadGoogleVertexMistralOCR protected logging', () => {
    it('does not log Vertex response content when file protection is active', async () => {
      jest.mocked(loadServiceKey).mockResolvedValueOnce({
        client_email: 'service-account@example.com',
        private_key: 'mock-private-key',
        project_id: 'project-123',
      });
      (readFileAsBuffer as jest.Mock).mockResolvedValueOnce({
        content: Buffer.from('PRIVATE uploaded bytes'),
        bytes: 22,
      });
      mockAxios
        .post!.mockResolvedValueOnce({ data: { access_token: 'vertex-access-token' } })
        .mockRejectedValueOnce(privateProviderError());
      const req = {
        user: { id: 'user123' },
        config: {
          filters: protectedFilters,
          ocr: { mistralModel: 'mistral-ocr-2505' },
        },
      } as unknown as ServerRequest;
      const file = {
        path: '/tmp/upload/private.pdf',
        originalname: 'PRIVATE-document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      let thrownError: unknown;
      try {
        await uploadGoogleVertexMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe(
        'Error uploading document to Google Vertex AI Mistral OCR:',
      );
      expect(mockedLogAxiosError).not.toHaveBeenCalled();
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });
  });

  describe('uploadAzureMistralOCR', () => {
    beforeEach(() => {
      (readFileAsBuffer as jest.Mock).mockResolvedValue({
        content: Buffer.from('mock-file-content'),
        bytes: Buffer.from('mock-file-content').length,
      });
      // Reset the HttpsProxyAgent mock to its default implementation for Azure tests
      (HttpsProxyAgent as unknown as jest.Mock).mockImplementation((url) => ({ proxyUrl: url }));
      // Clean up any PROXY env var from previous tests
      delete process.env.PROXY;
      // Reset axios mocks completely to clear any queued responses
      mockAxios.post!.mockReset();
      mockAxios.get!.mockReset();
      mockAxios.delete!.mockReset();
      // Re-establish default resolved values
      mockAxios.post!.mockResolvedValue({ data: {} });
      mockAxios.get!.mockResolvedValue({ data: {} });
      mockAxios.delete!.mockResolvedValue({ data: {} });
    });

    it('should process OCR using Azure Mistral with base64 encoding', async () => {
      mockLoadAuthValues.mockResolvedValue({
        OCR_API_KEY: 'azure-api-key',
        OCR_BASEURL: 'https://azure.mistral.ai/v1',
      });

      // Mock OCR response
      mockAxios.post!.mockResolvedValueOnce({
        data: {
          model: 'mistral-ocr-latest',
          pages: [
            {
              index: 0,
              markdown: 'Azure OCR content',
              images: [
                {
                  id: 'azure1',
                  top_left_x: 0,
                  top_left_y: 0,
                  bottom_right_x: 100,
                  bottom_right_y: 100,
                  image_base64: 'azure-base64',
                  image_annotation: '',
                },
              ],
              dimensions: { dpi: 300, height: 1100, width: 850 },
            },
          ],
          document_annotation: '',
          usage_info: {
            pages_processed: 1,
            doc_size_bytes: 1024,
          },
        },
      });

      const req = {
        user: { id: 'user123' },
        config: {
          ocr: {
            apiKey: '${OCR_API_KEY}',
            baseURL: '${OCR_BASEURL}',
            mistralModel: 'mistral-ocr-latest',
          },
        },
      } as unknown as ServerRequest;

      const file = {
        path: '/tmp/upload/azure-file.pdf',
        originalname: 'azure-document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      const result = await uploadAzureMistralOCR({
        req,
        file,
        loadAuthValues: mockLoadAuthValues,
      });

      expect(readFileAsBuffer).toHaveBeenCalledWith('/tmp/upload/azure-file.pdf', {
        fileSize: undefined,
      });

      // Verify OCR was called with base64 data URL
      expect(mockAxios.post).toHaveBeenCalledWith(
        'https://azure.mistral.ai/v1/ocr',
        expect.objectContaining({
          document: expect.objectContaining({
            type: 'document_url',
            document_url: expect.stringMatching(/^data:application\/pdf;base64,/),
          }),
        }),
        expect.any(Object),
      );

      expect(result).toEqual({
        filename: 'azure-document.pdf',
        bytes: expect.any(Number),
        filepath: 'azure_mistral_ocr',
        text: 'Azure OCR content\n\n',
        images: ['azure-base64'],
      });
    });

    it('does not log Azure response content when file protection is active', async () => {
      mockAxios.post!.mockRejectedValueOnce(privateProviderError());
      const req = {
        user: { id: 'user123' },
        config: {
          filters: protectedFilters,
          ocr: {
            apiKey: 'azure-api-key',
            baseURL: 'https://azure.mistral.ai/v1',
          },
        },
      } as unknown as ServerRequest;
      const file = {
        path: '/tmp/upload/private.pdf',
        originalname: 'PRIVATE-document.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;

      let thrownError: unknown;
      try {
        await uploadAzureMistralOCR({ req, file, loadAuthValues: mockLoadAuthValues });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe(
        'Error uploading document to Azure Mistral OCR API:',
      );
      expect(mockedLogAxiosError).not.toHaveBeenCalled();
      expect(JSON.stringify(jest.mocked(mockLogger.error).mock.calls)).not.toContain('PRIVATE');
    });

    describe('Mixed env var and hardcoded configuration', () => {
      beforeEach(() => {
        // Clean up any PROXY env var from previous tests
        delete process.env.PROXY;
      });

      it('should preserve hardcoded baseURL when only apiKey is an env var', async () => {
        // This test demonstrates the current bug
        mockLoadAuthValues.mockResolvedValue({
          AZURE_MISTRAL_OCR_API_KEY: 'test-api-key-from-env',
          // Note: OCR_BASEURL is not returned, simulating it not being set
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-2503',
            pages: [
              {
                index: 0,
                markdown: 'Test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        const req = {
          user: { id: 'user123' },
          config: {
            ocr: {
              apiKey: '${AZURE_MISTRAL_OCR_API_KEY}',
              baseURL: 'https://endpoint.models.ai.azure.com/v1',
              mistralModel: 'mistral-ocr-2503',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadAzureMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        // Check that loadAuthValues was called only with the env var field
        expect(mockLoadAuthValues).toHaveBeenCalledWith({
          userId: 'user123',
          authFields: ['AZURE_MISTRAL_OCR_API_KEY'],
          optional: expect.any(Set),
        });

        // The fix: baseURL should be the hardcoded value
        const ocrCall = mockAxios.post!.mock.calls[0];
        expect(ocrCall[0]).toBe('https://endpoint.models.ai.azure.com/v1/ocr');
      });

      it('should preserve hardcoded apiKey when only baseURL is an env var', async () => {
        // This test demonstrates the current bug
        mockLoadAuthValues.mockResolvedValue({
          CUSTOM_OCR_BASEURL: 'https://custom-ocr-endpoint.com/v1',
          // Note: OCR_API_KEY is not returned, simulating it not being set
        });

        // Mock OCR response
        mockAxios.post!.mockResolvedValueOnce({
          data: {
            model: 'mistral-ocr-latest',
            pages: [
              {
                index: 0,
                markdown: 'Test content',
                images: [],
                dimensions: { dpi: 300, height: 1100, width: 850 },
              },
            ],
            document_annotation: '',
            usage_info: {
              pages_processed: 1,
              doc_size_bytes: 1024,
            },
          },
        });

        const req = {
          user: { id: 'user456' },
          config: {
            ocr: {
              apiKey: 'hardcoded-api-key-12345',
              baseURL: '${CUSTOM_OCR_BASEURL}',
              mistralModel: 'mistral-ocr-latest',
            },
          },
        } as unknown as ServerRequest;

        const file = {
          path: '/tmp/upload/file.pdf',
          originalname: 'document.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File;

        await uploadAzureMistralOCR({
          req,
          file,
          loadAuthValues: mockLoadAuthValues,
        });

        // Check that loadAuthValues was called only with the env var field
        expect(mockLoadAuthValues).toHaveBeenCalledWith({
          userId: 'user456',
          authFields: ['CUSTOM_OCR_BASEURL'],
          optional: expect.any(Set),
        });

        // The fix: apiKey should be the hardcoded value
        const ocrCall = mockAxios.post!.mock.calls[0];
        const authHeader = ocrCall[2]?.headers?.Authorization;
        expect(authHeader).toBe('Bearer hardcoded-api-key-12345');
      });
    });
  });

  describe('SSRF connect-time guard', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.PROXY;
    });

    it('blocks a literal private-IP baseURL with ESSRF', async () => {
      await expect(
        performOCR({
          apiKey: 'k',
          url: 'https://document-url.com',
          baseURL: 'http://10.0.0.5:8080',
        }),
      ).rejects.toMatchObject({ code: 'ESSRF' });
    });

    it('exempts a literal private IP present in ocr.allowedAddresses', async () => {
      mockAxios.post!.mockResolvedValueOnce({ data: { pages: [] } });
      await performOCR({
        apiKey: 'k',
        url: 'https://document-url.com',
        baseURL: 'http://10.0.0.5:8080',
        allowedAddresses: ['10.0.0.5:8080'],
      });

      const config = mockAxios.post!.mock.calls[0][2] as {
        httpAgent?: unknown;
        maxRedirects?: number;
      };
      expect(config.httpAgent).toBeDefined();
      expect(config.maxRedirects).toBe(0);
    });

    it('does not open the upload file stream when the OCR target is a blocked literal private IP', async () => {
      (jest.mocked(fs).createReadStream as jest.Mock).mockClear();
      await expect(
        uploadDocumentToMistral({
          apiKey: 'k',
          filePath: '/tmp/doc.pdf',
          baseURL: 'http://10.0.0.5:8080',
        }),
      ).rejects.toMatchObject({ code: 'ESSRF' });
      expect(jest.mocked(fs).createReadStream).not.toHaveBeenCalled();
    });

    it('preserves proxy precedence and still disables redirects', async () => {
      process.env.PROXY = 'http://proxy.example.com:8080';
      mockAxios.post!.mockResolvedValueOnce({ data: { pages: [] } });
      await performOCR({
        apiKey: 'k',
        url: 'https://document-url.com',
        baseURL: 'https://api.mistral.ai/v1',
      });

      const config = mockAxios.post!.mock.calls[0][2] as {
        maxRedirects?: number;
        httpsAgent?: { proxyUrl?: string };
        httpAgent?: unknown;
      };
      expect(config.maxRedirects).toBe(0);
      expect(config.httpsAgent?.proxyUrl).toBe('http://proxy.example.com:8080');
      expect(config.httpAgent).toBeUndefined();
    });
  });
});
