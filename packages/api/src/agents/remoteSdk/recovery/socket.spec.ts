import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { RecoveryLog } from './socket';
import { RecoverySocket } from './socket';

function fixture(overrides: Partial<RecoveryLog> = {}) {
  const entries: string[] = [];
  const appendBatch = jest.fn(async (_id: string, payloads: string[]) => {
    const first = entries.length + 1;
    entries.push(...payloads);
    return { first, last: entries.length };
  });
  const log: RecoveryLog = {
    head: () => entries.length,
    append: async (id, payload) => (await appendBatch(id, [payload])).last,
    appendBatch,
    maxBatchFrames: 8,
    maxBatchBytes: 1024,
    read: async (after) =>
      entries.slice(after).map((payload, i) => ({ sequence: after + i + 1, payload })),
    acknowledge: async () => undefined,
    ...overrides,
  };
  const onFailure = jest.fn();
  const socket = new RecoverySocket({
    log,
    maxFrameBytes: 256,
    maxBufferedBytes: 2048,
    onDisconnect: () => undefined,
    onFailure,
  });
  const wire = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
  });
  const connection = randomUUID();
  socket.attach(wire as unknown as WebSocket, connection, 0);
  const receive = (kind: string, sequence: number, payload = '') =>
    wire.emit(
      'message',
      Buffer.from(JSON.stringify({ version: 1, kind, connection, sequence }) + '\n' + payload),
    );
  return { socket, wire, receive, appendBatch, entries, onFailure };
}

it('batches a burst within configured journal bounds and publishes in sequence', async () => {
  const f = fixture();
  try {
    await f.socket.flush();
    for (let i = 0; i < 32; i++) f.socket.send(String(i));
    await f.socket.flush();
    expect(f.appendBatch).toHaveBeenCalledTimes(4);
    expect(f.entries.map((s) => JSON.parse(s).payload)).toEqual(
      Array.from({ length: 32 }, (_, i) => String(i)),
    );
    expect(f.wire.send.mock.calls.map(([s]) => JSON.parse(s.split('\n')[0]).sequence)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1),
    );
    expect(f.socket.bufferedAmount).toBe(0);
    expect(f.onFailure).not.toHaveBeenCalled();
  } finally {
    f.socket.terminate();
  }
});

it('coalesces held durable ACKs without queuing raw frames or blocking cancellation', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acknowledge = jest.fn(async () => held);
  const f = fixture({ acknowledge, head: () => 10000 });
  const receive = jest.fn();
  f.socket.on('message', receive);
  try {
    await f.socket.flush();
    f.receive('ack', 1);
    await Promise.resolve();
    for (let sequence = 2; sequence <= 10000; sequence++) f.receive('ack', sequence);
    f.receive('data', 1, '{"type":"cancel","id":"call"}');
    expect(receive).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(f.socket.bufferedAmount).toBe(0);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(acknowledge).toHaveBeenLastCalledWith(10000);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(f.onFailure).not.toHaveBeenCalled();
  } finally {
    release();
    f.socket.terminate();
  }
});

it('rejects an outgoing burst before exceeding the memory budget', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    appendBatch: async () => {
      await held;
      return { first: 1, last: 1 };
    },
  });
  try {
    await f.socket.flush();
    expect(() => {
      for (let i = 0; i < 100; i++) f.socket.send('x'.repeat(200));
    }).toThrow('capacity');
    expect(f.socket.bufferedAmount).toBeLessThanOrEqual(2048);
  } finally {
    release();
    f.socket.terminate();
    await f.socket.flush();
  }
});
