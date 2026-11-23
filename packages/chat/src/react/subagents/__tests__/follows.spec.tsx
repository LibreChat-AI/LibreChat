/**
 * @jest-environment jsdom
 */
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { FollowedChat } from '../../follow';
import {
  useFollowedThread,
  useThreadInterest,
  ThreadFollowsProvider,
  THREAD_LINGER_MS,
  MAX_PREVIEWED_THREADS,
} from '../follows';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { SubagentsHostProvider } from '../host';

const followed = (overrides: Partial<FollowedChat> = {}): FollowedChat => ({
  chat: undefined,
  messages: [],
  status: 'ready',
  connection: 'idle',
  error: undefined,
  isLoading: false,
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
  ...overrides,
});

/** Each thread's follower as the host sees it: which are mounted, and how each was last asked. */
let asked: Record<string, { live: boolean; enabled: boolean }>;
let results: Record<string, FollowedChat>;
let mounted: Set<string>;
let unmounts: number;

const host = createSubagentsHost({
  useThreadChat: (_parent, threadId, options) => {
    asked[threadId] = options;
    useEffect(() => {
      mounted.add(threadId);
      return () => {
        mounted.delete(threadId);
        unmounts += 1;
      };
    }, [threadId]);
    return results[threadId] ?? followed({ isLoading: true });
  },
});

const page = (ui: ReactElement) => (
  <SubagentsHostProvider host={host}>
    <ThreadFollowsProvider parentConversationId="parent">{ui}</ThreadFollowsProvider>
  </SubagentsHostProvider>
);

function Reader({ threadId, live = false }: { threadId: string; live?: boolean }): null {
  seen[threadId] = useFollowedThread(threadId, { live, enabled: true });
  return null;
}

function Preview({ threadId }: { threadId: string }): null {
  admitted[threadId] = useThreadInterest(threadId, { live: true, enabled: true, passive: true });
  return null;
}

let admitted: Record<string, boolean>;

let seen: Record<string, FollowedChat | undefined>;

beforeEach(() => {
  asked = {};
  results = {};
  seen = {};
  mounted = new Set();
  unmounts = 0;
  admitted = {};
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ThreadFollowsProvider', () => {
  it('follows a thread once for every reader and lets it go when the last one leaves', () => {
    const view = render(
      page(
        <>
          <Reader threadId="thread-1" />
          <Preview threadId="thread-1" />
        </>,
      ),
    );
    /** One follower, live for the page as soon as any reader knows a run is going. */
    expect([...mounted]).toEqual(['thread-1']);
    expect(asked['thread-1']).toEqual({ live: true, enabled: true });

    view.rerender(page(<Reader threadId="thread-1" />));
    expect([...mounted]).toEqual(['thread-1']);
    expect(asked['thread-1']).toEqual({ live: false, enabled: true });

    view.rerender(page(<></>));
    /** Kept for a moment, so a reader that is only being replaced finds it still open. */
    expect([...mounted]).toEqual(['thread-1']);
    act(() => jest.advanceTimersByTime(THREAD_LINGER_MS));
    expect([...mounted]).toEqual([]);
  });

  it('keeps one follower through a reader being replaced', () => {
    const view = render(page(<Preview key="first" threadId="thread-1" />));
    view.rerender(page(<Preview key="second" threadId="thread-1" />));
    act(() => jest.advanceTimersByTime(THREAD_LINGER_MS * 2));
    expect([...mounted]).toEqual(['thread-1']);
    expect(unmounts).toBe(0);
  });

  it('hands a reader an opening state until the follower reports, then what it reports', () => {
    results['thread-1'] = followed({ isLoading: true });
    const view = render(page(<Reader threadId="thread-1" />));
    expect(seen['thread-1']).toMatchObject({ isLoading: true, messages: [] });

    const streaming = followed({ status: 'streaming', isFollowing: true });
    results['thread-1'] = streaming;
    act(() => view.rerender(page(<Reader threadId="thread-1" live />)));
    expect(seen['thread-1']).toBe(streaming);
  });

  it('previews only as many threads as the page has room for, and always follows an opened one', () => {
    const previews = Array.from({ length: MAX_PREVIEWED_THREADS + 1 }, (_, n) => `preview-${n}`);
    const view = render(
      page(
        <>
          {previews.map((threadId) => (
            <Preview key={threadId} threadId={threadId} />
          ))}
          <Reader threadId="opened" />
        </>,
      ),
    );
    const overflow = previews[MAX_PREVIEWED_THREADS];
    expect([...mounted].sort()).toEqual(
      [...previews.slice(0, MAX_PREVIEWED_THREADS), 'opened'].sort(),
    );

    /** Opening a preview that had no room follows it. */
    view.rerender(
      page(
        <>
          {previews.map((threadId) => (
            <Preview key={threadId} threadId={threadId} />
          ))}
          <Reader threadId="opened" />
          <Reader threadId={overflow} />
        </>,
      ),
    );
    expect(mounted.has(overflow)).toBe(true);
    expect(asked[overflow]).toEqual({ live: true, enabled: true });

    /** A preview that ends gives its room to the next one waiting. */
    view.rerender(
      page(
        <>
          {previews.slice(1).map((threadId) => (
            <Preview key={threadId} threadId={threadId} />
          ))}
        </>,
      ),
    );
    act(() => jest.advanceTimersByTime(THREAD_LINGER_MS));
    expect([...mounted].sort()).toEqual(previews.slice(1).sort());
  });

  it('tells a preview whether its thread is being followed, including once it loses its room', () => {
    const previews = Array.from({ length: MAX_PREVIEWED_THREADS + 1 }, (_, n) => `preview-${n}`);
    const overflow = previews[MAX_PREVIEWED_THREADS];
    const cards = previews.map((threadId) => <Preview key={threadId} threadId={threadId} />);
    const view = render(page(<>{cards}</>));
    expect(admitted[previews[0]]).toBe(true);
    expect(admitted[overflow]).toBe(false);

    /** Opened, it is followed whatever the cap; closed again, it is back to having no room. */
    view.rerender(
      page(
        <>
          {cards}
          <Reader threadId={overflow} />
        </>,
      ),
    );
    expect(admitted[overflow]).toBe(true);

    view.rerender(page(<>{cards}</>));
    act(() => jest.advanceTimersByTime(THREAD_LINGER_MS));
    expect(admitted[overflow]).toBe(false);
    expect(mounted.has(overflow)).toBe(false);
  });

  it('follows nothing where no page shares followers', () => {
    function Lone(): null {
      seen.lone = useFollowedThread('thread-1', { live: true, enabled: true });
      return null;
    }
    render(
      <SubagentsHostProvider host={host}>
        <Lone />
      </SubagentsHostProvider>,
    );
    expect(seen.lone).toBeUndefined();
    expect([...mounted]).toEqual([]);
  });
});
