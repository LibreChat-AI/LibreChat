import { z } from 'zod';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { encodeSdkValue, decodeSdkValue } from './wire';

export type SdkRpc = (method: string, data: unknown) => Promise<unknown>;
export type SdkFrame =
  | { type: 'call'; id: string; method: string; data: unknown }
  | { type: 'result'; id: string; data: unknown; failed?: boolean }
  | { type: 'event'; name: string; data: unknown; metadata?: Record<string, unknown> }
  | { type: 'done'; data: unknown }
  | { type: 'error' };

const frameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call'),
    id: z.string().uuid(),
    method: z.string().min(1).max(64),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal('result'),
    id: z.string().uuid(),
    data: z.unknown(),
    failed: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('event'),
    name: z.string().min(1).max(128),
    data: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('done'), data: z.unknown() }),
  z.object({ type: z.literal('error') }),
]);

/** Ordered dispatch and bounded RPC lifetime. Errors on this boundary never disclose upstream text. */
export function createSdkPeer(
  socket: WebSocket,
  options: {
    maxFrameBytes: number;
    maxBufferedBytes: number;
    timeoutMs: number;
    onCall: SdkRpc;
    onFrame: (frame: SdkFrame) => Promise<void>;
    onClose: (error: Error) => void;
    onError?: (error: unknown) => void;
  },
) {
  const pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  const incoming = new Set<string>();
  let queue = Promise.resolve();
  let closed = false;
  let queuedBytes = 0;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /* Diagnostics must not prevent cleanup. */
    }
  };
  const failure = () => new Error('SDK runtime connection failed');
  const send = (frame: SdkFrame): void => {
    if (closed || socket.readyState !== WebSocket.OPEN) throw failure();
    const data = JSON.stringify(encodeSdkValue(frame));
    if (
      Buffer.byteLength(data) > options.maxFrameBytes ||
      socket.bufferedAmount + Buffer.byteLength(data) > options.maxBufferedBytes
    )
      throw failure();
    socket.send(data);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(failure());
    pending.clear();
    options.onClose(failure());
  };
  socket.on('close', close);
  socket.on('error', close);
  socket.on('message', (raw) => {
    if (closed) return;
    const bytes = Buffer.byteLength(raw.toString());
    if (bytes > options.maxFrameBytes) {
      socket.close(1009);
      return;
    }
    let frame: SdkFrame;
    try {
      frame = frameSchema.parse(decodeSdkValue(JSON.parse(raw.toString())));
    } catch {
      socket.close(1008);
      return;
    }
    // RPC replies must bypass the event queue: a handler may itself be awaiting this reply.
    if (frame.type === 'result') {
      const entry = pending.get(frame.id);
      if (entry == null) return;
      pending.delete(frame.id);
      if (frame.failed) entry.reject(failure());
      else entry.resolve(frame.data);
      return;
    }
    if (frame.type === 'call') {
      if (incoming.has(frame.id)) {
        close();
        socket.close(1008);
        return;
      }
      incoming.add(frame.id);
      queuedBytes += bytes;
      if (queuedBytes > options.maxBufferedBytes) {
        close();
        socket.close(1009);
        return;
      }
      const dispatch = () =>
        Promise.resolve()
          .then(() => {
            if (closed) throw failure();
            return options.onCall(frame.method, frame.data);
          })
          .then(
            (data) => send({ type: 'result', id: frame.id, data }),
            (error) => {
              report(error);
              send({ type: 'result', id: frame.id, failed: true, data: null });
            },
          )
          .catch(() => socket.close(1011))
          .finally(() => {
            incoming.delete(frame.id);
            queuedBytes -= bytes;
          });
      // Hooks observe all earlier events and can reserve content slots for later ones.
      // Ordinary RPCs stay reentrant; replies above always bypass this barrier.
      if (frame.method === 'hook') queue = queue.then(dispatch);
      else void dispatch();
      return;
    }
    queuedBytes += bytes;
    if (queuedBytes > options.maxBufferedBytes) {
      close();
      socket.close(1009);
      return;
    }
    queue = queue
      .then(() => (closed ? undefined : options.onFrame(frame)))
      .finally(() => {
        queuedBytes -= bytes;
      })
      .catch((error) => {
        report(error);
        close();
        socket.close(1011);
      });
  });
  const call: SdkRpc = async (method, data) => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(failure());
      }, options.timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        send({ type: 'call', id, method, data });
      } catch (error) {
        pending.get(id)?.reject(error instanceof Error ? error : failure());
        pending.delete(id);
      }
    });
  };
  return { call, send, close };
}
