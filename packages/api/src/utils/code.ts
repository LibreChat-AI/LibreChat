import http from 'http';
import https from 'https';
import { isAxiosError } from 'axios';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerRequest } from '~/types';

/**
 * Dedicated agents for code-server requests, preventing socket pool contamination.
 * follow-redirects (used by axios) leaks `socket.destroy` as a timeout listener;
 * on Node 19+ (keepAlive: true by default), tainted sockets re-enter the global pool
 * and kill unrelated requests (e.g., node-fetch in CodeExecutor) after the idle timeout.
 */
export const codeServerHttpAgent: http.Agent = new http.Agent({ keepAlive: false });
export const codeServerHttpsAgent: https.Agent = new https.Agent({ keepAlive: false });

/**
 * Wait implied by a Code API 429, in milliseconds, or `null` when the error
 * is not a rate-limit response. The service answers with both the standard
 * `Retry-After` header and a `retry_after_seconds` body field; the header is
 * preferred so a body the caller asked for as a stream/buffer never has to be
 * parsed, and the body is the fallback for proxies that drop the header.
 */
export function getCodeApiRetryAfterMs(error: unknown): number | null {
  if (!isAxiosError(error) || error.response?.status !== 429) {
    return null;
  }
  const header = error.response.headers?.['retry-after'];
  const raw = Array.isArray(header) ? header[0] : header;
  /* `Number('')` is 0, which would read as "retry immediately" and skip the
   * body fallback; treat a blank header as absent. */
  const headerSeconds = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return headerSeconds * 1000;
  }
  const body = error.response.data;
  if (typeof body === 'object' && body !== null && 'retry_after_seconds' in body) {
    const bodySeconds = Number(body.retry_after_seconds);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return bodySeconds * 1000;
    }
  }
  return null;
}

/** Total time one operation may spend waiting out Code API rate limits.
 *  Keeps recovery bounded inside a live chat turn. */
export const MAX_CODE_API_RATE_LIMIT_WAIT_MS = 20_000;
export const CODE_API_UPLOAD_CONCURRENCY_DEFAULT = 3;

export interface CodeApiUploadRegistry {
  scopes: Map<string, UploadScopeState>;
}

export function createCodeApiUploadRegistry(): CodeApiUploadRegistry {
  return { scopes: new Map() };
}

export function createCodeApiUploadScope(params: {
  route: string;
  principalId: string;
  tenantId?: string;
}): string {
  return JSON.stringify([params.route, params.tenantId ?? 'legacy', params.principalId]);
}

export function getCodeApiUploadOptions(
  req: ServerRequest,
  route: string,
): { scope: string; concurrency: number; retryWaitMs: number } {
  const user = req.user as typeof req.user & {
    _id?: { toString(): string } | string;
    tenantId?: unknown;
    orgId?: unknown;
  };
  const principalId = user?.id ?? user?._id?.toString();
  if (!principalId) {
    throw new Error('Code API upload recovery requires an authenticated principal');
  }
  return {
    scope: createCodeApiUploadScope({
      route,
      principalId,
      tenantId:
        user.tenantId == null && user.orgId == null
          ? undefined
          : String(user.tenantId ?? user.orgId),
    }),
    concurrency:
      req.config?.endpoints?.agents?.codeApiUploadConcurrency ??
      CODE_API_UPLOAD_CONCURRENCY_DEFAULT,
    retryWaitMs:
      req.config?.endpoints?.agents?.codeApiMaxRetryWaitMs ?? MAX_CODE_API_RATE_LIMIT_WAIT_MS,
  };
}

interface QueuedUpload {
  run: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface UploadScopeState {
  active: number;
  concurrency: number;
  queue: QueuedUpload[];
}

interface CodeApiRateLimitWaitToken {
  endAt: number;
}

function abortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new Error('The operation was aborted');
}

function drainCodeApiUploadScope(
  registry: CodeApiUploadRegistry,
  scope: string,
  state: UploadScopeState,
): void {
  while (state.active < state.concurrency && state.queue.length > 0) {
    const queued = state.queue.shift();
    if (!queued) {
      break;
    }
    queued.signal?.removeEventListener('abort', queued.onAbort!);
    if (queued.signal?.aborted) {
      queued.reject(abortReason(queued.signal));
      continue;
    }
    queued.run();
  }
  if (state.active === 0 && state.queue.length === 0) {
    registry.scopes.delete(scope);
  }
}

