import { REST } from '@discordjs/rest';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { WebSocketManager, WebSocketShardEvents, SimpleIdentifyThrottler } from '@discordjs/ws';
import type { SessionInfo, ManagerShardEventsMap, IIdentifyThrottler } from '@discordjs/ws';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { RESTOptions } from '@discordjs/rest';
import { DiscordGatewayFailure } from './recovery';
import { DiscordRateCoordinator } from './rates';
import { boundedBody } from '../transport';

export type DiscordGatewayPolicy = DiscordChannelConfig['gateway'];
export type DiscordGatewayDispatch = ManagerShardEventsMap[WebSocketShardEvents.Dispatch][0];
export type DiscordGatewayReady = ManagerShardEventsMap[WebSocketShardEvents.Ready][0];
export interface DiscordGatewayDriver {
  connect(): Promise<void>;
  destroy(): Promise<void>;
}
export interface DiscordGatewayDriverOptions {
  token: string;
  policy: DiscordGatewayPolicy;
  maxResponseBytes: number;
  signal: AbortSignal;
  assertOwned(): void;
  retrieveSessionInfo(shardId: number): SessionInfo | null;
  updateSessionInfo(shardId: number, info: SessionInfo | null): Promise<void>;
  dispatch(event: DiscordGatewayDispatch): void;
  ready(event: DiscordGatewayReady): void;
  resumed(shardId: number): void;
  closed(code: number, shardId: number): void;
  error(): void;
  /** Round trip of one acknowledged heartbeat. The shard id is for health only, never a label. */
  heartbeat?(shardId: number, latencyMs: number): void;
}

function requestHeaders(input: Parameters<RESTOptions['makeRequest']>[1]['headers']): Headers {
  const headers = new Headers();
  if (!input) return headers;
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (pair.length !== 2) throw new Error('Invalid Discord request headers');
      headers.append(pair[0], pair[1]);
    }
  } else if ('forEach' in input && typeof input.forEach === 'function') {
    input.forEach((value: string, key: string) => headers.append(key, value));
  } else {
    for (const [key, value] of Object.entries(input))
      headers.append(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/** The promise itself is shared, including concurrent first identifies on separate shards. */
export function createOwnedIdentifyThrottler(
  options: Pick<DiscordGatewayDriverOptions, 'assertOwned' | 'signal'>,
) {
  let pending: Promise<IIdentifyThrottler> | undefined;
  return (
    manager: Pick<WebSocketManager, 'fetchGatewayInformation'>,
  ): Promise<IIdentifyThrottler> => {
    pending ??= manager.fetchGatewayInformation().then((info) => {
      const throttler = new SimpleIdentifyThrottler(info.session_start_limit.max_concurrency);
      return {
        async waitForIdentify(shardId: number, signal: AbortSignal) {
          options.assertOwned();
          const combined = AbortSignal.any([signal, options.signal]);
          combined.throwIfAborted();
          let abort = () => {};
          const stopped = new Promise<never>((_resolve, reject) => {
            abort = () => reject(new DOMException('Discord identify cancelled', 'AbortError'));
            combined.addEventListener('abort', abort, { once: true });
          });
          try {
            await Promise.race([throttler.waitForIdentify(shardId, combined), stopped]);
            combined.throwIfAborted();
            options.assertOwned();
          } finally {
            combined.removeEventListener('abort', abort);
          }
        },
      };
    });
    return pending;
  };
}

/** One official SDK manager and one identify throttler cover every shard of an owned bot. */
export function createDiscordGatewayDriver(
  options: DiscordGatewayDriverOptions,
  transport: typeof fetch = fetch,
  rates: DiscordRateCoordinator = new DiscordRateCoordinator(),
): DiscordGatewayDriver {
  const rest = new REST({
    version: '10',
    retries: 0,
    rejectOnRateLimit: () => true,
    timeout: options.policy.handshakeTimeoutMs,
    makeRequest: async (url, init) => {
      options.assertOwned();
      if (init.method !== 'GET' || init.body != null)
        throw new Error('Unsupported Discord Gateway REST operation');
      const signal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(options.policy.handshakeTimeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]);
      const permit = await rates.acquire(
        { route: 'GET /gateway/bot', major: 'application' },
        signal,
      );
      try {
        options.assertOwned();
        const response = await transport(url, {
          method: 'GET',
          headers: requestHeaders(init.headers),
          redirect: 'error',
          signal,
        });
        permit.observe(response);
        if (response.status === 401) throw new DiscordGatewayFailure('credentials');
        const bytes = await boundedBody(response, options.maxResponseBytes);
        if (response.status === 429) {
          try {
            permit.observe(response, JSON.parse(bytes.toString()));
          } catch {
            /* Header limits remain authoritative for a malformed response. */
          }
        }
        const bounded = new Response(Uint8Array.from(bytes), {
          status: response.status,
          headers: response.headers,
        });
        return {
          body: null,
          headers: bounded.headers,
          ok: bounded.ok,
          status: bounded.status,
          statusText: bounded.statusText,
          get bodyUsed() {
            return bounded.bodyUsed;
          },
          arrayBuffer: () => bounded.arrayBuffer(),
          json: () => bounded.json(),
          text: () => bounded.text(),
        };
      } finally {
        permit.release();
      }
    },
  }).setToken(options.token);
  const manager = new WebSocketManager({
    rest,
    token: options.token,
    intents:
      GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.DirectMessages |
      (options.policy.messageContent ? GatewayIntentBits.MessageContent : 0),
    shardCount: options.policy.shardCount,
    shardIds: Array.from({ length: options.policy.shardCount }, (_, id) => id),
    handshakeTimeout: options.policy.handshakeTimeoutMs,
    helloTimeout: options.policy.handshakeTimeoutMs,
    readyTimeout: options.policy.readyTimeoutMs,
    retrieveSessionInfo: options.retrieveSessionInfo,
    updateSessionInfo: options.updateSessionInfo,
    buildIdentifyThrottler: createOwnedIdentifyThrottler(options),
  });
  manager.on(WebSocketShardEvents.Dispatch, options.dispatch);
  manager.on(WebSocketShardEvents.Ready, options.ready);
  manager.on(WebSocketShardEvents.Resumed, ({ shardId }) => options.resumed(shardId));
  manager.on(WebSocketShardEvents.Closed, ({ code, shardId }) => options.closed(code, shardId));
  manager.on(WebSocketShardEvents.Error, options.error);
  manager.on(WebSocketShardEvents.HeartbeatComplete, ({ shardId, latency }) =>
    options.heartbeat?.(shardId, latency),
  );
  return {
    connect: () => manager.connect(),
    destroy: async () => {
      await manager.destroy();
    },
  };
}
