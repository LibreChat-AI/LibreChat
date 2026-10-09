import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { SpeechMessageCache } from './speech';
import { createSpeechChunkProcessor } from './speech';

const messageId = 'message-id';

function setup(stored: TMessage | null = null) {
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
