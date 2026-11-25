import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';
import { subagentActivityConfigSchema } from 'librechat-data-provider';
import type { ReplayLimits, ReplayPublication } from '../internal/replay';
import type { IEventTransport } from '../interfaces/IJobStore';

interface StreamState {
  emitter: EventEmitter;
  allSubscribersLeftCallback?: () => void;
}

interface ReplayBuffer {
  events: Array<{ type: 'chunk' | 'done'; data: unknown; bytes: number }>;
  bytes: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  publication?: ReplayPublication;
  done: boolean;
}

/**
 * In-memory event transport using Node.js EventEmitter.
 * For horizontal scaling, replace with RedisEventTransport.
 */
export class InMemoryEventTransport implements IEventTransport {
  private replay = new Map<string, ReplayBuffer>();
  private replayBytes = 0;
  private readonly replayMaxStreams: number;
  private readonly replayMaxBytes: number;

  constructor(options: { maxStreams?: number; maxBytes?: number } = {}) {
    const config = subagentActivityConfigSchema.parse({
      memoryMaxStreams: options.maxStreams,
      memoryMaxBytes: options.maxBytes,
    });
    this.replayMaxStreams = config.memoryMaxStreams;
    this.replayMaxBytes = config.memoryMaxBytes;
  }

  private streams = new Map<string, StreamState>();
  private providerDrainProofs = new Map<string, number>();
  private providerDrainWrites = 0;

  private static readonly PROVIDER_DRAIN_PROOF_TTL_MS = 5 * 60_000;

  private providerDrainKey(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): string {
    return `${streamId}:${generationId}:${providerExecutionId}`;
  }

