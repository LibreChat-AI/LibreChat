jest.mock('./crud', () => ({
  uploadVectors: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { uploadVectors } = require('./crud');
const { logger } = require('@librechat/data-schemas');
const { isTextBearingMimeType, tryEmbedChatAttachment } = require('./autoEmbed');

describe('VectorDB/autoEmbed', () => {
  const originalEnv = process.env.RAG_API_URL;

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = originalEnv;
    }
  });

  describe('isTextBearingMimeType', () => {
    test.each([
      ['application/pdf', true],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', true],
      ['application/msword', true],
      ['application/vnd.ms-excel', true],
      ['application/vnd.ms-powerpoint', true],
      ['text/plain', true],
      ['text/markdown', true],
      ['text/csv', true],
      ['text/html', true],
      ['application/json', true],
      ['application/xml', true],
      ['text/x-python', true],
      ['application/x-sh', true],
      ['application/epub+zip', true],
    ])('returns true for text-bearing type %s', (mimetype, expected) => {
      expect(isTextBearingMimeType(mimetype)).toBe(expected);
    });

    test.each([
      ['image/png', false],
      ['image/jpeg', false],
      ['image/gif', false],
      ['image/webp', false],
      ['image/svg+xml', false],
      ['audio/mp3', false],
      ['audio/mpeg', false],
      ['audio/wav', false],
      ['video/mp4', false],
      ['video/webm', false],
      ['', false],
      [undefined, false],
      [null, false],
    ])('returns false for non-text type %s', (mimetype, expected) => {
      expect(isTextBearingMimeType(mimetype)).toBe(expected);
    });
  });

  describe('tryEmbedChatAttachment', () => {
    const req = { user: { id: 'user-1' } };
    const file = { path: '/tmp/test.pdf', mimetype: 'application/pdf', size: 100, originalname: 'test.pdf' };
    const baseParams = { req, file, file_id: 'fid-1', entity_id: 'conv-1' };

    test('returns embedded:false when RAG_API_URL not configured', async () => {
      delete process.env.RAG_API_URL;

      const result = await tryEmbedChatAttachment(baseParams);

      expect(result).toEqual({ embedded: false });
      expect(uploadVectors).not.toHaveBeenCalled();
    });

    test('returns embedded:true on successful embed', async () => {
      process.env.RAG_API_URL = 'http://rag-api';
      uploadVectors.mockResolvedValueOnce({ embedded: true, bytes: 100 });

      const result = await tryEmbedChatAttachment(baseParams);

      expect(result).toEqual({ embedded: true });
      expect(uploadVectors).toHaveBeenCalledWith({
        req,
        file,
        file_id: 'fid-1',
        entity_id: 'conv-1',
      });
    });

    test('returns embedded:false on rag-api error without throwing (graceful degradation)', async () => {
      process.env.RAG_API_URL = 'http://rag-api';
      uploadVectors.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await tryEmbedChatAttachment(baseParams);

      expect(result).toEqual({ embedded: false });
      expect(logger.warn).toHaveBeenCalled();
    });

    test('returns embedded:false when rag-api reports unknown type', async () => {
      process.env.RAG_API_URL = 'http://rag-api';
      uploadVectors.mockResolvedValueOnce({ embedded: false, bytes: 100 });

      const result = await tryEmbedChatAttachment(baseParams);

      expect(result).toEqual({ embedded: false });
    });
  });
});
