import {
  PULL_REQUEST_BATCH_MAX,
  PULL_REQUEST_BATCH_TIMEOUT_MAX_SECONDS,
} from 'librechat-data-provider';
import type {
  TConversationPullRequestResponse,
  TConversationPullRequestsResponse,
} from 'librechat-data-provider';

/** A failed entry keeps its stable server code, so a caller can tell a rate limit from an outage. */
export class PullRequestBatchError extends Error {
  constructor(public readonly code: string) {
    super(`Pull request lookup failed: ${code}`);
    this.name = 'PullRequestBatchError';
  }
}

type Waiter = {
  resolve: (value: TConversationPullRequestResponse) => void;
  reject: (reason: unknown) => void;
};

type BatcherOptions = {
  /**
   * `signal` aborts when the request has run out of time or the batcher was disposed. A fetcher
   * that starts work of its own must stop it on abort: the queue moves on the moment the request
   * is settled, so work left running would overlap the next request.
   */
  fetchMany: (
    conversationIds: string[],
    signal: AbortSignal,
  ) => Promise<TConversationPullRequestsResponse>;
  /** How long to gather more ids before asking, so rows mounted together share one request. */
  delayMs?: number;
  /** Ids per request; the server refuses more than its own bound. */
  maxBatch?: number;
  /**
   * Longest a request may hold the queue. Requests go out one at a time, so one that never
   * answers would otherwise stop every later one. It defaults to just past the longest deadline a
   * deployment may configure for the server's own batch, so the server always answers first and
   * the next request never starts while the previous one's lookups are still running.
   */
  requestTimeoutMs?: number;
};

const DEFAULT_DELAY_MS = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = (PULL_REQUEST_BATCH_TIMEOUT_MAX_SECONDS + 10) * 1000;

/**
 * Collects the conversation ids asked for within a short window and fetches them in one request.
 * Each caller gets its own conversation's answer, and callers asking for the same conversation
 * share one entry. A request that fails rejects only the callers it carried.
 */
export function createPullRequestBatcher({
  fetchMany,
  delayMs = DEFAULT_DELAY_MS,
  maxBatch = PULL_REQUEST_BATCH_MAX,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: BatcherOptions) {
  const pending = new Map<string, Waiter[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  /**
   * Requests go out one at a time. Each request lets the server run its own number of lookups at
   * once, so requests in flight together would multiply the limit the operator configured: a long
   * pinned list, or a second flush while one is still out, would otherwise put several times that
   * many lookups on GitHub at once. The tail never rejects, so one failed request cannot stall
   * the ones queued behind it.
   */
  let tail: Promise<void> = Promise.resolve();
  /** Aborts whatever request is on the wire, so disposal does not leave its work running. */
  let active: AbortController | undefined;

  const send = (ids: string[], waiters: Map<string, Waiter[]>): Promise<void> => {
    /** Work that was still waiting its turn when the batcher was disposed never goes out. */
    if (disposed) {
      for (const list of waiters.values()) {
        list.forEach((waiter) => waiter.reject(new PullRequestBatchError('DISPOSED')));
      }
      return Promise.resolve();
    }
    const settle = ({ results }: TConversationPullRequestsResponse) => {
      const byId = new Map(results.map((entry) => [entry.conversationId, entry]));
      for (const [id, list] of waiters) {
        const entry = byId.get(id);
        for (const waiter of list) {
          if (entry != null && 'error' in entry) {
            waiter.reject(new PullRequestBatchError(entry.error.code));
          } else {
            waiter.resolve({ pullRequest: entry?.pullRequest ?? null });
          }
        }
      }
    };
    const fail = (error: unknown) => {
      for (const list of waiters.values()) list.forEach((waiter) => waiter.reject(error));
    };
    const controller = new AbortController();
    active = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Settles the request on its timeout, and on an abort from disposal, so callers never wait on
     * a fetcher that ignores its signal. The timeout aborts first, so the code it reports stays
     * `TIMEOUT` and the abort listener only ever fires for disposal.
     */
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new PullRequestBatchError('TIMEOUT'));
        controller.abort();
      }, requestTimeoutMs);
      controller.signal.addEventListener('abort', () =>
        reject(new PullRequestBatchError('ABORTED')),
      );
    });
    /**
     * `settle` is inside the guarded chain: a response that is not the shape it should be would
     * otherwise throw out of it, leave these callers waiting forever and, because the queue chains
     * on this promise, stop every later request. Anything that goes wrong here fails the callers
     * this request carried and nothing else.
     */
    return Promise.race([fetchMany(ids, controller.signal), timedOut])
      .then(settle)
      .catch(fail)
      .finally(() => {
        clearTimeout(timer);
        if (active === controller) active = undefined;
      });
  };

  const flush = () => {
    timer = undefined;
    const ids = [...pending.keys()];
    for (let start = 0; start < ids.length; start += maxBatch) {
      const chunk = ids.slice(start, start + maxBatch);
      const waiters = new Map<string, Waiter[]>();
      for (const id of chunk) {
        waiters.set(id, pending.get(id) ?? []);
        pending.delete(id);
      }
      tail = tail.then(() => send(chunk, waiters));
    }
  };

  return {
    /**
     * Ends this batcher's life, for the identity it was made for. What has not gone out yet is
     * rejected instead of being sent under whoever is signed in next, and nothing queued behind a
     * request still in flight waits on it for the next session. A request already on the wire
     * finishes on its own.
     */
    dispose(): void {
      disposed = true;
      active?.abort();
      clearTimeout(timer);
      timer = undefined;
      for (const list of pending.values()) {
        list.forEach((waiter) => waiter.reject(new PullRequestBatchError('DISPOSED')));
      }
      pending.clear();
    },
    load(conversationId: string): Promise<TConversationPullRequestResponse> {
      if (disposed) return Promise.reject(new PullRequestBatchError('DISPOSED'));
      return new Promise((resolve, reject) => {
        const waiters = pending.get(conversationId) ?? [];
        waiters.push({ resolve, reject });
        pending.set(conversationId, waiters);
        timer ??= setTimeout(flush, delayMs);
      });
    },
  };
}

