import { z } from 'zod';
import { LogLevel } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
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
  private validated = false;
  constructor(
    private readonly appId: string,
    private readonly state: (connected: boolean) => void,
    config: GatewayConfig,
    signal?: AbortSignal,
  ) {
    super({
      appToken: config.SLACK_APP_TOKEN!,
      logger: quiet,
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
    for (const phase of ['connecting', 'reconnecting', 'disconnected'])
      this.on(phase, () => {
        this.validated = false;
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
        this.validated = false;
        await this.disconnect().catch(() => {});
        return;
      }
      this.validated = true;
      this.state(true);
    } else if (value.type === 'disconnect') {
      this.validated = false;
      this.state(false);
    } else {
      if (!this.validated || !value.envelope_id || !value.payload) return;
      if (value.type === 'events_api') {
        if (
          !z.object({ event: z.object({ type: z.string().min(1) }) }).safeParse(value.payload)
            .success
        )
          return;
      } else if (value.type !== 'interactive') return;
    }
    await super.onWebSocketMessage(data, binary);
  }
}

export async function connectSocket(
  config: GatewayConfig,
  app: GatewayApp,
  appId: string,
  log: Logger,
  signal: AbortSignal,
): Promise<BoundSocket> {
  app.connected = false;
  const socket = new BoundSocket(
    appId,
    (connected) => {
      app.connected = connected && !signal.aborted;
    },
    config,
    signal,
  );
  socket.on('connecting', () => {
    app.connected = false;
  });
  socket.on('reconnecting', () => {
    app.connected = false;
  });
  socket.on('disconnected', () => {
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
  if (signal.aborted) throw new Error('Gateway stopped');
  let rejectAborted: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const stop = () => {
    app.connected = false;
    void socket.disconnect().catch(() => {});
    rejectAborted(new Error('Gateway stopped'));
  };
  signal.addEventListener('abort', stop, { once: true });
  const started = socket.start();
  void started.then(
    () => {
      if (signal.aborted) void socket.disconnect().catch(() => {});
    },
    () => {},
  );
  try {
    await Promise.race([started, aborted]);
  } catch (error) {
    signal.removeEventListener('abort', stop);
    await socket.disconnect().catch(() => {});
    throw error;
  }
  signal.throwIfAborted();
  return socket;
}
