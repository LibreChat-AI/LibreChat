import { useMemo, useEffect, useContext, createContext, useSyncExternalStore } from 'react';
import type { Context, ReactNode } from 'react';
import type { FollowedChat } from '../follow';
import { useSubagentsHost } from './host';

/**
 * How many threads a page follows only to preview them. A followed thread holds a stream open,
 * and over HTTP/1.1 a browser allows six connections to an origin, which main chat's own stream
 * and every request share. A thread someone opened is always followed; previews take what is
 * left of this many.
 */
export const MAX_PREVIEWED_THREADS = 3;

/**
 * How long a thread stays followed after its last reader leaves. A reader that is replaced, not
 * removed, leaves and returns within one commit: when a reply settles, its row is drawn again
 * under the reply's stored id, and the card in it with it. Letting go at once would close the
 * child's stream and open it again for that.
 */
export const THREAD_LINGER_MS = 250;

/** One reader's interest in a thread. */
export type ThreadInterest = {
  /** Whether this reader knows a generation is running under the thread. */
  live: boolean;
  /** A preview: followed only while the page has room for it. */
  passive: boolean;
};

type FollowedThread = { threadId: string; live: boolean };
type Listener = () => void;

const noThreads: readonly FollowedThread[] = [];
const unsubscribed = (): void => undefined;

/** What a reader holds until the thread's follower has something to report. */
const opening: FollowedChat = {
  chat: undefined,
  messages: [],
  status: 'ready',
  connection: 'idle',
  error: undefined,
  isLoading: true,
  isFollowing: false,
  isUnattached: false,
  isLoadError: false,
  retry: () => undefined,
};

/**
 * The threads one page follows, each once, however many readers want it: the panel showing a
 * child's conversation and the card previewing the same child read one stream. A thread is
 * followed while any reader is interested and let go when the last one leaves.
 */
export class ThreadFollows {
  private readonly interests = new Map<string, Set<ThreadInterest>>();
  /** What each thread's readers last asked for, which holds while none of them is present. */
  private readonly asked = new Map<string, { live: boolean; opened: boolean }>();
  private readonly results = new Map<string, FollowedChat>();
  private readonly threadListeners = new Set<Listener>();
  private readonly resultListeners = new Map<string, Set<Listener>>();
  private followed: readonly FollowedThread[] = noThreads;

  /** Registers a reader's interest; the result lets it go. */
  acquire(threadId: string, interest: ThreadInterest): () => void {
    const readers = this.interests.get(threadId) ?? new Set<ThreadInterest>();
    readers.add(interest);
    this.interests.set(threadId, readers);
    this.changed();
    return () => {
      readers.delete(interest);
      if (readers.size > 0) {
        this.changed();
        return;
      }
      setTimeout(() => {
        if (readers.size === 0 && this.interests.get(threadId) === readers) {
          this.interests.delete(threadId);
          this.asked.delete(threadId);
          this.changed();
        }
      }, THREAD_LINGER_MS);
    };
  }

  subscribeThreads = (listener: Listener): (() => void) => {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  };

  /** The threads to follow now: every opened one, then previews in the order they asked. */
  getThreads = (): readonly FollowedThread[] => {
    const next: FollowedThread[] = [];
    let previews = 0;
    for (const [threadId, readers] of this.interests) {
      let { live, opened } = this.asked.get(threadId) ?? { live: false, opened: false };
      if (readers.size > 0) {
        live = false;
        opened = false;
        for (const reader of readers) {
          live ||= reader.live;
          opened ||= !reader.passive;
        }
        this.asked.set(threadId, { live, opened });
      }
      if (!opened) {
        if (previews >= MAX_PREVIEWED_THREADS) {
          continue;
        }
        previews += 1;
      }
      next.push({ threadId, live });
    }
    const same =
      next.length === this.followed.length &&
      next.every(
        (thread, index) =>
          thread.threadId === this.followed[index].threadId &&
          thread.live === this.followed[index].live,
      );
    if (!same) {
      this.followed = next;
    }
    return this.followed;
  };

