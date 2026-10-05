import { useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  mediaCatalogSchema,
  mediaThreadDetailSchema,
  mediaThreadPageSchema,
  mediaTurnPageSchema,
  mediaJobPageSchema,
  mediaOutputPageSchema,
  mediaJobDiagnosticsResponseSchema,
} from 'librechat-data-provider';
import type {
  MediaThreadDetail,
  MediaThreadPage,
  MediaThreadListRequest,
  TCheckUserKeyResponse,
  MediaTurn,
  MediaJob,
} from 'librechat-data-provider';
import { cacheMediaAssets, cacheMediaTurns } from './files';
import { newerMediaSnapshot } from './reconcile';

export type MediaQueryScope = {
  scope: string;
  userId?: string;
  pollIntervalMs: number;
  catchUpIntervalMs: number;
  isCurrentSession: () => boolean;
};
const current = <T>(host: MediaQueryScope, value: T): T => {
  if (!host.isCurrentSession()) throw new Error('Session ended');
  return value;
};
export function useMediaCatalog(host: MediaQueryScope) {
  const { scope, catchUpIntervalMs, isCurrentSession } = host;
  const client = useQueryClient();
  const query = useQuery(
    [QueryKeys.mediaCatalog, host.scope],
    async ({ signal }) =>
      current(host, mediaCatalogSchema.parse(await dataService.getMediaCatalog(signal))),
    {
      retry: false,
      refetchInterval: (data) =>
        data?.integrations?.some((item) => item.userKey) ? host.catchUpIntervalMs : false,
      refetchIntervalInBackground: false,
    },
  );
  const processed = useRef(new Map<string, string>());
  const keyNames = JSON.stringify([
    ...new Set(
      query.data?.integrations?.flatMap((item) => (item.userKey ? [item.userKey.keyName] : [])) ??
        [],
    ),
  ]);
  useEffect(() => {
    const names: string[] = JSON.parse(keyNames);
    if (!names.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!isCurrentSession()) return;
      let delay = Infinity;
      let expired = false;
      for (const name of names) {
        const key = client.getQueryData<TCheckUserKeyResponse | null>([QueryKeys.name, name]);
        const expiry = key?.expiresAt;
        const time = expiry ? new Date(expiry).getTime() : NaN;
        if (!expiry || !Number.isFinite(time) || processed.current.get(name) === expiry) continue;
        if (time <= Date.now()) {
          processed.current.set(name, expiry);
          expired = true;
        } else delay = Math.min(delay, time - Date.now());
      }
      if (expired) void client.invalidateQueries([QueryKeys.mediaCatalog, scope]);
      // The existing catch-up interval also bounds browser timer limits for long expiries.
      if (Number.isFinite(delay)) timer = setTimeout(schedule, Math.min(delay, catchUpIntervalMs));
    };
    schedule();
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event?.query.queryKey[0] === QueryKeys.name) schedule();
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, scope, catchUpIntervalMs, isCurrentSession, keyNames]);
  return query;
}
export function useMediaThreads(
  host: MediaQueryScope,
  filter: MediaThreadListRequest['filter'],
  search = '',
  options: { enabled?: boolean; pollWhenIdle?: boolean } = {},
) {
  const client = useQueryClient();
  const activity = useRef(true);
  const key = [QueryKeys.mediaThreads, host.scope, filter, 'activity', search];
  return useInfiniteQuery(
    key,
    async ({ pageParam, signal }): Promise<MediaThreadPage> => {
      const params = { cursor: pageParam, filter, ...(search ? { search } : {}) };
      const load = async () => {
        try {
          return await dataService.listMediaThreads(
            { ...params, ...(activity.current ? { include: 'activity' as const } : {}) },
            signal,
          );
        } catch (error) {
          if (!activity.current || !isAxiosError(error) || error.response?.status !== 422)
            throw error;
          // Older servers validate query fields strictly. Keep their original response contract.
          activity.current = false;
          return dataService.listMediaThreads(params, signal);
        }
      };
      const next = current(host, mediaThreadPageSchema.parse(await load()));
      cacheMediaAssets(
        client,
        host.userId,
        next.items.flatMap((thread) => (thread.cover ? [thread.cover] : [])),
      );
      const previous = client.getQueryData<{ pages: MediaThreadPage[] }>(key);
      const old = new Map(
        previous?.pages.flatMap((page) => page.items).map((thread) => [thread.threadId, thread]),
      );
      return {
        ...next,
        items: next.items.map((thread) => newerMediaSnapshot(old.get(thread.threadId), thread)),
      };
    },
    {
      enabled: options.enabled,
      getNextPageParam: (page) => page.nextCursor,
      refetchOnWindowFocus: 'always',
      refetchInterval: (data, query) => {
        const status = (query.state.error as { response?: { status?: number } } | null)?.response
          ?.status;
        if (status === 403 || status === 404) return false;
        if (data?.pages.some((page) => page.items.some((thread) => thread.pendingJobCount > 0)))
          return host.pollIntervalMs;
        return options.pollWhenIdle === false ? false : host.catchUpIntervalMs;
      },
      refetchIntervalInBackground: false,
      retry: false,
    },
  );
}

