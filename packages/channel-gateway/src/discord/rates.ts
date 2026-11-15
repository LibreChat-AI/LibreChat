import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordChannelConfig } from 'librechat-data-provider';

export type DiscordRatePolicy = DiscordChannelConfig['rateLimits'];
export const DEFAULT_DISCORD_RATE_POLICY: Readonly<DiscordRatePolicy> =
  discordChannelConfigSchema.parse({}).rateLimits;

/** Route excludes individual message IDs; major identifies a channel, guild or webhook. */
export interface DiscordRateRoute {
  route: string;
  major: string;
}
export interface DiscordRatePermit {
  observe(response: Pick<Response, 'status' | 'headers'>, body?: unknown): void;
  release(): void;
}

export class DiscordRateQueueError extends Error {
  constructor(
    readonly code: 'aborted' | 'queue_full' | 'queue_timeout' | 'capacity',
    readonly retryAfterMs: number,
  ) {
    super('Discord request was not started');
  }
}

interface RouteState extends DiscordRateRoute {
  bucket?: string;
  remaining?: number;
  resetAt: number;
  blockedUntil: number;
  active: number;
  lastUsed: number;
}
interface WaitingRequest {
  state: RouteState;
  expiresAt: number;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (permit: DiscordRatePermit) => void;
  reject: (error: DiscordRateQueueError) => void;
}

const seconds = (raw: string | null): number | undefined => {
  if (raw == null || !raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000)
    return undefined;
  return Math.ceil(value * 1000);
};

/** One coordinator belongs to one bot credential and must be shared by its REST clients. */
export class DiscordRateCoordinator {
  private readonly policy: Readonly<DiscordRatePolicy>;
  private readonly routes = new Map<string, RouteState>();
  private readonly queue: WaitingRequest[] = [];
  private readonly starts: number[] = [];
  private globalUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(policy: DiscordRatePolicy = DEFAULT_DISCORD_RATE_POLICY) {
    if (
      [
        policy.globalRequestsPerSecond,
        policy.maxQueued,
        policy.maxQueueWaitMs,
        policy.maxTrackedRoutes,
        policy.idleTtlMs,
        policy.fallbackRetryMs,
      ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      policy.maxQueueWaitMs > 2_147_483_647
    )
      throw new TypeError('Invalid Discord rate policy');
    this.policy = { ...policy };
  }

  retryAfter(response: Pick<Response, 'headers'>, body?: unknown): number {
    const header = seconds(response.headers.get('retry-after')) ?? 0;
    const raw = body && typeof body === 'object' && 'retry_after' in body ? body.retry_after : 0;
    let delay = 0;
    if (
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw > 0 &&
      raw <= Number.MAX_SAFE_INTEGER / 1000
    )
      delay = Math.ceil(raw * 1000);
    return Math.max(header, delay) || this.policy.fallbackRetryMs;
  }

  acquire(route: DiscordRateRoute, signal?: AbortSignal): Promise<DiscordRatePermit> {
    if (signal?.aborted) return Promise.reject(this.failure('aborted'));
    if (this.queue.length >= this.policy.maxQueued)
      return Promise.reject(this.failure('queue_full'));
    if (!route.route || route.route.length > 256 || !route.major || route.major.length > 128)
      return Promise.reject(new TypeError('Invalid Discord rate route'));
    const now = Date.now();
    this.prune(now);
    const key = JSON.stringify([route.route, route.major]);
    let state = this.routes.get(key);
    if (!state) {
      if (this.routes.size >= this.policy.maxTrackedRoutes)
        return Promise.reject(this.failure('capacity'));
      const bucket = [...this.routes.values()].find(
        (entry) => entry.route === route.route && entry.bucket,
      )?.bucket;
      state = { ...route, bucket, active: 0, blockedUntil: 0, resetAt: 0, lastUsed: now };
      this.routes.set(key, state);
    }
    state.lastUsed = now;
    const target = state;
    return new Promise((resolve, reject) => {
      const request: WaitingRequest = {
        state: target,
        expiresAt: now + this.policy.maxQueueWaitMs,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(request);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.detach(request);
          reject(this.failure('aborted'));
          this.drain();
        },
      };
      this.queue.push(request);
      signal?.addEventListener('abort', request.abort, { once: true });
      this.drain();
    });
  }

