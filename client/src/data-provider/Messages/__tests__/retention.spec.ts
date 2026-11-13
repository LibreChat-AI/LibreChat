import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { Constants, QueryKeys, DEFAULT_HISTORY_CACHE_TTL_MS } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { retainMessages, PIN_RECHECK_MS, RELEASE_SETTLE_MS } from '../retention';

const TTL = DEFAULT_HISTORY_CACHE_TTL_MS;
/** React Query's own default `cacheTime`, which a retained history must outlive. */
const NATIVE_CACHE_TIME = 5 * 60_000;

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

    jest.advanceTimersByTime(TTL - 1);
    expect(isCached(queryClient, 'a')).toBe(true);

    jest.advanceTimersByTime(1);
    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('releases an oversized history instead of keeping it for the warm-cache grace', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    queryClient.setQueryData(
      [QueryKeys.messages, 'large'],
      [{ ...history('large')[0], text: 'x'.repeat(4096) }],
    );
    observe(queryClient, 'large')();

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'large')).toBe(false);
  });

  it('rechecks the budget when a late cache write grows a previously measured history', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    visit(queryClient, 'a');
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'a')).toBe(true);

    queryClient.setQueryData(
      [QueryKeys.messages, 'a'],
      [{ ...history('a')[0], text: 'x'.repeat(4096) }],
    );
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('remeasures same-reference writes even when their timestamp is unchanged', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    visit(queryClient, 'a');
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    const key = [QueryKeys.messages, 'a'];
    const messages = queryClient.getQueryData<TMessage[]>(key)!;
    const updatedAt = queryClient.getQueryState(key)!.dataUpdatedAt;
    const writes = queryClient.getQueryState(key)!.dataUpdateCount;
    messages[0].text = 'x'.repeat(4096);

    queryClient.setQueryData(key, messages, { updatedAt });
    expect(queryClient.getQueryData(key)).toBe(messages);
    expect(queryClient.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt);
    expect(queryClient.getQueryState(key)!.dataUpdateCount).toBe(writes + 1);
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('remeasures an observed in-place write after its history becomes inactive again', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    visit(queryClient, 'a');
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    const unmount = observe(queryClient, 'a');
    const key = [QueryKeys.messages, 'a'];
    const messages = queryClient.getQueryData<TMessage[]>(key)!;
    messages[0].text = 'x'.repeat(4096);
    queryClient.setQueryData(key, messages);
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'a')).toBe(true);

    unmount();
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
  });

  it('reuses an estimate across observer and fetch-status events without data writes', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    const key = [QueryKeys.messages, 'a'];
    const message = history('a')[0];
    queryClient.setQueryData(key, [message]);
    const readText = jest.fn(() => 'small');
    Object.defineProperty(message, 'text', { enumerable: true, get: readText });
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(readText).toHaveBeenCalledTimes(1);

    const unmount = observe(queryClient, 'a');
    unmount();
    queryClient.getQueryCache().find(key)!.setState({ fetchStatus: 'idle' });
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(true);
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('applies the payload budget across all recently left histories, newest first', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, recent: 3, maxBytes: 1024 });
    for (const id of ['a', 'b', 'c']) {
      queryClient.setQueryData(
        [QueryKeys.messages, id],
        [{ ...history(id)[0], text: 'x'.repeat(300) }],
      );
      observe(queryClient, id)();
      jest.advanceTimersByTime(10);
    }

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isCached(queryClient, 'b')).toBe(false);
    expect(isCached(queryClient, 'c')).toBe(true);
  });

  it('does not inspect observed, pinned or exempt histories to enforce the budget', () => {
    stop();
    stop = retainMessages(queryClient, {
      isPinned: (id) => pinned.has(id),
      isExempt: (id) => id === 'assistant',
      maxBytes: 0,
    });
    seed(queryClient, 'shown');
    const unmount = observe(queryClient, 'shown');
    pinned.add('running');
    visit(queryClient, 'running');
    visit(queryClient, 'assistant');
    visit(queryClient, 'left');

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'shown')).toBe(true);
    expect(isCached(queryClient, 'running')).toBe(true);
    expect(isCached(queryClient, 'assistant')).toBe(true);
    expect(isCached(queryClient, 'left')).toBe(false);
    unmount();
  });

  it('stops measuring once a payload exceeds the budget without serializing it', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, maxBytes: 1024 });
    const message = { ...history('large')[0], text: 'x'.repeat(4096) };
    const toJSON = jest.fn(() => {
      throw new Error('must not serialize the transcript');
    });
    Object.defineProperty(message, 'toJSON', { value: toJSON });
    queryClient.setQueryData([QueryKeys.messages, 'large'], [message]);
    const trailing = jest.fn(() => {
      throw new Error('must stop at the oversized text');
    });
    Object.defineProperty(message, 'trailing', { enumerable: true, get: trailing });
    observe(queryClient, 'large')();

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'large')).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
    expect(trailing).not.toHaveBeenCalled();
  });

  it('releases unobserved full tool parts even when the small history keeps its grace', () => {
    visit(queryClient, 'a');
    const key = [QueryKeys.toolCallPart, 'a', 'message', 'call'];
    queryClient.setQueryData(key, { tool_call: { output: 'x'.repeat(4096) } });

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(true);
    expect(queryClient.getQueryData(key)).toBeUndefined();
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

    jest.advanceTimersByTime(TTL * 2);

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
    jest.advanceTimersByTime(TTL);

    expect(isCached(queryClient, 'running')).toBe(false);
    expect(isCached(queryClient, 'on-screen')).toBe(false);
  });

  it('restarts the clock when a left conversation is opened again', () => {
    visit(queryClient, 'a');
    jest.advanceTimersByTime(TTL / 2);
    const unmount = observe(queryClient, 'a');

    jest.advanceTimersByTime(TTL);
    expect(isCached(queryClient, 'a')).toBe(true);

    unmount();
    jest.advanceTimersByTime(TTL - 1);
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

    jest.advanceTimersByTime(TTL * 2);
    expect(isCached(queryClient, 'a')).toBe(true);
    expect(isCached(queryClient, 'b')).toBe(true);

    settle();
    await pending;
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isCached(queryClient, 'b')).toBe(false);
  });

  it('owns collection, so a pinned history outlives the native cacheTime', () => {
    stop();
    queryClient.clear();
    seed(queryClient, 'mounted-first');
    const unmount = observe(queryClient, 'mounted-first');
    visit(queryClient, 'left-first');
    stop = retainMessages(queryClient, { isPinned: (id) => pinned.has(id) });
    pinned.add('mounted-first').add('left-first').add('running');
    unmount();
    visit(queryClient, 'running');

    jest.advanceTimersByTime(NATIVE_CACHE_TIME * 2);

    expect(isCached(queryClient, 'mounted-first')).toBe(true);
    expect(isCached(queryClient, 'left-first')).toBe(true);
    expect(isCached(queryClient, 'running')).toBe(true);
  });

  it('releases a history seeded without ever being observed', () => {
    seed(queryClient, 'forked');

    jest.advanceTimersByTime(TTL);
    expect(isCached(queryClient, 'forked')).toBe(true);
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'forked')).toBe(false);
  });

  it('applies the configured grace and recent count', () => {
    stop();
    stop = retainMessages(queryClient, { isPinned: () => false, recent: 2, ttlMs: 10_000 });
    visit(queryClient, 'a');
    jest.advanceTimersByTime(10);
    visit(queryClient, 'b');
    jest.advanceTimersByTime(10);
    visit(queryClient, 'c');

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isCached(queryClient, 'b')).toBe(true);
    expect(isCached(queryClient, 'c')).toBe(true);

    jest.advanceTimersByTime(10_000);
    expect(isCached(queryClient, 'b')).toBe(false);
    expect(isCached(queryClient, 'c')).toBe(false);
  });

  it('rechecks a pinned history soon after its pin clears, whatever the TTL', () => {
    stop();
    stop = retainMessages(queryClient, {
      isPinned: (id) => pinned.has(id),
      recent: 0,
      ttlMs: 60 * 60_000,
    });
    pinned.add('running');
    visit(queryClient, 'running');
    jest.advanceTimersByTime(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'running')).toBe(true);

    pinned.delete('running');
    jest.advanceTimersByTime(PIN_RECHECK_MS);

    expect(isCached(queryClient, 'running')).toBe(false);
  });

  it('keeps exempt histories without polling them', () => {
    stop();
    stop = retainMessages(queryClient, {
      isPinned: () => false,
      isExempt: (id) => id === 'assistant',
      recent: 0,
    });
    visit(queryClient, 'assistant');

    jest.advanceTimersByTime(RELEASE_SETTLE_MS);

    expect(isCached(queryClient, 'assistant')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves a fetching history alone at startup instead of re-arming it', async () => {
    stop();
    queryClient.clear();
    let signal: AbortSignal | undefined;
    const pending = queryClient.fetchQuery([QueryKeys.messages, 'sharing'], (context) => {
      signal = context.signal;
      return new Promise<TMessage[]>(() => undefined);
    });
    stop = retainMessages(queryClient, { isPinned: () => false });

    expect(signal?.aborted).toBe(false);
    expect(queryClient.getQueryState([QueryKeys.messages, 'sharing'])?.fetchStatus).toBe(
      'fetching',
    );
    void pending.catch(() => undefined);
  });

  it('releases the full tool-call parts fetched for a conversation along with its history', () => {
    const part = (conversationId: string, index: number) => [
      QueryKeys.toolCallPart,
      conversationId,
      `${conversationId}-1`,
      index,
      'call',
      '',
      '',
      'rev',
    ];
    const isPartCached = (key: unknown[]) => queryClient.getQueryCache().find(key) != null;
    visit(queryClient, 'a');
    queryClient.setQueryData(part('a', 1), { tool_call: { output: 'full' } });
    queryClient.setQueryData(part('b', 1), { tool_call: { output: 'other conversation' } });
    seed(queryClient, 'b');
    const stillOpen = observe(queryClient, 'b');

    jest.advanceTimersByTime(TTL);
    expect(isCached(queryClient, 'a')).toBe(false);
    expect(isPartCached(part('a', 1))).toBe(false);
    expect(isPartCached(part('b', 1))).toBe(true);

    queryClient.setQueryData(part('b', 2), { tool_call: { output: 'cleared' } });
    queryClient.removeQueries([QueryKeys.messages, 'b'], { exact: true });
    expect(isPartCached(part('b', 2))).toBe(false);
    stillOpen();
  });

  it('restores the messages query defaults on cleanup', () => {
    expect(queryClient.getQueryDefaults([QueryKeys.messages])?.cacheTime).toBe(Infinity);
    stop();
    expect(queryClient.getQueryDefaults([QueryKeys.messages])?.cacheTime).toBeUndefined();
  });

  it('releases nothing after cleanup', () => {
    visit(queryClient, 'a');
    visit(queryClient, 'b');
    stop();

    jest.advanceTimersByTime(TTL * 2);

    expect(isCached(queryClient, 'a')).toBe(true);
    expect(isCached(queryClient, 'b')).toBe(true);
  });
});
