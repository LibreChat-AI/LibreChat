import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { retainMessages, RELEASE_SETTLE_MS, LEFT_HISTORY_TTL_MS } from '../retention';

const history = (conversationId: string): TMessage[] => [
  { messageId: `${conversationId}-1`, conversationId, text: conversationId } as TMessage,
];

const seed = (queryClient: QueryClient, conversationId: string) =>
  queryClient.setQueryData([QueryKeys.messages, conversationId], history(conversationId));

const isCached = (queryClient: QueryClient, conversationId: string) =>
  queryClient.getQueryCache().find([QueryKeys.messages, conversationId]) != null;

/** Mounts a reader the way an on-screen view does; the returned function unmounts it. */
const observe = (queryClient: QueryClient, conversationId: string): (() => void) => {
  const observer = new QueryObserver(queryClient, {
    queryKey: [QueryKeys.messages, conversationId],
    enabled: false,
  });
  return observer.subscribe(() => undefined);
};

/** Opens a conversation and leaves it, which is when its retention clock starts. */
const visit = (queryClient: QueryClient, conversationId: string) => {
  seed(queryClient, conversationId);
  observe(queryClient, conversationId)();
};

describe('retainMessages', () => {
  let queryClient: QueryClient;
  let pinned: Set<string>;
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    queryClient = new QueryClient();
    pinned = new Set();
    stop = retainMessages(queryClient, { isPinned: (id) => pinned.has(id) });
  });

  afterEach(() => {
    stop();
    queryClient.clear();
    jest.useRealTimers();
  });

  it('releases the last conversation left once its history outlives the TTL', () => {
    visit(queryClient, 'a');

    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS - 1);
    expect(isCached(queryClient, 'a')).toBe(true);

    jest.advanceTimersByTime(1);
    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('keeps only the most recently left conversation across a burst of switches', () => {
    visit(queryClient, 'a');
    jest.advanceTimersByTime(10);
    visit(queryClient, 'b');
    jest.advanceTimersByTime(10);
    visit(queryClient, 'c');

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isCached(queryClient, 'b')).toBe(false);
    expect(isCached(queryClient, 'c')).toBe(true);
  });

  it('keeps observed, pinned and fetching histories, and placeholder or list queries', () => {
    seed(queryClient, 'on-screen');
    const unmount = observe(queryClient, 'on-screen');
    visit(queryClient, 'running');
    pinned.add('running');
    visit(queryClient, 'loading');
    queryClient.getQueryCache().find([QueryKeys.messages, 'loading'])?.setState({
      fetchStatus: 'fetching',
    });
    queryClient.setQueryData([QueryKeys.messages, Constants.NEW_CONVO], history('new'));
    queryClient.setQueryData([QueryKeys.messages, { conversationId: 'listed' }], {
      pages: [],
      pageParams: [],
    });
    visit(queryClient, 'idle');

    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS * 2);

    expect(isCached(queryClient, 'idle')).toBe(false);
    expect(isCached(queryClient, 'on-screen')).toBe(true);
    expect(isCached(queryClient, 'running')).toBe(true);
    expect(isCached(queryClient, 'loading')).toBe(true);
    expect(isCached(queryClient, Constants.NEW_CONVO)).toBe(true);
    expect(
      queryClient.getQueryData([QueryKeys.messages, { conversationId: 'listed' }]),
    ).toBeDefined();

    unmount();
    pinned.delete('running');
    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS);

    expect(isCached(queryClient, 'running')).toBe(false);
    expect(isCached(queryClient, 'on-screen')).toBe(false);
  });

  it('restarts the clock when a left conversation is opened again', () => {
    visit(queryClient, 'a');
    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS / 2);
    const unmount = observe(queryClient, 'a');

    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS);
    expect(isCached(queryClient, 'a')).toBe(true);

    unmount();
    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS - 1);
    expect(isCached(queryClient, 'a')).toBe(true);
    jest.advanceTimersByTime(1);
    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('waits for pending mutations, whose callbacks write into these caches', async () => {
    let settle: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => gate,
    });
    const pending = mutation.execute();
    visit(queryClient, 'a');
    visit(queryClient, 'b');

    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS * 2);
    expect(isCached(queryClient, 'a')).toBe(true);
    expect(isCached(queryClient, 'b')).toBe(true);

    settle();
    await pending;
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isCached(queryClient, 'b')).toBe(false);
  });

  it('releases nothing after cleanup', () => {
    visit(queryClient, 'a');
    visit(queryClient, 'b');
    stop();

    jest.advanceTimersByTime(LEFT_HISTORY_TTL_MS * 2);

    expect(isCached(queryClient, 'a')).toBe(true);
    expect(isCached(queryClient, 'b')).toBe(true);
  });
});
