import type { ChunkPublicationReceipt } from '~/stream/internal/chunkPublication';
import type { ServerSentEvent } from '~/types';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { registerChunkPublicationCapability } from '~/stream/internal/chunkPublication';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { resolveCoalesceWindowMs } from '~/stream/internal/coalescing';

jest.spyOn(console, 'log').mockImplementation();

const DELTA_EVENT: ServerSentEvent = {
  event: 'on_message_delta',
  data: { id: 'step-1', delta: { content: [{ type: 'text', text: 'token' }] } },
} as unknown as ServerSentEvent;

/** Structural coalescing advertisement: the manager gates on these methods. */
function advertiseCoalescing(
  jobStore: InMemoryJobStore,
  eventTransport: InMemoryEventTransport,
): void {
  (jobStore as { flushPendingAppends?: (id: string) => Promise<void> }).flushPendingAppends =
    async () => undefined;
  (eventTransport as { flushPendingChunks?: (id: string) => Promise<void> }).flushPendingChunks =
    async () => undefined;
}

describe('delta coalescing manager gating and backpressure', () => {
  const originalWindow = process.env.STREAM_DELTA_COALESCE_MS;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete process.env.STREAM_DELTA_COALESCE_MS;
    } else {
      process.env.STREAM_DELTA_COALESCE_MS = originalWindow;
    }
  });

  async function createManager(options: {
    windowMs: string | undefined;
    advertise: boolean;
    isRedis?: boolean;
  }): Promise<{
    manager: GenerationJobManagerClass;
    publishCalls: Array<unknown[]>;
    settleAll: (receipt: number | false | undefined) => void;
  }> {
    if (options.windowMs === undefined) {
      delete process.env.STREAM_DELTA_COALESCE_MS;
    } else {
      process.env.STREAM_DELTA_COALESCE_MS = options.windowMs;
    }

    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const eventTransport = new InMemoryEventTransport();
    if (options.advertise) {
      advertiseCoalescing(jobStore, eventTransport);
    }

    const publishCalls: Array<unknown[]> = [];
    const resolvers: Array<(receipt: ChunkPublicationReceipt) => void> = [];
    registerChunkPublicationCapability(eventTransport, (...args: unknown[]) => {
      publishCalls.push(args);
      return new Promise<ChunkPublicationReceipt>((resolve) => {
        resolvers.push(resolve);
      });
    });

    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore, eventTransport, isRedis: options.isRedis ?? true });
    manager.initialize();
    return {
      manager,
      publishCalls,
      settleAll: (receipt) => {
        for (const resolve of resolvers.splice(0)) {
          resolve(receipt);
        }
      },
    };
  }

  it('does not send coalesce hints when the configured services lack the capability', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: '25',
      advertise: false,
    });
    await manager.createJob('gate-off', 'user-1', 'gate-off');
    await manager.subscribe('gate-off', jest.fn());

    const emission = manager.emitChunk('gate-off', DELTA_EVENT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishCalls).toHaveLength(1);
    /** 3-arg call shape = the awaited per-event path; a 4th options argument
     * would mean the manager assumed batching the transport cannot provide. */
    expect(publishCalls[0]).toHaveLength(3);

    /** The per-event path awaits its receipt: the emission must still be
     * pending until the publication settles. */
    let emitted = false;
    void emission.then(() => {
      emitted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toBe(false);
    settleAll(0);
    await emission;

    await manager.destroy();
  });

  it.each([undefined, '25'])(
    'sends coalesce hints without awaiting receipts with capable Redis services and window %s',
    async (windowMs) => {
      const { manager, publishCalls, settleAll } = await createManager({
        windowMs,
        advertise: true,
      });
      await manager.createJob('gate-on', 'user-1', 'gate-on');
      await manager.subscribe('gate-on', jest.fn());

      await manager.emitChunk('gate-on', DELTA_EVENT);
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0][3]).toEqual({ coalesce: true });

      settleAll(0);
      await manager.destroy();
    },
  );

  it('does not batch the awaited append path before first subscriber admission', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: undefined,
      advertise: true,
    });
    await manager.createJob('before-admission', 'user-1', 'before-admission');

    const emission = manager.emitChunk('before-admission', DELTA_EVENT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishCalls[0]).toHaveLength(3);
    settleAll(0);
    await emission;
    await manager.destroy();
  });

  it('continues batching after an admitted subscriber disconnects', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: undefined,
      advertise: true,
    });
    await manager.createJob('after-admission', 'user-1', 'after-admission');
    const subscription = await manager.subscribe('after-admission', jest.fn());
    subscription?.unsubscribe();

    await manager.emitChunk('after-admission', DELTA_EVENT);
    expect(publishCalls[0][3]).toEqual({ coalesce: true });
    settleAll(0);
    await manager.destroy();
  });

  it('keeps the awaited path with an explicit zero even with capable services', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: '0',
      advertise: true,
    });
    await manager.createJob('window-off', 'user-1', 'window-off');
    await manager.subscribe('window-off', jest.fn());

    const emission = manager.emitChunk('window-off', DELTA_EVENT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishCalls[0]).toHaveLength(3);
    settleAll(0);
    await emission;

    await manager.destroy();
  });

  it('keeps attached in-memory streams on the awaited path with the default window', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: undefined,
      advertise: true,
      isRedis: false,
    });
    await manager.createJob('memory-default', 'user-1', 'memory-default');
    const subscription = await manager.subscribe('memory-default', jest.fn());

    const emission = manager.emitChunk('memory-default', DELTA_EVENT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishCalls[0]).toHaveLength(3);
    settleAll(0);
    await emission;
    subscription?.unsubscribe();
    await manager.destroy();
  });

  it.each([
    [undefined, 25],
    ['0', 0],
    ['', 0],
    ['invalid', 0],
    ['NaN', 0],
    ['Infinity', 0],
    ['-1', 0],
    ['0.5', 0],
    ['25', 25],
    ['50.9', 50],
    ['2000', 1000],
  ])('resolves window %s to %s ms', (value, expected) => {
    if (value === undefined) {
      delete process.env.STREAM_DELTA_COALESCE_MS;
    } else {
      process.env.STREAM_DELTA_COALESCE_MS = value;
    }
    expect(resolveCoalesceWindowMs()).toBe(expected);
  });

  it('applies backpressure once outstanding coalesced receipts hit the cap', async () => {
    const { manager, publishCalls, settleAll } = await createManager({
      windowMs: '25',
      advertise: true,
    });
    await manager.createJob('backpressure', 'user-1', 'backpressure');
    await manager.subscribe('backpressure', jest.fn());

    /** The cap is 256: every emission below it resolves without awaiting the
     * (deliberately unsettled) publication receipts. */
    for (let i = 0; i < 255; i++) {
      await manager.emitChunk('backpressure', DELTA_EVENT);
    }
    expect(publishCalls).toHaveLength(255);

    let saturatedResolved = false;
    const saturated = manager.emitChunk('backpressure', DELTA_EVENT).then(() => {
      saturatedResolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishCalls).toHaveLength(256);
    expect(saturatedResolved).toBe(false);

    settleAll(0);
    await saturated;
    expect(saturatedResolved).toBe(true);

    await manager.destroy();
  });
});
