/**
 * White-box integration test for `useTitleGeneration`'s effect logic.
 *
 * Complements the helper unit tests in `queries.test.ts` by driving the REAL
 * hook (real React state/effects) with a controllable react-query surface, so
 * the stateful decisions — immediate-vs-final eligibility, success application,
 * defer-while-active, and the post-completion `resetQueries` remount — are
 * deterministically locked down without timer/async flakiness.
 *
 * `~/utils` re-exports from `@librechat/client` (framer-motion peer, absent in
 * jsdom); mocked to the two symbols the hook uses. react-query is mocked so we
 * control `activeJobIds`, the per-conversation query results, and spy the
 * QueryClient — the hook's own React effects still run for real.
 */
let mockActiveJobIds: string[] = [];
let mockTiming: 'immediate' | 'final' = 'immediate';
let mockQueriesResults: Array<{
  isSuccess?: boolean;
  isError?: boolean;
  data?: { title: string; titleSetByUser?: boolean; titleRevision?: number };
  error?: unknown;
}> = [];
let mockCapturedQueries: Array<{ queryKey: unknown[] }> = [];

const mockSetQueryData = jest.fn();
const mockGetQueryData = jest.fn();
const mockRemoveQueries = jest.fn();
const mockResetQueries = jest.fn();
const mockUpdateConvoInAllQueries = jest.fn();
const mockFindManualTitle = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: { activeJobIds: mockActiveJobIds } })),
  useQueries: jest.fn(({ queries }: { queries: Array<{ queryKey: unknown[] }> }) => {
    mockCapturedQueries = queries;
    return mockQueriesResults;
  }),
  useQueryClient: jest.fn(() => ({
    setQueryData: mockSetQueryData,
    getQueryData: mockGetQueryData,
    removeQueries: mockRemoveQueries,
    resetQueries: mockResetQueries,
  })),
}));

jest.mock('../../Endpoints', () => ({
  useGetStartupConfig: () => ({ data: { titleGenerationTiming: mockTiming } }),
}));

jest.mock('~/utils', () => ({
  findManualConvoTitleInAllQueries: (...args: unknown[]) => mockFindManualTitle(...args),
  isNotFoundError: (error: unknown): boolean => {
    if (error != null && typeof error === 'object') {
      return (error as { response?: { status?: number } }).response?.status === 404;
    }
    return false;
  },
  updateConvoInAllQueries: (...args: unknown[]) => mockUpdateConvoInAllQueries(...args),
}));

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  QueryKeys: { conversation: 'conversation', activeJobs: 'activeJobs' },
  request: { get: jest.fn() },
  dataService: { genTitle: jest.fn(), getActiveJobs: jest.fn() },
}));

import { renderHook, act } from '@testing-library/react';
import type { ChatEvent, ChatTransport } from 'librechat-data-provider';
import {
  useTitleGeneration,
  genTitleQueryKey,
  queueTitleGeneration,
  TITLE_STREAM_RETRIES,
  isTitleGenerationProcessed,
  markTitleGenerationProcessed,
} from '../queries';

const notFound = { response: { status: 404 } };

/** queryKeys passed to the latest `useQueries` call (i.e. the ready-to-fetch set). */
const eligibleKeys = () => mockCapturedQueries.map((q) => JSON.stringify(q.queryKey));
const isEligible = (id: string) => eligibleKeys().includes(JSON.stringify(genTitleQueryKey(id)));

beforeEach(() => {
  mockActiveJobIds = [];
  mockTiming = 'immediate';
  mockQueriesResults = [];
  mockCapturedQueries = [];
  jest.clearAllMocks();
  mockGetQueryData.mockReset();
  mockFindManualTitle.mockReset().mockImplementation((_client, id, incoming) => {
    const cached = mockGetQueryData(['conversation', id]);
    if (
      cached?.titleSetByUser &&
      cached.title != null &&
      (!incoming.titleSetByUser || (cached.titleRevision ?? 0) > (incoming.titleRevision ?? 0))
    ) {
      return cached;
    }
    return incoming.titleSetByUser ? incoming : undefined;
  });
});

describe('useTitleGeneration — eligibility', () => {
  it('immediate mode: fetches a queued conversation while its stream is still active', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-imm'];

    renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-imm'));

    expect(isEligible('conv-imm')).toBe(true);
  });

  it('final mode: gates a queued conversation until its stream completes', () => {
    mockTiming = 'final';
    mockActiveJobIds = ['conv-fin'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-fin'));
    expect(isEligible('conv-fin')).toBe(false);

    // Stream completes — the conversation leaves the active set.
    mockActiveJobIds = [];
    rerender();
    expect(isEligible('conv-fin')).toBe(true);
  });

  it('stops polling when a title is completed by an SSE event', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-sse-title'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-sse-title'));
    expect(isEligible('conv-sse-title')).toBe(true);

    act(() => markTitleGenerationProcessed('conv-sse-title'));
    rerender();

    expect(isEligible('conv-sse-title')).toBe(false);
  });
});

