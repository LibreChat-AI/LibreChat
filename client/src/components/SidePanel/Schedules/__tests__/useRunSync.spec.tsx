import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TSchedule, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { resetTrackedRuns, trackedRunCount } from '~/data-provider/Schedules/admission';
import useRunSync from '../useRunSync';

const mockGetConversationById = jest.fn<Promise<TConversation>, [string]>();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: (id: string) => mockGetConversationById(id),
    },
  };
});

const schedule: TSchedule = {
  id: 'schedule-1',
  user: 'user-1',
  name: 'Morning briefing',
  prompt: 'Summarize overnight activity',
  agent_id: 'agent-1',
  cadence: { frequency: 'daily', hour: 9, minute: 0 },
  timezone: 'UTC',
  target: 'new',
  enabled: true,
  runCount: 0,
  failureCount: 0,
  nextRunAt: '2026-09-05T09:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

/** The list naming the chat a running occurrence is producing. */
const running = (conversationId = 'run-convo-1', overrides?: Partial<TSchedule>): TSchedule => ({
  ...schedule,
  inFlight: [{ conversationId }],
  ...overrides,
});

/** The list after a run settled — the only trace a run short enough to start and
 *  finish between two polls ever leaves. */
const settled = (conversationId = 'run-convo-1', overrides?: Partial<TSchedule>): TSchedule => ({
  ...schedule,
  lastRun: { conversationId, status: 'success', firedAt: '2026-09-05T09:00:00.000Z' },
  ...overrides,
});

const serverConversation = (conversationId = 'run-convo-1'): TConversation =>
  ({
    conversationId,
    title: 'Overnight activity summary',
    endpoint: 'agents',
    agent_id: 'agent-1',
    createdAt: '2026-09-05T09:00:01.000Z',
    updatedAt: '2026-09-05T09:00:01.000Z',
  }) as TConversation;

const listKey = [QueryKeys.allConversations];

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
  });
  queryClient.setQueryData([QueryKeys.user], { id: 'user-1' });
  queryClient.setQueryData(listKey, {
    pages: [{ conversations: [{ conversationId: 'existing' } as TConversation], nextCursor: null }],
    pageParams: [],
  });
  return queryClient;
}

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const listIds = (queryClient: QueryClient) =>
  (
    queryClient.getQueryData<{ pages: Array<{ conversations: TConversation[] }> }>(listKey)
      ?.pages[0].conversations ?? []
  ).map((convo) => convo.conversationId);

const isStale = (queryClient: QueryClient) =>
  queryClient.getQueryState(listKey)?.isInvalidated === true;

/** Every render is a fresh poll observation, the way the panel feeds the hook —
 *  including one whose data is the same reference as the last. */
let observation = 0;
const renderWith = (queryClient: QueryClient, initial?: TSchedule[]) =>
  renderHook((schedules?: TSchedule[]) => useRunSync(schedules, (observation += 1)), {
    wrapper: createWrapper(queryClient),
    initialProps: initial,
  });

/** Lets the admission watch reach its first probe. */
const admit = async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(3_000);
  });
};

