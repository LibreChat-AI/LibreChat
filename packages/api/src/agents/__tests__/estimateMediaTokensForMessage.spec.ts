import { estimateMediaTokensForMessage } from '../client';

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  extractImageDimensions: jest.fn((data: string) => {
    if (data.includes('VALID_PNG')) {
      return { width: 800, height: 600 };
    }
    return null;
  }),
  estimateAnthropicImageTokens: jest.fn((w: number, h: number) => Math.ceil((w * h) / 750)),
  estimateOpenAIImageTokens: jest.fn((w: number, h: number) => Math.ceil((w * h) / 512) + 85),
}));

const fakeTokenCount = (text: string) => Math.ceil(text.length / 4);

describe('estimateMediaTokensForMessage', () => {
  describe('non-array content', () => {
    it('returns 0 for string content', () => {
      expect(estimateMediaTokensForMessage('hello', false)).toBe(0);
    });

    it('returns 0 for null', () => {
      expect(estimateMediaTokensForMessage(null, false)).toBe(0);
    });

    it('returns 0 for undefined', () => {
      expect(estimateMediaTokensForMessage(undefined, true)).toBe(0);
    });

    it('returns 0 for a number', () => {
      expect(estimateMediaTokensForMessage(42, false)).toBe(0);
    });
  });

  describe('empty and malformed arrays', () => {
    it('returns 0 for an empty array', () => {
      expect(estimateMediaTokensForMessage([], false)).toBe(0);
    });

    it('skips null entries', () => {
      expect(estimateMediaTokensForMessage([null, undefined], false)).toBe(0);
    });

    it('skips entries without a string type', () => {
      expect(estimateMediaTokensForMessage([{ type: 123 }, { text: 'hi' }], false)).toBe(0);
    });

    it('skips text-only blocks (not media)', () => {
      expect(estimateMediaTokensForMessage([{ type: 'text', text: 'hi' }], false)).toBe(0);
    });
  });

  describe('image_url blocks', () => {
    it('falls back to 1024 for a remote URL (non-data)', () => {
      const content = [{ type: 'image_url', image_url: 'https://example.com/img.png' }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(1024);
    });

    it('falls back to 1024 when image_url is an object with non-data URL', () => {
      const content = [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }];
      expect(estimateMediaTokensForMessage(content, true)).toBe(1024);
    });

    it('falls back to 1024 when base64 data cannot be decoded', () => {
      const content = [{ type: 'image_url', image_url: 'data:image/png;base64,SHORT' }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(1024);
    });

    it('estimates tokens from decoded dimensions (OpenAI path)', () => {
      const content = [
        { type: 'image_url', image_url: 'data:image/png;base64,VALID_PNG_LONG_DATA' },
      ];
      const result = estimateMediaTokensForMessage(content, false);
      expect(result).toBeGreaterThan(0);
      expect(result).not.toBe(1024);
    });

    it('estimates tokens from decoded dimensions (Claude path)', () => {
      const content = [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,VALID_PNG_LONG_DATA' } },
      ];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBeGreaterThan(0);
      expect(result).not.toBe(1024);
    });
  });

  describe('image blocks (Anthropic format)', () => {
    it('falls back to 1024 when source is not base64', () => {
      const content = [{ type: 'image', source: { type: 'url', data: 'https://example.com' } }];
      expect(estimateMediaTokensForMessage(content, true)).toBe(1024);
    });

    it('falls back to 1024 when dimensions cannot be extracted', () => {
      const content = [{ type: 'image', source: { type: 'base64', data: 'INVALID' } }];
      expect(estimateMediaTokensForMessage(content, true)).toBe(1024);
    });

    it('estimates tokens from valid base64 image data', () => {
      const content = [{ type: 'image', source: { type: 'base64', data: 'VALID_PNG' } }];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBeGreaterThan(0);
      expect(result).not.toBe(1024);
    });
  });

  describe('image_file blocks', () => {
    it('falls back to 1024 (no base64 extraction path)', () => {
      const content = [{ type: 'image_file', file_id: 'file-abc' }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(1024);
    });
  });

  describe('document blocks - LangChain format (source_type)', () => {
    it('counts tokens for text source_type with getTokenCount', () => {
      const content = [
        {
          type: 'document',
          source_type: 'text',
          text: 'a'.repeat(400),
        },
      ];
      expect(estimateMediaTokensForMessage(content, false, fakeTokenCount)).toBe(100);
    });

    it('falls back to length/4 without getTokenCount', () => {
      const content = [
        {
          type: 'document',
          source_type: 'text',
          text: 'a'.repeat(400),
        },
      ];
      expect(estimateMediaTokensForMessage(content, false)).toBe(100);
    });

    it('estimates PDF pages for base64 source_type with application/pdf mime', () => {
      const pdfData = 'x'.repeat(150_000);
      const content = [
        {
          type: 'document',
          source_type: 'base64',
          data: pdfData,
          mime_type: 'application/pdf',
        },
      ];
      const result = estimateMediaTokensForMessage(content, false);
      expect(result).toBe(2 * 1500);
    });

    it('uses Claude PDF rate when isClaude is true', () => {
      const pdfData = 'x'.repeat(150_000);
      const content = [
        {
          type: 'document',
          source_type: 'base64',
          data: pdfData,
          mime_type: 'application/pdf',
        },
      ];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBe(2 * 2000);
    });

    it('defaults to PDF estimation for empty mime_type', () => {
      const pdfData = 'x'.repeat(10);
      const content = [
        {
          type: 'document',
          source_type: 'base64',
          data: pdfData,
          mime_type: '',
        },
      ];
      const result = estimateMediaTokensForMessage(content, false);
      expect(result).toBe(1 * 1500);
    });

    it('handles image/* mime inside base64 source_type', () => {
      const content = [
        {
          type: 'document',
          source_type: 'base64',
          data: 'VALID_PNG',
          mime_type: 'image/png',
        },
      ];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBeGreaterThan(0);
      expect(result).not.toBe(1024);
    });

    it('falls back to 1024 for undecodable image in base64 source_type', () => {
      const content = [
        {
          type: 'document',
          source_type: 'base64',
          data: 'BAD_DATA',
          mime_type: 'image/jpeg',
        },
      ];
      expect(estimateMediaTokensForMessage(content, false)).toBe(1024);
    });

    it('falls back to URL_DOCUMENT_FALLBACK_TOKENS for unrecognized source_type', () => {
      const content = [{ type: 'document', source_type: 'url' }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(2000);
    });
  });

  describe('document blocks - Anthropic format (source object)', () => {
    it('counts tokens for text source type with getTokenCount', () => {
      const content = [
        {
          type: 'document',
          source: { type: 'text', data: 'a'.repeat(800) },
        },
      ];
      expect(estimateMediaTokensForMessage(content, true, fakeTokenCount)).toBe(200);
    });

    it('falls back to length/4 for text source without getTokenCount', () => {
      const content = [
        {
          type: 'document',
          source: { type: 'text', data: 'a'.repeat(800) },
        },
      ];
      expect(estimateMediaTokensForMessage(content, true)).toBe(200);
    });

    it('estimates PDF pages for base64 source with application/pdf', () => {
      const pdfData = 'x'.repeat(225_000);
      const content = [
        {
          type: 'document',
          source: { type: 'base64', data: pdfData, media_type: 'application/pdf' },
        },
      ];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBe(3 * 2000);
    });

    it('returns URL fallback for url source type', () => {
      const content = [
        {
          type: 'document',
          source: { type: 'url' },
        },
      ];
      expect(estimateMediaTokensForMessage(content, false)).toBe(2000);
    });

    it('handles content source type with nested images', () => {
      const content = [
        {
          type: 'document',
          source: {
            type: 'content',
            content: [
              { type: 'image', source: { type: 'base64', data: 'VALID_PNG' } },
              { type: 'image', source: { type: 'base64', data: 'UNDECODABLE' } },
            ],
          },
        },
      ];
      const result = estimateMediaTokensForMessage(content, true);
      expect(result).toBeGreaterThan(1024);
    });

    it('falls back to URL_DOCUMENT_FALLBACK_TOKENS when source has unknown type', () => {
      const content = [{ type: 'document', source: { type: 'unknown_format' } }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(2000);
    });
  });

  describe('file blocks', () => {
    it('uses same logic as document for file type blocks', () => {
      const content = [
        {
          type: 'file',
          source_type: 'text',
          text: 'a'.repeat(120),
        },
      ];
      expect(estimateMediaTokensForMessage(content, false, fakeTokenCount)).toBe(30);
    });

    it('falls back to URL_DOCUMENT_FALLBACK_TOKENS for file without source info', () => {
      const content = [{ type: 'file' }];
      expect(estimateMediaTokensForMessage(content, false)).toBe(2000);
    });
  });

  describe('mixed content arrays', () => {
    it('sums tokens across multiple media blocks', () => {
      const content = [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: 'https://example.com/img.png' },
        { type: 'image_file', file_id: 'f1' },
        { type: 'document', source: { type: 'url' } },
      ];
      const result = estimateMediaTokensForMessage(content, false);
      expect(result).toBe(1024 + 1024 + 2000);
    });
  });
});
