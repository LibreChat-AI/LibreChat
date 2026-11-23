import { z } from 'zod';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** Fixed protocol envelope budget; payload limits continue to apply to the inner SDK frame. */
export const RECOVERY_HEADER_BYTES = 512;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const header = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    kind: z.literal('data'),
    connection: z.string().uuid(),
    sequence: counter.positive(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal('end'),
    connection: z.string().uuid(),
    sequence: counter.positive(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal('failure'),
    connection: z.string().uuid(),
    sequence: counter,
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal('ack'),
    connection: z.string().uuid(),
    sequence: counter,
  }),
]);
export interface RecoveryLog {
  append(id: string, payload: string): Promise<number>;
  appendBatch?(id: string, payloads: string[]): Promise<{ first: number; last: number }>;
  maxBatchFrames?: number;
  maxBatchBytes?: number;
  read(after: number): Promise<Array<{ sequence: number; payload: string }>>;
  acknowledge(sequence: number): Promise<void>;
  head(): number;
}
/** Bounded request-local host log; host-process execution adoption is deliberately not implied. */
export function createMemoryRecoveryLog(maxBytes: number): RecoveryLog {
  const frames: string[] = [];
  let bytes = 0;
  return {
    append: async (_id, payload) => {
      bytes += Buffer.byteLength(payload);
      if (bytes > maxBytes) throw new Error('SDK recovery log capacity exceeded');
      frames.push(payload);
      return frames.length;
    },
    read: async (after) => {
      if (after > frames.length) throw new Error('SDK recovery cursor is ahead');
      return frames
        .slice(after, after + 128)
        .map((payload, i) => ({ sequence: after + i + 1, payload }));
    },
    acknowledge: async (sequence) => {
      if (sequence > frames.length) throw new Error('SDK recovery cursor is ahead');
    },
    head: () => frames.length,
  };
}

/**
 * A physical close detaches only the wire. Frames are committed before publication and duplicate
 * sequence numbers never enter the existing SDK handlers twice. Logical close is an acknowledged,
 * replayable control frame, so cancellation survives a transient wire failure.
 */
export class RecoverySocket extends EventEmitter {
  private wire?: WebSocket;
  private connection?: string;
  private tail = Promise.resolve();
  private pendingFrames: Array<{
    kind: 'data' | 'end';
    payload: string;
    encoded: string;
    bytes: number;
  }> = [];

  private scheduled = false;
  private acknowledgement?: Promise<void>;
  private requestedAck = 0;
  private received = 0;
  private acknowledged = 0;
  private queuedBytes = 0;
  private closed = false;
  private ending = false;
  private generation = 0;
  private replaying = false;
  private failure?: Error;
  private endSequence?: number;
  private endResolve?: () => void;
  private readonly ended = new Promise<void>((resolve) => {
    this.endResolve = resolve;
  });

  constructor(
    private readonly options: {
      log: RecoveryLog;
      maxFrameBytes: number;
      maxBufferedBytes: number;
      onDisconnect: () => void;
      onFailure: (error: unknown) => void;
      terminalFailure?: boolean;
    },
  ) {
    super();
  }

  get readyState(): number {
    return this.closed ? WebSocket.CLOSED : WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.queuedBytes + (this.wire?.bufferedAmount ?? 0);
  }

  get cursor(): number {
    return this.received;
  }

  get hasWire(): boolean {
    return this.wire?.readyState === WebSocket.OPEN;
  }

  get isEnding(): boolean {
    return this.ending;
  }

  private fail = (error: unknown) => {
    this.failure = new Error('SDK recovery transport failed');
    try {
      this.options.onFailure(error);
    } catch {
      /* Diagnostics cannot prevent cleanup. */
    }
    this.terminate();
  };

  private publish(kind: 'data' | 'end' | 'ack' | 'failure', sequence: number, payload = ''): void {
    if (!this.hasWire || !this.connection) return;
    const data =
      JSON.stringify({ version: 1, kind, connection: this.connection, sequence }) + '\n' + payload;
    if (this.wire!.bufferedAmount + Buffer.byteLength(data) > this.options.maxBufferedBytes) {
      this.wire!.terminate();
      return;
    }
    this.wire!.send(data);
  }

  private scheduleFlush(): void {
    if (this.scheduled || this.closed || !this.pendingFrames.length) return;
    this.scheduled = true;
    this.tail = this.tail
      .then(async () => {
        const maxFrames = this.options.log.appendBatch ? (this.options.log.maxBatchFrames ?? 1) : 1;
        const maxBytes = this.options.log.maxBatchBytes ?? this.options.maxBufferedBytes;
        let count = 0;
        let bytes = 0;
        for (const frame of this.pendingFrames) {
          if (count >= maxFrames || (count > 0 && bytes + frame.bytes > maxBytes)) break;
          count++;
          bytes += frame.bytes;
        }
        const batch = this.pendingFrames.splice(0, count);
        if (!batch.length) return;
        try {
          const id = randomUUID();
          const range = this.options.log.appendBatch
            ? await this.options.log.appendBatch(
                id,
                batch.map((f) => f.encoded),
              )
            : { first: await this.options.log.append(id, batch[0].encoded) };
          for (let index = 0; index < batch.length; index++) {
            const frame = batch[index];
            const sequence = range.first + index;
            if (frame.kind === 'end') this.endSequence = sequence;
            if (!this.replaying) this.publish(frame.kind, sequence, frame.payload);
          }
        } finally {
          this.queuedBytes -= bytes;
        }
      })
      .catch(this.fail)
      .finally(() => {
        this.scheduled = false;
        this.scheduleFlush();
      });
  }