  subscribeResult(threadId: string, listener: Listener): () => void {
    const listeners = this.resultListeners.get(threadId) ?? new Set<Listener>();
    listeners.add(listener);
    this.resultListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  /** What the thread's follower last reported; `opening` until it has. */
  getResult(threadId: string): FollowedChat {
    return this.results.get(threadId) ?? opening;
  }

  /** Called by the thread's follower with each state it reaches, and with nothing when it ends. */
  publish(threadId: string, result: FollowedChat | undefined): void {
    if (result == null) {
      this.results.delete(threadId);
    } else {
      this.results.set(threadId, result);
    }
    for (const listener of this.resultListeners.get(threadId) ?? []) {
      listener();
    }
  }

  private changed(): void {
    for (const listener of this.threadListeners) {
      listener();
    }
  }
}

const ThreadFollowsContext: Context<ThreadFollows | undefined> = createContext<
  ThreadFollows | undefined
>(undefined);

/** The page's shared followers, when a provider above offers them. */
export const useThreadFollows = (): ThreadFollows | undefined => useContext(ThreadFollowsContext);

/** Follows one thread for everyone on the page and reports what it holds. */
function ThreadFollower({
  follows,
  parentConversationId,
  threadId,
  live,
}: {
  follows: ThreadFollows;
  parentConversationId: string;
  threadId: string;
  live: boolean;
}): null {
  const host = useSubagentsHost();
  const followed = host.useThreadChat?.(parentConversationId, threadId, { live, enabled: true });
  useEffect(() => {
    follows.publish(threadId, followed);
  });
  useEffect(() => () => follows.publish(threadId, undefined), [follows, threadId]);
  return null;
}

function ThreadFollowers({
  follows,
  parentConversationId,
}: {
  follows: ThreadFollows;
  parentConversationId: string;
}): ReactNode {
  const threads = useSyncExternalStore(
    follows.subscribeThreads,
    follows.getThreads,
    follows.getThreads,
  );
  return threads.map((thread) => (
    <ThreadFollower
      key={thread.threadId}
      follows={follows}
      parentConversationId={parentConversationId}
      threadId={thread.threadId}
      live={thread.live}
    />
  ));
}

/**
 * Shares one follower per child thread among every reader under it, for the children of one
 * parent conversation. Nothing is followed until a reader asks.
 */
export function ThreadFollowsProvider({
  parentConversationId,
  children,
}: {
  parentConversationId: string;
  children: ReactNode;
}): ReactNode {
  const follows = useMemo(
    () => ({ parentConversationId, store: new ThreadFollows() }),
    [parentConversationId],
  ).store;
  return (
    <ThreadFollowsContext.Provider value={follows}>
      <ThreadFollowers follows={follows} parentConversationId={parentConversationId} />
      {children}
    </ThreadFollowsContext.Provider>
  );
}

/**
 * Says this reader wants a thread followed, without reading what the follower holds: a card
 * reads its row from the thread's messages and has no use for every other change.
 */
export function useThreadInterest(
  threadId: string,
  { live, enabled, passive = false }: { live: boolean; enabled: boolean; passive?: boolean },
): void {
  const follows = useThreadFollows();
  useEffect(() => {
    if (follows == null || !enabled || threadId === '') {
      return;
    }
    return follows.acquire(threadId, { live, passive });
  }, [follows, threadId, live, enabled, passive]);
}

/**
 * The page's shared follower of a thread, and this reader's interest in it. Nothing while no
 * provider offers shared followers, or while `enabled` is false.
 */
export function useFollowedThread(
  threadId: string,
  options: { live: boolean; enabled: boolean; passive?: boolean },
): FollowedChat | undefined {
  const follows = useThreadFollows();
  useThreadInterest(threadId, options);
  const subscribe = useMemo(
    () =>
      follows == null
        ? () => unsubscribed
        : (listener: Listener) => follows.subscribeResult(threadId, listener),
    [follows, threadId],
  );
  const read = (): FollowedChat | undefined => follows?.getResult(threadId);
  const result = useSyncExternalStore(subscribe, read, read);
  return options.enabled ? result : undefined;
}