describe('useTitleGeneration — result handling', () => {
  it('keeps a persisted manual title when an old title poll resolves', () => {
    const id = 'conv-manual-poll';
    const owned = { title: 'New Chat', titleSetByUser: true };
    mockGetQueryData.mockImplementation((key: string[]) => (key[1] === id ? owned : undefined));
    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration(id));
    mockQueriesResults = [{ isSuccess: true, data: { title: 'Old generated title' } }];
    rerender();
    const call = mockSetQueryData.mock.calls.find(([key]) => key[1] === id);
    const updater = call?.[1] as (value: typeof owned) => typeof owned;
    expect(updater(owned)).toEqual(owned);
  });

  it.each([
    [1, 2],
    [3, 2],
  ])('orders polled manual revisions (cache %s, poll %s)', (cachedRevision, polledRevision) => {
    const id = `manual-poll-${cachedRevision}-${polledRevision}`;
    const cached = { title: 'Cached rename', titleSetByUser: true, titleRevision: cachedRevision };
    mockGetQueryData.mockImplementation((key: string[]) => (key[1] === id ? cached : undefined));
    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration(id));
    mockQueriesResults = [
      {
        isSuccess: true,
        data: { title: 'Polled rename', titleSetByUser: true, titleRevision: polledRevision },
      },
    ];
    rerender();
    const update = mockSetQueryData.mock.calls.find(([key]) => key[1] === id)?.[1];
    const expected =
      polledRevision >= cachedRevision
        ? { title: 'Polled rename', titleSetByUser: true, titleRevision: polledRevision }
        : cached;
    expect(update(cached)).toEqual(expected);
    const updateLists = mockUpdateConvoInAllQueries.mock.calls.find(([, key]) => key === id)?.[2];
    expect(updateLists(cached)).toEqual(expected);
    expect(isEligible(id)).toBe(false);
  });

  it('propagates the highest cached manual revision instead of an older poll', () => {
    const id = 'manual-list-poll';
    const newest = { title: 'List rename', titleSetByUser: true, titleRevision: 3 };
    mockFindManualTitle.mockReturnValue(newest);
    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration(id));
    mockQueriesResults = [
      { isSuccess: true, data: { title: 'Point rename', titleSetByUser: true, titleRevision: 2 } },
    ];
    rerender();
    const update = mockSetQueryData.mock.calls.find(([key]) => key[1] === id)?.[1];
    expect(update({ title: 'Point rename', titleSetByUser: true, titleRevision: 2 })).toEqual(
      newest,
    );
    const updateLists = mockUpdateConvoInAllQueries.mock.calls.find(([, key]) => key === id)?.[2];
    expect(updateLists({ title: 'Other rename', titleSetByUser: true, titleRevision: 1 })).toEqual(
      newest,
    );
  });

  it('applies the fetched title to the conversation caches on success', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-ok'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-ok'));

    mockQueriesResults = [{ isSuccess: true, isError: false, data: { title: 'Quantum Chat' } }];
    rerender();

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['conversation', 'conv-ok'],
      expect.any(Function),
    );
    expect(mockUpdateConvoInAllQueries).toHaveBeenCalled();

    const call = mockSetQueryData.mock.calls.find(
      ([key]) => JSON.stringify(key) === JSON.stringify(['conversation', 'conv-ok']),
    );
    const updater = call?.[1] as (c?: { title?: string }) => { title?: string };
    expect(updater({ title: 'New Chat' })).toEqual(
      expect.objectContaining({ title: 'Quantum Chat' }),
    );
  });

  it('a 404 while the stream is active defers (removeQueries), not giving up', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-active404'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-active404'));

    mockQueriesResults = [{ isError: true, isSuccess: false, error: notFound }];
    rerender();

    expect(mockRemoveQueries).toHaveBeenCalledWith(genTitleQueryKey('conv-active404'));
    expect(mockResetQueries).not.toHaveBeenCalled();
  });

  it('a 404 after the stream completes forces a fresh fetch via resetQueries', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = []; // stream already complete

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-done404'));

    mockQueriesResults = [{ isError: true, isSuccess: false, error: notFound }];
    rerender();

    expect(mockResetQueries).toHaveBeenCalledWith(genTitleQueryKey('conv-done404'));
  });
});

/** A transport that records each title stream the hook opens and lets the test answer it. */
const createTransport = () => {
  const streams: Array<{ url: string; signal: AbortSignal; emit: (event: ChatEvent) => void }> = [];
  const transport = {
    send: jest.fn(),
    reconnectToStream: jest.fn(
      (
        { url }: { url: string },
        { signal, onEvent }: { signal: AbortSignal; onEvent: (event: ChatEvent) => void },
      ) => {
        streams.push({ url, signal, emit: (event) => act(() => onEvent(event)) });
        return { closed: false };
      },
    ),
  };
  return { transport: transport as unknown as ChatTransport, streams };
};

