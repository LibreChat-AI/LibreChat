import { z } from 'zod';
import { LogLevel } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayRuntimeConfig } from './config';
import type { GatewayConfig } from './config';
import type { GatewayApp } from './app';
import type { Logger } from './types';

const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel: () => LogLevel.ERROR,
};
const event = z.object({
  type: z.enum(['events_api', 'interactive']),
  body: z.unknown(),
  envelope_id: z.string().min(1),
  ack: z.custom<(value?: object) => Promise<void>>((value) => typeof value === 'function'),
});

/** The SDK hides hello's connection_info; validate it before permitting its event dispatch. */
export class BoundSocket extends SocketModeClient {
  private phase: 'handshaking' | 'verified' | 'inactive' = 'handshaking';
  constructor(
    private readonly appId: string,
    private readonly state: (connected: boolean) => void,
    config: GatewayConfig,
    signal?: AbortSignal,
  ) {
    super({
      appToken: config.SLACK_APP_TOKEN!,
      logger: quiet,
      // SDK 3.1's automatic reconnect discards start rejections. The gateway owns that task.
      autoReconnectEnabled: false,
      clientOptions: {
        slackApiUrl: config.SLACK_API_BASE_URL.replace(/\/?$/, '/'),
        timeout: config.API_CALL_TIMEOUT_MS,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        allowAbsoluteUrls: false,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([
              AbortSignal.timeout(config.API_CALL_TIMEOUT_MS),
              ...(signal ? [signal] : []),
            ]),
          }),
      },
    });
    this.on('connecting', () => {
      // An aborted URL fetch may already have settled; close a late-created SDK socket too.
      if (signal?.aborted)
        queueMicrotask(() => {
          void this.disconnect().catch(() => {});
        });
    });
    for (const phase of ['connecting', 'reconnecting', 'disconnecting', 'disconnected', 'error'])
      this.on(phase, () => {
        this.phase = phase === 'connecting' ? 'handshaking' : 'inactive';
        this.state(false);
      });
  }

  protected override async onWebSocketMessage(
    data: string | ArrayBuffer,
    binary: boolean,
  ): Promise<void> {
    if (binary) return;
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (Buffer.byteLength(raw) > 1024 * 1024) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const envelope = z
      .object({
        type: z.string(),
        connection_info: z.unknown().optional(),
        envelope_id: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(parsed);
    if (!envelope.success) return;
    const value = envelope.data;
    if (value.type === 'hello') {
      const connection = z
        .object({ app_id: z.literal(this.appId) })
        .safeParse(value.connection_info);
      if (!connection.success) {
        this.state(false);
        this.phase = 'inactive';
        await this.disconnect().catch(() => {});
        return;
      }
      if (this.phase !== 'handshaking') return;
      this.phase = 'verified';
      this.state(true);
    } else if (value.type === 'disconnect') {
      this.phase = 'inactive';
      this.state(false);
    } else {
      if (this.phase !== 'verified' || !value.envelope_id || !value.payload) return;
      if (value.type === 'events_api') {
        if (
          !z.object({ event: z.object({ type: z.string().min(1) }) }).safeParse(value.payload)
            .success
        )
          return;
      } else if (value.type !== 'interactive') return;
    }
    try {
      await super.onWebSocketMessage(data, binary);
    } catch {
      // The SDK invokes this async callback without awaiting it. Contain malformed frames here.
      this.phase = 'inactive';
      this.state(false);
      this.emit('error', new Error('Socket message rejected'));
      await this.disconnect().catch(() => {});
    }
  }
}

export interface SocketConnection {
  socket: BoundSocket;
  /** Owned supervision/cleanup; rejects only an unexpected lifecycle failure. */
  closed: Promise<void>;
}

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('Gateway stopped'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export async function connectSocket(
  config: GatewayRuntimeConfig,
  app: GatewayApp,
  appId: string,
  log: Logger,
  signal: AbortSignal,
): Promise<SocketConnection> {
  signal.throwIfAborted();
  app.bindSocketApp(appId);
  app.connected = false;
  const socket = new BoundSocket(
    appId,
    (connected) => {
      app.connected = connected && !signal.aborted;
    },
    config,
    signal,
  );
  for (const phase of ['connecting', 'reconnecting', 'disconnected'])
    socket.on(phase, () => {
      app.connected = false;
    });
  socket.on('error', () => log.warn('slack_socket_transport_error'));
  socket.on('slack_event', (input: unknown) => {
    if (!app.connected || signal.aborted) return;
    const delivery = event.safeParse(input);
    if (!delivery.success) return;
    if (
      z
        .object({ event: z.object({ type: z.literal('agent_session_stopped') }) })
        .safeParse(delivery.data.body).success
    )
      log.info('slack_native_stop_received');
    void app
      .dispatch(delivery.data.body, delivery.data.type === 'interactive', signal)
      .then((payload) => delivery.data.ack(payload))
      .catch(() => log.warn('slack_socket_delivery_not_accepted'));
  });

  let resolveReady: () => void = () => {};
  let rejectReady: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let cleanup: Promise<void> | undefined;
  const close = () => {
    if (!cleanup)
      cleanup = (async () => {
        app.connected = false;
        let disconnect: Promise<void>;
        try {
          disconnect = socket.disconnect();
        } catch (error) {
          disconnect = Promise.reject(error);
        }
        const results = await Promise.allSettled([disconnect]);
        if (results.some((result) => result.status === 'rejected'))
          log.warn('slack_socket_shutdown_unconfirmed');
      })();
    return cleanup;
  };
  const stop = () => {
    app.connected = false;
    void close();
  };
  signal.addEventListener('abort', stop, { once: true });
  const closed = (async () => {
    let hasConnected = false;
    let failures = 0;
    try {
      while (!signal.aborted) {
        let disconnected: () => void = () => {};
        const ended = new Promise<void>((resolve) => {
          disconnected = resolve;
        });
        socket.once('disconnected', disconnected);
        try {
          await untilAbort(socket.start(), signal);
          signal.throwIfAborted();
          failures = 0;
          if (!hasConnected) {
            hasConnected = true;
            resolveReady();
          }
          await untilAbort(ended, signal);
        } catch (error) {
          if (signal.aborted) break;
          if (!hasConnected) throw error;
          log.warn('slack_socket_reconnect_failed');
        } finally {
          socket.removeListener('disconnected', disconnected);
          app.connected = false;
        }
        if (signal.aborted) break;
        failures++;
        // Node's timer ceiling is a platform constraint, not a retry policy limit.
        const wait = Math.min(config.socketReconnectDelayMs * failures, 2_147_483_647);
        try {
          await delay(wait, undefined, { signal });
        } catch {
          break;
        }
        socket.emit('reconnecting');
      }
    } finally {
      if (!hasConnected && signal.aborted) rejectReady(new Error('Gateway stopped'));
      signal.removeEventListener('abort', stop);
      await close();
    }
  })();
  // Own failures even before the initial handle can be returned; main also observes completion.
  void closed.catch(rejectReady);
  try {
    await ready;
    signal.throwIfAborted();
  } catch (error) {
    await closed.catch(() => {});
    throw error;
  }
  return { socket, closed };
}
