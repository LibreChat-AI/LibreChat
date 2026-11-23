import { useMemo, useEffect, useContext, createContext } from 'react';
import { selectAtom } from 'jotai/utils';
import { atom, createStore, useAtomValue, useSetAtom } from 'jotai';
import type { Atom, PrimitiveAtom } from 'jotai';
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

/**
 * A thread's readers, and what they last asked for between them, which holds for the moment
 * after the last one leaves.
 */
type ThreadReaders = { interests: readonly ThreadInterest[]; live: boolean; opened: boolean };
type Readers = ReadonlyMap<string, ThreadReaders>;
type FollowedThread = { threadId: string; live: boolean };

/**
 * The threads one page follows, each once, however many readers want it: the panel showing a
 * child's conversation and the card previewing the same child read one stream. A thread is
 * followed while any reader is interested and let go shortly after the last one leaves. The
 * atoms belong to one provider, so two pages' followers never meet.
 */
export type ThreadFollows = {
  /**
   * The store the atoms below are read and written in. Its own, so a reader under some other
   * Jotai provider than the followers reads the same state they do.
   */
  store: ReturnType<typeof createStore>;
  readers: PrimitiveAtom<Readers>;
  /** The threads to follow now: every opened one, then previews in the order they asked. */
  followed: Atom<readonly FollowedThread[]>;
  /** What a thread's follower last reported; nothing until it has. */
  result: (threadId: string) => PrimitiveAtom<FollowedChat | undefined>;
};

const noReaders: Readers = new Map();

const sameThreads = (a: readonly FollowedThread[], b: readonly FollowedThread[]): boolean =>
  a.length === b.length &&
  a.every(
    (thread, index) => thread.threadId === b[index].threadId && thread.live === b[index].live,
  );

const selectFollowed = (readers: Readers): readonly FollowedThread[] => {
  const followed: FollowedThread[] = [];
  let previews = 0;
  for (const [threadId, { live, opened }] of readers) {
    if (!opened) {
      if (previews >= MAX_PREVIEWED_THREADS) {
        continue;
      }
      previews += 1;
    }
    followed.push({ threadId, live });
  }
  return followed;
};

const withInterests = (interests: readonly ThreadInterest[], previous?: ThreadReaders) =>
  interests.length === 0 && previous != null
    ? { ...previous, interests }
    : {
        interests,
        live: interests.some((interest) => interest.live),
        opened: interests.some((interest) => !interest.passive),
      };

const createThreadFollows = (): ThreadFollows => {
  const readers = atom<Readers>(noReaders);
  const results = new Map<string, PrimitiveAtom<FollowedChat | undefined>>();
  return {
    store: createStore(),
    readers,
    followed: selectAtom(readers, selectFollowed, sameThreads),
    result: (threadId) => {
      const known = results.get(threadId);
      if (known != null) {
        return known;
      }
      const created = atom<FollowedChat | undefined>(undefined);
      results.set(threadId, created);
      return created;
    },
  };
};

/** Read where no page shares followers: nothing is ever written to these. */
const unshared: ThreadFollows = createThreadFollows();

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
  hasEarlier: false,
  isLoadingEarlier: false,
  isEarlierError: false,
  loadEarlier: () => undefined,
  canSend: () => false,
  send: () => false,
  stop: () => Promise.resolve(),
  attach: () => undefined,
};

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
  const report = useSetAtom(follows.result(threadId), follows);
  useEffect(() => {
    report(followed);
  });
  useEffect(() => () => report(undefined), [report]);
  return null;
}

function ThreadFollowers({
  follows,
  parentConversationId,
}: {
  follows: ThreadFollows;
  parentConversationId: string;
}): ReactNode {
  const threads = useAtomValue(follows.followed, follows);
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
    () => ({ parentConversationId, atoms: createThreadFollows() }),
    [parentConversationId],
  ).atoms;
  return (
    <ThreadFollowsContext.Provider value={follows}>
      <ThreadFollowers follows={follows} parentConversationId={parentConversationId} />
      {children}
    </ThreadFollowsContext.Provider>
  );
}

/**
 * Says this reader wants a thread followed, without reading what the follower holds: a card
 * reads its row from the thread's messages and has no use for every other change. Returns
 * whether the thread is being followed, which a preview with no room on the page is not. Where
 * no page shares followers there is nothing to be admitted to, and the answer is yes.
 */
export function useThreadInterest(
  threadId: string,
  { live, enabled, passive = false }: { live: boolean; enabled: boolean; passive?: boolean },
): boolean {
  const shared = useThreadFollows();
  const follows = shared ?? unshared;
  const setReaders = useSetAtom(follows.readers, follows);
  useEffect(() => {
    if (shared == null || !enabled || threadId === '') {
      return;
    }
    const interest: ThreadInterest = { live, passive };
    setReaders((readers) => {
      const previous = readers.get(threadId);
      const next = new Map(readers);
      next.set(threadId, withInterests([...(previous?.interests ?? []), interest], previous));
      return next;
    });
    return () => {
      setReaders((readers) => {
        const previous = readers.get(threadId);
        if (previous == null) {
          return readers;
        }
        const next = new Map(readers);
        next.set(
          threadId,
          withInterests(
            previous.interests.filter((reader) => reader !== interest),
            previous,
          ),
        );
        return next;
      });
      setTimeout(() => {
        setReaders((readers) => {
          if (readers.get(threadId)?.interests.length !== 0) {
            return readers;
          }
          const next = new Map(readers);
          next.delete(threadId);
          return next;
        });
      }, THREAD_LINGER_MS);
    };
  }, [shared, setReaders, threadId, live, enabled, passive]);
  const admitted = useMemo(
    () =>
      selectAtom(follows.followed, (threads) =>
        threads.some((thread) => thread.threadId === threadId),
      ),
    [follows, threadId],
  );
  const followed = useAtomValue(admitted, follows);
  return shared == null || followed;
}

/**
 * The page's shared follower of a thread, and this reader's interest in it. Nothing while no
 * provider offers shared followers, or while `enabled` is false.
 */
export function useFollowedThread(
  threadId: string,
  options: { live: boolean; enabled: boolean; passive?: boolean },
): FollowedChat | undefined {
  const shared = useThreadFollows();
  useThreadInterest(threadId, options);
  const follows = shared ?? unshared;
  const result = useAtomValue(follows.result(threadId), follows);
  if (shared == null || !options.enabled) {
    return undefined;
  }
  return result ?? opening;
}