const FALLBACK_CONCURRENCY = 4;

const statusOf = (error: unknown): number | undefined => {
  if (error == null || typeof error !== 'object') return undefined;
  const candidate = error as { status?: number; response?: { status?: number } };
  return candidate.response?.status ?? candidate.status;
};

const codeOf = (error: unknown): string => {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' ? code : 'UPSTREAM_ERROR';
};

/**
 * Asks the batch route, and when the server that answered does not have it (a replica that has
 * not been upgraded yet answers 404, whatever the startup config of another replica advertised),
 * asks the single route for each conversation instead, a few at a time. Anything but a 404 is a
 * real failure and is passed on untouched.
 */
export function createBatchFetcher({
  fetchMany,
  fetchOne,
}: {
  fetchMany: (
    conversationIds: string[],
    signal: AbortSignal,
  ) => Promise<TConversationPullRequestsResponse>;
  fetchOne: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<TConversationPullRequestResponse>;
}) {
  return async (
    conversationIds: string[],
    signal: AbortSignal,
  ): Promise<TConversationPullRequestsResponse> => {
    try {
      return await fetchMany(conversationIds, signal);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    const results: TConversationPullRequestsResponse['results'] = new Array(conversationIds.length);
    let next = 0;
    /**
     * The fallback is many requests, and the batcher moves on the moment this one is settled, so
     * it stops itself: once the signal aborts no worker starts another call, and the call each
     * has in flight is aborted with it, so nothing carries on beside the next request.
     */
    const worker = async (): Promise<void> => {
      for (let index = next++; index < conversationIds.length; index = next++) {
        if (signal.aborted) return;
        const conversationId = conversationIds[index];
        try {
          const { pullRequest } = await fetchOne(conversationId, signal);
          results[index] = { conversationId, pullRequest };
        } catch (error) {
          /** After an abort the whole fetch throws below, so a result written here is never read. */
          results[index] = { conversationId, error: { code: codeOf(error) } };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FALLBACK_CONCURRENCY, conversationIds.length) }, worker),
    );
    if (signal.aborted) throw new PullRequestBatchError('ABORTED');
    return { results };
  };
}