describe('useRunSync', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    resetTrackedRuns();
    mockGetConversationById.mockResolvedValue(serverConversation());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('puts a running occurrence’s chat in the sidebar', async () => {
    const queryClient = createQueryClient();
    renderWith(queryClient, [running()]);

    await admit();

    expect(listIds(queryClient)).toEqual(['run-convo-1', 'existing']);
    queryClient.clear();
  });

  it('watches a run once, however many polls list it', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running()]);
    rerender([running()]);
    rerender([running()]);

    await admit();

    expect(mockGetConversationById).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it('re-reads the list when the run settles, so the chat takes its final order', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running()]);
    await admit();
    expect(isStale(queryClient)).toBe(false);

    rerender([schedule]);

    expect(isStale(queryClient)).toBe(true);
    queryClient.clear();
  });

  it('sees a settlement through an edit made while the run was in flight', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running()]);
    await admit();

    /** The edit bumps configRevision, which fences the schedule's own `lastRun`
     *  projection; the run row is what this reads, and it is gone regardless. */
    rerender([running('run-convo-1', { name: 'Renamed', configRevision: 2 })]);
    expect(isStale(queryClient)).toBe(false);

    rerender([{ ...schedule, name: 'Renamed', configRevision: 2 }]);
    expect(isStale(queryClient)).toBe(true);
    queryClient.clear();
  });

  it('re-reads the list for a run that started and settled between two polls', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [schedule]);

    rerender([settled()]);
    await admit();

    /** Never seen generating, so never handed to the watch — the refetch brings the
     *  server's own row, and a settled run whose generation never wrote a chat
     *  (a 404 for good) is not probed at all, let alone again. */
    expect(isStale(queryClient)).toBe(true);
    expect(mockGetConversationById).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('fetches every generating occurrence a schedule names', async () => {
    const queryClient = createQueryClient();
    mockGetConversationById.mockImplementation(async (id) => serverConversation(id));
    renderWith(queryClient, [
      running('run-convo-1', {
        inFlight: [{ conversationId: 'run-convo-1' }, { conversationId: 'run-convo-2' }],
      }),
    ]);

    await admit();

    expect(listIds(queryClient)).toEqual(
      expect.arrayContaining(['run-convo-1', 'run-convo-2', 'existing']),
    );
    queryClient.clear();
  });

  it('re-reads the list when a schedule with a run is deleted from under it', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running(), { ...schedule, id: 'schedule-2' }]);
    await admit();
    expect(isStale(queryClient)).toBe(false);

    /** Deleting aborts and settles the run, and the schedule leaves the list; the
     *  chat's final state is only visible if the vanishing counts as a move. */
    rerender([{ ...schedule, id: 'schedule-2' }]);

    expect(isStale(queryClient)).toBe(true);
    queryClient.clear();
  });

  it('announces a run again once its watch has given up', async () => {
    const queryClient = createQueryClient();
    mockGetConversationById.mockRejectedValue(
      Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } }),
    );
    const { rerender } = renderWith(queryClient, [schedule]);
    rerender([running()]);
    /** Deferred past the whole budget: the watch forgets the id so a later
     *  announcement can try again — which is only useful if this hook makes one. */
    await act(async () => {
      await jest.advanceTimersByTimeAsync(600_000);
    });
    expect(listIds(queryClient)).toEqual(['existing']);

    mockGetConversationById.mockResolvedValue(serverConversation());
    rerender([running()]);
    await admit();

    expect(listIds(queryClient)).toEqual(['run-convo-1', 'existing']);
    queryClient.clear();
  });

  it('re-reads the list when a schedule created elsewhere arrives already settled', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [schedule]);

    /** Made in another tab, fired, and finished — all before this poll first
     *  listed it. There is no earlier state to compare against; idle is the
     *  baseline, and this is not idle. */
    rerender([schedule, { ...settled('elsewhere-convo'), id: 'schedule-2' }]);

    expect(isStale(queryClient)).toBe(true);
    expect(mockGetConversationById).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('leaves the list alone when a schedule created elsewhere arrives idle', () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [schedule]);

    rerender([schedule, { ...schedule, id: 'schedule-2' }]);

    expect(isStale(queryClient)).toBe(false);
    queryClient.clear();
  });

  it('re-reads on the first observation when any schedule has run', async () => {
    const queryClient = createQueryClient();
    /** The sidebar may have been read before that run and nothing here can tell;
     *  one refetch on opening the panel is the price. Nothing is probed. */
    renderWith(queryClient, [settled()]);
    await admit();

    expect(isStale(queryClient)).toBe(true);
    expect(mockGetConversationById).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('records the first observation in silence when nothing has ever run', async () => {
    const queryClient = createQueryClient();
    renderWith(queryClient, [schedule, { ...schedule, id: 'schedule-2' }]);
    await admit();

    expect(isStale(queryClient)).toBe(false);
    expect(mockGetConversationById).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('announces again on a poll whose data is the same reference', async () => {
    const queryClient = createQueryClient();
    mockGetConversationById.mockRejectedValue(
      Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } }),
    );
    const list = [running()];
    const { rerender } = renderWith(queryClient, list);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(600_000);
    });
    expect(listIds(queryClient)).toEqual(['existing']);

    /** Deep-equal refetch: React Query hands back the same array. Only the
     *  observation stamp moves, and that has to be enough to ask again. */
    mockGetConversationById.mockResolvedValue(serverConversation());
    rerender(list);
    await admit();

    expect(listIds(queryClient)).toEqual(['run-convo-1', 'existing']);
    queryClient.clear();
  });

  it('releases a run once it leaves the list, so nothing is remembered for it', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running()]);
    await admit();
    expect(trackedRunCount()).toBe(1);

    rerender([settled()]);

    expect(trackedRunCount()).toBe(0);
    queryClient.clear();
  });

  it('does not retain a run released before admission finishes', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [running()]);
    rerender([settled()]);

    await admit();

    expect(listIds(queryClient)).toContain('run-convo-1');
    expect(trackedRunCount()).toBe(0);
    queryClient.clear();
  });

  it.each([false, true])('releases on unmount with admission finished: %s', async (finished) => {
    const queryClient = createQueryClient();
    const { unmount } = renderWith(queryClient, [running()]);
    if (finished) {
      await admit();
    }

    unmount();
    await admit();

    expect(listIds(queryClient)).toContain('run-convo-1');
    expect(trackedRunCount()).toBe(0);
    expect(mockGetConversationById).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it('reclaims a pending watch on remount without a duplicate probe', async () => {
    const queryClient = createQueryClient();
    const first = renderWith(queryClient, [running()]);
    first.unmount();
    const second = renderWith(queryClient, [running()]);

    await admit();

    expect(trackedRunCount()).toBe(1);
    expect(mockGetConversationById).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(trackedRunCount()).toBe(0);
    queryClient.clear();
  });

  it('leaves the list alone when nothing about a run moved', async () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, [schedule]);

    rerender([
      { ...schedule, name: 'Renamed', enabled: false, nextRunAt: '2026-09-06T09:00:00.000Z' },
    ]);

    expect(isStale(queryClient)).toBe(false);
    queryClient.clear();
  });

  it('waits for data before recording anything', () => {
    const queryClient = createQueryClient();
    const { rerender } = renderWith(queryClient, undefined);

    rerender([schedule]);

    expect(isStale(queryClient)).toBe(false);
    queryClient.clear();
  });
});
