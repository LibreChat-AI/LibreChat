import { logger } from '@librechat/data-schemas';
import type { Redis } from 'ioredis';
import { createMockPublisher } from './helpers/publisher';

logger.silent = true;

function createMockSubscriber() {
  return {
    on: jest.fn(),
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
  };
}

function getMessageHandler(mockSubscriber: ReturnType<typeof createMockSubscriber>) {
  return mockSubscriber.on.mock.calls.find((call) => call[0] === 'message')?.[1] as (
    channel: string,
    message: string,
  ) => void;
}

interface SequencedTestMessage {
  type: 'chunk' | 'done' | 'error';
  seq: number;
  data?: object;
}

function deliverSequencedMessage(
  handler: ReturnType<typeof getMessageHandler>,
  channel: string,
  message: SequencedTestMessage,
): void {
  handler(channel, JSON.stringify(message));
}

/** Load RedisEventTransport with the given REDIS_CHANNEL_PREFIX env var.
 * Isolates the module cache so the prefix is picked up at import time. */
function loadTransport(
  prefix?: string,
): typeof import('~/stream/implementations/RedisEventTransport') {
  if (prefix !== undefined) {
    process.env.REDIS_CHANNEL_PREFIX = prefix;
  } else {
    delete process.env.REDIS_CHANNEL_PREFIX;
  }
  let mod: typeof import('~/stream/implementations/RedisEventTransport');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('~/stream/implementations/RedisEventTransport');
  });
  return mod!;
}

describe('RedisEventTransport channel prefix', () => {
  afterEach(() => {
    delete process.env.REDIS_CHANNEL_PREFIX;
    jest.resetModules();
  });

  it('uses unprefixed channels when REDIS_CHANNEL_PREFIX is not set', () => {
    const { RedisEventTransport } = loadTransport();
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    // Subscribe should use the unprefixed channel
    expect(subscriber.subscribe).toHaveBeenCalledWith('stream:{test-stream}:events');

    // Simulate a message on the unprefixed channel
    const handler = getMessageHandler(subscriber);
    deliverSequencedMessage(handler, 'stream:{test-stream}:events', {
      type: 'chunk',
      seq: 0,
      data: { delta: 'hello' },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ delta: 'hello' });
  });

  it('prefixes channel names when REDIS_CHANNEL_PREFIX is set', () => {
    const { RedisEventTransport } = loadTransport('base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    // The subscribe call should use the prefixed channel
    expect(subscriber.subscribe).toHaveBeenCalledWith('base::stream:{test-stream}:events');

    // Simulate a message on the prefixed channel — should be delivered
    const handler = getMessageHandler(subscriber);
    deliverSequencedMessage(handler, 'base::stream:{test-stream}:events', {
      type: 'chunk',
      seq: 0,
      data: { delta: 'hello' },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ delta: 'hello' });
  });

  it('ignores unprefixed channels when prefix is set', () => {
    const { RedisEventTransport } = loadTransport('base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    // An unprefixed channel message should NOT be delivered
    const handler = getMessageHandler(subscriber);
    deliverSequencedMessage(handler, 'stream:{test-stream}:events', {
      type: 'chunk',
      seq: 0,
      data: { delta: 'hello' },
    });

    expect(onChunk).not.toHaveBeenCalled();
  });

  it('ignores messages on wrong prefix', () => {
    const { RedisEventTransport } = loadTransport('base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    // A message with a different prefix should NOT be delivered
    const handler = getMessageHandler(subscriber);
    deliverSequencedMessage(handler, 'other:stream:{test-stream}:events', {
      type: 'chunk',
      seq: 0,
      data: { delta: 'hello' },
    });

    expect(onChunk).not.toHaveBeenCalled();
  });

  it('passes prefixed channel to eval for Lua publish', async () => {
    const { RedisEventTransport } = loadTransport('base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    // Emit a chunk — the eval mock should receive the prefixed channel as ARGV
    await transport.emitChunk('test-stream', { delta: 'hello' });

    // eval is called with: script, numKeys, key1, key2, key3, channel, ...
    const evalCall = publisher.eval.mock.calls[0];
    const channelArg = evalCall[5]; // index 5 = channel (after 3 keys)
    expect(channelArg).toBe('base::stream:{test-stream}:events');
  });

  it('handles prefix with regex special characters', () => {
    const { RedisEventTransport } = loadTransport('tenant.base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    const onChunk = jest.fn();
    transport.subscribe('test-stream', { onChunk });

    expect(subscriber.subscribe).toHaveBeenCalledWith('tenant.base::stream:{test-stream}:events');

    const handler = getMessageHandler(subscriber);
    deliverSequencedMessage(handler, 'tenant.base::stream:{test-stream}:events', {
      type: 'chunk',
      seq: 0,
      data: { delta: 'hello' },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('passes prefixed channel to publish (non-Lua publish path)', async () => {
    const { RedisEventTransport } = loadTransport('base');
    const publisher = createMockPublisher();
    const subscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      publisher as unknown as Redis,
      subscriber as unknown as Redis,
    );

    // publishAbortAcknowledgement uses publisher.publish directly
    await transport.publishAbortAcknowledgement('test-stream', 1, 'req-123');

    expect(publisher.publish).toHaveBeenCalledWith(
      'base::stream:{test-stream}:events',
      expect.any(String),
    );
  });
});
