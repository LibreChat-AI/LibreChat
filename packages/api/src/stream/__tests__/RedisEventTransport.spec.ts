import { logger } from '@librechat/data-schemas';
import type { Redis } from 'ioredis';
import { emitChunkWithReceipt, emitObservedChunk } from '~/stream/internal/chunkPublication';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { GenerationPublicationFencedError } from '~/stream/interfaces/IJobStore';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
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
  error?: string;
  generationId?: number;
}

function deliverSequencedMessage(
  handler: ReturnType<typeof getMessageHandler>,
  streamId: string,
  message: SequencedTestMessage,
): void {
  handler(`stream:{${streamId}}:events`, JSON.stringify(message));
}

describe('RedisEventTransport', () => {
  it('delivers tagged events and preserves legacy in-memory callback arity', () => {
    const transport = new InMemoryEventTransport();
    const onChunk = jest.fn();
    const onDone = jest.fn();
    const onError = jest.fn();
    const streamId = 'in-memory-terminal-identity';
    const subscription = transport.subscribe(streamId, {
      onChunk,
      onDone,
      onError,
    });
    const taggedChunk = { delta: 'tagged' };
    const legacyChunk = { delta: 'legacy' };
    const taggedDone = { final: 'tagged' };
    const legacyDone = { final: 'legacy' };

    transport.emitChunk(streamId, taggedChunk, 123456);
    transport.emitChunk(streamId, legacyChunk);
    transport.emitDone(streamId, taggedDone, 123456);
    transport.emitDone(streamId, legacyDone);
    transport.emitError(streamId, 'tagged error', 123456);
    transport.emitError(streamId, 'legacy error');

    expect(onChunk).toHaveBeenNthCalledWith(1, taggedChunk, 123456);
    expect(onChunk).toHaveBeenNthCalledWith(2, legacyChunk);
    expect(onDone).toHaveBeenNthCalledWith(1, taggedDone, 123456);
    expect(onDone).toHaveBeenNthCalledWith(2, legacyDone);
    expect(onError).toHaveBeenNthCalledWith(1, 'tagged error', 123456);
    expect(onError).toHaveBeenNthCalledWith(2, 'legacy error');

    subscription.unsubscribe();
    transport.destroy();
  });

  it('round-trips tagged events and preserves legacy Redis callback arity', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'redis-terminal-identity';
    const onChunk = jest.fn();
    const onDone = jest.fn();
    const onError = jest.fn();
    const onAbort = jest.fn();
    const subscription = transport.subscribe(streamId, {
      onChunk,
      onDone,
      onError,
    });
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      messageHandler(channel, payload);
      return 1;
    });

    await subscription.ready;
    await transport.onAbort(streamId, onAbort);
    const taggedChunk = { delta: 'tagged' };
    const legacyChunk = { delta: 'legacy' };
    const taggedDone = { final: 'tagged' };
    const legacyDone = { final: 'legacy' };
    await transport.emitChunk(streamId, taggedChunk, 654321);
    await transport.emitChunk(streamId, legacyChunk);
    await transport.emitDone(streamId, taggedDone, 654321);
    await transport.emitDone(streamId, legacyDone);
    await transport.emitError(streamId, 'tagged error', 654321);
    await transport.emitError(streamId, 'legacy error');
    transport.emitAbort(streamId, 654321);
    transport.emitAbort(streamId);

    expect(onChunk).toHaveBeenNthCalledWith(1, taggedChunk, 654321);
    expect(onChunk).toHaveBeenNthCalledWith(2, legacyChunk);
    expect(onDone).toHaveBeenNthCalledWith(1, taggedDone, 654321);
    expect(onDone).toHaveBeenNthCalledWith(2, legacyDone);
    expect(onError).toHaveBeenNthCalledWith(1, 'tagged error', 654321);
    expect(onError).toHaveBeenNthCalledWith(2, 'legacy error');
    expect(onAbort).toHaveBeenNthCalledWith(1, 654321);
    expect(onAbort).toHaveBeenNthCalledWith(2);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('disposes only the owning abort callback and releases an unused channel', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'abort-registration-disposal';
    const firstAbort = jest.fn();
    const secondAbort = jest.fn();
    const disposeFirst = await transport.onAbort(streamId, firstAbort);
    const disposeSecond = await transport.onAbort(streamId, secondAbort);
    const messageHandler = getMessageHandler(mockSubscriber);
    const channel = `stream:{${streamId}}:events`;

    disposeFirst();
    messageHandler(channel, JSON.stringify({ type: 'abort', generationId: 2 }));

    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).toHaveBeenCalledWith(2);
    expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

    disposeFirst();
    disposeSecond();

    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(channel);

    transport.destroy();
  });

  it('ignores sequenced events while only internal abort listeners are attached', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'abort-only-sequenced-events';
    const onAbort = jest.fn();
    const onPreempt = jest.fn();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      await transport.onAbort(streamId, onAbort);
      await transport.onPreempt(streamId, onPreempt);
      const messageHandler = getMessageHandler(mockSubscriber);

      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 16_119,
        data: { index: 0 },
      });
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'done',
        seq: 16_120,
        data: { final: true },
      });
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'error',
        seq: 16_121,
        error: 'remote error',
      });
      await jest.advanceTimersByTimeAsync(1_000);

      messageHandler(
        `stream:{${streamId}}:events`,
        JSON.stringify({ type: 'abort', generationId: 9 }),
      );
      const preempt = { op: 'arm', createdAt: 10, steerIds: ['steer-1'] };
      messageHandler(`stream:{${streamId}}:events`, JSON.stringify({ type: 'preempt', preempt }));

      expect(onAbort).toHaveBeenCalledWith(9);
      expect(onPreempt).toHaveBeenCalledWith(preempt);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(`Stream ${streamId}:`));
    } finally {
      warn.mockRestore();
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('synchronizes a resumed subscriber after ignoring detached stream traffic', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'abort-only-then-sse';
    const messageHandler = getMessageHandler(mockSubscriber);

    await transport.onAbort(streamId, () => undefined);
    const initial: object[] = [];
    const initialSubscription = transport.subscribe(streamId, {
      onChunk: (event) => initial.push(event as object),
    });
    await initialSubscription.ready;
    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 0,
      data: { index: 0 },
    });
    initialSubscription.unsubscribe();

    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 41,
      data: { ignored: true },
    });

    mockPublisher.get.mockResolvedValueOnce('42');
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferSequenceDelivery: true },
    );
    await subscription.ready;
    await transport.syncReorderBuffer(streamId);

    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 42,
      data: { index: 42 },
    });

    expect(initial).toEqual([{ index: 0 }]);
    expect(received).toEqual([{ index: 42 }]);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('does not let a stale subscription synchronize replacement stream state', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'stale-subscription-sync';
    const stale = transport.subscribe(
      streamId,
      { onChunk: jest.fn() },
      { deferSequenceDelivery: true },
    );
    await stale.ready;
    stale.unsubscribe();
    transport.cleanup(streamId);

    const replacement = transport.subscribe(
      streamId,
      { onChunk: jest.fn() },
      { deferSequenceDelivery: true },
    );
    await replacement.ready;
    mockPublisher.get.mockResolvedValue('0');

    await stale.syncReorderBuffer?.();
    expect(mockPublisher.get).not.toHaveBeenCalled();
    await replacement.syncReorderBuffer?.();
    expect(mockPublisher.get).toHaveBeenCalledTimes(1);

    replacement.unsubscribe();
    transport.destroy();
  });

  it('fences a fresh channel before advancing past attachment-time chunks', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'fresh-attachment-frontier';
    const received: object[] = [];
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.get.mockResolvedValueOnce('6');
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      const parsed = JSON.parse(payload) as { type?: string };
      if (parsed.type === 'subscription_frontier') {
        deliverSequencedMessage(messageHandler, streamId, {
          type: 'chunk',
          seq: 5,
          data: { index: 5 },
        });
        messageHandler(channel, payload);
      }
      return 1;
    });

    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferSequenceDelivery: true, captureSequenceFrontier: true },
    );
    expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(1);
    await subscription.ready;

    await subscription.syncReorderBuffer?.();

    expect(received).toEqual([{ index: 5 }]);
    expect(mockPublisher.get).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    transport.destroy();
  });

  it('does not capture a frontier after the last subscriber leaves during SUBSCRIBE', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let releaseSubscribe!: () => void;
    mockSubscriber.subscribe.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseSubscribe = resolve)),
    );
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );

    const subscription = transport.subscribe(
      'closed-frontier-attachment',
      { onChunk: jest.fn() },
      { deferSequenceDelivery: true, captureSequenceFrontier: true },
    );
    subscription.unsubscribe();
    releaseSubscribe();
    await subscription.ready;

    expect(mockPublisher.eval).not.toHaveBeenCalled();
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    transport.destroy();
  });

  it('times out a hung channel subscription and releases deferred delivery', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let finishOriginalSubscribe!: () => void;
    mockSubscriber.subscribe.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishOriginalSubscribe = resolve)),
    );
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'hung-channel-attachment';
    const received: object[] = [];
    const messageHandler = getMessageHandler(mockSubscriber);

    try {
      const subscription = transport.subscribe(
        streamId,
        { onChunk: (event) => received.push(event as object) },
        { deferSequenceDelivery: true, captureSequenceFrontier: true },
      );
      jest.advanceTimersByTime(500);
      const concurrent = transport.subscribe(streamId, { onChunk: jest.fn() });
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 0,
        data: { index: 0 },
      });
      expect(received).toEqual([]);

      const readinessFailures = Promise.all([
        subscription.ready?.then(
          () => undefined,
          (error: unknown) => error,
        ),
        concurrent.ready?.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ]);
      jest.advanceTimersByTime(2_500);
      const [initiatingFailure, concurrentFailure] = await readinessFailures;
      expect(initiatingFailure).toEqual(
        expect.objectContaining({ message: expect.stringContaining('Timed out synchronizing') }),
      );
      expect(concurrentFailure).toEqual(
        expect.objectContaining({ message: expect.stringContaining('Timed out synchronizing') }),
      );
      expect(received).toEqual([{ index: 0 }]);

      const retry = transport.subscribe(streamId, { onChunk: jest.fn() });
      await retry.ready;
      expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(2);

      finishOriginalSubscribe();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

      subscription.unsubscribe();
      concurrent.unsubscribe();
      retry.unsubscribe();
      expect(transport.getSubscriberCount(streamId)).toBe(0);
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('unsubscribes an evicted channel operation that completes without an owner', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let finishSubscribe!: () => void;
    mockSubscriber.subscribe.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSubscribe = resolve)),
    );
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'late-channel-without-owner';

    try {
      const subscription = transport.subscribe(
        streamId,
        { onChunk: jest.fn() },
        { deferSequenceDelivery: true, captureSequenceFrontier: true },
      );
      const readinessFailure = subscription.ready?.then(
        () => undefined,
        (error: unknown) => error,
      );
      jest.advanceTimersByTime(3_000);
      await readinessFailure;
      subscription.unsubscribe();
      expect(transport.getSubscriberCount(streamId)).toBe(0);
      expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

      finishSubscribe();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('promotes a late active predecessor when its pending replacement fails', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let finishOriginal!: () => void;
    let failReplacement!: (error: Error) => void;
    mockSubscriber.subscribe
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishOriginal = resolve)))
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (failReplacement = reject)));
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'late-active-before-replacement-failure';

    try {
      const original = transport.subscribe(
        streamId,
        { onChunk: jest.fn() },
        { deferSequenceDelivery: true, captureSequenceFrontier: true },
      );
      const originalFailure = original.ready?.then(
        () => undefined,
        (error: unknown) => error,
      );
      jest.advanceTimersByTime(3_000);
      await originalFailure;

      const replacement = transport.subscribe(streamId, { onChunk: jest.fn() });
      const replacementFailure = replacement.ready?.then(
        () => undefined,
        (error: unknown) => error,
      );
      finishOriginal();
      await Promise.resolve();
      await Promise.resolve();
      failReplacement(new Error('replacement unavailable'));
      await replacementFailure;
      await Promise.resolve();

      const survivor = transport.subscribe(streamId, { onChunk: jest.fn() });
      await survivor.ready;
      expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(2);

      original.unsubscribe();
      replacement.unsubscribe();
      survivor.unsubscribe();
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('releases a surviving subscriber when the initiating frontier capture fails', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'failed-frontier-survivor';
    const messageHandler = getMessageHandler(mockSubscriber);
    let rejectFrontier!: (error: Error) => void;
    mockPublisher.eval.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectFrontier = reject)),
    );

    const failed = transport.subscribe(
      streamId,
      { onChunk: jest.fn() },
      { deferSequenceDelivery: true, captureSequenceFrontier: true },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const received: object[] = [];
    const survivor = transport.subscribe(streamId, {
      onChunk: (event) => received.push(event as object),
    });
    await survivor.ready;
    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 0,
      data: { index: 0 },
    });
    expect(received).toEqual([]);

    rejectFrontier(new Error('frontier unavailable'));
    await expect(failed.ready).rejects.toThrow('frontier unavailable');
    failed.unsubscribe();

    expect(received).toEqual([{ index: 0 }]);
    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 1,
      data: { index: 1 },
    });
    expect(received).toEqual([{ index: 0 }, { index: 1 }]);

    survivor.unsubscribe();
    transport.destroy();
  });

  it('times out a hung frontier command and releases surviving subscribers', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'hung-frontier-survivor';
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.eval.mockImplementationOnce((...args: unknown[]) => {
      const channel = String(args[3]);
      const payload = String(args[4]);
      queueMicrotask(() => messageHandler(channel, payload));
      return new Promise(() => undefined);
    });

    try {
      const failed = transport.subscribe(
        streamId,
        { onChunk: jest.fn() },
        { deferSequenceDelivery: true, captureSequenceFrontier: true },
      );
      while (mockPublisher.eval.mock.calls.length === 0) {
        await Promise.resolve();
      }

      const received: object[] = [];
      const survivor = transport.subscribe(streamId, {
        onChunk: (event) => received.push(event as object),
      });
      await survivor.ready;
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 0,
        data: { index: 0 },
      });
      expect(received).toEqual([]);

      jest.advanceTimersByTime(3_000);
      await expect(failed.ready).rejects.toThrow('Timed out synchronizing Redis subscription');
      expect(received).toEqual([{ index: 0 }]);

      failed.unsubscribe();
      survivor.unsubscribe();
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('releases each generation abort subscription after successful completion', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore(),
      eventTransport: transport,
    });
    const streamId = 'completed-generation-abort-cleanup';
    const channel = `stream:{${streamId}}:events`;

    const first = await manager.createJob(streamId, 'user-1');
    await manager.completeJob(streamId, undefined, first.createdAt);

    expect(mockSubscriber.unsubscribe).toHaveBeenNthCalledWith(1, channel);

    const second = await manager.createJob(streamId, 'user-1');
    await manager.completeJob(streamId, undefined, second.createdAt);

    expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscriber.unsubscribe).toHaveBeenNthCalledWith(2, channel);

    await manager.destroy();
  });

  it('does not register an abort listener for a lazily loaded terminal job', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const terminalJob = await jobStore.createJob('lazy-terminal-job', 'user-1');
    await jobStore.transitionStatus('lazy-terminal-job', {
      from: 'running',
      to: 'complete',
      expectCreatedAt: terminalJob.createdAt,
      patch: { completedAt: Date.now() },
    });
    const manager = new GenerationJobManagerClass({
      jobStore,
      eventTransport: transport,
      cleanupOnComplete: false,
    });

    await expect(manager.getJob('lazy-terminal-job')).resolves.toBeDefined();
    expect(mockSubscriber.subscribe).not.toHaveBeenCalled();

    await manager.destroy();
  });

  it('releases an equal-epoch lazy runtime when a later lookup observes it terminal', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const streamId = 'lazy-equal-epoch-terminal';
    const durableJob = await jobStore.createJob(streamId, 'user-1');
    const manager = new GenerationJobManagerClass({
      jobStore,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    const lazyJob = await manager.getJob(streamId);

    await jobStore.transitionStatus(streamId, {
      from: 'running',
      to: 'error',
      expectCreatedAt: durableJob.createdAt,
      patch: { completedAt: Date.now(), error: 'remote terminal' },
    });
    await expect(manager.getJob(streamId)).resolves.toMatchObject({
      createdAt: durableJob.createdAt,
      status: 'error',
    });

    expect(lazyJob?.abortController.signal.aborted).toBe(true);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);

    await manager.destroy();
  });

  it('releases a lazy abort runtime when cleanup observes a retained terminal job', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 3_600_000 });
    const streamId = 'lazy-remote-terminal-cleanup';
    const durableJob = await jobStore.createJob(streamId, 'user-1');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: false,
    });
    manager.initialize();

    try {
      const lazyJob = await manager.getJob(streamId);
      expect(lazyJob?.abortController.signal.aborted).toBe(false);
      expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(1);

      await jobStore.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: durableJob.createdAt,
        patch: { completedAt: Date.now() },
      });
      await jest.advanceTimersByTimeAsync(60_000);

      expect(lazyJob?.abortController.signal.aborted).toBe(true);
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
      await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
        createdAt: durableJob.createdAt,
        status: 'complete',
      });
    } finally {
      await manager.destroy();
      jest.useRealTimers();
    }
  });

  it('releases a subscriber-only abort listener when tagged terminal delivery arrives', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const streamId = 'subscriber-only-terminal-cleanup';
    const durableJob = await jobStore.createJob(streamId, 'user-1');
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: false,
    });
    const onDone = jest.fn();
    const subscription = await manager.subscribe(streamId, () => undefined, onDone);
    const channel = `stream:{${streamId}}:events`;

    deliverSequencedMessage(getMessageHandler(mockSubscriber), streamId, {
      type: 'done',
      seq: 0,
      data: { final: true },
      generationId: durableJob.createdAt,
    });

    expect(onDone).toHaveBeenCalledWith({ final: true });
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(channel);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('filters tagged predecessor chunks from a current generation subscription', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(200);
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: false,
    });
    manager.initialize();

    try {
      const streamId = 'manager-chunk-generation-filter';
      const job = await manager.createJob(streamId, 'user-1');
      const received: unknown[] = [];
      const subscription = await manager.subscribe(streamId, (event) => received.push(event));
      const stale = { event: 'on_message_delta', data: { text: 'stale' } };
      const current = { event: 'on_message_delta', data: { text: 'current' } };
      const legacy = { event: 'on_message_delta', data: { text: 'legacy' } };

      transport.emitChunk(streamId, stale, job.createdAt - 1);
      transport.emitChunk(streamId, current, job.createdAt);
      transport.emitChunk(streamId, legacy);

      expect(received).toEqual([current, legacy]);
      subscription?.unsubscribe();
    } finally {
      now.mockRestore();
      await manager.destroy();
    }
  });

  it('defers ordered delivery until the replay frontier is synchronized', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'deferred-until-sync';
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferDeliveryUntilSynchronized: true },
    );

    deliverSequencedMessage(getMessageHandler(mockSubscriber), streamId, {
      type: 'chunk',
      seq: 0,
      data: { index: 0 },
    });

    expect(received).toEqual([]);

    await transport.syncReorderBuffer(streamId);

    expect(received).toEqual([{ index: 0 }]);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('keeps the attachment fence closed across reorder timeout and buffer pressure', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'deferred-timeout-and-overflow';
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferDeliveryUntilSynchronized: true },
    );
    const messageHandler = getMessageHandler(mockSubscriber);

    try {
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 0,
        data: { index: 0 },
      });
      await jest.advanceTimersByTimeAsync(501);
      expect(received).toEqual([]);

      for (let i = 1; i < 100; i++) {
        deliverSequencedMessage(messageHandler, streamId, {
          type: 'chunk',
          seq: i,
          data: { index: i },
        });
      }
      expect(received).toEqual([]);

      await transport.syncReorderBuffer(streamId);
      expect(received).toHaveLength(100);
      expect(received[0]).toEqual({ index: 0 });
      expect(received[99]).toEqual({ index: 99 });
    } finally {
      subscription.unsubscribe();
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('waits at a same-replica frontier when the following sequence arrives first', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'same-replica-frontier-gap';
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferDeliveryUntilSynchronized: true },
    );
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.get.mockResolvedValueOnce('7');

    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 6,
      data: { index: 6 },
    });
    await transport.syncReorderBuffer(streamId, 5);

    expect(mockPublisher.get).toHaveBeenCalledWith(`stream:{${streamId}}:seq`);
    expect(received).toEqual([]);

    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 5,
      data: { index: 5 },
    });

    expect(received).toEqual([{ index: 5 }, { index: 6 }]);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('uses the Redis sequence as the cross-replica attachment fence', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'cross-replica-attachment-fence';
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferDeliveryUntilSynchronized: true },
    );
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.get.mockResolvedValueOnce('7');

    try {
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 6,
        data: { index: 6 },
      });
      await transport.syncReorderBuffer(streamId);

      expect(mockPublisher.get).toHaveBeenCalledWith(`stream:{${streamId}}:seq`);
      expect(received).toEqual([{ index: 6 }]);

      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 7,
        data: { index: 7 },
      });
      deliverSequencedMessage(messageHandler, streamId, {
        type: 'chunk',
        seq: 5,
        data: { index: 5 },
      });

      expect(received).toEqual([{ index: 6 }, { index: 7 }]);
    } finally {
      subscription.unsubscribe();
      transport.destroy();
    }
  });

  it('adopts the Redis frontier after an empty cross-replica sync', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'cross-replica-empty-sync';
    const received: object[] = [];
    const subscription = transport.subscribe(
      streamId,
      { onChunk: (event) => received.push(event as object) },
      { deferDeliveryUntilSynchronized: true },
    );
    mockPublisher.get.mockResolvedValueOnce('6');
    await transport.syncReorderBuffer(streamId);
    expect(mockPublisher.get).toHaveBeenCalledWith(`stream:{${streamId}}:seq`);

    deliverSequencedMessage(getMessageHandler(mockSubscriber), streamId, {
      type: 'chunk',
      seq: 6,
      data: { index: 6 },
    });
    expect(received).toEqual([{ index: 6 }]);

    deliverSequencedMessage(getMessageHandler(mockSubscriber), streamId, {
      type: 'chunk',
      seq: 7,
      data: { index: 7 },
    });
    expect(received).toEqual([{ index: 6 }, { index: 7 }]);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('holds terminal events behind earlier chunks until synchronization', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'terminal-deferred-until-sync';
    const received: string[] = [];
    const subscription = transport.subscribe(
      streamId,
      {
        onChunk: (event) => received.push(`chunk:${(event as { index: number }).index}`),
        onDone: () => received.push('done'),
      },
      { deferDeliveryUntilSynchronized: true },
    );
    const messageHandler = getMessageHandler(mockSubscriber);

    deliverSequencedMessage(messageHandler, streamId, {
      type: 'done',
      seq: 1,
      data: { final: true },
    });
    deliverSequencedMessage(messageHandler, streamId, {
      type: 'chunk',
      seq: 0,
      data: { index: 0 },
    });

    expect(received).toEqual([]);

    await transport.syncReorderBuffer(streamId);

    expect(mockPublisher.get).toHaveBeenCalledWith(`stream:{${streamId}}:seq`);
    expect(received).toEqual(['chunk:0', 'done']);

    subscription.unsubscribe();
    transport.destroy();
  });

  it('closes a snapshot of local subscribers without publishing', () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'close-local-subscribers';
    const secondOnError = jest.fn();
    const onAllSubscribersLeft = jest.fn();
    transport.onAllSubscribersLeft(streamId, onAllSubscribersLeft);
    let unsubscribeSecond = (): void => undefined;
    const firstSubscription = transport.subscribe(streamId, {
      onChunk: () => undefined,
      onError: () => {
        unsubscribeSecond();
        throw new Error('first handler failed');
      },
    });
    const secondSubscription = transport.subscribe(streamId, {
      onChunk: () => undefined,
      onError: secondOnError,
    });
    unsubscribeSecond = secondSubscription.unsubscribe;

    expect(() => transport.closeLocalSubscribers(streamId, 'stream closed')).not.toThrow();
    expect(secondOnError).toHaveBeenCalledWith('stream closed');
    expect(transport.getSubscriberCount(streamId)).toBe(0);
    expect(onAllSubscribersLeft).toHaveBeenCalledTimes(1);
    expect(mockPublisher.publish).not.toHaveBeenCalled();
    expect(mockPublisher.eval).not.toHaveBeenCalled();

    firstSubscription.unsubscribe();
    transport.destroy();
  });

  it('replaces the disconnect lifecycle callback for a replacement runtime', () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'replacement-disconnect-callback';
    const replacedRuntimeCallback = jest.fn();
    const currentRuntimeCallback = jest.fn();
    transport.onAllSubscribersLeft(streamId, replacedRuntimeCallback);
    transport.onAllSubscribersLeft(streamId, currentRuntimeCallback);
    const subscription = transport.subscribe(streamId, {
      onChunk: () => undefined,
    });

    subscription.unsubscribe();

    expect(replacedRuntimeCallback).not.toHaveBeenCalled();
    expect(currentRuntimeCallback).toHaveBeenCalledTimes(1);
    transport.destroy();
  });

  it('waits for the cross-replica abort channel before resolving job creation', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let signalSubscriptionStarted: (() => void) | undefined;
    const subscriptionStarted = new Promise<void>((resolve) => {
      signalSubscriptionStarted = resolve;
    });
    let releaseSubscription: (() => void) | undefined;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    mockSubscriber.subscribe.mockImplementationOnce(() => {
      signalSubscriptionStarted?.();
      return subscriptionGate;
    });
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });

    let createResolved = false;
    const creating = manager.createJob('abort-readiness', 'user-1').then((job) => {
      createResolved = true;
      return job;
    });

    await subscriptionStarted;
    await Promise.resolve();

    expect(createResolved).toBe(false);

    releaseSubscription?.();
    await creating;

    expect(createResolved).toBe(true);
    await manager.destroy();
  });

  it('resubscribes a replacement after an unexposed registration loses initialization', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let signalSubscriptionStarted: (() => void) | undefined;
    const subscriptionStarted = new Promise<void>((resolve) => {
      signalSubscriptionStarted = resolve;
    });
    let releaseSubscription: (() => void) | undefined;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    mockSubscriber.subscribe.mockImplementationOnce(() => {
      signalSubscriptionStarted?.();
      return subscriptionGate;
    });
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
    });
    const streamId = 'abort-registration-replacement-race';
    const predecessorCreation = manager.createJob(streamId, 'user-1');

    await subscriptionStarted;

    const replacementCreation = manager.createJob(streamId, 'user-1');
    await Promise.resolve();
    releaseSubscription?.();

    await expect(predecessorCreation).rejects.toThrow(
      'Generation job was replaced during initialization',
    );
    const replacement = await replacementCreation;

    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(2);

    getMessageHandler(mockSubscriber)(
      `stream:{${streamId}}:events`,
      JSON.stringify({ type: 'abort', generationId: replacement.createdAt }),
    );

    expect(replacement.abortController.signal.aborted).toBe(true);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(2);

    await manager.destroy();
  });

  it('keeps remote abort active after SSE disconnect and releases it after delivery', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });
    const streamId = 'remote-abort-after-disconnect';
    const job = await manager.createJob(streamId, 'user-1');
    const subscription = await manager.subscribe(streamId, () => undefined);

    subscription?.unsubscribe();

    expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

    getMessageHandler(mockSubscriber)(
      `stream:{${streamId}}:events`,
      JSON.stringify({ type: 'abort' }),
    );

    expect(job.abortController.signal.aborted).toBe(true);
    expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(`stream:{${streamId}}:events`);

    await manager.destroy();
  });

  it('detaches a manager subscription when shutdown starts during transport readiness', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    let signalReadyStarted: (() => void) | undefined;
    const readyStarted = new Promise<void>((resolve) => {
      signalReadyStarted = resolve;
    });
    let releaseReady: (() => void) | undefined;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    mockSubscriber.subscribe.mockImplementationOnce(() => {
      signalReadyStarted?.();
      return readyGate;
    });
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    /** Both manager-level channel registrations are suppressed so the gated
     *  `subscribe` below belongs to the SSE subscription under test. */
    Object.defineProperty(transport, 'onAbort', { value: undefined });
    Object.defineProperty(transport, 'onPreempt', { value: undefined });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });
    manager.initialize();
    await manager.createJob('shutdown-during-ready', 'user-1');

    const onError = jest.fn();
    const subscribing = manager.subscribe(
      'shutdown-during-ready',
      () => undefined,
      undefined,
      onError,
    );
    await readyStarted;

    manager.prepareForShutdown();

    expect(onError).toHaveBeenCalledWith('Server is shutting down');
    expect(transport.getSubscriberCount('shutdown-during-ready')).toBe(0);

    releaseReady?.();
    await expect(subscribing).resolves.toBeNull();
    await manager.destroy();
  });

  it('keeps publication receipts behind the internal transport capability', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );

    await expect(transport.emitChunk('stream-1', { text: 'Hello' })).resolves.toBeUndefined();
    await expect(emitChunkWithReceipt(transport, 'stream-1', { text: 'World' }, 777)).resolves.toBe(
      1,
    );
    expect(mockPublisher.eval.mock.calls[0][12]).toBe('0');
    const guardedPublish = mockPublisher.eval.mock.calls[1];
    expect(guardedPublish[0]).toContain('local currentCreatedAt = redis.call("HGET", KEYS[2]');
    expect(guardedPublish[9]).toBe('777');
    expect(guardedPublish[10]).toBe('0');
    expect(guardedPublish[12]).toBe('1');
    expect(JSON.parse(`${guardedPublish[6]}1${guardedPublish[7]}`)).toMatchObject({
      type: 'chunk',
      data: { text: 'World' },
      generationId: 777,
    });

    mockPublisher.eval.mockResolvedValueOnce(-1);
    await expect(
      emitChunkWithReceipt(transport, 'replaced-stream', { text: 'stale' }, 111),
    ).resolves.toBe(false);
    mockPublisher.eval.mockRejectedValue(new Error('publish failed'));
    await expect(transport.emitChunk('failed-stream', { text: 'Hello' })).resolves.toBeUndefined();
    await expect(
      emitChunkWithReceipt(transport, 'failed-stream', { text: 'Hello' }),
    ).resolves.toBeUndefined();
    await expect(
      emitObservedChunk(transport, 'failed-observer', { text: 'Hello' }),
    ).rejects.toThrow('Observed chunk publication failed');

    transport.destroy();
  });

  it('guards terminal publications with the winning finalized epoch', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );

    await transport.emitDone('terminal-guard', { final: true }, 777);
    await transport.emitError('terminal-guard', 'failed', 777);
    await emitChunkWithReceipt(transport, 'terminal-guard', { text: 'delta' }, 777);

    const [donePublish, errorPublish, chunkPublish] = mockPublisher.eval.mock.calls;
    expect(donePublish[0]).toContain(
      'if redis.call("EXISTS", KEYS[2]) == 1 or ARGV[6] ~= "1" then return -1 end',
    );
    expect(donePublish[0]).toContain(
      'redis.call("SET", KEYS[3], ARGV[5], "EX", tonumber(ARGV[7]), "NX")',
    );
    expect(donePublish[0]).not.toContain('redis.call("DEL", KEYS[3])');
    expect(donePublish[4]).toBe('stream:{terminal-guard}:generation-epoch');
    expect(donePublish[9]).toBe('777');
    expect(donePublish[10]).toBe('1');
    expect(donePublish[11]).toBe('300');
    expect(donePublish[12]).toBe('0');
    expect(errorPublish[9]).toBe('777');
    expect(errorPublish[10]).toBe('1');
    expect(errorPublish[11]).toBe('300');
    expect(errorPublish[12]).toBe('0');
    expect(chunkPublish[9]).toBe('777');
    expect(chunkPublish[10]).toBe('0');
    expect(chunkPublish[11]).toBe('300');
    expect(chunkPublish[12]).toBe('1');
    expect(chunkPublish[0]).toContain('if ARGV[8] == "1" then');
    expect(chunkPublish[0]).toContain('currentStatus ~= "running"');

    transport.destroy();
  });

  it('publishes a receipt-authorized replacement DONE for an old epoch', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    mockPublisher.eval.mockResolvedValueOnce(0);

    await expect(
      transport.emitReplacedDoneConfirmed(
        'replacement-done',
        { final: true, reconcile: true },
        1234,
        'current-create-attempt',
      ),
    ).resolves.toBeUndefined();

    const publish = mockPublisher.eval.mock.calls[0];
    expect(publish[0]).toContain('HGET", KEYS[2], "__creationAttemptId"');
    expect(publish[0]).toContain('__replacedGenerations');
    expect(publish[0]).toContain('redis.call("PUBLISH"');
    expect(publish[1]).toBe(2);
    expect(publish[2]).toBe('stream:{replacement-done}:seq');
    expect(publish[3]).toBe('stream:{replacement-done}:job');
    expect(publish[8]).toBe('1234');
    expect(publish[9]).toBe('current-create-attempt');
    expect(JSON.parse(`${publish[5]}0${publish[6]}`)).toMatchObject({
      type: 'done',
      generationId: 1234,
      data: { final: true, reconcile: true },
    });

    transport.destroy();
  });

  it('rejects stale replacement receipts and ordinary fenced terminal events', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);

    try {
      mockPublisher.eval.mockResolvedValueOnce(-1);
      await expect(
        transport.emitReplacedDoneConfirmed('stale-replacement', { final: true }, 1234, 'wrong'),
      ).rejects.toThrow('replacement DONE receipt is no longer current');
      mockPublisher.eval.mockResolvedValueOnce(-1);
      await expect(transport.emitDone('stale-done', { final: true }, 1234)).rejects.toBeInstanceOf(
        GenerationPublicationFencedError,
      );
      mockPublisher.eval.mockResolvedValueOnce(-1);
      await expect(transport.emitError('stale-error', 'failed', 1234)).rejects.toBeInstanceOf(
        GenerationPublicationFencedError,
      );

      expect(warn).toHaveBeenNthCalledWith(
        1,
        '[RedisEventTransport] Skipped stale terminal publication:',
        { streamId: 'stale-done', generationId: 1234, eventType: 'done' },
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        '[RedisEventTransport] Skipped stale terminal publication:',
        { streamId: 'stale-error', generationId: 1234, eventType: 'error' },
      );
      expect(error).not.toHaveBeenCalled();

      mockPublisher.eval.mockRejectedValueOnce(new Error('Redis unavailable'));
      await expect(transport.emitDone('failed-done', { final: true }, 1234)).rejects.toThrow(
        'Redis unavailable',
      );
      expect(error).toHaveBeenCalledWith(
        '[RedisEventTransport] Failed to publish done:',
        expect.objectContaining({ message: 'Redis unavailable' }),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    transport.destroy();
  });

  it('rejects a confirmed abort with no generation-owner acknowledgement', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    let resolveAbortPublished!: () => void;
    const abortPublished = new Promise<void>((resolve) => {
      resolveAbortPublished = resolve;
    });
    mockPublisher.publish.mockImplementationOnce(async () => {
      resolveAbortPublished();
      return 0;
    });
    mockPublisher.eval.mockResolvedValueOnce(0);

    try {
      const confirmation = transport.emitAbortConfirmed('zero-listener', 1234);
      await abortPublished;
      await jest.advanceTimersByTimeAsync(3000);
      await expect(confirmation).resolves.toBe(false);
      await expect(
        transport.emitReplacedDoneConfirmed('zero-listener', { final: true }, 1234, 'attempt'),
      ).resolves.toBeUndefined();
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('recovers a confirmed abort from durable owner proof after the initial read', async () => {
    jest.useFakeTimers();
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'delayed-owner-abort-proof';
    let resolveAbortPublished!: () => void;
    const abortPublished = new Promise<void>((resolve) => {
      resolveAbortPublished = resolve;
    });
    mockPublisher.publish.mockImplementationOnce(async () => {
      resolveAbortPublished();
      return 0;
    });

    try {
      const confirmation = transport.emitAbortConfirmed(streamId, 1234);
      await abortPublished;

      await expect(transport.recordAbortAcknowledgement(streamId, 1234)).resolves.toBe(true);
      expect(mockPublisher.set).toHaveBeenCalledWith(
        `stream:{${streamId}}:abort-ack:1234`,
        '1',
        'EX',
        86400,
      );

      await jest.advanceTimersByTimeAsync(3000);
      await expect(confirmation).resolves.toBe(true);
    } finally {
      transport.destroy();
      jest.useRealTimers();
    }
  });

  it('persists provider drain proof under the exact generation and segment identity', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'provider-drain-proof';

    await expect(transport.recordProviderDrain(streamId, 1234, 'segment-a')).resolves.toBe(true);
    expect(mockPublisher.set).toHaveBeenCalledWith(
      `stream:{${streamId}}:provider-drain:1234:segment-a`,
      '1',
      'EX',
      86400,
    );
    await expect(transport.hasProviderDrain(streamId, 1234, 'segment-a')).resolves.toBe(true);
    await expect(transport.hasProviderDrain(streamId, 1234, 'segment-b')).resolves.toBe(false);

    transport.destroy();
  });

  it('waits for a delayed owner acknowledgement when cluster publish reports zero local receivers', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'cluster-zero-local-receivers';
    const channel = `stream:{${streamId}}:events`;
    const messageHandler = getMessageHandler(mockSubscriber);
    let resolveAbortPublished!: (message: { abortRequestId: string }) => void;
    const abortPublished = new Promise<{ abortRequestId: string }>((resolve) => {
      resolveAbortPublished = resolve;
    });
    mockPublisher.publish.mockImplementation(async (_channel: string, payload: string) => {
      const message = JSON.parse(payload) as { type: string; abortRequestId: string };
      if (message.type === 'abort') {
        resolveAbortPublished(message);
      }
      return 0;
    });

    const confirmation = transport.emitAbortConfirmed(streamId, 1234);
    const abortMessage = await abortPublished;
    await new Promise<void>((resolve) => setImmediate(resolve));
    messageHandler(
      channel,
      JSON.stringify({
        type: 'abort_ack',
        generationId: 1234,
        abortRequestId: abortMessage.abortRequestId,
      }),
    );

    await expect(confirmation).resolves.toBe(true);
    transport.destroy();
  });

  it('correlates an abort acknowledgement to its request and generation', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'generation-correlated-abort-ack';
    const channel = `stream:{${streamId}}:events`;
    const messageHandler = getMessageHandler(mockSubscriber);
    let resolveAbortMessage!: (message: { abortRequestId: string }) => void;
    const abortPublished = new Promise<{ abortRequestId: string }>((resolve) => {
      resolveAbortMessage = resolve;
    });
    mockPublisher.publish.mockImplementation(async (_channel: string, payload: string) => {
      const message = JSON.parse(payload) as { type: string; abortRequestId: string };
      if (message.type === 'abort') {
        resolveAbortMessage(message);
      }
      return 4;
    });

    const confirmation = transport.emitAbortConfirmed(streamId, 1234);
    const abortMessage = await abortPublished;
    let settled = false;
    void confirmation.then(() => {
      settled = true;
    });

    messageHandler(
      channel,
      JSON.stringify({
        type: 'abort_ack',
        generationId: 5678,
        abortRequestId: abortMessage.abortRequestId,
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    messageHandler(
      channel,
      JSON.stringify({
        type: 'abort_ack',
        generationId: 1234,
        abortRequestId: abortMessage.abortRequestId,
      }),
    );
    await expect(confirmation).resolves.toBe(true);

    transport.destroy();
  });

  it('replays an event exactly once when its Redis publish resolves during attachment', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'publish-resolves-during-attachment';
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      if (transport.getSubscriberCount(streamId) > 0) {
        messageHandler(channel, payload);
      }
      return 1;
    });

    const originalEval = mockPublisher.eval.getMockImplementation();
    let releasePublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    mockPublisher.eval.mockImplementationOnce(async (...args: unknown[]) => {
      await publicationGate;
      return originalEval?.(...args);
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });
    manager.initialize();
    await manager.createJob(streamId, 'user-1');

    const earlyEvent = {
      event: 'on_message_delta' as const,
      data: { delta: { content: { type: 'text', text: 'early' } } },
    };
    const publication = manager.emitChunk(streamId, earlyEvent);
    await Promise.resolve();

    const received: unknown[] = [];
    const attachment = manager.subscribe(streamId, (event) => received.push(event));
    let attachmentSettled = false;
    void attachment.then(() => {
      attachmentSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(attachmentSettled).toBe(false);
    expect(received).toEqual([]);

    releasePublication?.();

    await publication;
    const subscription = await attachment;

    expect(received).toEqual([earlyEvent]);

    const liveEvent = {
      event: 'on_message_delta' as const,
      data: { delta: { content: { type: 'text', text: 'live' } } },
    };
    await manager.emitChunk(streamId, liveEvent);
    expect(received).toEqual([earlyEvent, liveEvent]);

    subscription?.unsubscribe();
    await manager.destroy();
  });

  it('hands a canceled resume bootstrap to a surviving initial subscriber', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'abort-during-publication-fence';
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      messageHandler(channel, payload);
      return 1;
    });
    const originalEval = mockPublisher.eval.getMockImplementation();
    let signalPublicationStarted: (() => void) | undefined;
    const publicationStarted = new Promise<void>((resolve) => {
      signalPublicationStarted = resolve;
    });
    let releasePublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    mockPublisher.eval.mockImplementationOnce(async (...args: unknown[]) => {
      signalPublicationStarted?.();
      await publicationGate;
      return originalEval?.(...args);
    });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });
    manager.initialize();
    await manager.createJob(streamId, 'user-1');

    const earlyEvent = {
      event: 'on_message_delta',
      data: { delta: { content: [{ type: 'text', text: 'early' }] } },
    } as const;
    const publication = manager.emitChunk(streamId, earlyEvent);
    await publicationStarted;

    const attachmentAbortController = new AbortController();
    const subscribing = manager.subscribe(streamId, () => undefined, undefined, undefined, {
      skipBufferReplay: true,
      signal: attachmentAbortController.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.getSubscriberCount(streamId)).toBe(1);

    const receivedBySurvivor: unknown[] = [];
    const survivingSubscription = await manager.subscribe(streamId, (event) =>
      receivedBySurvivor.push(event),
    );
    expect(transport.getSubscriberCount(streamId)).toBe(2);

    attachmentAbortController.abort();

    await expect(subscribing).resolves.toBeNull();
    expect(transport.getSubscriberCount(streamId)).toBe(1);

    releasePublication?.();
    await publication;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(receivedBySurvivor).toEqual([earlyEvent]);

    const liveEvent = {
      event: 'on_message_delta' as const,
      data: { delta: { content: [{ type: 'text', text: 'live' }] } },
    };
    await manager.emitChunk(streamId, liveEvent);
    expect(receivedBySurvivor).toEqual([earlyEvent, liveEvent]);

    survivingSubscription?.unsubscribe();
    await manager.destroy();
  });

  it('deduplicates a cross-replica created fallback when the original publishes later', async () => {
    const mockPublisher = createMockPublisher();
    const generatingSubscriber = createMockSubscriber();
    const attachingSubscriber = createMockSubscriber();
    const generatingTransport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      generatingSubscriber as unknown as Redis,
    );
    const attachingTransport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      attachingSubscriber as unknown as Redis,
    );
    const attachingMessageHandler = getMessageHandler(attachingSubscriber);
    const streamId = 'cross-replica-created-fallback';
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      if (attachingTransport.getSubscriberCount(streamId) > 0) {
        attachingMessageHandler(channel, payload);
      }
      return 1;
    });

    const originalEval = mockPublisher.eval.getMockImplementation();
    let signalPublicationStarted: (() => void) | undefined;
    const publicationStarted = new Promise<void>((resolve) => {
      signalPublicationStarted = resolve;
    });
    let releasePublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    mockPublisher.eval.mockImplementationOnce(async (...args: unknown[]) => {
      signalPublicationStarted?.();
      await publicationGate;
      return originalEval?.(...args);
    });

    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const generatingManager = new GenerationJobManagerClass();
    generatingManager.configure({
      jobStore,
      eventTransport: generatingTransport,
      isRedis: true,
    });
    const attachingManager = new GenerationJobManagerClass();
    attachingManager.configure({
      jobStore,
      eventTransport: attachingTransport,
      isRedis: true,
    });
    await generatingManager.createJob(streamId, 'user-1', streamId);

    const createdEvent = {
      created: true as const,
      message: {
        messageId: 'message-1',
        conversationId: streamId,
        text: 'Hello',
        sender: 'User',
        isCreatedByUser: true,
      },
      streamId,
    };
    const publication = generatingManager.emitChunk(streamId, createdEvent);
    await publicationStarted;

    const received: unknown[] = [];
    const subscription = await attachingManager.subscribe(streamId, (event) =>
      received.push(event),
    );
    expect(received).toEqual([createdEvent]);

    releasePublication?.();
    await publication;
    await Promise.resolve();

    expect(received).toEqual([createdEvent]);

    subscription?.unsubscribe();
    await generatingManager.destroy();
    await attachingManager.destroy();
  });

  it('reconstructs a missed cross-replica created event before a pending delta', async () => {
    const mockPublisher = createMockPublisher();
    const generatingSubscriber = createMockSubscriber();
    const attachingSubscriber = createMockSubscriber();
    const generatingTransport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      generatingSubscriber as unknown as Redis,
    );
    const attachingTransport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      attachingSubscriber as unknown as Redis,
    );
    const streamId = 'cross-replica-created-before-delta';
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const generatingManager = new GenerationJobManagerClass();
    generatingManager.configure({
      jobStore,
      eventTransport: generatingTransport,
      isRedis: true,
    });
    const attachingManager = new GenerationJobManagerClass();
    attachingManager.configure({
      jobStore,
      eventTransport: attachingTransport,
      isRedis: true,
    });
    await generatingManager.createJob(streamId, 'user-1', streamId);

    const createdEvent = {
      created: true as const,
      message: {
        messageId: 'message-1',
        conversationId: streamId,
        text: 'Hello',
        sender: 'User',
        isCreatedByUser: true,
      },
      streamId,
    };
    await generatingManager.emitChunk(streamId, createdEvent);

    const deltaEvent = {
      event: 'on_message_delta' as const,
      data: { delta: { content: [{ type: 'text', text: 'World' }] } },
    };
    const messageHandler = getMessageHandler(attachingSubscriber);
    const originalSync = attachingTransport.syncReorderBuffer.bind(attachingTransport);
    jest
      .spyOn(attachingTransport, 'syncReorderBuffer')
      .mockImplementation(async (syncStreamId, replayedSequenceFrontier) => {
        deliverSequencedMessage(messageHandler, streamId, {
          type: 'chunk',
          seq: 1,
          data: deltaEvent,
        });
        return originalSync(syncStreamId, replayedSequenceFrontier);
      });

    const received: unknown[] = [];
    const subscription = await attachingManager.subscribe(streamId, (event) =>
      received.push(event),
    );

    expect(received).toEqual([createdEvent, deltaEvent]);

    subscription?.unsubscribe();
    await generatingManager.destroy();
    await attachingManager.destroy();
  });

  it('keeps the replay frontier aligned after publication failure and reconnect', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const streamId = 'buffered-publish-failure';
    const messageHandler = getMessageHandler(mockSubscriber);
    mockPublisher.publish.mockImplementation(async (channel: string, payload: string) => {
      if (transport.getSubscriberCount(streamId) > 0) {
        messageHandler(channel, payload);
      }
      return 1;
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: transport,
      isRedis: true,
    });
    manager.initialize();

    await manager.createJob(streamId, 'user-1');
    mockPublisher.eval.mockRejectedValueOnce(
      new Error('publish failed before sequence allocation'),
    );

    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { delta: { content: { type: 'text', text: 'buffered locally' } } },
    });

    const received: unknown[] = [];
    const subscription = await manager.subscribe(streamId, (event) => received.push(event));

    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { delta: { content: { type: 'text', text: 'first live chunk' } } },
    });

    expect(received).toEqual([
      {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'buffered locally' } } },
      },
      {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'first live chunk' } } },
      },
    ]);

    subscription?.unsubscribe();

    /** After the first attachment the local buffer stays closed; a detached
     * emission is durable-log-only, and the reconnect frontier must advance
     * past its sequence so the next live chunk is not held for reordering. */
    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { delta: { content: { type: 'text', text: 'detached after disconnect' } } },
    });
    expect(manager.getRuntimeStats().earlyBufferedEvents).toBe(0);

    const resumed: unknown[] = [];
    const resumedSubscription = await manager.subscribe(streamId, (event) => resumed.push(event));
    await manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { delta: { content: { type: 'text', text: 'live after reconnect' } } },
    });

    expect(resumed).toEqual([
      {
        event: 'on_message_delta',
        data: { delta: { content: { type: 'text', text: 'live after reconnect' } } },
      },
    ]);

    resumedSubscription?.unsubscribe();
    await manager.destroy();
  });

  it('resets stale abort-listener reorder state before the next real subscriber', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );

    const streamId = 'reorder-abort-listener-reuse-test';
    transport.onAbort(streamId, () => {});

    const messageHandler = getMessageHandler(mockSubscriber);
    const channel = `stream:{${streamId}}:events`;

    for (let i = 0; i < 5; i++) {
      await transport.emitChunk(streamId, { index: i });
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: i, data: { index: i } }));
    }

    await mockPublisher.del(`stream:{${streamId}}:seq`);

    const secondRunChunks: unknown[] = [];
    transport.subscribe(streamId, {
      onChunk: (event) => secondRunChunks.push(event),
    });

    messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));

    expect(secondRunChunks.map((chunk) => (chunk as { index: number }).index)).toEqual([0]);

    transport.destroy();
  });
});