  private queue(kind: 'data' | 'end', payload: string): void {
    const encoded = JSON.stringify({ kind, payload });
    const bytes = Buffer.byteLength(encoded);
    if (
      Buffer.byteLength(payload) > this.options.maxFrameBytes ||
      this.bufferedAmount + bytes > this.options.maxBufferedBytes
    )
      throw new Error('SDK recovery frame capacity exceeded');
    this.queuedBytes += bytes;
    this.pendingFrames.push({ kind, payload, encoded, bytes });
    this.scheduleFlush();
  }

  private persistAcknowledgement(): void {
    if (this.acknowledgement || this.closed || this.requestedAck <= this.acknowledged) return;
    this.acknowledgement = Promise.resolve()
      .then(async () => {
        const sequence = this.requestedAck;
        await this.options.log.acknowledge(sequence);
        this.acknowledged = sequence;
        if (this.endSequence != null && sequence >= this.endSequence) this.terminate();
      })
      .catch((error) => {
        if (!this.closed) this.fail(error);
      })
      .finally(() => {
        this.acknowledgement = undefined;
        this.persistAcknowledgement();
      });
  }

  send(data: string): void {
    if (this.closed || this.ending) throw new Error('SDK recovery connection closed');
    this.queue('data', data);
  }

  close(_code?: number): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    try {
      this.queue('end', '');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Abort is reserved for expiry, shutdown, or a definitively failed journal. */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    for (const frame of this.pendingFrames) this.queuedBytes -= frame.bytes;
    this.pendingFrames.length = 0;
    this.generation++;
    this.wire?.terminate();
    this.wire = undefined;
    this.endResolve?.();
    this.emit('close');
  }

  async flush(): Promise<void> {
    do {
      await this.tail;
    } while (!this.closed && (this.scheduled || this.pendingFrames.length));
    if (this.failure) throw this.failure;
  }

  waitForClose(): Promise<void> {
    return this.ended;
  }

  attach(wire: WebSocket, connection: string, after: number, ready?: string): void {
    if (this.closed) {
      wire.close(1000);
      return;
    }
    const old = this.wire;
    this.wire = wire;
    this.connection = connection;
    this.replaying = true;
    const generation = ++this.generation;
    old?.close(1000);
    const detached = () => {
      if (generation !== this.generation || this.closed || this.wire !== wire) return;
      this.wire = undefined;
      this.options.onDisconnect();
    };
    wire.once('close', detached);
    wire.once('error', detached);
    wire.on('message', (raw) => {
      if (generation !== this.generation || this.closed) return;
      // No async receive queue: durable ACK bookkeeping must not retain raw frames or
      // delay cancellation. The SDK peer bounds outstanding event/RPC handler work.
      try {
        const text = raw.toString();
        if (Buffer.byteLength(text) > this.options.maxBufferedBytes)
          throw new Error('SDK recovery receive capacity exceeded');
        const split = text.indexOf('\n');
        if (split < 0 || Buffer.byteLength(text.slice(0, split)) > RECOVERY_HEADER_BYTES)
          throw new Error('Invalid SDK recovery envelope');
        const frame = header.parse(JSON.parse(text.slice(0, split)));
        const payload = text.slice(split + 1);
        if (
          frame.connection !== this.connection ||
          Buffer.byteLength(payload) > this.options.maxFrameBytes
        )
          throw new Error('Invalid SDK recovery frame');
        if (frame.kind === 'failure') {
          if (frame.sequence !== this.received)
            throw new Error('SDK recovery terminal cursor mismatch');
          this.emit('message', Buffer.from('{"type":"error"}'));
          return;
        }
        if (frame.kind === 'ack') {
          if (frame.sequence > this.options.log.head())
            throw new Error('SDK recovery cursor is ahead');
          this.requestedAck = Math.max(this.requestedAck, frame.sequence);
          this.persistAcknowledgement();
          return;
        }
        if (frame.sequence <= this.received) {
          this.publish('ack', this.received);
          return;
        }
        if (frame.sequence !== this.received + 1) throw new Error('SDK recovery sequence gap');
        this.received = frame.sequence;
        if (frame.kind === 'end') {
          this.publish('ack', this.received);
          // Allow the acknowledgement to leave before closing the physical connection.
          this.closed = true;
          this.endResolve?.();
          this.emit('close');
          wire.close(1000);
        } else {
          this.emit('message', Buffer.from(payload));
          this.publish('ack', this.received);
        }
      } catch (error) {
        this.fail(error);
      }
    });
    if (ready) wire.send(ready);
    // Serialize replay with publication so new live frames cannot overtake its prefix.
    this.tail = this.tail
      .then(async () => {
        if (after > this.options.log.head()) throw new Error('SDK recovery cursor is ahead');
        let cursor = after;
        while (generation === this.generation && this.hasWire) {
          const frames = await this.options.log.read(cursor);
          if (generation !== this.generation || !this.hasWire || !frames.length) break;
          for (const frame of frames) {
            const entry = z
              .object({ kind: z.enum(['data', 'end']), payload: z.string() })
              .parse(JSON.parse(frame.payload));
            this.publish(entry.kind, frame.sequence, entry.payload);
            cursor = frame.sequence;
          }
        }
        if (generation === this.generation && this.options.terminalFailure)
          this.publish('failure', cursor);
      })
      .finally(() => {
        if (generation === this.generation) this.replaying = false;
      })
      .catch(this.fail);
  }
}
