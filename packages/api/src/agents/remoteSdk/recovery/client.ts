import { z } from 'zod';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { RemoteSdkLimits, RemoteSdkRecoveryOptions } from '../types';
import type { RecoveryClaim } from './server';
import { RecoverySocket, createMemoryRecoveryLog, RECOVERY_HEADER_BYTES } from './socket';

export async function connectRecoveringSdkSocket(options: {
  url: string;
  token: (claim: RecoveryClaim) => string;
  generation?: string;
  limits: RemoteSdkLimits;
  recovery: RemoteSdkRecoveryOptions;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}): Promise<RecoverySocket> {
  const { limits, recovery } = options;
  if (Object.values(recovery).some((v) => !Number.isSafeInteger(v) || v <= 0))
    throw new Error('Invalid SDK recovery configuration');
  if (recovery.maxDisconnectMs >= limits.rpcTimeoutMs)
    throw new Error('SDK recovery window must be shorter than the RPC timeout');
  const sessionId = randomUUID();
  let connected = false;
  let connecting = false;
  let deadline = Date.now() + recovery.maxDisconnectMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let current: WebSocket | undefined;
  let resolve!: (socket: RecoverySocket) => void;
  let reject!: (error: Error) => void;
  const first = new Promise<RecoverySocket>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /* Trusted diagnostics only. */
    }
  };
  const failed = (error: unknown) => {
    report(error);
    reject(new Error('SDK runtime recovery failed'));
    socket.terminate();
  };
  const schedule = () => {
    if (socket.readyState !== WebSocket.OPEN || retry || connecting) return;
    if (Date.now() >= deadline) {
      failed(new Error('SDK runtime recovery window expired'));
      return;
    }
    retry = setTimeout(
      () => {
        retry = undefined;
        void connect();
      },
      Math.min(recovery.retryDelayMs, deadline - Date.now()),
    );
  };
  const socket = new RecoverySocket({
    log: createMemoryRecoveryLog(recovery.maxJournalBytes),
    maxFrameBytes: limits.maxFrameBytes,
    maxBufferedBytes: limits.maxBufferedBytes,
    onDisconnect: () => {
      deadline = Date.now() + recovery.maxDisconnectMs;
      schedule();
    },
    onFailure: failed,
  });
  socket.once('close', () => {
    clearTimeout(retry);
    current?.terminate();
    options.signal?.removeEventListener('abort', initialAbort);
    reject(new Error('SDK runtime recovery closed'));
  });
  const initialAbort = () => {
    if (connected) return;
    reject(Object.assign(new Error('SDK runtime connection cancelled'), { name: 'AbortError' }));
    socket.terminate();
  };
  options.signal?.addEventListener('abort', initialAbort, { once: true });
  const connect = async () => {
    if (socket.readyState !== WebSocket.OPEN || connecting) return;
    connecting = true;
    const wire = new WebSocket(options.url, {
      headers: {
        Authorization: `Bearer ${options.token({ sessionId, after: socket.cursor, resume: connected, generation: options.generation })}`,
      },
      handshakeTimeout: Math.min(limits.connectTimeoutMs, Math.max(1, deadline - Date.now())),
      maxPayload: limits.maxFrameBytes + RECOVERY_HEADER_BYTES,
      followRedirects: false,
    });
    current = wire;
    let handoff: (() => void) | undefined;
    const early: WebSocket.RawData[] = [];
    let earlyBytes = 0;
    try {
      const ready = await new Promise<{ connection: string; received: number }>((yes, no) => {
        const timer = setTimeout(
          () => no(new Error('SDK recovery handshake timed out')),
          Math.min(limits.connectTimeoutMs, Math.max(1, deadline - Date.now())),
        );
        const cleanup = (keepMessage = false) => {
          clearTimeout(timer);
          if (!keepMessage) wire.removeListener('message', message);
          wire.removeListener('close', closed);
          wire.removeListener('error', closed);
        };
        const closed = () => {
          cleanup();
          no(new Error('SDK recovery handshake failed'));
        };
        let readySeen = false;
        const message = (raw: WebSocket.RawData) => {
          if (readySeen) {
            earlyBytes += Buffer.byteLength(raw.toString());
            if (earlyBytes > limits.maxBufferedBytes) wire.terminate();
            else early.push(raw);
            return;
          }
          try {
            const frame = z
              .object({
                version: z.literal(1),
                kind: z.literal('ready'),
                sessionId: z.literal(sessionId),
                connection: z.string().uuid(),
                received: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              })
              .parse(JSON.parse(raw.toString()));
            readySeen = true;
            cleanup(true);
            handoff = () => wire.removeListener('message', message);
            yes(frame);
          } catch {
            cleanup();
            no(new Error('Invalid SDK recovery handshake'));
          }
        };
        wire.on('message', message);
        wire.once('close', closed);
        wire.once('error', closed);
      });
      if (wire.readyState !== WebSocket.OPEN) throw new Error('SDK recovery handshake closed');
      if (socket.readyState !== WebSocket.OPEN) {
        wire.terminate();
        return;
      }
      connected = true;
      options.signal?.removeEventListener('abort', initialAbort);
      socket.attach(wire, ready.connection, ready.received);
      handoff?.();
      for (const raw of early) wire.emit('message', raw);
      resolve(socket);
    } catch (error) {
      handoff?.();
      wire.terminate();
      report(error);
    } finally {
      connecting = false;
      if (!socket.hasWire) schedule();
    }
  };
  if (options.signal?.aborted) initialAbort();
  else void connect();
  return first;
}
