const { splitTextIntoChunks } = require('./streamAudio');

jest.mock('keyv');

const globalCache = {};
jest.mock('~/models', () => {
  return {
    getMessage: jest.fn().mockImplementation((messageId) => {
      return globalCache[messageId] || null;
    }),
  };
});
jest.mock('~/cache/getLogStores', () => {
  return jest.fn().mockImplementation(() => {
    const EventEmitter = require('events');
    const { CacheKeys } = require('librechat-data-provider');

    class KeyvMongo extends EventEmitter {
      constructor(url = 'mongodb://127.0.0.1:27017', options) {
        super();
        this.ttlSupport = false;
        url = url ?? {};
        if (typeof url === 'string') {
          url = { url };
        }
        if (url.uri) {
          url = { url: url.uri, ...url };
        }
        this.opts = {
          url,
          collection: 'keyv',
          ...url,
          ...options,
        };
      }

      get = async (key) => {
        return new Promise((resolve) => {
          resolve(globalCache[key] || null);
        });
      };

      set = async (key, value) => {
        return new Promise((resolve) => {
          globalCache[key] = value;
          resolve(true);
        });
      };
    }

    return new KeyvMongo('', {
      namespace: CacheKeys.MESSAGES,
      ttl: 0,
    });
  });
});

describe('splitTextIntoChunks', () => {
  test('splits text into chunks of specified size with default separators', () => {
    const text = 'This is a test. This is only a test! Make sure it works properly? Okay.';
    const chunkSize = 20;
    const expectedChunks = [
      { text: 'This is a test.', isFinished: false },
      { text: 'This is only a test!', isFinished: false },
      { text: 'Make sure it works p', isFinished: false },
      { text: 'roperly? Okay.', isFinished: true },
    ];

    const result = splitTextIntoChunks(text, chunkSize);
    expect(result).toEqual(expectedChunks);
  });

  test('splits text into chunks with default size', () => {
    const text = 'A'.repeat(8000) + '. The end.';
    const expectedChunks = [
      { text: 'A'.repeat(4000), isFinished: false },
      { text: 'A'.repeat(4000), isFinished: false },
      { text: '. The end.', isFinished: true },
    ];

    const result = splitTextIntoChunks(text);
    expect(result).toEqual(expectedChunks);
  });

  test('returns a single chunk if text length is less than chunk size', () => {
    const text = 'Short text.';
    const expectedChunks = [{ text: 'Short text.', isFinished: true }];

    const result = splitTextIntoChunks(text, 4000);
    expect(result).toEqual(expectedChunks);
  });

  test('handles text with no separators correctly', () => {
    const text = 'ThisTextHasNoSeparatorsAndIsVeryLong'.repeat(100);
    const chunkSize = 4000;
    const expectedChunks = [{ text: text, isFinished: true }];

    const result = splitTextIntoChunks(text, chunkSize);
    expect(result).toEqual(expectedChunks);
  });

  test('throws an error when text is empty', () => {
    expect(() => splitTextIntoChunks('')).toThrow('Text is required');
  });
});