const titleFrame = (conversationId: string, title: string): ChatEvent => ({
  type: 'title',
  data: { event: 'title', data: { conversationId, title } },
});

const finalFrame = (titleSettled: boolean): ChatEvent => ({
  type: 'final',
  data: { final: true, titleSettled },
});

describe('useTitleGeneration — title stream', () => {
  it('waits on the title stream instead of polling, after the chat stream ends', () => {
    const id = 'stream-late-title';
    mockActiveJobIds = [];
    const { transport, streams } = createTransport();

    renderHook(() => useTitleGeneration(true, transport));
    act(() => queueTitleGeneration(id));

    expect(streams.map((stream) => stream.url)).toEqual([`/api/convos/${id}/title/stream`]);
    expect(isEligible(id)).toBe(false);

    streams[0].emit(titleFrame(id, 'Late Title'));
    streams[0].emit(finalFrame(true));

    const update = mockSetQueryData.mock.calls.find(([key]) => key[1] === id)?.[1];
    expect(update({ conversationId: id, title: 'New Chat' })).toEqual({
      conversationId: id,
      title: 'Late Title',
    });
    expect(isTitleGenerationProcessed(id)).toBe(true);
    expect(streams[0].signal.aborted).toBe(true);
    expect(isEligible(id)).toBe(false);
  });

  it('keeps a local rename over the title the stream delivers', () => {
    const id = 'stream-manual';
    const owned = { title: 'My Rename', titleSetByUser: true, titleRevision: 1 };
    mockGetQueryData.mockImplementation((key: string[]) => (key[1] === id ? owned : undefined));
    const { transport, streams } = createTransport();

    renderHook(() => useTitleGeneration(true, transport));
    act(() => queueTitleGeneration(id));
    streams[0].emit(titleFrame(id, 'Generated Title'));

    const update = mockSetQueryData.mock.calls.find(([key]) => key[1] === id)?.[1];
    expect(update(owned)).toEqual(owned);
  });

  it('stops without polling when the attempt settles with no title', () => {
    const id = 'stream-no-title';
    const { transport, streams } = createTransport();

    renderHook(() => useTitleGeneration(true, transport));
    act(() => queueTitleGeneration(id));
    streams[0].emit(finalFrame(true));

    expect(isTitleGenerationProcessed(id)).toBe(true);
    expect(isEligible(id)).toBe(false);
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });

  it.each([
    ['the server reports nothing pending', finalFrame(false)],
    ['the server has no title stream route', { type: 'error', status: 404 } as ChatEvent],
  ])('falls back to polling when %s', (_case, event) => {
    const id = `stream-fallback-${event.type}`;
    const { transport, streams } = createTransport();

    renderHook(() => useTitleGeneration(true, transport));
    act(() => queueTitleGeneration(id));
    expect(isEligible(id)).toBe(false);

    streams[0].emit(event);

    expect(streams[0].signal.aborted).toBe(true);
    expect(isEligible(id)).toBe(true);
  });

  it('reconnects a dropped stream before falling back to polling', () => {
    jest.useFakeTimers();
    try {
      const id = 'stream-dropped';
      const { transport, streams } = createTransport();

      renderHook(() => useTitleGeneration(true, transport));
      act(() => queueTitleGeneration(id));

      for (let failure = 1; failure <= TITLE_STREAM_RETRIES; failure += 1) {
        streams.at(-1)!.emit({ type: 'error', status: 0 });
        expect(isEligible(id)).toBe(false);
        act(() => {
          jest.runOnlyPendingTimers();
        });
        expect(streams).toHaveLength(failure + 1);
      }
      streams.at(-1)!.emit({ type: 'error', status: 0 });

      expect(isEligible(id)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes the stream once a local rename delivers the title', () => {
    const id = 'stream-renamed';
    const { transport, streams } = createTransport();

    renderHook(() => useTitleGeneration(true, transport));
    act(() => queueTitleGeneration(id));
    act(() => markTitleGenerationProcessed(id));

    expect(streams[0].signal.aborted).toBe(true);
    expect(isEligible(id)).toBe(false);
  });

  it('closes open title streams on sign-out', () => {
    const id = 'stream-signed-out';
    const { transport, streams } = createTransport();

    const { rerender } = renderHook(({ enabled }) => useTitleGeneration(enabled, transport), {
      initialProps: { enabled: true },
    });
    act(() => queueTitleGeneration(id));
    rerender({ enabled: false });

    expect(streams[0].signal.aborted).toBe(true);
  });
});