/** Limits uploads within one Code API route and principal. A throttled bucket
 * holds only its own slots, and canceled callers leave the queue immediately. */
export function withCodeApiUploadSlot<T>(params: {
  registry: CodeApiUploadRegistry;
  task: () => Promise<T>;
  scope: string;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const {
    registry,
    task,
    scope,
    concurrency = CODE_API_UPLOAD_CONCURRENCY_DEFAULT,
    signal,
  } = params;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Code API upload concurrency must be a positive integer (got ${concurrency})`);
  }
  signal?.throwIfAborted();
  let state = registry.scopes.get(scope);
  if (!state) {
    state = { active: 0, concurrency, queue: [] };
    registry.scopes.set(scope, state);
  } else {
    state.concurrency = concurrency;
  }

  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      state.active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.active--;
          drainCodeApiUploadScope(registry, scope, state);
        });
    };
    if (state.active < state.concurrency) {
      run();
      return;
    }
    const queued: QueuedUpload = { run, reject, signal };
    queued.onAbort = () => {
      const index = state.queue.indexOf(queued);
      if (index >= 0) {
        state.queue.splice(index, 1);
        reject(abortReason(signal!));
        drainCodeApiUploadScope(registry, scope, state);
      }
    };
    signal?.addEventListener('abort', queued.onAbort, { once: true });
    state.queue.push(queued);
  });
}

/** Actual rate-limit wait time shared by every request of one operation. */
export interface CodeApiRateLimitBudget {
  limitMs: number;
  waitedMs: number;
  waitingSince?: number;
  activeWaitEnds: Set<CodeApiRateLimitWaitToken>;
}

export function createCodeApiRateLimitBudget(
  totalMs: number = MAX_CODE_API_RATE_LIMIT_WAIT_MS,
): CodeApiRateLimitBudget {
  return { limitMs: totalMs, waitedMs: 0, activeWaitEnds: new Set() };
}

function beginCodeApiRateLimitWait(
  budget: CodeApiRateLimitBudget,
  waitMs: number,
): CodeApiRateLimitWaitToken | null {
  const now = Date.now();
  const activeElapsed = budget.waitingSince == null ? 0 : now - budget.waitingSince;
  const currentWaitEnd = Math.max(
    now,
    ...Array.from(budget.activeWaitEnds, (token) => token.endAt),
  );
  const projectedWaitedMs =
    budget.waitedMs + activeElapsed + Math.max(currentWaitEnd, now + waitMs) - now;
  if (projectedWaitedMs > budget.limitMs) {
    return null;
  }
  const token = { endAt: now + waitMs };
  if (budget.activeWaitEnds.size === 0) {
    budget.waitingSince = now;
  }
  budget.activeWaitEnds.add(token);
  return token;
}

function finishCodeApiRateLimitWait(
  budget: CodeApiRateLimitBudget,
  token: CodeApiRateLimitWaitToken,
): void {
  if (!budget.activeWaitEnds.delete(token)) {
    return;
  }
  if (budget.activeWaitEnds.size === 0 && budget.waitingSince != null) {
    budget.waitedMs += Date.now() - budget.waitingSince;
    budget.waitingSince = undefined;
  }
}

function codeApiRateLimitError(label: string, cause: unknown, retryAfterMs?: number): Error {
  const retrySuffix = retryAfterMs == null ? '' : ` (retry in ${Math.ceil(retryAfterMs / 1000)}s)`;
  return Object.assign(
    new Error(`Code API rate limit reached while ${label}${retrySuffix}.`, { cause }),
    {
      name: 'CodeApiRateLimitError',
      code: 'CODE_API_RATE_LIMITED',
      status: 429,
      statusCode: 429,
      ...(retryAfterMs == null ? {} : { retryAfterMs }),
    },
  );
}

/**
 * Runs a Code API request, waiting out a rate limit whenever the shared
 * budget still covers the server's `Retry-After`. Multi-request operations
 * (a windowed image read, a batch upload) would otherwise abandon the work
 * already done the moment a limiter window closes mid-flight. A 429 the
 * budget cannot absorb throws a named error rather than a bare
 * "status code 429", which reads as an unspecified failure instead of one
 * that clears on its own.
 */
export async function withCodeApiRateLimit<T>(params: {
  attempt: () => Promise<T>;
  label: string;
  budget?: CodeApiRateLimitBudget;
  onWait?: (waitMs: number) => void;
  signal?: AbortSignal;
  /** Narrows retry classification when an attempt also performs non-CodeAPI work. */
  isRateLimit?: (error: unknown) => boolean;
}): Promise<T> {
  const {
    attempt,
    label,
    budget,
    onWait,
    signal,
    isRateLimit = (error) => isAxiosError(error) && error.response?.status === 429,
  } = params;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (!isRateLimit(error)) {
        throw error;
      }
      const retryAfterMs = getCodeApiRetryAfterMs(error);
      if (retryAfterMs == null) {
        throw codeApiRateLimitError(label, error);
      }
      /* A zero delay would spin. Wait at least a second; the actual-wait
       * budget still guarantees that repeated zero hints terminate. */
      const waitMs = Math.max(retryAfterMs, 1000);
      if (budget == null) {
        throw codeApiRateLimitError(label, error, waitMs);
      }
      const rateLimitBudget = budget;
      const waitToken = beginCodeApiRateLimitWait(rateLimitBudget, waitMs);
      if (waitToken == null) {
        throw codeApiRateLimitError(label, error, waitMs);
      }
      onWait?.(waitMs);
      try {
        await delay(waitMs, undefined, signal ? { signal } : undefined);
      } finally {
        finishCodeApiRateLimitWait(rateLimitBudget, waitToken);
      }
    }
  }
}

/** Owns upload admission, retry waiting, and source reopening for every Code API
 * upload producer. Callers supply storage and transport adapters only. */
export function withCodeApiUploadRecovery<S, T>(params: {
  registry: CodeApiUploadRegistry;
  scope: string;
  concurrency?: number;
  budget?: CodeApiRateLimitBudget;
  signal?: AbortSignal;
  label: string;
  onWait?: (waitMs: number) => void;
  openSource: () => Promise<S>;
  upload: (source: S) => Promise<T>;
}): Promise<T> {
  const { registry, scope, concurrency, budget, signal, label, onWait, openSource, upload } =
    params;
  return withCodeApiUploadSlot({
    registry,
    scope,
    concurrency,
    signal,
    task: () => {
      let uploadStarted = false;
      return withCodeApiRateLimit({
        budget,
        signal,
        label,
        onWait,
        /* Storage backends can also answer 429. Only the CodeAPI transport owns this
         * retry policy and its operator-facing error identity. */
        isRateLimit: (error) =>
          uploadStarted && isAxiosError(error) && error.response?.status === 429,
        attempt: async () => {
          uploadStarted = false;
          let source: S | undefined;
          try {
            source = await openSource();
            signal?.throwIfAborted();
            uploadStarted = true;
            return await upload(source);
          } catch (error) {
            if (source !== undefined) {
              disposeCodeApiUploadSource(source);
            }
            throw error;
          }
        },
      });
    },
  });
}

/** Best-effort disposal for the stream shapes accepted by upload adapters: a
 * single readable or a batch of `{ stream }` entries. */
function disposeCodeApiUploadSource(source: unknown): void {
  try {
    if (Array.isArray(source)) {
      source.forEach(disposeCodeApiUploadSource);
      return;
    }
    if (source == null || typeof source !== 'object') {
      return;
    }
    if ('stream' in source) {
      disposeCodeApiUploadSource((source as { stream?: unknown }).stream);
      return;
    }
    const destroy = (source as { destroy?: unknown }).destroy;
    if (typeof destroy === 'function') {
      destroy.call(source);
    }
  } catch {
    /* Cleanup must not replace the upload or cancellation error being propagated. */
  }
}

export function isCodeApiRateLimitError(error: unknown): error is Error & {
  code: 'CODE_API_RATE_LIMITED';
  status: 429;
} {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'CODE_API_RATE_LIMITED' &&
    (error as { status?: unknown }).status === 429
  );
}
