import { REST } from '@discordjs/rest';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { WebSocketManager, WebSocketShardEvents, SimpleIdentifyThrottler } from '@discordjs/ws';
import type { SessionInfo, ManagerShardEventsMap, IIdentifyThrottler } from '@discordjs/ws';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { RESTOptions } from '@discordjs/rest';
import type { DiscordIdentifyBudget } from './budget';
import {
  assertDiscordGatewayInformation,
  createDiscordIdentifyBudget,
  readDiscordGatewayInformation,
} from './budget';
import { DiscordGatewayFailure, DiscordIdentifyRefusal } from './recovery';
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
  /** An IDENTIFY was refused (see `DiscordIdentifyRefusal`). The owner must stop the session. */
  identifyRefused?(error: unknown): void;
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

/**
 * The promise itself is shared, including concurrent first identifies on separate shards. Every
 * IDENTIFY is reserved against the session budget before the SDK throttle spaces it. A refused one
 * is never sent: the SDK sends an IDENTIFY anyway once it has recovered from a throttle that
 * threw, so a refusal tells the owner and then parks the shard instead.
 */
export function createOwnedIdentifyThrottler(
  options: Pick<DiscordGatewayDriverOptions, 'assertOwned' | 'signal' | 'identifyRefused'>,
  budget: DiscordIdentifyBudget = createDiscordIdentifyBudget(),
  throttle: (maxConcurrency: number) => IIdentifyThrottler = (maxConcurrency) =>
    new SimpleIdentifyThrottler(maxConcurrency),
) {
  const parked = new Promise<never>(() => undefined);
  const refuse = (error: unknown) => {
    try {
      options.identifyRefused?.(error);
    } catch {
      // The owner stops the session itself, and a refusal cannot be allowed to throw into the SDK.
    }
  };
  const refusing = (error: unknown): IIdentifyThrottler => ({
    async waitForIdentify() {
      options.assertOwned();
      refuse(error);
      return parked;
    },
  });
  const spaced = (
    manager: Pick<WebSocketManager, 'fetchGatewayInformation'>,
    maxConcurrency: number,
  ): IIdentifyThrottler => {
    const throttler = throttle(maxConcurrency);
    return {
      async waitForIdentify(shardId: number, signal: AbortSignal) {
        options.assertOwned();
        try {
          await budget.reserve(manager, shardId);
        } catch (error) {
          refuse(error);
          return parked;
        }
        const combined = AbortSignal.any([signal, options.signal]);
        let abort = () => {};
        const stopped = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DOMException('Discord identify cancelled', 'AbortError'));
          combined.addEventListener('abort', abort, { once: true });
        });
        try {
          combined.throwIfAborted();
          await Promise.race([throttler.waitForIdentify(shardId, combined), stopped]);
          combined.throwIfAborted();
          options.assertOwned();
        } catch (error) {
          budget.release(shardId);
          throw error;
        } finally {
          combined.removeEventListener('abort', abort);
        }
      },
    };
  };
  let pending: Promise<IIdentifyThrottler> | undefined;
  return (
    manager: Pick<WebSocketManager, 'fetchGatewayInformation'>,
  ): Promise<IIdentifyThrottler> => {
    pending ??= manager.fetchGatewayInformation().then(
      (info) => {
        try {
          return spaced(
            manager,
            readDiscordGatewayInformation(info).session_start_limit.max_concurrency,
          );
        } catch (error) {
          return refusing(error);
        }
      },
      (error: unknown) => refusing(error),
    );
    return pending;
  };
}

/** One official SDK manager and one identify throttler cover every shard of an owned bot. */
export function createDiscordGatewayDriver(
  options: DiscordGatewayDriverOptions,
  transport: typeof fetch = fetch,
  rates: DiscordRateCoordinator = new DiscordRateCoordinator(),
  budget: DiscordIdentifyBudget = createDiscordIdentifyBudget(),
): DiscordGatewayDriver {
  // The SDK runs reconnects and heartbeats on timers no caller awaits, so a hook that throws there
  // is an unhandled rejection that ends the process. Losing ownership freezes the SDK instead:
  // it opens no further socket and sends no further IDENTIFY, and the session stops itself.
  const parked = new Promise<never>(() => undefined);
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
        if (response.ok && new URL(url).pathname.endsWith('/gateway/bot'))
          assertDiscordGatewayInformation(bytes);
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
    retrieveSessionInfo: (shardId) => {
      try {
        return options.retrieveSessionInfo(shardId);
      } catch {
        return parked;
      }
    },
    updateSessionInfo: async (shardId, info) => {
      try {
        await options.updateSessionInfo(shardId, info);
      } catch {
        // Every failing path has already stopped the session, and a stopped session records nothing.
      }
    },
    buildIdentifyThrottler: createOwnedIdentifyThrottler(options, budget),
  });
  manager.on(WebSocketShardEvents.Dispatch, options.dispatch);
  manager.on(WebSocketShardEvents.Ready, (event) => {
    budget.reached(event.shardId);
    options.ready(event);
  });
  manager.on(WebSocketShardEvents.Resumed, ({ shardId }) => {
    budget.reached(shardId);
    options.resumed(shardId);
  });
  manager.on(WebSocketShardEvents.Closed, ({ code, shardId }) => options.closed(code, shardId));
  manager.on(WebSocketShardEvents.Error, options.error);
  manager.on(WebSocketShardEvents.HeartbeatComplete, ({ shardId, latency }) =>
    options.heartbeat?.(shardId, latency),
  );
  return {
    // The SDK makes the same comparison inside `connect`, but throws an untyped error, and the owner
    // must tell a spent budget from an ordinary failure. Nothing is opened while the budget is spent.
    connect: async () => {
      const { session_start_limit: limit } = readDiscordGatewayInformation(
        await manager.fetchGatewayInformation(),
      );
      if (limit.remaining < options.policy.shardCount)
        throw new DiscordIdentifyRefusal('exhausted');
      await manager.connect();
    },
    // Closing a shard that is waiting for READY can start a second close on the same socket inside
    // the SDK, and the first never settles. The wait is bounded so shutdown cannot hang on it.
    destroy: async () => {
      const destroying = Promise.resolve(manager.destroy());
      void destroying.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Discord Gateway destroy timed out')),
          options.policy.handshakeTimeoutMs,
        );
      });
      try {
        await Promise.race([destroying, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
