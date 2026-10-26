import { logger } from '@librechat/data-schemas';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { SpeechMessageCache } from './speech';
import { capSpeechInput, createSpeechChunkProcessor, DEFAULT_TTS_MAX_INPUT_CHARS } from './speech';

const messageId = 'message-id';

function setup(stored: TMessage | null = null, maxInputChars?: number) {
  const entries = new Map<string, Parameters<SpeechMessageCache['set']>[1]>();
  const cache = {
    get: jest.fn(async (key: string) => entries.get(key)),
    set: jest.fn((key: string, value: Parameters<SpeechMessageCache['set']>[1]) =>
      entries.set(key, value),
    ),
  };
  const getMessage = jest.fn(async () => stored);
  const processChunks = createSpeechChunkProcessor({
    user: 'user-id',
    messageId,
    cache,
    getMessage,
    maxInputChars,
  });
  return { cache, getMessage, processChunks };
}

describe('createSpeechChunkProcessor', () => {
  it('requires a message id', () => {
    expect(() =>
      createSpeechChunkProcessor({
        user: 'user-id',
        cache: { get: jest.fn(), set: jest.fn() },
        getMessage: jest.fn(),
      }),
    ).toThrow('Message ID is required');
  });

  it('returns no chunks while the message is not found', async () => {
    const { cache, getMessage, processChunks } = setup();

    expect(await processChunks()).toEqual([]);
    expect(cache.get).toHaveBeenCalledWith(messageId);
    expect(getMessage).toHaveBeenCalledWith({ user: 'user-id', messageId });
  });

  it('gives up after the message stays missing', async () => {
    const { processChunks } = setup();

    for (let i = 0; i < 6; i++) {
      await processChunks();
    }

    expect(await processChunks()).toBe('Message not found after 6 attempts');
  });

  it('splits an incomplete message at its last separator', async () => {
    const { cache, processChunks } = setup();
    cache.get.mockResolvedValueOnce({
      text: 'This is a long message. It should be split into chunks. Lol hi mom',
      complete: false,
    });

    expect(await processChunks()).toEqual([
      { text: 'This is a long message. It should be split into chunks.', isFinished: false },
    ]);
  });

  it('finishes a message that reaches the cap exactly', async () => {
    const { cache, processChunks } = setup(null, 10);
    cache.get.mockResolvedValueOnce({ text: 'Ten chars.', complete: false });

    expect(await processChunks()).toEqual([{ text: 'Ten chars.', isFinished: true }]);
  });

  it('stops a message longer than the cap at the cap', async () => {
    const { cache, processChunks } = setup(null, 10);
    cache.get.mockResolvedValueOnce({ text: 'Twelve chars and then some more', complete: false });

    expect(await processChunks()).toEqual([{ text: 'Twelve cha', isFinished: true }]);
  });

  it('sends an incomplete message without separators whole', async () => {
    const text = 'This is a long message without separators hello there my friend';
    const { cache, processChunks } = setup();
    cache.get.mockResolvedValueOnce({ text, complete: false });

    expect(await processChunks()).toEqual([{ text, isFinished: false }]);
  });

  it('finishes with the remaining text of a complete message', async () => {
    const text = 'This is a finished message.';
    const { cache, processChunks } = setup();
    cache.get.mockResolvedValueOnce({ text, complete: true });

    expect(await processChunks()).toEqual([{ text, isFinished: true }]);
    expect(await processChunks()).toEqual([]);
  });

  it('gives up after the message stops changing', async () => {
    const { cache, processChunks } = setup();
    cache.get.mockResolvedValue({ text: 'This message does not change.', complete: false });

    for (let i = 0; i < 11; i++) {
      await processChunks();
    }

    expect(await processChunks()).toBe('No change in message after 10 attempts');
  });

  it('treats a cached string as incomplete', async () => {
    const text = 'This is a message as a string.';
    const { cache, processChunks } = setup();
    cache.get.mockResolvedValueOnce(text);

    expect(await processChunks()).toEqual([{ text, isFinished: false }]);
  });

  /** An aborted turn persists `text` with its reasoning alongside the content parts. */
  it('never speaks the reasoning of a stored message', async () => {
    const { processChunks } = setup({
      messageId,
      text: 'Let me work this out. The answer is 4.',
      content: [
        { type: ContentTypes.THINK, think: 'Let me work this out.' },
        { type: ContentTypes.TEXT, text: 'The answer is 4.' },
      ],
    } as TMessage);

    expect(await processChunks()).toEqual([{ text: 'The answer is 4.', isFinished: true }]);
  });
});

describe('capSpeechInput', () => {
  it('keeps text within the default cap whole', () => {
    const text = 'a'.repeat(DEFAULT_TTS_MAX_INPUT_CHARS);
    expect(capSpeechInput(text)).toBe(text);
  });

  it.each([['a', 'b'], { length: 5 }, 42, undefined])(
    'treats a non-text body (%j) as empty',
    (input) => {
      expect(capSpeechInput(input)).toBe('');
    },
  );

  it('reads text over the configured cap only up to the cap, saying so without the text', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      expect(capSpeechInput('a'.repeat(11), { maxInputChars: 10 })).toBe('a'.repeat(10));
      expect(warn).toHaveBeenCalledWith(
        '[TTS] Text of 11 characters exceeds speech.tts.maxInputChars (10); reading the first 10',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet for text within the cap', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      capSpeechInput('a'.repeat(10), { maxInputChars: 10 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createSpeechChunkProcessor at the cap', () => {
  it('warns once when a message is longer than the cap', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { cache, processChunks } = setup(null, 10);
    cache.get.mockResolvedValue({ text: 'b'.repeat(25), complete: false });
    try {
      await processChunks();
      await processChunks();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[TTS] Text of 25 characters exceeds speech.tts.maxInputChars (10); reading the first 10',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
