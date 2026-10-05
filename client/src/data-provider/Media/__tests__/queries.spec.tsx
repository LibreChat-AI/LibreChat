import React from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys, mediaCatalogSchema } from 'librechat-data-provider';
import type { MediaThreadDetail, TFile } from 'librechat-data-provider';
import {
  useMediaTurns,
  useMediaThreads,
  useMediaCatalog,
  useMediaThread,
  useMediaActivity,
  useMediaJobDiagnostics,
} from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listMediaThreads: jest.fn(),
      listMediaTurns: jest.fn(),
      getMediaCatalog: jest.fn(),
    },
  };
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const host = {
    scope: 'owner',
    pollIntervalMs: 60000,
    catchUpIntervalMs: 60000,
    isCurrentSession: () => true,
  };
  return { client, wrapper, host };
}

function rejected(status: number) {
  const error = new AxiosError('Request rejected');
  error.response = {
    status,
    statusText: 'Rejected',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

beforeEach(() => jest.mocked(dataService.listMediaThreads).mockReset());

test('shell activity includes unfinished work awaiting attention and wakes on invalidation', async () => {
  const env = setup();
  const load = jest.mocked(dataService.listMediaThreads).mockResolvedValue({ items: [] });
  const hook = renderHook(() => useMediaActivity(env.host, true), { wrapper: env.wrapper });
  expect(hook.result.current.isFetched).toBe(false);
  await waitFor(() => expect(hook.result.current.isFetched).toBe(true));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  jest.useFakeTimers();
  await act(async () => {
    jest.advanceTimersByTime(120000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  const thread = {
    schemaVersion: 1 as const,
    threadId: 'background',
    title: 'Video',
    version: 1,
    createdAt: '2026-09-19T12:00:00Z',
    updatedAt: '2026-09-19T12:00:00Z',
    pendingJobCount: 2,
    turnCount: 1,
    activity: {
      readyOutputs: 0,
      latestJob: {
        phase: 'requires_attention' as const,
        operation: 'video.generate' as const,
        selection: { connectionId: 'video', modelId: 'model', catalogVersion: 'catalog' },
      },
    },
  };
  load.mockResolvedValue({ items: [thread] });
  await act(async () => {
    await env.client.invalidateQueries([QueryKeys.mediaThreads, env.host.scope]);
    jest.advanceTimersByTime(1);
  });
  expect(hook.result.current.count).toBe(2);
  load.mockResolvedValue({ items: [] });
  await act(async () => {
    jest.advanceTimersByTime(60001);
  });
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(hook.result.current.count).toBe(0);
  hook.unmount();
  env.client.clear();
  jest.useRealTimers();
});

test('a failed initial activity snapshot releases events without waiting for a successful retry', async () => {
  const env = setup();
  const load = jest.mocked(dataService.listMediaThreads).mockRejectedValue(rejected(503));
  const hook = renderHook(() => useMediaActivity(env.host, true), { wrapper: env.wrapper });
  expect(hook.result.current.isFetched).toBe(false);
  await waitFor(() => expect(hook.result.current.isFetched).toBe(true));
  expect(hook.result.current.count).toBe(0);
  expect(load).toHaveBeenCalledTimes(1);
  hook.unmount();
  env.client.clear();
});

test('a cached activity snapshot releases events while its background refresh is pending', () => {
  const env = setup();
  env.client.setQueryData([QueryKeys.mediaThreads, env.host.scope, 'pending', 'activity', ''], {
    pages: [{ items: [] }],
    pageParams: [undefined],
  });
  jest.mocked(dataService.listMediaThreads).mockReturnValue(new Promise(() => {}));
  const hook = renderHook(() => useMediaActivity(env.host, true), { wrapper: env.wrapper });
  expect(hook.result.current.isFetched).toBe(true);
  hook.unmount();
  env.client.clear();
});

test('refreshes at a known saved-key expiry without fetching individual keys on startup', async () => {
  const env = setup();
  const catalog = mediaCatalogSchema.parse({
    schemaVersion: 1,
    version: 'catalog',
    offerings: [],
    limits: {},
    integrations: [
      {
        connectionId: 'native',
        connectionName: 'Native',
        api: 'bfl.images',
        available: true,
        userKey: { keyName: 'CaseSensitive', encoding: 'apiKey', userProvideURL: false },
      },
    ],
  });
  const load = jest.mocked(dataService.getMediaCatalog).mockReset().mockResolvedValue(catalog);
  const hook = renderHook(() => useMediaCatalog(env.host), { wrapper: env.wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(env.client.getQueryCache().findAll([QueryKeys.name])).toHaveLength(0);
  jest.useFakeTimers();
  act(() => {
    env.client.setQueryData([QueryKeys.name, 'CaseSensitive'], {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
  });
  await act(async () => {
    jest.advanceTimersByTime(1001);
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  hook.unmount();
  env.client.clear();
  jest.useRealTimers();
});

test('falls back once when an older server rejects the optional gallery view', async () => {
  const list = jest
    .mocked(dataService.listMediaThreads)
    .mockRejectedValueOnce(rejected(422))
    .mockResolvedValue({ items: [] });
  const env = setup();
  const hook = renderHook(() => useMediaThreads(env.host, 'all'), { wrapper: env.wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(list.mock.calls[0][0]).toMatchObject({ include: 'activity' });
  expect(list.mock.calls[1][0]).not.toHaveProperty('include');
  await act(async () => {
    await hook.result.current.refetch();
  });
  expect(list.mock.calls[2][0]).not.toHaveProperty('include');
  hook.unmount();
  env.client.clear();
});

test('preserves authorization failures instead of retrying a different gallery request', async () => {
  const list = jest.mocked(dataService.listMediaThreads).mockRejectedValue(rejected(403));
  const env = setup();
  const hook = renderHook(() => useMediaThreads(env.host, 'all'), { wrapper: env.wrapper });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(list).toHaveBeenCalledTimes(1);
  hook.unmount();
  env.client.clear();
});

test.each([true, false])(
  'caches thread assets together (seeded: %s) and ignores older snapshots',
  async (seeded) => {
    const env = setup();
    const createdAt = '2026-09-17T12:00:00.000Z';
    const asset = {
      file_id: 'image',
      filename: 'image.png',
      filepath: '/image.png',
      type: 'image/png',
      bytes: 100,
    };
    env.client.setQueryData<TFile[]>(
      [QueryKeys.files],
      seeded
        ? [
            {
              ...asset,
              object: 'file',
              user: 'owner',
              embedded: true,
              usage: 5,
              width: 128,
              metadata: { fileIdentifier: 'original' },
            },
          ]
        : [],
    );
    const cacheWrite = jest.spyOn(env.client, 'setQueryData');
    const newer: MediaThreadDetail = {
      thread: {
        schemaVersion: 1,
        threadId: 'thread',
        title: 'Renamed',
        version: 2,
        createdAt,
        updatedAt: createdAt,
        pendingJobCount: 0,
        turnCount: 1,
      },
      turns: {
        items: [
          {
            schemaVersion: 1,
            threadId: 'thread',
            turnId: 'turn',
            version: 1,
            kind: 'import',
            createdAt,
            prompt: '',
            inputs: [],
            jobs: [],
            assets: [
              { ...asset, width: 640 },
              { ...asset, file_id: 'turn-image' },
            ],
          },
        ],
      },
      latestImageContext: { turnId: 'turn', asset: { ...asset, filename: 'latest.png' } },
      latestVideoContext: {
        turnId: 'older-turn',
        asset: {
          ...asset,
          file_id: 'video',
          filename: 'video.mp4',
          filepath: '/video.mp4',
          type: 'video/mp4',
        },
      },
    };
    const older = { ...newer, thread: { ...newer.thread, title: 'Original', version: 1 } };
    const load = jest
      .spyOn(dataService, 'getMediaThread')
      .mockResolvedValueOnce(newer)
      .mockResolvedValueOnce(older);
    const hook = renderHook(() => useMediaThread({ ...env.host, userId: 'owner' }, 'thread'), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(hook.result.current.data?.thread.version).toBe(2));
    expect(env.client.getQueryData<TFile[]>([QueryKeys.files])).toEqual([
      expect.objectContaining({ file_id: 'video', user: 'owner' }),
      ...(seeded ? [expect.objectContaining({ file_id: 'turn-image' })] : []),
      expect.objectContaining({
        file_id: 'image',
        filename: 'latest.png',
        width: 640,
        embedded: seeded,
        usage: seeded ? 5 : 0,
        ...(seeded ? { metadata: { fileIdentifier: 'original' } } : {}),
      }),
      ...(seeded ? [] : [expect.objectContaining({ file_id: 'turn-image' })]),
    ]);
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(hook.result.current.data?.thread).toMatchObject({ version: 2, title: 'Renamed' });
    expect(cacheWrite.mock.calls.filter(([key]) => key[0] === QueryKeys.files)).toHaveLength(1);
    cacheWrite.mockRestore();
    load.mockRestore();
    env.client.clear();
  },
);

test('does not cache a late provider diagnostic after its session ends', async () => {
  const env = setup();
  let resolve!: (response: { diagnostic: { message: string } }) => void;
  const read = jest.spyOn(dataService, 'getMediaJobDiagnostics').mockReturnValue(
    new Promise((finish) => {
      resolve = finish;
    }),
  );
  const hook = renderHook(() => useMediaJobDiagnostics(env.host, 'job', 1, true), {
    wrapper: env.wrapper,
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  env.host.isCurrentSession = () => false;
  await act(async () => resolve({ diagnostic: { message: 'Previous session response' } }));
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(
    env.client.getQueryData([QueryKeys.mediaJobDiagnostics, env.host.scope, 'job', 1]),
  ).toBeUndefined();
  hook.unmount();
  env.client.clear();
});

test('keeps loaded older turns when a new turn moves the thread cursor', async () => {
  const env = setup();
  const turn = (sequence: number) => ({
    schemaVersion: 1 as const,
    threadId: 'thread',
    turnId: `turn-${sequence}`,
    version: 1,
    kind: 'generation' as const,
    sequence,
    createdAt: '2026-09-01T00:00:00.000Z',
    prompt: `Prompt ${sequence}`,
    inputs: [],
    jobs: [],
    assets: [],
  });
  const load = jest.mocked(dataService.listMediaTurns).mockImplementation(async (_id, request) => {
    const start = Number(request?.cursor);
    return {
      items: [turn(start - 1), turn(start - 2)],
      ...(start > 3 ? { nextCursor: String(start - 2) } : {}),
    };
  });
  const detail = (cursor: string) =>
    ({
      thread: { threadId: 'thread', pendingJobCount: 0 },
      turns: { items: [], nextCursor: cursor },
    }) as unknown as MediaThreadDetail;
  const hook = renderHook(({ cursor }) => useMediaTurns(env.host, detail(cursor), true), {
    wrapper: env.wrapper,
    initialProps: { cursor: '10' },
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
  hook.rerender({ cursor: '11' });
  await waitFor(() =>
    expect(hook.result.current.data?.pages[0].items[0]).toMatchObject({ turnId: 'turn-10' }),
  );
  expect(hook.result.current.data?.pages).toHaveLength(2);
  expect(load.mock.calls.map(([, request]) => request?.cursor)).toEqual(['10', '8', '11', '9']);
});
