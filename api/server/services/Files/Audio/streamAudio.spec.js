const { createChunkProcessor, splitTextIntoChunks } = require('./streamAudio');

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

describe('processChunks', () => {
  let processChunks;
  let mockMessageCache;

  beforeEach(() => {
    jest.resetAllMocks();
    mockMessageCache = {
      get: jest.fn(),
      set: jest.fn(),
    };
    require('~/cache/getLogStores').mockReturnValue(mockMessageCache);
    processChunks = createChunkProcessor('userId', 'message-id');
  });

  it('should return an empty array when the message is not found', async () => {
    mockMessageCache.get.mockResolvedValueOnce(null);

    const result = await processChunks();

    expect(result).toEqual([]);
    expect(mockMessageCache.get).toHaveBeenCalledWith('message-id');
  });

  it('should return an error message after MAX_NOT_FOUND_COUNT attempts', async () => {
    mockMessageCache.get.mockResolvedValue(null);

    for (let i = 0; i < 6; i++) {
      await processChunks();
    }
    const result = await processChunks();

    expect(result).toBe('Message not found after 6 attempts');
  });

  it('should return chunks for an incomplete message with separators', async () => {
    const messageText = 'This is a long message. It should be split into chunks. Lol hi mom';
    mockMessageCache.get.mockResolvedValueOnce({ text: messageText, complete: false });

    const result = await processChunks();

    expect(result).toEqual([
      { text: 'This is a long message. It should be split into chunks.', isFinished: false },
    ]);
  });

  it('should return chunks for an incomplete message without separators', async () => {
    const messageText = 'This is a long message without separators hello there my friend';
    mockMessageCache.get.mockResolvedValueOnce({ text: messageText, complete: false });

    const result = await processChunks();

    expect(result).toEqual([{ text: messageText, isFinished: false }]);
  });

  it('should return the remaining text as a chunk for a complete message', async () => {
    const messageText = 'This is a finished message.';
    mockMessageCache.get.mockResolvedValueOnce({ text: messageText, complete: true });

    const result = await processChunks();

    expect(result).toEqual([{ text: messageText, isFinished: true }]);
  });

  it('should return an empty array for a complete message with no remaining text', async () => {
    const messageText = 'This is a finished message.';
    mockMessageCache.get.mockResolvedValueOnce({ text: messageText, complete: true });

    await processChunks();
    mockMessageCache.get.mockResolvedValueOnce({ text: messageText, complete: true });
    const result = await processChunks();

    expect(result).toEqual([]);
  });

  it('should return an error message after MAX_NO_CHANGE_COUNT attempts with no change', async () => {
    const messageText = 'This is a message that does not change.';
    mockMessageCache.get.mockResolvedValue({ text: messageText, complete: false });

    for (let i = 0; i < 11; i++) {
      await processChunks();
    }
    const result = await processChunks();

    expect(result).toBe('No change in message after 10 attempts');
  });

  /** An aborted turn persists `text` with its reasoning alongside the content parts. */
  it('should not speak the reasoning of a stored message', async () => {
    mockMessageCache.get.mockResolvedValueOnce(null);
    require('~/models').getMessage.mockResolvedValueOnce({
      text: 'Let me work this out. The answer is 4.',
      content: [
        { type: 'think', think: 'Let me work this out.' },
        { type: 'text', text: 'The answer is 4.' },
      ],
    });

    const result = await processChunks();

    expect(result).toEqual([{ text: 'The answer is 4.', isFinished: true }]);
  });

  it('should handle string messages as incomplete', async () => {
    const messageText = 'This is a message as a string.';
    mockMessageCache.get.mockResolvedValueOnce(messageText);

    const result = await processChunks();

    expect(result).toEqual([{ text: messageText, isFinished: false }]);
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
