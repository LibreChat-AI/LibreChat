import type { GenerationSettledEvent, GenerationSettledListener } from '../GenerationJobManager';
import type { GenerationJobStatus } from '../../types/stream';
import { waitForGenerationSettled } from '../settled';

function createSource(initial: Record<string, GenerationJobStatus>) {
  const statuses = new Map(Object.entries(initial));
  const listeners = new Set<GenerationSettledListener>();
  const epochs = new Map<string, number>();
  const pending = new Set<string>();
  return {
    statuses,
    epochs,
    pending,
    listeners,
    getGenerationSettlementState: jest.fn(async (streamId: string) => {
      const status = statuses.get(streamId);
      return status == null
        ? undefined
        : {
            createdAt: epochs.get(streamId) ?? 1,
            status,
            terminalPersistencePending: pending.has(streamId),
          };
    }),
    onGenerationSettled: (listener: GenerationSettledListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settle(event: Omit<GenerationSettledEvent, 'streamId' | 'userId'>) {
      statuses.set(event.conversationId, event.status as GenerationJobStatus);
      for (const listener of listeners) {
        listener({ ...event, streamId: event.conversationId, userId: 'user-1' });
      }
    },
  };
}

describe('waitForGenerationSettled', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['no generation', {}],
    ['a completed generation', { 'conversation-1': 'complete' as const }],
  ])('resolves false at once for %s', async (_label, initial) => {
    const source = createSource(initial);

    await expect(waitForGenerationSettled(source, 'conversation-1')).resolves.toBe(false);
    expect(source.listeners.size).toBe(0);
  });

  it('resolves when this conversation settles, ignoring others', async () => {
    const source = createSource({ 'conversation-1': 'running', 'conversation-2': 'running' });
    let resolved: boolean | undefined;
    void waitForGenerationSettled(source, 'conversation-1').then((settled) => {
      resolved = settled;
    });
    await jest.advanceTimersByTimeAsync(0);

    source.settle({ conversationId: 'conversation-2', status: 'complete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toBeUndefined();

    source.settle({ conversationId: 'conversation-1', status: 'complete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(source.listeners.size).toBe(0);
  });

  it('waits through an approval pause', async () => {
    const source = createSource({ 'conversation-1': 'requires_action' });
    let resolved: boolean | undefined;
    void waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 }).then(
      (settled) => {
        resolved = settled;
      },
    );

    await jest.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBeUndefined();
  });

  it('observes a generation that settles on another replica', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 });
    await jest.advanceTimersByTimeAsync(0);

    source.statuses.set('conversation-1', 'complete');
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe(true);
    expect(source.listeners.size).toBe(0);
  });

  it('keeps waiting for as long as the generation stays active by default', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    let resolved: boolean | undefined;
    void waitForGenerationSettled(source, 'conversation-1', { recheckMs: 60 * 60 * 1_000 }).then(
      (settled) => {
        resolved = settled;
      },
    );

    await jest.advanceTimersByTimeAsync(48 * 60 * 60 * 1_000);
    expect(resolved).toBeUndefined();

    source.settle({ conversationId: 'conversation-1', status: 'complete' });
    await jest.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('gives up after the maximum wait', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const waiting = waitForGenerationSettled(source, 'conversation-1', {
      recheckMs: 1_000,
      maxWaitMs: 10_000,
    });

    await jest.advanceTimersByTimeAsync(10_000);

    await expect(waiting).resolves.toBe(false);
    expect(source.listeners.size).toBe(0);
  });

  it('stops waiting when the caller aborts', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const controller = new AbortController();
    const waiting = waitForGenerationSettled(source, 'conversation-1', {
      signal: controller.signal,
    });
    await jest.advanceTimersByTimeAsync(0);

    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(source.listeners.size).toBe(0);
  });

  it('recovers from initial and later read failures without unsubscribing', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    source.getGenerationSettlementState.mockRejectedValueOnce(new Error('job store unavailable'));
    const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(source.getGenerationSettlementState).toHaveBeenCalledTimes(2);
    expect(source.listeners.size).toBe(1);
    source.getGenerationSettlementState.mockRejectedValueOnce(new Error('later outage'));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(source.listeners.size).toBe(1);
    source.statuses.set('conversation-1', 'complete');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(true);
    expect(source.listeners.size).toBe(0);
  });

  it.each(['running', 'requires_action'] as const)(
    'does not follow a %s successor on another replica',
    async (status) => {
      const source = createSource({ 'conversation-1': 'running' });
      const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 });
      await jest.advanceTimersByTimeAsync(0);
      source.statuses.set('conversation-1', status);
      source.epochs.set('conversation-1', 2);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toBe(true);
      expect(source.listeners.size).toBe(0);
    },
  );

  it('uses the dispatch epoch even when the first successful read sees its successor', async () => {
    const source = createSource({ 'conversation-1': 'requires_action' });
    source.epochs.set('conversation-1', 2);
    source.getGenerationSettlementState.mockRejectedValueOnce(new Error('outage'));
    const waiting = waitForGenerationSettled(source, 'conversation-1', {
      generationCreatedAt: 1,
      recheckMs: 1_000,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(true);
  });

  it.each(['complete', 'error', 'aborted'] as const)(
    'waits for %s terminal persistence even after a stale settlement event',
    async (status) => {
      const source = createSource({ 'conversation-1': status });
      source.pending.add('conversation-1');
      let resolved = false;
      const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 }).then(
        (value) => {
          resolved = true;
          return value;
        },
      );
      await jest.advanceTimersByTimeAsync(120_000);
      source.settle({ conversationId: 'conversation-1', status });
      await jest.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);
      source.pending.delete('conversation-1');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toBe(true);
    },
  );

  it('finishes when the observed job disappears', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 });
    await jest.advanceTimersByTimeAsync(0);
    source.statuses.delete('conversation-1');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(true);
  });

  it('resolves a pre-aborted wait without subscribing or creating timers', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForGenerationSettled(source, 'conversation-1', { signal: controller.signal }),
    ).resolves.toBe(false);
    expect(source.getGenerationSettlementState).not.toHaveBeenCalled();
    expect(source.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('serializes reads and remembers a settlement event during an in-flight read', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.getGenerationSettlementState.mockImplementationOnce(async () => {
      await gate;
      return { createdAt: 1, status: 'running', terminalPersistencePending: false };
    });
    const waiting = waitForGenerationSettled(source, 'conversation-1', { recheckMs: 1_000 });
    await jest.advanceTimersByTimeAsync(10_000);
    source.settle({ conversationId: 'conversation-1', status: 'complete' });
    source.settle({ conversationId: 'conversation-1', status: 'complete' });
    expect(source.getGenerationSettlementState).toHaveBeenCalledTimes(1);
    release();
    await expect(waiting).resolves.toBe(true);
    expect(source.getGenerationSettlementState).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('removes abort listeners and ignores reads completing after cancellation', async () => {
    const source = createSource({ 'conversation-1': 'running' });
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.getGenerationSettlementState.mockImplementationOnce(async () => {
      await gate;
      return undefined;
    });
    const waiting = waitForGenerationSettled(source, 'conversation-1', {
      signal: controller.signal,
      maxWaitMs: 500,
    });
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    release();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(source.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