/** Shell observer stays alive outside Studio; local submissions and event nudges wake an idle query. */
export function useMediaActivity(host: MediaQueryScope, enabled: boolean) {
  const query = useMediaThreads(host, 'pending', '', { enabled, pollWhenIdle: false });
  return {
    count: enabled
      ? (query.data?.pages.reduce(
          (total, page) =>
            total + page.items.reduce((count, thread) => count + thread.pendingJobCount, 0),
          0,
        ) ?? 0)
      : 0,
    hasMore: query.hasNextPage === true,
    isFetched: query.isFetched,
  };
}
export function useMediaThread(host: MediaQueryScope, threadId?: string) {
  const client = useQueryClient();
  const key = [QueryKeys.mediaThread, host.scope, threadId];
  return useQuery(
    key,
    async ({ signal }): Promise<MediaThreadDetail> => {
      const next = current(
        host,
        mediaThreadDetailSchema.parse(await dataService.getMediaThread(threadId!, signal)),
      );
      const previous = client.getQueryData<MediaThreadDetail>(key);
      if (previous && previous.thread.version > next.thread.version) return previous;
      cacheMediaTurns(
        client,
        host.userId,
        next.turns.items,
        [next.latestImageContext, next.latestVideoContext].flatMap((context) =>
          context ? [context.asset] : [],
        ),
      );
      const turns = new Map(previous?.turns.items.map((turn) => [turn.turnId, turn]));
      return {
        ...next,
        turns: {
          ...next.turns,
          items: next.turns.items.map((turn) => newerMediaSnapshot(turns.get(turn.turnId), turn)),
        },
      };
    },
    {
      enabled: !!threadId,
      refetchInterval: (data, query) => {
        const status = (query.state.error as { response?: { status?: number } } | null)?.response
          ?.status;
        if (status === 403 || status === 404) return false;
        return (data?.thread.pendingJobCount ?? 0) > 0
          ? host.pollIntervalMs
          : host.catchUpIntervalMs;
      },
      refetchIntervalInBackground: false,
      retry: false,
    },
  );
}
/**
 * Older turns continue from the thread detail's cursor, which moves whenever a turn is added.
 * The loaded pages are refetched from the new cursor instead of being replaced by a single page.
 */