  private getOrCreateStream(streamId: string): StreamState {
    let state = this.streams.get(streamId);
    if (!state) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(100);
      state = { emitter };
      this.streams.set(streamId, state);
    }
    return state;
  }

  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown, generationId?: number) => void;
      onReplay?: (events: unknown[]) => void;
      onDone?: (event: unknown, generationId?: number) => void;
      onError?: (error: string, generationId?: number) => void;
    },
    options?: { replay?: ReplayLimits },
  ): { unsubscribe: () => void; ready?: Promise<void> } {
    if (options?.replay != null) {
      const cached = this.replay.get(streamId);
      if (cached != null && cached.expiresAt <= Date.now()) this.dropReplay(streamId);
      const snapshot = this.replay.get(streamId)?.events.slice() ?? [];
      let attached = false;
      let closed = false;
      let pendingBytes = 0;
      const pending: Array<{ type: 'chunk' | 'done'; data: unknown }> = [];
      const deliver = (type: 'chunk' | 'done', data: unknown) => {
        if (closed) return;
        if (attached) {
          if (type === 'chunk') handlers.onChunk(data);
          else handlers.onDone?.(data);
          return;
        }
        pendingBytes += Buffer.byteLength(JSON.stringify(data), 'utf8');
        if (pending.length >= options.replay!.items || pendingBytes > options.replay!.bytes) {
          closed = true;
          subscription.unsubscribe();
          handlers.onError?.('Activity replay buffer overflow; reconnect to replay.');
          return;
        }
        pending.push({ type, data });
      };
      const subscription = this.subscribe(streamId, {
        onChunk: (data) => deliver('chunk', data),
        onDone: (data) => deliver('done', data),
        onError: handlers.onError,
      });
      return {
        unsubscribe: () => {
          closed = true;
          subscription.unsubscribe();
        },
        ready: Promise.resolve().then(() => {
          if (closed) return;
          const chunks = snapshot
            .filter((event) => event.type === 'chunk')
            .map((event) => event.data);
          if (handlers.onReplay != null) handlers.onReplay(chunks);
          else chunks.forEach((data) => handlers.onChunk(data));
          attached = true;
          for (const event of snapshot) if (event.type === 'done') deliver('done', event.data);
          for (const event of pending) deliver(event.type, event.data);
          pending.length = 0;
        }),
      };
    }
    const state = this.getOrCreateStream(streamId);

    const chunkHandler = (event: unknown, generationId?: number) => {
      if (generationId == null) {
        handlers.onChunk(event);
        return;
      }
      handlers.onChunk(event, generationId);
    };
    const doneHandler = (event: unknown, generationId?: number) => {
      if (generationId == null) {
        handlers.onDone?.(event);
        return;
      }
      handlers.onDone?.(event, generationId);
    };
    const errorHandler = (error: string, generationId?: number) => {
      if (generationId == null) {
        handlers.onError?.(error);
        return;
      }
      handlers.onError?.(error, generationId);
    };

    state.emitter.on('chunk', chunkHandler);
    state.emitter.on('done', doneHandler);
    state.emitter.on('error', errorHandler);

    logger.debug(
      `[InMemoryEventTransport] subscribe ${streamId}: listeners=${state.emitter.listenerCount('chunk')}`,
    );

    return {
      unsubscribe: () => {
        const currentState = this.streams.get(streamId);
        if (currentState) {
          if (!currentState.emitter.listeners('chunk').includes(chunkHandler)) {
            return;
          }

          currentState.emitter.off('chunk', chunkHandler);
          currentState.emitter.off('done', doneHandler);
          currentState.emitter.off('error', errorHandler);

          // Check if all subscribers left - cleanup and notify
          if (currentState.emitter.listenerCount('chunk') === 0) {
            currentState.allSubscribersLeftCallback?.();
            /* Remove all EventEmitter listeners but preserve stream state
             * (including allSubscribersLeftCallback) for reconnection.
             * State is fully cleaned up by cleanup() when the job completes.
             */
            currentState.emitter.removeAllListeners();
          }
        }
      },
    };
  }

  private dropReplay(streamId: string): void {
    const buffer = this.replay.get(streamId);
    if (buffer == null) return;
    if (buffer.timer != null) clearTimeout(buffer.timer);
    this.replayBytes -= buffer.bytes;
    this.replay.delete(streamId);
  }

  private retainReplay(
    streamId: string,
    type: 'chunk' | 'done',
    data: unknown,
    limits: ReplayLimits,
    publication?: ReplayPublication,
  ): boolean {
    const cached = this.replay.get(streamId);
    if (cached != null && cached.expiresAt <= Date.now()) this.dropReplay(streamId);
    const existing = this.replay.get(streamId);
    if (
      existing?.done === true ||
      (publication != null &&
        existing?.publication != null &&
        (existing.publication.id === publication.id ||
          (publication.sequence != null &&
            existing.publication.sequence != null &&
            publication.sequence <= existing.publication.sequence)))
    )
      return false;
    const buffer: ReplayBuffer = existing ?? { events: [], bytes: 0, expiresAt: 0, done: false };
    const priorBytes = buffer.bytes;
    const bytes = Buffer.byteLength(JSON.stringify({ type, data }), 'utf8');
    buffer.events.push({ type, data, bytes });
    buffer.bytes += bytes;
    while (buffer.events.length > limits.items || buffer.bytes > limits.bytes) {
      buffer.bytes -= buffer.events.shift()!.bytes;
    }
    buffer.publication = publication;
    buffer.done = type === 'done';
    buffer.expiresAt = Date.now() + limits.ttlMs;
    if (buffer.timer != null) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => this.dropReplay(streamId), limits.ttlMs);
    buffer.timer.unref?.();
    /** Map insertion order is a write-recency eviction queue, independent of stream cleanup. */
    this.replay.delete(streamId);
    this.replay.set(streamId, buffer);
    this.replayBytes += buffer.bytes - priorBytes;
    while (this.replay.size > this.replayMaxStreams || this.replayBytes > this.replayMaxBytes) {
      const oldest = this.replay.keys().next().value;
      if (oldest == null) break;
      this.dropReplay(oldest);
    }
    return true;
  }

  async emitReplayableChunk(
    streamId: string,
    event: unknown,
    limits: ReplayLimits,
    publication?: ReplayPublication,
  ): Promise<void> {
    if (this.retainReplay(streamId, 'chunk', event, limits, publication))
      this.emitChunk(streamId, event);
  }

  async emitReplayableDone(
    streamId: string,
    event: unknown,
    limits: ReplayLimits,
    publication?: ReplayPublication,
  ): Promise<void> {
    if (this.retainReplay(streamId, 'done', event, limits, publication))
      this.emitDone(streamId, event);
  }

  emitChunk(streamId: string, event: unknown, generationId?: number): void {
    const state = this.streams.get(streamId);
    state?.emitter.emit('chunk', event, generationId);
  }

  emitDone(streamId: string, event: unknown, generationId?: number): void {
    const state = this.streams.get(streamId);
    state?.emitter.emit('done', event, generationId);
  }

  emitError(streamId: string, error: string, generationId?: number): void {
    const state = this.streams.get(streamId);
    // Only emit if there are listeners - Node.js throws on unhandled 'error' events
    // This is intentional for the race condition where error occurs before client connects
    if (state?.emitter.listenerCount('error') ?? 0 > 0) {
      state?.emitter.emit('error', error, generationId);
    }
  }

  renewDemand(_streamId: string, _ttlMs: number): void {
    // The in-process subscriber count is authoritative; no lease is needed.
  }

  hasDemand(streamId: string): boolean {
    return this.getSubscriberCount(streamId) > 0;
  }

  async recordProviderDrain(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    const now = Date.now();
    this.providerDrainWrites++;
    if (this.providerDrainWrites % 256 === 0) {
      for (const [key, expiresAt] of this.providerDrainProofs) {
        if (expiresAt <= now) {
          this.providerDrainProofs.delete(key);
        }
      }
    }
    this.providerDrainProofs.set(
      this.providerDrainKey(streamId, generationId, providerExecutionId),
      now + InMemoryEventTransport.PROVIDER_DRAIN_PROOF_TTL_MS,
    );
    return true;
  }

  async hasProviderDrain(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    const key = this.providerDrainKey(streamId, generationId, providerExecutionId);
    const expiresAt = this.providerDrainProofs.get(key);
    if (expiresAt == null) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.providerDrainProofs.delete(key);
      return false;
    }
    return true;
  }

  getSubscriberCount(streamId: string): number {
    const state = this.streams.get(streamId);
    return state?.emitter.listenerCount('chunk') ?? 0;
  }

  onAllSubscribersLeft(streamId: string, callback: () => void): void {
    const state = this.getOrCreateStream(streamId);
    state.allSubscribersLeftCallback = callback;
  }

  /**
   * Check if this is the first subscriber (for ready signaling)
   */
  isFirstSubscriber(streamId: string): boolean {
    const state = this.streams.get(streamId);
    const count = state?.emitter.listenerCount('chunk') ?? 0;
    logger.debug(`[InMemoryEventTransport] isFirstSubscriber ${streamId}: count=${count}`);
    return count === 1;
  }

  closeLocalSubscribers(streamId: string, error: string): void {
    const state = this.streams.get(streamId);
    if (!state) {
      return;
    }

    const errorListeners = state.emitter.listeners('error');
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch (err) {
        logger.error(
          `[InMemoryEventTransport] Failed to close local subscriber for ${streamId}:`,
          err,
        );
      }
    }

    if (state.emitter.listenerCount('chunk') === 0) {
      return;
    }

    state.emitter.removeAllListeners();
    state.allSubscribersLeftCallback?.();
  }

  /**
   * Cleanup a stream's event emitter
   */
  cleanup(streamId: string): void {
    const state = this.streams.get(streamId);
    if (state) {
      state.emitter.removeAllListeners();
      this.streams.delete(streamId);
    }
  }

  /**
   * Get count of tracked streams (for monitoring)
   */
  getStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Get all tracked stream IDs (for orphan cleanup)
   */
  getTrackedStreamIds(): string[] {
    return Array.from(this.streams.keys());
  }

  destroy(): void {
    for (const buffer of this.replay.values()) if (buffer.timer != null) clearTimeout(buffer.timer);
    this.replay.clear();
    this.replayBytes = 0;
    for (const state of this.streams.values()) {
      state.emitter.removeAllListeners();
    }
    this.streams.clear();
    this.providerDrainProofs.clear();
    this.providerDrainWrites = 0;
    logger.debug('[InMemoryEventTransport] Destroyed');
  }
}