  private failure(code: DiscordRateQueueError['code']): DiscordRateQueueError {
    return new DiscordRateQueueError(code, this.policy.fallbackRetryMs);
  }

  private group(state: RouteState): RouteState[] {
    return [...this.routes.values()].filter(
      (entry) =>
        entry === state ||
        (state.bucket !== undefined &&
          entry.bucket === state.bucket &&
          entry.major === state.major),
    );
  }

  private prune(now: number): void {
    const waiting = new Set(this.queue.map((request) => request.state));
    for (const [key, state] of this.routes) {
      if (
        !state.active &&
        !waiting.has(state) &&
        state.resetAt <= now &&
        state.blockedUntil <= now &&
        state.lastUsed + this.policy.idleTtlMs <= now
      )
        this.routes.delete(key);
    }
  }

  private detach(request: WaitingRequest): void {
    request.signal?.removeEventListener('abort', request.abort);
  }

  /** Wake only for a reset/deadline or a state change, never on a polling interval. */
  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    while (this.starts.length && this.starts[0] + 1000 <= now) this.starts.shift();
    let wakeAt = Infinity;
    for (let index = 0; index < this.queue.length; ) {
      const request = this.queue[index];
      if (request.signal?.aborted || request.expiresAt <= now) {
        this.queue.splice(index, 1);
        this.detach(request);
        request.reject(this.failure(request.signal?.aborted ? 'aborted' : 'queue_timeout'));
        continue;
      }
      wakeAt = Math.min(wakeAt, request.expiresAt);
      const group = this.group(request.state);
      let readyAt = this.globalUntil;
      if (this.starts.length >= this.policy.globalRequestsPerSecond)
        readyAt = Math.max(readyAt, this.starts[0] + 1000);
      for (const state of group) {
        readyAt = Math.max(readyAt, state.blockedUntil);
        if (state.remaining === 0 && state.resetAt > now)
          readyAt = Math.max(readyAt, state.resetAt);
      }
      if (group.some((state) => state.active > 0)) {
        index++;
        continue;
      }
      if (readyAt > now) {
        wakeAt = Math.min(wakeAt, readyAt);
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      this.detach(request);
      for (const state of group) {
        if (state.remaining !== undefined && state.resetAt > now)
          state.remaining = Math.max(0, state.remaining - 1);
      }
      request.state.active++;
      request.state.lastUsed = now;
      this.starts.push(now);
      request.resolve(this.permit(request.state));
    }
    if (this.queue.length && Number.isFinite(wakeAt))
      this.timer = setTimeout(() => this.drain(), Math.max(1, wakeAt - now));
  }

  private permit(state: RouteState): DiscordRatePermit {
    let released = false;
    let observedAt: number | undefined;
    return {
      observe: (response, body) => {
        if (released) return;
        observedAt ??= Date.now();
        const bucket = response.headers.get('x-ratelimit-bucket');
        if (bucket && bucket.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(bucket))
          state.bucket = bucket;
        const raw = response.headers.get('x-ratelimit-remaining');
        if (raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
          state.remaining = Number(raw);
          const resetAfter = seconds(response.headers.get('x-ratelimit-reset-after'));
          state.resetAt = observedAt + (resetAfter ?? this.policy.fallbackRetryMs);
        }
        if (response.status === 429) {
          const until = observedAt + this.retryAfter(response, body);
          state.blockedUntil = Math.max(state.blockedUntil, until);
          const global =
            response.headers.get('x-ratelimit-global') === 'true' ||
            response.headers.get('x-ratelimit-scope') === 'global' ||
            (body !== null && typeof body === 'object' && 'global' in body && body.global === true);
          if (global) this.globalUntil = Math.max(this.globalUntil, until);
        }
        this.drain();
      },
      release: () => {
        if (released) return;
        released = true;
        state.active--;
        state.lastUsed = Date.now();
        this.drain();
      },
    };
  }
}
