import { QueryObserver } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  DEFAULT_HISTORY_CACHE_RECENT,
  DEFAULT_HISTORY_CACHE_TTL_MS,
  DEFAULT_HISTORY_CACHE_MAX_BYTES,
} from 'librechat-data-provider';
import type { Query, QueryClient } from '@tanstack/react-query';

/** Gives a route change time to mount the next view before anything unobserved is judged. */
export const RELEASE_SETTLE_MS = 1_000;
/** How soon a history kept only because it is pinned or fetching is judged again. */
export const PIN_RECHECK_MS = 5_000;

export type MessagesRetentionOptions = {
  /** Conversations whose history must stay regardless of age, such as the routed conversation
   *  or one whose job is still running. Read at release time, so it sees live state. */
  isPinned: (conversationId: string) => boolean;
  /** Conversations whose history is never released, for a reason that does not lapse on its
   *  own (such as an Assistants thread id that deletion reads from the cache). Unlike pins,
   *  these are not polled. */
  isExempt?: (conversationId: string) => boolean;
  /** How many of the most recently left conversations keep their history for `ttlMs`. */
  recent?: number;
  /** How long a left conversation's history stays cached. */
  ttlMs?: number;
  /** Aggregate estimated payload budget for histories kept during the grace period. */
  maxBytes?: number;
};

type IdleHistory = {
  query: Query;
  conversationId: string;
  leftAt: number;
};

const isPlaceholderId = (conversationId: string): boolean =>
  conversationId === Constants.NEW_CONVO ||
  conversationId === Constants.PENDING_CONVO ||
  conversationId === Constants.SEARCH;

/** Only per-conversation histories qualify; list and search queries share the root with
 *  object keys and keep their own cache times. */
function historyConversationId(query: Query): string | null {
  const [root, conversationId] = query.queryKey;
  if (
    query.queryKey.length !== 2 ||
    root !== QueryKeys.messages ||
    typeof conversationId !== 'string' ||
    isPlaceholderId(conversationId)
  ) {
    return null;
  }
  return conversationId;
}

/** React Query only reschedules a query's collection when its observers change or a fetch
 *  settles, so a history already counting down keeps its old timer. A momentary observer
 *  re-arms it under the new `cacheTime`, which for `Infinity` cancels it. A fetching history is
 *  left alone: removing its last observer would cancel the request, and settling re-arms it. */
function rearmCollection(queryClient: QueryClient, query: Query): void {
  const observer = new QueryObserver(queryClient, { queryKey: query.queryKey, enabled: false });
  observer.subscribe(() => undefined)();
}

const isUnobservedHistory = (query: Query): boolean =>
  historyConversationId(query) != null && query.getObserversCount() === 0;

const newestFirst = (a: IdleHistory, b: IdleHistory): number => b.leftAt - a.leftAt;

/** Walk untyped cache payloads lazily: JSON.stringify would allocate another transcript.
 *  Count UTF-16 strings and scalar slots, not engine-specific object/DOM overhead. */
function estimatePayloadBytes(data: unknown, limit: number): number {
  function* fields(value: object): Generator<unknown> {
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        yield key;
        yield Reflect.get(value, key);
      }
    }
  }

  const seen = new WeakSet<object>();
  const stack: Iterator<unknown>[] = [[data].values()];
  let bytes = 0;
  while (stack.length > 0) {
    const next = stack[stack.length - 1].next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const value = next.value;
    if (typeof value === 'string') {
      bytes += value.length * 2;
    } else if (value != null && typeof value === 'object') {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      bytes += 8;
      stack.push(Array.isArray(value) ? value.values() : fields(value));
    } else {
      bytes += 8;
    }
    if (bytes > limit) {
      return bytes;
    }
  }
  return bytes;
}

/**
 * Releases the message histories of conversations the user has left, so long transcripts do
 * not pile up in memory across conversation switches. React Query's own `cacheTime` cannot
 * express this: it is fixed per query (only ever raised), counts down even while a run is still
 * writing into the cache, and does not bound how many histories a burst of switches retains.
 * While active this module therefore owns their lifetime: per-conversation histories get an
 * infinite `cacheTime`, so React Query never collects one this policy still retains.
 *
 * A history is released once it has no observers, is not fetching, is neither pinned nor exempt,
 * and is either older than `ttlMs` since it was left or beyond the `recent` most recently left
 * conversations, or would exceed the aggregate payload budget.
 * Releases wait while any mutation is pending, since mutation callbacks write into these caches.
 * Returning to a released conversation mounts a fresh query, which fetches the history again.
 *
 * @returns Cleanup that stops tracking and restores the messages query defaults; it releases
 *  nothing (sign-out removes every query anyway).
 */