export function useMediaTurns(host: MediaQueryScope, detail: MediaThreadDetail, expanded: boolean) {
  const client = useQueryClient();
  const threadId = detail.thread.threadId;
  const cursor = detail.turns.nextCursor;
  const firstCursor = useRef(cursor);
  firstCursor.current = cursor;
  const queryKey = [QueryKeys.mediaTurns, host.scope, threadId];
  const query = useInfiniteQuery(
    queryKey,
    async ({ pageParam, signal }) => {
      const page = current(
        host,
        mediaTurnPageSchema.parse(
          await dataService.listMediaTurns(
            threadId,
            { cursor: pageParam ?? firstCursor.current },
            signal,
          ),
        ),
      );
      cacheMediaTurns(client, host.userId, page.items);
      return page;
    },
    {
      enabled: expanded && !!cursor,
      getNextPageParam: (page) => page.nextCursor,
      retry: false,
      refetchInterval: detail.thread.pendingJobCount ? host.pollIntervalMs : host.catchUpIntervalMs,
      refetchIntervalInBackground: false,
    },
  );
  const loadedCursor = useRef(cursor);
  const { data, refetch } = query;
  useEffect(() => {
    if (loadedCursor.current === cursor) return;
    loadedCursor.current = cursor;
    if (!cursor) client.removeQueries({ queryKey, exact: true });
    else if (data) void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);
  return query;
}

const activeJob = (job: MediaJob) =>
  !['succeeded', 'failed', 'cancelled', 'requires_attention'].includes(job.phase);

export function useMediaTurnJobs(host: MediaQueryScope, turn: MediaTurn, expanded: boolean) {
  const client = useQueryClient();
  return useInfiniteQuery(
    [QueryKeys.mediaTurnJobs, host.scope, turn.threadId, turn.turnId, turn.jobsNextCursor],
    async ({ pageParam, signal }) => {
      const page = current(
        host,
        mediaJobPageSchema.parse(
          await dataService.listMediaTurnJobs(
            turn.threadId,
            turn.turnId,
            { cursor: pageParam ?? turn.jobsNextCursor },
            signal,
          ),
        ),
      );
      cacheMediaTurns(client, host.userId, [{ ...turn, jobs: page.items }]);
      return page;
    },
    {
      enabled: expanded && !!turn.jobsNextCursor,
      getNextPageParam: (page) => page.nextCursor,
      retry: false,
      refetchInterval: (data) =>
        turn.jobs.some(activeJob) || data?.pages.some((page) => page.items.some(activeJob))
          ? host.pollIntervalMs
          : host.catchUpIntervalMs,
      refetchIntervalInBackground: false,
    },
  );
}

export function useMediaJobOutputs(host: MediaQueryScope, job: MediaJob, expanded: boolean) {
  const client = useQueryClient();
  return useInfiniteQuery(
    [QueryKeys.mediaJobOutputs, host.scope, job.jobId, job.outputsNextCursor],
    async ({ pageParam, signal }) => {
      const page = current(
        host,
        mediaOutputPageSchema.parse(
          await dataService.listMediaJobOutputs(
            job.jobId,
            { cursor: pageParam ?? job.outputsNextCursor },
            signal,
          ),
        ),
      );
      cacheMediaAssets(
        client,
        host.userId,
        page.items.flatMap((output) =>
          output.kind !== 'text' && output.state === 'ready' && output.asset ? [output.asset] : [],
        ),
      );
      return page;
    },
    {
      enabled: expanded && !!job.outputsNextCursor,
      getNextPageParam: (page) => page.nextCursor,
      retry: false,
      refetchInterval: activeJob(job) ? host.pollIntervalMs : host.catchUpIntervalMs,
      refetchIntervalInBackground: false,
    },
  );
}

export function useMediaJobDiagnostics(
  host: MediaQueryScope,
  jobId: string,
  version: number,
  enabled: boolean,
) {
  return useQuery(
    [QueryKeys.mediaJobDiagnostics, host.scope, jobId, version],
    async ({ signal }) => {
      try {
        return current(
          host,
          mediaJobDiagnosticsResponseSchema.parse(
            await dataService.getMediaJobDiagnostics(jobId, signal),
          ),
        );
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 404)
          return current(host, mediaJobDiagnosticsResponseSchema.parse({}));
        throw error;
      }
    },
    { enabled, retry: false, staleTime: Infinity },
  );
}

export function invalidateMedia(client: ReturnType<typeof useQueryClient>, scope: string) {
  return Promise.all([
    client.invalidateQueries([QueryKeys.mediaThreads, scope]),
    client.invalidateQueries([QueryKeys.mediaThread, scope]),
    client.invalidateQueries([QueryKeys.mediaTurns, scope]),
    client.invalidateQueries([QueryKeys.mediaTurnJobs, scope]),
    client.invalidateQueries([QueryKeys.mediaJobOutputs, scope]),
  ]);
}