export function retainMessages(
  queryClient: QueryClient,
  {
    isPinned,
    isExempt = () => false,
    recent = DEFAULT_HISTORY_CACHE_RECENT,
    ttlMs = DEFAULT_HISTORY_CACHE_TTL_MS,
    maxBytes = DEFAULT_HISTORY_CACHE_MAX_BYTES,
  }: MessagesRetentionOptions,
): () => void {
  const cache = queryClient.getQueryCache();
  const leftAt = new Map<string, number>();
  const payloadSizes = new WeakMap<Query, { data: object; writes: number; bytes: number }>();
  const previousDefaults = queryClient.getQueryDefaults([QueryKeys.messages]);
  queryClient.setQueryDefaults([QueryKeys.messages], { ...previousDefaults, cacheTime: Infinity });
  cache.findAll([QueryKeys.messages]).forEach((query) => {
    if (historyConversationId(query) == null) {
      return;
    }
    query.cacheTime = Infinity;
    if (query.getObserversCount() === 0 && query.state.fetchStatus === 'idle') {
      rearmCollection(queryClient, query);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = Infinity;

  const schedule = (delay: number) => {
    const at = Date.now() + delay;
    if (timer != null && dueAt <= at) {
      return;
    }
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(release, delay);
  };

  const collectIdle = (now: number): IdleHistory[] =>
    cache.findAll([QueryKeys.messages]).reduce<IdleHistory[]>((idle, query) => {
      const conversationId = historyConversationId(query);
      if (conversationId == null) {
        return idle;
      }
      if (query.getObserversCount() > 0) {
        leftAt.delete(conversationId);
        return idle;
      }
      const since = leftAt.get(conversationId) ?? now;
      leftAt.set(conversationId, since);
      idle.push({ query, conversationId, leftAt: since });
      return idle;
    }, []);

  function release() {
    timer = undefined;
    dueAt = Infinity;
    if (queryClient.isMutating() > 0) {
      schedule(RELEASE_SETTLE_MS);
      return;
    }
    const now = Date.now();
    const candidates = collectIdle(now).filter((entry) => {
      if (isExempt(entry.conversationId)) {
        return false;
      }
      if (entry.query.state.fetchStatus === 'idle' && !isPinned(entry.conversationId)) {
        return true;
      }
      schedule(PIN_RECHECK_MS);
      return false;
    });
    let retainedBytes = 0;
    candidates.sort(newestFirst).forEach((entry, index) => {
      releaseToolCallParts(entry.conversationId);
      const expiresAt = entry.leftAt + ttlMs;
      if (index < recent && expiresAt > now && maxBytes > 0) {
        const data = entry.query.state.data;
        let bytes = 0;
        if (data != null && typeof data === 'object') {
          const writes = entry.query.state.dataUpdateCount;
          const cached = payloadSizes.get(entry.query);
          bytes =
            cached?.data === data && cached.writes === writes
              ? cached.bytes
              : estimatePayloadBytes(data, maxBytes);
          payloadSizes.set(entry.query, { data, writes, bytes });
        }
        if (retainedBytes + bytes <= maxBytes) {
          retainedBytes += bytes;
          schedule(expiresAt - now);
          return;
        }
      }
      leftAt.delete(entry.conversationId);
      cache.remove(entry.query);
    });
  }

  /** Full preview expansions are cheap to refetch and need not occupy the history grace. */
  const releaseToolCallParts = (conversationId: string) => {
    queryClient.removeQueries({
      queryKey: [QueryKeys.toolCallPart, conversationId],
      predicate: (query) => query.getObserversCount() === 0,
    });
  };

  const unsubscribe = cache.subscribe((event) => {
    if (
      event.type !== 'added' &&
      event.type !== 'updated' &&
      event.type !== 'observerAdded' &&
      event.type !== 'observerRemoved' &&
      event.type !== 'removed'
    ) {
      return;
    }
    const conversationId = historyConversationId(event.query);
    if (conversationId == null) {
      return;
    }
    if (event.type === 'added' || event.type === 'updated') {
      if (event.type === 'added' || event.query.getObserversCount() === 0) {
        schedule(RELEASE_SETTLE_MS);
      }
      return;
    }
    if (event.type === 'removed') {
      releaseToolCallParts(conversationId);
    }
    if (event.type !== 'observerRemoved') {
      leftAt.delete(conversationId);
      return;
    }
    if (event.query.getObserversCount() > 0) {
      return;
    }
    leftAt.set(conversationId, Date.now());
    schedule(RELEASE_SETTLE_MS);
  });

  if (cache.findAll([QueryKeys.messages]).some(isUnobservedHistory)) {
    schedule(RELEASE_SETTLE_MS);
  }

  return () => {
    unsubscribe();
    clearTimeout(timer);
    timer = undefined;
    queryClient.setQueryDefaults([QueryKeys.messages], previousDefaults ?? {});
  };
}
